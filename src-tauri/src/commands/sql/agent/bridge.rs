//! A2.4/A3 Tauri command/event bridge for local Agent runtimes.

#![allow(dead_code)]
#![allow(clippy::needless_pass_by_value)]

use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use super::super::connection_manager::SharedConnectionManager;
use super::super::state::SqlConnectionStore;
use super::super::types::SqlCommandError;
use super::domain::{AgentBudget, AgentMode, AgentRun, AgentRunStore, AgentTaskKind};
use super::evidence::AgentEvidenceStore;
use super::explore::LocalReadOnlyCompositeAgentToolExecutor;
use super::model::{
    AgentModelContext, AgentModelGateway, AgentModelRequest, DeterministicAgentModelGateway,
    DeterministicReadOnlyExploreAgentModelGateway, DeterministicSchemaFixAgentModelGateway,
    DeterministicSchemaGenerateAgentModelGateway,
};
use super::optimize::{DeterministicOptimizeAgentModelGateway, OptimizeAgentLoop};
use super::policy::{AgentCapability, AgentCapabilitySet, AgentPolicy};
use super::runtime::{AgentLoopResult, ReadOnlyAgentLoop, SuggestOnlyAgentLoop};
use super::suggest_only::LocalSuggestOnlyAgentToolExecutor;

pub const SQL_AGENT_RUN_EVENT: &str = "sql-agent/run";
const MAX_AGENT_START_REQUEST_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlAgentStartRequest {
    pub goal: String,
    pub task: AgentTaskKind,
    pub mode: AgentMode,
    #[serde(default)]
    pub budget: Option<AgentBudget>,
    pub context: AgentModelContext,
    /// Renderer/plugin capability declarations are opt-down hints only. Rust
    /// intersects them with the fixed grant for the selected built-in action.
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlAgentRunEvent {
    pub run: AgentRun,
    pub result: Option<AgentLoopResult>,
    pub error: Option<SqlCommandError>,
}

pub struct AgentRuntimeState {
    pub runs: AgentRunStore,
    pub evidence: Arc<AgentEvidenceStore>,
    pending: Mutex<HashMap<String, PendingAgentRun>>,
    next_run_id: AtomicU64,
}

#[derive(Debug, Clone)]
struct PendingAgentRun {
    task: AgentTaskKind,
    context: AgentModelContext,
    granted_capabilities: AgentCapabilitySet,
}

#[derive(Debug)]
enum ClaimedAgentRun {
    Ready {
        run: AgentRun,
        request: Box<PendingAgentRun>,
    },
    Cancelled(AgentRun),
}

impl Default for AgentRuntimeState {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentRuntimeState {
    pub fn new() -> Self {
        Self::with_run_capacity(super::domain::DEFAULT_AGENT_RUN_MAX_ENTRIES)
    }

    fn with_run_capacity(max_entries: usize) -> Self {
        Self {
            runs: AgentRunStore::with_capacity(max_entries),
            evidence: Arc::new(AgentEvidenceStore::default()),
            pending: Mutex::new(HashMap::new()),
            next_run_id: AtomicU64::new(1),
        }
    }

    fn allocate_run_id(&self) -> String {
        format!(
            "agent-run-{}",
            self.next_run_id.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn allocate_run(&self, request: SqlAgentStartRequest) -> Result<AgentRun, SqlCommandError> {
        validate_task_mode(request.task, request.mode)?;
        validate_task_context(&request)?;
        validate_start_request_size(&request)?;
        let backend_grant = backend_action_grant(&request);
        let requested_capabilities = AgentCapabilitySet::from_wire(request.capabilities)?;
        let granted_capabilities = requested_capabilities.intersection(&backend_grant);
        let budget = request.budget.unwrap_or_default();
        let run = AgentRun::new(self.allocate_run_id(), request.goal, request.mode, budget)?;
        let pending_request = PendingAgentRun {
            task: request.task,
            context: request.context,
            granted_capabilities,
        };

        // This mutex is also taken by claim/cancel, making allocation visible as
        // one lifecycle operation even though request and run have separate owners.
        let mut pending = self.pending.lock().expect("agent pending store poisoned");
        let evicted_run_id = self.runs.insert(run.clone())?;
        if let Some(evicted_run_id) = &evicted_run_id {
            pending.remove(evicted_run_id);
        }
        pending.insert(run.run_id.clone(), pending_request);
        drop(pending);
        if let Some(evicted_run_id) = evicted_run_id {
            self.evidence.remove_for_run(&evicted_run_id);
        }
        Ok(run)
    }

    fn claim_run(&self, run_id: &str) -> Result<ClaimedAgentRun, SqlCommandError> {
        let mut pending = self.pending.lock().expect("agent pending store poisoned");
        if !pending.contains_key(run_id) {
            match self.runs.get(run_id) {
                None => {
                    return Err(SqlCommandError::new(
                        "invalid_input",
                        "agent run was not found",
                    ));
                }
                Some(run) if run.state == super::domain::AgentRunState::Cancelled => {
                    return Ok(ClaimedAgentRun::Cancelled(run));
                }
                Some(_) => {}
            }
            return Err(SqlCommandError::new(
                "invalid_input",
                "agent run has already started",
            ));
        }

        match self.runs.claim(run_id)? {
            super::domain::AgentRunClaim::Ready(run) => {
                let request = pending.remove(run_id).ok_or_else(|| {
                    SqlCommandError::new("internal", "agent run request was not found")
                })?;
                Ok(ClaimedAgentRun::Ready {
                    run,
                    request: Box::new(request),
                })
            }
            super::domain::AgentRunClaim::Cancelled(run) => {
                pending.remove(run_id);
                Ok(ClaimedAgentRun::Cancelled(run))
            }
        }
    }

    fn cancel_run(&self, run_id: &str) -> Result<AgentRun, SqlCommandError> {
        let mut pending = self.pending.lock().expect("agent pending store poisoned");
        let run = self.runs.cancel(run_id)?;
        pending.remove(run_id);
        Ok(run)
    }

    #[cfg(test)]
    fn pending_len(&self) -> usize {
        self.pending
            .lock()
            .expect("agent pending store poisoned")
            .len()
    }
}

#[tauri::command]
pub fn sql_agent_start(
    app: tauri::AppHandle,
    state: State<'_, Arc<AgentRuntimeState>>,
    request: SqlAgentStartRequest,
) -> Result<SqlAgentRunEvent, SqlCommandError> {
    let run = state.allocate_run(request)?;
    let event = SqlAgentRunEvent {
        run,
        result: None,
        error: None,
    };
    emit_run_event(&app, &event);
    Ok(event)
}

#[tauri::command]
pub async fn sql_agent_run(
    app: tauri::AppHandle,
    state: State<'_, Arc<AgentRuntimeState>>,
    sql_state: State<'_, Arc<SqlConnectionStore>>,
    metadata_manager: State<'_, SharedConnectionManager>,
    run_id: String,
) -> Result<SqlAgentRunEvent, SqlCommandError> {
    let (run, request) = match state.claim_run(&run_id)? {
        ClaimedAgentRun::Ready { run, request } => (run, *request),
        ClaimedAgentRun::Cancelled(run) => {
            return Ok(SqlAgentRunEvent {
                run,
                result: None,
                error: None,
            });
        }
    };
    let worker_run_id = run.run_id.clone();
    let runtime_state = state.inner().clone();
    let worker_state = Arc::clone(&runtime_state);
    let worker_app = app.clone();
    let sql_store = sql_state.inner().clone();
    let metadata_manager = metadata_manager.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        execute_agent_worker(
            run,
            request,
            worker_state,
            sql_store,
            metadata_manager,
            worker_app,
        )
    })
    .await;
    let result = match result {
        Ok(result) => result,
        Err(join_error) => {
            let error = SqlCommandError::new(
                "internal",
                format!("sql_agent_run worker failed: {join_error}"),
            );
            let (run, changed) = state.runs.fail_active(&worker_run_id)?;
            if run.state == super::domain::AgentRunState::Cancelled {
                state.evidence.remove_for_run(&run.run_id);
            }
            let event = SqlAgentRunEvent {
                run,
                result: None,
                error: changed.then_some(error),
            };
            emit_run_event(&app, &event);
            return Ok(event);
        }
    };
    let (result, run, accepted) = result?;

    match result {
        Ok(result) => {
            let event = SqlAgentRunEvent {
                run,
                result: accepted.then_some(result),
                error: None,
            };
            emit_run_event(&app, &event);
            Ok(event)
        }
        Err(error) => {
            if !accepted && run.state == super::domain::AgentRunState::Cancelled {
                return Ok(SqlAgentRunEvent {
                    run,
                    result: None,
                    error: None,
                });
            }
            let event = SqlAgentRunEvent {
                run,
                result: None,
                error: Some(error.clone()),
            };
            emit_run_event(&app, &event);
            Ok(event)
        }
    }
}

fn execute_agent_worker(
    mut run: AgentRun,
    request: PendingAgentRun,
    runtime_state: Arc<AgentRuntimeState>,
    sql_store: Arc<SqlConnectionStore>,
    metadata_manager: SharedConnectionManager,
    event_app: tauri::AppHandle,
) -> Result<(Result<AgentLoopResult, SqlCommandError>, AgentRun, bool), SqlCommandError> {
    let emit_progress = |run: &AgentRun| -> Result<(), SqlCommandError> {
        let Some(snapshot) = runtime_state.runs.replace_active(run.clone())? else {
            return Err(SqlCommandError::new(
                "invalid_input",
                "agent run was cancelled",
            ));
        };
        emit_run_event(
            &event_app,
            &SqlAgentRunEvent {
                run: snapshot,
                result: None,
                error: None,
            },
        );
        Ok(())
    };
    let result = execute_agent_loop(
        &mut run,
        &request,
        &runtime_state,
        sql_store,
        metadata_manager,
        emit_progress,
    );
    let (stored_run, accepted) = runtime_state.runs.finish(run)?;
    if !accepted && stored_run.state == super::domain::AgentRunState::Cancelled {
        runtime_state.evidence.remove_for_run(&stored_run.run_id);
    }
    Ok((result, stored_run, accepted))
}

fn execute_agent_loop<F>(
    run: &mut AgentRun,
    request: &PendingAgentRun,
    runtime_state: &AgentRuntimeState,
    sql_store: Arc<SqlConnectionStore>,
    metadata_manager: SharedConnectionManager,
    emit_progress: F,
) -> Result<AgentLoopResult, SqlCommandError>
where
    F: FnMut(&AgentRun) -> Result<(), SqlCommandError>,
{
    let policy = AgentPolicy::new(run.mode, request.granted_capabilities.clone());
    if run.mode == AgentMode::ReadOnly {
        let connection_id = request.context.connection_id.as_deref().ok_or_else(|| {
            SqlCommandError::new(
                "invalid_input",
                "Agent read-only run requires a connection id",
            )
        })?;
        if request.task == AgentTaskKind::OptimizeQuery {
            let executor = LocalReadOnlyCompositeAgentToolExecutor::new(
                metadata_manager,
                sql_store,
                connection_id,
                run.cancellation_token(),
            )?;
            let mut runtime = OptimizeAgentLoop::new(
                DeterministicOptimizeAgentModelGateway::default(),
                policy,
                executor,
                Arc::clone(&runtime_state.evidence),
            );
            runtime.run_with_progress(run, request.task, &request.context, emit_progress)
        } else if request.task == AgentTaskKind::Assistant {
            let executor = LocalReadOnlyCompositeAgentToolExecutor::new(
                metadata_manager,
                sql_store,
                connection_id,
                run.cancellation_token(),
            )?;
            let mut runtime = ReadOnlyAgentLoop::new_explore(
                DeterministicReadOnlyExploreAgentModelGateway::new(&run.goal),
                policy,
                executor,
                Arc::clone(&runtime_state.evidence),
            );
            runtime.run_with_progress(run, request.task, &request.context, emit_progress)
        } else {
            let executor = LocalReadOnlyCompositeAgentToolExecutor::new(
                metadata_manager,
                sql_store,
                connection_id,
                run.cancellation_token(),
            )?;
            let mut runtime = ReadOnlyAgentLoop::new(
                DeterministicReadOnlyAgentModelGateway::default(),
                policy,
                executor,
                Arc::clone(&runtime_state.evidence),
            );
            runtime.run_with_progress(run, request.task, &request.context, emit_progress)
        }
    } else if request.task == AgentTaskKind::GenerateQuery && has_agent_connection(&request.context)
    {
        let executor = LocalSuggestOnlyAgentToolExecutor::new(metadata_manager, sql_store);
        let mut runtime = SuggestOnlyAgentLoop::with_executor(
            DeterministicSchemaGenerateAgentModelGateway::new(&run.goal),
            policy,
            executor,
            Arc::clone(&runtime_state.evidence),
        );
        runtime.run_with_progress(run, request.task, &request.context, emit_progress)
    } else if request.task == AgentTaskKind::FixError {
        let executor = LocalSuggestOnlyAgentToolExecutor::new(metadata_manager, sql_store);
        let mut runtime = SuggestOnlyAgentLoop::with_executor(
            DeterministicSchemaFixAgentModelGateway::new(),
            policy,
            executor,
            Arc::clone(&runtime_state.evidence),
        );
        runtime.run_with_progress(run, request.task, &request.context, emit_progress)
    } else {
        let mut runtime = SuggestOnlyAgentLoop::new(
            DeterministicAgentModelGateway,
            policy,
            Arc::clone(&runtime_state.evidence),
        );
        runtime.run_with_progress(run, request.task, &request.context, emit_progress)
    }
}

fn validate_start_request_size(request: &SqlAgentStartRequest) -> Result<(), SqlCommandError> {
    let bytes = serde_json::to_vec(request)
        .map_err(|error| SqlCommandError::new("invalid_input", error.to_string()))?
        .len();
    if bytes > MAX_AGENT_START_REQUEST_BYTES {
        return Err(SqlCommandError::new(
            "invalid_input",
            format!("Agent start request exceeds {MAX_AGENT_START_REQUEST_BYTES} bytes"),
        ));
    }
    Ok(())
}

fn validate_task_mode(task: AgentTaskKind, mode: AgentMode) -> Result<(), SqlCommandError> {
    if task == AgentTaskKind::GenerateQuery && mode != AgentMode::SuggestOnly {
        return Err(SqlCommandError::new(
            "invalid_input",
            "Generate Query requires Suggest Only mode",
        ));
    }
    if task == AgentTaskKind::FixError && mode != AgentMode::SuggestOnly {
        return Err(SqlCommandError::new(
            "invalid_input",
            "Fix Error requires Suggest Only mode",
        ));
    }
    if task == AgentTaskKind::OptimizeQuery && mode != AgentMode::ReadOnly {
        return Err(SqlCommandError::new(
            "invalid_input",
            "Optimize Query requires Read Only mode",
        ));
    }
    Ok(())
}

fn validate_task_context(request: &SqlAgentStartRequest) -> Result<(), SqlCommandError> {
    if request.task == AgentTaskKind::FixError && !has_agent_connection(&request.context) {
        return Err(SqlCommandError::new(
            "invalid_input",
            "Schema-aware Fix requires an open connection",
        ));
    }
    if request.task == AgentTaskKind::OptimizeQuery {
        if !has_agent_connection(&request.context) {
            return Err(SqlCommandError::new(
                "invalid_input",
                "Optimize Query requires an open connection",
            ));
        }
        if request.context.dialect != super::super::dialect::SqlDialect::Sqlite {
            return Err(SqlCommandError::new(
                "validation",
                "Optimize Query supports Stable SQLite only",
            ));
        }
        let sql = request
            .context
            .selected_sql
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .or(request.context.sql.as_deref());
        if sql.is_none_or(|value| value.trim().is_empty() || value.contains('\0')) {
            return Err(SqlCommandError::new(
                "invalid_input",
                "Optimize Query requires SQL",
            ));
        }
    }
    Ok(())
}

fn backend_action_grant(request: &SqlAgentStartRequest) -> AgentCapabilitySet {
    let has_connection = has_agent_connection(&request.context);
    let capabilities: &[AgentCapability] = match (request.mode, request.task) {
        (AgentMode::SuggestOnly, AgentTaskKind::GenerateQuery | AgentTaskKind::FixError)
            if has_connection =>
        {
            &[
                AgentCapability::AgentTool,
                AgentCapability::WorkspaceReadSql,
                AgentCapability::DatabaseReadMetadata,
            ]
        }
        (AgentMode::SuggestOnly, _) => &[
            AgentCapability::AgentTool,
            AgentCapability::WorkspaceReadSql,
        ],
        (AgentMode::ReadOnly, AgentTaskKind::Assistant) => &[
            AgentCapability::AgentTool,
            AgentCapability::DatabaseReadMetadata,
            AgentCapability::DatabaseExecuteRead,
            AgentCapability::DatabaseReadResultShape,
        ],
        (AgentMode::ReadOnly, AgentTaskKind::ExplainError) => &[AgentCapability::DatabaseExplain],
        (AgentMode::ReadOnly, AgentTaskKind::OptimizeQuery) => &[
            AgentCapability::AgentTool,
            AgentCapability::DatabaseReadMetadata,
            AgentCapability::DatabaseExplain,
        ],
        (AgentMode::ReadOnly | AgentMode::AllowWritesWithApproval, _) => &[],
    };
    AgentCapabilitySet::from_capabilities(capabilities.iter().copied())
}

fn has_agent_connection(context: &AgentModelContext) -> bool {
    context
        .connection_id
        .as_deref()
        .is_some_and(|connection_id| !connection_id.trim().is_empty())
}

/// Small local provider used by the deterministic A3 bridge. It exercises the
/// real policy, `SQLite` adapter, result store, and evidence path without making
/// a network request or pretending that an external model has run.
#[derive(Debug, Default, Clone, Copy)]
struct DeterministicReadOnlyAgentModelGateway {
    step: usize,
    inspected: bool,
}

impl AgentModelGateway for DeterministicReadOnlyAgentModelGateway {
    fn generate(&mut self, request: &AgentModelRequest) -> Result<String, SqlCommandError> {
        let sql = request
            .context
            .selected_sql
            .as_deref()
            .or(request.context.sql.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("SELECT 1")
            .to_string();
        let connection_id = request.context.connection_id.clone().unwrap_or_default();
        let should_explain = request.task == AgentTaskKind::ExplainError;

        let response = if self.step == 0 {
            self.step = self.step.saturating_add(1);
            serde_json::json!({
                "type": "tool_call",
                "call_id": "a3-query",
                "tool": if should_explain { "sql.explain" } else { "sql.execute_readonly" },
                "arguments": {
                    "connectionId": connection_id,
                    "dialect": "sqlite",
                    "sql": sql
                }
            })
        } else if !should_explain && !self.inspected {
            self.inspected = true;
            self.step = self.step.saturating_add(1);
            serde_json::json!({
                "type": "tool_call",
                "call_id": "a3-inspect",
                "tool": "result.inspect",
                "arguments": {"resultRef": "result-1"}
            })
        } else {
            serde_json::json!({
                "type": "final",
                "title": "SQL Read Only Agent",
                "content": if should_explain {
                    "SQLite explain evidence is ready for review."
                } else {
                    "SQLite read-only result shape and aggregate evidence are ready for review."
                }
            })
        };
        serde_json::to_string(&response)
            .map_err(|error| SqlCommandError::new("internal", error.to_string()))
    }
}

#[tauri::command]
pub fn sql_agent_cancel(
    app: tauri::AppHandle,
    state: State<'_, Arc<AgentRuntimeState>>,
    sql_state: State<'_, Arc<SqlConnectionStore>>,
    run_id: String,
) -> Result<SqlAgentRunEvent, SqlCommandError> {
    let run = cancel_agent_run(&state, &sql_state, &run_id)?;
    let event = SqlAgentRunEvent {
        run,
        result: None,
        error: None,
    };
    emit_run_event(&app, &event);
    Ok(event)
}

fn cancel_agent_run(
    state: &AgentRuntimeState,
    sql_state: &SqlConnectionStore,
    run_id: &str,
) -> Result<AgentRun, SqlCommandError> {
    let run = state.cancel_run(run_id)?;
    state.evidence.remove_for_run(run_id);
    if let Err(error) = sql_state.cancel_agent_queries_for_run(run_id) {
        log::warn!("Failed to interrupt SQLite query for cancelled Agent run {run_id}: {error}");
    }
    Ok(run)
}

#[tauri::command]
pub fn sql_agent_get_run(
    state: State<'_, Arc<AgentRuntimeState>>,
    run_id: String,
) -> Result<AgentRun, SqlCommandError> {
    state
        .runs
        .get(&run_id)
        .ok_or_else(|| SqlCommandError::new("invalid_input", "agent run was not found"))
}

fn emit_run_event(app: &tauri::AppHandle, event: &SqlAgentRunEvent) {
    if let Err(error) = app.emit(SQL_AGENT_RUN_EVENT, event) {
        log::debug!("SQL Agent event listener unavailable: {error}");
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::commands::sql::connection_manager::ConnectionManager;
    use crate::commands::sql::demo_seed::ensure_demo_db;
    use crate::commands::sql::driver_registry::default_registry;
    use crate::commands::sql::product::{bootstrap_demo_inner, DEMO_PROFILE_ID};
    use crate::commands::sql::types::{
        ConnectionProfile, ConnectionSecret, DriverIdDto, SqlConnectionInput, SqlConnectionKind,
    };
    use serde_json::json;

    static NEXT_SCHEMA_GENERATE_TEST: AtomicU64 = AtomicU64::new(0);

    fn schema_generate_test_path(label: &str, extension: &str) -> std::path::PathBuf {
        let id = NEXT_SCHEMA_GENERATE_TEST.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "nyala-agent-schema-generate-{label}-{}-{id}.{extension}",
            std::process::id()
        ))
    }

    fn sqlite_profile(id: &str, path: &Path) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_string(),
            label: id.to_string(),
            driver: DriverIdDto::Sqlite,
            read_only: true,
            host: None,
            port: None,
            database: None,
            username: None,
            ssl_mode: None,
            file_path: Some(path.to_string_lossy().into_owned()),
            remember_in_memory: false,
            created_at_ms: 0,
        }
    }

    fn legacy_sqlite_input(id: &str, path: &Path) -> SqlConnectionInput {
        SqlConnectionInput {
            id: Some(id.to_string()),
            name: Some(id.to_string()),
            kind: SqlConnectionKind::Sqlite,
            database_path: Some(path.to_string_lossy().into_owned()),
            host: None,
            port: None,
            database: None,
            username: None,
            password: None,
            ssl_mode: None,
            read_only: true,
            create_if_missing: false,
        }
    }

    struct SchemaGenerateTestFiles {
        database: std::path::PathBuf,
        persistence: std::path::PathBuf,
        legacy_persistence: std::path::PathBuf,
    }

    impl SchemaGenerateTestFiles {
        fn new(label: &str) -> Self {
            Self {
                database: schema_generate_test_path(label, "db"),
                persistence: schema_generate_test_path(label, "json"),
                legacy_persistence: schema_generate_test_path(label, "v1.json"),
            }
        }
    }

    impl Drop for SchemaGenerateTestFiles {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.database);
            let _ = std::fs::remove_file(&self.persistence);
            let _ = std::fs::remove_file(&self.legacy_persistence);
        }
    }

    struct ReadOnlyExploreFixture {
        _files: SchemaGenerateTestFiles,
        metadata_manager: SharedConnectionManager,
        sql_store: Arc<SqlConnectionStore>,
        connection_id: &'static str,
    }

    impl ReadOnlyExploreFixture {
        fn new() -> Self {
            let files = SchemaGenerateTestFiles::new("read-only-explore");
            let metadata_manager = Arc::new(ConnectionManager::new(
                default_registry(),
                files.persistence.clone(),
            ));
            let sql_store = Arc::new(SqlConnectionStore::new());
            sql_store
                .initialize_persistence(files.legacy_persistence.clone())
                .expect("initialize Demo legacy persistence");
            bootstrap_demo_inner(&metadata_manager, &sql_store, &files.database)
                .expect("bootstrap product Demo");
            Self {
                _files: files,
                metadata_manager,
                sql_store,
                connection_id: DEMO_PROFILE_ID,
            }
        }

        fn request(&self, goal: &str) -> SqlAgentStartRequest {
            SqlAgentStartRequest {
                goal: goal.to_string(),
                task: AgentTaskKind::Assistant,
                mode: AgentMode::ReadOnly,
                budget: None,
                context: AgentModelContext {
                    connection_id: Some(self.connection_id.to_string()),
                    user_prompt: Some(goal.to_string()),
                    schema: vec![super::super::model::AgentModelSchemaTable {
                        schema: Some("forged".to_string()),
                        name: "secret_table".to_string(),
                        columns: vec!["secret_column".to_string()],
                    }],
                    result_ref: Some("forged-result".to_string()),
                    ..AgentModelContext::default()
                },
                capabilities: vec![
                    "agent.tool".to_string(),
                    "database.readMetadata".to_string(),
                    "database.executeRead".to_string(),
                    "database.readResultShape".to_string(),
                ],
            }
        }
    }

    impl Drop for ReadOnlyExploreFixture {
        fn drop(&mut self) {
            self.metadata_manager.close(self.connection_id);
            let _ = self.sql_store.close_connection(self.connection_id);
        }
    }

    fn assert_read_only_explore_result(
        state: &AgentRuntimeState,
        stored: &AgentRun,
        result: &AgentLoopResult,
        goal: &str,
    ) {
        assert_eq!(stored.state, super::super::domain::AgentRunState::Completed);
        assert_eq!(result.query_call_count, 1);
        let sql = result
            .answer
            .as_ref()
            .and_then(|answer| answer.sql.as_deref())
            .expect("Explore SQL");
        for expected in ["orders", "amount", "created_at", "SUM", "-6 days"] {
            assert!(sql.contains(expected), "missing {expected}: {sql}");
        }
        assert!(!sql.contains("secret_table"));
        assert!(!sql.contains("secret_column"));
        assert_eq!(
            stored
                .tool_calls
                .iter()
                .map(|call| call.tool.as_str())
                .collect::<Vec<_>>(),
            vec![
                "schema.search",
                "sql.parse",
                "sql.execute_readonly",
                "result.inspect",
            ]
        );
        assert_eq!(stored.tool_calls[0].arguments["query"], goal);
        assert_eq!(
            stored.tool_calls[0].arguments["connectionId"],
            DEMO_PROFILE_ID
        );
        assert_eq!(stored.tool_calls[2].arguments["sql"], sql);
        assert_eq!(
            stored.tool_calls[2].arguments["connectionId"],
            DEMO_PROFILE_ID
        );
        let evidence = state.evidence.list_for_run(&stored.run_id);
        for kind in [
            super::super::evidence::AgentEvidenceKind::Schema,
            super::super::evidence::AgentEvidenceKind::Analysis,
            super::super::evidence::AgentEvidenceKind::ResultShape,
            super::super::evidence::AgentEvidenceKind::Aggregate,
        ] {
            assert!(evidence.iter().any(|entry| entry.kind == kind));
        }
        assert!(!evidence
            .iter()
            .any(|entry| entry.kind == super::super::evidence::AgentEvidenceKind::ResultSample));
        let serialized_evidence = serde_json::to_string(&evidence).expect("serialize evidence");
        assert!(!serialized_evidence.contains("\"rows\""));
    }

    fn start_request(task: AgentTaskKind) -> SqlAgentStartRequest {
        SqlAgentStartRequest {
            goal: "inspect the current query".to_string(),
            task,
            mode: AgentMode::SuggestOnly,
            budget: None,
            context: AgentModelContext {
                sql: Some("SELECT trusted_context".to_string()),
                ..AgentModelContext::default()
            },
            capabilities: vec!["agent.tool".to_string()],
        }
    }

    #[test]
    fn runtime_state_allocates_opaque_monotonic_run_ids() {
        let state = AgentRuntimeState::new();
        assert_eq!(state.allocate_run_id(), "agent-run-1");
        assert_eq!(state.allocate_run_id(), "agent-run-2");
    }

    #[test]
    fn runtime_state_claims_the_request_owned_by_start() {
        let state = AgentRuntimeState::new();
        let allocated = state
            .allocate_run(start_request(AgentTaskKind::GenerateQuery))
            .unwrap();

        let ClaimedAgentRun::Ready { run, request } = state.claim_run(&allocated.run_id).unwrap()
        else {
            panic!("newly allocated run should be ready");
        };

        assert_eq!(run.run_id, allocated.run_id);
        assert_eq!(request.task, AgentTaskKind::GenerateQuery);
        assert_eq!(
            request.context.sql.as_deref(),
            Some("SELECT trusted_context")
        );
        assert!(request
            .granted_capabilities
            .contains(super::super::policy::AgentCapability::AgentTool));
    }

    #[test]
    fn assistant_request_cannot_forge_metadata_capability() {
        let state = AgentRuntimeState::new();
        let mut request = start_request(AgentTaskKind::Assistant);
        request
            .capabilities
            .push("database.readMetadata".to_string());
        let allocated = state.allocate_run(request).unwrap();
        let ClaimedAgentRun::Ready { run, request } = state.claim_run(&allocated.run_id).unwrap()
        else {
            panic!("assistant run should be ready");
        };
        let policy = AgentPolicy::new(run.mode, request.granted_capabilities.clone());
        let call = super::super::domain::AgentToolCall::new(
            run.run_id,
            "forged-schema-call",
            "schema.search",
            json!({
                "connectionId": "forged-connection",
                "schema": "main",
                "query": "users"
            }),
            Vec::new(),
        )
        .unwrap();

        let error = policy.authorize(&call).unwrap_err();

        assert!(error.to_string().contains("database.readMetadata"));
    }

    #[test]
    fn connected_generate_keeps_only_requested_backend_grants() {
        let state = AgentRuntimeState::new();
        let mut request = start_request(AgentTaskKind::GenerateQuery);
        request.context.connection_id = Some("workspace".to_string());
        request.capabilities.extend([
            "workspace.readSql".to_string(),
            "database.readMetadata".to_string(),
            "database.executeWrite".to_string(),
            "network.request".to_string(),
        ]);
        let allocated = state.allocate_run(request).unwrap();
        let ClaimedAgentRun::Ready { request, .. } = state.claim_run(&allocated.run_id).unwrap()
        else {
            panic!("connected Generate run should be ready");
        };

        assert_eq!(
            request.granted_capabilities.wire_names(),
            vec!["database.readMetadata", "agent.tool", "workspace.readSql"]
        );
    }

    #[test]
    fn connected_fix_keeps_only_requested_backend_grants() {
        let state = AgentRuntimeState::new();
        let mut request = start_request(AgentTaskKind::FixError);
        request.context.connection_id = Some("workspace".to_string());
        request.capabilities.extend([
            "workspace.readSql".to_string(),
            "database.readMetadata".to_string(),
            "database.executeRead".to_string(),
            "database.executeWrite".to_string(),
            "network.request".to_string(),
        ]);
        let allocated = state.allocate_run(request).unwrap();
        let ClaimedAgentRun::Ready { request, .. } = state.claim_run(&allocated.run_id).unwrap()
        else {
            panic!("connected Fix run should be ready");
        };

        assert_eq!(
            request.granted_capabilities.wire_names(),
            vec!["database.readMetadata", "agent.tool", "workspace.readSql"]
        );
    }

    #[test]
    fn generate_without_connection_does_not_receive_metadata_grant() {
        let state = AgentRuntimeState::new();
        let mut request = start_request(AgentTaskKind::GenerateQuery);
        request
            .capabilities
            .push("database.readMetadata".to_string());
        let allocated = state.allocate_run(request).unwrap();
        let ClaimedAgentRun::Ready { request, .. } = state.claim_run(&allocated.run_id).unwrap()
        else {
            panic!("Generate run should be ready");
        };

        assert!(!request
            .granted_capabilities
            .contains(AgentCapability::DatabaseReadMetadata));
    }

    #[test]
    fn read_only_assistant_grant_excludes_forged_sample_and_write_capabilities() {
        let state = AgentRuntimeState::new();
        let mut request = start_request(AgentTaskKind::Assistant);
        request.mode = AgentMode::ReadOnly;
        request.context.connection_id = Some("reader".to_string());
        request.capabilities = vec![
            "agent.tool".to_string(),
            "database.readMetadata".to_string(),
            "database.executeRead".to_string(),
            "database.readResultShape".to_string(),
            "database.readResultSample".to_string(),
            "database.executeWrite".to_string(),
            "network.request".to_string(),
        ];
        let allocated = state.allocate_run(request).unwrap();
        let ClaimedAgentRun::Ready { request, .. } = state.claim_run(&allocated.run_id).unwrap()
        else {
            panic!("Read Only Assistant run should be ready");
        };

        assert_eq!(
            request.granted_capabilities.wire_names(),
            vec![
                "database.readMetadata",
                "database.executeRead",
                "agent.tool",
                "database.readResultShape",
            ]
        );
    }

    #[test]
    fn allocating_after_terminal_eviction_removes_only_evicted_run_evidence() {
        let state = AgentRuntimeState::with_run_capacity(1);
        let allocated = state
            .allocate_run(start_request(AgentTaskKind::Assistant))
            .unwrap();
        let ClaimedAgentRun::Ready { mut run, .. } = state.claim_run(&allocated.run_id).unwrap()
        else {
            panic!("first run should be ready");
        };
        run.transition(super::super::domain::AgentRunState::BuildingContext)
            .unwrap();
        run.transition(super::super::domain::AgentRunState::Reasoning)
            .unwrap();
        run.transition(super::super::domain::AgentRunState::Completed)
            .unwrap();
        state.runs.finish(run).unwrap();
        state
            .evidence
            .append(
                &allocated.run_id,
                super::super::evidence::AgentEvidenceKind::Analysis,
                super::super::evidence::AgentEvidenceSensitivity::Workspace,
                json!({"owner": "evicted"}),
            )
            .unwrap();
        state
            .evidence
            .append(
                "unrelated-run",
                super::super::evidence::AgentEvidenceKind::Analysis,
                super::super::evidence::AgentEvidenceSensitivity::Workspace,
                json!({"owner": "retained"}),
            )
            .unwrap();

        let replacement = state
            .allocate_run(start_request(AgentTaskKind::Assistant))
            .unwrap();

        assert!(state.runs.get(&allocated.run_id).is_none());
        assert!(state.evidence.list_for_run(&allocated.run_id).is_empty());
        assert_eq!(state.evidence.list_for_run("unrelated-run").len(), 1);
        assert_eq!(state.pending_len(), 1);
        assert!(matches!(
            state.claim_run(&replacement.run_id).unwrap(),
            ClaimedAgentRun::Ready { .. }
        ));
    }

    fn assert_top_spend_sql_uses_demo_schema(sql: &str) {
        for expected in [
            "orders",
            "users",
            "user_id",
            "SUM(\"o\".\"amount\")",
            "'-30 days'",
            "GROUP BY \"u\".\"id\", \"u\".\"name\"",
            "ORDER BY \"total_amount\" DESC",
            "LIMIT 10",
        ] {
            assert!(sql.contains(expected), "missing {expected}: {sql}");
        }
        assert!(!sql.contains("LIMIT 100"));
        assert!(!sql.contains("fake_table"));
        assert!(!sql.contains("fake_column"));
    }

    #[test]
    fn schema_generate_worker_uses_real_demo_metadata_and_parses_without_query_calls() {
        let files = SchemaGenerateTestFiles::new("demo");
        ensure_demo_db(&files.database).expect("seed Demo SQLite");
        let metadata_manager = Arc::new(ConnectionManager::new(
            default_registry(),
            files.persistence.clone(),
        ));
        let profile = sqlite_profile("demo", &files.database);
        metadata_manager
            .upsert_profile(profile.clone())
            .expect("save Demo profile");
        metadata_manager
            .open(&profile, ConnectionSecret::default())
            .expect("open Demo profile");
        let state = AgentRuntimeState::new();
        let allocated = state
            .allocate_run(SqlAgentStartRequest {
                goal: "查询最近 30 天消费金额最高的 10 个用户".to_string(),
                task: AgentTaskKind::GenerateQuery,
                mode: AgentMode::SuggestOnly,
                budget: None,
                context: AgentModelContext {
                    connection_id: Some("demo".to_string()),
                    user_prompt: Some("查询最近 30 天消费金额最高的 10 个用户".to_string()),
                    schema: vec![super::super::model::AgentModelSchemaTable {
                        schema: Some("forged".to_string()),
                        name: "fake_table".to_string(),
                        columns: vec!["fake_column".to_string()],
                    }],
                    ..AgentModelContext::default()
                },
                capabilities: vec![
                    "agent.tool".to_string(),
                    "workspace.readSql".to_string(),
                    "database.readMetadata".to_string(),
                ],
            })
            .expect("allocate schema Generate run");
        let ClaimedAgentRun::Ready { mut run, request } =
            state.claim_run(&allocated.run_id).expect("claim run")
        else {
            panic!("schema Generate run should be ready");
        };
        let sql_store = Arc::new(SqlConnectionStore::new());

        let result = execute_agent_loop(
            &mut run,
            &request,
            &state,
            sql_store,
            Arc::clone(&metadata_manager),
            |snapshot| {
                state
                    .runs
                    .replace_active(snapshot.clone())?
                    .ok_or_else(|| {
                        SqlCommandError::new("invalid_input", "agent run was cancelled")
                    })?;
                Ok(())
            },
        )
        .expect("run schema Generate loop");
        let (stored, accepted) = state.runs.finish(run).expect("finish worker");

        assert!(accepted);
        assert_eq!(stored.state, super::super::domain::AgentRunState::Completed);
        assert_eq!(result.query_call_count, 0);
        let sql = result
            .answer
            .as_ref()
            .and_then(|answer| answer.sql.as_deref())
            .expect("generated SQL proposal");
        assert_top_spend_sql_uses_demo_schema(sql);
        assert_eq!(
            stored
                .tool_calls
                .iter()
                .map(|call| call.tool.as_str())
                .collect::<Vec<_>>(),
            vec!["schema.search", "sql.parse"]
        );
        let evidence = state.evidence.list_for_run(&stored.run_id);
        let schema_evidence = evidence
            .iter()
            .find(|entry| entry.kind == super::super::evidence::AgentEvidenceKind::Schema)
            .expect("typed schema and relation evidence");
        assert_eq!(schema_evidence.payload["relations"]["status"], "supported");
        assert_eq!(
            schema_evidence.payload["relations"]["search"]["paths"][0]["edges"][0]["evidenceKind"],
            "declared_foreign_key"
        );
        let analysis = evidence
            .iter()
            .find(|entry| entry.kind == super::super::evidence::AgentEvidenceKind::Analysis)
            .expect("typed SQL analysis evidence");
        assert_eq!(analysis.payload["analysis"]["statementCount"], 1);
        assert_eq!(analysis.payload["analysis"]["risk"], "read_only");
        assert_eq!(stored.usage.schema_objects, 2);
        metadata_manager.close("demo");
    }

    #[test]
    fn schema_fix_worker_uses_real_demo_metadata_and_parses_without_query_calls() {
        let files = SchemaGenerateTestFiles::new("fix-demo");
        ensure_demo_db(&files.database).expect("seed Demo SQLite");
        let metadata_manager = Arc::new(ConnectionManager::new(
            default_registry(),
            files.persistence.clone(),
        ));
        let profile = sqlite_profile("demo-fix", &files.database);
        metadata_manager
            .upsert_profile(profile.clone())
            .expect("save Demo profile");
        metadata_manager
            .open(&profile, ConnectionSecret::default())
            .expect("open Demo profile");
        let state = AgentRuntimeState::new();
        let allocated = state
            .allocate_run(SqlAgentStartRequest {
                goal: "Fix the failed SQL using its structured error.".to_string(),
                task: AgentTaskKind::FixError,
                mode: AgentMode::SuggestOnly,
                budget: None,
                context: AgentModelContext {
                    connection_id: Some("demo-fix".to_string()),
                    sql: Some("SELECT amunt FROM orders".to_string()),
                    error_context: Some(super::super::model::AgentModelErrorContext {
                        code: Some("no_such_column".to_string()),
                        message: "no such column: amunt".to_string(),
                        detail: Some("renderer detail must not define schema".to_string()),
                    }),
                    schema: vec![super::super::model::AgentModelSchemaTable {
                        schema: Some("forged".to_string()),
                        name: "orders".to_string(),
                        columns: vec!["amunt".to_string()],
                    }],
                    ..AgentModelContext::default()
                },
                capabilities: vec![
                    "agent.tool".to_string(),
                    "workspace.readSql".to_string(),
                    "database.readMetadata".to_string(),
                ],
            })
            .expect("allocate schema Fix run");
        let ClaimedAgentRun::Ready { mut run, request } =
            state.claim_run(&allocated.run_id).expect("claim run")
        else {
            panic!("schema Fix run should be ready");
        };

        let result = execute_agent_loop(
            &mut run,
            &request,
            &state,
            Arc::new(SqlConnectionStore::new()),
            Arc::clone(&metadata_manager),
            |_| Ok(()),
        )
        .expect("run schema Fix loop");
        let (stored, accepted) = state.runs.finish(run).expect("finish worker");

        assert!(accepted);
        assert_eq!(stored.state, super::super::domain::AgentRunState::Completed);
        assert_eq!(result.query_call_count, 0);
        assert_eq!(
            result.answer.and_then(|answer| answer.sql).as_deref(),
            Some("SELECT amount FROM orders")
        );
        assert_eq!(
            stored
                .tool_calls
                .iter()
                .map(|call| call.tool.as_str())
                .collect::<Vec<_>>(),
            vec!["schema.search", "sql.parse"]
        );
        let evidence = state.evidence.list_for_run(&stored.run_id);
        assert!(evidence
            .iter()
            .any(|entry| entry.kind == super::super::evidence::AgentEvidenceKind::Schema));
        assert!(evidence
            .iter()
            .any(|entry| entry.kind == super::super::evidence::AgentEvidenceKind::Analysis));
        metadata_manager.close("demo-fix");
    }

    #[test]
    fn read_only_explore_worker_grounds_goal_in_demo_schema_and_executes_one_query() {
        let fixture = ReadOnlyExploreFixture::new();
        let state = AgentRuntimeState::new();
        let goal = "按天汇总最近 7 天订单";
        let allocated = state
            .allocate_run(fixture.request(goal))
            .expect("allocate read-only Explore run");
        let ClaimedAgentRun::Ready { mut run, request } =
            state.claim_run(&allocated.run_id).expect("claim run")
        else {
            panic!("read-only Explore run should be ready");
        };

        let result = execute_agent_loop(
            &mut run,
            &request,
            &state,
            Arc::clone(&fixture.sql_store),
            Arc::clone(&fixture.metadata_manager),
            |snapshot| {
                state
                    .runs
                    .replace_active(snapshot.clone())?
                    .ok_or_else(|| {
                        SqlCommandError::new("invalid_input", "agent run was cancelled")
                    })?;
                Ok(())
            },
        )
        .expect("run read-only Explore loop");
        let (stored, accepted) = state.runs.finish(run).expect("finish worker");

        assert!(accepted);
        assert_read_only_explore_result(&state, &stored, &result, goal);
    }

    fn optimize_request(
        fixture: &ReadOnlyExploreFixture,
        original_sql: &str,
    ) -> SqlAgentStartRequest {
        SqlAgentStartRequest {
            goal: "Optimize the selected SQLite query.".to_string(),
            task: AgentTaskKind::OptimizeQuery,
            mode: AgentMode::ReadOnly,
            budget: None,
            context: AgentModelContext {
                connection_id: Some(fixture.connection_id.to_string()),
                editor_id: Some("sql-editor-9".to_string()),
                editor_version_id: Some(12),
                sql: Some(original_sql.to_string()),
                schema: vec![super::super::model::AgentModelSchemaTable {
                    schema: Some("forged".to_string()),
                    name: "secret_table".to_string(),
                    columns: vec!["secret_column".to_string()],
                }],
                result_ref: Some("forged-result".to_string()),
                ..AgentModelContext::default()
            },
            capabilities: vec![
                "agent.tool".to_string(),
                "database.readMetadata".to_string(),
                "database.explain".to_string(),
                "database.executeRead".to_string(),
                "database.readResultSample".to_string(),
            ],
        }
    }

    #[test]
    fn optimize_worker_records_two_revision_bound_plans_without_result_rows() {
        let fixture = ReadOnlyExploreFixture::new();
        let state = AgentRuntimeState::new();
        let original_sql = "SELECT id, email FROM users WHERE email = 'ada@example.com'";
        let allocated = state
            .allocate_run(optimize_request(&fixture, original_sql))
            .expect("allocate Optimize run");
        let ClaimedAgentRun::Ready { mut run, request } =
            state.claim_run(&allocated.run_id).expect("claim run")
        else {
            panic!("Optimize run should be ready");
        };

        let result = execute_agent_loop(
            &mut run,
            &request,
            &state,
            Arc::clone(&fixture.sql_store),
            Arc::clone(&fixture.metadata_manager),
            |_| Ok(()),
        )
        .expect("run Optimize loop");
        let (stored, accepted) = state.runs.finish(run).expect("finish worker");

        assert!(accepted);
        assert_eq!(stored.state, super::super::domain::AgentRunState::Completed);
        assert_eq!(result.query_call_count, 2);
        let optimize_evidence = result
            .optimize_evidence
            .as_ref()
            .expect("terminal Optimize evidence");
        assert!(optimize_evidence.index_metadata_available);
        assert!(!optimize_evidence.semantics_verified);
        assert!(!optimize_evidence.comparison.performance_verified);
        let terminal_json = serde_json::to_value(&result).expect("serialize Optimize result");
        assert_eq!(terminal_json["queryCallCount"], 2);
        assert!(terminal_json.get("optimizeEvidence").is_some());
        assert!(terminal_json.get("rows").is_none());
        assert_eq!(stored.usage.result_rows, 0);
        assert_eq!(
            stored
                .tool_calls
                .iter()
                .map(|call| call.tool.as_str())
                .collect::<Vec<_>>(),
            vec![
                "sql.parse",
                "index.list",
                "sql.explain",
                "sql.parse",
                "sql.explain",
            ]
        );
        assert!(!stored
            .tool_calls
            .iter()
            .any(|call| call.tool == "sql.execute_readonly"));
        let evidence = state.evidence.list_for_run(&stored.run_id);
        assert_eq!(
            evidence
                .iter()
                .filter(|entry| {
                    entry.kind == super::super::evidence::AgentEvidenceKind::Analysis
                })
                .count(),
            2
        );
        assert_eq!(
            evidence
                .iter()
                .filter(|entry| entry.kind == super::super::evidence::AgentEvidenceKind::Index)
                .count(),
            1
        );
        assert_eq!(
            evidence
                .iter()
                .filter(|entry| entry.kind == super::super::evidence::AgentEvidenceKind::Plan)
                .count(),
            3
        );
        let comparison = evidence
            .iter()
            .find(|entry| entry.payload.get("comparison").is_some())
            .expect("typed comparison evidence");
        assert_eq!(comparison.payload["indexMetadataAvailable"], true);
        assert_eq!(
            comparison.payload["comparison"]["performanceVerified"],
            false
        );
        let serialized = serde_json::to_string(&evidence).expect("serialize Optimize evidence");
        assert!(!serialized.contains("secret_table"));
        assert!(!serialized.contains("secret_column"));
        assert!(!serialized.contains("forged-result"));
        assert!(!serialized.contains("\"rows\""));
        assert_eq!(
            result.answer.and_then(|answer| answer.sql).as_deref(),
            Some(original_sql)
        );
    }

    #[test]
    fn schema_generate_worker_rejects_real_metadata_over_run_budget_without_evidence() {
        let files = SchemaGenerateTestFiles::new("budget");
        ensure_demo_db(&files.database).expect("seed Demo SQLite");
        let metadata_manager = Arc::new(ConnectionManager::new(
            default_registry(),
            files.persistence.clone(),
        ));
        let profile = sqlite_profile("demo-budget", &files.database);
        metadata_manager
            .upsert_profile(profile.clone())
            .expect("save Demo profile");
        metadata_manager
            .open(&profile, ConnectionSecret::default())
            .expect("open Demo profile");
        let state = AgentRuntimeState::new();
        let allocated = state
            .allocate_run(SqlAgentStartRequest {
                goal: "list recent orders with customer names".to_string(),
                task: AgentTaskKind::GenerateQuery,
                mode: AgentMode::SuggestOnly,
                budget: Some(AgentBudget {
                    max_schema_objects: 1,
                    ..AgentBudget::default()
                }),
                context: AgentModelContext {
                    connection_id: Some("demo-budget".to_string()),
                    ..AgentModelContext::default()
                },
                capabilities: vec![
                    "agent.tool".to_string(),
                    "database.readMetadata".to_string(),
                ],
            })
            .expect("allocate schema Generate run");
        let ClaimedAgentRun::Ready { mut run, request } =
            state.claim_run(&allocated.run_id).expect("claim run")
        else {
            panic!("schema Generate run should be ready");
        };

        let error = execute_agent_loop(
            &mut run,
            &request,
            &state,
            Arc::new(SqlConnectionStore::new()),
            Arc::clone(&metadata_manager),
            |_| Ok(()),
        )
        .unwrap_err();

        assert!(error.to_string().contains("schema object"));
        assert_eq!(run.state, super::super::domain::AgentRunState::Failed);
        assert_eq!(run.usage.schema_objects, 0);
        assert!(run.evidence_refs.is_empty());
        assert!(state.evidence.list_for_run(&run.run_id).is_empty());
        metadata_manager.close("demo-budget");
    }

    #[test]
    fn runtime_state_returns_cancelled_when_cancel_wins_before_claim() {
        let state = AgentRuntimeState::new();
        let allocated = state
            .allocate_run(start_request(AgentTaskKind::Assistant))
            .unwrap();
        state.cancel_run(&allocated.run_id).unwrap();

        let claimed = state.claim_run(&allocated.run_id).unwrap();

        assert!(matches!(
            claimed,
            ClaimedAgentRun::Cancelled(run)
                if run.run_id == allocated.run_id
                    && run.state == super::super::domain::AgentRunState::Cancelled
        ));
    }

    #[test]
    fn runtime_state_rejects_a_second_claim_without_reusing_request() {
        let state = AgentRuntimeState::new();
        let allocated = state
            .allocate_run(start_request(AgentTaskKind::Assistant))
            .unwrap();
        assert!(matches!(
            state.claim_run(&allocated.run_id).unwrap(),
            ClaimedAgentRun::Ready { .. }
        ));

        let error = state.claim_run(&allocated.run_id).unwrap_err();

        assert!(error.to_string().contains("already started"));
    }

    #[test]
    fn runtime_state_distinguishes_unknown_run_from_repeated_claim() {
        let state = AgentRuntimeState::new();

        let error = state.claim_run("agent-run-missing").unwrap_err();

        assert!(error.to_string().contains("not found"));
    }

    #[test]
    fn start_request_deserializes_without_secret_fields() {
        let request: SqlAgentStartRequest = serde_json::from_value(json!({
            "goal": "generate a query",
            "task": "generate_query",
            "mode": "suggest_only",
            "context": {"dialect": "sqlite", "schema": []},
            "capabilities": ["agent.tool"]
        }))
        .unwrap();
        assert_eq!(request.goal, "generate a query");
        assert_eq!(
            request.context.dialect,
            super::super::super::dialect::SqlDialect::Sqlite
        );
        let serialized = serde_json::to_string(&request.context).unwrap();
        assert!(!serialized.contains("password"));
    }

    #[test]
    fn deterministic_read_only_gateway_scripts_query_inspect_and_answer() {
        let mut gateway = DeterministicReadOnlyAgentModelGateway::default();
        let request = super::super::model::AgentModelRequest {
            run_id: "run-1".to_string(),
            task: AgentTaskKind::Assistant,
            context: AgentModelContext {
                connection_id: Some("reader".to_string()),
                sql: Some("SELECT 1".to_string()),
                ..AgentModelContext::default()
            },
            evidence_refs: Vec::new(),
        };
        let first = gateway.generate(&request).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&first).unwrap()["tool"],
            "sql.execute_readonly"
        );
        let second = gateway.generate(&request).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&second).unwrap()["tool"],
            "result.inspect"
        );
        let third = gateway.generate(&request).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&third).unwrap()["type"],
            "final"
        );
    }

    #[test]
    fn optimize_backend_grant_adds_metadata_without_query_execution() {
        let mut request = start_request(AgentTaskKind::OptimizeQuery);
        request.mode = AgentMode::ReadOnly;

        let grant = backend_action_grant(&request);

        assert_eq!(
            grant.wire_names(),
            vec!["database.readMetadata", "agent.tool", "database.explain"]
        );
        assert!(!grant.contains(AgentCapability::DatabaseExecuteRead));
        assert!(!grant.contains(AgentCapability::DatabaseExecuteWrite));
        assert!(!grant.contains(AgentCapability::DatabaseReadResultSample));
    }

    #[test]
    fn start_request_deserializes_fix_error_with_structured_error_context() {
        let request: SqlAgentStartRequest = serde_json::from_value(json!({
            "goal": "fix the failed query",
            "task": "fix_error",
            "mode": "suggest_only",
            "context": {
                "dialect": "sqlite",
                "connectionId": "demo",
                "editorId": "query-7",
                "editorVersionId": 9,
                "sql": "SELECT missing FROM orders",
                "errorContext": {
                    "code": "no_such_column",
                    "message": "no such column: missing",
                    "detail": "orders exposes id and total"
                },
                "schema": [{"schema": "main", "name": "orders", "columns": ["id", "total"]}]
            },
            "capabilities": ["agent.tool"]
        }))
        .unwrap();

        assert_eq!(request.task, AgentTaskKind::FixError);
        assert_eq!(request.context.connection_id.as_deref(), Some("demo"));
        assert_eq!(request.context.editor_id.as_deref(), Some("query-7"));
        assert_eq!(request.context.editor_version_id, Some(9));
        assert_eq!(
            request
                .context
                .error_context
                .as_ref()
                .and_then(|error| error.code.as_deref()),
            Some("no_such_column")
        );
    }

    #[test]
    fn fix_error_rejects_modes_that_can_call_database_tools() {
        let error = validate_task_mode(AgentTaskKind::FixError, AgentMode::ReadOnly).unwrap_err();

        assert!(matches!(error, SqlCommandError::InvalidInput { .. }));
    }

    #[test]
    fn fix_error_requires_non_empty_connection_before_run_allocation() {
        let state = AgentRuntimeState::new();
        for connection_id in [None, Some("   ".to_string())] {
            let mut request = start_request(AgentTaskKind::FixError);
            request.context.connection_id = connection_id;
            request.context.schema = vec![super::super::model::AgentModelSchemaTable {
                schema: Some("forged".to_string()),
                name: "orders".to_string(),
                columns: vec!["forged_total".to_string()],
            }];

            let error = state.allocate_run(request).unwrap_err();

            assert!(error.to_string().contains("open connection"));
            assert_eq!(state.pending_len(), 0);
            assert!(state.runs.get("agent-run-1").is_none());
            assert!(state.evidence.list_for_run("agent-run-1").is_empty());
        }

        let allocated = state
            .allocate_run(start_request(AgentTaskKind::Assistant))
            .expect("allocate the first valid run");

        assert_eq!(allocated.run_id, "agent-run-1");
    }

    #[test]
    fn generate_query_rejects_read_only_mode_before_runtime_routing() {
        let error =
            validate_task_mode(AgentTaskKind::GenerateQuery, AgentMode::ReadOnly).unwrap_err();

        assert!(error.to_string().contains("Suggest Only"));
    }

    #[test]
    fn cancelling_an_unclaimed_run_releases_its_pending_context() {
        let state = AgentRuntimeState::new();
        let allocated = state
            .allocate_run(start_request(AgentTaskKind::Assistant))
            .unwrap();
        assert_eq!(state.pending_len(), 1);

        state.cancel_run(&allocated.run_id).unwrap();

        assert_eq!(state.pending_len(), 0);
        assert!(matches!(
            state.claim_run(&allocated.run_id).unwrap(),
            ClaimedAgentRun::Cancelled(_)
        ));
    }

    #[test]
    fn cancel_helper_removes_pending_context_and_evidence_for_the_terminal_run() {
        let state = AgentRuntimeState::new();
        let sql_state = SqlConnectionStore::new();
        let allocated = state
            .allocate_run(start_request(AgentTaskKind::Assistant))
            .unwrap();
        state
            .evidence
            .append(
                &allocated.run_id,
                super::super::evidence::AgentEvidenceKind::Analysis,
                super::super::evidence::AgentEvidenceSensitivity::Workspace,
                json!({"status": "stale"}),
            )
            .unwrap();

        let cancelled = cancel_agent_run(&state, &sql_state, &allocated.run_id).unwrap();

        assert_eq!(
            cancelled.state,
            super::super::domain::AgentRunState::Cancelled
        );
        assert_eq!(state.pending_len(), 0);
        assert!(state.evidence.list_for_run(&allocated.run_id).is_empty());
    }

    #[test]
    fn oversized_start_request_is_rejected_without_storing_a_run() {
        let state = AgentRuntimeState::new();
        let mut request = start_request(AgentTaskKind::Assistant);
        request.context.user_prompt = Some("x".repeat(MAX_AGENT_START_REQUEST_BYTES));

        let error = state.allocate_run(request).unwrap_err();

        assert!(error.to_string().contains("start request exceeds"));
        assert_eq!(state.pending_len(), 0);
        assert!(state.runs.get("agent-run-1").is_none());
    }
}
