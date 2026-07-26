/*---------------------------------------------------------------------------------------------
 * Nyala Studio - MySQL Preview opt-in validation (Phase 08).
 *--------------------------------------------------------------------------------------------*/

#![allow(clippy::needless_pass_by_value)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use mysql::prelude::Queryable;
use mysql::{Opts, Pool, SslOpts};
use serde::{Deserialize, Serialize};

use super::mysql_runtime::mysql_opts_builder;
use super::types::{ConnectionSecret, SqlCommandError, SqlSslMode};

#[cfg(test)]
use super::mysql_runtime::{MYSQL_IO_TIMEOUT, MYSQL_TCP_CONNECT_TIMEOUT};

pub const TABLE_PREFIX: &str = "nyala_validation_";

const ERR_INVALID_INPUT: &str = "invalid_input";
const ERR_CONNECTION_FAILED: &str = "connection_failed";
const ERR_DDL_FAILED: &str = "ddl_failed";
const ERR_INSERT_FAILED: &str = "insert_failed";
const ERR_SELECT_FAILED: &str = "select_failed";
const ERR_DROP_FAILED: &str = "drop_failed";
const CANCELLATION_WARNING: &str = "MySQL Preview: query cancellation is not supported yet.";

static NEXT_VALIDATION_ID: AtomicU64 = AtomicU64::new(1);

/// Transient `MySQL` settings supplied by the connection form. This DTO is never persisted.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MysqlPreviewValidationInputDto {
    pub host: Option<String>,
    pub port: Option<u32>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub ssl_mode: Option<SqlSslMode>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MysqlValidationReportDto {
    pub select_ok: bool,
    pub ddl_ok: bool,
    pub dropped_table: bool,
    pub elapsed_ms: u128,
    pub warnings: Vec<String>,
}

/// Validates the form values without saving the profile or secret in either connection store.
#[tauri::command]
pub async fn sql_validate_mysql_preview(
    input: MysqlPreviewValidationInputDto,
    secret: ConnectionSecret,
) -> Result<MysqlValidationReportDto, SqlCommandError> {
    tauri::async_runtime::spawn_blocking(move || validate_mysql_preview_inner(&input, &secret))
        .await
        .map_err(|_| {
            SqlCommandError::new(
                "internal",
                "MySQL validation task stopped before it could complete",
            )
        })?
}

fn validate_mysql_preview_inner(
    input: &MysqlPreviewValidationInputDto,
    secret: &ConnectionSecret,
) -> Result<MysqlValidationReportDto, SqlCommandError> {
    let opts = build_mysql_opts(input, secret)?;
    let started_at = Instant::now();
    let table = next_table_name();
    let pool = Pool::new(opts).map_err(|error| {
        SqlCommandError::new(
            ERR_CONNECTION_FAILED,
            format!("failed to create MySQL validation pool: {error}"),
        )
    })?;

    if let Err(error) = run_round_trip(&pool, &table) {
        return Err(match cleanup_table(&pool, &table) {
            Ok(()) => error,
            Err(cleanup_error) => cleanup_failure_error(error, &table, &cleanup_error),
        });
    }

    Ok(MysqlValidationReportDto {
        select_ok: true,
        ddl_ok: true,
        dropped_table: true,
        elapsed_ms: started_at.elapsed().as_millis(),
        warnings: vec![CANCELLATION_WARNING.to_string()],
    })
}

fn build_mysql_opts(
    input: &MysqlPreviewValidationInputDto,
    secret: &ConnectionSecret,
) -> Result<Opts, SqlCommandError> {
    let host = required(input.host.as_deref(), "host")?;
    let database = required(input.database.as_deref(), "database")?;
    let username = required(input.username.as_deref(), "username")?;
    let port = input
        .port
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            SqlCommandError::new(
                ERR_INVALID_INPUT,
                "port must be an integer between 1 and 65535",
            )
        })?;

    let mut builder = mysql_opts_builder()
        .ip_or_hostname(Some(host))
        .tcp_port(port)
        .db_name(Some(database))
        .user(Some(username));

    if let Some(password) = secret.password.as_deref() {
        builder = builder.pass(Some(password));
    }

    if matches!(input.ssl_mode, Some(SqlSslMode::Require)) {
        builder = builder.ssl_opts(Some(SslOpts::default()));
    }

    Ok(Opts::from(builder))
}

fn required<'a>(value: Option<&'a str>, field: &str) -> Result<&'a str, SqlCommandError> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            SqlCommandError::new(ERR_INVALID_INPUT, format!("{field} must not be empty"))
        })
}

fn next_table_name() -> String {
    let sequence = NEXT_VALIDATION_ID.fetch_add(1, Ordering::Relaxed);
    format!("{TABLE_PREFIX}{}_{sequence}", std::process::id())
}

fn run_round_trip(pool: &Pool, table: &str) -> Result<(), SqlCommandError> {
    let mut conn = pool.get_conn().map_err(|error| {
        SqlCommandError::new(
            ERR_CONNECTION_FAILED,
            format!("failed to connect to MySQL: {error}"),
        )
    })?;

    conn.query_drop("SELECT 1").map_err(|error| {
        SqlCommandError::new(
            ERR_CONNECTION_FAILED,
            format!("MySQL connection probe failed: {error}"),
        )
    })?;

    conn.query_drop(format!("CREATE TABLE `{table}` (id INTEGER PRIMARY KEY)"))
        .map_err(|error| SqlCommandError::new(ERR_DDL_FAILED, error.to_string()))?;

    conn.query_drop(format!("INSERT INTO `{table}` (id) VALUES (1)"))
        .map_err(|error| SqlCommandError::new(ERR_INSERT_FAILED, error.to_string()))?;

    let selected = conn
        .query_first::<u64, _>(format!("SELECT id FROM `{table}`"))
        .map_err(|error| SqlCommandError::new(ERR_SELECT_FAILED, error.to_string()))?;
    if selected != Some(1) {
        return Err(SqlCommandError::new(
            ERR_SELECT_FAILED,
            "validation row did not round-trip",
        ));
    }

    conn.query_drop(format!("DROP TABLE `{table}`"))
        .map_err(|error| SqlCommandError::new(ERR_DROP_FAILED, error.to_string()))?;

    Ok(())
}

fn cleanup_table(pool: &Pool, table: &str) -> Result<(), String> {
    let mut conn = pool.get_conn().map_err(|error| error.to_string())?;
    conn.query_drop(format!("DROP TABLE IF EXISTS `{table}`"))
        .map_err(|error| error.to_string())
}

fn cleanup_failure_error(
    error: SqlCommandError,
    table: &str,
    cleanup_error: &str,
) -> SqlCommandError {
    error.append_message(format!(
        "; automatic cleanup of temporary table `{table}` also failed: {cleanup_error}. The table may remain and should be removed manually."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_input() -> MysqlPreviewValidationInputDto {
        MysqlPreviewValidationInputDto {
            host: Some("127.0.0.1".to_string()),
            port: Some(3306),
            database: Some("nyala".to_string()),
            username: Some("root".to_string()),
            ssl_mode: Some(SqlSslMode::Prefer),
        }
    }

    #[test]
    fn validation_rejects_empty_required_fields_before_networking() {
        for (field, input) in [
            (
                "host",
                MysqlPreviewValidationInputDto {
                    host: Some("  ".to_string()),
                    ..valid_input()
                },
            ),
            (
                "database",
                MysqlPreviewValidationInputDto {
                    database: None,
                    ..valid_input()
                },
            ),
            (
                "username",
                MysqlPreviewValidationInputDto {
                    username: Some(String::new()),
                    ..valid_input()
                },
            ),
        ] {
            let error = build_mysql_opts(&input, &ConnectionSecret::default())
                .expect_err("invalid input must fail before opening a pool");
            assert!(matches!(error, SqlCommandError::InvalidInput { .. }));
            assert!(error.to_string().contains(field));
        }
    }

    #[test]
    fn validation_rejects_invalid_ports_before_networking() {
        for port in [None, Some(0), Some(65_536)] {
            let input = MysqlPreviewValidationInputDto {
                port,
                ..valid_input()
            };
            let error = build_mysql_opts(&input, &ConnectionSecret::default())
                .expect_err("invalid port must fail before opening a pool");
            assert!(matches!(error, SqlCommandError::InvalidInput { .. }));
        }
    }

    #[test]
    fn require_ssl_mode_enables_tls() {
        let input = MysqlPreviewValidationInputDto {
            ssl_mode: Some(SqlSslMode::Require),
            ..valid_input()
        };

        let opts = build_mysql_opts(&input, &ConnectionSecret::default()).expect("valid options");

        assert!(opts.get_ssl_opts().is_some());
    }

    #[test]
    fn prefer_ssl_mode_matches_existing_mysql_runtime_behavior() {
        let opts =
            build_mysql_opts(&valid_input(), &ConnectionSecret::default()).expect("valid options");

        assert!(opts.get_ssl_opts().is_none());
    }

    #[test]
    fn validation_options_use_the_shared_network_timeouts() {
        let opts =
            build_mysql_opts(&valid_input(), &ConnectionSecret::default()).expect("valid options");

        assert_eq!(
            opts.get_tcp_connect_timeout(),
            Some(MYSQL_TCP_CONNECT_TIMEOUT)
        );
        assert_eq!(opts.get_read_timeout().copied(), Some(MYSQL_IO_TIMEOUT));
        assert_eq!(opts.get_write_timeout().copied(), Some(MYSQL_IO_TIMEOUT));
    }

    #[test]
    fn validation_command_rejects_invalid_input_from_the_blocking_worker() {
        let input = MysqlPreviewValidationInputDto {
            host: None,
            ..valid_input()
        };

        let error = tauri::async_runtime::block_on(sql_validate_mysql_preview(
            input,
            ConnectionSecret::default(),
        ))
        .expect_err("missing host must fail before networking");

        assert!(matches!(error, SqlCommandError::InvalidInput { .. }));
    }

    #[test]
    fn validation_table_names_are_unique_within_the_process() {
        let first = next_table_name();
        let second = next_table_name();

        assert_ne!(first, second);
        assert!(first.starts_with(TABLE_PREFIX));
        assert!(first.contains(&format!("{}_", std::process::id())));
    }

    #[test]
    fn cleanup_failure_keeps_the_original_error_code_and_names_the_table() {
        let error = cleanup_failure_error(
            SqlCommandError::new(ERR_INSERT_FAILED, "insert denied"),
            "nyala_validation_1_1",
            "drop denied",
        );

        assert!(matches!(error, SqlCommandError::InsertFailed { .. }));
        assert!(error.to_string().contains("nyala_validation_1_1"));
        assert!(error.to_string().contains("may remain"));
    }

    #[test]
    #[ignore = "requires NYALA_TEST_MYSQL_HOST, DATABASE, and USERNAME"]
    fn mysql_preview_validation_live_contract() -> Result<(), String> {
        let host = required_live_env("NYALA_TEST_MYSQL_HOST")?;
        let database = required_live_env("NYALA_TEST_MYSQL_DATABASE")?;
        let username = required_live_env("NYALA_TEST_MYSQL_USERNAME")?;
        let port = std::env::var("NYALA_TEST_MYSQL_PORT")
            .ok()
            .map(|value| {
                value
                    .parse::<u32>()
                    .map_err(|error| format!("invalid NYALA_TEST_MYSQL_PORT: {error}"))
            })
            .transpose()?
            .unwrap_or(3306);

        let report = tauri::async_runtime::block_on(sql_validate_mysql_preview(
            MysqlPreviewValidationInputDto {
                host: Some(host),
                port: Some(port),
                database: Some(database),
                username: Some(username),
                ssl_mode: Some(SqlSslMode::Prefer),
            },
            ConnectionSecret {
                password: std::env::var("NYALA_TEST_MYSQL_PASSWORD").ok(),
            },
        ))
        .map_err(|error| format!("MySQL Preview validation command failed: {error}"))?;

        if !report.select_ok {
            return Err(
                "MySQL Preview report did not confirm SELECT 1 and row round-trip SELECT"
                    .to_string(),
            );
        }
        if !report.ddl_ok {
            return Err(
                "MySQL Preview report did not confirm CREATE and INSERT validation stages"
                    .to_string(),
            );
        }
        if !report.dropped_table {
            return Err(
                "MySQL Preview report did not confirm the DROP validation stage".to_string(),
            );
        }
        if !report
            .warnings
            .iter()
            .any(|warning| warning.contains("query cancellation is not supported"))
        {
            return Err(
                "MySQL Preview validation did not report the cancellation warning".to_string(),
            );
        }

        Ok(())
    }

    fn required_live_env(name: &str) -> Result<String, String> {
        std::env::var(name)
            .map(|value| value.trim().to_string())
            .map_err(|_| format!("{name} must be set for the ignored MySQL integration test"))
            .and_then(|value| {
                if value.is_empty() {
                    Err(format!("{name} must not be empty"))
                } else {
                    Ok(value)
                }
            })
    }
}
