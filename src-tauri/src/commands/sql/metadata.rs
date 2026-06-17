use super::state::SqlConnectionStore;
use super::types::{SqlColumn, SqlListColumnsRequest, SqlTable};
use std::sync::Arc;
use tauri::State;

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn sql_list_tables(
    state: State<'_, Arc<SqlConnectionStore>>,
    connection_id: String,
) -> Result<Vec<SqlTable>, String> {
    state.list_tables(&connection_id)
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn sql_list_columns(
    state: State<'_, Arc<SqlConnectionStore>>,
    request: SqlListColumnsRequest,
) -> Result<Vec<SqlColumn>, String> {
    state.list_columns(request)
}
