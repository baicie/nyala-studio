use super::demo_seed::DEMO_PROFILE_ID;
use super::driver::{is_persistable_connection, normalize_connection_input};
use super::mysql_runtime::{
    execute_mysql_query, list_mysql_columns, list_mysql_databases, list_mysql_tables,
    open_mysql_pool, test_mysql_connection,
};
use super::persistence::{load_saved_connections, save_saved_connections};
use super::sql_analysis::{analyze_sql, StatementRisk};
use super::types::{
    SqlCancelQueryRequest, SqlCancelQueryResult, SqlCellValue, SqlColumn, SqlCommandError,
    SqlConnection, SqlConnectionInput, SqlConnectionKind, SqlConnectionTestResult, SqlDatabase,
    SqlExecuteQueryRequest, SqlListColumnsRequest, SqlQueryResult, SqlRemoveSavedConnectionRequest,
    SqlRestoreSavedConnectionError, SqlRestoreSavedConnectionsResult, SqlResultColumn,
    SqlSaveConnectionRequest, SqlSavedConnection, SqlTable, SqlTableType, DEFAULT_QUERY_ROW_LIMIT,
    MAX_QUERY_ROW_LIMIT, MAX_SQL_BYTES,
};
use super::SqlDialect;
use base64::{engine::general_purpose, Engine as _};
use mysql::Pool;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, InterruptHandle, OpenFlags};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, MutexGuard,
};
use std::time::Instant;

type ConnectionMap = HashMap<String, Arc<SqlConnectionHandle>>;
type SavedConnectionMap = HashMap<String, SqlSavedConnection>;

#[cfg(test)]
struct PersistenceFlushPause {
    reached: std::sync::mpsc::SyncSender<()>,
    resume: std::sync::mpsc::Receiver<()>,
}

enum SqlRuntimeConnection {
    Sqlite {
        conn: Box<Mutex<Connection>>,
        interrupt: InterruptHandle,
        active_query_owner: Mutex<Option<ActiveAgentQueryOwner>>,
    },
    MySql {
        pool: Pool,
    },
}

struct SqlConnectionHandle {
    info: SqlConnection,
    runtime: SqlRuntimeConnection,
    retired: AtomicBool,
}

impl SqlConnectionHandle {
    fn ensure_active(&self) -> Result<(), String> {
        if self.retired.load(Ordering::Acquire) {
            return Err(format!("connection '{}' is closed", self.info.id));
        }
        Ok(())
    }

    fn retire(&self) {
        self.retired.store(true, Ordering::Release);
        if let SqlRuntimeConnection::Sqlite {
            conn, interrupt, ..
        } = &self.runtime
        {
            loop {
                interrupt.interrupt();

                match conn.try_lock() {
                    Ok(guard) => {
                        drop(guard);
                        break;
                    }
                    Err(std::sync::TryLockError::WouldBlock) => {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                    Err(std::sync::TryLockError::Poisoned(error)) => {
                        drop(error.into_inner());
                        break;
                    }
                }
            }
        }
    }
}

pub struct SqlConnectionStore {
    lifecycle: Mutex<()>,
    connections: Mutex<ConnectionMap>,
    saved_connections: Mutex<SavedConnectionMap>,
    persistence_path: Mutex<Option<PathBuf>>,
    #[cfg(test)]
    lifecycle_attempts: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    persistence_flush_pause: Mutex<Option<PersistenceFlushPause>>,
}

impl SqlConnectionStore {
    pub fn new() -> Self {
        Self {
            lifecycle: Mutex::new(()),
            connections: Mutex::new(HashMap::new()),
            saved_connections: Mutex::new(HashMap::new()),
            persistence_path: Mutex::new(None),
            #[cfg(test)]
            lifecycle_attempts: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            persistence_flush_pause: Mutex::new(None),
        }
    }

    pub fn initialize_persistence(&self, path: PathBuf) -> Result<(), String> {
        let _lifecycle = self.lifecycle()?;

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| {
                format!(
                    "failed to create SQL connection persistence directory {}: {err}",
                    parent.display()
                )
            })?;
        }

        let saved = load_saved_connections(&path)?;
        let mut saved_map = self.saved_connections()?;
        saved_map.clear();

        for connection in saved {
            saved_map.insert(connection.id.clone(), connection);
        }

        *self.persistence_path()? = Some(path);

        Ok(())
    }

    #[allow(clippy::unused_self, clippy::needless_pass_by_value)]
    pub fn test_connection(&self, mut input: SqlConnectionInput) -> SqlConnectionTestResult {
        enforce_builtin_runtime_policy(&mut input);
        match normalize_connection_input(&input) {
            Ok(connection) => {
                let result = match connection.kind {
                    SqlConnectionKind::Sqlite => open_sqlite_connection(&input).and_then(|conn| {
                        conn.query_row("SELECT 1", [], |_| Ok(()))
                            .map_err(|err| err.to_string())
                    }),
                    SqlConnectionKind::MySql => {
                        open_mysql_pool(&input).and_then(|pool| test_mysql_connection(&pool))
                    }
                    SqlConnectionKind::PostgreSql => {
                        Err("SQL driver 'PostgreSQL' is not enabled yet".to_string())
                    }
                };

                match result {
                    Ok(()) => SqlConnectionTestResult::ok(connection),
                    Err(error) => SqlConnectionTestResult::error(SqlCommandError::new(
                        "connection_failed",
                        error,
                    )),
                }
            }
            Err(error) => {
                SqlConnectionTestResult::error(SqlCommandError::new("invalid_input", error))
            }
        }
    }

    #[allow(clippy::needless_pass_by_value)]
    pub fn open_connection(&self, mut input: SqlConnectionInput) -> Result<SqlConnection, String> {
        enforce_builtin_runtime_policy(&mut input);
        let _lifecycle = self.lifecycle()?;
        self.open_connection_inner(&input)
    }

    fn open_connection_inner(&self, input: &SqlConnectionInput) -> Result<SqlConnection, String> {
        let connection = normalize_connection_input(input)?;

        {
            let connections = self.connections()?;
            if connections.contains_key(&connection.id) {
                return Err(format!("connection id '{}' already exists", connection.id));
            }
        }

        let runtime = match connection.kind {
            SqlConnectionKind::Sqlite => {
                let conn = open_sqlite_connection(input)?;
                let interrupt = conn.get_interrupt_handle();

                SqlRuntimeConnection::Sqlite {
                    conn: Box::new(Mutex::new(conn)),
                    interrupt,
                    active_query_owner: Mutex::new(None),
                }
            }
            SqlConnectionKind::MySql => {
                let pool = open_mysql_pool(input)?;
                test_mysql_connection(&pool)?;

                SqlRuntimeConnection::MySql { pool }
            }
            SqlConnectionKind::PostgreSql => {
                return Err("SQL driver 'PostgreSQL' is not enabled yet".to_string());
            }
        };

        let handle = Arc::new(SqlConnectionHandle {
            info: connection.clone(),
            runtime,
            retired: AtomicBool::new(false),
        });

        let mut connections = self.connections()?;
        if connections.contains_key(&connection.id) {
            return Err(format!("connection id '{}' already exists", connection.id));
        }

        connections.insert(connection.id.clone(), handle);

        Ok(connection)
    }

    /// Replaces an open runtime connection with the same id. If opening the
    /// replacement fails, the previous runtime handle is restored.
    pub fn replace_connection(
        &self,
        mut input: SqlConnectionInput,
    ) -> Result<SqlConnection, String> {
        enforce_builtin_runtime_policy(&mut input);
        let _lifecycle = self.lifecycle()?;
        let connection = normalize_connection_input(&input)?;
        let previous = self.connections()?.remove(&connection.id);

        match self.open_connection_inner(&input) {
            Ok(connection) => {
                if let Some(previous) = previous {
                    previous.retire();
                }
                Ok(connection)
            }
            Err(error) => {
                if let Some(previous) = previous {
                    self.connections()?.insert(connection.id, previous);
                }
                Err(error)
            }
        }
    }

    pub fn close_connection(&self, connection_id: &str) -> Result<(), String> {
        let _lifecycle = self.lifecycle()?;
        self.close_connection_inner(connection_id)
    }

    fn close_connection_inner(&self, connection_id: &str) -> Result<(), String> {
        let mut connections = self.connections()?;
        let handle = connections
            .remove(connection_id)
            .ok_or_else(|| format!("connection '{connection_id}' does not exist"))?;
        drop(connections);

        handle.retire();

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

    pub(crate) fn open_connection_info(
        &self,
        connection_id: &str,
    ) -> Result<SqlConnection, SqlCommandError> {
        let connection_id = connection_id.trim();
        if connection_id.is_empty() {
            return Err(SqlCommandError::new(
                "invalid_input",
                "connection id must not be empty",
            ));
        }

        let connections = self
            .connections()
            .map_err(|message| SqlCommandError::new("internal", message))?;

        connections
            .get(connection_id)
            .map(|handle| handle.info.clone())
            .ok_or_else(|| {
                SqlCommandError::new(
                    "not_open",
                    format!("connection '{connection_id}' is not open"),
                )
            })
    }

    pub fn list_databases(&self, connection_id: &str) -> Result<Vec<SqlDatabase>, String> {
        let handle = self.connection(connection_id)?;
        handle.ensure_active()?;

        match &handle.runtime {
            SqlRuntimeConnection::Sqlite { .. } => Ok(vec![SqlDatabase {
                name: "main".to_string(),
            }]),
            SqlRuntimeConnection::MySql { pool } => list_mysql_databases(pool),
        }
    }

    #[allow(clippy::needless_pass_by_value)]
    pub fn save_connection(
        &self,
        mut request: SqlSaveConnectionRequest,
    ) -> Result<SqlSavedConnection, String> {
        enforce_builtin_runtime_policy(&mut request.input);
        let _lifecycle = self.lifecycle()?;
        let connection = normalize_connection_input(&request.input)?;

        if !is_persistable_connection(&connection) {
            return Err("in-memory SQLite connections cannot be saved".to_string());
        }

        let saved = SqlSavedConnection {
            id: connection.id.clone(),
            name: connection.name.clone(),
            kind: connection.kind,
            database_path: connection.database_path.clone(),
            host: connection.host.clone(),
            port: connection.port,
            database: connection.database.clone(),
            username: connection.username.clone(),
            ssl_mode: connection.ssl_mode,
            read_only: connection.read_only,
            create_if_missing: request.input.create_if_missing,
            auto_connect: request.auto_connect,
        };

        let was_open = {
            let connections = self.connections()?;
            connections.contains_key(&saved.id)
        };

        if request.open_now && !was_open {
            self.open_connection_inner(&saved.to_input())?;
        }

        let previous = {
            let mut saved_connections = self.saved_connections()?;
            saved_connections.insert(saved.id.clone(), saved.clone())
        };

        if let Err(error) = self.flush_saved_connections() {
            {
                let mut saved_connections = self.saved_connections()?;
                match previous {
                    Some(previous) => {
                        saved_connections.insert(previous.id.clone(), previous);
                    }
                    None => {
                        saved_connections.remove(&saved.id);
                    }
                }
            }

            if request.open_now && !was_open {
                let _ = self.close_connection_inner(&saved.id);
            }

            return Err(error);
        }

        Ok(saved)
    }

    /// Opens or replaces a runtime connection and optionally persists its public
    /// profile. The runtime input may contain a transient password; the saved
    /// profile never does. When `persist` is false, an existing profile with the
    /// same id is removed atomically with the runtime replacement.
    pub fn save_and_open_connection(
        &self,
        mut input: SqlConnectionInput,
        auto_connect: bool,
        persist: bool,
    ) -> Result<SqlConnection, String> {
        enforce_builtin_runtime_policy(&mut input);
        let _lifecycle = self.lifecycle()?;
        self.save_and_open_connection_inner(&input, auto_connect, persist)
    }

    fn save_and_open_connection_inner(
        &self,
        input: &SqlConnectionInput,
        auto_connect: bool,
        persist: bool,
    ) -> Result<SqlConnection, String> {
        let connection = normalize_connection_input(input)?;

        if persist && !is_persistable_connection(&connection) {
            return Err("in-memory SQLite connections cannot be saved".to_string());
        }

        let saved = persist.then(|| SqlSavedConnection {
            id: connection.id.clone(),
            name: connection.name.clone(),
            kind: connection.kind,
            database_path: connection.database_path.clone(),
            host: connection.host.clone(),
            port: connection.port,
            database: connection.database.clone(),
            username: connection.username.clone(),
            ssl_mode: connection.ssl_mode,
            read_only: connection.read_only,
            create_if_missing: input.create_if_missing,
            auto_connect,
        });

        let previous_runtime = self.connections()?.remove(&connection.id);
        let opened = match self.open_connection_inner(input) {
            Ok(connection) => connection,
            Err(error) => {
                if let Some(previous_runtime) = previous_runtime {
                    self.connections()?
                        .insert(connection.id.clone(), previous_runtime);
                }
                return Err(error);
            }
        };

        let previous_saved = {
            let mut saved_connections = self.saved_connections()?;
            match saved {
                Some(saved) => saved_connections.insert(saved.id.clone(), saved),
                None => saved_connections.remove(&opened.id),
            }
        };

        let persistence_changed = persist || previous_saved.is_some();
        if persistence_changed {
            if let Err(error) = self.flush_saved_connections() {
                let _ = self.close_connection_inner(&opened.id);
                if let Some(previous_runtime) = previous_runtime {
                    self.connections()?
                        .insert(opened.id.clone(), previous_runtime);
                }

                let mut saved_connections = self.saved_connections()?;
                if let Some(previous_saved) = previous_saved {
                    saved_connections.insert(opened.id.clone(), previous_saved);
                } else if persist {
                    saved_connections.remove(&opened.id);
                }

                return Err(error);
            }
        }

        if let Some(previous_runtime) = previous_runtime {
            previous_runtime.retire();
        }

        Ok(opened)
    }

    #[cfg(test)]
    pub(crate) fn save_and_open_connection_without_builtin_policy(
        &self,
        input: &SqlConnectionInput,
        auto_connect: bool,
        persist: bool,
    ) -> Result<SqlConnection, String> {
        let _lifecycle = self.lifecycle()?;
        self.save_and_open_connection_inner(input, auto_connect, persist)
    }

    pub fn list_saved_connections(&self) -> Result<Vec<SqlSavedConnection>, String> {
        let mut saved = self
            .saved_connections()?
            .values()
            .cloned()
            .collect::<Vec<_>>();

        saved.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));

        Ok(saved)
    }

    #[allow(clippy::needless_pass_by_value)]
    pub fn remove_saved_connection(
        &self,
        request: SqlRemoveSavedConnectionRequest,
    ) -> Result<(), String> {
        let _lifecycle = self.lifecycle()?;
        let connection_id = request.connection_id.trim();

        if connection_id.is_empty() {
            return Err("connectionId must not be empty".to_string());
        }

        let removed = {
            let mut saved_connections = self.saved_connections()?;
            saved_connections.remove(connection_id)
        };

        let Some(removed) = removed else {
            return Err(format!("saved connection '{connection_id}' does not exist"));
        };

        if let Err(error) = self.flush_saved_connections() {
            let mut saved_connections = self.saved_connections()?;
            saved_connections.insert(removed.id.clone(), removed);
            return Err(error);
        }

        if request.close_if_open {
            let is_open = {
                let connections = self.connections()?;
                connections.contains_key(connection_id)
            };

            if is_open {
                self.close_connection_inner(connection_id)?;
            }
        }

        Ok(())
    }

    pub fn restore_saved_connections(&self) -> Result<SqlRestoreSavedConnectionsResult, String> {
        let _lifecycle = self.lifecycle()?;
        let saved_connections = self.list_saved_connections()?;

        let mut opened = Vec::new();
        let mut errors = Vec::new();

        for saved in saved_connections
            .into_iter()
            .filter(|connection| connection.auto_connect)
        {
            let already_open = {
                let connections = self.connections()?;
                connections.contains_key(&saved.id)
            };

            if already_open {
                if let Ok(connection) = self.connection(&saved.id) {
                    opened.push(connection.info.clone());
                }
                continue;
            }

            let mut input = saved.to_input();
            enforce_builtin_runtime_policy(&mut input);
            match self.open_connection_inner(&input) {
                Ok(connection) => opened.push(connection),
                Err(error) => errors.push(SqlRestoreSavedConnectionError {
                    connection_id: saved.id,
                    name: saved.name,
                    error,
                }),
            }
        }

        Ok(SqlRestoreSavedConnectionsResult { opened, errors })
    }

    fn flush_saved_connections(&self) -> Result<(), String> {
        #[cfg(test)]
        self.wait_at_persistence_flush_pause_for_test();

        let path = self
            .persistence_path()?
            .clone()
            .ok_or_else(|| "SQL connection persistence has not been initialized".to_string())?;

        let saved = self.list_saved_connections()?;
        save_saved_connections(&path, &saved)
    }

    pub fn list_tables(&self, connection_id: &str) -> Result<Vec<SqlTable>, String> {
        let handle = self.connection(connection_id)?;

        match &handle.runtime {
            SqlRuntimeConnection::Sqlite { conn, .. } => {
                let conn = conn.lock().map_err(|err| err.to_string())?;
                handle.ensure_active()?;

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
            SqlRuntimeConnection::MySql { pool } => {
                list_mysql_tables(pool, handle.info.database.as_deref())
            }
        }
    }

    #[allow(clippy::needless_pass_by_value)]
    pub fn list_columns(&self, request: SqlListColumnsRequest) -> Result<Vec<SqlColumn>, String> {
        let handle = self.connection(&request.connection_id)?;

        match &handle.runtime {
            SqlRuntimeConnection::Sqlite { conn, .. } => {
                let conn = conn.lock().map_err(|err| err.to_string())?;
                handle.ensure_active()?;

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
            SqlRuntimeConnection::MySql { pool } => list_mysql_columns(
                pool,
                request
                    .schema
                    .as_deref()
                    .or(handle.info.database.as_deref()),
                &request.table_name,
            ),
        }
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

        if handle.info.read_only && sql_may_mutate_for_kind(sql, handle.info.kind) {
            return Err(
                "read-only connection only allows explicitly read-only statements".to_string(),
            );
        }

        match &handle.runtime {
            SqlRuntimeConnection::Sqlite { conn, .. } => {
                Self::execute_sqlite_query(handle.as_ref(), conn, sql, limit)
            }
            SqlRuntimeConnection::MySql { pool } => {
                handle.ensure_active()?;
                execute_mysql_query(pool, sql, limit)
            }
        }
    }

    pub(crate) fn execute_agent_query<F>(
        &self,
        request: &SqlExecuteQueryRequest,
        run_id: &str,
        call_id: &str,
        mut cancellation_requested: F,
    ) -> Result<SqlQueryResult, String>
    where
        F: FnMut() -> bool + Send + std::panic::RefUnwindSafe + 'static,
    {
        let sql = request.sql.trim();
        if sql.is_empty() {
            return Err("sql must not be empty".to_string());
        }
        if sql.len() > MAX_SQL_BYTES {
            return Err(format!(
                "sql length exceeds maximum of {MAX_SQL_BYTES} bytes"
            ));
        }
        let owner = ActiveAgentQueryOwner::new(run_id, call_id)?;
        let limit = normalize_limit(request.limit)?;
        let handle = self.connection(&request.connection_id)?;
        if !handle.info.read_only || sql_may_mutate_for_kind(sql, handle.info.kind) {
            return Err(
                "read-only connection only allows explicitly read-only statements".to_string(),
            );
        }

        match &handle.runtime {
            SqlRuntimeConnection::Sqlite {
                conn,
                active_query_owner,
                ..
            } => {
                let conn = conn.lock().map_err(|err| err.to_string())?;
                handle.ensure_active()?;
                let _owner = ActiveQueryOwnerGuard::register(active_query_owner, owner)?;
                if cancellation_requested() {
                    return Err("agent query was cancelled before execution".to_string());
                }
                let _progress = SqliteProgressHandlerGuard::new(&conn, cancellation_requested);
                Self::execute_sqlite_query_locked(&conn, sql, limit)
            }
            SqlRuntimeConnection::MySql { .. } => {
                Err("Agent read-only tools support SQLite only".to_string())
            }
        }
    }

    pub(crate) fn cancel_agent_queries_for_run(&self, run_id: &str) -> Result<usize, String> {
        let run_id = run_id.trim();
        if run_id.is_empty() || run_id.contains('\0') {
            return Err("agent run id must not be blank or contain NUL".to_string());
        }
        let handles = self.connections()?.values().cloned().collect::<Vec<_>>();
        let mut interrupted = 0;
        for handle in handles {
            let SqlRuntimeConnection::Sqlite {
                interrupt,
                active_query_owner,
                ..
            } = &handle.runtime
            else {
                continue;
            };
            let active = active_query_owner.lock().map_err(|err| err.to_string())?;
            if active.as_ref().map(|owner| owner.run_id.as_str()) == Some(run_id) {
                interrupt.interrupt();
                interrupted += 1;
            }
        }
        Ok(interrupted)
    }

    #[cfg(test)]
    fn active_agent_query_owner(
        &self,
        connection_id: &str,
    ) -> Result<Option<ActiveAgentQueryOwner>, String> {
        let handle = self.connection(connection_id)?;
        match &handle.runtime {
            SqlRuntimeConnection::Sqlite {
                active_query_owner, ..
            } => active_query_owner
                .lock()
                .map(|owner| owner.clone())
                .map_err(|err| err.to_string()),
            SqlRuntimeConnection::MySql { .. } => Ok(None),
        }
    }

    #[cfg(test)]
    pub(crate) fn install_sqlite_progress_handler_for_test<F>(
        &self,
        connection_id: &str,
        handler: F,
    ) -> Result<(), String>
    where
        F: FnMut() -> bool + Send + std::panic::RefUnwindSafe + 'static,
    {
        let handle = self.connection(connection_id)?;
        let SqlRuntimeConnection::Sqlite { conn, .. } = &handle.runtime else {
            return Err("test progress handlers support SQLite only".to_string());
        };
        let conn = conn.lock().map_err(|err| err.to_string())?;
        handle.ensure_active()?;
        conn.progress_handler(1_000, Some(handler));
        Ok(())
    }

    fn execute_sqlite_query(
        handle: &SqlConnectionHandle,
        conn: &Mutex<Connection>,
        sql: &str,
        limit: usize,
    ) -> Result<SqlQueryResult, String> {
        let conn = conn.lock().map_err(|err| err.to_string())?;
        handle.ensure_active()?;
        Self::execute_sqlite_query_locked(&conn, sql, limit)
    }

    fn execute_sqlite_query_locked(
        conn: &Connection,
        sql: &str,
        limit: usize,
    ) -> Result<SqlQueryResult, String> {
        let started_at = Instant::now();

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

        match &handle.runtime {
            SqlRuntimeConnection::Sqlite { interrupt, .. } => {
                interrupt.interrupt();

                Ok(SqlCancelQueryResult {
                    cancelled: true,
                    connection_id: request.connection_id,
                    query_id: request.query_id,
                    message: "interrupt signal sent to SQLite connection".to_string(),
                })
            }
            SqlRuntimeConnection::MySql { .. } => Ok(SqlCancelQueryResult {
                cancelled: false,
                connection_id: request.connection_id,
                query_id: request.query_id,
                message: "MySQL query cancellation is not supported in Phase 9.2".to_string(),
            }),
        }
    }

    fn connections(&self) -> Result<MutexGuard<'_, ConnectionMap>, String> {
        self.connections.lock().map_err(|err| err.to_string())
    }

    fn lifecycle(&self) -> Result<MutexGuard<'_, ()>, String> {
        #[cfg(test)]
        self.lifecycle_attempts.fetch_add(1, Ordering::AcqRel);

        self.lifecycle.lock().map_err(|err| err.to_string())
    }

    fn saved_connections(&self) -> Result<MutexGuard<'_, SavedConnectionMap>, String> {
        self.saved_connections.lock().map_err(|err| err.to_string())
    }

    fn persistence_path(&self) -> Result<MutexGuard<'_, Option<PathBuf>>, String> {
        self.persistence_path.lock().map_err(|err| err.to_string())
    }

    fn connection(&self, connection_id: &str) -> Result<Arc<SqlConnectionHandle>, String> {
        self.connections()?
            .get(connection_id)
            .cloned()
            .ok_or_else(|| format!("connection '{connection_id}' does not exist"))
    }

    #[cfg(test)]
    fn pause_next_persistence_flush_for_test(
        &self,
    ) -> (
        std::sync::mpsc::Receiver<()>,
        std::sync::mpsc::SyncSender<()>,
    ) {
        let (reached_tx, reached_rx) = std::sync::mpsc::sync_channel(1);
        let (resume_tx, resume_rx) = std::sync::mpsc::sync_channel(0);
        let mut pause = self.persistence_flush_pause.lock().unwrap();
        assert!(pause.is_none(), "persistence flush pause already installed");
        *pause = Some(PersistenceFlushPause {
            reached: reached_tx,
            resume: resume_rx,
        });
        (reached_rx, resume_tx)
    }

    #[cfg(test)]
    fn wait_at_persistence_flush_pause_for_test(&self) {
        let pause = self.persistence_flush_pause.lock().unwrap().take();
        if let Some(pause) = pause {
            pause
                .reached
                .send(())
                .expect("report persistence flush pause");
            pause.resume.recv().expect("resume persistence flush");
        }
    }

    #[cfg(test)]
    fn lifecycle_attempts_for_test(&self) -> usize {
        self.lifecycle_attempts.load(Ordering::Acquire)
    }
}

fn enforce_builtin_runtime_policy(input: &mut SqlConnectionInput) {
    if input
        .id
        .as_deref()
        .is_some_and(|id| id.trim() == DEMO_PROFILE_ID)
    {
        input.read_only = true;
        input.create_if_missing = false;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ActiveAgentQueryOwner {
    run_id: String,
    call_id: String,
}

impl ActiveAgentQueryOwner {
    fn new(run_id: &str, call_id: &str) -> Result<Self, String> {
        fn validated(value: &str, label: &str) -> Result<String, String> {
            let value = value.trim();
            if value.is_empty() || value.contains('\0') {
                return Err(format!("{label} must not be blank or contain NUL"));
            }
            Ok(value.to_string())
        }

        Ok(Self {
            run_id: validated(run_id, "agent query run id")?,
            call_id: validated(call_id, "agent query call id")?,
        })
    }
}

struct ActiveQueryOwnerGuard<'a> {
    owner: &'a Mutex<Option<ActiveAgentQueryOwner>>,
}

impl<'a> ActiveQueryOwnerGuard<'a> {
    fn register(
        owner: &'a Mutex<Option<ActiveAgentQueryOwner>>,
        value: ActiveAgentQueryOwner,
    ) -> Result<Self, String> {
        let mut active = owner.lock().map_err(|err| err.to_string())?;
        if active.is_some() {
            return Err("SQLite connection already has an active owned query".to_string());
        }
        *active = Some(value);
        drop(active);
        Ok(Self { owner })
    }
}

struct SqliteProgressHandlerGuard<'a> {
    conn: &'a Connection,
}

impl<'a> SqliteProgressHandlerGuard<'a> {
    fn new<F>(conn: &'a Connection, handler: F) -> Self
    where
        F: FnMut() -> bool + Send + std::panic::RefUnwindSafe + 'static,
    {
        conn.progress_handler(1_000, Some(handler));
        Self { conn }
    }
}

impl Drop for SqliteProgressHandlerGuard<'_> {
    fn drop(&mut self) {
        self.conn.progress_handler(0, None::<fn() -> bool>);
    }
}

impl Drop for ActiveQueryOwnerGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.owner.lock() {
            *active = None;
        }
    }
}

impl Default for SqlConnectionStore {
    fn default() -> Self {
        Self::new()
    }
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
    if input.kind != SqlConnectionKind::Sqlite {
        return Err("only SQLite runtime driver is enabled".to_string());
    }

    let database_path = input.database_path.as_deref().unwrap_or("").trim();

    if database_path.is_empty() {
        return Err("databasePath must not be empty".to_string());
    }

    if database_path == ":memory:" {
        let conn = Connection::open_in_memory()
            .map_err(|err| format!("failed to open in-memory SQLite database: {err}"))?;

        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|err| format!("failed to set sqlite busy timeout: {err}"))?;

        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|err| format!("failed to enable sqlite foreign_keys: {err}"))?;

        if input.read_only {
            conn.pragma_update(None, "query_only", 1)
                .map_err(|err| format!("failed to enable sqlite query_only mode: {err}"))?;
        }

        return Ok(conn);
    }

    validate_sqlite_path(database_path, input.create_if_missing)?;

    let flags = if input.read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else if input.create_if_missing {
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    };

    let path = Path::new(database_path);

    let conn = Connection::open_with_flags(path, flags)
        .map_err(|err| format!("failed to open sqlite database: {err}"))?;

    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|err| format!("failed to set sqlite busy timeout: {err}"))?;

    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|err| format!("failed to enable sqlite foreign_keys: {err}"))?;

    Ok(conn)
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

fn sql_may_mutate_for_kind(sql: &str, kind: SqlConnectionKind) -> bool {
    !matches!(
        analyze_sql(sql, SqlDialect::from_connection_kind(kind)).risk,
        StatementRisk::Metadata | StatementRisk::ReadOnly | StatementRisk::ExplainReadOnly
    )
}

#[cfg(test)]
fn sql_may_mutate(sql: &str) -> bool {
    sql_may_mutate_for_kind(sql, SqlConnectionKind::Sqlite)
}

fn elapsed_ms(started_at: Instant) -> u64 {
    u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};
    use uuid::Uuid;

    const LONG_RECURSIVE_QUERY: &str = "WITH RECURSIVE counter(value) AS (VALUES(0) UNION ALL SELECT value + 1 FROM counter WHERE value < 1000000000) SELECT sum(value) FROM counter";

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
                database_path: Some(self.path.display().to_string()),
                host: None,
                port: None,
                database: None,
                username: None,
                password: None,
                ssl_mode: None,
                read_only: false,
                create_if_missing: true,
            }
        }

        fn read_only_input(&self, id: &str) -> SqlConnectionInput {
            SqlConnectionInput {
                id: Some(id.to_string()),
                name: Some(id.to_string()),
                kind: SqlConnectionKind::Sqlite,
                database_path: Some(self.path.display().to_string()),
                host: None,
                port: None,
                database: None,
                username: None,
                password: None,
                ssl_mode: None,
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

    fn read_only_store(name: &str) -> (Arc<SqlConnectionStore>, TempDb) {
        let db = TempDb::new(name);
        let store = Arc::new(SqlConnectionStore::new());
        store.open_connection(db.input("writer")).unwrap();
        store.close_connection("writer").unwrap();
        store.open_connection(db.read_only_input("reader")).unwrap();
        (store, db)
    }

    fn wait_for_lifecycle_attempt(store: &SqlConnectionStore, previous_attempts: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while store.lifecycle_attempts_for_test() <= previous_attempts {
            assert!(
                Instant::now() < deadline,
                "connection lifecycle operation did not reach the serialized boundary"
            );
            std::thread::yield_now();
        }
    }

    struct RunningAgentQuery {
        started: mpsc::Receiver<()>,
        result: mpsc::Receiver<Result<SqlQueryResult, String>>,
        stop: Arc<AtomicBool>,
        worker: Option<JoinHandle<()>>,
    }

    impl Drop for RunningAgentQuery {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    struct RunningStoreQuery {
        started: mpsc::Receiver<()>,
        result: mpsc::Receiver<Result<SqlQueryResult, String>>,
        stop: Arc<AtomicBool>,
        worker: Option<JoinHandle<()>>,
    }

    impl Drop for RunningStoreQuery {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    fn spawn_running_store_query(
        store: Arc<SqlConnectionStore>,
        connection_id: &str,
    ) -> RunningStoreQuery {
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_in_query = Arc::clone(&stop);
        let mut started_tx = Some(started_tx);
        store
            .install_sqlite_progress_handler_for_test(connection_id, move || {
                if let Some(started_tx) = started_tx.take() {
                    let _ = started_tx.send(());
                }
                stop_in_query.load(Ordering::Acquire)
            })
            .expect("install SQLite progress handler");

        let connection_id = connection_id.to_string();
        let worker = std::thread::spawn(move || {
            let result = store.execute_query(SqlExecuteQueryRequest {
                connection_id,
                sql: LONG_RECURSIVE_QUERY.to_string(),
                limit: Some(1),
            });
            let _ = result_tx.send(result);
        });

        RunningStoreQuery {
            started: started_rx,
            result: result_rx,
            stop,
            worker: Some(worker),
        }
    }

    fn spawn_running_agent_query(
        store: Arc<SqlConnectionStore>,
        run_id: &'static str,
    ) -> RunningAgentQuery {
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_in_query = Arc::clone(&stop);
        let worker = std::thread::spawn(move || {
            let mut cancellation_checks = 0;
            let result = store.execute_agent_query(
                &SqlExecuteQueryRequest {
                    connection_id: "reader".to_string(),
                    sql: LONG_RECURSIVE_QUERY.to_string(),
                    limit: Some(1),
                },
                run_id,
                "call-long",
                move || {
                    cancellation_checks += 1;
                    if cancellation_checks == 2 {
                        let _ = started_tx.send(());
                    }
                    stop_in_query.load(Ordering::Acquire)
                },
            );
            let _ = result_tx.send(result);
        });
        RunningAgentQuery {
            started: started_rx,
            result: result_rx,
            stop,
            worker: Some(worker),
        }
    }

    struct RunningUnownedQuery<'a> {
        conn: &'a Mutex<Connection>,
        resume: Option<mpsc::SyncSender<()>>,
        stop: Arc<AtomicBool>,
        result: mpsc::Receiver<Result<SqlQueryResult, String>>,
        worker: Option<JoinHandle<()>>,
    }

    impl Drop for RunningUnownedQuery<'_> {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            self.resume.take();
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
            if let Ok(conn) = self.conn.lock() {
                conn.progress_handler(0, None::<fn() -> bool>);
            }
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
        assert!(matches!(
            result.error,
            Some(SqlCommandError::ConnectionFailed { message }) if message.contains("does not exist")
        ));
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
    fn open_connection_info_returns_public_identity() {
        let store = SqlConnectionStore::new();
        let db = TempDb::new("open-connection-info");
        let opened = store.open_connection(db.input("local")).unwrap();

        let info = store.open_connection_info(" local ").unwrap();

        assert_eq!(info, opened);
    }

    #[test]
    fn open_connection_info_rejects_blank_id() {
        let store = SqlConnectionStore::new();

        let error = store.open_connection_info("  ").unwrap_err();

        assert!(matches!(error, SqlCommandError::InvalidInput { .. }));
    }

    #[test]
    fn open_connection_info_returns_not_open_for_missing_id() {
        let store = SqlConnectionStore::new();

        let error = store.open_connection_info("missing").unwrap_err();

        assert!(matches!(error, SqlCommandError::NotOpen { .. }));
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

        let cte_err = store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: "reader".to_string(),
                sql: "WITH cte AS (SELECT 1) DELETE FROM users WHERE id = 1".to_string(),
                limit: None,
            })
            .unwrap_err();

        assert!(cte_err.contains("read-only connection"));
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
    fn matching_agent_run_interrupts_running_query_and_connection_remains_usable() {
        let (store, _db) = read_only_store("agent-interrupt");
        let query = spawn_running_agent_query(Arc::clone(&store), "run-target");
        query
            .started
            .recv_timeout(Duration::from_secs(5))
            .expect("agent query should enter the SQLite VM");

        assert_eq!(store.cancel_agent_queries_for_run("run-target").unwrap(), 1);
        let error = query
            .result
            .recv_timeout(Duration::from_secs(5))
            .expect("interrupted query should return promptly")
            .unwrap_err();
        assert!(error.contains("interrupted"), "unexpected error: {error}");
        assert!(store.active_agent_query_owner("reader").unwrap().is_none());

        let follow_up = store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: "reader".to_string(),
                sql: "SELECT 1".to_string(),
                limit: Some(1),
            })
            .unwrap();
        assert_eq!(follow_up.rows[0][0], SqlCellValue::integer(1));
    }

    #[test]
    fn mismatched_agent_run_does_not_interrupt_active_query() {
        let (store, _db) = read_only_store("agent-owner-mismatch");
        let query = spawn_running_agent_query(Arc::clone(&store), "run-owner");
        query
            .started
            .recv_timeout(Duration::from_secs(5))
            .expect("agent query should enter the SQLite VM");

        assert_eq!(store.cancel_agent_queries_for_run("run-other").unwrap(), 0);
        assert!(matches!(
            query.result.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));

        assert_eq!(store.cancel_agent_queries_for_run("run-owner").unwrap(), 1);
        let error = query
            .result
            .recv_timeout(Duration::from_secs(5))
            .expect("cleanup interrupt should finish the query")
            .unwrap_err();
        assert!(error.contains("interrupted"), "unexpected error: {error}");
    }

    #[test]
    fn agent_cancel_does_not_interrupt_unowned_query() {
        let (store, _db) = read_only_store("agent-unowned-query");
        let handle = store.connection("reader").unwrap();
        let SqlRuntimeConnection::Sqlite { conn, .. } = &handle.runtime else {
            panic!("test connection should be SQLite");
        };
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (continued_tx, continued_rx) = mpsc::sync_channel(1);
        let (resume_tx, resume_rx) = mpsc::sync_channel(0);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_in_query = Arc::clone(&stop);
        let mut started_tx = Some(started_tx);
        let mut continued_tx = Some(continued_tx);
        conn.lock().unwrap().progress_handler(
            1_000,
            Some(move || {
                if let Some(started_tx) = started_tx.take() {
                    let _ = started_tx.send(());
                    if resume_rx.recv().is_err() {
                        return true;
                    }
                }
                if let Some(continued_tx) = continued_tx.take() {
                    let _ = continued_tx.send(());
                }
                stop_in_query.load(Ordering::Acquire)
            }),
        );
        let store_for_query = Arc::clone(&store);
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            let result = store_for_query.execute_query(SqlExecuteQueryRequest {
                connection_id: "reader".to_string(),
                sql: LONG_RECURSIVE_QUERY.to_string(),
                limit: Some(1),
            });
            let _ = result_tx.send(result);
        });
        let query = RunningUnownedQuery {
            conn,
            resume: Some(resume_tx),
            stop,
            result: result_rx,
            worker: Some(worker),
        };
        started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("ordinary query should enter the SQLite VM");

        assert_eq!(
            store.cancel_agent_queries_for_run("run-unrelated").unwrap(),
            0
        );
        query
            .resume
            .as_ref()
            .expect("query resume gate should be available")
            .send(())
            .expect("query should still be waiting inside the SQLite VM");
        continued_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("unowned query should continue inside the SQLite VM");
        assert!(matches!(
            query.result.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));

        query.stop.store(true, Ordering::Release);
        let result = query
            .result
            .recv_timeout(Duration::from_secs(5))
            .expect("test stop should finish the ordinary query");
        let error = result.unwrap_err();
        assert!(error.contains("interrupted"), "unexpected error: {error}");
    }

    #[test]
    fn close_connection_interrupts_running_unowned_query() {
        let (store, _db) = read_only_store("close-unowned-query");
        let query = spawn_running_store_query(Arc::clone(&store), "reader");
        query
            .started
            .recv_timeout(Duration::from_secs(5))
            .expect("ordinary query should enter the SQLite VM");

        store.close_connection("reader").unwrap();
        let error = query
            .result
            .recv_timeout(Duration::from_secs(5))
            .expect("close should interrupt the detached query")
            .unwrap_err();

        assert!(error.contains("interrupted"), "unexpected error: {error}");
    }

    #[test]
    fn close_connection_drains_and_rejects_query_waiting_on_old_runtime_lock() {
        let (store, _db) = read_only_store("close-waiting-query");
        let handle = store.connection("reader").unwrap();
        let SqlRuntimeConnection::Sqlite { conn, .. } = &handle.runtime else {
            panic!("test connection should be SQLite");
        };
        let connection_lock = conn.lock().unwrap();
        let stale_handle = Arc::clone(&handle);
        let (attempted_tx, attempted_rx) = mpsc::sync_channel(1);
        let (query_result_tx, query_result_rx) = mpsc::sync_channel(1);
        let query_worker = std::thread::spawn(move || {
            let SqlRuntimeConnection::Sqlite { conn, .. } = &stale_handle.runtime else {
                panic!("test connection should be SQLite");
            };
            attempted_tx.send(()).unwrap();
            let result = SqlConnectionStore::execute_sqlite_query(
                stale_handle.as_ref(),
                conn,
                "SELECT 1",
                1,
            );
            query_result_tx.send(result).unwrap();
        });
        attempted_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("detached query should wait for the SQLite lock");

        let close_store = Arc::clone(&store);
        let (close_result_tx, close_result_rx) = mpsc::sync_channel(1);
        let close_worker = std::thread::spawn(move || {
            close_result_tx
                .send(close_store.close_connection("reader"))
                .unwrap();
        });
        let retirement_deadline = Instant::now() + Duration::from_secs(5);
        while !handle.retired.load(Ordering::Acquire) {
            assert!(
                Instant::now() < retirement_deadline,
                "close should publish retirement before draining SQLite"
            );
            std::thread::yield_now();
        }
        assert!(matches!(
            close_result_rx.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        drop(connection_lock);

        let close_result = close_result_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("close should finish after the SQLite lock is released");
        let query_error = query_result_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("detached query should finish after retirement")
            .expect_err("detached query must not execute on a retired runtime");
        close_worker.join().expect("join close worker");
        query_worker.join().expect("join detached query worker");

        assert!(
            close_result.is_ok(),
            "unexpected close error: {close_result:?}"
        );
        assert!(
            query_error.contains("closed"),
            "unexpected query error: {query_error}"
        );
    }

    #[test]
    fn close_connection_retries_interrupt_for_query_paused_before_sqlite_vm() {
        let (store, _db) = read_only_store("close-pre-vm-query");
        let handle = store.connection("reader").unwrap();
        let SqlRuntimeConnection::Sqlite { conn, .. } = &handle.runtime else {
            panic!("test connection should be SQLite");
        };
        let cleanup = Arc::new(AtomicBool::new(false));
        let cleanup_in_query = Arc::clone(&cleanup);
        conn.lock().unwrap().progress_handler(
            1_000,
            Some(move || cleanup_in_query.load(Ordering::Acquire)),
        );
        let stale_handle = Arc::clone(&handle);
        let (active_tx, active_rx) = mpsc::sync_channel(1);
        let (resume_tx, resume_rx) = mpsc::sync_channel(0);
        let (query_result_tx, query_result_rx) = mpsc::sync_channel(1);
        let query_worker = std::thread::spawn(move || {
            let SqlRuntimeConnection::Sqlite { conn, .. } = &stale_handle.runtime else {
                panic!("test connection should be SQLite");
            };
            let conn = conn.lock().unwrap();
            stale_handle.ensure_active().unwrap();
            active_tx.send(()).unwrap();
            resume_rx.recv().unwrap();
            let result =
                SqlConnectionStore::execute_sqlite_query_locked(&conn, LONG_RECURSIVE_QUERY, 1);
            query_result_tx.send(result).unwrap();
        });
        active_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("query should pass its active check before entering SQLite");

        let close_store = Arc::clone(&store);
        let (close_result_tx, close_result_rx) = mpsc::sync_channel(1);
        let close_worker = std::thread::spawn(move || {
            close_result_tx
                .send(close_store.close_connection("reader"))
                .unwrap();
        });
        let retirement_deadline = Instant::now() + Duration::from_secs(5);
        while !handle.retired.load(Ordering::Acquire) {
            assert!(
                Instant::now() < retirement_deadline,
                "close should publish retirement before draining SQLite"
            );
            std::thread::yield_now();
        }
        resume_tx
            .send(())
            .expect("resume query after the first interrupt was sent");

        let early_query_result = query_result_rx.recv_timeout(Duration::from_millis(200));
        let interrupted_without_cleanup = early_query_result.is_ok();
        if !interrupted_without_cleanup {
            cleanup.store(true, Ordering::Release);
        }
        let query_result = match early_query_result {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => query_result_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("cleanup should stop the query after a lost interrupt"),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                panic!("query worker disconnected before returning a result")
            }
        };
        let close_result = close_result_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("close should finish after the old query stops");
        query_worker.join().expect("join pre-VM query worker");
        close_worker.join().expect("join close worker");
        let query_error = query_result.expect_err("retired query should be interrupted");

        assert!(
            interrupted_without_cleanup,
            "retirement must retry an interrupt that arrived before the SQLite VM started"
        );
        assert!(
            close_result.is_ok(),
            "unexpected close error: {close_result:?}"
        );
        assert!(
            query_error.contains("interrupted"),
            "unexpected query error: {query_error}"
        );
    }

    #[test]
    fn replace_connection_interrupts_previous_runtime_query() {
        let (store, db) = read_only_store("replace-running-query");
        let query = spawn_running_store_query(Arc::clone(&store), "reader");
        query
            .started
            .recv_timeout(Duration::from_secs(5))
            .expect("old runtime query should enter the SQLite VM");

        store
            .replace_connection(db.read_only_input("reader"))
            .expect("replace SQLite runtime");
        let error = query
            .result
            .recv_timeout(Duration::from_millis(200))
            .expect("replacement should retire the old runtime query")
            .expect_err("old runtime query should be interrupted");

        assert!(error.contains("interrupted"), "unexpected error: {error}");
    }

    #[test]
    fn save_and_open_connection_interrupts_previous_runtime_query() {
        let (store, db) = read_only_store("save-open-running-query");
        let query = spawn_running_store_query(Arc::clone(&store), "reader");
        query
            .started
            .recv_timeout(Duration::from_secs(5))
            .expect("old runtime query should enter the SQLite VM");

        store
            .save_and_open_connection(db.read_only_input("reader"), false, false)
            .expect("replace SQLite runtime without persistence");
        let error = query
            .result
            .recv_timeout(Duration::from_millis(200))
            .expect("save-and-open should retire the old runtime query")
            .expect_err("old runtime query should be interrupted");

        assert!(error.contains("interrupted"), "unexpected error: {error}");
    }

    #[test]
    fn cancelled_agent_waiting_for_connection_lock_never_becomes_active_owner() {
        let (store, _db) = read_only_store("agent-lock-wait");
        let handle = store.connection("reader").unwrap();
        let SqlRuntimeConnection::Sqlite { conn, .. } = &handle.runtime else {
            panic!("test connection should be SQLite");
        };
        let connection_lock = conn.lock().unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancelled_for_query = Arc::clone(&cancelled);
        let store_for_query = Arc::clone(&store);
        let (attempted_tx, attempted_rx) = mpsc::sync_channel(1);
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            attempted_tx.send(()).unwrap();
            let result = store_for_query.execute_agent_query(
                &SqlExecuteQueryRequest {
                    connection_id: "reader".to_string(),
                    sql: LONG_RECURSIVE_QUERY.to_string(),
                    limit: Some(1),
                },
                "run-waiting",
                "call-waiting",
                move || cancelled_for_query.load(Ordering::Acquire),
            );
            result_tx.send(result).unwrap();
        });
        attempted_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("agent query thread should start");

        cancelled.store(true, Ordering::Release);
        assert_eq!(
            store.cancel_agent_queries_for_run("run-waiting").unwrap(),
            0
        );
        assert!(store.active_agent_query_owner("reader").unwrap().is_none());
        drop(connection_lock);

        let error = result_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("waiting query should observe cancellation")
            .unwrap_err();
        assert!(error.contains("cancelled before execution"));
    }

    #[test]
    fn pre_cancelled_agent_query_is_rejected_before_sqlite_execution() {
        let (store, _db) = read_only_store("agent-pre-cancel");

        let error = store
            .execute_agent_query(
                &SqlExecuteQueryRequest {
                    connection_id: "reader".to_string(),
                    sql: "SELECT 1".to_string(),
                    limit: Some(1),
                },
                "run-cancelled",
                "call-cancelled",
                || true,
            )
            .unwrap_err();

        assert!(error.contains("cancelled before execution"));
        assert!(store.active_agent_query_owner("reader").unwrap().is_none());
    }

    #[test]
    fn sql_may_mutate_detects_mutating_statements() {
        assert!(!sql_may_mutate("SELECT 1"));
        assert!(!sql_may_mutate(
            "-- comment\nWITH cte AS (SELECT 1) SELECT * FROM cte"
        ));
        assert!(!sql_may_mutate(
            "WITH first_cte AS (SELECT 1), second_cte AS (SELECT 2) SELECT * FROM second_cte"
        ));
        assert!(sql_may_mutate(
            "WITH cte AS (SELECT 1) DELETE FROM users WHERE id = 1"
        ));
        assert!(sql_may_mutate(
            "WITH cte AS (SELECT 1) UPDATE users SET name = 'changed'"
        ));
        assert!(sql_may_mutate(
            "WITH cte AS (SELECT 1) INSERT INTO users(name) SELECT 'changed'"
        ));
        assert!(sql_may_mutate("INSERT INTO users VALUES (1)"));
        assert!(sql_may_mutate("/* comment */ DROP TABLE users"));
        assert!(sql_may_mutate("PRAGMA journal_mode = WAL"));
    }

    #[test]
    fn sql_may_mutate_allows_mysql_show() {
        assert!(!sql_may_mutate("SHOW TABLES"));
    }

    #[test]
    fn sql_may_mutate_allows_values() {
        assert!(!sql_may_mutate("VALUES (1), (2)"));
    }

    #[test]
    fn sql_may_mutate_allows_cte_followed_by_values() {
        assert!(!sql_may_mutate(
            "WITH cte AS (SELECT 1) VALUES ((SELECT * FROM cte))"
        ));
    }

    #[test]
    fn sql_may_mutate_blocks_unknown_statement_keywords() {
        assert!([
            "REINDEX users",
            "GRANT SELECT ON users TO reader",
            "CALL refresh_cache()"
        ]
        .into_iter()
        .all(sql_may_mutate));
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

    #[test]
    fn replace_connection_swaps_runtime_and_restores_after_failure() {
        let store = SqlConnectionStore::new();
        let old_db = TempDb::new("replace-old");
        let new_db = TempDb::new("replace-new");

        store.open_connection(old_db.input("local")).unwrap();

        let replaced = store.replace_connection(new_db.input("local")).unwrap();
        assert_eq!(
            replaced.database_path,
            Some(new_db.path.display().to_string())
        );
        assert_eq!(
            store.list_connections().unwrap()[0].database_path,
            replaced.database_path
        );

        let missing_path =
            std::env::temp_dir().join(format!("sql-studio-next-missing-{}.db", Uuid::new_v4()));
        let mut failing_input = new_db.input("local");
        failing_input.database_path = Some(missing_path.display().to_string());
        failing_input.create_if_missing = false;

        assert!(store.replace_connection(failing_input).is_err());
        assert_eq!(
            store.list_connections().unwrap()[0].database_path,
            Some(new_db.path.display().to_string())
        );
        let result = store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: "local".to_string(),
                sql: "SELECT 1".to_string(),
                limit: Some(1),
            })
            .expect("restored replacement runtime should remain active");
        assert_eq!(result.rows[0][0], SqlCellValue::integer(1));
    }

    #[test]
    fn save_and_open_connection_replaces_runtime_and_persists_public_fields() {
        let store = SqlConnectionStore::new();
        let path = temp_json_file("save-and-open-replace");
        store.initialize_persistence(path.clone()).unwrap();

        let old_db = TempDb::new("save-and-open-old");
        let new_db = TempDb::new("save-and-open-new");
        store.open_connection(old_db.input("local")).unwrap();

        let mut input = new_db.input("local");
        input.password = Some("transient-secret".to_string());
        let opened = store.save_and_open_connection(input, true, true).unwrap();

        assert_eq!(
            opened.database_path,
            Some(new_db.path.display().to_string())
        );
        assert_eq!(
            store.list_connections().unwrap()[0].database_path,
            opened.database_path
        );
        let saved = store.list_saved_connections().unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].database_path, opened.database_path);
        assert!(saved[0].auto_connect);
        let persisted = std::fs::read_to_string(&path).unwrap();
        assert!(!persisted.contains("password"));
        assert!(!persisted.contains("transient-secret"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn save_and_open_connection_restores_active_runtime_after_persistence_failure() {
        let store = SqlConnectionStore::new();
        let path = temp_json_file("save-and-open-persistence-failure");
        store.initialize_persistence(path.clone()).unwrap();
        let old_db = TempDb::new("save-and-open-persistence-old");
        let new_db = TempDb::new("save-and-open-persistence-new");
        store
            .save_and_open_connection(old_db.input("local"), false, true)
            .expect("persist original runtime");
        std::fs::remove_file(&path).expect("remove persistence file");
        std::fs::create_dir(&path).expect("block persistence path with directory");

        let _error = store
            .save_and_open_connection(new_db.input("local"), false, true)
            .expect_err("replacement persistence should fail");
        let restored = store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: "local".to_string(),
                sql: "SELECT 1".to_string(),
                limit: Some(1),
            })
            .expect("previous runtime should be restored without retirement");
        let _ = std::fs::remove_dir(path);

        assert_eq!(restored.rows[0][0], SqlCellValue::integer(1));
    }

    #[test]
    fn persistence_failure_then_concurrent_close_does_not_resurrect_previous_runtime() {
        let store = Arc::new(SqlConnectionStore::new());
        let path = temp_json_file("save-open-failure-concurrent-close");
        store.initialize_persistence(path.clone()).unwrap();
        let previous_db = TempDb::new("save-open-close-previous");
        let transient_db = TempDb::new("save-open-close-transient");
        store
            .save_and_open_connection(previous_db.input("local"), false, true)
            .expect("persist previous runtime");
        let previous_handle = store.connection("local").unwrap();
        std::fs::remove_file(&path).expect("remove persistence file");
        std::fs::create_dir(&path).expect("block persistence path with directory");

        let (flush_reached_rx, resume_flush_tx) = store.pause_next_persistence_flush_for_test();
        let save_store = Arc::clone(&store);
        let transient_input = transient_db.input("local");
        let (save_result_tx, save_result_rx) = mpsc::sync_channel(1);
        let save_worker = std::thread::spawn(move || {
            save_result_tx
                .send(save_store.save_and_open_connection(transient_input, false, true))
                .unwrap();
        });
        flush_reached_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("replacement should pause before persistence");
        let transient_handle = store.connection("local").unwrap();

        let attempts_before_close = store.lifecycle_attempts_for_test();
        let close_store = Arc::clone(&store);
        let (close_result_tx, close_result_rx) = mpsc::sync_channel(1);
        let close_worker = std::thread::spawn(move || {
            close_result_tx
                .send(close_store.close_connection("local"))
                .unwrap();
        });
        wait_for_lifecycle_attempt(&store, attempts_before_close);
        assert!(matches!(
            close_result_rx.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));

        resume_flush_tx.send(()).expect("resume failed persistence");
        let save_error = save_result_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("save-and-open should return")
            .expect_err("replacement persistence should fail");
        let close_result = close_result_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("close should run after rollback");
        save_worker.join().expect("join save-and-open worker");
        close_worker.join().expect("join close worker");
        let _ = std::fs::remove_dir(path);

        assert!(
            save_error.contains("failed") || save_error.contains("directory"),
            "unexpected persistence error: {save_error}"
        );
        assert!(
            close_result.is_ok(),
            "unexpected close error: {close_result:?}"
        );
        assert!(store.list_connections().unwrap().is_empty());
        assert!(previous_handle.ensure_active().is_err());
        assert!(transient_handle.ensure_active().is_err());
    }

    #[test]
    fn persistence_failure_then_concurrent_replace_keeps_latest_runtime() {
        let store = Arc::new(SqlConnectionStore::new());
        let path = temp_json_file("save-open-failure-concurrent-replace");
        store.initialize_persistence(path.clone()).unwrap();
        let previous_db = TempDb::new("save-open-replace-previous");
        let transient_db = TempDb::new("save-open-replace-transient");
        let latest_db = TempDb::new("save-open-replace-latest");
        store
            .save_and_open_connection(previous_db.input("local"), false, true)
            .expect("persist previous runtime");
        let previous_handle = store.connection("local").unwrap();
        std::fs::remove_file(&path).expect("remove persistence file");
        std::fs::create_dir(&path).expect("block persistence path with directory");

        let (flush_reached_rx, resume_flush_tx) = store.pause_next_persistence_flush_for_test();
        let save_store = Arc::clone(&store);
        let transient_input = transient_db.input("local");
        let (save_result_tx, save_result_rx) = mpsc::sync_channel(1);
        let save_worker = std::thread::spawn(move || {
            save_result_tx
                .send(save_store.save_and_open_connection(transient_input, false, true))
                .unwrap();
        });
        flush_reached_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("replacement should pause before persistence");
        let transient_handle = store.connection("local").unwrap();

        let attempts_before_replace = store.lifecycle_attempts_for_test();
        let replace_store = Arc::clone(&store);
        let latest_input = latest_db.input("local");
        let (replace_result_tx, replace_result_rx) = mpsc::sync_channel(1);
        let replace_worker = std::thread::spawn(move || {
            replace_result_tx
                .send(replace_store.replace_connection(latest_input))
                .unwrap();
        });
        wait_for_lifecycle_attempt(&store, attempts_before_replace);
        assert!(matches!(
            replace_result_rx.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));

        resume_flush_tx.send(()).expect("resume failed persistence");
        save_result_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("save-and-open should return")
            .expect_err("replacement persistence should fail");
        let replaced = replace_result_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("replace should run after rollback")
            .expect("latest runtime should open");
        save_worker.join().expect("join save-and-open worker");
        replace_worker.join().expect("join replace worker");
        let _ = std::fs::remove_dir(path);

        assert_eq!(
            replaced.database_path,
            Some(latest_db.path.display().to_string())
        );
        let query = store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: "local".to_string(),
                sql: "SELECT 1".to_string(),
                limit: Some(1),
            })
            .expect("latest runtime should remain queryable");
        assert_eq!(query.rows[0][0], SqlCellValue::integer(1));
        assert!(previous_handle.ensure_active().is_err());
        assert!(transient_handle.ensure_active().is_err());
    }

    #[test]
    fn save_and_open_connection_can_forget_an_existing_profile_atomically() {
        let store = SqlConnectionStore::new();
        let path = temp_json_file("save-and-open-forget");
        store.initialize_persistence(path.clone()).unwrap();

        let old_db = TempDb::new("save-and-open-forget-old");
        let new_db = TempDb::new("save-and-open-forget-new");
        let mut original = old_db.input("local");
        original.name = Some("Saved local".to_string());
        store
            .save_and_open_connection(original, false, true)
            .unwrap();

        let mut replacement = new_db.input("local");
        replacement.name = Some("Unsaved local".to_string());
        let opened = store
            .save_and_open_connection(replacement, false, false)
            .unwrap();

        assert_eq!(opened.name, "Unsaved local");
        assert!(store.list_saved_connections().unwrap().is_empty());
        assert!(!std::fs::read_to_string(&path)
            .unwrap()
            .contains("Saved local"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn save_connection_persists_and_lists_saved_connections() {
        let store = SqlConnectionStore::new();
        let path = temp_json_file("save-list");

        store.initialize_persistence(path.clone()).unwrap();

        let db = TempDb::new("save-list-db");

        let saved = store
            .save_connection(SqlSaveConnectionRequest {
                input: db.input("local"),
                auto_connect: true,
                open_now: false,
            })
            .unwrap();

        assert_eq!(saved.id, "local");
        assert!(saved.auto_connect);

        let saved_connections = store.list_saved_connections().unwrap();
        assert_eq!(saved_connections.len(), 1);
        assert_eq!(saved_connections[0].id, "local");

        let reloaded = SqlConnectionStore::new();
        reloaded.initialize_persistence(path.clone()).unwrap();

        let saved_connections = reloaded.list_saved_connections().unwrap();
        assert_eq!(saved_connections.len(), 1);
        assert_eq!(saved_connections[0].id, "local");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn save_connection_can_open_connection_immediately() {
        let store = SqlConnectionStore::new();
        let path = temp_json_file("save-open-now");

        store.initialize_persistence(path.clone()).unwrap();

        let db = TempDb::new("save-open-now-db");

        store
            .save_connection(SqlSaveConnectionRequest {
                input: db.input("local"),
                auto_connect: true,
                open_now: true,
            })
            .unwrap();

        let opened = store.list_connections().unwrap();
        assert_eq!(opened.len(), 1);
        assert_eq!(opened[0].id, "local");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn remove_saved_connection_deletes_saved_entry_and_optionally_closes_open_connection() {
        let store = SqlConnectionStore::new();
        let path = temp_json_file("remove");

        store.initialize_persistence(path.clone()).unwrap();

        let db = TempDb::new("remove-db");

        store
            .save_connection(SqlSaveConnectionRequest {
                input: db.input("local"),
                auto_connect: true,
                open_now: true,
            })
            .unwrap();

        store
            .remove_saved_connection(SqlRemoveSavedConnectionRequest {
                connection_id: "local".to_string(),
                close_if_open: true,
            })
            .unwrap();

        assert_eq!(store.list_saved_connections().unwrap().len(), 0);
        assert_eq!(store.list_connections().unwrap().len(), 0);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn restore_saved_connections_opens_auto_connect_connections() {
        let path = temp_json_file("restore");

        let store = SqlConnectionStore::new();
        store.initialize_persistence(path.clone()).unwrap();

        let db = TempDb::new("restore-db");

        store
            .save_connection(SqlSaveConnectionRequest {
                input: db.input("local"),
                auto_connect: true,
                open_now: false,
            })
            .unwrap();

        let restored = SqlConnectionStore::new();
        restored.initialize_persistence(path.clone()).unwrap();

        let result = restored.restore_saved_connections().unwrap();

        assert_eq!(result.opened.len(), 1);
        assert_eq!(result.errors.len(), 0);
        assert_eq!(result.opened[0].id, "local");
        assert_eq!(restored.list_connections().unwrap().len(), 1);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn restore_saved_connections_forces_legacy_demo_runtime_read_only() {
        let path = temp_json_file("restore-legacy-demo");
        let store = SqlConnectionStore::new();
        store.initialize_persistence(path.clone()).unwrap();
        let db = TempDb::new("restore-legacy-demo-db");

        store
            .save_and_open_connection_without_builtin_policy(&db.input(DEMO_PROFILE_ID), true, true)
            .unwrap();
        store.close_connection(DEMO_PROFILE_ID).unwrap();

        let result = store.restore_saved_connections().unwrap();
        let mutation_error = store
            .execute_query(SqlExecuteQueryRequest {
                connection_id: DEMO_PROFILE_ID.to_string(),
                sql: "UPDATE users SET name = 'Changed'".to_string(),
                limit: None,
            })
            .unwrap_err();

        assert!(result.errors.is_empty());
        assert!(result.opened[0].read_only);
        assert_eq!(
            mutation_error,
            "read-only connection only allows explicitly read-only statements"
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn restore_saved_connections_reports_failed_auto_connect() {
        let path = temp_json_file("restore-error");

        let store = SqlConnectionStore::new();
        store.initialize_persistence(path.clone()).unwrap();

        // A non-existent file under a writable parent. At save time,
        // validate_sqlite_path passes (create_if_missing: true) even
        // though no file is written. On restore, the read-only flag
        // forces SQLITE_OPEN_READ_ONLY against a missing file, which
        // fails at the SQLite open step.
        let missing_dir = std::env::temp_dir().join(format!(
            "sql-studio-next-restore-missing-{}",
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&missing_dir).unwrap();
        let missing_path = missing_dir.join("never-created.sqlite");
        let missing_path_str = missing_path.to_string_lossy().to_string();

        store
            .save_connection(SqlSaveConnectionRequest {
                input: SqlConnectionInput {
                    id: Some("missing".to_string()),
                    name: Some("Missing".to_string()),
                    kind: SqlConnectionKind::Sqlite,
                    database_path: Some(missing_path_str),
                    host: None,
                    port: None,
                    database: None,
                    username: None,
                    password: None,
                    ssl_mode: None,
                    read_only: true,
                    create_if_missing: true,
                },
                auto_connect: true,
                open_now: false,
            })
            .unwrap();

        let restored = SqlConnectionStore::new();
        restored.initialize_persistence(path.clone()).unwrap();

        let result = restored.restore_saved_connections().unwrap();

        assert_eq!(result.opened.len(), 0);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].connection_id, "missing");

        let _ = std::fs::remove_dir_all(&missing_dir);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn save_connection_does_not_persist_when_open_now_fails() {
        let store = SqlConnectionStore::new();
        let path = temp_json_file("save-open-fail");

        store.initialize_persistence(path.clone()).unwrap();

        let missing_dir =
            std::env::temp_dir().join(format!("sql-studio-next-save-open-fail-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&missing_dir).unwrap();

        let missing_path = missing_dir.join("never-created.sqlite");
        let missing_path_str = missing_path.to_string_lossy().to_string();

        let err = store
            .save_connection(SqlSaveConnectionRequest {
                input: SqlConnectionInput {
                    id: Some("missing".to_string()),
                    name: Some("Missing".to_string()),
                    kind: SqlConnectionKind::Sqlite,
                    database_path: Some(missing_path_str),
                    host: None,
                    port: None,
                    database: None,
                    username: None,
                    password: None,
                    ssl_mode: None,
                    read_only: true,
                    create_if_missing: true,
                },
                auto_connect: true,
                open_now: true,
            })
            .unwrap_err();

        assert!(err.contains("failed to open sqlite database"));
        assert_eq!(store.list_saved_connections().unwrap().len(), 0);
        assert_eq!(store.list_connections().unwrap().len(), 0);

        let reloaded = SqlConnectionStore::new();
        reloaded.initialize_persistence(path.clone()).unwrap();
        assert_eq!(reloaded.list_saved_connections().unwrap().len(), 0);

        let _ = std::fs::remove_dir_all(&missing_dir);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn save_connection_rejects_in_memory_database() {
        let store = SqlConnectionStore::new();
        let path = temp_json_file("reject-memory");

        store.initialize_persistence(path.clone()).unwrap();

        let err = store
            .save_connection(SqlSaveConnectionRequest {
                input: SqlConnectionInput {
                    id: Some("memory".to_string()),
                    name: Some("Memory".to_string()),
                    kind: SqlConnectionKind::Sqlite,
                    database_path: Some(":memory:".to_string()),
                    host: None,
                    port: None,
                    database: None,
                    username: None,
                    password: None,
                    ssl_mode: None,
                    read_only: false,
                    create_if_missing: true,
                },
                auto_connect: true,
                open_now: true,
            })
            .unwrap_err();

        assert!(err.contains("in-memory SQLite connections cannot be saved"));
        assert_eq!(store.list_saved_connections().unwrap().len(), 0);
        assert_eq!(store.list_connections().unwrap().len(), 0);

        let _ = std::fs::remove_file(path);
    }

    fn temp_json_file(name: &str) -> std::path::PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();

        std::env::temp_dir().join(format!("sql-studio-next-{name}-{now}.json"))
    }
}

#[cfg(test)]
mod phase9_tests {
    use super::*;
    use crate::commands::sql::types::{SqlConnectionInput, SqlConnectionKind};

    #[test]
    fn open_memory_sqlite_connection_uses_in_memory_database() {
        let input = SqlConnectionInput {
            id: None,
            name: None,
            kind: SqlConnectionKind::Sqlite,
            database_path: Some(":memory:".to_string()),
            host: None,
            port: None,
            database: None,
            username: None,
            password: None,
            ssl_mode: None,
            read_only: false,
            create_if_missing: true,
        };

        let conn = open_sqlite_connection(&input).unwrap();

        conn.execute("CREATE TABLE users(id INTEGER PRIMARY KEY)", [])
            .unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'users'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(count, 1);
    }

    #[test]
    fn open_sqlite_connection_rejects_non_sqlite_driver() {
        let input = SqlConnectionInput {
            id: None,
            name: None,
            kind: SqlConnectionKind::PostgreSql,
            database_path: None,
            host: Some("localhost".to_string()),
            port: None,
            database: Some("app".to_string()),
            username: None,
            password: None,
            ssl_mode: None,
            read_only: false,
            create_if_missing: false,
        };

        let err = open_sqlite_connection(&input).unwrap_err();
        assert!(err.contains("only SQLite runtime driver is enabled"));
    }
}
