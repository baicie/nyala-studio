use crate::runtime_status::{DriverId, RuntimeStatus};
use serde::{Deserialize, Serialize};

pub const DEFAULT_QUERY_ROW_LIMIT: usize = 1_000;
pub const MAX_QUERY_ROW_LIMIT: usize = 100_000;
pub const MAX_SQL_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SqlConnectionKind {
    #[serde(rename = "sqlite")]
    Sqlite,
    #[serde(rename = "postgresql", alias = "postgre_sql")]
    PostgreSql,
    #[serde(rename = "mysql", alias = "my_sql")]
    MySql,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SqlSslMode {
    Disable,
    Prefer,
    Require,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlConnectionInput {
    pub id: Option<String>,
    pub name: Option<String>,
    pub kind: SqlConnectionKind,

    pub database_path: Option<String>,

    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub ssl_mode: Option<SqlSslMode>,

    #[serde(default)]
    pub read_only: bool,

    #[serde(default)]
    pub create_if_missing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlConnection {
    pub id: String,
    pub name: String,
    pub kind: SqlConnectionKind,

    pub database_path: Option<String>,

    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub ssl_mode: Option<SqlSslMode>,

    pub read_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlSavedConnection {
    pub id: String,
    pub name: String,
    pub kind: SqlConnectionKind,

    pub database_path: Option<String>,

    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub ssl_mode: Option<SqlSslMode>,

    pub read_only: bool,
    pub create_if_missing: bool,
    pub auto_connect: bool,
}

impl SqlSavedConnection {
    pub fn to_input(&self) -> SqlConnectionInput {
        SqlConnectionInput {
            id: Some(self.id.clone()),
            name: Some(self.name.clone()),
            kind: self.kind,
            database_path: self.database_path.clone(),
            host: self.host.clone(),
            port: self.port,
            database: self.database.clone(),
            username: self.username.clone(),
            password: None,
            ssl_mode: self.ssl_mode,
            read_only: self.read_only,
            create_if_missing: self.create_if_missing,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlSaveConnectionRequest {
    pub input: SqlConnectionInput,

    #[serde(default)]
    pub auto_connect: bool,

    #[serde(default)]
    pub open_now: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlRemoveSavedConnectionRequest {
    pub connection_id: String,

    #[serde(default)]
    pub close_if_open: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlRestoreSavedConnectionError {
    pub connection_id: String,
    pub name: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlRestoreSavedConnectionsResult {
    pub opened: Vec<SqlConnection>,
    pub errors: Vec<SqlRestoreSavedConnectionError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlConnectionTestResult {
    pub ok: bool,
    pub connection: Option<SqlConnection>,
    pub error: Option<String>,
}

impl SqlConnectionTestResult {
    pub fn ok(connection: SqlConnection) -> Self {
        Self {
            ok: true,
            connection: Some(connection),
            error: None,
        }
    }

    pub fn error(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            connection: None,
            error: Some(error.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlDatabase {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SqlTableType {
    Table,
    View,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlTable {
    pub schema: Option<String>,
    pub name: String,
    pub table_type: SqlTableType,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlListColumnsRequest {
    pub connection_id: String,
    pub table_name: String,
    pub schema: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlColumn {
    pub name: String,
    pub ordinal: i64,
    pub data_type: Option<String>,
    pub not_null: bool,
    pub primary_key: bool,
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlExecuteQueryRequest {
    pub connection_id: String,
    pub sql: String,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlCancelQueryRequest {
    pub connection_id: String,
    pub query_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlCancelQueryResult {
    pub cancelled: bool,
    pub connection_id: String,
    pub query_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SqlCellKind {
    Null,
    Integer,
    Real,
    Text,
    Blob,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlCellValue {
    pub kind: SqlCellKind,
    pub value: Option<serde_json::Value>,
}

impl SqlCellValue {
    pub fn null() -> Self {
        Self {
            kind: SqlCellKind::Null,
            value: None,
        }
    }

    pub fn integer(value: i64) -> Self {
        Self {
            kind: SqlCellKind::Integer,
            value: Some(serde_json::Value::Number(value.into())),
        }
    }

    pub fn real(value: f64) -> Self {
        Self {
            kind: SqlCellKind::Real,
            value: serde_json::Number::from_f64(value).map(serde_json::Value::Number),
        }
    }

    pub fn text(value: impl Into<String>) -> Self {
        Self {
            kind: SqlCellKind::Text,
            value: Some(serde_json::Value::String(value.into())),
        }
    }

    pub fn blob(encoded: impl Into<String>, byte_len: usize) -> Self {
        Self {
            kind: SqlCellKind::Blob,
            value: Some(serde_json::json!({
                "encoding": "base64",
                "data": encoded.into(),
                "byteLength": byte_len,
            })),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlResultColumn {
    pub name: String,
    pub ordinal: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlQueryResult {
    pub columns: Vec<SqlResultColumn>,
    pub rows: Vec<Vec<SqlCellValue>>,
    pub affected_rows: Option<usize>,
    pub row_count: usize,
    pub elapsed_ms: u64,
    pub truncated: bool,
}

// ---------------------------------------------------------------------------
// Phase 01 - Connection MVP Stabilization
//
// New "clean room" model types introduced for Phase 01. They deliberately
// duplicate the *shape* (not the storage) of `SqlConnection` so the new
// `ConnectionManager` can layer on top of the existing store without
// breaking already-shipped commands.
//
// Rules:
//   * `ConnectionProfile` is the durable shape (file-backed).
//   * `ConnectionSecret` is in-memory only; it must never reach the
//     persistence layer and must be safe to `Display`/`Debug`.
//   * `DriverIdDto` is the serde DTO for `DriverId`; serde cannot encode
//     the snake_case `DriverId` enum directly because we already own
//     `SqlConnectionKind` for the legacy wire format.
// ---------------------------------------------------------------------------

#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DriverIdDto {
    Sqlite,
    Mysql,
    Postgres,
}

impl From<DriverIdDto> for DriverId {
    fn from(value: DriverIdDto) -> Self {
        match value {
            DriverIdDto::Sqlite => DriverId::Sqlite,
            DriverIdDto::Mysql => DriverId::MySql,
            DriverIdDto::Postgres => DriverId::Postgres,
        }
    }
}

impl From<DriverId> for DriverIdDto {
    fn from(value: DriverId) -> Self {
        match value {
            DriverId::Sqlite => DriverIdDto::Sqlite,
            DriverId::MySql => DriverIdDto::Mysql,
            DriverId::Postgres => DriverIdDto::Postgres,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub label: String,
    pub driver: DriverIdDto,
    pub read_only: bool,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    #[serde(default, alias = "ssl_mode")]
    pub ssl_mode: Option<SqlSslMode>,
    pub file_path: Option<String>,
    #[serde(default)]
    pub remember_in_memory: bool,
    pub created_at_ms: i64,
}

/// In-memory secret material. NEVER persisted, NEVER logged.
#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSecret {
    pub password: Option<String>,
}

impl ConnectionSecret {
    /// Returns a deterministic redacted string. Used by Display/Debug
    /// overrides to ensure secrets never leak through logs.
    pub fn redacted_string(&self) -> String {
        let mut count = 0usize;
        if self.password.is_some() {
            count += 1;
        }
        format!("redacted:{count}fields")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum SqlCommandError {
    DriverNotAvailable { message: String },
    UnknownDriver { message: String },
    OpenFailed { message: String },
    NotOpen { message: String },
    Persistence { message: String },
    Validation { message: String },
    InvalidInput { message: String },
    ConnectionFailed { message: String },
    DdlFailed { message: String },
    InsertFailed { message: String },
    SelectFailed { message: String },
    DropFailed { message: String },
    Internal { message: String },
}

impl SqlCommandError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        match code {
            "driver_not_available" => SqlCommandError::DriverNotAvailable {
                message: message.into(),
            },
            "unknown_driver" => SqlCommandError::UnknownDriver {
                message: message.into(),
            },
            "open_failed" => SqlCommandError::OpenFailed {
                message: message.into(),
            },
            "not_open" => SqlCommandError::NotOpen {
                message: message.into(),
            },
            "persistence" => SqlCommandError::Persistence {
                message: message.into(),
            },
            "validation" => SqlCommandError::Validation {
                message: message.into(),
            },
            "invalid_input" => SqlCommandError::InvalidInput {
                message: message.into(),
            },
            "connection_failed" => SqlCommandError::ConnectionFailed {
                message: message.into(),
            },
            "ddl_failed" => SqlCommandError::DdlFailed {
                message: message.into(),
            },
            "insert_failed" => SqlCommandError::InsertFailed {
                message: message.into(),
            },
            "select_failed" => SqlCommandError::SelectFailed {
                message: message.into(),
            },
            "drop_failed" => SqlCommandError::DropFailed {
                message: message.into(),
            },
            _ => SqlCommandError::Internal {
                message: message.into(),
            },
        }
    }

    /// Adds user-facing context without changing the serialized error code.
    pub fn append_message(mut self, suffix: impl AsRef<str>) -> Self {
        let suffix = suffix.as_ref();
        match &mut self {
            SqlCommandError::DriverNotAvailable { message }
            | SqlCommandError::UnknownDriver { message }
            | SqlCommandError::OpenFailed { message }
            | SqlCommandError::NotOpen { message }
            | SqlCommandError::Persistence { message }
            | SqlCommandError::Validation { message }
            | SqlCommandError::InvalidInput { message }
            | SqlCommandError::ConnectionFailed { message }
            | SqlCommandError::DdlFailed { message }
            | SqlCommandError::InsertFailed { message }
            | SqlCommandError::SelectFailed { message }
            | SqlCommandError::DropFailed { message }
            | SqlCommandError::Internal { message } => message.push_str(suffix),
        }
        self
    }
}

impl std::fmt::Display for SqlCommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SqlCommandError::DriverNotAvailable { message }
            | SqlCommandError::UnknownDriver { message }
            | SqlCommandError::OpenFailed { message }
            | SqlCommandError::NotOpen { message }
            | SqlCommandError::Persistence { message }
            | SqlCommandError::Validation { message }
            | SqlCommandError::InvalidInput { message }
            | SqlCommandError::ConnectionFailed { message }
            | SqlCommandError::DdlFailed { message }
            | SqlCommandError::InsertFailed { message }
            | SqlCommandError::SelectFailed { message }
            | SqlCommandError::DropFailed { message }
            | SqlCommandError::Internal { message } => write!(f, "{message}"),
        }
    }
}

impl std::fmt::Debug for ConnectionSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("ConnectionSecret")
            .field(&self.redacted_string())
            .finish()
    }
}

impl std::fmt::Display for ConnectionSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.redacted_string())
    }
}

/// Mirrors `runtime_status::assert_minimum_status` but operates on the
/// `DriverIdDto` enum so the rest of Phase 01 does not need to depend on
/// the raw `DriverId` (which would re-expose the runtime status module).
pub fn assert_driver_status_at_least(
    driver: DriverIdDto,
    minimum: RuntimeStatus,
) -> Result<(), String> {
    let id: DriverId = driver.into();
    crate::runtime_status::assert_minimum_status(id, minimum)
        .map_err(|message| format!("driver {} does not meet status: {message}", id.as_token()))
}

#[cfg(test)]
mod phase01_tests {
    use super::*;

    #[test]
    fn connection_secret_display_is_redacted() {
        let secret = ConnectionSecret {
            password: Some("hunter2".into()),
        };

        let display = format!("{secret}");
        assert!(!display.contains("hunter2"));
        assert!(display.contains("redacted"));
        assert!(display.contains("1fields"));
    }

    #[test]
    fn connection_secret_debug_is_redacted() {
        let secret = ConnectionSecret {
            password: Some("hunter2".into()),
        };

        let debug = format!("{secret:?}");
        assert!(!debug.contains("hunter2"));
        assert!(debug.contains("redacted"));
        assert!(debug.contains("1fields"));
    }

    #[test]
    fn connection_secret_redacted_string_counts_fields() {
        assert_eq!(
            ConnectionSecret::default().redacted_string(),
            "redacted:0fields"
        );
        assert_eq!(
            ConnectionSecret {
                password: Some("x".into())
            }
            .redacted_string(),
            "redacted:1fields"
        );
    }

    #[test]
    fn driver_id_dto_round_trips_via_serde() {
        for (raw, token) in [
            (DriverIdDto::Sqlite, "\"sqlite\""),
            (DriverIdDto::Mysql, "\"mysql\""),
            (DriverIdDto::Postgres, "\"postgres\""),
        ] {
            let serialised = serde_json::to_string(&raw).unwrap();
            assert_eq!(serialised, token);
            let back: DriverIdDto = serde_json::from_str(&serialised).unwrap();
            assert_eq!(back, raw);
        }
    }

    #[test]
    fn connection_kind_round_trips_with_frontend_wire_tokens() {
        for (kind, token) in [
            (SqlConnectionKind::Sqlite, "\"sqlite\""),
            (SqlConnectionKind::PostgreSql, "\"postgresql\""),
            (SqlConnectionKind::MySql, "\"mysql\""),
        ] {
            let serialized = serde_json::to_string(&kind).unwrap();
            assert_eq!(serialized, token);

            let deserialized: SqlConnectionKind = serde_json::from_str(token).unwrap();
            assert_eq!(deserialized, kind);
        }
    }

    #[test]
    fn connection_kind_accepts_legacy_snake_case_tokens() {
        let postgres: SqlConnectionKind = serde_json::from_str("\"postgre_sql\"").unwrap();
        let mysql: SqlConnectionKind = serde_json::from_str("\"my_sql\"").unwrap();

        assert_eq!(postgres, SqlConnectionKind::PostgreSql);
        assert_eq!(mysql, SqlConnectionKind::MySql);
    }

    #[test]
    fn connection_input_deserializes_typescript_mysql_wire_payload() {
        let input: SqlConnectionInput = serde_json::from_value(serde_json::json!({
            "name": "Local MySQL",
            "kind": "mysql",
            "host": "127.0.0.1",
            "port": 3306,
            "database": "nyala",
            "username": "nyala",
            "password": "not-persisted",
            "sslMode": "prefer",
            "readOnly": false,
            "createIfMissing": false
        }))
        .unwrap();

        assert_eq!(input.kind, SqlConnectionKind::MySql);
    }

    #[test]
    fn driver_id_dto_into_driver_id() {
        assert_eq!(DriverId::from(DriverIdDto::Sqlite), DriverId::Sqlite);
        assert_eq!(DriverId::from(DriverIdDto::Mysql), DriverId::MySql);
        assert_eq!(DriverId::from(DriverIdDto::Postgres), DriverId::Postgres);
    }

    #[test]
    fn connection_profile_serialization_strips_secret_fields() {
        let profile = ConnectionProfile {
            id: "p1".into(),
            label: "demo".into(),
            driver: DriverIdDto::Sqlite,
            read_only: false,
            host: None,
            port: None,
            database: None,
            username: None,
            ssl_mode: Some(SqlSslMode::Require),
            file_path: Some("/tmp/x.db".into()),
            remember_in_memory: false,
            created_at_ms: 0,
        };

        let json = serde_json::to_string(&profile).unwrap();
        assert!(!json.contains("password"));
        assert!(!json.contains("secret"));
        assert!(!json.contains("credential"));
        assert!(json.contains("filePath"));
        assert!(json.contains("\"sslMode\":\"require\""));
    }

    #[test]
    fn connection_profile_deserializes_missing_camel_case_or_snake_case_ssl_mode() {
        let without_ssl: ConnectionProfile = serde_json::from_value(serde_json::json!({
            "id": "p1",
            "label": "demo",
            "driver": "mysql",
            "readOnly": false,
            "createdAtMs": 0
        }))
        .unwrap();
        assert_eq!(without_ssl.ssl_mode, None);

        let current_ssl: ConnectionProfile = serde_json::from_value(serde_json::json!({
            "id": "p1",
            "label": "demo",
            "driver": "mysql",
            "readOnly": false,
            "sslMode": "require",
            "createdAtMs": 0
        }))
        .unwrap();
        assert_eq!(current_ssl.ssl_mode, Some(SqlSslMode::Require));

        let legacy_ssl: ConnectionProfile = serde_json::from_value(serde_json::json!({
            "id": "p1",
            "label": "demo",
            "driver": "mysql",
            "readOnly": false,
            "ssl_mode": "require",
            "createdAtMs": 0
        }))
        .unwrap();
        assert_eq!(legacy_ssl.ssl_mode, Some(SqlSslMode::Require));
    }

    #[test]
    fn assert_driver_status_at_least_accepts_stable_for_sqlite() {
        assert!(assert_driver_status_at_least(DriverIdDto::Sqlite, RuntimeStatus::Stable).is_ok());
        assert!(assert_driver_status_at_least(DriverIdDto::Sqlite, RuntimeStatus::Preview).is_ok());
    }

    #[test]
    fn assert_driver_status_at_least_rejects_planned_postgres() {
        let err = assert_driver_status_at_least(DriverIdDto::Postgres, RuntimeStatus::Stable)
            .unwrap_err();
        assert!(err.contains("postgres"));
    }

    #[test]
    fn assert_driver_status_at_least_rejects_stable_minimum_for_mysql_preview() {
        // MySQL is Preview, so a `stable` minimum must reject.
        let err =
            assert_driver_status_at_least(DriverIdDto::Mysql, RuntimeStatus::Stable).unwrap_err();
        assert!(err.contains("mysql"));
    }

    #[test]
    fn sql_command_error_serializes_with_code_tag() {
        let value = SqlCommandError::new("open_failed", "boom");
        let json = serde_json::to_string(&value).unwrap();
        assert!(json.contains("\"code\":\"open_failed\""));
        assert!(json.contains("\"message\":\"boom\""));
    }

    #[test]
    fn sql_command_error_preserves_mysql_validation_codes() {
        for code in [
            "invalid_input",
            "connection_failed",
            "ddl_failed",
            "insert_failed",
            "select_failed",
            "drop_failed",
        ] {
            let value = serde_json::to_value(SqlCommandError::new(code, "boom")).unwrap();
            assert_eq!(value["code"], code);
            assert_eq!(value["message"], "boom");
        }
    }

    #[test]
    fn sql_command_error_append_message_keeps_code() {
        let value = SqlCommandError::new("insert_failed", "insert denied")
            .append_message("; temporary table cleanup failed");
        let json = serde_json::to_value(&value).unwrap();

        assert_eq!(json["code"], "insert_failed");
        assert_eq!(
            json["message"],
            "insert denied; temporary table cleanup failed"
        );
    }
}
