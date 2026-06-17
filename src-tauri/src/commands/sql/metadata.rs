use super::state::SqlConnectionStore;
use super::types::{SqlColumn, SqlListColumnsRequest, SqlTable};
use std::sync::Arc;
use tauri::State;

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn sql_list_tables(
    state: State<'_, Arc<SqlConnectionStore>>,
    connection_id: String,
) -> Result<Vec<SqlTable>, String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.list_tables(&connection_id))
        .await
        .map_err(|err| format!("sql_list_tables task failed: {err}"))?
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn sql_list_columns(
    state: State<'_, Arc<SqlConnectionStore>>,
    request: SqlListColumnsRequest,
) -> Result<Vec<SqlColumn>, String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.list_columns(request))
        .await
        .map_err(|err| format!("sql_list_columns task failed: {err}"))?
}
