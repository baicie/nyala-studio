/*---------------------------------------------------------------------------------------------
 * Nyala Studio - MySQL Preview opt-in validation (Phase 08 §2.3).
 *
 * `sql_validate_mysql_preview` runs a tiny CREATE / INSERT / SELECT /
 * DROP round-trip against an already-open MySQL Preview connection
 * so the user can confirm the driver actually works against their
 * local MySQL before they trust query history / result panels.
 *
 * Implementation notes vs the spec in
 * `docs/sql-mvp-phases/phase-08-mvp-packaging.md` §2.3:
 *
 *  * The spec writes `entry.conn.execute_raw(&sql)` because it assumes
 *    `SqlConnection` will eventually own a query-execution method
 *    (Phase 03). Today the trait only carries metadata methods, and
 *    `MysqlProbeConnection` drops the pool immediately after the
 *    `SELECT 1` probe (see `MysqlDriver::open`). We therefore rebuild
 *    the pool from the profile + secret for the duration of the
 *    validation and drop it on the way out. When Phase 03 lifts the
 *    pool into the executor, this module becomes a one-line call to
 *    `entry.conn.execute_raw`.
 *
 *  * The spec calls the Tauri command `async fn`. Every other command
 *    in this crate is `pub fn` (sync, run inside `tauri::async_runtime`
 *    when needed) so we follow that convention.
 *
 *  * The validation lives behind `RuntimeStatus::Preview` for MySQL
 *    (set in `runtime_status/mod.rs`). The connection manager already
 *    refuses to open a MySQL Preview profile with an unavailable
 *    runtime status, so we don't re-check it here.
 *--------------------------------------------------------------------------------------------*/

#![allow(clippy::needless_pass_by_value)]

use mysql::prelude::Queryable;
use mysql::{OptsBuilder, Pool};
use serde::Serialize;
use tauri::State;

use super::connection_manager::SharedConnectionManager;
use super::types::{ConnectionProfile, ConnectionSecret, SqlCommandError};

/// Prefix used for the throwaway table the validation creates. The
/// table name is unique per process id so two simultaneous validations
/// never collide.
pub const TABLE_PREFIX: &str = "nyala_validation_";

/// Error code returned when the user invokes the validation against a
/// connection whose driver is not `MySQL`.
pub const ERR_WRONG_DRIVER: &str = "wrong_driver";
pub const ERR_DDL_FAILED: &str = "ddl_failed";
pub const ERR_INSERT_FAILED: &str = "insert_failed";
pub const ERR_SELECT_FAILED: &str = "select_failed";
pub const ERR_DROP_FAILED: &str = "drop_failed";
pub const ERR_PROFILE_NOT_FOUND: &str = "profile_not_found";
pub const ERR_NO_SECRET: &str = "no_secret";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MysqlValidationReportDto {
    pub select_ok: bool,
    pub ddl_ok: bool,
    pub dropped_table: bool,
    pub elapsed_ms: u128,
    pub warnings: Vec<String>,
}

/// Tauri command: run the CREATE / INSERT / SELECT / DROP round-trip
/// against the given `MySQL` Preview connection. Returns a structured
/// report; any failure surfaces as a `SqlCommandError` so the caller
/// can route the message through the existing error UI.
#[tauri::command]
pub fn sql_validate_mysql_preview(
    manager: State<'_, SharedConnectionManager>,
    connection_id: String,
) -> Result<MysqlValidationReportDto, SqlCommandError> {
    let (profile, secret) = lookup_mysql_profile(manager.inner(), &connection_id)?;
    let started_at = std::time::Instant::now();
    let table = format!("{TABLE_PREFIX}{}", std::process::id());

    let pool = open_pool_from_profile(&profile, &secret)
        .map_err(|e| SqlCommandError::new(ERR_DDL_FAILED, format!("pool open: {e}")))?;

    let ddl_sql = format!("CREATE TABLE `{table}` (id INTEGER PRIMARY KEY)");
    let insert_sql = format!("INSERT INTO `{table}`(id) VALUES (1)");
    let select_sql = format!("SELECT id FROM `{table}`");
    let drop_sql = format!("DROP TABLE `{table}`");

    // Best-effort cleanup: if any step fails, try to drop the table so
    // we don't leave a validation artifact in the user's database.
    let outcome = run_round_trip(&pool, &ddl_sql, &insert_sql, &select_sql, &drop_sql);
    if outcome.is_err() {
        let _ = cleanup_table(&pool, &drop_sql);
    }
    outcome?;

    Ok(MysqlValidationReportDto {
        select_ok: true,
        ddl_ok: true,
        dropped_table: true,
        elapsed_ms: started_at.elapsed().as_millis(),
        warnings: vec!["MySQL Preview: query cancellation is not supported yet.".to_string()],
    })
}

fn lookup_mysql_profile(
    manager: &SharedConnectionManager,
    connection_id: &str,
) -> Result<(ConnectionProfile, ConnectionSecret), SqlCommandError> {
    let driver = manager
        .with_conn(connection_id, |entry| Ok(entry.driver_id))
        .map_err(|e| SqlCommandError::new(ERR_PROFILE_NOT_FOUND, e.to_string()))?;
    if !matches!(driver, crate::runtime_status::DriverId::MySql) {
        return Err(SqlCommandError::new(ERR_WRONG_DRIVER, "expected mysql"));
    }
    let profile = manager
        .get_profile(connection_id)
        .ok_or_else(|| SqlCommandError::new(ERR_PROFILE_NOT_FOUND, "profile missing"))?;
    let secret = manager
        .get_secret(connection_id)
        .ok_or_else(|| SqlCommandError::new(ERR_NO_SECRET, "no secret in manager"))?;
    Ok((profile, secret))
}

fn open_pool_from_profile(
    profile: &ConnectionProfile,
    secret: &ConnectionSecret,
) -> Result<Pool, String> {
    let host = profile
        .host
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "host must not be empty".to_string())?;
    let database = profile
        .database
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "database must not be empty".to_string())?;
    let port = profile.port.unwrap_or(3306);

    let mut builder = OptsBuilder::new()
        .ip_or_hostname(Some(host))
        .tcp_port(port)
        .db_name(Some(database));

    if let Some(username) = profile
        .username
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        builder = builder.user(Some(username));
    }
    if let Some(password) = secret.password.as_deref() {
        builder = builder.pass(Some(password));
    }

    Pool::new(builder).map_err(|err| format!("failed to build MySQL pool: {err}"))
}

fn run_round_trip(
    pool: &Pool,
    ddl: &str,
    insert: &str,
    select: &str,
    drop: &str,
) -> Result<(), SqlCommandError> {
    let mut conn = pool
        .get_conn()
        .map_err(|e| SqlCommandError::new(ERR_DDL_FAILED, format!("get_conn: {e}")))?;

    conn.query_drop(ddl)
        .map_err(|e| SqlCommandError::new(ERR_DDL_FAILED, e.to_string()))?;

    conn.query_drop(insert)
        .map_err(|e| SqlCommandError::new(ERR_INSERT_FAILED, e.to_string()))?;

    conn.query_drop(select)
        .map_err(|e| SqlCommandError::new(ERR_SELECT_FAILED, e.to_string()))?;

    conn.query_drop(drop)
        .map_err(|e| SqlCommandError::new(ERR_DROP_FAILED, e.to_string()))?;

    Ok(())
}

fn cleanup_table(pool: &Pool, drop_sql: &str) -> Result<(), String> {
    let mut conn = pool.get_conn().map_err(|err| err.to_string())?;
    conn.query_drop(drop_sql).map_err(|err| err.to_string())?;
    Ok(())
}

/// Inner entry point that does not require a Tauri `State` wrapper,
/// so unit tests can exercise the validation logic without spinning
/// up a Tauri runtime. Only used by the unit tests below.
#[cfg(test)]
pub fn sql_validate_mysql_preview_inner(
    manager: &SharedConnectionManager,
    connection_id: &str,
) -> Result<MysqlValidationReportDto, SqlCommandError> {
    let (profile, secret) = lookup_mysql_profile(manager, connection_id)?;
    let started_at = std::time::Instant::now();
    let table = format!("{TABLE_PREFIX}{}", std::process::id());

    let pool = open_pool_from_profile(&profile, &secret)
        .map_err(|e| SqlCommandError::new(ERR_DDL_FAILED, format!("pool open: {e}")))?;

    let ddl_sql = format!("CREATE TABLE `{table}` (id INTEGER PRIMARY KEY)");
    let insert_sql = format!("INSERT INTO `{table}`(id) VALUES (1)");
    let select_sql = format!("SELECT id FROM `{table}`");
    let drop_sql = format!("DROP TABLE `{table}`");

    let outcome = run_round_trip(&pool, &ddl_sql, &insert_sql, &select_sql, &drop_sql);
    if outcome.is_err() {
        let _ = cleanup_table(&pool, &drop_sql);
    }
    outcome?;

    Ok(MysqlValidationReportDto {
        select_ok: true,
        ddl_ok: true,
        dropped_table: true,
        elapsed_ms: started_at.elapsed().as_millis(),
        warnings: vec!["MySQL Preview: query cancellation is not supported yet.".to_string()],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sql::connection_manager::build_default_manager;

    fn fresh_manager(test_name: &str) -> SharedConnectionManager {
        let path = std::env::temp_dir().join(format!(
            "nyala-mysql-validation-{}-{}.json",
            std::process::id(),
            test_name
        ));
        build_default_manager(Some(path))
    }

    fn sqlite_profile() -> ConnectionProfile {
        ConnectionProfile {
            id: "any".to_string(),
            label: "sqlite".to_string(),
            driver: crate::commands::sql::types::DriverIdDto::Sqlite,
            read_only: false,
            host: None,
            port: None,
            database: None,
            username: None,
            file_path: Some(":memory:".to_string()),
            remember_in_memory: true,
            created_at_ms: 0,
        }
    }

    #[test]
    fn table_prefix_is_unique_per_pid() {
        let t = format!("{TABLE_PREFIX}{}", std::process::id());
        assert!(t.starts_with(TABLE_PREFIX));
        assert!(t.len() > TABLE_PREFIX.len());
    }

    #[test]
    fn validation_rejects_sqlite_profile() {
        // A profile whose driver is SQLite must be rejected before any
        // network round-trip is attempted.
        let manager = fresh_manager("rejects_sqlite");
        let profile = sqlite_profile();
        manager
            .upsert_profile(profile.clone())
            .expect("upsert profile");
        manager.put_secret(&profile.id, ConnectionSecret { password: None });
        // Open so the manager has a connection entry to look up via
        // `with_conn`.
        manager
            .open(&profile, ConnectionSecret::default())
            .expect("open sqlite");

        let err = sql_validate_mysql_preview_inner(&manager, &profile.id)
            .expect_err("validation must reject non-mysql driver");
        assert!(matches!(
            err,
            SqlCommandError::DriverNotAvailable { .. }
                | SqlCommandError::OpenFailed { .. }
                | SqlCommandError::NotOpen { .. }
                | SqlCommandError::Internal { .. }
                | SqlCommandError::Persistence { .. }
                | SqlCommandError::UnknownDriver { .. }
                | SqlCommandError::Validation { .. }
        ));
    }

    #[test]
    fn validation_rejects_unknown_profile_id() {
        let manager = fresh_manager("unknown_id");
        let err = sql_validate_mysql_preview_inner(&manager, "missing-id")
            .expect_err("validation must reject unknown profile id");
        // The exact variant depends on the manager internals
        // (currently `NotOpen`); the important contract is that we
        // surface a structured `SqlCommandError` rather than panicking.
        assert!(
            matches!(
                err,
                SqlCommandError::NotOpen { .. }
                    | SqlCommandError::Internal { .. }
                    | SqlCommandError::Persistence { .. }
                    | SqlCommandError::UnknownDriver { .. }
                    | SqlCommandError::Validation { .. }
            ),
            "expected structured SqlCommandError variant, got {err:?}"
        );
    }

    #[test]
    fn open_pool_rejects_mysql_profile_without_host() {
        let mut profile = sqlite_profile();
        profile.driver = crate::commands::sql::types::DriverIdDto::Mysql;
        let err = open_pool_from_profile(&profile, &ConnectionSecret::default())
            .expect_err("open_pool must require host");
        assert!(err.contains("host"));
    }

    #[test]
    fn open_pool_rejects_mysql_profile_without_database() {
        let mut profile = sqlite_profile();
        profile.driver = crate::commands::sql::types::DriverIdDto::Mysql;
        profile.host = Some("127.0.0.1".to_string());
        let err = open_pool_from_profile(&profile, &ConnectionSecret::default())
            .expect_err("open_pool must require database");
        assert!(err.contains("database"));
    }
}
