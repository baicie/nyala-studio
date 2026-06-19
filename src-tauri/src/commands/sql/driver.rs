use super::types::{SqlConnection, SqlConnectionInput, SqlConnectionKind, SqlSslMode};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SqlDriverAvailability {
    Enabled,
    Planned,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlDriverDescriptor {
    pub kind: SqlConnectionKind,
    pub label: &'static str,
    pub availability: SqlDriverAvailability,
    pub default_port: Option<u16>,
    pub file_based: bool,
    pub remote: bool,
}

pub fn sql_driver_catalog() -> Vec<SqlDriverDescriptor> {
    vec![
        SqlDriverDescriptor {
            kind: SqlConnectionKind::Sqlite,
            label: "SQLite",
            availability: SqlDriverAvailability::Enabled,
            default_port: None,
            file_based: true,
            remote: false,
        },
        SqlDriverDescriptor {
            kind: SqlConnectionKind::PostgreSql,
            label: "PostgreSQL",
            availability: SqlDriverAvailability::Planned,
            default_port: Some(5432),
            file_based: false,
            remote: true,
        },
        SqlDriverDescriptor {
            kind: SqlConnectionKind::MySql,
            label: "MySQL",
            availability: SqlDriverAvailability::Planned,
            default_port: Some(3306),
            file_based: false,
            remote: true,
        },
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
        SqlDriverAvailability::Enabled => Ok(()),
        SqlDriverAvailability::Planned => Err(format!(
            "SQL driver '{}' is planned and is not enabled yet",
            descriptor.label
        )),
    }
}

pub fn normalize_connection_input(input: &SqlConnectionInput) -> Result<SqlConnection, String> {
    ensure_driver_enabled(&input.kind)?;

    match input.kind {
        SqlConnectionKind::Sqlite => normalize_sqlite_connection_input(input),
        SqlConnectionKind::PostgreSql | SqlConnectionKind::MySql => {
            Err(format!("SQL driver '{:?}' is not enabled yet", input.kind))
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
    fn sqlite_driver_is_enabled() {
        assert_eq!(
            get_driver_descriptor(&SqlConnectionKind::Sqlite).label,
            "SQLite"
        );
        assert!(ensure_driver_enabled(&SqlConnectionKind::Sqlite).is_ok());
    }

    #[test]
    fn postgresql_driver_is_planned() {
        let err = ensure_driver_enabled(&SqlConnectionKind::PostgreSql).unwrap_err();
        assert!(err.contains("planned"));
    }

    #[test]
    fn mysql_driver_is_planned() {
        let err = ensure_driver_enabled(&SqlConnectionKind::MySql).unwrap_err();
        assert!(err.contains("planned"));
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
