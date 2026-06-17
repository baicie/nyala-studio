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

    #[allow(clippy::unused_self, clippy::needless_pass_by_value)]
    pub fn test_connection(&self, input: SqlConnectionInput) -> SqlConnectionTestResult {
        match normalize_connection_input(&input)
            .and_then(|connection| open_sqlite_connection(&input).map(|conn| (connection, conn)))
        {
            Ok((connection, conn)) => match conn.query_row("SELECT 1", [], |_| Ok(())) {
                Ok(()) => SqlConnectionTestResult::ok(connection),
                Err(err) => {
                    SqlConnectionTestResult::error(format!("failed to validate connection: {err}"))
                }
            },
            Err(err) => SqlConnectionTestResult::error(err),
        }
    }

    #[allow(clippy::needless_pass_by_value)]
    pub fn open_connection(&self, input: SqlConnectionInput) -> Result<SqlConnection, String> {
        let connection = normalize_connection_input(&input)?;

        {
            let connections = self.connections()?;
            if connections.contains_key(&connection.id) {
                return Err(format!("connection id '{}' already exists", connection.id));
            }
        }

        let conn = open_sqlite_connection(&input)?;
        let interrupt = conn.get_interrupt_handle();

        let handle = Arc::new(SqlConnectionHandle {
            info: connection.clone(),
            conn: Mutex::new(conn),
            interrupt,
        });

        let mut connections = self.connections()?;
        if connections.contains_key(&connection.id) {
            return Err(format!("connection id '{}' already exists", connection.id));
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

    #[allow(clippy::needless_pass_by_value)]
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

    #[allow(clippy::needless_pass_by_value)]
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
            return Err(
                "read-only connection only allows SELECT/WITH/EXPLAIN style statements".to_string(),
            );
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
        .map_or_else(|| format!("sqlite-{}", Uuid::new_v4()), ToOwned::to_owned);

    let name = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map_or_else(|| default_connection_name(database_path), ToOwned::to_owned);

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
        return Err(format!("database file does not exist: {}", path.display()));
    }

    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));

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
    use std::fs;

    struct TempDb {
        path: std::path::PathBuf,
    }

    impl TempDb {
        fn new(name: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("sql-studio-next-{name}-{}.db", Uuid::new_v4()));

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
            result
                .connection
                .as_ref()
                .map(|connection| connection.id.as_str()),
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
            Some(serde_json::json!({
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
            first_sql_keyword("/* comment */\nWITH cte AS (SELECT 1) SELECT * FROM cte").as_deref(),
            Some("with")
        );
    }

    #[test]
    fn sql_may_mutate_detects_mutating_statements() {
        assert!(!sql_may_mutate("SELECT 1"));
        assert!(!sql_may_mutate(
            "-- comment\nWITH cte AS (SELECT 1) SELECT * FROM cte"
        ));
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

    #[test]
    fn validate_sqlite_path_allows_relative_file_in_current_dir() {
        assert!(validate_sqlite_path("relative-phase2-test.db", true).is_ok());
    }

    #[test]
    fn open_connection_rejects_duplicate_id_before_reopening_database() {
        let store = SqlConnectionStore::new();
        let db = TempDb::new("duplicate-id-before-open");

        store.open_connection(db.input("local")).unwrap();

        let err = store.open_connection(db.input("local")).unwrap_err();

        assert!(err.contains("already exists"));
        assert_eq!(store.list_connections().unwrap().len(), 1);
    }
}
