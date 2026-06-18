use super::state::SqlConnectionStore;
use super::types::{
    SqlConnection, SqlConnectionInput, SqlConnectionTestResult, SqlRemoveSavedConnectionRequest,
    SqlRestoreSavedConnectionsResult, SqlSaveConnectionRequest, SqlSavedConnection,
};
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

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn sql_save_connection(
    state: State<'_, Arc<SqlConnectionStore>>,
    request: SqlSaveConnectionRequest,
) -> Result<SqlSavedConnection, String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.save_connection(request))
        .await
        .map_err(|err| format!("sql_save_connection task failed: {err}"))?
}

#[tauri::command]
pub async fn sql_list_saved_connections(
    state: State<'_, Arc<SqlConnectionStore>>,
) -> Result<Vec<SqlSavedConnection>, String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.list_saved_connections())
        .await
        .map_err(|err| format!("sql_list_saved_connections task failed: {err}"))?
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn sql_remove_saved_connection(
    state: State<'_, Arc<SqlConnectionStore>>,
    request: SqlRemoveSavedConnectionRequest,
) -> Result<(), String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.remove_saved_connection(request))
        .await
        .map_err(|err| format!("sql_remove_saved_connection task failed: {err}"))?
}

#[tauri::command]
pub async fn sql_restore_saved_connections(
    state: State<'_, Arc<SqlConnectionStore>>,
) -> Result<SqlRestoreSavedConnectionsResult, String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.restore_saved_connections())
        .await
        .map_err(|err| format!("sql_restore_saved_connections task failed: {err}"))?
}
