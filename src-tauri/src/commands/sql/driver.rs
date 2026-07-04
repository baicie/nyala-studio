use super::types::{SqlConnection, SqlConnectionInput, SqlConnectionKind, SqlSslMode};
use crate::runtime_status::{self, DriverId, DriverRuntimeEntry, RuntimeStatus};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SqlDriverAvailability {
    Stable,
    Preview,
    Planned,
    Disabled,
}

impl SqlDriverAvailability {
    pub fn from_runtime_status(status: RuntimeStatus) -> Self {
        match status {
            RuntimeStatus::Stable => SqlDriverAvailability::Stable,
            RuntimeStatus::Preview => SqlDriverAvailability::Preview,
            RuntimeStatus::Planned => SqlDriverAvailability::Planned,
            RuntimeStatus::Disabled => SqlDriverAvailability::Disabled,
        }
    }

    #[allow(dead_code)]
    pub fn as_token(&self) -> &'static str {
        match self {
            SqlDriverAvailability::Stable => "stable",
            SqlDriverAvailability::Preview => "preview",
            SqlDriverAvailability::Planned => "planned",
            SqlDriverAvailability::Disabled => "disabled",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlDriverDescriptor {
    pub kind: SqlConnectionKind,
    pub label: &'static str,
    pub availability: SqlDriverAvailability,
    pub runtime_status: RuntimeStatus,
    pub default_port: Option<u16>,
    pub file_based: bool,
    pub remote: bool,
}

/// Build a driver descriptor backed by the runtime-status truth-of-record.
fn build_descriptor_from_runtime(
    runtime_entry: &DriverRuntimeEntry,
    kind: SqlConnectionKind,
    default_port: Option<u16>,
    file_based: bool,
    remote: bool,
) -> SqlDriverDescriptor {
    SqlDriverDescriptor {
        kind,
        label: runtime_entry.display_name,
        availability: SqlDriverAvailability::from_runtime_status(runtime_entry.status),
        runtime_status: runtime_entry.status,
        default_port,
        file_based,
        remote,
    }
}

pub fn sql_driver_catalog() -> Vec<SqlDriverDescriptor> {
    let sqlite_entry = runtime_status::lookup(DriverId::Sqlite)
        .expect("sqlite must be present in runtime status table");
    let mysql_entry = runtime_status::lookup(DriverId::MySql)
        .expect("mysql must be present in runtime status table");
    let postgres_entry = runtime_status::lookup(DriverId::Postgres)
        .expect("postgres must be present in runtime status table");

    vec![
        build_descriptor_from_runtime(sqlite_entry, SqlConnectionKind::Sqlite, None, true, false),
        // MySQL is intentionally PREVIEW per Phase 00; this matches the README
        // runtime status table and is enforced by `verify-sql-runtime-status.mjs`.
        build_descriptor_from_runtime(
            mysql_entry,
            SqlConnectionKind::MySql,
            Some(3306),
            false,
            true,
        ),
        // PostgreSQL stays PLANNED per Phase 00; no runtime driver is wired yet.
        build_descriptor_from_runtime(
            postgres_entry,
            SqlConnectionKind::PostgreSql,
            Some(5432),
            false,
            true,
        ),
    ]
}

pub fn get_driver_descriptor(kind: &SqlConnectionKind) -> SqlDriverDescriptor {
    sql_driver_catalog()
        .into_iter()
        .find(|driver| &driver.kind == kind)
        .expect("all SqlConnectionKind variants must be in driver catalog")
}

pub fn ensure_driver_enabled(kind: &SqlConnectionKind) -> Result<(), String> {
    let descriptor = get_driver_descriptor(kind);

    match descriptor.availability {
        SqlDriverAvailability::Stable | SqlDriverAvailability::Preview => Ok(()),
        SqlDriverAvailability::Planned => Err(format!(
            "SQL driver '{}' is planned and is not enabled yet",
            descriptor.label
        )),
        SqlDriverAvailability::Disabled => Err(format!(
            "SQL driver '{}' is disabled in this build",
            descriptor.label
        )),
    }
}

pub fn normalize_connection_input(input: &SqlConnectionInput) -> Result<SqlConnection, String> {
    ensure_driver_enabled(&input.kind)?;

    match input.kind {
        SqlConnectionKind::Sqlite => normalize_sqlite_connection_input(input),
        SqlConnectionKind::MySql => normalize_network_connection_input(input),
        SqlConnectionKind::PostgreSql => {
            Err("SQL driver 'PostgreSQL' is not enabled yet".to_string())
        }
    }
}

pub fn normalize_sqlite_connection_input(
    input: &SqlConnectionInput,
) -> Result<SqlConnection, String> {
    let database_path = normalize_required(input.database_path.as_deref(), "databasePath")?;
    let id = normalize_optional(input.id.as_deref()).unwrap_or_else(|| Uuid::new_v4().to_string());
    let name = normalize_optional(input.name.as_deref()).unwrap_or_else(|| database_path.clone());

    Ok(SqlConnection {
        id,
        name,
        kind: SqlConnectionKind::Sqlite,
        database_path: Some(database_path),
        host: None,
        port: None,
        database: None,
        username: None,
        ssl_mode: None,
        read_only: input.read_only,
    })
}

#[allow(dead_code)]
pub fn normalize_network_connection_input(
    input: &SqlConnectionInput,
) -> Result<SqlConnection, String> {
    let descriptor = get_driver_descriptor(&input.kind);

    if !descriptor.remote {
        return Err(format!(
            "SQL driver '{}' is not a network driver",
            descriptor.label
        ));
    }

    let host = normalize_required(input.host.as_deref(), "host")?;
    let database = normalize_required(input.database.as_deref(), "database")?;
    let port = input
        .port
        .or(descriptor.default_port)
        .ok_or_else(|| "port is required".to_string())?;

    let id = normalize_optional(input.id.as_deref()).unwrap_or_else(|| Uuid::new_v4().to_string());
    let name = normalize_optional(input.name.as_deref())
        .unwrap_or_else(|| format!("{} · {}:{}/{}", descriptor.label, host, port, database));

    Ok(SqlConnection {
        id,
        name,
        kind: input.kind.clone(),
        database_path: None,
        host: Some(host),
        port: Some(port),
        database: Some(database),
        username: normalize_optional(input.username.as_deref()),
        ssl_mode: Some(input.ssl_mode.clone().unwrap_or(SqlSslMode::Prefer)),
        read_only: input.read_only,
    })
}

pub fn is_persistable_connection(connection: &SqlConnection) -> bool {
    match connection.kind {
        SqlConnectionKind::Sqlite => connection.database_path.as_deref() != Some(":memory:"),
        SqlConnectionKind::PostgreSql | SqlConnectionKind::MySql => true,
    }
}

fn normalize_required(value: Option<&str>, field_name: &str) -> Result<String, String> {
    let value = value.unwrap_or("").trim();

    if value.is_empty() {
        return Err(format!("{field_name} must not be empty"));
    }

    if value.contains('\0') {
        return Err(format!("{field_name} must not contain NUL bytes"));
    }

    Ok(value.to_string())
}

fn normalize_optional(value: Option<&str>) -> Option<String> {
    let value = value?.trim();

    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_driver_is_stable() {
        let descriptor = get_driver_descriptor(&SqlConnectionKind::Sqlite);
        assert_eq!(descriptor.label, "SQLite");
        assert_eq!(descriptor.availability, SqlDriverAvailability::Stable);
        assert_eq!(descriptor.runtime_status, RuntimeStatus::Stable);
        assert!(ensure_driver_enabled(&SqlConnectionKind::Sqlite).is_ok());
    }

    #[test]
    fn postgresql_driver_is_planned() {
        let descriptor = get_driver_descriptor(&SqlConnectionKind::PostgreSql);
        assert_eq!(descriptor.runtime_status, RuntimeStatus::Planned);
        let err = ensure_driver_enabled(&SqlConnectionKind::PostgreSql).unwrap_err();
        assert!(err.contains("planned"));
    }

    #[test]
    fn mysql_driver_is_preview_per_phase_00() {
        let descriptor = get_driver_descriptor(&SqlConnectionKind::MySql);
        assert_eq!(descriptor.label, "MySQL");
        assert_eq!(descriptor.availability, SqlDriverAvailability::Preview);
        assert_eq!(descriptor.runtime_status, RuntimeStatus::Preview);
        assert!(ensure_driver_enabled(&SqlConnectionKind::MySql).is_ok());
    }

    #[test]
    fn catalog_runtime_status_matches_truth_of_record() {
        // 关键 invariant：catalog 里的 runtime_status 必须从单一真理之源派生。
        let sqlite = get_driver_descriptor(&SqlConnectionKind::Sqlite);
        let mysql = get_driver_descriptor(&SqlConnectionKind::MySql);
        let postgres = get_driver_descriptor(&SqlConnectionKind::PostgreSql);

        assert_eq!(sqlite.runtime_status, RuntimeStatus::Stable);
        assert_eq!(mysql.runtime_status, RuntimeStatus::Preview);
        assert_eq!(postgres.runtime_status, RuntimeStatus::Planned);
    }

    #[test]
    fn normalize_mysql_connection_input_creates_network_connection() {
        let input = SqlConnectionInput {
            id: Some("mysql-local".to_string()),
            name: Some("Local MySQL".to_string()),
            kind: SqlConnectionKind::MySql,
            database_path: None,
            host: Some(" localhost ".to_string()),
            port: None,
            database: Some(" app ".to_string()),
            username: Some(" root ".to_string()),
            password: Some(" secret ".to_string()),
            ssl_mode: None,
            read_only: false,
            create_if_missing: false,
        };

        let connection = normalize_connection_input(&input).unwrap();

        assert_eq!(connection.id, "mysql-local");
        assert_eq!(connection.name, "Local MySQL");
        assert_eq!(connection.kind, SqlConnectionKind::MySql);
        assert_eq!(connection.host.as_deref(), Some("localhost"));
        assert_eq!(connection.port, Some(3306));
        assert_eq!(connection.database.as_deref(), Some("app"));
        assert_eq!(connection.username.as_deref(), Some("root"));
    }

    #[test]
    fn normalize_sqlite_connection_input_creates_connection() {
        let input = SqlConnectionInput {
            id: Some("local".to_string()),
            name: Some("Local".to_string()),
            kind: SqlConnectionKind::Sqlite,
            database_path: Some(" /tmp/app.db ".to_string()),
            host: None,
            port: None,
            database: None,
            username: None,
            password: None,
            ssl_mode: None,
            read_only: true,
            create_if_missing: true,
        };

        let connection = normalize_connection_input(&input).unwrap();

        assert_eq!(connection.id, "local");
        assert_eq!(connection.name, "Local");
        assert_eq!(connection.database_path.as_deref(), Some("/tmp/app.db"));
        assert!(connection.read_only);
    }

    #[test]
    fn normalize_sqlite_connection_input_rejects_empty_path() {
        let input = SqlConnectionInput {
            id: None,
            name: None,
            kind: SqlConnectionKind::Sqlite,
            database_path: Some(" ".to_string()),
            host: None,
            port: None,
            database: None,
            username: None,
            password: None,
            ssl_mode: None,
            read_only: false,
            create_if_missing: true,
        };

        assert!(normalize_connection_input(&input).is_err());
    }

    #[test]
    fn normalize_network_connection_input_uses_default_port() {
        let input = SqlConnectionInput {
            id: None,
            name: None,
            kind: SqlConnectionKind::PostgreSql,
            database_path: None,
            host: Some("localhost".to_string()),
            port: None,
            database: Some("app".to_string()),
            username: Some("user".to_string()),
            password: Some("secret".to_string()),
            ssl_mode: None,
            read_only: false,
            create_if_missing: false,
        };

        let connection = normalize_network_connection_input(&input).unwrap();

        assert_eq!(connection.port, Some(5432));
        assert_eq!(connection.ssl_mode, Some(SqlSslMode::Prefer));
        assert_eq!(connection.database.as_deref(), Some("app"));
    }

    #[test]
    fn memory_sqlite_connection_is_not_persistable() {
        let connection = SqlConnection {
            id: "memory".to_string(),
            name: "memory".to_string(),
            kind: SqlConnectionKind::Sqlite,
            database_path: Some(":memory:".to_string()),
            host: None,
            port: None,
            database: None,
            username: None,
            ssl_mode: None,
            read_only: false,
        };

        assert!(!is_persistable_connection(&connection));
    }
}
