use super::types::SqlSavedConnection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const SQL_CONNECTIONS_DOCUMENT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SqlConnectionsDocument {
    version: u32,
    connections: Vec<SqlSavedConnection>,
}

pub fn load_saved_connections(path: &Path) -> Result<Vec<SqlSavedConnection>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(path)
        .map_err(|err| format!("failed to read saved SQL connections: {err}"))?;

    if content.trim().is_empty() {
        return Ok(Vec::new());
    }

    let document: SqlConnectionsDocument = serde_json::from_str(&content)
        .map_err(|err| format!("failed to parse saved SQL connections: {err}"))?;

    if document.version != SQL_CONNECTIONS_DOCUMENT_VERSION {
        return Err(format!(
            "unsupported saved SQL connections version: {}",
            document.version
        ));
    }

    Ok(document.connections)
}

pub fn save_saved_connections(
    path: &Path,
    connections: &[SqlSavedConnection],
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "failed to create saved SQL connections directory {}: {err}",
                parent.display()
            )
        })?;
    }

    let document = SqlConnectionsDocument {
        version: SQL_CONNECTIONS_DOCUMENT_VERSION,
        connections: connections.to_vec(),
    };

    let content = serde_json::to_string_pretty(&document)
        .map_err(|err| format!("failed to serialize saved SQL connections: {err}"))?;

    let tmp_path = temporary_path(path);

    fs::write(&tmp_path, content).map_err(|err| {
        format!(
            "failed to write saved SQL connections temp file {}: {err}",
            tmp_path.display()
        )
    })?;

    fs::rename(&tmp_path, path).map_err(|err| {
        format!(
            "failed to replace saved SQL connections file {}: {err}",
            path.display()
        )
    })?;

    Ok(())
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut tmp = path.to_path_buf();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!("{value}.tmp"))
        .unwrap_or_else(|| "tmp".to_string());

    tmp.set_extension(extension);
    tmp
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sql::types::SqlConnectionKind;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn load_saved_connections_returns_empty_when_file_is_missing() {
        let path = temp_file("missing");
        assert_eq!(load_saved_connections(&path).unwrap(), Vec::new());
    }

    #[test]
    fn save_and_load_saved_connections_round_trip() {
        let path = temp_file("round-trip");

        let connections = vec![SqlSavedConnection {
            id: "local".to_string(),
            name: "Local SQLite".to_string(),
            kind: SqlConnectionKind::Sqlite,
            database_path: "/tmp/app.db".to_string(),
            read_only: false,
            create_if_missing: true,
            auto_connect: true,
        }];

        save_saved_connections(&path, &connections).unwrap();

        let loaded = load_saved_connections(&path).unwrap();
        assert_eq!(loaded, connections);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn load_saved_connections_rejects_unknown_version() {
        let path = temp_file("bad-version");

        fs::write(
            &path,
            r#"{
              "version": 999,
              "connections": []
            }"#,
        )
        .unwrap();

        let err = load_saved_connections(&path).unwrap_err();
        assert!(err.contains("unsupported saved SQL connections version"));

        let _ = fs::remove_file(path);
    }

    fn temp_file(name: &str) -> PathBuf {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();

        std::env::temp_dir().join(format!("sql-studio-next-{name}-{now}.json"))
    }
}
