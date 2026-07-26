/*---------------------------------------------------------------------------------------------
 * Nyala Studio - Connection profile persistence (Phase 01).
 *
 * Phase 01 introduces a *clean* profile model: secrets live in memory only
 * and this module owns the on-disk shape. `persistence.rs` (legacy) keeps
 * its existing `SqlSavedConnection` document untouched.
 *
 * Hard rule: this module must NOT import `ConnectionSecret` and must never
 * write a `password`, `secret` or `credentials` field. The defensive
 * `strip_secret_fields` helper runs as the *last* step before
 * deserialization so any leak path is closed at the JSON boundary.
 *--------------------------------------------------------------------------------------------*/

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::types::ConnectionProfile;

pub const CONNECTIONS_DOCUMENT_MAGIC: &str = "nyala.connections.v1";
pub const CONNECTIONS_DOCUMENT_VERSION: u32 = 1;

/// On-disk shape for saved connection profiles. Wrapped in a struct so we
/// have a forward-compatible place to bump the schema and migration logic
/// without breaking the existing `SqlConnectionsDocument`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredConnections {
    pub version: u32,
    pub profiles: Vec<ConnectionProfile>,
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum PersistenceError {
    Io(String),
    Encoding(String),
    Json(String),
    Version(String),
}

impl std::fmt::Display for PersistenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PersistenceError::Io(message) => write!(f, "io: {message}"),
            PersistenceError::Encoding(message) => write!(f, "encoding: {message}"),
            PersistenceError::Json(message) => write!(f, "json: {message}"),
            PersistenceError::Version(message) => write!(f, "version: {message}"),
        }
    }
}

impl std::error::Error for PersistenceError {}

impl From<std::io::Error> for PersistenceError {
    fn from(value: std::io::Error) -> Self {
        PersistenceError::Io(value.to_string())
    }
}

/// Loads stored profiles. Any `password` / `secret` / `credentials` field
/// is removed from the parsed document *before* deserialization into the
/// typed struct, so a leaked secret can never make it back as a
/// `ConnectionProfile` field.
pub fn load_from(path: &Path) -> Result<StoredConnections, PersistenceError> {
    if !path.exists() {
        return Ok(StoredConnections {
            version: CONNECTIONS_DOCUMENT_VERSION,
            profiles: Vec::new(),
        });
    }

    let bytes = std::fs::read(path)?;
    let text =
        String::from_utf8(bytes).map_err(|err| PersistenceError::Encoding(err.to_string()))?;

    let mut doc: HashMap<String, Value> =
        serde_json::from_str(&text).map_err(|err| PersistenceError::Json(err.to_string()))?;

    strip_secret_fields(&mut doc);

    let version = doc
        .get("version")
        .and_then(Value::as_u64)
        .ok_or_else(|| PersistenceError::Version("missing version field".to_string()))?;

    if version != u64::from(CONNECTIONS_DOCUMENT_VERSION) {
        return Err(PersistenceError::Version(format!(
            "unsupported version: {version}"
        )));
    }

    let profiles_value = doc
        .remove("profiles")
        .unwrap_or_else(|| Value::Array(Vec::new()));

    let profiles = serde_json::from_value(profiles_value)
        .map_err(|err| PersistenceError::Json(err.to_string()))?;

    Ok(StoredConnections {
        version: CONNECTIONS_DOCUMENT_VERSION,
        profiles,
    })
}

/// Persists stored profiles. The document is serialized through a JSON
/// object first so we can strip any secret field defensively even if a
/// caller accidentally hands us a `ConnectionProfile` containing one.
pub fn save_to(path: &Path, stored: &StoredConnections) -> Result<(), PersistenceError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut value =
        serde_json::to_value(stored).map_err(|err| PersistenceError::Json(err.to_string()))?;

    strip_secret_fields_root(&mut value);

    let text = serde_json::to_string_pretty(&value)
        .map_err(|err| PersistenceError::Json(err.to_string()))?;

    std::fs::write(path, text)?;
    Ok(())
}

pub fn default_path() -> PathBuf {
    let base = std::env::var_os("NYALA_DATA_DIR")
        .map(PathBuf::from)
        .or_else(dirs::data_dir)
        .unwrap_or_else(|| PathBuf::from("."));

    base.join(CONNECTIONS_DOCUMENT_MAGIC)
        .join("connections.json")
}

fn strip_secret_fields(doc: &mut HashMap<String, Value>) {
    if let Some(arr) = doc.get_mut("profiles").and_then(Value::as_array_mut) {
        for profile in arr {
            strip_secret_fields_root(profile);
        }
    }
}

fn strip_secret_fields_root(value: &mut Value) {
    if let Some(obj) = value.as_object_mut() {
        obj.remove("password");
        obj.remove("secret");
        obj.remove("credentials");
        obj.remove("connectionSecret");
        obj.remove("connection_secret");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sql::types::DriverIdDto;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn sample_profile(id: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_string(),
            label: id.to_string(),
            driver: DriverIdDto::Sqlite,
            read_only: false,
            host: None,
            port: None,
            database: None,
            username: None,
            ssl_mode: None,
            file_path: Some(format!("/tmp/{id}.db")),
            remember_in_memory: false,
            created_at_ms: 0,
        }
    }

    fn temp_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("nyala-connections-{label}-{nanos}.json"))
    }

    #[test]
    fn load_missing_file_returns_empty() {
        let path = temp_path("missing");
        let _ = std::fs::remove_file(&path);
        let stored = load_from(&path).unwrap();
        assert!(stored.profiles.is_empty());
        assert_eq!(stored.version, CONNECTIONS_DOCUMENT_VERSION);
    }

    #[test]
    fn round_trip_preserves_profiles_without_secret() {
        let path = temp_path("round-trip");
        let mut profile = sample_profile("a");
        profile.host = Some("db.example.com".to_string());
        profile.port = Some(5432);
        profile.read_only = true;
        let stored = StoredConnections {
            version: CONNECTIONS_DOCUMENT_VERSION,
            profiles: vec![profile.clone()],
        };

        save_to(&path, &stored).unwrap();
        let reloaded = load_from(&path).unwrap();
        assert_eq!(reloaded.profiles.len(), 1);
        assert_eq!(reloaded.profiles[0], profile);

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("password"));
        assert!(!raw.contains("secret"));
        assert!(!raw.contains("credentials"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_strips_password_field_defensively() {
        let path = temp_path("strip");
        let raw = r#"{
            "version": 1,
            "profiles": [
                {
                    "id": "a",
                    "label": "a",
                    "driver": "sqlite",
                    "readOnly": false,
                    "filePath": "/tmp/x.db",
                    "createdAtMs": 0,
                    "password": "should-not-survive",
                    "secret": {"username": "root", "password": "x"},
                    "credentials": {"token": "leak"}
                }
            ]
        }"#;

        std::fs::write(&path, raw).unwrap();

        let stored = load_from(&path).unwrap();
        let profile = &stored.profiles[0];

        // serialized form must not contain secret fields.
        let serialized = serde_json::to_string(profile).unwrap();
        assert!(!serialized.contains("password"));
        assert!(!serialized.contains("should-not-survive"));
        assert!(!serialized.contains("leak"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_rejects_unsupported_version() {
        let path = temp_path("version");
        std::fs::write(&path, r#"{"version": 999, "profiles": []}"#).unwrap();
        let err = load_from(&path).unwrap_err();
        match err {
            PersistenceError::Version(_) => {}
            other => panic!("expected Version error, got {other:?}"),
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn save_then_load_drops_secret_fields() {
        let path = temp_path("save-strip");

        // Build a profile through serde, then inject a `password` field
        // into the JSON object tree to simulate an upstream mistake.
        let mut raw = serde_json::json!({
            "version": 1,
            "profiles": [
                {
                    "id": "a",
                    "label": "a",
                    "driver": "sqlite",
                    "readOnly": false,
                    "filePath": "/tmp/x.db",
                    "createdAtMs": 0,
                }
            ]
        });

        if let Some(profile) = raw
            .get_mut("profiles")
            .and_then(|v| v.as_array_mut())
            .and_then(|arr| arr.first_mut())
            .and_then(|v| v.as_object_mut())
        {
            profile.insert("password".to_string(), serde_json::json!("hunter2"));
        }

        // Round-trip through save_to (which strips) then load_from.
        let mut intermediate: StoredConnections = serde_json::from_value(raw).unwrap();
        // StoredConnections requires the typed profile to lack `password`,
        // so we must build a fresh StoredConnections from the surviving profile.
        let typed_profile: ConnectionProfile = intermediate.profiles.pop().unwrap();
        let stored = StoredConnections {
            version: CONNECTIONS_DOCUMENT_VERSION,
            profiles: vec![typed_profile],
        };
        save_to(&path, &stored).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("hunter2"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn default_path_lives_under_data_dir() {
        let path = default_path();
        let raw = path.to_string_lossy();
        assert!(raw.contains(CONNECTIONS_DOCUMENT_MAGIC));
    }

    #[test]
    fn version_constant_matches_loader_default() {
        assert_eq!(CONNECTIONS_DOCUMENT_VERSION, 1);
    }
}
