use super::types::{
    SqlCellValue, SqlColumn, SqlConnectionInput, SqlDatabase, SqlQueryResult, SqlResultColumn,
    SqlSslMode, SqlTable, SqlTableType, MAX_QUERY_ROW_LIMIT,
};
use mysql::prelude::Queryable;
use mysql::{OptsBuilder, Pool, PooledConn, Row, SslOpts, Value};
use std::time::Instant;

pub fn open_mysql_pool(input: &SqlConnectionInput) -> Result<Pool, String> {
    let host = required(input.host.as_deref(), "host")?;
    let database = required(input.database.as_deref(), "database")?;
    let port = input.port.unwrap_or(3306);
    let username = optional(input.username.as_deref());
    let password = optional(input.password.as_deref());

    let mut builder = OptsBuilder::new()
        .ip_or_hostname(Some(host))
        .tcp_port(port)
        .db_name(Some(database));

    if let Some(username) = username {
        builder = builder.user(Some(username));
    }

    if let Some(password) = password {
        builder = builder.pass(Some(password));
    }

    if matches!(input.ssl_mode, Some(SqlSslMode::Require)) {
        builder = builder.ssl_opts(Some(SslOpts::default()));
    }

    Pool::new(builder).map_err(|err| format!("failed to create MySQL pool: {err}"))
}

pub fn test_mysql_connection(pool: &Pool) -> Result<(), String> {
    let mut conn = pool
        .get_conn()
        .map_err(|err| format!("failed to get MySQL connection: {err}"))?;

    conn.query_drop("SELECT 1")
        .map_err(|err| format!("failed to validate MySQL connection: {err}"))
}

pub fn list_mysql_databases(pool: &Pool) -> Result<Vec<SqlDatabase>, String> {
    let mut conn = pooled(pool)?;

    conn.query_map("SHOW DATABASES", |name: String| SqlDatabase { name })
        .map_err(|err| format!("failed to list MySQL databases: {err}"))
}

pub fn list_mysql_tables(pool: &Pool, database: Option<&str>) -> Result<Vec<SqlTable>, String> {
    let mut conn = pooled(pool)?;
    let database = match database {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => conn
            .query_first::<String, _>("SELECT DATABASE()")
            .map_err(|err| format!("failed to read current MySQL database: {err}"))?
            .ok_or_else(|| "MySQL connection has no selected database".to_string())?,
    };

    let rows: Vec<(String, String, String)> = conn
        .exec(
            "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
             FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = ?
             ORDER BY TABLE_TYPE, TABLE_NAME",
            (database,),
        )
        .map_err(|err| format!("failed to list MySQL tables: {err}"))?;

    Ok(rows
        .into_iter()
        .map(|(schema, name, raw_type)| SqlTable {
            schema: Some(schema),
            name,
            table_type: if raw_type.eq_ignore_ascii_case("VIEW") {
                SqlTableType::View
            } else {
                SqlTableType::Table
            },
        })
        .collect())
}

type MySqlColumnRow = (
    u64,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
);

pub fn list_mysql_columns(
    pool: &Pool,
    schema: Option<&str>,
    table_name: &str,
) -> Result<Vec<SqlColumn>, String> {
    let mut conn = pooled(pool)?;
    let schema = match schema {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => conn
            .query_first::<String, _>("SELECT DATABASE()")
            .map_err(|err| format!("failed to read current MySQL database: {err}"))?
            .ok_or_else(|| "MySQL connection has no selected database".to_string())?,
    };

    let rows: Vec<MySqlColumnRow> = conn
        .exec(
            "SELECT ORDINAL_POSITION, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT
             FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = ?
               AND TABLE_NAME = ?
             ORDER BY ORDINAL_POSITION",
            (schema, table_name.trim()),
        )
        .map_err(|err| format!("failed to list MySQL columns: {err}"))?;

    Ok(rows
        .into_iter()
        .map(
            |(ordinal, name, data_type, nullable, column_key, default_value)| SqlColumn {
                name,
                ordinal: i64::try_from(ordinal.saturating_sub(1)).unwrap_or(i64::MAX),
                data_type,
                not_null: nullable.eq_ignore_ascii_case("NO"),
                primary_key: column_key.as_deref() == Some("PRI"),
                default_value,
            },
        )
        .collect())
}

pub fn execute_mysql_query(pool: &Pool, sql: &str, limit: usize) -> Result<SqlQueryResult, String> {
    let mut conn = pooled(pool)?;
    let sql = sql.trim();

    if is_mysql_select_like(sql) {
        execute_mysql_select(&mut conn, sql, limit)
    } else {
        let started_at = Instant::now();

        conn.query_drop(sql)
            .map_err(|err| format!("failed to execute MySQL statement: {err}"))?;

        Ok(SqlQueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows: Some(usize::try_from(conn.affected_rows()).unwrap_or(usize::MAX)),
            row_count: 0,
            elapsed_ms: elapsed_ms(started_at),
            truncated: false,
        })
    }
}

fn execute_mysql_select(
    conn: &mut PooledConn,
    sql: &str,
    limit: usize,
) -> Result<SqlQueryResult, String> {
    let started_at = Instant::now();
    let limit = limit.min(MAX_QUERY_ROW_LIMIT);
    let mut result = conn
        .query_iter(sql)
        .map_err(|err| format!("failed to execute MySQL query: {err}"))?;

    let columns = result
        .columns()
        .as_ref()
        .iter()
        .enumerate()
        .map(|(index, column)| SqlResultColumn {
            name: column.name_str().into_owned(),
            ordinal: index,
        })
        .collect::<Vec<_>>();

    let mut rows = Vec::new();
    let mut truncated = false;

    #[allow(clippy::while_let_on_iterator)]
    while let Some(row) = result.next() {
        let row = row.map_err(|err| format!("failed to read MySQL row: {err}"))?;

        if rows.len() >= limit {
            truncated = true;
            break;
        }

        rows.push(row_to_cells(row));
    }

    Ok(SqlQueryResult {
        columns,
        row_count: rows.len(),
        rows,
        affected_rows: None,
        elapsed_ms: elapsed_ms(started_at),
        truncated,
    })
}

fn row_to_cells(row: Row) -> Vec<SqlCellValue> {
    row.unwrap().into_iter().map(mysql_value_to_cell).collect()
}

pub fn mysql_value_to_cell(value: Value) -> SqlCellValue {
    match value {
        Value::NULL => SqlCellValue::null(),
        Value::Bytes(bytes) => {
            if let Ok(text) = String::from_utf8(bytes.clone()) {
                SqlCellValue::text(text)
            } else {
                use base64::{engine::general_purpose, Engine as _};
                SqlCellValue::blob(general_purpose::STANDARD.encode(&bytes), bytes.len())
            }
        }
        Value::Int(value) => SqlCellValue::integer(value),
        Value::UInt(value) => {
            let signed = i64::try_from(value).unwrap_or(i64::MAX);
            SqlCellValue::integer(signed)
        }
        Value::Float(value) => SqlCellValue::real(f64::from(value)),
        Value::Double(value) => SqlCellValue::real(value),
        Value::Date(year, month, day, hour, minute, second, micros) => SqlCellValue::text(format!(
            "{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}.{micros:06}"
        )),
        Value::Time(is_negative, days, hours, minutes, seconds, micros) => {
            let sign = if is_negative { "-" } else { "" };
            SqlCellValue::text(format!(
                "{sign}{days} {hours:02}:{minutes:02}:{seconds:02}.{micros:06}"
            ))
        }
    }
}

fn pooled(pool: &Pool) -> Result<PooledConn, String> {
    pool.get_conn()
        .map_err(|err| format!("failed to get MySQL connection: {err}"))
}

fn is_mysql_select_like(sql: &str) -> bool {
    matches!(
        first_sql_keyword(sql).as_deref(),
        Some("select" | "show" | "describe" | "desc" | "explain" | "with")
    )
}

fn first_sql_keyword(sql: &str) -> Option<String> {
    let trimmed = sql.trim_start();
    let keyword = trimmed
        .split(|ch: char| !ch.is_ascii_alphabetic() && ch != '_')
        .next()?
        .to_ascii_lowercase();

    if keyword.is_empty() {
        None
    } else {
        Some(keyword)
    }
}

fn required(value: Option<&str>, field: &str) -> Result<String, String> {
    let value = value.unwrap_or("").trim();

    if value.is_empty() {
        return Err(format!("{field} must not be empty"));
    }

    Ok(value.to_string())
}

fn optional(value: Option<&str>) -> Option<String> {
    let value = value?.trim();

    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn elapsed_ms(started_at: Instant) -> u64 {
    u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mysql::Value;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn mysql_value_to_cell_handles_null() {
        assert_eq!(mysql_value_to_cell(Value::NULL), SqlCellValue::null());
    }

    #[test]
    fn mysql_value_to_cell_handles_text() {
        assert_eq!(
            mysql_value_to_cell(Value::Bytes(b"hello".to_vec())),
            SqlCellValue::text("hello")
        );
    }

    #[test]
    fn mysql_value_to_cell_handles_int() {
        assert_eq!(
            mysql_value_to_cell(Value::Int(42)),
            SqlCellValue::integer(42)
        );
    }

    #[test]
    fn mysql_value_to_cell_handles_uint_overflow() {
        assert_eq!(
            mysql_value_to_cell(Value::UInt(u64::MAX)),
            SqlCellValue::integer(i64::MAX)
        );
    }

    #[test]
    fn mysql_select_like_detects_show() {
        assert!(is_mysql_select_like("SHOW DATABASES"));
        assert!(is_mysql_select_like("describe users"));
        assert!(!is_mysql_select_like("insert into users values (1)"));
    }

    #[test]
    #[ignore = "requires NYALA_TEST_MYSQL_HOST and NYALA_TEST_MYSQL_DATABASE"]
    fn mysql_live_preview_flow() -> Result<(), String> {
        let host = required_test_env("NYALA_TEST_MYSQL_HOST")?;
        let database = required_test_env("NYALA_TEST_MYSQL_DATABASE")?;
        let port = std::env::var("NYALA_TEST_MYSQL_PORT")
            .ok()
            .map(|value| {
                value
                    .parse::<u16>()
                    .map_err(|err| format!("invalid NYALA_TEST_MYSQL_PORT: {err}"))
            })
            .transpose()?
            .unwrap_or(3306);

        let input = SqlConnectionInput {
            id: Some("nyala-mysql-integration".to_string()),
            name: Some("Nyala MySQL Integration".to_string()),
            kind: super::super::types::SqlConnectionKind::MySql,
            database_path: None,
            host: Some(host),
            port: Some(port),
            database: Some(database.clone()),
            username: std::env::var("NYALA_TEST_MYSQL_USERNAME").ok(),
            password: std::env::var("NYALA_TEST_MYSQL_PASSWORD").ok(),
            ssl_mode: Some(SqlSslMode::Prefer),
            read_only: false,
            create_if_missing: false,
        };

        let pool = open_mysql_pool(&input)?;
        test_mysql_connection(&pool)?;

        let databases = list_mysql_databases(&pool)?;
        if !databases.iter().any(|item| item.name == database) {
            return Err(format!("configured database '{database}' was not listed"));
        }

        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|err| format!("system clock error: {err}"))?
            .as_millis();
        let table_name = format!("nyala_integration_{suffix}");
        let create_sql = format!(
            "CREATE TABLE `{table_name}` (id BIGINT PRIMARY KEY, name VARCHAR(64) NOT NULL)"
        );
        let drop_sql = format!("DROP TABLE IF EXISTS `{table_name}`");

        execute_mysql_query(&pool, &create_sql, 100)?;

        let verification = (|| -> Result<(), String> {
            let tables = list_mysql_tables(&pool, Some(&database))?;
            if !tables.iter().any(|table| table.name == table_name) {
                return Err(format!("integration table '{table_name}' was not listed"));
            }

            let columns = list_mysql_columns(&pool, Some(&database), &table_name)?;
            if columns.len() != 2 || columns[0].name != "id" || columns[1].name != "name" {
                return Err(format!("unexpected integration columns: {columns:?}"));
            }

            let result = execute_mysql_query(&pool, "SELECT 1 AS value", 100)?;
            if result.row_count != 1
                || result.columns.first().map(|column| column.name.as_str()) != Some("value")
            {
                return Err(format!("unexpected SELECT 1 result: {result:?}"));
            }

            Ok(())
        })();

        let cleanup = execute_mysql_query(&pool, &drop_sql, 100).map(|_| ());
        verification?;
        cleanup
    }

    fn required_test_env(name: &str) -> Result<String, String> {
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
