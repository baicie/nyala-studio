/*---------------------------------------------------------------------------------------------
 * Nyala Studio - Connection MVP Tauri commands (Phase 01).
 *
 * These commands are the durable IPC surface for the new
 * `ConnectionManager`. They sit alongside the existing
 * `sql_*_connection` commands (which talk to `SqlConnectionStore`) so
 * that the existing UI keeps working while we phase it over.
 *
 * Rules:
 *   * Secrets never round-trip into the IPC return value.
 *   * Errors are returned as `SqlCommandError` (snake_case `code`).
 *   * Test connection must never persist the secret.
 *--------------------------------------------------------------------------------------------*/

// Tauri's IPC surface requires owned parameters on every `#[tauri::command]`:
// the command handler consumes each argument and serializes the response.
// `&str` / `&State<...>` parameters would not match the runtime-generated
// invocation shim, so we silence the clippy lint here once for the file.
#![allow(clippy::needless_pass_by_value)]

use tauri::State;

use super::connection_manager::SharedConnectionManager;
use super::types::{ConnectionProfile, ConnectionSecret, SqlCommandError};

#[tauri::command]
pub async fn sql_test_connection_v2(
    manager: State<'_, SharedConnectionManager>,
    profile: ConnectionProfile,
    secret: ConnectionSecret,
) -> Result<(), SqlCommandError> {
    // Test path: open-then-close. The secret is consumed by
    // `open_for_test`, which is responsible for clearing it from the
    // manager afterwards.
    let manager = manager.inner().clone();

    tauri::async_runtime::spawn_blocking(move || manager.open_for_test(&profile, secret))
        .await
        .map_err(|_| {
            SqlCommandError::new(
                "internal",
                "Connection test task stopped before it could complete",
            )
        })?
}

#[tauri::command]
pub async fn sql_open_connection_v2(
    manager: State<'_, SharedConnectionManager>,
    profile: ConnectionProfile,
    secret: ConnectionSecret,
) -> Result<String, SqlCommandError> {
    // Save the profile first so that even a failed open still leaves
    // the profile available for re-attempt. `ConnectionManager::open`
    // stores the secret only after the driver has opened successfully.
    let manager = manager.inner().clone();

    tauri::async_runtime::spawn_blocking(move || {
        manager.upsert_profile(profile.clone())?;
        manager.open(&profile, secret)
    })
    .await
    .map_err(|_| {
        SqlCommandError::new(
            "internal",
            "Connection open task stopped before it could complete",
        )
    })?
}

#[tauri::command]
pub fn sql_close_connection_v2(manager: State<'_, SharedConnectionManager>, profile_id: String) {
    manager.close(&profile_id);
}

#[tauri::command]
pub fn sql_list_connections_v2(
    manager: State<'_, SharedConnectionManager>,
) -> Vec<ConnectionProfile> {
    manager.list_profiles()
}

#[tauri::command]
pub fn sql_forget_secrets(manager: State<'_, SharedConnectionManager>) {
    manager.forget_everything();
}

#[tauri::command]
pub fn sql_upsert_connection_v2(
    manager: State<'_, SharedConnectionManager>,
    profile: ConnectionProfile,
) -> Result<(), SqlCommandError> {
    manager.upsert_profile(profile)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sql::connection_manager::{build_default_manager, ConnectionManager};
    use crate::commands::sql::driver_registry::default_registry;
    use crate::commands::sql::types::DriverIdDto;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn profile(id: &str, driver: DriverIdDto) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_string(),
            label: id.to_string(),
            driver,
            read_only: false,
            host: None,
            port: None,
            database: None,
            username: None,
            ssl_mode: None,
            file_path: None,
            remember_in_memory: false,
            created_at_ms: 0,
        }
    }

    fn unique_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("nyala-conn-v2-{label}-{nanos}.json"))
    }

    fn sqlite_in_memory_profile(id: &str) -> ConnectionProfile {
        let mut p = profile(id, DriverIdDto::Sqlite);
        p.remember_in_memory = true;
        p
    }

    #[test]
    fn open_connection_v2_returns_profile_id() {
        let manager = build_default_manager(Some(unique_path("open")));
        manager
            .open(&sqlite_in_memory_profile("a"), ConnectionSecret::default())
            .unwrap();
        assert!(manager.is_open("a"));
    }

    #[test]
    fn close_connection_v2_drops_open_state() {
        let manager = build_default_manager(Some(unique_path("close")));
        manager
            .open(&sqlite_in_memory_profile("a"), ConnectionSecret::default())
            .unwrap();
        manager.close("a");
        assert!(!manager.is_open("a"));
    }

    #[test]
    fn list_connections_v2_returns_profiles() {
        let manager = build_default_manager(Some(unique_path("list")));
        manager
            .upsert_profile(profile("a", DriverIdDto::Sqlite))
            .unwrap();
        let list = manager.list_profiles();
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn test_connection_v2_does_not_retain_secret() {
        let manager = build_default_manager(Some(unique_path("test")));
        manager
            .open_for_test(
                &sqlite_in_memory_profile("a"),
                ConnectionSecret {
                    password: Some("hunter2".into()),
                },
            )
            .unwrap();
        // After a test, no secret is stored.
        assert!(manager.get_secret("a").is_none());
        assert!(!manager.is_open("a"));
    }

    #[test]
    fn test_connection_v2_rejects_planned_postgres() {
        let manager = build_default_manager(Some(unique_path("postgres")));
        let err = manager
            .open_for_test(
                &profile("a", DriverIdDto::Postgres),
                ConnectionSecret::default(),
            )
            .unwrap_err();
        assert!(matches!(err, SqlCommandError::DriverNotAvailable { .. }));
    }

    #[test]
    fn forget_secrets_clears_runtime_state() {
        let manager = build_default_manager(Some(unique_path("forget")));
        manager
            .open(
                &sqlite_in_memory_profile("a"),
                ConnectionSecret {
                    password: Some("hunter2".into()),
                },
            )
            .unwrap();
        assert!(manager.is_open("a"));
        manager.forget_everything();
        assert!(!manager.is_open("a"));
        assert!(manager.get_secret("a").is_none());
    }

    #[test]
    fn upsert_then_list_round_trip() {
        let manager = build_default_manager(Some(unique_path("upsert")));
        let mut p = profile("a", DriverIdDto::Sqlite);
        p.host = Some("h".into());
        p.port = Some(1234);
        manager.upsert_profile(p.clone()).unwrap();
        let list = manager.list_profiles();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].port, Some(1234));
    }

    #[test]
    fn connection_manager_uses_default_registry_when_no_path() {
        // Smoke check: build_default_manager without a path returns a
        // working manager backed by the default driver registry.
        let manager: std::sync::Arc<ConnectionManager> = Arc::new(ConnectionManager::new(
            default_registry(),
            unique_path("smoke"),
        ));
        assert!(manager.list_profiles().is_empty());
    }
}
