use super::state::SqlConnectionStore;
use super::types::{SqlConnection, SqlConnectionInput, SqlConnectionTestResult};
use std::sync::Arc;
use tauri::State;

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn sql_test_connection(
    state: State<'_, Arc<SqlConnectionStore>>,
    input: SqlConnectionInput,
) -> SqlConnectionTestResult {
    state.test_connection(input)
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn sql_open_connection(
    state: State<'_, Arc<SqlConnectionStore>>,
    input: SqlConnectionInput,
) -> Result<SqlConnection, String> {
    state.open_connection(input)
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn sql_close_connection(
    state: State<'_, Arc<SqlConnectionStore>>,
    connection_id: String,
) -> Result<(), String> {
    state.close_connection(&connection_id)
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn sql_list_connections(
    state: State<'_, Arc<SqlConnectionStore>>,
) -> Result<Vec<SqlConnection>, String> {
    state.list_connections()
}
