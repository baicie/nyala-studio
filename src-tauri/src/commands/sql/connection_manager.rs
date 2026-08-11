/*---------------------------------------------------------------------------------------------
 * Nyala Studio - Connection manager (Phase 01).
 *
 * Single in-process owner of:
 *   * Saved connection profiles (durable).
 *   * Open connections (runtime only).
 *   * Secrets (runtime only, never persisted).
 *
 * The manager is wrapped in `Arc` and registered with Tauri via
 * `app.manage(...)`. All state mutations go through the `Mutex` so
 * concurrent Tauri commands stay consistent.
 *--------------------------------------------------------------------------------------------*/

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::runtime_status::{assert_minimum_status, DriverId, RuntimeStatus};

use super::driver_registry::{default_registry, BoxedConnection, SqlDriverRegistry};
use super::persistence_v2::{
    default_path, load_from, save_to, PersistenceError, StoredConnections,
};
use super::types::{
    assert_driver_status_at_least, ConnectionProfile, ConnectionSecret, DriverIdDto,
    SqlCommandError,
};

pub struct ConnectionEntry {
    #[allow(dead_code)]
    pub driver_id: DriverId,
    pub conn: BoxedConnection,
    open_profile: ConnectionProfile,
}

pub struct ConnectionManager {
    inner: Mutex<Inner>,
    registry: SqlDriverRegistry,
    persistence_path: std::path::PathBuf,
}

#[derive(Default)]
struct Inner {
    drivers: HashMap<String, ConnectionEntry>,
    profile_by_id: HashMap<String, ConnectionProfile>,
    last_secret_by_id: HashMap<String, ConnectionSecret>,
}

impl ConnectionManager {
    pub fn new(registry: SqlDriverRegistry, persistence_path: std::path::PathBuf) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            registry,
            persistence_path,
        }
    }

    /// Loads saved profiles from disk; missing or unreadable files
    /// degrade to an empty store (no panic, no fallback to defaults).
    pub fn load_persisted(&self) -> Result<(), PersistenceError> {
        let stored = load_from(&self.persistence_path)?;
        let mut inner = self.inner.lock().expect("connection manager poisoned");
        for profile in stored.profiles {
            inner.profile_by_id.insert(profile.id.clone(), profile);
        }
        Ok(())
    }

    pub fn upsert_profile(&self, profile: ConnectionProfile) -> Result<(), SqlCommandError> {
        let mut inner = self.inner.lock().expect("connection manager poisoned");
        inner.profile_by_id.insert(profile.id.clone(), profile);
        // Persistence is best-effort; we surface failures as `persistence`
        // errors so the UI can toast them.
        let snapshot = stored_snapshot(&inner);
        save_to(&self.persistence_path, &snapshot)
            .map_err(|err| SqlCommandError::new("persistence", err.to_string()))
    }

    pub fn list_profiles(&self) -> Vec<ConnectionProfile> {
        let inner = self.inner.lock().expect("connection manager poisoned");
        let mut values: Vec<_> = inner.profile_by_id.values().cloned().collect();
        values.sort_by(|a, b| a.label.cmp(&b.label));
        values
    }

    pub fn get_profile(&self, profile_id: &str) -> Option<ConnectionProfile> {
        let inner = self.inner.lock().expect("connection manager poisoned");
        inner.profile_by_id.get(profile_id).cloned()
    }

    pub(crate) fn get_open_profile(&self, profile_id: &str) -> Option<ConnectionProfile> {
        let inner = self.inner.lock().expect("connection manager poisoned");
        inner
            .drivers
            .get(profile_id)
            .map(|entry| entry.open_profile.clone())
    }

    pub fn drop_secret(&self, profile_id: &str) {
        let mut inner = self.inner.lock().expect("connection manager poisoned");
        inner.last_secret_by_id.remove(profile_id);
    }

    pub fn put_secret(&self, profile_id: &str, secret: ConnectionSecret) {
        let mut inner = self.inner.lock().expect("connection manager poisoned");
        inner
            .last_secret_by_id
            .insert(profile_id.to_string(), secret);
    }

    pub fn get_secret(&self, profile_id: &str) -> Option<ConnectionSecret> {
        let inner = self.inner.lock().expect("connection manager poisoned");
        inner.last_secret_by_id.get(profile_id).cloned()
    }

    /// Drop every open driver + secret. Saved profiles remain intact.
    pub fn forget_everything(&self) {
        let mut inner = self.inner.lock().expect("connection manager poisoned");
        for entry in inner.drivers.values() {
            entry.conn.close();
        }
        inner.drivers.clear();
        inner.last_secret_by_id.clear();
    }

    /// Tests a profile + secret end-to-end. The driver is opened, the
    /// probe connection is closed, and we explicitly drop the secret
    /// from the manager. Tests must never leak secrets into `profile_by_id`.
    pub fn open_for_test(
        &self,
        profile: &ConnectionProfile,
        secret: ConnectionSecret,
    ) -> Result<(), SqlCommandError> {
        self.open_internal(profile, secret)?;
        // Open-for-test deliberately throws the connection away.
        let mut inner = self.inner.lock().expect("connection manager poisoned");
        if let Some(entry) = inner.drivers.remove(&profile.id) {
            entry.conn.close();
        }
        inner.last_secret_by_id.remove(&profile.id);
        Ok(())
    }

    /// Opens a real connection. Returns the profile id used as the
    /// runtime handle. Secrets stay in `last_secret_by_id` so that
    /// follow-up calls (Phase 03 queries, Phase 04 panels) can reuse
    /// them while the connection is open.
    pub fn open(
        &self,
        profile: &ConnectionProfile,
        secret: ConnectionSecret,
    ) -> Result<String, SqlCommandError> {
        self.open_internal(profile, secret)?;
        Ok(profile.id.clone())
    }

    fn open_internal(
        &self,
        profile: &ConnectionProfile,
        secret: ConnectionSecret,
    ) -> Result<(), SqlCommandError> {
        let minimum_status = match profile.driver {
            DriverIdDto::Sqlite | DriverIdDto::Postgres => RuntimeStatus::Stable,
            DriverIdDto::Mysql => RuntimeStatus::Preview,
        };
        assert_driver_status_at_least(profile.driver, minimum_status)
            .map_err(|message| SqlCommandError::new("driver_not_available", message))?;

        let runtime_id: DriverId = profile.driver.into();
        // Defensive runtime guard – in practice the assert above catches it,
        // but we keep this for clarity if `assert_minimum_status` is ever
        // bypassed by tests.
        assert_minimum_status(runtime_id, minimum_status)
            .map_err(|message| SqlCommandError::new("driver_not_available", message))?;

        let driver = self
            .registry
            .build(runtime_id)
            .ok_or_else(|| SqlCommandError::new("unknown_driver", "no driver registered"))?;

        let conn = driver
            .open(profile, &secret)
            .map_err(|message| SqlCommandError::new("open_failed", message))?;

        let mut inner = self.inner.lock().expect("connection manager poisoned");
        inner.drivers.insert(
            profile.id.clone(),
            ConnectionEntry {
                driver_id: runtime_id,
                conn,
                open_profile: profile.clone(),
            },
        );
        inner.last_secret_by_id.insert(profile.id.clone(), secret);
        Ok(())
    }

    pub fn close(&self, profile_id: &str) {
        let mut inner = self.inner.lock().expect("connection manager poisoned");
        if let Some(entry) = inner.drivers.remove(profile_id) {
            entry.conn.close();
        }
        inner.last_secret_by_id.remove(profile_id);
    }

    pub fn is_open(&self, profile_id: &str) -> bool {
        let inner = self.inner.lock().expect("connection manager poisoned");
        inner.drivers.contains_key(profile_id)
    }

    pub fn with_conn<R>(
        &self,
        profile_id: &str,
        f: impl FnOnce(&mut ConnectionEntry) -> Result<R, SqlCommandError>,
    ) -> Result<R, SqlCommandError> {
        let mut inner = self.inner.lock().expect("connection manager poisoned");
        let entry = inner
            .drivers
            .get_mut(profile_id)
            .ok_or_else(|| SqlCommandError::new("not_open", "connection not open"))?;
        f(entry)
    }

    pub(crate) fn with_conn_for_profile<R>(
        &self,
        profile: &ConnectionProfile,
        f: impl FnOnce(&mut ConnectionEntry) -> Result<R, SqlCommandError>,
    ) -> Result<R, SqlCommandError> {
        let mut inner = self.inner.lock().expect("connection manager poisoned");
        let entry = inner
            .drivers
            .get_mut(&profile.id)
            .ok_or_else(|| SqlCommandError::new("not_open", "connection not open"))?;

        if entry.open_profile != *profile {
            return Err(SqlCommandError::new(
                "validation",
                "open connection changed while metadata was being resolved",
            ));
        }

        f(entry)
    }
}

fn stored_snapshot(inner: &Inner) -> StoredConnections {
    let mut profiles: Vec<ConnectionProfile> = inner.profile_by_id.values().cloned().collect();
    profiles.sort_by(|a, b| a.label.cmp(&b.label));
    StoredConnections {
        version: super::persistence_v2::CONNECTIONS_DOCUMENT_VERSION,
        profiles,
    }
}

pub type SharedConnectionManager = Arc<ConnectionManager>;

pub fn build_default_manager(
    persistence_path: Option<std::path::PathBuf>,
) -> SharedConnectionManager {
    let path = persistence_path.unwrap_or_else(default_path);
    Arc::new(ConnectionManager::new(default_registry(), path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_PATH_ID: AtomicU64 = AtomicU64::new(0);

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

    fn temp_path(label: &str) -> std::path::PathBuf {
        let id = NEXT_TEMP_PATH_ID.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "nyala-conn-mgr-{}-{label}-{id}.json",
            std::process::id()
        ))
    }

    fn fresh_manager() -> ConnectionManager {
        ConnectionManager::new(default_registry(), temp_path("fresh"))
    }

    #[test]
    fn upsert_then_list_returns_profiles_sorted() {
        let manager = fresh_manager();
        manager
            .upsert_profile(profile("b", DriverIdDto::Sqlite))
            .unwrap();
        manager
            .upsert_profile(profile("a", DriverIdDto::Sqlite))
            .unwrap();
        let list = manager.list_profiles();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "a");
        assert_eq!(list[1].id, "b");
    }

    #[test]
    fn drop_secret_preserves_profile() {
        let manager = fresh_manager();
        manager
            .upsert_profile(profile("a", DriverIdDto::Sqlite))
            .unwrap();
        manager.put_secret(
            "a",
            ConnectionSecret {
                password: Some("x".into()),
            },
        );
        manager.drop_secret("a");
        assert!(manager.get_secret("a").is_none());
        assert_eq!(manager.list_profiles().len(), 1);
    }

    #[test]
    fn close_removes_open_state_and_secret() {
        let manager = fresh_manager();
        let mut p = profile("a", DriverIdDto::Sqlite);
        p.remember_in_memory = true;
        manager.upsert_profile(p.clone()).unwrap();
        manager.put_secret(
            "a",
            ConnectionSecret {
                password: Some("x".into()),
            },
        );
        manager
            .open(&p, ConnectionSecret { password: None })
            .unwrap();
        assert!(manager.is_open("a"));
        manager.close("a");
        assert!(!manager.is_open("a"));
        assert!(manager.get_secret("a").is_none());
    }

    #[test]
    fn forget_everything_keeps_profiles() {
        let manager = fresh_manager();
        let mut p = profile("a", DriverIdDto::Sqlite);
        p.remember_in_memory = true;
        manager.upsert_profile(p.clone()).unwrap();
        manager.put_secret(
            "a",
            ConnectionSecret {
                password: Some("x".into()),
            },
        );
        manager
            .open(&p, ConnectionSecret { password: None })
            .unwrap();
        manager.forget_everything();
        assert!(!manager.is_open("a"));
        assert!(manager.get_secret("a").is_none());
        assert_eq!(manager.list_profiles().len(), 1);
    }

    #[test]
    fn open_for_test_does_not_retain_secret_or_connection() {
        let manager = fresh_manager();
        let mut p = profile("a", DriverIdDto::Sqlite);
        p.remember_in_memory = true;
        manager.upsert_profile(p.clone()).unwrap();
        manager
            .open_for_test(
                &p,
                ConnectionSecret {
                    password: Some("x".into()),
                },
            )
            .unwrap();
        assert!(!manager.is_open("a"));
        assert!(manager.get_secret("a").is_none());
    }

    #[test]
    fn postgres_open_is_blocked_by_runtime_status_guard() {
        let manager = fresh_manager();
        let p = profile("a", DriverIdDto::Postgres);
        let err = manager.open(&p, ConnectionSecret::default()).unwrap_err();
        assert!(matches!(err, SqlCommandError::DriverNotAvailable { .. }));
    }

    #[test]
    fn mysql_open_succeeds_via_default_registry() {
        let manager = fresh_manager();
        let mut p = profile("a", DriverIdDto::Mysql);
        p.host = Some("127.0.0.1".into());
        p.port = Some(1);
        p.database = Some("nonexistent".into());
        let err = manager.open(&p, ConnectionSecret::default()).unwrap_err();
        // We only assert it fails through the *runtime* path (i.e. with an
        // `open_failed` code); we do not try to reach a real MySQL server.
        assert!(matches!(err, SqlCommandError::OpenFailed { .. }));
    }

    #[test]
    fn with_conn_returns_not_open_when_missing() {
        let manager = fresh_manager();
        let err = manager.with_conn("missing", |_| Ok(())).unwrap_err();
        assert!(matches!(err, SqlCommandError::NotOpen { .. }));
    }

    #[test]
    fn build_default_manager_uses_default_registry() {
        let manager = build_default_manager(Some(temp_path("default-registry")));
        // Can list profiles (empty list is fine).
        assert!(manager.list_profiles().is_empty());
    }

    #[test]
    fn load_persisted_restores_profiles_without_secrets() {
        let path = temp_path("reload");
        let writer = ConnectionManager::new(default_registry(), path.clone());
        writer
            .upsert_profile(profile("saved", DriverIdDto::Sqlite))
            .unwrap();
        writer.put_secret(
            "saved",
            ConnectionSecret {
                password: Some("must-not-persist".into()),
            },
        );

        let restored = ConnectionManager::new(default_registry(), path.clone());
        restored.load_persisted().expect("restore profiles");

        assert_eq!(restored.list_profiles().len(), 1);
        assert_eq!(restored.list_profiles()[0].id, "saved");
        assert!(restored.get_secret("saved").is_none());
        assert!(!std::fs::read_to_string(&path)
            .expect("read persisted document")
            .contains("must-not-persist"));

        let _ = std::fs::remove_file(path);
    }
}
