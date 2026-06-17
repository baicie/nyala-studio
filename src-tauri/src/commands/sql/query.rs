use super::state::SqlConnectionStore;
use super::types::{
    SqlCancelQueryRequest, SqlCancelQueryResult, SqlExecuteQueryRequest, SqlQueryResult,
};
use std::sync::Arc;
use tauri::State;

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn sql_execute_query(
    state: State<'_, Arc<SqlConnectionStore>>,
    request: SqlExecuteQueryRequest,
) -> Result<SqlQueryResult, String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.execute_query(request))
        .await
        .map_err(|err| format!("sql_execute_query task failed: {err}"))?
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn sql_cancel_query(
    state: State<'_, Arc<SqlConnectionStore>>,
    request: SqlCancelQueryRequest,
) -> Result<SqlCancelQueryResult, String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.cancel_query(request))
        .await
        .map_err(|err| format!("sql_cancel_query task failed: {err}"))?
}
