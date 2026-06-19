use serde::{Deserialize, Serialize};

pub const DEFAULT_QUERY_ROW_LIMIT: usize = 1_000;
pub const MAX_QUERY_ROW_LIMIT: usize = 100_000;
pub const MAX_SQL_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SqlConnectionKind {
    Sqlite,
    PostgreSql,
    MySql,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
            kind: self.kind.clone(),
            database_path: self.database_path.clone(),
            host: self.host.clone(),
            port: self.port,
            database: self.database.clone(),
            username: self.username.clone(),
            password: None,
            ssl_mode: self.ssl_mode.clone(),
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
