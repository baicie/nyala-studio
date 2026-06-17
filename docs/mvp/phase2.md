下面以 `91ff2f4` 为基准给出 **Phase 2：Rust SQL 后端最小桥** 的完整设计与代码。

当前仓库已经具备落地 Phase 2 的基础：`src-tauri/Cargo.toml` 已有 `rusqlite = { version = "0.31", features = ["bundled"] }`，不需要新增 SQLite 依赖；`commands/mod.rs` 是统一 command 模块导出点；`lib.rs` 通过 `.manage(...)` 注册全局状态，并在 `tauri::generate_handler![]` 中集中注册 command。

# Phase 2 目标

本阶段只做后端闭环：

```txt
前端 Tauri invoke
  -> sql_* commands
    -> SqlConnectionStore
      -> rusqlite Connection
        -> SQLite database
```

暂时不做：

```txt
- SQL Connections Activity
- SQL Editor UI
- Result Panel UI
- MySQL / Postgres
- 插件 API
- AI Agent
```

本阶段交付 8 个 command：

```txt
sql_test_connection
sql_open_connection
sql_close_connection
sql_list_connections
sql_list_tables
sql_list_columns
sql_execute_query
sql_cancel_query
```

---

# 文件结构

新增：

```txt
src-tauri/src/commands/sql/
├─ mod.rs
├─ types.rs
├─ state.rs
├─ connection.rs
├─ metadata.rs
└─ query.rs
```

修改：

```txt
src-tauri/src/commands/mod.rs
src-tauri/src/lib.rs
```

---

# 1. 新增 `src-tauri/src/commands/sql/mod.rs`

```rust
mod connection;
mod metadata;
mod query;
pub mod state;
pub mod types;

pub use connection::*;
pub use metadata::*;
pub use query::*;
pub use state::SqlConnectionStore;
pub use types::*;
```

---

# 2. 新增 `src-tauri/src/commands/sql/types.rs`

```rust
use serde::{Deserialize, Serialize};

pub const DEFAULT_QUERY_ROW_LIMIT: usize = 1_000;
pub const MAX_QUERY_ROW_LIMIT: usize = 100_000;
pub const MAX_SQL_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SqlConnectionKind {
    Sqlite,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlConnectionInput {
    pub id: Option<String>,
    pub name: Option<String>,
    pub kind: SqlConnectionKind,
    pub database_path: String,

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
    pub database_path: String,
    pub read_only: bool,
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
```

---

# 3. 新增 `src-tauri/src/commands/sql/state.rs`

```rust
use super::types::{
    SqlCancelQueryRequest, SqlCancelQueryResult, SqlCellValue, SqlColumn, SqlConnection,
    SqlConnectionInput, SqlConnectionKind, SqlConnectionTestResult, SqlExecuteQueryRequest,
    SqlListColumnsRequest, SqlQueryResult, SqlResultColumn, SqlTable, SqlTableType,
    DEFAULT_QUERY_ROW_LIMIT, MAX_QUERY_ROW_LIMIT, MAX_SQL_BYTES,
};
use base64::{engine::general_purpose, Engine as _};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, InterruptHandle, OpenFlags};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;
use uuid::Uuid;

type ConnectionMap = HashMap<String, Arc<SqlConnectionHandle>>;

struct SqlConnectionHandle {
    info: SqlConnection,
    conn: Mutex<Connection>,
    interrupt: InterruptHandle,
}

pub struct SqlConnectionStore {
    connections: Mutex<ConnectionMap>,
}

impl SqlConnectionStore {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
        }
    }

    pub fn test_connection(&self, input: SqlConnectionInput) -> SqlConnectionTestResult {
        match normalize_connection_input(&input)
            .and_then(|connection| open_sqlite_connection(&input).map(|conn| (connection, conn)))
        {
            Ok((connection, conn)) => match conn.query_row("SELECT 1", [], |_| Ok(())) {
                Ok(()) => SqlConnectionTestResult::ok(connection),
                Err(err) => SqlConnectionTestResult::error(format!("failed to validate connection: {err}")),
            },
            Err(err) => SqlConnectionTestResult::error(err),
        }
    }

    pub fn open_connection(&self, input: SqlConnectionInput) -> Result<SqlConnection, String> {
        let connection = normalize_connection_input(&input)?;
        let conn = open_sqlite_connection(&input)?;
        let interrupt = conn.get_interrupt_handle();

        let handle = Arc::new(SqlConnectionHandle {
            info: connection.clone(),
            conn: Mutex::new(conn),
            interrupt,
        });

        let mut connections = self.connections()?;
        if connections.contains_key(&connection.id) {
            return Err(format!(
                "connection id '{}' already exists",
                connection.id
            ));
        }

        connections.insert(connection.id.clone(), handle);

        Ok(connection)
    }

    pub fn close_connection(&self, connection_id: &str) -> Result<(), String> {
        let mut connections = self.connections()?;

        if connections.remove(connection_id).is_none() {
            return Err(format!("connection '{connection_id}' does not exist"));
        }

        Ok(())
    }

    pub fn list_connections(&self) -> Result<Vec<SqlConnection>, String> {
        let mut connections = self
            .connections()?
            .values()
            .map(|handle| handle.info.clone())
            .collect::<Vec<_>>();

        connections.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));

        Ok(connections)
    }

    pub fn list_tables(&self, connection_id: &str) -> Result<Vec<SqlTable>, String> {
        let handle = self.connection(connection_id)?;
        let conn = handle.conn.lock().map_err(|err| err.to_string())?;

        let mut stmt = conn
            .prepare(
                "SELECT name, type
                 FROM sqlite_master
                 WHERE type IN ('table', 'view')
                   AND name NOT LIKE 'sqlite_%'
                 ORDER BY type, name",
            )
            .map_err(|err| format!("failed to prepare table metadata query: {err}"))?;

        let rows = stmt
            .query_map([], |row| {
                let name = row.get::<_, String>(0)?;
                let raw_type = row.get::<_, String>(1)?;
                let table_type = if raw_type.eq_ignore_ascii_case("view") {
                    SqlTableType::View
                } else {
                    SqlTableType::Table
                };

                Ok(SqlTable {
                    schema: Some("main".to_string()),
                    name,
                    table_type,
                })
            })
            .map_err(|err| format!("failed to query table metadata: {err}"))?;

        collect_rows(rows, "failed to read table metadata row")
    }

    pub fn list_columns(&self, request: SqlListColumnsRequest) -> Result<Vec<SqlColumn>, String> {
        let handle = self.connection(&request.connection_id)?;
        let conn = handle.conn.lock().map_err(|err| err.to_string())?;

        let table_name = quote_sqlite_identifier(&request.table_name)?;
        let sql = format!("PRAGMA table_info({table_name})");

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|err| format!("failed to prepare column metadata query: {err}"))?;

        let rows = stmt
            .query_map([], |row| {
                let data_type = row.get::<_, Option<String>>(2)?;

                Ok(SqlColumn {
                    ordinal: row.get::<_, i64>(0)?,
                    name: row.get::<_, String>(1)?,
                    data_type: data_type.filter(|value| !value.trim().is_empty()),
                    not_null: row.get::<_, i64>(3)? != 0,
                    default_value: row.get::<_, Option<String>>(4)?,
                    primary_key: row.get::<_, i64>(5)? != 0,
                })
            })
            .map_err(|err| format!("failed to query column metadata: {err}"))?;

        collect_rows(rows, "failed to read column metadata row")
    }

    pub fn execute_query(&self, request: SqlExecuteQueryRequest) -> Result<SqlQueryResult, String> {
        let sql = request.sql.trim();

        if sql.is_empty() {
            return Err("sql must not be empty".to_string());
        }

        if sql.len() > MAX_SQL_BYTES {
            return Err(format!(
                "sql length exceeds maximum of {MAX_SQL_BYTES} bytes"
            ));
        }

        let limit = normalize_limit(request.limit)?;
        let handle = self.connection(&request.connection_id)?;

        if handle.info.read_only && sql_may_mutate(sql) {
            return Err("read-only connection only allows SELECT/WITH/EXPLAIN style statements".to_string());
        }

        let started_at = Instant::now();
        let conn = handle.conn.lock().map_err(|err| err.to_string())?;

        let mut stmt = conn
            .prepare(sql)
            .map_err(|err| format!("failed to prepare sql: {err}"))?;

        let column_count = stmt.column_count();

        if column_count == 0 {
            let affected_rows = stmt
                .execute([])
                .map_err(|err| format!("failed to execute sql: {err}"))?;

            return Ok(SqlQueryResult {
                columns: Vec::new(),
                rows: Vec::new(),
                affected_rows: Some(affected_rows),
                row_count: 0,
                elapsed_ms: elapsed_ms(started_at),
                truncated: false,
            });
        }

        let columns = (0..column_count)
            .map(|index| SqlResultColumn {
                name: stmt.column_name(index).unwrap_or("").to_string(),
                ordinal: index,
            })
            .collect::<Vec<_>>();

        let mut rows = stmt
            .query([])
            .map_err(|err| format!("failed to execute query: {err}"))?;

        let mut result_rows = Vec::new();
        let mut truncated = false;

        loop {
            if result_rows.len() >= limit {
                truncated = rows
                    .next()
                    .map_err(|err| format!("failed to read query row: {err}"))?
                    .is_some();
                break;
            }

            let Some(row) = rows
                .next()
                .map_err(|err| format!("failed to read query row: {err}"))?
            else {
                break;
            };

            let mut values = Vec::with_capacity(column_count);

            for index in 0..column_count {
                let value = row
                    .get_ref(index)
                    .map_err(|err| format!("failed to read column {index}: {err}"))?;
                values.push(sqlite_value_to_cell(value));
            }

            result_rows.push(values);
        }

        Ok(SqlQueryResult {
            columns,
            row_count: result_rows.len(),
            rows: result_rows,
            affected_rows: None,
            elapsed_ms: elapsed_ms(started_at),
            truncated,
        })
    }

    pub fn cancel_query(
        &self,
        request: SqlCancelQueryRequest,
    ) -> Result<SqlCancelQueryResult, String> {
        let handle = self.connection(&request.connection_id)?;
        handle.interrupt.interrupt();

        Ok(SqlCancelQueryResult {
            cancelled: true,
            connection_id: request.connection_id,
            query_id: request.query_id,
            message: "interrupt signal sent to SQLite connection".to_string(),
        })
    }

    fn connections(&self) -> Result<MutexGuard<'_, ConnectionMap>, String> {
        self.connections.lock().map_err(|err| err.to_string())
    }

    fn connection(&self, connection_id: &str) -> Result<Arc<SqlConnectionHandle>, String> {
        self.connections()?
            .get(connection_id)
            .cloned()
            .ok_or_else(|| format!("connection '{connection_id}' does not exist"))
    }
}

impl Default for SqlConnectionStore {
    fn default() -> Self {
        Self::new()
    }
}

fn normalize_connection_input(input: &SqlConnectionInput) -> Result<SqlConnection, String> {
    if input.kind != SqlConnectionKind::Sqlite {
        return Err("only sqlite connections are supported in phase 2".to_string());
    }

    let database_path = input.database_path.trim();

    if database_path.is_empty() {
        return Err("databasePath must not be empty".to_string());
    }

    validate_sqlite_path(database_path, input.create_if_missing)?;

    let id = input
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("sqlite-{}", Uuid::new_v4()));

    let name = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| default_connection_name(database_path));

    Ok(SqlConnection {
        id,
        name,
        kind: SqlConnectionKind::Sqlite,
        database_path: database_path.to_string(),
        read_only: input.read_only,
    })
}

fn validate_sqlite_path(database_path: &str, create_if_missing: bool) -> Result<(), String> {
    if database_path == ":memory:" {
        return Ok(());
    }

    let path = Path::new(database_path);

    if path.exists() {
        if path.is_dir() {
            return Err(format!(
                "databasePath points to a directory: {}",
                path.display()
            ));
        }

        return Ok(());
    }

    if !create_if_missing {
        return Err(format!(
            "database file does not exist: {}",
            path.display()
        ));
    }

    let Some(parent) = path.parent() else {
        return Err(format!(
            "databasePath has no parent directory: {}",
            path.display()
        ));
    };

    if !parent.exists() {
        return Err(format!(
            "database parent directory does not exist: {}",
            parent.display()
        ));
    }

    Ok(())
}

fn open_sqlite_connection(input: &SqlConnectionInput) -> Result<Connection, String> {
    let flags = if input.read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else if input.create_if_missing {
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    };

    let conn = Connection::open_with_flags(input.database_path.trim(), flags)
        .map_err(|err| format!("failed to open sqlite database: {err}"))?;

    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|err| format!("failed to set sqlite busy timeout: {err}"))?;

    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|err| format!("failed to enable sqlite foreign_keys: {err}"))?;

    Ok(conn)
}

fn default_connection_name(database_path: &str) -> String {
    if database_path == ":memory:" {
        return "In-memory SQLite".to_string();
    }

    Path::new(database_path)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("SQLite")
        .to_string()
}

fn normalize_limit(limit: Option<usize>) -> Result<usize, String> {
    let limit = limit.unwrap_or(DEFAULT_QUERY_ROW_LIMIT);

    if limit == 0 {
        return Err("limit must be greater than 0".to_string());
    }

    Ok(limit.min(MAX_QUERY_ROW_LIMIT))
}

fn sqlite_value_to_cell(value: ValueRef<'_>) -> SqlCellValue {
    match value {
        ValueRef::Null => SqlCellValue::null(),
        ValueRef::Integer(value) => SqlCellValue::integer(value),
        ValueRef::Real(value) => SqlCellValue::real(value),
        ValueRef::Text(value) => SqlCellValue::text(String::from_utf8_lossy(value).into_owned()),
        ValueRef::Blob(value) => {
            SqlCellValue::blob(general_purpose::STANDARD.encode(value), value.len())
        }
    }
}

fn collect_rows<T>(
    rows: impl IntoIterator<Item = rusqlite::Result<T>>,
    error_prefix: &str,
) -> Result<Vec<T>, String> {
    let mut items = Vec::new();

    for row in rows {
        items.push(row.map_err(|err| format!("{error_prefix}: {err}"))?);
    }

    Ok(items)
}

fn quote_sqlite_identifier(identifier: &str) -> Result<String, String> {
    let trimmed = identifier.trim();

    if trimmed.is_empty() {
        return Err("identifier must not be empty".to_string());
    }

    if trimmed.contains('\0') {
        return Err("identifier must not contain NUL bytes".to_string());
    }

    Ok(format!("\"{}\"", trimmed.replace('"', "\"\"")))
}

fn sql_may_mutate(sql: &str) -> bool {
    let Some(keyword) = first_sql_keyword(sql) else {
        return false;
    };

    matches!(
        keyword.as_str(),
        "alter"
            | "attach"
            | "begin"
            | "commit"
            | "create"
            | "delete"
            | "detach"
            | "drop"
            | "insert"
            | "pragma"
            | "replace"
            | "rollback"
            | "truncate"
            | "update"
            | "vacuum"
    )
}

fn first_sql_keyword(sql: &str) -> Option<String> {
    let bytes = sql.as_bytes();
    let mut index = 0;

    while index < bytes.len() {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }

        if index + 1 < bytes.len() && bytes[index] == b'-' && bytes[index + 1] == b'-' {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }

        if index + 1 < bytes.len() && bytes[index] == b'/' && bytes[index + 1] == b'*' {
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                index += 1;
            }

            if index + 1 < bytes.len() {
                index += 2;
            }

            continue;
        }

        break;
    }

    let start = index;

    while index < bytes.len() && (bytes[index].is_ascii_alphabetic() || bytes[index] == b'_') {
        index += 1;
    }

    if start == index {
        return None;
    }

    Some(sql[start..index].to_ascii_lowercase())
}

fn elapsed_ms(started_at: Instant) -> u64 {
    u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    struct TempDb {
        path: std::path::PathBuf,
    }

    impl TempDb {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "sql-studio-next-{name}-{}.db",
                Uuid::new_v4()
            ));

            Self { path }
        }

        fn input(&self, id: &str) -> SqlConnectionInput {
            SqlConnectionInput {
                id: Some(id.to_string()),
                name: Some(id.to_string()),
                kind: SqlConnectionKind::Sqlite,
                database_path: self.path.display().to_string(),
                read_only: false,
                create_if_missing: true,
            }
        }

        fn read_only_input(&self, id: &str) -> SqlConnectionInput {
            SqlConnectionInput {
                id: Some(id.to_string()),
                name: Some(id.to_string()),
                kind: SqlConnectionKind::Sqlite,
                database_path: self.path.display().to_string(),
                read_only: true,
                create_if_missing: false,
            }
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    #[test]
    fn test_connection_returns_ok_for_valid_sqlite_database() {
        let store = SqlConnectionStore::new();
        let db = TempDb::new("test-connection");

        let result = store.test_connection(db.input("local"));

        assert!(result.ok);
        assert_eq!(
            result.connection.as_ref().map(|connection| connection.id.as_str()),
            Some("local")
        );
        assert!(result.error.is_none());
    }

    #[test]
    fn test_connection_returns_error_when_file_is_missing() {
        let store = SqlConnectionStore::new();
        let db = TempDb::new("missing");

        let mut input = db.input("missing");
        input.create_if_missing = false;

        let result = store.test_connection(input);

        assert!(!result.ok);
        assert!(result.connection.is_none());
        assert!(result
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("does not exist"));
    }

    #[test]
    fn open_list_and_close_connection() {
        let store = SqlConnectionStore::new();
        let db = TempDb::new("open-list-close");

        let connection = store.open_connection(db.input("local")).unwrap();

        assert_eq!(connection.id, "local");
        assert_eq!(store.list_connections().unwrap().len(), 1);

        store.close_connection("local").unwrap();

        assert!(store.list_connections().unwrap().is_empty());
    }

    #[test]
    fn open_connection_rejects_duplicate_ids() {
        let store = SqlConnectionStore::new();
        let db = TempDb::new("duplicate-id");

        store.open_connection(db.input("local")).unwrap();

        let err = store.open_connection(db.input("local")).unwrap_err();

        assert!(err.contains("already exists"));
    }

    #[test]
    fn execute_query_returns_columns_and_rows() {
        let store = SqlConnectionStore::new();
        let db = TempDb::new("query");

        store.open_connection(db.input("local")).unwrap();

        let result = store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: "local".to_string(),
                sql: "SELECT 1 AS value, 'hello' AS label, NULL AS empty_value".to_string(),
                limit: Some(10),
            })
            .unwrap();

        assert_eq!(result.columns.len(), 3);
        assert_eq!(result.columns[0].name, "value");
        assert_eq!(result.row_count, 1);
        assert_eq!(result.rows[0][0], SqlCellValue::integer(1));
        assert_eq!(result.rows[0][1], SqlCellValue::text("hello"));
        assert_eq!(result.rows[0][2], SqlCellValue::null());
        assert!(!result.truncated);
        assert_eq!(result.affected_rows, None);
    }

    #[test]
    fn execute_query_reports_affected_rows_for_mutations() {
        let store = SqlConnectionStore::new();
        let db = TempDb::new("affected-rows");

        store.open_connection(db.input("local")).unwrap();

        let result = store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: "local".to_string(),
                sql: "CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL)".to_string(),
                limit: None,
            })
            .unwrap();

        assert!(result.columns.is_empty());
        assert!(result.rows.is_empty());
        assert_eq!(result.affected_rows, Some(0));

        let result = store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: "local".to_string(),
                sql: "INSERT INTO users(name) VALUES ('Alice')".to_string(),
                limit: None,
            })
            .unwrap();

        assert_eq!(result.affected_rows, Some(1));
    }

    #[test]
    fn execute_query_enforces_row_limit() {
        let store = SqlConnectionStore::new();
        let db = TempDb::new("limit");

        store.open_connection(db.input("local")).unwrap();

        let result = store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: "local".to_string(),
                sql: "SELECT 1 AS value UNION ALL SELECT 2 UNION ALL SELECT 3".to_string(),
                limit: Some(2),
            })
            .unwrap();

        assert_eq!(result.row_count, 2);
        assert!(result.truncated);
    }

    #[test]
    fn execute_query_returns_error_for_invalid_sql() {
        let store = SqlConnectionStore::new();
        let db = TempDb::new("invalid-sql");

        store.open_connection(db.input("local")).unwrap();

        let err = store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: "local".to_string(),
                sql: "SELECT FROM".to_string(),
                limit: None,
            })
            .unwrap_err();

        assert!(err.contains("failed to prepare sql"));
    }

    #[test]
    fn list_tables_and_columns_returns_sqlite_metadata() {
        let store = SqlConnectionStore::new();
        let db = TempDb::new("metadata");

        store.open_connection(db.input("local")).unwrap();

        store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: "local".to_string(),
                sql: "CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT 'unknown')"
                    .to_string(),
                limit: None,
            })
            .unwrap();

        let tables = store.list_tables("local").unwrap();

        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].name, "users");
        assert_eq!(tables[0].table_type, SqlTableType::Table);

        let columns = store
            .list_columns(SqlListColumnsRequest {
                connection_id: "local".to_string(),
                table_name: "users".to_string(),
                schema: None,
            })
            .unwrap();

        assert_eq!(columns.len(), 2);
        assert_eq!(columns[0].name, "id");
        assert_eq!(columns[0].data_type.as_deref(), Some("INTEGER"));
        assert!(columns[0].primary_key);

        assert_eq!(columns[1].name, "name");
        assert_eq!(columns[1].data_type.as_deref(), Some("TEXT"));
        assert!(columns[1].not_null);
        assert_eq!(columns[1].default_value.as_deref(), Some("'unknown'"));
    }

    #[test]
    fn read_only_connection_rejects_mutating_sql() {
        let store = SqlConnectionStore::new();
        let db = TempDb::new("read-only");

        store.open_connection(db.input("writer")).unwrap();

        store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: "writer".to_string(),
                sql: "CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL)".to_string(),
                limit: None,
            })
            .unwrap();

        store.close_connection("writer").unwrap();

        store.open_connection(db.read_only_input("reader")).unwrap();

        let result = store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: "reader".to_string(),
                sql: "SELECT COUNT(*) AS count FROM users".to_string(),
                limit: None,
            })
            .unwrap();

        assert_eq!(result.rows[0][0], SqlCellValue::integer(0));

        let err = store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: "reader".to_string(),
                sql: "INSERT INTO users(name) VALUES ('Alice')".to_string(),
                limit: None,
            })
            .unwrap_err();

        assert!(err.contains("read-only connection"));
    }

    #[test]
    fn blob_values_are_returned_as_base64_payloads() {
        let store = SqlConnectionStore::new();
        let db = TempDb::new("blob");

        store.open_connection(db.input("local")).unwrap();

        let result = store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: "local".to_string(),
                sql: "SELECT X'6869' AS payload".to_string(),
                limit: None,
            })
            .unwrap();

        assert_eq!(
            result.rows[0][0].value,
            Some(json!({
                "encoding": "base64",
                "data": "aGk=",
                "byteLength": 2
            }))
        );
    }

    #[test]
    fn cancel_unknown_connection_returns_error() {
        let store = SqlConnectionStore::new();

        let err = store
            .cancel_query(SqlCancelQueryRequest {
                connection_id: "missing".to_string(),
                query_id: Some("q1".to_string()),
            })
            .unwrap_err();

        assert!(err.contains("does not exist"));
    }

    #[test]
    fn first_sql_keyword_skips_comments() {
        assert_eq!(
            first_sql_keyword("-- comment\nSELECT 1").as_deref(),
            Some("select")
        );
        assert_eq!(
            first_sql_keyword("/* comment */\nWITH cte AS (SELECT 1) SELECT * FROM cte")
                .as_deref(),
            Some("with")
        );
    }

    #[test]
    fn sql_may_mutate_detects_mutating_statements() {
        assert!(!sql_may_mutate("SELECT 1"));
        assert!(!sql_may_mutate("-- comment\nWITH cte AS (SELECT 1) SELECT * FROM cte"));
        assert!(sql_may_mutate("INSERT INTO users VALUES (1)"));
        assert!(sql_may_mutate("/* comment */ DROP TABLE users"));
        assert!(sql_may_mutate("PRAGMA journal_mode = WAL"));
    }

    #[test]
    fn quote_identifier_escapes_double_quotes() {
        assert_eq!(quote_sqlite_identifier("users").unwrap(), "\"users\"");
        assert_eq!(
            quote_sqlite_identifier("weird\"name").unwrap(),
            "\"weird\"\"name\""
        );
    }
}
```

---

# 4. 新增 `src-tauri/src/commands/sql/connection.rs`

```rust
use super::state::SqlConnectionStore;
use super::types::{SqlConnection, SqlConnectionInput, SqlConnectionTestResult};
use std::sync::Arc;
use tauri::State;

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn sql_test_connection(
    state: State<'_, Arc<SqlConnectionStore>>,
    input: SqlConnectionInput,
) -> Result<SqlConnectionTestResult, String> {
    Ok(state.test_connection(input))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn sql_open_connection(
    state: State<'_, Arc<SqlConnectionStore>>,
    input: SqlConnectionInput,
) -> Result<SqlConnection, String> {
    state.open_connection(input)
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn sql_close_connection(
    state: State<'_, Arc<SqlConnectionStore>>,
    connection_id: String,
) -> Result<(), String> {
    state.close_connection(&connection_id)
}

#[tauri::command]
pub fn sql_list_connections(
    state: State<'_, Arc<SqlConnectionStore>>,
) -> Result<Vec<SqlConnection>, String> {
    state.list_connections()
}
```

---

# 5. 新增 `src-tauri/src/commands/sql/metadata.rs`

```rust
use super::state::SqlConnectionStore;
use super::types::{SqlColumn, SqlListColumnsRequest, SqlTable};
use std::sync::Arc;
use tauri::State;

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn sql_list_tables(
    state: State<'_, Arc<SqlConnectionStore>>,
    connection_id: String,
) -> Result<Vec<SqlTable>, String> {
    state.list_tables(&connection_id)
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn sql_list_columns(
    state: State<'_, Arc<SqlConnectionStore>>,
    request: SqlListColumnsRequest,
) -> Result<Vec<SqlColumn>, String> {
    state.list_columns(request)
}
```

---

# 6. 新增 `src-tauri/src/commands/sql/query.rs`

```rust
use super::state::SqlConnectionStore;
use super::types::{SqlCancelQueryRequest, SqlCancelQueryResult, SqlExecuteQueryRequest, SqlQueryResult};
use std::sync::Arc;
use tauri::State;

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn sql_execute_query(
    state: State<'_, Arc<SqlConnectionStore>>,
    request: SqlExecuteQueryRequest,
) -> Result<SqlQueryResult, String> {
    state.execute_query(request)
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn sql_cancel_query(
    state: State<'_, Arc<SqlConnectionStore>>,
    request: SqlCancelQueryRequest,
) -> Result<SqlCancelQueryResult, String> {
    state.cancel_query(request)
}
```

---

# 7. 修改 `src-tauri/src/commands/mod.rs`

增加模块声明：

```rust
pub mod sql;
```

建议放在 `settings` 后面或 `storage` 前后，例如：

```rust
pub mod settings;
pub mod sql;
pub mod sidex_terminal;
```

增加导出：

```rust
pub use sql::*;
```

建议放在：

```rust
pub use settings::*;
pub use sql::*;
pub use sidex_terminal::*;
```

完整局部结果：

```rust
pub mod settings;
pub mod sql;
pub mod sidex_terminal;
```

```rust
pub use settings::*;
pub use sql::*;
pub use sidex_terminal::*;
```

---

# 8. 修改 `src-tauri/src/lib.rs`

## 8.1 增加 import

当前 `lib.rs` 已经 import 了多个 Store，例如 `TerminalStore`、`UpdateManagerState`、`WatchStore`。

增加：

```rust
use commands::sql::SqlConnectionStore;
```

建议放在：

```rust
use commands::settings::SettingsStore;
use commands::sql::SqlConnectionStore;
use commands::storage::StorageDb;
```

---

## 8.2 注册 Store

当前 `.manage(...)` 已经集中注册状态。

在 `.manage(Arc::new(SettingsStore::new()))` 后面增加：

```rust
.manage(Arc::new(SqlConnectionStore::new()))
```

局部结果：

```rust
.manage(Arc::new(SettingsStore::new()))
.manage(Arc::new(SqlConnectionStore::new()))
.manage(Arc::new(sidex_extension_api::CommandRegistry::new()))
```

---

## 8.3 注册 Tauri commands

在 `tauri::generate_handler![]` 中增加 SQL command。建议放在 `storage_*` 后面、`db_state` 前面：

```rust
// SQL Studio database bridge
commands::sql_test_connection,
commands::sql_open_connection,
commands::sql_close_connection,
commands::sql_list_connections,
commands::sql_list_tables,
commands::sql_list_columns,
commands::sql_execute_query,
commands::sql_cancel_query,
```

局部结果：

```rust
commands::storage_get,
commands::storage_set,
commands::storage_delete,
commands::storage_list,
// SQL Studio database bridge
commands::sql_test_connection,
commands::sql_open_connection,
commands::sql_close_connection,
commands::sql_list_connections,
commands::sql_list_tables,
commands::sql_list_columns,
commands::sql_execute_query,
commands::sql_cancel_query,
// sidex-db state persistence
commands::db_get_recent_files,
commands::db_get_recent_workspaces,
```

---

# 9. Cargo.toml 是否需要改？

不需要。

当前 `src-tauri/Cargo.toml` 已经有：

```toml
rusqlite = { version = "0.31", features = ["bundled"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
base64 = "0.22"
uuid = { version = "1", features = ["v4"] }
```

这些足够支撑 Phase 2。

---

# 10. 前端临时调用示例

Phase 2 不做正式前端服务，但可以在 DevTools 临时验证：

```ts
import { invoke } from '@tauri-apps/api/core';

const input = {
	id: 'local',
	name: 'Local SQLite',
	kind: 'sqlite',
	databasePath: '/absolute/path/to/test.db',
	readOnly: false,
	createIfMissing: true
};

await invoke('sql_test_connection', { input });

await invoke('sql_open_connection', { input });

await invoke('sql_execute_query', {
	request: {
		connectionId: 'local',
		sql: 'CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL)',
		limit: 1000
	}
});

await invoke('sql_execute_query', {
	request: {
		connectionId: 'local',
		sql: "INSERT INTO users(name) VALUES ('Alice')",
		limit: 1000
	}
});

const result = await invoke('sql_execute_query', {
	request: {
		connectionId: 'local',
		sql: 'SELECT id, name FROM users LIMIT 10',
		limit: 1000
	}
});

console.log(result);
```

---

# 11. 单元测试覆盖范围

本方案的测试覆盖：

```txt
1. 有效 SQLite 连接测试
2. 缺失文件错误测试
3. open / list / close 生命周期
4. 重复 connection id 拒绝
5. SELECT 查询返回 columns + rows
6. DDL / DML 返回 affectedRows
7. 查询 limit 截断
8. invalid SQL 错误
9. tables / columns metadata
10. readOnly connection 拒绝写入 SQL
11. blob base64 序列化
12. cancel unknown connection 错误
13. SQL keyword 解析
14. SQLite identifier quote
```

运行：

```bash
cd src-tauri
cargo test sql
```

或者从仓库根目录：

```bash
pnpm run test:rust
pnpm run rust:check
pnpm run rust:clippy
```

---

# 12. Phase 2 验收标准

完成后必须满足：

```txt
cargo test sql 通过
pnpm run rust:check 通过
pnpm run rust:clippy 通过
pnpm tauri dev 可启动
DevTools invoke('sql_execute_query', ...) 能返回 rows
```

最小闭环：

```txt
sql_open_connection
  -> sql_execute_query("SELECT 1 AS value")
    -> 返回：
       columns: [{ name: "value", ordinal: 0 }]
       rows: [[{ kind: "integer", value: 1 }]]
       rowCount: 1
```

---

# 13. 下一阶段衔接

Phase 2 完成后，Phase 3 不要继续堆 Rust command，而是做前端服务层：

```txt
src/vs/workbench/services/sql/common/sqlTypes.ts
src/vs/workbench/services/sql/common/sqlConnection.ts
src/vs/workbench/services/sql/common/sqlQuery.ts
src/vs/workbench/services/sql/browser/sqlConnectionService.ts
src/vs/workbench/services/sql/browser/sqlQueryService.ts
```

Phase 3 的目标是把这些 command 包成：

```ts
ISqlConnectionService;
ISqlMetadataService;
ISqlQueryService;
```

这样后面的 SQL Connections View、SQL Editor、Result Panel 都只依赖 Workbench service，不直接到处 `invoke()`。
