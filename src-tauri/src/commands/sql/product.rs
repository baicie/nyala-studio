/*---------------------------------------------------------------------------------------------
 * Nyala Studio - Phase 08 demo bootstrap command.
 *
 * `sql_bootstrap_demo` is the entry point that the workbench calls on
 * first launch (or on demand from the welcome view) to materialize a
 * working SQLite demo flow:
 *
 *   1. Decide where the demo database should live (NYALA_DATA_DIR
 *      override or the platform default).
 *   2. Seed the SQLite file with users + orders via `demo_seed`.
 *   3. Register a `Demo (SQLite)` profile with the `ConnectionManager`.
 *   4. Open the connection so subsequent commands (list tables, run a
 *      SELECT) see a real connection without the user clicking through
 *      the connection form.
 *
 * The command returns enough metadata for the UI to navigate the user
 * straight to the metadata explorer or to the SQL editor.
 *--------------------------------------------------------------------------------------------*/

#![allow(clippy::needless_pass_by_value)]

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;

use super::connection_manager::SharedConnectionManager;
use super::demo_seed::{demo_data_dir, ensure_demo_db};
use super::types::{ConnectionProfile, ConnectionSecret, DriverIdDto, SqlCommandError};

/// Profile id used for the demo connection. Stable across runs so the
/// welcome view can deep-link to it.
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

/// Tauri command: seed the demo `SQLite` file (idempotent), register the
/// demo profile, and open it. Returns enough metadata for the UI to
/// surface the connection.
#[tauri::command]
pub fn sql_bootstrap_demo(
    manager: State<'_, SharedConnectionManager>,
) -> Result<DemoBootstrapDto, SqlCommandError> {
    let db_path = demo_data_dir().join("demo.db");
    let reused = db_path.exists();
    ensure_demo_db(&db_path)?;

    let profile = ConnectionProfile {
        id: DEMO_PROFILE_ID.to_string(),
        label: DEMO_PROFILE_LABEL.to_string(),
        driver: DriverIdDto::Sqlite,
        read_only: false,
        host: None,
        port: None,
        database: None,
        username: None,
        file_path: Some(db_path.to_string_lossy().to_string()),
        remember_in_memory: false,
        created_at_ms: now_ms(),
    };

    // SQLite demo connection has no secret, but `open` requires the
    // caller to surface one anyway — using `ConnectionSecret::default()`
    // keeps the secret-handling code path identical to the user-driven
    // open flow.
    let secret = ConnectionSecret::default();
    manager.upsert_profile(profile.clone())?;
    manager.put_secret(&profile.id, secret.clone());
    let connection_id = manager.open(&profile, secret)?;

    Ok(DemoBootstrapDto {
        db_path: db_path.to_string_lossy().to_string(),
        reused,
        connected: true,
        sample_connection_id: connection_id,
    })
}

fn now_ms() -> i64 {
    // Time is monotonic in practice but `as i64` on the `u128` millis
    // value can overflow far-future timestamps. Saturate instead of
    // truncating so clippy stays clean.
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Tests that touch `demo_data_dir()` serialize on this mutex so
    // they cannot race on the `NYALA_DATA_DIR` env var.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn fresh_manager(test_name: &str) -> SharedConnectionManager {
        let path = std::env::temp_dir().join(format!(
            "nyala-demo-bs-{}-{}.json",
            std::process::id(),
            test_name
        ));
        super::super::connection_manager::build_default_manager(Some(path))
    }

    #[test]
    fn bootstrap_demo_seeds_file_and_opens_profile() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let tmp =
            std::env::temp_dir().join(format!("nyala-demo-data-{}-seeds", std::process::id()));
        std::fs::create_dir_all(&tmp).expect("tmp dir");
        let prior = std::env::var_os("NYALA_DATA_DIR");
        std::env::set_var("NYALA_DATA_DIR", &tmp);

        let manager = fresh_manager("seeds");
        let dto = bootstrap_demo_inner(&manager).expect("bootstrap");
        assert_eq!(dto.sample_connection_id, DEMO_PROFILE_ID);
        assert!(dto.connected);

        let conn = rusqlite::Connection::open(&dto.db_path).expect("reopen demo db");
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
            .expect("count users");
        assert_eq!(n, 5);

        let profiles = manager.list_profiles();
        assert!(profiles.iter().any(|p| p.id == DEMO_PROFILE_ID));
        assert!(manager.is_open(DEMO_PROFILE_ID));

        match prior {
            Some(value) => std::env::set_var("NYALA_DATA_DIR", value),
            None => std::env::remove_var("NYALA_DATA_DIR"),
        }
    }

    #[test]
    fn bootstrap_demo_is_idempotent() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let tmp =
            std::env::temp_dir().join(format!("nyala-demo-data-{}-idempotent", std::process::id()));
        std::fs::create_dir_all(&tmp).expect("tmp dir");
        let prior = std::env::var_os("NYALA_DATA_DIR");
        std::env::set_var("NYALA_DATA_DIR", &tmp);

        let manager = fresh_manager("idempotent");
        let first = bootstrap_demo_inner(&manager).expect("first");
        let second = bootstrap_demo_inner(&manager).expect("second");
        assert!(!first.reused, "first run should not report reused");
        assert!(second.reused, "second run should report reused");
        let conn = rusqlite::Connection::open(&second.db_path).expect("reopen");
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
            .expect("count");
        assert_eq!(n, 5);

        match prior {
            Some(value) => std::env::set_var("NYALA_DATA_DIR", value),
            None => std::env::remove_var("NYALA_DATA_DIR"),
        }
    }

    #[test]
    fn demo_profile_label_and_id_are_stable() {
        assert_eq!(DEMO_PROFILE_ID, "demo-sqlite");
        assert_eq!(DEMO_PROFILE_LABEL, "Demo (SQLite)");
    }

    /// Same body as `sql_bootstrap_demo` minus the `State<'_, ...>`
    /// wrapper, so tests can pass the `SharedConnectionManager`
    /// directly without standing up a Tauri runtime.
    fn bootstrap_demo_inner(
        manager: &SharedConnectionManager,
    ) -> Result<DemoBootstrapDto, SqlCommandError> {
        let db_path = demo_data_dir().join("demo.db");
        let reused = db_path.exists();
        ensure_demo_db(&db_path)?;
        let profile = ConnectionProfile {
            id: DEMO_PROFILE_ID.to_string(),
            label: DEMO_PROFILE_LABEL.to_string(),
            driver: DriverIdDto::Sqlite,
            read_only: false,
            host: None,
            port: None,
            database: None,
            username: None,
            file_path: Some(db_path.to_string_lossy().to_string()),
            remember_in_memory: false,
            created_at_ms: now_ms(),
        };
        let secret = ConnectionSecret::default();
        manager.upsert_profile(profile.clone())?;
        manager.put_secret(&profile.id, secret.clone());
        let connection_id = manager.open(&profile, secret)?;
        Ok(DemoBootstrapDto {
            db_path: db_path.to_string_lossy().to_string(),
            reused,
            connected: true,
            sample_connection_id: connection_id,
        })
    }
}
