use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;

use crate::runtime_status::{self, DriverId, RuntimeStatus};

use super::super::connection_manager::SharedConnectionManager;
use super::super::dialect::SqlDialect;
use super::super::state::SqlConnectionStore;
use super::super::types::{
    ConnectionProfile, DriverIdDto, SqlCommandError, SqlConnection, SqlConnectionKind,
};

const MYSQL_METADATA_UNSUPPORTED: &str =
    "MySQL Preview metadata is not available through the V2 probe connection";
const POSTGRES_METADATA_UNSUPPORTED: &str =
    "PostgreSQL metadata is unavailable while the driver is planned";
const SQLITE_METADATA_REQUIRES_STABLE: &str = "SQLite schema metadata requires a stable runtime";
const INDEX_METADATA_UNSUPPORTED: &str = "index metadata is not available in A1.1";
const FOREIGN_KEY_METADATA_UNSUPPORTED: &str = "foreign-key metadata is not available in A1.1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SqlCapabilitySupport {
    Supported,
    Unsupported { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlMetadataCapabilities {
    pub schema_context: SqlCapabilitySupport,
    pub indexes: SqlCapabilitySupport,
    pub foreign_keys: SqlCapabilitySupport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlRuntimeCapabilities {
    pub connection_id: String,
    pub driver: DriverId,
    pub status: RuntimeStatus,
    pub dialect: SqlDialect,
    pub read_only: bool,
    pub metadata: SqlMetadataCapabilities,
}

pub trait SqlCoreAdapter: Send + Sync {
    fn runtime_capabilities(
        &self,
        connection_id: &str,
    ) -> Result<SqlRuntimeCapabilities, SqlCommandError>;
}

pub struct LocalSqlCoreAdapter {
    metadata_manager: SharedConnectionManager,
    legacy_store: Arc<SqlConnectionStore>,
}

impl LocalSqlCoreAdapter {
    pub fn new(
        metadata_manager: SharedConnectionManager,
        legacy_store: Arc<SqlConnectionStore>,
    ) -> Self {
        Self {
            metadata_manager,
            legacy_store,
        }
    }

    fn resolve_binding(
        &self,
        connection_id: &str,
    ) -> Result<ValidatedMetadataBinding, SqlCommandError> {
        let connection_id = normalize_connection_id(connection_id)?;
        let profile = self
            .metadata_manager
            .get_profile(connection_id)
            .ok_or_else(|| not_open_error(connection_id))?;

        if !self.metadata_manager.is_open(connection_id) {
            return Err(not_open_error(connection_id));
        }

        self.validate_legacy_binding(&profile)?;

        let driver: DriverId = profile.driver.into();
        let status = runtime_status::lookup(driver)
            .map(|entry| entry.status)
            .ok_or_else(|| SqlCommandError::new("internal", "driver runtime status is missing"))?;

        Ok(ValidatedMetadataBinding {
            connection_id: connection_id.to_string(),
            driver,
            status,
            dialect: dialect_for_driver(profile.driver),
            read_only: profile.read_only,
        })
    }

    fn validate_legacy_binding(&self, profile: &ConnectionProfile) -> Result<(), SqlCommandError> {
        let legacy = match self.legacy_store.open_connection_info(&profile.id) {
            Ok(connection) => connection,
            Err(SqlCommandError::NotOpen { .. }) => return Ok(()),
            Err(error) => return Err(error),
        };

        if !driver_matches(profile.driver, legacy.kind) {
            return Err(binding_validation_error(
                "workspace connection maps to different drivers",
            ));
        }

        if profile.read_only != legacy.read_only {
            return Err(binding_validation_error(
                "workspace connection maps to different read-only modes",
            ));
        }

        let targets_match = match profile.driver {
            DriverIdDto::Sqlite => sqlite_targets_match(profile, &legacy)?,
            DriverIdDto::Mysql | DriverIdDto::Postgres => network_targets_match(profile, &legacy),
        };

        if !targets_match {
            return Err(binding_validation_error(
                "workspace connection maps to different database targets",
            ));
        }

        Ok(())
    }
}

impl SqlCoreAdapter for LocalSqlCoreAdapter {
    fn runtime_capabilities(
        &self,
        connection_id: &str,
    ) -> Result<SqlRuntimeCapabilities, SqlCommandError> {
        let binding = self.resolve_binding(connection_id)?;
        Ok(binding.into_capabilities())
    }
}

struct ValidatedMetadataBinding {
    connection_id: String,
    driver: DriverId,
    status: RuntimeStatus,
    dialect: SqlDialect,
    read_only: bool,
}

impl ValidatedMetadataBinding {
    fn into_capabilities(self) -> SqlRuntimeCapabilities {
        SqlRuntimeCapabilities {
            connection_id: self.connection_id,
            driver: self.driver,
            status: self.status,
            dialect: self.dialect,
            read_only: self.read_only,
            metadata: metadata_capabilities(self.driver, self.status),
        }
    }
}

fn metadata_capabilities(driver: DriverId, status: RuntimeStatus) -> SqlMetadataCapabilities {
    let schema_context = match (driver, status) {
        (DriverId::Sqlite, RuntimeStatus::Stable) => SqlCapabilitySupport::Supported,
        (DriverId::Sqlite, _) => unsupported(SQLITE_METADATA_REQUIRES_STABLE),
        (DriverId::MySql, _) => unsupported(MYSQL_METADATA_UNSUPPORTED),
        (DriverId::Postgres, _) => unsupported(POSTGRES_METADATA_UNSUPPORTED),
    };

    SqlMetadataCapabilities {
        schema_context,
        indexes: unsupported(INDEX_METADATA_UNSUPPORTED),
        foreign_keys: unsupported(FOREIGN_KEY_METADATA_UNSUPPORTED),
    }
}

fn unsupported(reason: &str) -> SqlCapabilitySupport {
    SqlCapabilitySupport::Unsupported {
        reason: reason.to_string(),
    }
}

fn normalize_connection_id(connection_id: &str) -> Result<&str, SqlCommandError> {
    let connection_id = connection_id.trim();
    if connection_id.is_empty() {
        Err(SqlCommandError::new(
            "invalid_input",
            "connection id must not be empty",
        ))
    } else {
        Ok(connection_id)
    }
}

fn not_open_error(connection_id: &str) -> SqlCommandError {
    SqlCommandError::new(
        "not_open",
        format!("workspace connection '{connection_id}' is not open"),
    )
}

fn binding_validation_error(message: &str) -> SqlCommandError {
    SqlCommandError::new("validation", message)
}

fn dialect_for_driver(driver: DriverIdDto) -> SqlDialect {
    match driver {
        DriverIdDto::Sqlite => SqlDialect::Sqlite,
        DriverIdDto::Mysql => SqlDialect::MySql,
        DriverIdDto::Postgres => SqlDialect::PostgreSql,
    }
}

fn driver_matches(driver: DriverIdDto, kind: SqlConnectionKind) -> bool {
    matches!(
        (driver, kind),
        (DriverIdDto::Sqlite, SqlConnectionKind::Sqlite)
            | (DriverIdDto::Mysql, SqlConnectionKind::MySql)
            | (DriverIdDto::Postgres, SqlConnectionKind::PostgreSql)
    )
}

fn sqlite_targets_match(
    profile: &ConnectionProfile,
    legacy: &SqlConnection,
) -> Result<bool, SqlCommandError> {
    if profile.remember_in_memory || legacy.database_path.as_deref().is_some_and(is_memory_path) {
        return Err(binding_validation_error(
            "dual-store in-memory SQLite connections cannot share one workspace identity",
        ));
    }

    let profile_path = canonical_sqlite_path(profile.file_path.as_deref())?;
    let legacy_path = canonical_sqlite_path(legacy.database_path.as_deref())?;
    Ok(profile_path == legacy_path)
}

fn canonical_sqlite_path(path: Option<&str>) -> Result<PathBuf, SqlCommandError> {
    let path = path.map(str::trim).filter(|value| !value.is_empty());
    let Some(path) = path else {
        return Err(binding_validation_error(
            "SQLite binding is missing a file target",
        ));
    };

    if is_memory_path(path) {
        return Err(binding_validation_error(
            "dual-store in-memory SQLite connections cannot share one workspace identity",
        ));
    }

    std::fs::canonicalize(Path::new(path))
        .map_err(|_| binding_validation_error("SQLite binding file identity could not be verified"))
}

fn is_memory_path(path: &str) -> bool {
    path == ":memory:"
}

fn network_targets_match(profile: &ConnectionProfile, legacy: &SqlConnection) -> bool {
    normalized_host(profile.host.as_deref()) == normalized_host(legacy.host.as_deref())
        && normalized_network_port(profile.driver, profile.port) == legacy.port
        && normalized_text(profile.database.as_deref())
            == normalized_text(legacy.database.as_deref())
        && normalized_text(profile.username.as_deref())
            == normalized_text(legacy.username.as_deref())
        && profile.ssl_mode == legacy.ssl_mode
}

fn normalized_host(value: Option<&str>) -> Option<String> {
    normalized_text(value).map(|value| value.to_ascii_lowercase())
}

fn normalized_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalized_network_port(driver: DriverIdDto, port: Option<u16>) -> Option<u16> {
    match driver {
        DriverIdDto::Mysql => Some(port.unwrap_or(3306)),
        DriverIdDto::Postgres => Some(port.unwrap_or(5432)),
        DriverIdDto::Sqlite => port,
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;
    use crate::commands::sql::connection_manager::ConnectionManager;
    use crate::commands::sql::demo_seed::ensure_demo_db;
    use crate::commands::sql::driver_registry::{
        default_registry, BoxedConnection, SqlConnection as DriverConnection, SqlDriver,
        SqlDriverRegistry,
    };
    use crate::commands::sql::metadata_v2::{ColumnDto, SchemaObjectDto, SchemataDto};
    use crate::commands::sql::types::{ConnectionSecret, SqlConnectionInput, SqlSslMode};

    struct TempRoot {
        path: PathBuf,
    }

    impl TempRoot {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "nyala-sql-core-adapter-{}-{label}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("create adapter test root");
            Self { path }
        }

        fn database(&self, name: &str) -> PathBuf {
            self.path.join(format!("{name}.db"))
        }

        fn persistence(&self, name: &str) -> PathBuf {
            self.path.join(format!("{name}.json"))
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn sqlite_profile(id: &str, path: &Path, read_only: bool) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_string(),
            label: id.to_string(),
            driver: DriverIdDto::Sqlite,
            read_only,
            host: None,
            port: None,
            database: None,
            username: None,
            ssl_mode: None,
            file_path: Some(path.to_string_lossy().to_string()),
            remember_in_memory: false,
            created_at_ms: 0,
        }
    }

    fn sqlite_memory_profile(id: &str) -> ConnectionProfile {
        ConnectionProfile {
            remember_in_memory: true,
            file_path: None,
            ..sqlite_profile(id, Path::new("unused"), false)
        }
    }

    fn mysql_profile(id: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_string(),
            label: id.to_string(),
            driver: DriverIdDto::Mysql,
            read_only: true,
            host: Some("127.0.0.1".to_string()),
            port: Some(3306),
            database: Some("app".to_string()),
            username: Some("root".to_string()),
            ssl_mode: Some(SqlSslMode::Prefer),
            file_path: None,
            remember_in_memory: false,
            created_at_ms: 0,
        }
    }

    fn legacy_sqlite_input(id: &str, path: &Path, read_only: bool) -> SqlConnectionInput {
        SqlConnectionInput {
            id: Some(id.to_string()),
            name: Some(id.to_string()),
            kind: SqlConnectionKind::Sqlite,
            database_path: Some(path.to_string_lossy().to_string()),
            host: None,
            port: None,
            database: None,
            username: None,
            password: None,
            ssl_mode: None,
            read_only,
            create_if_missing: false,
        }
    }

    fn legacy_memory_input(id: &str) -> SqlConnectionInput {
        SqlConnectionInput {
            create_if_missing: true,
            database_path: Some(":memory:".to_string()),
            ..legacy_sqlite_input(id, Path::new(":memory:"), false)
        }
    }

    fn sqlite_manager(root: &TempRoot) -> SharedConnectionManager {
        Arc::new(ConnectionManager::new(
            default_registry(),
            root.persistence("v2"),
        ))
    }

    fn empty_legacy_store() -> Arc<SqlConnectionStore> {
        Arc::new(SqlConnectionStore::new())
    }

    fn open_profile(
        manager: &SharedConnectionManager,
        profile: &ConnectionProfile,
        secret: ConnectionSecret,
    ) {
        manager
            .upsert_profile(profile.clone())
            .expect("save V2 profile");
        manager.open(profile, secret).expect("open V2 profile");
    }

    #[test]
    fn v2_only_sqlite_reports_stable_schema_context_support() {
        let root = TempRoot::new("v2-only");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let capabilities = adapter
            .runtime_capabilities("workspace")
            .expect("resolve capabilities");

        assert_eq!(capabilities.driver, DriverId::Sqlite);
        assert_eq!(capabilities.status, RuntimeStatus::Stable);
        assert_eq!(capabilities.dialect, SqlDialect::Sqlite);
        assert!(capabilities.read_only);
        assert_eq!(
            capabilities.metadata.schema_context,
            SqlCapabilitySupport::Supported
        );
    }

    #[test]
    fn capability_serialization_hides_store_and_secret_fields() {
        let root = TempRoot::new("serialization");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, false);
        open_profile(
            &manager,
            &profile,
            ConnectionSecret {
                password: Some("adapter-secret-canary".to_string()),
            },
        );
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());
        let capabilities = adapter
            .runtime_capabilities("workspace")
            .expect("resolve capabilities");

        let serialized = serde_json::to_string(&capabilities).expect("serialize capabilities");

        for forbidden in [
            "adapter-secret-canary",
            "password",
            "profileId",
            "legacyConnectionId",
            "filePath",
            "host",
            "username",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "serialized capabilities exposed {forbidden}: {serialized}"
            );
        }
    }

    #[test]
    fn compatible_dual_store_sqlite_binding_is_accepted() {
        let root = TempRoot::new("dual-compatible");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, false);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let legacy = empty_legacy_store();
        legacy
            .open_connection(legacy_sqlite_input("workspace", &database, false))
            .expect("open V1 SQLite");
        let adapter = LocalSqlCoreAdapter::new(manager, legacy);

        let capabilities = adapter.runtime_capabilities("workspace");

        assert!(capabilities.is_ok(), "{capabilities:?}");
    }

    #[test]
    fn dual_store_sqlite_binding_rejects_different_files() {
        let root = TempRoot::new("dual-mismatch");
        let metadata_database = root.database("metadata");
        let query_database = root.database("query");
        ensure_demo_db(&metadata_database).expect("seed metadata database");
        ensure_demo_db(&query_database).expect("seed query database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &metadata_database, false);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let legacy = empty_legacy_store();
        legacy
            .open_connection(legacy_sqlite_input("workspace", &query_database, false))
            .expect("open V1 SQLite");
        let adapter = LocalSqlCoreAdapter::new(manager, legacy);

        let error = adapter.runtime_capabilities("workspace").unwrap_err();

        assert!(matches!(error, SqlCommandError::Validation { .. }));
    }

    #[test]
    fn dual_store_in_memory_sqlite_binding_is_rejected() {
        let root = TempRoot::new("dual-memory");
        let manager = sqlite_manager(&root);
        let profile = sqlite_memory_profile("workspace");
        open_profile(&manager, &profile, ConnectionSecret::default());
        let legacy = empty_legacy_store();
        legacy
            .open_connection(legacy_memory_input("workspace"))
            .expect("open V1 in-memory SQLite");
        let adapter = LocalSqlCoreAdapter::new(manager, legacy);

        let error = adapter.runtime_capabilities("workspace").unwrap_err();

        assert!(matches!(error, SqlCommandError::Validation { .. }));
    }

    #[test]
    fn saved_but_closed_profile_returns_not_open() {
        let root = TempRoot::new("closed");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        manager
            .upsert_profile(sqlite_profile("workspace", &database, false))
            .expect("save profile");
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let error = adapter.runtime_capabilities("workspace").unwrap_err();

        assert!(matches!(error, SqlCommandError::NotOpen { .. }));
    }

    #[test]
    fn unknown_profile_does_not_fallback_to_an_open_connection() {
        let root = TempRoot::new("missing");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("other", &database, false);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let error = adapter.runtime_capabilities("missing").unwrap_err();

        assert!(matches!(error, SqlCommandError::NotOpen { .. }));
    }

    struct FakeMysqlDriver;

    impl SqlDriver for FakeMysqlDriver {
        fn id(&self) -> DriverId {
            DriverId::MySql
        }

        fn open(
            &self,
            _profile: &ConnectionProfile,
            _secret: &ConnectionSecret,
        ) -> Result<BoxedConnection, String> {
            Ok(Arc::new(FakeMysqlConnection))
        }
    }

    struct FakeMysqlConnection;

    impl std::fmt::Debug for FakeMysqlConnection {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("FakeMysqlConnection")
        }
    }

    impl DriverConnection for FakeMysqlConnection {
        fn close(&self) {}

        fn is_alive(&self) -> bool {
            true
        }

        fn list_schemas(&self) -> Result<Vec<SchemataDto>, SqlCommandError> {
            Ok(Vec::new())
        }

        fn list_tables(&self, _schema: &str) -> Result<Vec<SchemaObjectDto>, SqlCommandError> {
            Ok(Vec::new())
        }

        fn list_columns(
            &self,
            _schema: &str,
            _table: &str,
        ) -> Result<Vec<ColumnDto>, SqlCommandError> {
            Ok(Vec::new())
        }
    }

    #[test]
    fn mysql_preview_reports_schema_context_as_unsupported() {
        let root = TempRoot::new("mysql-preview");
        let registry = SqlDriverRegistry::new(vec![Box::new(FakeMysqlDriver)]);
        let manager = Arc::new(ConnectionManager::new(registry, root.persistence("v2")));
        let profile = mysql_profile("workspace");
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let capabilities = adapter
            .runtime_capabilities("workspace")
            .expect("resolve capabilities");

        assert_eq!(capabilities.status, RuntimeStatus::Preview);
        assert!(matches!(
            capabilities.metadata.schema_context,
            SqlCapabilitySupport::Unsupported { .. }
        ));
    }

    #[test]
    fn postgres_capability_remains_planned_and_unsupported() {
        let capabilities = metadata_capabilities(DriverId::Postgres, RuntimeStatus::Planned);
        let status = runtime_status::lookup(DriverId::Postgres)
            .expect("postgres runtime status")
            .status;

        assert_eq!(status, RuntimeStatus::Planned);
        assert!(matches!(
            capabilities.schema_context,
            SqlCapabilitySupport::Unsupported { .. }
        ));
    }

    #[test]
    fn sqlite_schema_context_requires_stable_runtime() {
        let capabilities = metadata_capabilities(DriverId::Sqlite, RuntimeStatus::Preview);

        assert!(matches!(
            capabilities.schema_context,
            SqlCapabilitySupport::Unsupported { .. }
        ));
    }
}
