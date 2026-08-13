//! A2.4/A3 Tauri command/event bridge for local Agent runtimes.

#![allow(dead_code)]
#![allow(clippy::needless_pass_by_value)]

use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use super::super::state::SqlConnectionStore;
use super::super::types::SqlCommandError;
use super::domain::{AgentBudget, AgentMode, AgentRun, AgentRunStore, AgentTaskKind};
use super::evidence::AgentEvidenceStore;
use super::model::{
    AgentModelContext, AgentModelGateway, AgentModelRequest, DeterministicAgentModelGateway,
};
use super::policy::{AgentCapabilitySet, AgentPolicy};
use super::read_only::LocalReadOnlyAgentToolExecutor;
use super::runtime::{AgentLoopResult, ReadOnlyAgentLoop, SuggestOnlyAgentLoop};

pub const SQL_AGENT_RUN_EVENT: &str = "sql-agent/run";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlAgentStartRequest {
    pub goal: String,
    pub task: AgentTaskKind,
    pub mode: AgentMode,
    #[serde(default)]
    pub budget: Option<AgentBudget>,
    pub context: AgentModelContext,
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
    next_run_id: AtomicU64,
}

impl Default for AgentRuntimeState {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentRuntimeState {
    pub fn new() -> Self {
        Self {
            runs: AgentRunStore::new(),
            evidence: Arc::new(AgentEvidenceStore::default()),
            next_run_id: AtomicU64::new(1),
        }
    }

    fn allocate_run_id(&self) -> String {
        format!(
            "agent-run-{}",
            self.next_run_id.fetch_add(1, Ordering::Relaxed)
        )
    }
}

#[tauri::command]
pub fn sql_agent_start(
    app: tauri::AppHandle,
    state: State<'_, Arc<AgentRuntimeState>>,
    sql_state: State<'_, Arc<SqlConnectionStore>>,
    request: SqlAgentStartRequest,
) -> Result<SqlAgentRunEvent, SqlCommandError> {
    validate_task_mode(request.task, request.mode)?;
    let capabilities = AgentCapabilitySet::from_wire(request.capabilities)?;
    let budget = request.budget.unwrap_or_default();
    let run_id = state.allocate_run_id();
    let mut run = AgentRun::new(&run_id, request.goal, request.mode, budget)?;
    state.runs.insert(run.clone())?;

    let policy = AgentPolicy::new(request.mode, capabilities);
    let result = if request.mode == AgentMode::ReadOnly {
        let executor = LocalReadOnlyAgentToolExecutor::new(sql_state.inner().clone());
        let mut runtime = ReadOnlyAgentLoop::new(
            DeterministicReadOnlyAgentModelGateway::default(),
            policy,
            executor,
            Arc::clone(&state.evidence),
        );
        runtime.run(&mut run, request.task, &request.context)
    } else {
        let mut runtime = SuggestOnlyAgentLoop::new(
            DeterministicAgentModelGateway,
            policy,
            Arc::clone(&state.evidence),
        );
        runtime.run(&mut run, request.task, &request.context)
    };
    state.runs.replace(run.clone())?;

    match result {
        Ok(result) => {
            let event = SqlAgentRunEvent {
                run,
                result: Some(result),
                error: None,
            };
            emit_run_event(&app, &event);
            Ok(event)
        }
        Err(error) => {
            let event = SqlAgentRunEvent {
                run,
                result: None,
                error: Some(error.clone()),
            };
            emit_run_event(&app, &event);
            Err(error)
        }
    }
}

fn validate_task_mode(task: AgentTaskKind, mode: AgentMode) -> Result<(), SqlCommandError> {
    if task == AgentTaskKind::FixError && mode != AgentMode::SuggestOnly {
        return Err(SqlCommandError::new(
            "invalid_input",
            "Fix Error requires Suggest Only mode",
        ));
    }
    Ok(())
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
        let should_explain = matches!(
            request.task,
            AgentTaskKind::OptimizeQuery | AgentTaskKind::ExplainError
        );

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
    run_id: String,
) -> Result<SqlAgentRunEvent, SqlCommandError> {
    let run = state.runs.cancel(&run_id)?;
    let event = SqlAgentRunEvent {
        run,
        result: None,
        error: None,
    };
    emit_run_event(&app, &event);
    Ok(event)
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
    use super::*;
    use serde_json::json;

    #[test]
    fn runtime_state_allocates_opaque_monotonic_run_ids() {
        let state = AgentRuntimeState::new();
        assert_eq!(state.allocate_run_id(), "agent-run-1");
        assert_eq!(state.allocate_run_id(), "agent-run-2");
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
    fn start_request_deserializes_fix_error_with_structured_error_context() {
        let request: SqlAgentStartRequest = serde_json::from_value(json!({
            "goal": "fix the failed query",
            "task": "fix_error",
            "mode": "suggest_only",
            "context": {
                "dialect": "sqlite",
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
}
