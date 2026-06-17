use super::state::SqlConnectionStore;
use super::types::{SqlConnection, SqlConnectionInput, SqlConnectionTestResult};
use std::sync::Arc;
use tauri::State;

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn sql_test_connection(
    state: State<'_, Arc<SqlConnectionStore>>,
    input: SqlConnectionInput,
) -> Result<SqlConnectionTestResult, String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.test_connection(input))
        .await
        .map_err(|err| format!("sql_test_connection task failed: {err}"))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn sql_open_connection(
    state: State<'_, Arc<SqlConnectionStore>>,
    input: SqlConnectionInput,
) -> Result<SqlConnection, String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.open_connection(input))
        .await
        .map_err(|err| format!("sql_open_connection task failed: {err}"))?
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn sql_close_connection(
    state: State<'_, Arc<SqlConnectionStore>>,
    connection_id: String,
) -> Result<(), String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.close_connection(&connection_id))
        .await
        .map_err(|err| format!("sql_close_connection task failed: {err}"))?
}

#[tauri::command]
pub async fn sql_list_connections(
    state: State<'_, Arc<SqlConnectionStore>>,
) -> Result<Vec<SqlConnection>, String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.list_connections())
        .await
        .map_err(|err| format!("sql_list_connections task failed: {err}"))?
}
