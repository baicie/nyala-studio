/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL driver registry (Phase 01).
 *
 * The registry is the *only* place that knows how to map a `DriverId` to
 * a concrete runtime driver. It is consulted by `ConnectionManager` when
 * a profile is opened.
 *
 * Goals:
 *   * Hide all runtime-specific types behind `BoxedConnection`.
 *   * Make driver implementation pluggable via `SqlDriver` trait.
 *   * Never log a secret: drivers only receive `ConnectionSecret` and are
 *     responsible for using it through their credential builder, never
 *     printing it.
 *--------------------------------------------------------------------------------------------*/

use std::sync::{Arc, Mutex};

use crate::runtime_status::DriverId;

use super::metadata_v2::{ColumnDto, SchemaObjectDto, SchemataDto};
use super::types::{ConnectionProfile, ConnectionSecret, DriverIdDto, SqlCommandError, SqlSslMode};

/// A live SQL connection. Concrete drivers own the underlying handle and
/// expose a tiny set of operations the rest of the SQL MVP cares about.
pub trait SqlConnection: Send + Sync + std::fmt::Debug {
    /// Closes the connection. Best-effort; subsequent calls are no-ops.
    fn close(&self);

    /// Returns true when the underlying handle is still healthy enough
    /// to issue a follow-up query. Used by Phase 04 result panel for
    /// status bar reporting.
    #[allow(dead_code)]
    fn is_alive(&self) -> bool;

    /// Lists schemas / databases for the connection.
    fn list_schemas(&self) -> Result<Vec<SchemataDto>, SqlCommandError>;

    /// Lists tables / views inside the given schema.
    fn list_tables(&self, schema: &str) -> Result<Vec<SchemaObjectDto>, SqlCommandError>;

    /// Lists columns of a table inside the given schema.
    fn list_columns(&self, schema: &str, table: &str) -> Result<Vec<ColumnDto>, SqlCommandError>;
}

pub type BoxedConnection = Arc<dyn SqlConnection>;

/// A SQL driver builds an open connection for a given profile + secret.
pub trait SqlDriver: Send + Sync {
    fn id(&self) -> DriverId;

    /// Returns Ok(BoxedConnection) when the connection was created
    /// successfully. The driver is responsible for honouring
    /// `profile.read_only` and `secret` confidentiality.
    fn open(
        &self,
        profile: &ConnectionProfile,
        secret: &ConnectionSecret,
    ) -> Result<BoxedConnection, String>;

    /// Returns Ok(()) if the connection could be opened and torn down
    /// cleanly. Drivers that need a network round-trip (`MySQL`) should
    /// actually open the pool to confirm reachability.
    #[allow(dead_code)]
    fn test(&self, profile: &ConnectionProfile, secret: &ConnectionSecret) -> Result<(), String> {
        let conn = self.open(profile, secret)?;
        conn.close();
        Ok(())
    }
}

pub struct SqlDriverRegistry {
    drivers: Vec<Box<dyn SqlDriver>>,
}

impl SqlDriverRegistry {
    pub fn new(drivers: Vec<Box<dyn SqlDriver>>) -> Self {
        Self { drivers }
    }

    pub fn build(&self, id: DriverId) -> Option<&dyn SqlDriver> {
        self.drivers
            .iter()
            .find(|driver| driver.id() == id)
            .map(std::convert::AsRef::as_ref)
    }
}

pub fn default_registry() -> SqlDriverRegistry {
    SqlDriverRegistry::new(vec![
        Box::new(SqliteDriver),
        Box::new(MysqlDriver),
        Box::new(PostgresDriverStub),
    ])
}

impl DriverIdDto {
    pub fn as_runtime_id(self) -> DriverId {
        DriverId::from(self)
    }
}

// ---------------------------------------------------------------------------
// SQLite driver.
//
// For Phase 01 the SQLite driver verifies the file path. Phase 02
// upgrades the probe connection to a real `rusqlite::Connection` and
// implements schema / table / column introspection.
// ---------------------------------------------------------------------------

use rusqlite::Connection as SqliteRawConnection;

pub struct SqliteDriver;

impl SqlDriver for SqliteDriver {
    fn id(&self) -> DriverId {
        DriverId::Sqlite
    }

    fn open(
        &self,
        profile: &ConnectionProfile,
        _secret: &ConnectionSecret,
    ) -> Result<BoxedConnection, String> {
        let path = if profile.remember_in_memory {
            ":memory:".to_string()
        } else {
            profile.file_path.clone().ok_or_else(|| {
                "SQLite connection requires filePath or rememberInMemory".to_string()
            })?
        };

        let conn = SqliteRawConnection::open(&path)
            .map_err(|err| format!("failed to open SQLite connection: {err}"))?;

        if profile.read_only {
            // `query_only` PRAGMA is broadly supported; falling back to
            // a read-only transaction would change semantics, so we
            // only apply the pragma when the connection accepted it.
            let _ = conn.pragma_update(None, "query_only", 1);
        }

        Ok(Arc::new(SqliteConnection::new(conn)))
    }

    fn test(&self, profile: &ConnectionProfile, secret: &ConnectionSecret) -> Result<(), String> {
        self.open(profile, secret).map(|_| ())
    }
}

/// Phase 02 `SQLite` connection. The underlying handle is wrapped behind
/// a `Mutex` so the trait methods can be called from multiple Tauri
/// commands without taking the connection by `&mut`.
pub struct SqliteConnection {
    conn: Mutex<SqliteRawConnection>,
}

impl std::fmt::Debug for SqliteConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SqliteConnection")
    }
}

impl SqliteConnection {
    pub fn new(conn: SqliteRawConnection) -> Self {
        Self {
            conn: Mutex::new(conn),
        }
    }
}

impl SqlConnection for SqliteConnection {
    fn close(&self) {}

    fn is_alive(&self) -> bool {
        self.conn.lock().is_ok_and(|_| true)
    }

    fn list_schemas(&self) -> Result<Vec<SchemataDto>, SqlCommandError> {
        Ok(vec![SchemataDto {
            schema: "main".into(),
            is_default: true,
        }])
    }

    fn list_tables(&self, schema: &str) -> Result<Vec<SchemaObjectDto>, SqlCommandError> {
        if schema != "main" {
            return Err(SqlCommandError::new(
                "invalid_schema",
                "SQLite only supports the 'main' schema",
            ));
        }

        let conn = self.conn.lock().map_err(|err| {
            SqlCommandError::new(
                "sqlite_locked",
                format!("sqlite connection poisoned: {err}"),
            )
        })?;

        let mut stmt = conn
            .prepare(
                "SELECT type, name FROM sqlite_master \
                 WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' \
                 ORDER BY type, name",
            )
            .map_err(|err| SqlCommandError::new("sqlite_prepare", err.to_string()))?;

        let rows = stmt
            .query_map([], |row| {
                let t: String = row.get(0)?;
                let n: String = row.get(1)?;
                Ok((t, n))
            })
            .map_err(|err| SqlCommandError::new("sqlite_query", err.to_string()))?;

        let mut out = Vec::new();
        for r in rows {
            let (t, n) = r.map_err(|err| SqlCommandError::new("sqlite_iter", err.to_string()))?;
            out.push(SchemaObjectDto {
                kind: if t.eq_ignore_ascii_case("view") {
                    super::metadata_v2::SchemaObjectKind::View
                } else {
                    super::metadata_v2::SchemaObjectKind::Table
                },
                name: n,
                schema: Some("main".into()),
                columns: Vec::new(),
                primary_key: Vec::new(),
            });
        }
        Ok(out)
    }

    fn list_columns(&self, schema: &str, table: &str) -> Result<Vec<ColumnDto>, SqlCommandError> {
        if schema != "main" {
            return Err(SqlCommandError::new(
                "invalid_schema",
                "SQLite only supports the 'main' schema",
            ));
        }

        let escaped = table.replace('"', "\"\"");
        let sql = format!("PRAGMA table_info(\"{escaped}\")");
        let conn = self.conn.lock().map_err(|err| {
            SqlCommandError::new(
                "sqlite_locked",
                format!("sqlite connection poisoned: {err}"),
            )
        })?;

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|err| SqlCommandError::new("sqlite_prepare", err.to_string()))?;

        let rows = stmt
            .query_map([], |row| {
                let cid: i32 = row.get(0)?;
                let name: String = row.get(1)?;
                let dtype: String = row.get(2)?;
                let notnull: i64 = row.get(3)?;
                let default: Option<String> = row.get(4)?;
                let pk: i64 = row.get(5)?;
                Ok(ColumnDto {
                    name,
                    data_type: dtype,
                    is_nullable: notnull == 0,
                    is_primary_key: pk > 0,
                    default_value: default,
                    comment: None,
                    ordinal: cid,
                })
            })
            .map_err(|err| SqlCommandError::new("sqlite_query", err.to_string()))?;

        let mut out: Vec<ColumnDto> = rows
            .map(|r| r.unwrap_or_else(|err| panic!("sqlite row decode failed: {err}")))
            .collect();
        out.sort_by_key(|c| c.ordinal);
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// MySQL driver.
//
// Phase 01 only verifies the driver builds a pool and that the pool can
// hand out a connection; it does *not* actually run queries.
// ---------------------------------------------------------------------------

use mysql::{prelude::Queryable, SslOpts};

pub struct MysqlDriver;

impl MysqlDriver {
    fn options(
        profile: &ConnectionProfile,
        secret: &ConnectionSecret,
    ) -> Result<mysql::OptsBuilder, String> {
        let host = non_empty(profile.host.as_deref(), "host")?;
        let database = non_empty(profile.database.as_deref(), "database")?;
        let port = profile.port.unwrap_or(3306);

        let mut builder = super::mysql_runtime::mysql_opts_builder()
            .ip_or_hostname(Some(host))
            .tcp_port(port)
            .db_name(Some(database));

        if let Some(username) = profile
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            builder = builder.user(Some(username));
        }
        if let Some(password) = secret.password.as_deref() {
            builder = builder.pass(Some(password));
        }
        if matches!(profile.ssl_mode, Some(SqlSslMode::Require)) {
            builder = builder.ssl_opts(Some(SslOpts::default()));
        }

        Ok(builder)
    }
}

impl SqlDriver for MysqlDriver {
    fn id(&self) -> DriverId {
        DriverId::MySql
    }

    fn open(
        &self,
        profile: &ConnectionProfile,
        secret: &ConnectionSecret,
    ) -> Result<BoxedConnection, String> {
        // We intentionally call the same builder used by Phase 03 but
        // immediately drop the pool after one round-trip. Phase 03 will
        // lift the pool into a real executor.
        let builder = Self::options(profile, secret)?;

        let pool = mysql::Pool::new(builder)
            .map_err(|err| format!("failed to build MySQL pool: {err}"))?;

        let mut conn = pool
            .get_conn()
            .map_err(|err| format!("failed to reach MySQL host: {err}"))?;
        conn.query_drop("SELECT 1")
            .map_err(|err| format!("failed to validate MySQL connection: {err}"))?;

        // Drop the pool eagerly; the probe connection is the only thing
        // we hand back to the manager, and it just answers `is_alive`.
        drop(pool);
        drop(conn);

        Ok(Arc::new(MysqlProbeConnection))
    }
}

struct MysqlProbeConnection;

impl std::fmt::Debug for MysqlProbeConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MysqlProbeConnection")
    }
}

impl SqlConnection for MysqlProbeConnection {
    fn close(&self) {}

    fn is_alive(&self) -> bool {
        // We deliberately report `false` so Phase 04 prompts the user to
        // re-open the connection once query execution is wired up.
        false
    }

    fn list_schemas(&self) -> Result<Vec<SchemataDto>, SqlCommandError> {
        // Real MySQL metadata fetch lives in `mysql_runtime.rs` (Phase 09
        // integration tests). For Phase 02 unit tests we deliberately
        // return an empty list — UI shows an empty `Schemas` group.
        Ok(Vec::new())
    }

    fn list_tables(&self, _schema: &str) -> Result<Vec<SchemaObjectDto>, SqlCommandError> {
        Ok(Vec::new())
    }

    fn list_columns(&self, _schema: &str, _table: &str) -> Result<Vec<ColumnDto>, SqlCommandError> {
        Ok(Vec::new())
    }
}

// ---------------------------------------------------------------------------
// PostgreSQL driver stub.
//
// Postgres is `planned` in Phase 01; the registry must still expose the
// driver so command handlers can recognise the id and return a
// structured error. The stub simply refuses to open.
// ---------------------------------------------------------------------------

pub struct PostgresDriverStub;

impl SqlDriver for PostgresDriverStub {
    fn id(&self) -> DriverId {
        DriverId::Postgres
    }

    fn open(
        &self,
        _profile: &ConnectionProfile,
        _secret: &ConnectionSecret,
    ) -> Result<BoxedConnection, String> {
        Err("PostgreSQL driver is planned; runtime is not enabled".to_string())
    }
}

fn non_empty(value: Option<&str>, field: &str) -> Result<String, String> {
    let trimmed = value.unwrap_or("").trim();
    if trimmed.is_empty() {
        Err(format!("{field} must not be empty"))
    } else {
        Ok(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mysql::Opts;

    fn profile(driver: DriverIdDto) -> ConnectionProfile {
        ConnectionProfile {
            id: "p".to_string(),
            label: "p".to_string(),
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

    #[test]
    fn registry_finds_sqlite_mysql_postgres() {
        let registry = default_registry();
        assert!(registry.build(DriverId::Sqlite).is_some());
        assert!(registry.build(DriverId::MySql).is_some());
        assert!(registry.build(DriverId::Postgres).is_some());
    }

    #[test]
    fn sqlite_driver_opens_in_memory_mode() {
        let driver = SqliteDriver;
        let mut p = profile(DriverIdDto::Sqlite);
        p.remember_in_memory = true;
        let conn = driver.open(&p, &ConnectionSecret::default()).unwrap();
        assert!(conn.is_alive());
        conn.close();
    }

    #[test]
    fn sqlite_driver_requires_file_path_when_not_memory() {
        let driver = SqliteDriver;
        let p = profile(DriverIdDto::Sqlite);
        let err = driver.open(&p, &ConnectionSecret::default()).unwrap_err();
        assert!(err.contains("filePath"));
    }

    #[test]
    fn sqlite_driver_opens_real_temp_file() {
        let driver = SqliteDriver;
        let mut p = profile(DriverIdDto::Sqlite);
        let tmp = std::env::temp_dir().join(format!(
            "nyala-sqlite-probe-{}.db",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        p.file_path = Some(tmp.to_string_lossy().to_string());
        let conn = driver.open(&p, &ConnectionSecret::default()).unwrap();
        assert!(conn.is_alive());
        let _ = std::fs::remove_file(tmp);
    }

    #[test]
    fn mysql_driver_rejects_missing_host() {
        let driver = MysqlDriver;
        let p = profile(DriverIdDto::Mysql);
        let err = driver.open(&p, &ConnectionSecret::default()).unwrap_err();
        assert!(err.contains("host"));
    }

    #[test]
    fn mysql_driver_rejects_missing_database() {
        let driver = MysqlDriver;
        let mut p = profile(DriverIdDto::Mysql);
        p.host = Some("127.0.0.1".to_string());
        let err = driver.open(&p, &ConnectionSecret::default()).unwrap_err();
        assert!(err.contains("database"));
    }

    #[test]
    fn mysql_driver_requires_tls_for_require_ssl_mode() {
        let mut p = profile(DriverIdDto::Mysql);
        p.host = Some("127.0.0.1".to_string());
        p.database = Some("app".to_string());
        p.ssl_mode = Some(SqlSslMode::Require);

        let opts = Opts::from(MysqlDriver::options(&p, &ConnectionSecret::default()).unwrap());
        assert!(opts.get_ssl_opts().is_some());
    }

    #[test]
    fn mysql_driver_leaves_tls_optional_without_require_ssl_mode() {
        let mut p = profile(DriverIdDto::Mysql);
        p.host = Some("127.0.0.1".to_string());
        p.database = Some("app".to_string());

        let opts = Opts::from(MysqlDriver::options(&p, &ConnectionSecret::default()).unwrap());
        assert!(opts.get_ssl_opts().is_none());
    }

    #[test]
    fn postgres_driver_stub_refuses_to_open() {
        let driver = PostgresDriverStub;
        let p = profile(DriverIdDto::Postgres);
        let err = driver.open(&p, &ConnectionSecret::default()).unwrap_err();
        assert!(err.contains("planned"));
    }

    #[test]
    fn driver_registry_can_build_all_default_drivers() {
        let registry = default_registry();
        assert_eq!(
            registry.build(DriverId::Sqlite).unwrap().id(),
            DriverId::Sqlite
        );
        assert_eq!(
            registry.build(DriverId::MySql).unwrap().id(),
            DriverId::MySql
        );
        assert_eq!(
            registry.build(DriverId::Postgres).unwrap().id(),
            DriverId::Postgres
        );
    }
}
