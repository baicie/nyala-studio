use super::state::SqlConnectionStore;
use super::types::{
    SqlCancelQueryRequest, SqlCancelQueryResult, SqlExecuteQueryRequest, SqlQueryResult,
};
use std::sync::Arc;
use tauri::State;

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn sql_execute_query(
    state: State<'_, Arc<SqlConnectionStore>>,
    request: SqlExecuteQueryRequest,
) -> Result<SqlQueryResult, String> {
    state.execute_query(request)
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn sql_cancel_query(
    state: State<'_, Arc<SqlConnectionStore>>,
    request: SqlCancelQueryRequest,
) -> Result<SqlCancelQueryResult, String> {
    state.cancel_query(request)
}
