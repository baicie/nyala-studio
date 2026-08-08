use super::state::SqlConnectionStore;
use super::types::{
    SqlCancelQueryRequest, SqlCancelQueryResult, SqlCommandError, SqlExecuteQueryRequest,
    SqlQueryResult,
};
use std::sync::Arc;
use tauri::State;

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn sql_execute_query(
    state: State<'_, Arc<SqlConnectionStore>>,
    request: SqlExecuteQueryRequest,
) -> Result<SqlQueryResult, SqlCommandError> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.execute_query(request))
        .await
        .map_err(|err| {
            SqlCommandError::new("internal", format!("sql_execute_query task failed: {err}"))
        })?
        .map_err(map_query_error)
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn sql_cancel_query(
    state: State<'_, Arc<SqlConnectionStore>>,
    request: SqlCancelQueryRequest,
) -> Result<SqlCancelQueryResult, SqlCommandError> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.cancel_query(request))
        .await
        .map_err(|err| {
            SqlCommandError::new("internal", format!("sql_cancel_query task failed: {err}"))
        })?
        .map_err(map_query_error)
}

fn map_query_error(message: String) -> SqlCommandError {
    let code = if message.starts_with("sql must not be empty")
        || message.starts_with("sql length exceeds")
        || message.starts_with("limit must")
    {
        "invalid_input"
    } else if message.contains("read-only connection") {
        "validation"
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

    #[test]
    fn invalid_sql_returns_a_structured_query_error() {
        let error = map_query_error("failed to prepare sql: near FROM: syntax error".to_string());

        assert!(matches!(error, SqlCommandError::QueryFailed { .. }));
        assert_eq!(serde_json::to_value(error).unwrap()["code"], "query_failed");
    }

    #[test]
    fn query_error_mapping_preserves_input_and_connection_codes() {
        assert!(matches!(
            map_query_error("sql must not be empty".to_string()),
            SqlCommandError::InvalidInput { .. }
        ));
        assert!(matches!(
            map_query_error("connection 'missing' does not exist".to_string()),
            SqlCommandError::NotOpen { .. }
        ));
        assert!(matches!(
            map_query_error("read-only connection only allows SELECT".to_string()),
            SqlCommandError::Validation { .. }
        ));
    }
}
