/*---------------------------------------------------------------------------------------------
 * Nyala Studio - Phase 08 demo bootstrap command.
 *--------------------------------------------------------------------------------------------*/

#![allow(clippy::needless_pass_by_value)]

use std::{
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::State;

use super::connection_manager::SharedConnectionManager;
use super::demo_seed::{demo_data_dir, ensure_demo_db};
use super::state::SqlConnectionStore;
use super::types::{
    ConnectionProfile, ConnectionSecret, DriverIdDto, SqlCommandError, SqlConnectionInput,
    SqlConnectionKind, SqlSaveConnectionRequest,
};

/// Profile id used by both connection stores for the demo database.
pub const DEMO_PROFILE_ID: &str = "demo-sqlite";

/// Stable label shown in the connection tree.
pub const DEMO_PROFILE_LABEL: &str = "Demo (SQLite)";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DemoBootstrapDto {
    pub db_path: String,
    pub reused: bool,
    pub connected: bool,
    pub sample_connection_id: String,
}

/// Seeds, persists, and opens the demo connection in both SQL runtimes.
#[tauri::command]
pub async fn sql_bootstrap_demo(
    manager: State<'_, SharedConnectionManager>,
    legacy_store: State<'_, Arc<SqlConnectionStore>>,
) -> Result<DemoBootstrapDto, SqlCommandError> {
    let manager = manager.inner().clone();
    let legacy_store = legacy_store.inner().clone();
    let db_path = demo_data_dir().join("demo.db");

    tauri::async_runtime::spawn_blocking(move || {
        bootstrap_demo_inner(&manager, legacy_store.as_ref(), &db_path)
    })
    .await
    .map_err(|_| {
        SqlCommandError::new(
            "internal",
            "Demo bootstrap task stopped before it could complete",
        )
    })?
}

fn bootstrap_demo_inner(
    manager: &SharedConnectionManager,
    legacy_store: &SqlConnectionStore,
    db_path: &Path,
) -> Result<DemoBootstrapDto, SqlCommandError> {
    let reused = db_path.exists();
    ensure_demo_db(db_path)?;

    let profile = ConnectionProfile {
        id: DEMO_PROFILE_ID.to_string(),
        label: DEMO_PROFILE_LABEL.to_string(),
        driver: DriverIdDto::Sqlite,
        read_only: false,
        host: None,
        port: None,
        database: None,
        username: None,
        ssl_mode: None,
        file_path: Some(db_path.to_string_lossy().to_string()),
        remember_in_memory: false,
        created_at_ms: manager
            .get_profile(DEMO_PROFILE_ID)
            .map_or_else(now_ms, |existing| existing.created_at_ms),
    };

    manager.upsert_profile(profile.clone())?;
    if !manager.is_open(DEMO_PROFILE_ID) {
        manager.open(&profile, ConnectionSecret::default())?;
    }

    legacy_store
        .save_connection(SqlSaveConnectionRequest {
            input: SqlConnectionInput {
                id: Some(DEMO_PROFILE_ID.to_string()),
                name: Some(DEMO_PROFILE_LABEL.to_string()),
                kind: SqlConnectionKind::Sqlite,
                database_path: Some(db_path.to_string_lossy().to_string()),
                host: None,
                port: None,
                database: None,
                username: None,
                password: None,
                ssl_mode: None,
                read_only: false,
                create_if_missing: false,
            },
            auto_connect: true,
            open_now: true,
        })
        .map_err(|message| {
            SqlCommandError::new(
                "persistence",
                format!("register legacy demo connection: {message}"),
            )
        })?;

    Ok(DemoBootstrapDto {
        db_path: db_path.to_string_lossy().to_string(),
        reused,
        connected: true,
        sample_connection_id: DEMO_PROFILE_ID.to_string(),
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::super::types::{SqlCellValue, SqlExecuteQueryRequest};
    use super::*;

    fn fresh_stores(
        test_name: &str,
    ) -> (
        std::path::PathBuf,
        SharedConnectionManager,
        SqlConnectionStore,
    ) {
        let root = std::env::temp_dir().join(format!(
            "nyala-demo-bootstrap-{}-{test_name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create bootstrap test directory");

        let manager = super::super::connection_manager::build_default_manager(Some(
            root.join("connections-v2.json"),
        ));
        let legacy_store = SqlConnectionStore::new();
        legacy_store
            .initialize_persistence(root.join("connections-v1.json"))
            .expect("initialize legacy persistence");

        (root, manager, legacy_store)
    }

    #[test]
    fn bootstrap_demo_seeds_file_and_opens_v2_profile() {
        let (root, manager, legacy_store) = fresh_stores("v2-profile");
        let dto = bootstrap_demo_inner(&manager, &legacy_store, &root.join("demo.db"))
            .expect("bootstrap");

        assert_eq!(dto.sample_connection_id, DEMO_PROFILE_ID);
        assert!(dto.connected);
        assert!(manager
            .list_profiles()
            .iter()
            .any(|profile| profile.id == DEMO_PROFILE_ID));
        assert!(manager.is_open(DEMO_PROFILE_ID));
    }

    #[test]
    fn bootstrap_demo_supports_v1_query_execution() {
        let (root, manager, legacy_store) = fresh_stores("v1-query");
        bootstrap_demo_inner(&manager, &legacy_store, &root.join("demo.db")).expect("bootstrap");

        let result = legacy_store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: DEMO_PROFILE_ID.to_string(),
                sql: "SELECT COUNT(*) AS count FROM users".to_string(),
                limit: None,
            })
            .expect("execute count through legacy store");

        assert_eq!(result.rows, vec![vec![SqlCellValue::integer(5)]]);
    }

    #[test]
    fn bootstrap_demo_is_idempotent_in_both_stores() {
        let (root, manager, legacy_store) = fresh_stores("idempotent");
        let db_path = root.join("demo.db");

        let first = bootstrap_demo_inner(&manager, &legacy_store, &db_path).expect("first");
        let second = bootstrap_demo_inner(&manager, &legacy_store, &db_path).expect("second");

        assert!(!first.reused, "first run should create the demo database");
        assert!(second.reused, "second run should reuse the demo database");
        assert_eq!(manager.list_profiles().len(), 1);
        assert_eq!(
            legacy_store.list_connections().expect("connections").len(),
            1
        );
        let saved = legacy_store
            .list_saved_connections()
            .expect("saved connections");
        assert_eq!(saved.len(), 1);
        assert!(saved[0].auto_connect);

        let result = legacy_store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: DEMO_PROFILE_ID.to_string(),
                sql: "SELECT COUNT(*) FROM users u JOIN orders o ON u.id = o.user_id".to_string(),
                limit: None,
            })
            .expect("execute join count after repeated bootstrap");
        assert_eq!(result.rows, vec![vec![SqlCellValue::integer(5)]]);
    }

    #[test]
    fn demo_profile_label_and_id_are_stable() {
        assert_eq!(DEMO_PROFILE_ID, "demo-sqlite");
        assert_eq!(DEMO_PROFILE_LABEL, "Demo (SQLite)");
    }
}
