//! Agent-facing metadata adapter over the existing V1 and V2 SQL stores.
//!
//! A1.1 exposes only secret-free runtime capabilities and scoped metadata.
//! Query execution, search/cache budgets, IPC, and model access live in later slices.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

#[cfg(test)]
use std::time::Duration;

use serde::Serialize;

use crate::runtime_status::{self, DriverId, RuntimeStatus};

use super::super::connection_manager::{ConnectionEntry, SharedConnectionManager};
use super::super::dialect::SqlDialect;
use super::super::metadata_v2::{ColumnDto, SchemaObjectDto, SchemaObjectKind, SchemataDto};
use super::super::state::SqlConnectionStore;
use super::super::types::{
    ConnectionProfile, DriverIdDto, SqlCommandError, SqlConnection, SqlConnectionKind,
};
use super::schema_context::{
    search_snapshot, SchemaCacheKey, SchemaSearchRequest, SchemaSearchResult, SchemaSnapshotCache,
    SchemaSnapshotObject, DEFAULT_SCHEMA_CACHE_TTL,
};

#[allow(unused_imports)]
pub use super::schema_context::{SchemaMatchKind, SchemaSearchBudget, SchemaSearchMatch};

const MYSQL_METADATA_UNSUPPORTED: &str =
    "MySQL Preview metadata is not available through the V2 probe connection";
const POSTGRES_METADATA_UNSUPPORTED: &str =
    "PostgreSQL metadata is unavailable while the driver is planned";
const SQLITE_METADATA_REQUIRES_STABLE: &str = "SQLite schema metadata requires a stable runtime";
const COMMENT_METADATA_UNSUPPORTED: &str = "column comment metadata is not available in A1.1";
const INDEX_METADATA_UNSUPPORTED: &str = "index metadata is not available in A1.1";
const FOREIGN_KEY_METADATA_UNSUPPORTED: &str = "foreign-key metadata is not available in A1.1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
/// Declares whether an Agent capability is usable, with an explicit reason when not.
pub enum SqlCapabilitySupport {
    Supported,
    Unsupported { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
/// Metadata features available for one validated workspace connection.
pub struct SqlMetadataCapabilities {
    pub schema_context: SqlCapabilitySupport,
    pub comments: SqlCapabilitySupport,
    pub indexes: SqlCapabilitySupport,
    pub foreign_keys: SqlCapabilitySupport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
/// Secret-free runtime identity and capability envelope exposed to Agent callers.
pub struct SqlRuntimeCapabilities {
    pub connection_id: String,
    pub driver: DriverId,
    pub status: RuntimeStatus,
    pub dialect: SqlDialect,
    pub read_only: bool,
    pub metadata: SqlMetadataCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Requests one bounded metadata level for an opaque workspace connection id.
pub struct SchemaContextRequest {
    pub connection_id: String,
    pub scope: SchemaContextScope,
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Metadata level requested from the existing V2 connection.
pub enum SchemaContextScope {
    Schemas,
    Tables { schema: String },
    Columns { schema: String, table: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
/// Agent-owned metadata result that does not expose V1 or V2 store identifiers.
pub struct SchemaContextResult {
    pub connection_id: String,
    pub dialect: SqlDialect,
    pub context: SchemaContextData,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "scope", rename_all = "snake_case")]
/// Typed payload corresponding exactly to the requested metadata scope.
pub enum SchemaContextData {
    Schemas {
        schemas: Vec<SchemaContextSchema>,
    },
    Tables {
        schema: String,
        objects: Vec<SchemaContextObject>,
    },
    Columns {
        schema: String,
        table: String,
        columns: Vec<SchemaContextColumn>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
/// Schema identity safe for Agent context.
pub struct SchemaContextSchema {
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Copy, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
/// Agent-owned schema object classification.
pub enum SchemaContextObjectKind {
    Table,
    View,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
/// Table or view identity within a normalized schema scope.
pub struct SchemaContextObject {
    pub schema: String,
    pub name: String,
    pub kind: SchemaContextObjectKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
/// Column shape safe for Agent context; literal defaults are intentionally omitted.
pub struct SchemaContextColumn {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub is_primary_key: bool,
    pub ordinal: i32,
}

/// Stable SQL Core boundary used by future Agent runtime and tool implementations.
pub trait SqlCoreAdapter: Send + Sync {
    /// Resolves driver maturity and metadata support for an open workspace connection.
    fn runtime_capabilities(
        &self,
        connection_id: &str,
    ) -> Result<SqlRuntimeCapabilities, SqlCommandError>;

    /// Returns scoped schema context after capability and V1/V2 binding validation.
    fn list_schema_context(
        &self,
        request: SchemaContextRequest,
    ) -> Result<SchemaContextResult, SqlCommandError>;

    /// Searches the validated schema snapshot without querying the model or
    /// exposing V1/V2 store identity.
    fn search_schema(
        &self,
        request: SchemaSearchRequest,
    ) -> Result<SchemaSearchResult, SqlCommandError>;

    /// Invalidates all cached schema snapshots for one opaque connection id.
    fn invalidate_schema_cache(&self, connection_id: &str) -> Result<(), SqlCommandError>;
}

/// Local adapter backed by the V2 metadata manager and optional V1 identity validation.
pub struct LocalSqlCoreAdapter {
    metadata_manager: SharedConnectionManager,
    legacy_store: Arc<SqlConnectionStore>,
    schema_cache: Arc<SchemaSnapshotCache>,
}

impl LocalSqlCoreAdapter {
    /// Creates an adapter without opening, cloning, or persisting a database secret.
    pub fn new(
        metadata_manager: SharedConnectionManager,
        legacy_store: Arc<SqlConnectionStore>,
    ) -> Self {
        Self {
            metadata_manager,
            legacy_store,
            schema_cache: Arc::new(SchemaSnapshotCache::new(DEFAULT_SCHEMA_CACHE_TTL)),
        }
    }

    #[cfg(test)]
    #[allow(dead_code)]
    fn new_with_cache_ttl(
        metadata_manager: SharedConnectionManager,
        legacy_store: Arc<SqlConnectionStore>,
        ttl: Duration,
    ) -> Self {
        Self {
            metadata_manager,
            legacy_store,
            schema_cache: Arc::new(SchemaSnapshotCache::new(ttl)),
        }
    }

    fn resolve_binding(
        &self,
        connection_id: &str,
    ) -> Result<ValidatedMetadataBinding, SqlCommandError> {
        let connection_id = normalize_connection_id(connection_id)?;
        let (profile, metadata_revision) = self
            .metadata_manager
            .get_open_profile_with_revision(connection_id)
            .ok_or_else(|| not_open_error(connection_id))?;

        self.validate_legacy_binding(&profile)?;

        let driver: DriverId = profile.driver.into();
        let status = runtime_status::lookup(driver)
            .map(|entry| entry.status)
            .ok_or_else(|| SqlCommandError::new("internal", "driver runtime status is missing"))?;
        let dialect = dialect_for_driver(profile.driver);
        let read_only = profile.read_only;

        Ok(ValidatedMetadataBinding {
            connection_id: connection_id.to_string(),
            open_profile: profile,
            driver,
            status,
            dialect,
            read_only,
            metadata_revision,
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
        self.with_metadata_connection(&binding, |_| Ok(()))?;
        Ok(binding.into_capabilities())
    }

    fn list_schema_context(
        &self,
        request: SchemaContextRequest,
    ) -> Result<SchemaContextResult, SqlCommandError> {
        let binding = self.resolve_binding(&request.connection_id)?;
        ensure_schema_context_supported(&binding)?;

        let context = match request.scope {
            SchemaContextScope::Schemas => {
                let schemas = self
                    .with_metadata_connection(&binding, |entry| entry.conn.list_schemas())?
                    .into_iter()
                    .map(map_schema)
                    .collect();
                SchemaContextData::Schemas { schemas }
            }
            SchemaContextScope::Tables { schema } => {
                let schema = normalize_schema_scope(&binding, &schema)?;
                let mut objects: Vec<_> = self
                    .with_metadata_connection(&binding, |entry| entry.conn.list_tables(&schema))?
                    .into_iter()
                    .map(|object| map_schema_object(object, &schema))
                    .collect();
                objects.sort_by(|left, right| {
                    left.schema
                        .cmp(&right.schema)
                        .then_with(|| left.name.cmp(&right.name))
                        .then_with(|| {
                            object_kind_rank(left.kind).cmp(&object_kind_rank(right.kind))
                        })
                });
                SchemaContextData::Tables { schema, objects }
            }
            SchemaContextScope::Columns { schema, table } => {
                let schema = normalize_schema_scope(&binding, &schema)?;
                let table = normalize_scope_name(&table, "table")?.to_string();
                self.ensure_schema_object_exists(&binding, &schema, &table)?;
                let mut columns: Vec<_> = self
                    .with_metadata_connection(&binding, |entry| {
                        entry.conn.list_columns(&schema, &table)
                    })?
                    .into_iter()
                    .map(map_column)
                    .collect();
                columns.sort_by_key(|column| column.ordinal);
                SchemaContextData::Columns {
                    schema,
                    table,
                    columns,
                }
            }
        };

        Ok(SchemaContextResult {
            connection_id: binding.connection_id,
            dialect: binding.dialect,
            context,
        })
    }

    fn search_schema(
        &self,
        request: SchemaSearchRequest,
    ) -> Result<SchemaSearchResult, SqlCommandError> {
        let binding = self.resolve_binding(&request.connection_id)?;
        ensure_schema_context_supported(&binding)?;
        let schema = normalize_schema_scope(&binding, &request.schema)?;

        // Validate the runtime again before accepting a cache hit. This
        // closes the race where a connection is replaced after binding
        // resolution but before search begins.
        self.with_metadata_connection(&binding, |_| Ok(()))?;

        let key = SchemaCacheKey::new(&binding.connection_id, &schema, binding.metadata_revision);
        let snapshot = self
            .schema_cache
            .get_or_try_insert_with(key, Instant::now(), || {
                self.load_schema_snapshot(&binding, &schema)
            })?;

        let request = SchemaSearchRequest {
            connection_id: binding.connection_id.clone(),
            schema,
            ..request
        };
        search_snapshot(
            &request,
            binding.dialect,
            binding.metadata_revision,
            &snapshot,
        )
    }

    fn invalidate_schema_cache(&self, connection_id: &str) -> Result<(), SqlCommandError> {
        let connection_id = normalize_connection_id(connection_id)?;
        // Advance the revision before deleting entries so a concurrent load
        // cannot publish a snapshot under the old metadata identity.
        self.metadata_manager
            .bump_metadata_revision(connection_id)?;
        self.schema_cache.invalidate(connection_id);
        Ok(())
    }
}

impl LocalSqlCoreAdapter {
    fn with_metadata_connection<R>(
        &self,
        binding: &ValidatedMetadataBinding,
        f: impl FnOnce(&mut ConnectionEntry) -> Result<R, SqlCommandError>,
    ) -> Result<R, SqlCommandError> {
        self.metadata_manager.with_conn_for_runtime(
            &binding.open_profile,
            binding.metadata_revision,
            f,
        )
    }

    fn load_schema_snapshot(
        &self,
        binding: &ValidatedMetadataBinding,
        schema: &str,
    ) -> Result<Vec<SchemaSnapshotObject>, SqlCommandError> {
        self.with_metadata_connection(binding, |entry| {
            let mut objects: Vec<_> = entry
                .conn
                .list_tables(schema)?
                .into_iter()
                .map(|object| {
                    let context_object = map_schema_object(object, schema);
                    let mut columns = entry
                        .conn
                        .list_columns(schema, &context_object.name)?
                        .into_iter()
                        .map(map_column)
                        .collect::<Vec<_>>();
                    columns.sort_by_key(|column| column.ordinal);
                    Ok(SchemaSnapshotObject {
                        object: context_object,
                        columns,
                    })
                })
                .collect::<Result<_, SqlCommandError>>()?;
            objects.sort_by(|left, right| {
                left.object
                    .schema
                    .cmp(&right.object.schema)
                    .then_with(|| left.object.name.cmp(&right.object.name))
                    .then_with(|| {
                        object_kind_rank(left.object.kind).cmp(&object_kind_rank(right.object.kind))
                    })
            });
            Ok(objects)
        })
    }

    fn ensure_schema_object_exists(
        &self,
        binding: &ValidatedMetadataBinding,
        schema: &str,
        table: &str,
    ) -> Result<(), SqlCommandError> {
        let objects =
            self.with_metadata_connection(binding, |entry| entry.conn.list_tables(schema))?;
        if objects.iter().any(|object| object.name == table) {
            Ok(())
        } else {
            Err(SqlCommandError::new(
                "validation",
                format!("schema object '{schema}.{table}' does not exist"),
            ))
        }
    }
}

struct ValidatedMetadataBinding {
    connection_id: String,
    open_profile: ConnectionProfile,
    driver: DriverId,
    status: RuntimeStatus,
    dialect: SqlDialect,
    read_only: bool,
    metadata_revision: u64,
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
        comments: unsupported(COMMENT_METADATA_UNSUPPORTED),
        indexes: unsupported(INDEX_METADATA_UNSUPPORTED),
        foreign_keys: unsupported(FOREIGN_KEY_METADATA_UNSUPPORTED),
    }
}

fn unsupported(reason: &str) -> SqlCapabilitySupport {
    SqlCapabilitySupport::Unsupported {
        reason: reason.to_string(),
    }
}

fn ensure_schema_context_supported(
    binding: &ValidatedMetadataBinding,
) -> Result<(), SqlCommandError> {
    match metadata_capabilities(binding.driver, binding.status).schema_context {
        SqlCapabilitySupport::Supported => Ok(()),
        SqlCapabilitySupport::Unsupported { reason } => {
            Err(SqlCommandError::new("validation", reason))
        }
    }
}

fn map_schema(schema: SchemataDto) -> SchemaContextSchema {
    SchemaContextSchema {
        name: schema.schema,
        is_default: schema.is_default,
    }
}

fn map_schema_object(object: SchemaObjectDto, requested_schema: &str) -> SchemaContextObject {
    SchemaContextObject {
        schema: object
            .schema
            .map(|schema| schema.trim().to_string())
            .filter(|schema| !schema.is_empty())
            .unwrap_or_else(|| requested_schema.to_string()),
        name: object.name,
        kind: match object.kind {
            SchemaObjectKind::Table => SchemaContextObjectKind::Table,
            SchemaObjectKind::View => SchemaContextObjectKind::View,
            SchemaObjectKind::System => SchemaContextObjectKind::System,
        },
    }
}

fn object_kind_rank(kind: SchemaContextObjectKind) -> u8 {
    match kind {
        SchemaContextObjectKind::Table => 0,
        SchemaContextObjectKind::View => 1,
        SchemaContextObjectKind::System => 2,
    }
}

fn map_column(column: ColumnDto) -> SchemaContextColumn {
    SchemaContextColumn {
        name: column.name,
        data_type: column.data_type,
        is_nullable: column.is_nullable,
        is_primary_key: column.is_primary_key,
        ordinal: column.ordinal,
    }
}

fn normalize_connection_id(connection_id: &str) -> Result<&str, SqlCommandError> {
    normalize_scope_name(connection_id, "connection id")
}

fn normalize_scope_name<'a>(value: &'a str, label: &str) -> Result<&'a str, SqlCommandError> {
    let value = value.trim();
    if value.is_empty() {
        Err(SqlCommandError::new(
            "invalid_input",
            format!("{label} must not be empty"),
        ))
    } else if value.contains('\0') {
        Err(SqlCommandError::new(
            "invalid_input",
            format!("{label} must not contain NUL"),
        ))
    } else {
        Ok(value)
    }
}

fn normalize_schema_scope(
    binding: &ValidatedMetadataBinding,
    schema: &str,
) -> Result<String, SqlCommandError> {
    let schema = normalize_scope_name(schema, "schema")?;
    if binding.driver == DriverId::Sqlite && schema != "main" {
        return Err(SqlCommandError::new(
            "validation",
            "SQLite schema context only supports the 'main' schema",
        ));
    }
    Ok(schema.to_string())
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
    use std::sync::atomic::{AtomicUsize, Ordering};
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
        let adapter: &dyn SqlCoreAdapter = &adapter;

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
        assert!(matches!(
            capabilities.metadata.comments,
            SqlCapabilitySupport::Unsupported { .. }
        ));
    }

    #[test]
    fn v2_only_sqlite_lists_main_schema_context() {
        let root = TempRoot::new("schema-context");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let result = adapter
            .list_schema_context(SchemaContextRequest {
                connection_id: "workspace".to_string(),
                scope: SchemaContextScope::Schemas,
            })
            .expect("list schema context");

        assert_eq!(result.connection_id, "workspace");
        assert_eq!(result.dialect, SqlDialect::Sqlite);
        assert_eq!(
            result.context,
            SchemaContextData::Schemas {
                schemas: vec![SchemaContextSchema {
                    name: "main".to_string(),
                    is_default: true,
                }],
            }
        );
    }

    #[test]
    fn v2_only_in_memory_sqlite_lists_main_schema_context() {
        let root = TempRoot::new("v2-memory-context");
        let manager = sqlite_manager(&root);
        let profile = sqlite_memory_profile("workspace");
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let result = adapter
            .list_schema_context(SchemaContextRequest {
                connection_id: "workspace".to_string(),
                scope: SchemaContextScope::Schemas,
            })
            .expect("list in-memory schema context");

        assert!(matches!(
            result.context,
            SchemaContextData::Schemas { schemas }
                if schemas == vec![SchemaContextSchema {
                    name: "main".to_string(),
                    is_default: true,
                }]
        ));
    }

    #[test]
    fn v2_only_sqlite_lists_seeded_table_context() {
        let root = TempRoot::new("table-context");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let result = adapter
            .list_schema_context(SchemaContextRequest {
                connection_id: "workspace".to_string(),
                scope: SchemaContextScope::Tables {
                    schema: "main".to_string(),
                },
            })
            .expect("list table context");
        let SchemaContextData::Tables { objects, .. } = result.context else {
            panic!("expected table context");
        };

        assert_eq!(
            objects,
            vec![
                SchemaContextObject {
                    schema: "main".to_string(),
                    name: "orders".to_string(),
                    kind: SchemaContextObjectKind::Table,
                },
                SchemaContextObject {
                    schema: "main".to_string(),
                    name: "users".to_string(),
                    kind: SchemaContextObjectKind::Table,
                },
            ]
        );
    }

    #[test]
    fn v2_only_sqlite_lists_columns_in_ordinal_order() {
        let root = TempRoot::new("column-context");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let result = adapter
            .list_schema_context(SchemaContextRequest {
                connection_id: "workspace".to_string(),
                scope: SchemaContextScope::Columns {
                    schema: "main".to_string(),
                    table: "orders".to_string(),
                },
            })
            .expect("list column context");
        let SchemaContextData::Columns { columns, .. } = result.context else {
            panic!("expected column context");
        };
        assert_eq!(
            columns,
            vec![
                SchemaContextColumn {
                    name: "id".to_string(),
                    data_type: "INTEGER".to_string(),
                    is_nullable: true,
                    is_primary_key: true,
                    ordinal: 0,
                },
                SchemaContextColumn {
                    name: "user_id".to_string(),
                    data_type: "INTEGER".to_string(),
                    is_nullable: false,
                    is_primary_key: false,
                    ordinal: 1,
                },
                SchemaContextColumn {
                    name: "amount".to_string(),
                    data_type: "INTEGER".to_string(),
                    is_nullable: false,
                    is_primary_key: false,
                    ordinal: 2,
                },
                SchemaContextColumn {
                    name: "created_at".to_string(),
                    data_type: "TEXT".to_string(),
                    is_nullable: false,
                    is_primary_key: false,
                    ordinal: 3,
                },
            ]
        );
    }

    #[test]
    fn schema_search_returns_bounded_real_columns_and_reuses_runtime_snapshot() {
        let root = TempRoot::new("schema-search");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let request = SchemaSearchRequest {
            connection_id: "workspace".to_string(),
            schema: "main".to_string(),
            query: "user_id".to_string(),
            explicit_tables: Vec::new(),
            budget: SchemaSearchBudget::default(),
        };
        let first = adapter
            .search_schema(request.clone())
            .expect("search schema");
        let second = adapter
            .search_schema(request)
            .expect("reuse schema snapshot");

        assert_eq!(first, second);
        assert_eq!(first.matches.len(), 1);
        assert_eq!(first.matches[0].object.name, "orders");
        assert_eq!(first.matches[0].columns[1].name, "user_id");
        assert_eq!(
            first.returned_byte_count,
            serde_json::to_vec(&first).unwrap().len()
        );
    }

    #[test]
    fn schema_search_invalidation_refreshes_schema_and_changes_revision() {
        let root = TempRoot::new("schema-search-invalidate");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(Arc::clone(&manager), empty_legacy_store());
        let request = SchemaSearchRequest {
            connection_id: "workspace".to_string(),
            schema: "main".to_string(),
            query: "invoices".to_string(),
            explicit_tables: Vec::new(),
            budget: SchemaSearchBudget::default(),
        };

        let before = adapter
            .search_schema(request.clone())
            .expect("initial search");
        assert!(before.matches.is_empty());
        let external = rusqlite::Connection::open(&database).expect("open schema fixture");
        external
            .execute_batch("CREATE TABLE invoices (id INTEGER PRIMARY KEY);")
            .expect("create table outside metadata adapter");
        drop(external);

        let stale = adapter
            .search_schema(request.clone())
            .expect("cached search");
        assert!(stale.matches.is_empty());

        adapter
            .invalidate_schema_cache("workspace")
            .expect("invalidate schema cache");
        let refreshed = adapter.search_schema(request).expect("refreshed search");
        assert!(refreshed
            .matches
            .iter()
            .any(|entry| entry.object.name == "invoices"));
        assert!(refreshed.metadata_revision > before.metadata_revision);
    }

    #[test]
    fn schema_search_after_close_and_reopen_does_not_reuse_old_revision() {
        let root = TempRoot::new("schema-search-reopen");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(Arc::clone(&manager), empty_legacy_store());
        let request = SchemaSearchRequest {
            connection_id: "workspace".to_string(),
            schema: "main".to_string(),
            query: "users".to_string(),
            explicit_tables: Vec::new(),
            budget: SchemaSearchBudget::default(),
        };

        let first = adapter
            .search_schema(request.clone())
            .expect("initial search");
        manager.close("workspace");
        open_profile(&manager, &profile, ConnectionSecret::default());
        let reopened = adapter.search_schema(request).expect("search after reopen");

        assert!(reopened.metadata_revision > first.metadata_revision);
        assert_eq!(reopened.matches[0].object.name, "users");
    }

    #[test]
    fn schema_context_trims_schema_and_table_scope_names() {
        let root = TempRoot::new("trimmed-scope");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let result = adapter
            .list_schema_context(SchemaContextRequest {
                connection_id: "workspace".to_string(),
                scope: SchemaContextScope::Columns {
                    schema: " main ".to_string(),
                    table: " orders ".to_string(),
                },
            })
            .expect("list trimmed column context");

        assert!(matches!(
            result.context,
            SchemaContextData::Columns { schema, table, .. }
                if schema == "main" && table == "orders"
        ));
    }

    #[test]
    fn schema_context_rejects_blank_schema() {
        let root = TempRoot::new("blank-schema");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let error = adapter
            .list_schema_context(SchemaContextRequest {
                connection_id: "workspace".to_string(),
                scope: SchemaContextScope::Tables {
                    schema: "  ".to_string(),
                },
            })
            .unwrap_err();

        assert!(matches!(error, SqlCommandError::InvalidInput { .. }));
    }

    #[test]
    fn schema_context_rejects_blank_table() {
        let root = TempRoot::new("blank-table");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let error = adapter
            .list_schema_context(SchemaContextRequest {
                connection_id: "workspace".to_string(),
                scope: SchemaContextScope::Columns {
                    schema: "main".to_string(),
                    table: "  ".to_string(),
                },
            })
            .unwrap_err();

        assert!(matches!(error, SqlCommandError::InvalidInput { .. }));
    }

    #[test]
    fn schema_context_rejects_non_main_sqlite_schema() {
        let root = TempRoot::new("invalid-sqlite-schema");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let error = adapter
            .list_schema_context(SchemaContextRequest {
                connection_id: "workspace".to_string(),
                scope: SchemaContextScope::Tables {
                    schema: "other".to_string(),
                },
            })
            .unwrap_err();

        assert!(matches!(error, SqlCommandError::Validation { .. }));
    }

    #[test]
    fn schema_context_rejects_nul_scope_names() {
        let root = TempRoot::new("nul-scope");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        for scope in [
            SchemaContextScope::Tables {
                schema: "main\0".to_string(),
            },
            SchemaContextScope::Columns {
                schema: "main".to_string(),
                table: "orders\0".to_string(),
            },
        ] {
            let error = adapter
                .list_schema_context(SchemaContextRequest {
                    connection_id: "workspace".to_string(),
                    scope,
                })
                .unwrap_err();
            assert!(matches!(error, SqlCommandError::InvalidInput { .. }));
        }
    }

    #[test]
    fn schema_context_rejects_unknown_sqlite_table() {
        let root = TempRoot::new("unknown-table");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let error = adapter
            .list_schema_context(SchemaContextRequest {
                connection_id: "workspace".to_string(),
                scope: SchemaContextScope::Columns {
                    schema: "main".to_string(),
                    table: "missing".to_string(),
                },
            })
            .unwrap_err();

        assert!(matches!(error, SqlCommandError::Validation { .. }));
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
    fn schema_context_serialization_hides_store_and_secret_fields() {
        let root = TempRoot::new("context-serialization");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let fixture = rusqlite::Connection::open(&database).expect("open default canary fixture");
        fixture
            .execute_batch(
                "CREATE TABLE secret_defaults (
                    id INTEGER PRIMARY KEY,
                    value TEXT NOT NULL DEFAULT 'adapter-default-secret-canary'
                );",
            )
            .expect("create default canary table");
        drop(fixture);
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
        let result = adapter
            .list_schema_context(SchemaContextRequest {
                connection_id: "workspace".to_string(),
                scope: SchemaContextScope::Columns {
                    schema: "main".to_string(),
                    table: "secret_defaults".to_string(),
                },
            })
            .expect("list schema context");

        let serialized = serde_json::to_string(&result).expect("serialize schema context");
        let debug = format!("{result:?}");
        let persisted =
            std::fs::read_to_string(root.persistence("v2")).expect("read persisted V2 profiles");

        for forbidden in [
            "adapter-secret-canary",
            "adapter-default-secret-canary",
            "password",
            "defaultValue",
            "profileId",
            "legacyConnectionId",
            "filePath",
            "databasePath",
            "host",
            "username",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "serialized schema context exposed {forbidden}: {serialized}"
            );
            assert!(
                !debug.contains(forbidden),
                "debug schema context exposed {forbidden}: {debug}"
            );
        }
        assert!(!persisted.contains("adapter-secret-canary"));
        assert!(!persisted.contains("password"));
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

        let context = adapter.list_schema_context(SchemaContextRequest {
            connection_id: "workspace".to_string(),
            scope: SchemaContextScope::Schemas,
        });

        assert!(context.is_ok(), "{context:?}");
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

        let error = adapter
            .list_schema_context(SchemaContextRequest {
                connection_id: "workspace".to_string(),
                scope: SchemaContextScope::Schemas,
            })
            .unwrap_err();

        assert!(matches!(error, SqlCommandError::Validation { .. }));
    }

    #[test]
    fn dual_store_sqlite_binding_rejects_read_only_mismatch() {
        let root = TempRoot::new("dual-read-only-mismatch");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let legacy = empty_legacy_store();
        legacy
            .open_connection(legacy_sqlite_input("workspace", &database, false))
            .expect("open V1 SQLite");
        let adapter = LocalSqlCoreAdapter::new(manager, legacy);

        let error = adapter
            .list_schema_context(SchemaContextRequest {
                connection_id: "workspace".to_string(),
                scope: SchemaContextScope::Schemas,
            })
            .unwrap_err();

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

        let error = adapter
            .list_schema_context(SchemaContextRequest {
                connection_id: "workspace".to_string(),
                scope: SchemaContextScope::Schemas,
            })
            .unwrap_err();

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

        let error = adapter
            .list_schema_context(SchemaContextRequest {
                connection_id: "workspace".to_string(),
                scope: SchemaContextScope::Schemas,
            })
            .unwrap_err();

        assert!(matches!(error, SqlCommandError::NotOpen { .. }));
    }

    #[test]
    fn open_profile_identity_is_not_relabelled_by_a_saved_profile_update() {
        let root = TempRoot::new("open-profile-snapshot");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        manager
            .upsert_profile(mysql_profile("workspace"))
            .expect("replace saved profile without reopening");
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let capabilities = adapter
            .runtime_capabilities("workspace")
            .expect("resolve capabilities from the open profile");

        assert_eq!(capabilities.driver, DriverId::Sqlite);
    }

    #[test]
    fn resolved_metadata_binding_rejects_a_replaced_same_id_runtime() {
        let root = TempRoot::new("replaced-open-runtime");
        let original_database = root.database("original");
        let replacement_database = root.database("replacement");
        ensure_demo_db(&original_database).expect("seed original database");
        ensure_demo_db(&replacement_database).expect("seed replacement database");
        let manager = sqlite_manager(&root);
        let original = sqlite_profile("workspace", &original_database, true);
        open_profile(&manager, &original, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(Arc::clone(&manager), empty_legacy_store());
        let binding = adapter
            .resolve_binding("workspace")
            .expect("resolve original binding");
        let replacement = sqlite_profile("workspace", &replacement_database, true);
        manager
            .open(&replacement, ConnectionSecret::default())
            .expect("replace open runtime");

        let error = adapter
            .with_metadata_connection(&binding, |entry| entry.conn.list_schemas())
            .unwrap_err();

        assert!(matches!(error, SqlCommandError::Validation { .. }));
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

        let error = adapter
            .list_schema_context(SchemaContextRequest {
                connection_id: "missing".to_string(),
                scope: SchemaContextScope::Schemas,
            })
            .unwrap_err();

        assert!(matches!(error, SqlCommandError::NotOpen { .. }));
    }

    struct FakeMysqlDriver {
        metadata_calls: Arc<AtomicUsize>,
    }

    impl SqlDriver for FakeMysqlDriver {
        fn id(&self) -> DriverId {
            DriverId::MySql
        }

        fn open(
            &self,
            _profile: &ConnectionProfile,
            _secret: &ConnectionSecret,
        ) -> Result<BoxedConnection, String> {
            Ok(Arc::new(FakeMysqlConnection {
                metadata_calls: Arc::clone(&self.metadata_calls),
            }))
        }
    }

    struct FakeMysqlConnection {
        metadata_calls: Arc<AtomicUsize>,
    }

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
            self.metadata_calls.fetch_add(1, Ordering::Relaxed);
            Ok(Vec::new())
        }

        fn list_tables(&self, _schema: &str) -> Result<Vec<SchemaObjectDto>, SqlCommandError> {
            self.metadata_calls.fetch_add(1, Ordering::Relaxed);
            Ok(Vec::new())
        }

        fn list_columns(
            &self,
            _schema: &str,
            _table: &str,
        ) -> Result<Vec<ColumnDto>, SqlCommandError> {
            self.metadata_calls.fetch_add(1, Ordering::Relaxed);
            Ok(Vec::new())
        }
    }

    #[test]
    fn mysql_preview_reports_schema_context_as_unsupported() {
        let root = TempRoot::new("mysql-preview");
        let metadata_calls = Arc::new(AtomicUsize::new(0));
        let registry = SqlDriverRegistry::new(vec![Box::new(FakeMysqlDriver { metadata_calls })]);
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
    fn mysql_preview_rejects_schema_context_retrieval() {
        let root = TempRoot::new("mysql-context");
        let metadata_calls = Arc::new(AtomicUsize::new(0));
        let registry = SqlDriverRegistry::new(vec![Box::new(FakeMysqlDriver {
            metadata_calls: Arc::clone(&metadata_calls),
        })]);
        let manager = Arc::new(ConnectionManager::new(registry, root.persistence("v2")));
        let profile = mysql_profile("workspace");
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        for scope in [
            SchemaContextScope::Schemas,
            SchemaContextScope::Tables {
                schema: "app".to_string(),
            },
            SchemaContextScope::Columns {
                schema: "app".to_string(),
                table: "users".to_string(),
            },
        ] {
            let error = adapter
                .list_schema_context(SchemaContextRequest {
                    connection_id: "workspace".to_string(),
                    scope,
                })
                .unwrap_err();
            assert!(matches!(
                error,
                SqlCommandError::Validation { message }
                    if message == MYSQL_METADATA_UNSUPPORTED
            ));
        }

        let error = adapter
            .search_schema(SchemaSearchRequest {
                connection_id: "workspace".to_string(),
                schema: "app".to_string(),
                query: "users".to_string(),
                explicit_tables: Vec::new(),
                budget: SchemaSearchBudget::default(),
            })
            .unwrap_err();
        assert!(matches!(
            error,
            SqlCommandError::Validation { message }
                if message == MYSQL_METADATA_UNSUPPORTED
        ));

        assert_eq!(metadata_calls.load(Ordering::Relaxed), 0);
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
