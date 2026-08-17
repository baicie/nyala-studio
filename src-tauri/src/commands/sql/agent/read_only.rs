//! A3.1 read-only Agent SQL tools.
//!
//! The adapter deliberately reuses the stable `SQLite` store. Static analysis
//! is a deny gate, while the opened connection's read-only flag provides the
//! database-enforced second gate. No other driver is promoted by this module.

#![allow(dead_code)]

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::super::sql_analysis::{analyze_sql, SqlAnalysis, StatementRisk};
use super::super::state::SqlConnectionStore;
use super::super::types::{
    SqlCommandError, SqlConnectionKind, SqlExecuteQueryRequest, SqlQueryResult,
    DEFAULT_QUERY_ROW_LIMIT, MAX_SQL_BYTES,
};
use super::super::SqlDialect;
use super::domain::AgentCancellationToken;
use super::evidence::{AgentEvidenceKind, AgentEvidenceSensitivity};
use super::model::{AgentModelContext, AgentModelResultShape, AgentModelResultShapeColumn};
use super::plan::{normalize_sqlite_plan, SqlitePlanIdentity};
use super::policy::{AgentAuthorizedTool, AgentTool};
use super::result_policy::{
    aggregate_result, inspect_result, sample_result, AgentResultStore, AgentSampleRequest,
};
use super::runtime::{AgentToolExecution, ReadOnlyAgentToolExecutor};

const READ_ONLY_CONNECTION_REQUIRED: &str =
    "Agent read-only tools require an explicitly read-only SQLite connection";
const RUN_CONNECTION_SCOPE_REQUIRED: &str =
    "Agent read-only tool connectionId must match the run connection";
const SQLITE_ONLY: &str = "Agent read-only tools support SQLite only";
const MAX_PLAN_TEXT_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlAgentReadOnlyRequest {
    pub connection_id: String,
    pub sql: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlAgentExecuteReadonlyResult {
    pub connection_id: String,
    pub analysis: SqlAnalysis,
    pub result: SqlQueryResult,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlAgentExplainResult {
    pub connection_id: String,
    pub analysis: SqlAnalysis,
    pub plan: SqlQueryResult,
}

#[derive(Clone)]
pub struct LocalSqlAgentQueryAdapter {
    store: Arc<SqlConnectionStore>,
}

pub struct LocalReadOnlyAgentToolExecutor {
    adapter: LocalSqlAgentQueryAdapter,
    results: AgentResultStore,
    expected_connection_id: String,
    cancellation: AgentCancellationToken,
}

impl LocalReadOnlyAgentToolExecutor {
    pub fn new(
        store: Arc<SqlConnectionStore>,
        expected_connection_id: impl Into<String>,
        cancellation: AgentCancellationToken,
    ) -> Result<Self, SqlCommandError> {
        let expected_connection_id = expected_connection_id.into();
        let expected_connection_id = expected_connection_id.trim();
        if expected_connection_id.is_empty() {
            return Err(SqlCommandError::new(
                "invalid_input",
                "Agent read-only run requires a connection id",
            ));
        }
        Ok(Self {
            adapter: LocalSqlAgentQueryAdapter::new(store),
            results: AgentResultStore::default(),
            expected_connection_id: expected_connection_id.to_string(),
            cancellation,
        })
    }

    fn validate_connection_scope(
        &self,
        request: &SqlAgentReadOnlyRequest,
    ) -> Result<(), SqlCommandError> {
        if request.connection_id.trim() != self.expected_connection_id {
            return Err(SqlCommandError::new(
                "validation",
                RUN_CONNECTION_SCOPE_REQUIRED,
            ));
        }
        Ok(())
    }

    pub(crate) fn execute_explain_with_identity(
        &mut self,
        authorized: &AgentAuthorizedTool,
        identity: SqlitePlanIdentity,
    ) -> Result<AgentToolExecution, SqlCommandError> {
        if authorized.tool != AgentTool::SqlExplain {
            return Err(SqlCommandError::new(
                "invalid_input",
                "typed plan identity is only valid for sql.explain",
            ));
        }
        self.execute_explain(authorized, Some(identity))
    }

    fn execute_explain(
        &mut self,
        authorized: &AgentAuthorizedTool,
        identity: Option<SqlitePlanIdentity>,
    ) -> Result<AgentToolExecution, SqlCommandError> {
        let request = read_only_request(&authorized.arguments)?;
        self.validate_connection_scope(&request)?;
        let response = self.adapter.explain_owned(
            &request,
            &authorized.run_id,
            &authorized.call_id,
            &self.cancellation,
        )?;
        if identity
            .as_ref()
            .is_some_and(|identity| identity.connection_id != response.connection_id)
        {
            return Err(SqlCommandError::new(
                "validation",
                "SQLite plan identity does not match the explained connection",
            ));
        }
        let normalized_plan = identity
            .map(|identity| normalize_sqlite_plan(identity, &response.plan))
            .transpose()?;
        let normalized_incomplete = normalized_plan
            .as_ref()
            .is_some_and(|plan| !plan.is_complete());
        let normalized_bytes = normalized_plan
            .as_ref()
            .map_or(0, |plan| plan.returned_byte_count);
        let (plan_text, text_truncated) = format_plan_text(&response.plan);
        let result_bytes = plan_text
            .len()
            .checked_add(normalized_bytes)
            .ok_or_else(|| {
                SqlCommandError::new("internal", "SQLite explain evidence byte count overflow")
            })?;
        let partial = response.plan.truncated || text_truncated || normalized_incomplete;
        let mut warnings = Vec::new();
        if text_truncated {
            warnings
                .push("SQLite explain text was truncated by the evidence byte cap.".to_string());
        }
        if normalized_incomplete {
            warnings.push(
                "SQLite normalized plan is incomplete and cannot support a structural verdict."
                    .to_string(),
            );
        }
        Ok(AgentToolExecution {
            evidence: vec![(
                AgentEvidenceKind::Plan,
                AgentEvidenceSensitivity::Workspace,
                serde_json::json!({
                    "analysis": response.analysis,
                    "planText": plan_text,
                    "normalizedPlan": &normalized_plan,
                }),
            )],
            schema: None,
            relation_context: None,
            analysis: None,
            index_context: None,
            normalized_plan,
            result_ref: None,
            result_shape: None,
            warnings,
            query_call_count: 1,
            result_rows: 0,
            result_bytes,
            partial,
        })
    }
}

impl ReadOnlyAgentToolExecutor for LocalReadOnlyAgentToolExecutor {
    #[allow(clippy::too_many_lines)]
    fn execute(
        &mut self,
        authorized: &AgentAuthorizedTool,
        _context: &AgentModelContext,
    ) -> Result<AgentToolExecution, SqlCommandError> {
        match authorized.tool {
            AgentTool::SqlExecuteReadonly => {
                let request = read_only_request(&authorized.arguments)?;
                self.validate_connection_scope(&request)?;
                let response = self.adapter.execute_readonly_owned(
                    &request,
                    &authorized.run_id,
                    &authorized.call_id,
                    &self.cancellation,
                )?;
                let result_ref = self.results.insert(response.result.clone())?;
                let shape = inspect_result(&response.result);
                let result_bytes = shape.result_bytes;
                let aggregate = aggregate_result(&response.result);
                let model_result_shape = model_result_shape(&response.result);
                Ok(AgentToolExecution {
                    evidence: vec![
                        (
                            AgentEvidenceKind::ResultShape,
                            AgentEvidenceSensitivity::Workspace,
                            serde_json::json!({"resultRef": result_ref.clone(), "shape": shape}),
                        ),
                        (
                            AgentEvidenceKind::Aggregate,
                            AgentEvidenceSensitivity::Workspace,
                            serde_json::json!({"resultRef": result_ref.clone(), "aggregate": aggregate}),
                        ),
                    ],
                    schema: None,
                    relation_context: None,
                    analysis: None,
                    index_context: None,
                    normalized_plan: None,
                    result_ref: Some(result_ref),
                    result_shape: Some(model_result_shape),
                    warnings: if response.result.truncated {
                        vec!["Query result was truncated by the read-only result policy."
                            .to_string()]
                    } else {
                        Vec::new()
                    },
                    query_call_count: 1,
                    result_rows: response.result.row_count,
                    result_bytes,
                    partial: response.result.truncated,
                })
            }
            AgentTool::SqlExplain => self.execute_explain(authorized, None),
            AgentTool::ResultInspect => {
                let result_ref = result_ref(&authorized.arguments)?;
                let result = self.results.get(&result_ref)?;
                Ok(AgentToolExecution {
                    evidence: vec![
                        (
                            AgentEvidenceKind::ResultShape,
                            AgentEvidenceSensitivity::Workspace,
                            serde_json::json!({
                                "resultRef": result_ref.clone(),
                                "shape": inspect_result(&result),
                            }),
                        ),
                        (
                            AgentEvidenceKind::Aggregate,
                            AgentEvidenceSensitivity::Workspace,
                            serde_json::json!({
                                "resultRef": result_ref.clone(),
                                "aggregate": aggregate_result(&result),
                            }),
                        ),
                    ],
                    schema: None,
                    relation_context: None,
                    analysis: None,
                    index_context: None,
                    normalized_plan: None,
                    result_ref: Some(result_ref),
                    result_shape: Some(model_result_shape(&result)),
                    warnings: Vec::new(),
                    query_call_count: 0,
                    result_rows: 0,
                    result_bytes: 0,
                    partial: result.truncated,
                })
            }
            AgentTool::ResultSample => {
                let result_ref = result_ref(&authorized.arguments)?;
                let result = self.results.get(&result_ref)?;
                let request: AgentSampleRequest =
                    serde_json::from_value(authorized.arguments.clone()).map_err(|error| {
                        SqlCommandError::new("invalid_input", error.to_string())
                    })?;
                let sample = sample_result(&result, request)?;
                let result_rows = sample.sampled_row_count;
                let result_bytes = sample.serialized_bytes;
                Ok(AgentToolExecution {
                    evidence: vec![(
                        AgentEvidenceKind::ResultSample,
                        AgentEvidenceSensitivity::Sensitive,
                        serde_json::json!({"resultRef": result_ref, "sample": sample}),
                    )],
                    schema: None,
                    relation_context: None,
                    analysis: None,
                    index_context: None,
                    normalized_plan: None,
                    result_ref: None,
                    result_shape: None,
                    warnings: if sample.truncated {
                        vec![
                            "Approved result sample was truncated by its row or byte cap."
                                .to_string(),
                        ]
                    } else {
                        Vec::new()
                    },
                    query_call_count: 0,
                    result_rows,
                    result_bytes,
                    partial: sample.truncated,
                })
            }
            _ => Err(SqlCommandError::new(
                "invalid_input",
                "A3 executor received a tool outside the read-only result set",
            )),
        }
    }
}

fn model_result_shape(result: &SqlQueryResult) -> AgentModelResultShape {
    AgentModelResultShape {
        columns: result
            .columns
            .iter()
            .map(|column| AgentModelResultShapeColumn {
                name: column.name.clone(),
                ordinal: column.ordinal,
            })
            .collect(),
        row_count: result.row_count,
        elapsed_ms: u128::from(result.elapsed_ms),
        truncated: result.truncated,
    }
}

fn read_only_request(
    arguments: &serde_json::Value,
) -> Result<SqlAgentReadOnlyRequest, SqlCommandError> {
    serde_json::from_value(arguments.clone())
        .map_err(|error| SqlCommandError::new("invalid_input", error.to_string()))
}

fn result_ref(arguments: &serde_json::Value) -> Result<String, SqlCommandError> {
    arguments
        .get("resultRef")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| SqlCommandError::new("invalid_input", "result tool requires a resultRef"))
}

fn format_plan_text(plan: &SqlQueryResult) -> (String, bool) {
    let mut lines = Vec::new();
    for row in &plan.rows {
        let values = row
            .iter()
            .map(|cell| {
                cell.value
                    .as_ref()
                    .map_or_else(|| "NULL".to_string(), ToString::to_string)
            })
            .collect::<Vec<_>>();
        lines.push(values.join(" | "));
    }
    let mut text = lines.join("\n");
    let truncated = text.len() > MAX_PLAN_TEXT_BYTES;
    if truncated {
        let end = text
            .char_indices()
            .take_while(|(index, _)| *index <= MAX_PLAN_TEXT_BYTES)
            .map(|(index, _)| index)
            .last()
            .unwrap_or(0);
        text.truncate(end);
    }
    (text, truncated)
}

impl LocalSqlAgentQueryAdapter {
    pub fn new(store: Arc<SqlConnectionStore>) -> Self {
        Self { store }
    }

    pub fn execute_readonly(
        &self,
        request: &SqlAgentReadOnlyRequest,
    ) -> Result<SqlAgentExecuteReadonlyResult, SqlCommandError> {
        let (connection_id, sql, analysis) = validate_request(&self.store, request, false)?;
        let result = self
            .store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: connection_id.clone(),
                sql,
                limit: bounded_limit(request.limit),
            })
            .map_err(map_agent_query_error)?;

        Ok(SqlAgentExecuteReadonlyResult {
            connection_id,
            analysis,
            result,
        })
    }

    fn execute_readonly_owned(
        &self,
        request: &SqlAgentReadOnlyRequest,
        run_id: &str,
        call_id: &str,
        cancellation: &AgentCancellationToken,
    ) -> Result<SqlAgentExecuteReadonlyResult, SqlCommandError> {
        let (connection_id, sql, analysis) = validate_request(&self.store, request, false)?;
        let result = self.execute_owned_query(
            &connection_id,
            sql,
            bounded_limit(request.limit),
            run_id,
            call_id,
            cancellation,
        )?;
        Ok(SqlAgentExecuteReadonlyResult {
            connection_id,
            analysis,
            result,
        })
    }

    pub fn explain(
        &self,
        request: &SqlAgentReadOnlyRequest,
    ) -> Result<SqlAgentExplainResult, SqlCommandError> {
        let (connection_id, sql, analysis) = validate_request(&self.store, request, true)?;
        let plan_sql = if analysis.risk == StatementRisk::ExplainReadOnly {
            sql
        } else {
            format!("EXPLAIN QUERY PLAN {sql}")
        };
        let plan = self
            .store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: connection_id.clone(),
                sql: plan_sql,
                limit: bounded_limit(request.limit),
            })
            .map_err(map_agent_query_error)?;

        Ok(SqlAgentExplainResult {
            connection_id,
            analysis,
            plan,
        })
    }

    fn explain_owned(
        &self,
        request: &SqlAgentReadOnlyRequest,
        run_id: &str,
        call_id: &str,
        cancellation: &AgentCancellationToken,
    ) -> Result<SqlAgentExplainResult, SqlCommandError> {
        let (connection_id, sql, analysis) = validate_request(&self.store, request, true)?;
        let plan_sql = if analysis.risk == StatementRisk::ExplainReadOnly {
            sql
        } else {
            format!("EXPLAIN QUERY PLAN {sql}")
        };
        let plan = self.execute_owned_query(
            &connection_id,
            plan_sql,
            bounded_limit(request.limit),
            run_id,
            call_id,
            cancellation,
        )?;
        Ok(SqlAgentExplainResult {
            connection_id,
            analysis,
            plan,
        })
    }

    fn execute_owned_query(
        &self,
        connection_id: &str,
        sql: String,
        limit: Option<usize>,
        run_id: &str,
        call_id: &str,
        cancellation: &AgentCancellationToken,
    ) -> Result<SqlQueryResult, SqlCommandError> {
        if cancellation.is_cancelled() {
            return Err(cancelled_error());
        }
        let cancellation_for_query = cancellation.clone();
        let result = self.store.execute_agent_query(
            &SqlExecuteQueryRequest {
                connection_id: connection_id.to_string(),
                sql,
                limit,
            },
            run_id,
            call_id,
            move || cancellation_for_query.is_cancelled(),
        );
        if cancellation.is_cancelled() {
            return Err(cancelled_error());
        }
        result.map_err(map_agent_query_error)
    }
}

fn cancelled_error() -> SqlCommandError {
    SqlCommandError::new("invalid_input", "agent run was cancelled")
}

#[tauri::command]
pub async fn sql_agent_execute_readonly(
    state: State<'_, Arc<SqlConnectionStore>>,
    request: SqlAgentReadOnlyRequest,
) -> Result<SqlAgentExecuteReadonlyResult, SqlCommandError> {
    let adapter = LocalSqlAgentQueryAdapter::new(state.inner().clone());
    tauri::async_runtime::spawn_blocking(move || adapter.execute_readonly(&request))
        .await
        .map_err(|error| {
            SqlCommandError::new(
                "internal",
                format!("sql_agent_execute_readonly task failed: {error}"),
            )
        })?
}

#[tauri::command]
pub async fn sql_agent_explain(
    state: State<'_, Arc<SqlConnectionStore>>,
    request: SqlAgentReadOnlyRequest,
) -> Result<SqlAgentExplainResult, SqlCommandError> {
    let adapter = LocalSqlAgentQueryAdapter::new(state.inner().clone());
    tauri::async_runtime::spawn_blocking(move || adapter.explain(&request))
        .await
        .map_err(|error| {
            SqlCommandError::new(
                "internal",
                format!("sql_agent_explain task failed: {error}"),
            )
        })?
}

fn validate_request(
    store: &SqlConnectionStore,
    request: &SqlAgentReadOnlyRequest,
    allow_explain: bool,
) -> Result<(String, String, SqlAnalysis), SqlCommandError> {
    let connection_id = request.connection_id.trim();
    if connection_id.is_empty() {
        return Err(SqlCommandError::new(
            "invalid_input",
            "connection id must not be empty",
        ));
    }

    let sql = request.sql.trim();
    if sql.is_empty() {
        return Err(SqlCommandError::new(
            "invalid_input",
            "sql must not be empty",
        ));
    }
    if sql.len() > MAX_SQL_BYTES {
        return Err(SqlCommandError::new(
            "invalid_input",
            format!("sql length exceeds maximum of {MAX_SQL_BYTES} bytes"),
        ));
    }

    let connection = store.open_connection_info(connection_id)?;
    if connection.kind != SqlConnectionKind::Sqlite {
        return Err(SqlCommandError::new("validation", SQLITE_ONLY));
    }
    if !connection.read_only {
        return Err(SqlCommandError::new(
            "validation",
            READ_ONLY_CONNECTION_REQUIRED,
        ));
    }

    let analysis = analyze_sql(sql, SqlDialect::Sqlite);
    let allowed = if allow_explain {
        matches!(
            analysis.risk,
            StatementRisk::ReadOnly | StatementRisk::ExplainReadOnly
        )
    } else {
        analysis.risk == StatementRisk::ReadOnly
    };
    if analysis.statement_count != 1 || !allowed {
        return Err(SqlCommandError::new(
            "validation",
            deny_reason(&analysis, allow_explain),
        ));
    }

    Ok((connection_id.to_string(), sql.to_string(), analysis))
}

fn deny_reason(analysis: &SqlAnalysis, allow_explain: bool) -> String {
    if analysis.statement_count != 1 {
        return "Agent SQL tools require exactly one SQL statement".to_string();
    }
    if analysis.risk == StatementRisk::Unknown {
        return "Agent SQL tool cannot classify this statement safely".to_string();
    }
    if analysis.risk != StatementRisk::ReadOnly
        && !(allow_explain && analysis.risk == StatementRisk::ExplainReadOnly)
    {
        return "Agent SQL tool only allows read-only SQLite statements".to_string();
    }
    "Agent SQL statement was rejected by the read-only policy".to_string()
}

fn bounded_limit(limit: Option<usize>) -> Option<usize> {
    limit.map(|value| value.min(DEFAULT_QUERY_ROW_LIMIT))
}

fn map_agent_query_error(message: String) -> SqlCommandError {
    let code = if message.starts_with("sql must not be empty")
        || message.starts_with("sql length exceeds")
        || message.starts_with("limit must")
    {
        "invalid_input"
    } else if message.contains("connection '") && message.contains("does not exist") {
        "not_open"
    } else {
        "query_failed"
    };
    SqlCommandError::new(code, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_DB: AtomicU64 = AtomicU64::new(0);

    fn database_path(label: &str) -> std::path::PathBuf {
        let id = NEXT_TEMP_DB.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "nyala-agent-a31-{label}-{}-{id}.db",
            std::process::id()
        ))
    }

    fn input(
        id: &str,
        path: &std::path::Path,
        read_only: bool,
    ) -> super::super::super::types::SqlConnectionInput {
        super::super::super::types::SqlConnectionInput {
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
            read_only,
            create_if_missing: !read_only,
        }
    }

    fn read_only_adapter(label: &str) -> (Arc<SqlConnectionStore>, String) {
        let path = database_path(label);
        let store = Arc::new(SqlConnectionStore::new());
        store
            .open_connection(input("writer", &path, false))
            .unwrap();
        store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: "writer".to_string(),
                sql: "CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)".to_string(),
                limit: None,
            })
            .unwrap();
        store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: "writer".to_string(),
                sql: "INSERT INTO users(name) VALUES ('Alice')".to_string(),
                limit: None,
            })
            .unwrap();
        store.close_connection("writer").unwrap();
        store.open_connection(input("reader", &path, true)).unwrap();
        (store, "reader".to_string())
    }

    #[test]
    fn sqlite_select_executes_only_on_read_only_connection() {
        let (store, connection_id) = read_only_adapter("select");
        let result = LocalSqlAgentQueryAdapter::new(store)
            .execute_readonly(&SqlAgentReadOnlyRequest {
                connection_id,
                sql: "SELECT id, name FROM users".to_string(),
                limit: None,
            })
            .unwrap();
        assert_eq!(result.analysis.risk, StatementRisk::ReadOnly);
        assert_eq!(result.result.row_count, 1);
        assert_eq!(
            result.result.rows[0][1],
            super::super::super::types::SqlCellValue::text("Alice")
        );
    }

    #[test]
    fn explain_returns_sqlite_query_plan() {
        let (store, connection_id) = read_only_adapter("explain");
        let result = LocalSqlAgentQueryAdapter::new(store)
            .explain(&SqlAgentReadOnlyRequest {
                connection_id,
                sql: "SELECT id FROM users".to_string(),
                limit: None,
            })
            .unwrap();
        assert_eq!(result.analysis.risk, StatementRisk::ReadOnly);
        assert!(!result.plan.rows.is_empty());
        assert!(result
            .plan
            .columns
            .iter()
            .any(|column| column.name == "detail"));
    }

    #[test]
    fn explain_plan_text_truncation_is_utf8_safe() {
        let plan = SqlQueryResult {
            columns: vec![super::super::super::types::SqlResultColumn {
                name: "detail".to_string(),
                ordinal: 0,
            }],
            rows: vec![vec![super::super::super::types::SqlCellValue::text(
                "计划".repeat(10_000),
            )]],
            affected_rows: None,
            row_count: 1,
            elapsed_ms: 0,
            truncated: false,
        };
        let (text, truncated) = format_plan_text(&plan);
        assert!(text.len() <= MAX_PLAN_TEXT_BYTES);
        assert!(text.is_char_boundary(text.len()));
        assert!(truncated);
    }

    #[test]
    fn write_multi_statement_and_unknown_are_denied_before_execution() {
        let (store, connection_id) = read_only_adapter("deny");
        let adapter = LocalSqlAgentQueryAdapter::new(store);
        for sql in [
            "INSERT INTO users(name) VALUES ('Bob')",
            "SELECT 1; SELECT 2",
            "PRAGMA user_version",
        ] {
            let error = adapter
                .execute_readonly(&SqlAgentReadOnlyRequest {
                    connection_id: connection_id.clone(),
                    sql: sql.to_string(),
                    limit: None,
                })
                .unwrap_err();
            assert!(matches!(error, SqlCommandError::Validation { .. }));
        }
    }

    #[test]
    fn writable_connection_is_rejected_even_for_select() {
        let path = database_path("writer");
        let store = Arc::new(SqlConnectionStore::new());
        store
            .open_connection(input("writer", &path, false))
            .unwrap();
        let error = LocalSqlAgentQueryAdapter::new(store)
            .execute_readonly(&SqlAgentReadOnlyRequest {
                connection_id: "writer".to_string(),
                sql: "SELECT 1".to_string(),
                limit: None,
            })
            .unwrap_err();
        assert!(error.to_string().contains("read-only SQLite connection"));
    }

    #[test]
    fn read_only_tool_executor_rejects_cross_connection_arguments() {
        let path = database_path("connection-scope");
        let store = Arc::new(SqlConnectionStore::new());
        store
            .open_connection(input("writer", &path, false))
            .unwrap();
        store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: "writer".to_string(),
                sql: "CREATE TABLE users(id INTEGER PRIMARY KEY)".to_string(),
                limit: None,
            })
            .unwrap();
        store.close_connection("writer").unwrap();
        store
            .open_connection(input("reader-a", &path, true))
            .unwrap();
        store
            .open_connection(input("reader-b", &path, true))
            .unwrap();
        let mut executor = LocalReadOnlyAgentToolExecutor::new(
            Arc::clone(&store),
            "reader-a".to_string(),
            AgentCancellationToken::default(),
        )
        .unwrap();
        for (tool, required_capability) in [
            (
                AgentTool::SqlExecuteReadonly,
                super::super::policy::AgentCapability::DatabaseExecuteRead,
            ),
            (
                AgentTool::SqlExplain,
                super::super::policy::AgentCapability::DatabaseExplain,
            ),
        ] {
            let authorized = AgentAuthorizedTool {
                run_id: "run-reader-a".to_string(),
                call_id: format!("call-{}", tool.wire_name()),
                tool,
                arguments: serde_json::json!({
                    "connectionId": "reader-b",
                    "sql": "SELECT id FROM users"
                }),
                required_capability,
            };

            let error = executor
                .execute(&authorized, &AgentModelContext::default())
                .unwrap_err();

            assert!(matches!(error, SqlCommandError::Validation { .. }));
            assert!(error.to_string().contains("run connection"));
        }
        store.close_connection("reader-a").unwrap();
        store.close_connection("reader-b").unwrap();
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_only_tool_executor_requires_a_run_connection() {
        let result = LocalReadOnlyAgentToolExecutor::new(
            Arc::new(SqlConnectionStore::new()),
            "  ",
            AgentCancellationToken::default(),
        );
        let Err(error) = result else {
            panic!("blank run connection should be rejected");
        };

        assert!(matches!(error, SqlCommandError::InvalidInput { .. }));
        assert!(error.to_string().contains("requires a connection id"));
    }
}
