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
pub use super::demo_seed::DEMO_PROFILE_ID;
use super::demo_seed::{demo_data_dir, ensure_demo_db};
use super::driver::normalize_connection_input;
use super::state::SqlConnectionStore;
use super::types::{
    ConnectionProfile, ConnectionSecret, DriverIdDto, SqlCommandError, SqlConnectionInput,
    SqlConnectionKind, SqlSaveConnectionRequest,
};

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

pub(super) fn bootstrap_demo_inner(
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
        read_only: true,
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

    let open_profile = manager.get_open_profile(DEMO_PROFILE_ID);
    let legacy_input = SqlConnectionInput {
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
        read_only: true,
        create_if_missing: false,
    };
    let expected_legacy_runtime = normalize_connection_input(&legacy_input).map_err(|message| {
        SqlCommandError::new(
            "validation",
            format!("normalize legacy demo connection: {message}"),
        )
    })?;
    let open_legacy_runtime = legacy_store.open_connection_info(DEMO_PROFILE_ID).ok();
    let v2_runtime_matches = open_profile.as_ref() == Some(&profile);
    let legacy_runtime_matches = open_legacy_runtime.as_ref() == Some(&expected_legacy_runtime);

    if open_profile.is_some() && !v2_runtime_matches {
        manager.close(DEMO_PROFILE_ID);
    }
    if open_legacy_runtime.is_some() && !legacy_runtime_matches {
        if let Err(message) = legacy_store.close_connection(DEMO_PROFILE_ID) {
            close_demo_runtimes(manager, legacy_store);
            return Err(SqlCommandError::new(
                "internal",
                format!("close legacy demo connection: {message}"),
            ));
        }
    }

    if let Err(error) = manager.upsert_profile(profile.clone()) {
        close_demo_runtimes(manager, legacy_store);
        return Err(error);
    }
    if !v2_runtime_matches {
        if let Err(error) = manager.open(&profile, ConnectionSecret::default()) {
            close_demo_runtimes(manager, legacy_store);
            return Err(error);
        }
    }

    let persist_legacy_result = if legacy_runtime_matches {
        legacy_store
            .save_connection(SqlSaveConnectionRequest {
                input: legacy_input,
                auto_connect: true,
                open_now: false,
            })
            .map(|_| ())
    } else {
        legacy_store
            .save_and_open_connection(legacy_input, true, true)
            .map(|_| ())
    };
    if let Err(message) = persist_legacy_result {
        // A partial V1/V2 migration must never leave either query path usable.
        close_demo_runtimes(manager, legacy_store);
        return Err(SqlCommandError::new(
            "persistence",
            format!("register legacy demo connection: {message}"),
        ));
    }

    Ok(DemoBootstrapDto {
        db_path: db_path.to_string_lossy().to_string(),
        reused,
        connected: true,
        sample_connection_id: DEMO_PROFILE_ID.to_string(),
    })
}

fn close_demo_runtimes(manager: &SharedConnectionManager, legacy_store: &SqlConnectionStore) {
    manager.close(DEMO_PROFILE_ID);
    let _ = legacy_store.close_connection(DEMO_PROFILE_ID);
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
    use std::{
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc,
        },
        thread::JoinHandle,
        time::Duration,
    };

    use super::super::types::{SqlCellValue, SqlExecuteQueryRequest, SqlQueryResult};
    use super::*;

    const LONG_RECURSIVE_QUERY: &str = "WITH RECURSIVE count(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM count WHERE x < 1000000000) SELECT sum(x) FROM count";

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

    fn writable_demo_profile(db_path: &Path) -> ConnectionProfile {
        ConnectionProfile {
            id: DEMO_PROFILE_ID.to_string(),
            label: DEMO_PROFILE_LABEL.to_string(),
            driver: DriverIdDto::Sqlite,
            read_only: false,
            host: None,
            port: None,
            database: None,
            username: None,
            ssl_mode: None,
            file_path: Some(db_path.to_string_lossy().into_owned()),
            remember_in_memory: false,
            created_at_ms: 0,
        }
    }

    fn writable_demo_input(db_path: &Path) -> SqlConnectionInput {
        SqlConnectionInput {
            id: Some(DEMO_PROFILE_ID.to_string()),
            name: Some(DEMO_PROFILE_LABEL.to_string()),
            kind: SqlConnectionKind::Sqlite,
            database_path: Some(db_path.to_string_lossy().into_owned()),
            host: None,
            port: None,
            database: None,
            username: None,
            password: None,
            ssl_mode: None,
            read_only: false,
            create_if_missing: false,
        }
    }

    fn open_writable_demo_runtimes(
        manager: &SharedConnectionManager,
        legacy_store: &SqlConnectionStore,
        db_path: &Path,
    ) {
        ensure_demo_db(db_path).expect("seed legacy writable Demo");

        let profile = writable_demo_profile(db_path);
        manager
            .upsert_profile(profile.clone())
            .expect("save writable V2 Demo");
        manager
            .open_without_builtin_policy(&profile, ConnectionSecret::default())
            .expect("open writable V2 Demo");
        legacy_store
            .save_and_open_connection_without_builtin_policy(
                &writable_demo_input(db_path),
                true,
                true,
            )
            .expect("open writable V1 Demo");
    }

    fn block_persistence_file(path: &Path) {
        std::fs::remove_file(path).expect("remove persistence file");
        std::fs::create_dir(path).expect("replace persistence file with directory");
    }

    struct RunningDemoQuery {
        started: mpsc::Receiver<()>,
        result: mpsc::Receiver<Result<SqlQueryResult, String>>,
        stop: Arc<AtomicBool>,
        worker: Option<JoinHandle<()>>,
    }

    impl RunningDemoQuery {
        fn spawn_unowned(store: Arc<SqlConnectionStore>) -> Self {
            let (started_tx, started_rx) = mpsc::sync_channel(1);
            let (result_tx, result_rx) = mpsc::sync_channel(1);
            let stop = Arc::new(AtomicBool::new(false));
            let stop_in_query = Arc::clone(&stop);
            let mut started_tx = Some(started_tx);
            store
                .install_sqlite_progress_handler_for_test(DEMO_PROFILE_ID, move || {
                    if let Some(started_tx) = started_tx.take() {
                        let _ = started_tx.send(());
                    }
                    stop_in_query.load(Ordering::Acquire)
                })
                .expect("install Demo query progress handler");

            let worker = std::thread::spawn(move || {
                let result = store.execute_query(SqlExecuteQueryRequest {
                    connection_id: DEMO_PROFILE_ID.to_string(),
                    sql: LONG_RECURSIVE_QUERY.to_string(),
                    limit: Some(1),
                });
                let _ = result_tx.send(result);
            });

            Self {
                started: started_rx,
                result: result_rx,
                stop,
                worker: Some(worker),
            }
        }

        fn join(&mut self) {
            if let Some(worker) = self.worker.take() {
                worker.join().expect("join Demo query worker");
            }
        }
    }

    impl Drop for RunningDemoQuery {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            self.join();
        }
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
        assert!(
            manager
                .get_profile(DEMO_PROFILE_ID)
                .expect("saved V2 Demo profile")
                .read_only
        );
        assert!(
            manager
                .get_open_profile(DEMO_PROFILE_ID)
                .expect("open V2 Demo profile")
                .read_only
        );
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
        assert!(
            legacy_store
                .list_connections()
                .expect("open V1 Demo connections")
                .into_iter()
                .find(|connection| connection.id == DEMO_PROFILE_ID)
                .expect("open V1 Demo connection")
                .read_only
        );
        assert!(
            legacy_store
                .list_saved_connections()
                .expect("saved V1 Demo connections")
                .into_iter()
                .find(|connection| connection.id == DEMO_PROFILE_ID)
                .expect("saved V1 Demo connection")
                .read_only
        );
    }

    #[test]
    fn bootstrap_demo_rejects_mutations_through_v1_query_runtime() {
        let (root, manager, legacy_store) = fresh_stores("v1-read-only");
        bootstrap_demo_inner(&manager, &legacy_store, &root.join("demo.db")).expect("bootstrap");

        let error = legacy_store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: DEMO_PROFILE_ID.to_string(),
                sql: "UPDATE users SET name = 'Changed' WHERE id = 1".to_string(),
                limit: None,
            })
            .expect_err("Demo connection must reject mutation queries");

        assert_eq!(
            error,
            "read-only connection only allows explicitly read-only statements"
        );
    }

    #[test]
    fn bootstrap_demo_replaces_existing_writable_runtimes() {
        let (root, manager, legacy_store) = fresh_stores("upgrade-writable");
        let db_path = root.join("demo.db");
        open_writable_demo_runtimes(&manager, &legacy_store, &db_path);
        let (_, writable_revision) = manager
            .get_open_profile_with_revision(DEMO_PROFILE_ID)
            .expect("writable V2 Demo runtime");

        bootstrap_demo_inner(&manager, &legacy_store, &db_path).expect("upgrade Demo bootstrap");
        let (_, read_only_revision) = manager
            .get_open_profile_with_revision(DEMO_PROFILE_ID)
            .expect("upgraded V2 Demo runtime");

        assert!(
            manager
                .get_open_profile(DEMO_PROFILE_ID)
                .expect("upgraded V2 Demo runtime")
                .read_only
        );
        assert!(
            legacy_store
                .open_connection_info(DEMO_PROFILE_ID)
                .expect("upgraded V1 Demo runtime")
                .read_only
        );
        assert!(read_only_revision > writable_revision);
    }

    #[test]
    fn bootstrap_demo_interrupts_in_flight_writable_v1_query_before_replacement() {
        let (root, manager, legacy_store) = fresh_stores("interrupt-writable-v1");
        let legacy_store = Arc::new(legacy_store);
        let db_path = root.join("demo.db");
        open_writable_demo_runtimes(&manager, legacy_store.as_ref(), &db_path);
        let mut query = RunningDemoQuery::spawn_unowned(Arc::clone(&legacy_store));
        query
            .started
            .recv_timeout(Duration::from_secs(5))
            .expect("writable Demo query should enter the SQLite VM");

        bootstrap_demo_inner(&manager, legacy_store.as_ref(), &db_path)
            .expect("migrate writable Demo runtime");
        let query_error = query
            .result
            .recv_timeout(Duration::from_secs(5))
            .expect("replaced Demo query should stop promptly")
            .expect_err("replaced Demo query should be interrupted");
        query.join();

        assert!(
            query_error.contains("interrupted"),
            "unexpected query error: {query_error}"
        );
        assert!(
            legacy_store
                .open_connection_info(DEMO_PROFILE_ID)
                .expect("replacement V1 Demo runtime")
                .read_only
        );
    }

    #[test]
    fn bootstrap_demo_restores_read_only_runtimes_after_process_restart() {
        let (root, manager, legacy_store) = fresh_stores("process-restart");
        let db_path = root.join("demo.db");
        let v2_persistence = root.join("connections-v2.json");
        let v1_persistence = root.join("connections-v1.json");
        bootstrap_demo_inner(&manager, &legacy_store, &db_path).expect("initial bootstrap");
        manager.close(DEMO_PROFILE_ID);
        legacy_store
            .close_connection(DEMO_PROFILE_ID)
            .expect("close initial V1 Demo runtime");
        drop(manager);
        drop(legacy_store);

        let restarted_manager =
            super::super::connection_manager::build_default_manager(Some(v2_persistence));
        restarted_manager
            .load_persisted()
            .expect("load persisted V2 profiles");
        let restarted_legacy_store = SqlConnectionStore::new();
        restarted_legacy_store
            .initialize_persistence(v1_persistence)
            .expect("load persisted V1 profiles");
        assert!(!restarted_manager.is_open(DEMO_PROFILE_ID));
        assert!(restarted_legacy_store
            .list_connections()
            .expect("restarted V1 runtimes")
            .is_empty());

        bootstrap_demo_inner(&restarted_manager, &restarted_legacy_store, &db_path)
            .expect("restart bootstrap");

        assert!(
            restarted_manager
                .get_open_profile(DEMO_PROFILE_ID)
                .expect("restored V2 Demo runtime")
                .read_only
        );
        assert!(
            restarted_legacy_store
                .open_connection_info(DEMO_PROFILE_ID)
                .expect("restored V1 Demo runtime")
                .read_only
        );
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
    fn bootstrap_demo_preserves_matching_v1_runtime_and_its_cancel_handle() {
        let (root, manager, legacy_store) = fresh_stores("preserve-v1-runtime");
        let legacy_store = Arc::new(legacy_store);
        let db_path = root.join("demo.db");
        bootstrap_demo_inner(&manager, legacy_store.as_ref(), &db_path).expect("initial bootstrap");

        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_in_query = Arc::clone(&stop);
        let query_store = Arc::clone(&legacy_store);
        let worker = std::thread::spawn(move || {
            let mut cancellation_checks = 0;
            let result = query_store.execute_agent_query(
                &SqlExecuteQueryRequest {
                    connection_id: DEMO_PROFILE_ID.to_string(),
                    sql: LONG_RECURSIVE_QUERY.to_string(),
                    limit: Some(1),
                },
                "run-demo-bootstrap",
                "call-long",
                move || {
                    cancellation_checks += 1;
                    if cancellation_checks == 2 {
                        let _ = started_tx.send(());
                    }
                    stop_in_query.load(Ordering::Acquire)
                },
            );
            let _ = result_tx.send(result);
        });

        started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("Demo query should enter the SQLite VM");
        bootstrap_demo_inner(&manager, legacy_store.as_ref(), &db_path).expect("repeat bootstrap");

        let interrupted = legacy_store
            .cancel_agent_queries_for_run("run-demo-bootstrap")
            .expect("cancel Demo query");
        stop.store(true, Ordering::Release);
        let query_error = result_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("Demo query should stop promptly")
            .expect_err("long Demo query should be interrupted");
        worker.join().expect("join Demo query worker");

        assert_eq!(interrupted, 1);
        assert!(
            query_error.contains("interrupted"),
            "unexpected query error: {query_error}"
        );
    }

    #[test]
    fn bootstrap_demo_preserves_matching_v2_runtime_revision() {
        let (root, manager, legacy_store) = fresh_stores("preserve-v2-runtime");
        let db_path = root.join("demo.db");
        bootstrap_demo_inner(&manager, &legacy_store, &db_path).expect("initial bootstrap");
        let (_, first_revision) = manager
            .get_open_profile_with_revision(DEMO_PROFILE_ID)
            .expect("initial V2 Demo runtime");

        bootstrap_demo_inner(&manager, &legacy_store, &db_path).expect("repeat bootstrap");
        let (_, second_revision) = manager
            .get_open_profile_with_revision(DEMO_PROFILE_ID)
            .expect("repeated V2 Demo runtime");

        assert_eq!(second_revision, first_revision);
    }

    #[test]
    fn bootstrap_demo_closes_both_runtimes_when_v1_persistence_fails() {
        let (root, manager, legacy_store) = fresh_stores("v1-persistence-failure");
        let db_path = root.join("demo.db");
        open_writable_demo_runtimes(&manager, &legacy_store, &db_path);
        block_persistence_file(&root.join("connections-v1.json"));

        let error = bootstrap_demo_inner(&manager, &legacy_store, &db_path)
            .expect_err("V1 persistence failure must fail Demo bootstrap");

        assert!(matches!(error, SqlCommandError::Persistence { .. }));
        assert!(!manager.is_open(DEMO_PROFILE_ID));
        assert!(legacy_store.open_connection_info(DEMO_PROFILE_ID).is_err());

        let saved = legacy_store
            .list_saved_connections()
            .expect("restored legacy V1 saved profile");
        assert!(
            !saved[0].read_only,
            "test fixture must retain legacy disk state"
        );

        let restored = legacy_store
            .restore_saved_connections()
            .expect("restore legacy Demo profile under runtime policy");
        assert!(restored.errors.is_empty());
        assert!(restored.opened[0].read_only);
        assert!(legacy_store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: DEMO_PROFILE_ID.to_string(),
                sql: "UPDATE users SET name = 'Changed' WHERE id = 1".to_string(),
                limit: None,
            })
            .is_err());
    }

    #[test]
    fn bootstrap_demo_rolls_back_profile_and_closes_runtimes_when_v2_persistence_fails() {
        let (root, manager, legacy_store) = fresh_stores("v2-persistence-failure");
        let db_path = root.join("demo.db");
        open_writable_demo_runtimes(&manager, &legacy_store, &db_path);
        block_persistence_file(&root.join("connections-v2.json"));

        let error = bootstrap_demo_inner(&manager, &legacy_store, &db_path)
            .expect_err("V2 persistence failure must fail Demo bootstrap");

        assert!(matches!(error, SqlCommandError::Persistence { .. }));
        let restored_profile = manager
            .get_profile(DEMO_PROFILE_ID)
            .expect("restored V2 Demo profile");
        assert!(!restored_profile.read_only);
        assert!(!manager.is_open(DEMO_PROFILE_ID));
        assert!(legacy_store.open_connection_info(DEMO_PROFILE_ID).is_err());

        manager
            .open(&restored_profile, ConnectionSecret::default())
            .expect("reopen legacy V2 Demo profile under runtime policy");
        assert!(
            manager
                .get_open_profile(DEMO_PROFILE_ID)
                .expect("policy-hardened V2 Demo runtime")
                .read_only
        );
    }

    #[test]
    fn demo_profile_label_and_id_are_stable() {
        assert_eq!(DEMO_PROFILE_ID, "demo-sqlite");
        assert_eq!(DEMO_PROFILE_LABEL, "Demo (SQLite)");
    }
}
