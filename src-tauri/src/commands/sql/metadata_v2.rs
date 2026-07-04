/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL metadata v2 (Phase 02).
 *
 * Routes schema / table / column lookups through the Phase 01
 * `ConnectionManager` instead of the legacy `SqlConnectionStore`. The
 * tree model consumes these endpoints via `ISqlMetadataService`.
 *
 * The DTOs intentionally live next to the commands so a future Phase
 * 03 / 06 can lift them into a shared types module without changing
 * the IPC wire format.
 *--------------------------------------------------------------------------------------------*/

use serde::{Deserialize, Serialize};
use tauri::State;

use super::connection_manager::SharedConnectionManager;
use super::types::SqlCommandError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemataDto {
    pub schema: String,
    pub is_default: bool,
}

#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SchemaObjectKind {
    Table,
    View,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDto {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub is_primary_key: bool,
    pub default_value: Option<String>,
    pub comment: Option<String>,
    pub ordinal: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaObjectDto {
    pub kind: SchemaObjectKind,
    pub name: String,
    pub schema: Option<String>,
    pub columns: Vec<ColumnDto>,
    pub primary_key: Vec<String>,
}

/// Errors surfaced to the UI. Mirrors the Phase 01 `SqlCommandError`
/// shape so callers can render them uniformly.
pub type MetadataResult<T> = Result<T, SqlCommandError>;

#[tauri::command]
pub fn sql_list_schemas(
    manager: State<'_, SharedConnectionManager>,
    profile_id: String,
) -> MetadataResult<Vec<SchemataDto>> {
    with_conn(&manager, &profile_id, |entry| entry.conn.list_schemas())
}

#[tauri::command]
pub fn sql_list_tables_v2(
    manager: State<'_, SharedConnectionManager>,
    profile_id: String,
    schema: String,
) -> MetadataResult<Vec<SchemaObjectDto>> {
    with_conn(&manager, &profile_id, |entry| entry.conn.list_tables(&schema))
}

#[tauri::command]
pub fn sql_list_columns_v2(
    manager: State<'_, SharedConnectionManager>,
    profile_id: String,
    schema: String,
    table: String,
) -> MetadataResult<Vec<ColumnDto>> {
    with_conn(&manager, &profile_id, |entry| entry.conn.list_columns(&schema, &table))
}

fn with_conn<R>(
    manager: &State<'_, SharedConnectionManager>,
    profile_id: &str,
    f: impl FnOnce(&mut super::connection_manager::ConnectionEntry) -> MetadataResult<R>,
) -> MetadataResult<R> {
    manager.with_conn(profile_id, f)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sql::connection_manager::{build_default_manager, ConnectionManager};
    use crate::commands::sql::driver_registry::default_registry;
    use crate::commands::sql::types::{ConnectionProfile, ConnectionSecret, DriverIdDto};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn sqlite_in_memory_profile() -> ConnectionProfile {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        ConnectionProfile {
            id: format!("smoke-{nanos}"),
            label: "smoke".into(),
            driver: DriverIdDto::Sqlite,
            read_only: false,
            host: None,
            port: None,
            database: None,
            username: None,
            file_path: None,
            remember_in_memory: true,
            created_at_ms: 0,
        }
    }

    fn unique_path() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("nyala-metadata-v2-{nanos}.json"))
    }

    #[test]
    fn schema_object_kind_serializes_lowercase() {
        let kind = SchemaObjectKind::View;
        let json = serde_json::to_string(&kind).unwrap();
        assert_eq!(json, "\"view\"");
    }

    #[test]
    fn column_dto_round_trip() {
        let col = ColumnDto {
            name: "id".into(),
            data_type: "INTEGER".into(),
            is_nullable: false,
            is_primary_key: true,
            default_value: None,
            comment: None,
            ordinal: 0,
        };
        let json = serde_json::to_string(&col).unwrap();
        assert!(json.contains("\"dataType\":\"INTEGER\""));
        assert!(json.contains("\"isPrimaryKey\":true"));
        let back: ColumnDto = serde_json::from_str(&json).unwrap();
        assert_eq!(back.name, "id");
    }

    #[test]
    fn schema_object_dto_round_trip() {
        let value = SchemaObjectDto {
            kind: SchemaObjectKind::Table,
            name: "users".into(),
            schema: Some("main".into()),
            columns: Vec::new(),
            primary_key: vec!["id".into()],
        };
        let json = serde_json::to_string(&value).unwrap();
        assert!(json.contains("\"kind\":\"table\""));
        assert!(json.contains("\"primaryKey\":[\"id\"]"));
    }

    #[test]
    fn schemata_dto_round_trip() {
        let value = SchemataDto {
            schema: "main".into(),
            is_default: true,
        };
        let json = serde_json::to_string(&value).unwrap();
        assert!(json.contains("\"isDefault\":true"));
    }

    #[test]
    fn list_schemas_for_sqlite_returns_main_via_manager() {
        let manager = ConnectionManager::new(default_registry(), unique_path());
        let profile = sqlite_in_memory_profile();
        manager
            .open(&profile, ConnectionSecret::default())
            .unwrap();

        let schemas = manager
            .with_conn(&profile.id, |entry| entry.conn.list_schemas())
            .unwrap();
        assert_eq!(schemas.len(), 1);
        assert_eq!(schemas[0].schema, "main");
        assert!(schemas[0].is_default);
    }

    #[test]
    fn list_tables_for_empty_sqlite_returns_empty() {
        let manager = ConnectionManager::new(default_registry(), unique_path());
        let profile = sqlite_in_memory_profile();
        manager
            .open(&profile, ConnectionSecret::default())
            .unwrap();

        let tables = manager
            .with_conn(&profile.id, |entry| entry.conn.list_tables("main"))
            .unwrap();
        assert!(tables.is_empty());
    }

    #[test]
    fn with_conn_returns_not_open_for_missing_profile() {
        let manager = build_default_manager(Some(unique_path()));
        let err = manager
            .with_conn("missing", |entry| {
                let _ = entry;
                Ok::<(), SqlCommandError>(())
            })
            .unwrap_err();
        assert!(matches!(err, SqlCommandError::NotOpen { .. }));
    }
}