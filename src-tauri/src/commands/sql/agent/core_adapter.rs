//! Agent-facing metadata adapter over the existing V1 and V2 SQL stores.
//!
//! A1.1-A1.3 expose secret-free runtime capabilities plus bounded schema and
//! declared foreign-key graph retrieval. Query execution remains outside this boundary.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

#[cfg(test)]
use std::time::Duration;

use serde::Serialize;

use crate::runtime_status::{self, DriverId, RuntimeStatus};

use super::super::connection_manager::{ConnectionEntry, SharedConnectionManager};
use super::super::dialect::SqlDialect;
use super::super::metadata_v2::{
    BoundedForeignKeySnapshotDto, BoundedIndexSnapshotDto, BoundedSchemaSnapshotDto, ColumnDto,
    ForeignKeyDto, IndexColumnKindDto, IndexDto, IndexOriginDto, MetadataForeignKeyLimits,
    MetadataIndexLimits, MetadataSnapshotLimits, SchemaObjectDto, SchemaObjectKind, SchemataDto,
};
use super::super::sql_analysis::SqlTableRef;
use super::super::state::SqlConnectionStore;
use super::super::types::{
    ConnectionProfile, DriverIdDto, SqlCommandError, SqlConnection, SqlConnectionKind,
};
use super::index_context::{
    list_snapshot as list_index_snapshot, validate_index_list_request, IndexCacheKey,
    IndexSnapshot, IndexSnapshotCache, DEFAULT_INDEX_CACHE_TTL,
};
#[cfg(test)]
use super::relation_context::RelationSearchBudget;
use super::relation_context::{
    search_relation_graph, validate_relation_search_request, RelationCacheKey, RelationColumnPair,
    RelationEdge, RelationEvidenceKind, RelationGraphCache, RelationGraphSnapshot,
    RelationSearchRequest, RelationSearchResult, DEFAULT_RELATION_CACHE_TTL,
};
use super::schema_context::{
    search_snapshot, SchemaCacheKey, SchemaSearchRequest, SchemaSearchResult, SchemaSnapshot,
    SchemaSnapshotCache, SchemaSnapshotObject, DEFAULT_SCHEMA_CACHE_TTL,
};

#[allow(unused_imports)]
pub use super::index_context::{
    IndexContextColumn, IndexContextColumnKind, IndexContextEntry, IndexContextOrigin,
    IndexListBudget, IndexListRequest, IndexListResult,
};
#[allow(unused_imports)]
pub use super::schema_context::{SchemaMatchKind, SchemaSearchBudget, SchemaSearchMatch};

const MYSQL_METADATA_UNSUPPORTED: &str =
    "MySQL Preview metadata is not available through the V2 probe connection";
const POSTGRES_METADATA_UNSUPPORTED: &str =
    "PostgreSQL metadata is unavailable while the driver is planned";
const SQLITE_METADATA_REQUIRES_STABLE: &str = "SQLite schema metadata requires a stable runtime";
const COMMENT_METADATA_UNSUPPORTED: &str = "column comment metadata is not available";
const SCHEMA_SNAPSHOT_LIMITS: MetadataSnapshotLimits = MetadataSnapshotLimits {
    max_objects: 100,
    max_columns: 1_000,
    max_bytes: 256 * 1024,
};
const FOREIGN_KEY_SNAPSHOT_LIMITS: MetadataForeignKeyLimits = MetadataForeignKeyLimits {
    max_tables: 100,
    max_foreign_keys: 512,
    max_columns: 1_024,
    max_bytes: 256 * 1024,
};
const INDEX_SNAPSHOT_LIMITS: MetadataIndexLimits = MetadataIndexLimits {
    max_tables: 100,
    max_indexes: 512,
    max_columns: 1_024,
    max_bytes: 256 * 1024,
};

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
    pub metadata_revision: u64,
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

    /// Searches declared table relationships without executing SQL or
    /// exposing driver/store identities.
    fn search_relations(
        &self,
        request: RelationSearchRequest,
    ) -> Result<RelationSearchResult, SqlCommandError>;

    /// Lists declared indexes for an explicitly bounded table scope without
    /// executing SQL or exposing driver/store identities.
    fn list_indexes(&self, request: IndexListRequest) -> Result<IndexListResult, SqlCommandError>;

    /// Invalidates cached metadata snapshots for one opaque connection id.
    fn invalidate_schema_cache(&self, connection_id: &str) -> Result<(), SqlCommandError>;
}

/// Local adapter backed by the V2 metadata manager and optional V1 identity validation.
pub struct LocalSqlCoreAdapter {
    metadata_manager: SharedConnectionManager,
    legacy_store: Arc<SqlConnectionStore>,
    schema_cache: Arc<SchemaSnapshotCache>,
    relation_cache: Arc<RelationGraphCache>,
    index_cache: Arc<IndexSnapshotCache>,
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
            relation_cache: Arc::new(RelationGraphCache::new(DEFAULT_RELATION_CACHE_TTL)),
            index_cache: Arc::new(IndexSnapshotCache::new(DEFAULT_INDEX_CACHE_TTL)),
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
            relation_cache: Arc::new(RelationGraphCache::new(ttl)),
            index_cache: Arc::new(IndexSnapshotCache::new(ttl)),
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
            .get_or_try_insert_with(&key, Instant::now(), || {
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

    fn search_relations(
        &self,
        request: RelationSearchRequest,
    ) -> Result<RelationSearchResult, SqlCommandError> {
        validate_relation_search_request(&request)?;
        let binding = self.resolve_binding(&request.connection_id)?;
        ensure_foreign_keys_supported(&binding)?;
        let schema = normalize_schema_scope(&binding, &request.schema)?;
        let tables = normalize_relation_tables(&schema, &request.tables)?;

        // Revalidate the open runtime before accepting a graph cache hit.
        self.with_metadata_connection(&binding, |_| Ok(()))?;

        let key = RelationCacheKey::new(&binding.connection_id, &schema, binding.metadata_revision);
        let snapshot = self
            .relation_cache
            .get_or_try_insert_with(&key, Instant::now(), || {
                self.load_relation_graph(&binding, &schema)
            })?;
        let request = RelationSearchRequest {
            connection_id: binding.connection_id.clone(),
            schema,
            tables,
            ..request
        };
        search_relation_graph(
            &request,
            binding.dialect,
            binding.metadata_revision,
            &snapshot,
        )
    }

    fn list_indexes(&self, request: IndexListRequest) -> Result<IndexListResult, SqlCommandError> {
        validate_index_list_request(&request)?;
        let binding = self.resolve_binding(&request.connection_id)?;
        ensure_indexes_supported(&binding)?;
        let schema = normalize_schema_scope(&binding, &request.schema)?;
        let tables = normalize_index_tables(&schema, &request.tables)?;

        // Revalidate the open runtime before accepting a revision-bound cache hit.
        self.with_metadata_connection(&binding, |_| Ok(()))?;

        let key = IndexCacheKey::new(&binding.connection_id, &schema, binding.metadata_revision);
        let snapshot = self
            .index_cache
            .get_or_try_insert_with(&key, Instant::now(), || {
                self.load_index_snapshot(&binding, &schema)
            })?;
        let request = IndexListRequest {
            connection_id: binding.connection_id.clone(),
            schema,
            tables,
            ..request
        };
        let result = list_index_snapshot(
            &request,
            binding.dialect,
            binding.metadata_revision,
            &snapshot,
        )?;
        // Do not return an old revision if metadata refresh raced the cache
        // read or the bounded result construction above.
        self.with_metadata_connection(&binding, |_| Ok(()))?;
        Ok(result)
    }

    fn invalidate_schema_cache(&self, connection_id: &str) -> Result<(), SqlCommandError> {
        let connection_id = normalize_connection_id(connection_id)?;
        // Advance the revision before deleting entries so a concurrent load
        // cannot publish a snapshot under the old metadata identity.
        self.metadata_manager
            .bump_metadata_revision(connection_id)?;
        self.schema_cache.invalidate(connection_id);
        self.relation_cache.invalidate(connection_id);
        self.index_cache.invalidate(connection_id);
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
    ) -> Result<SchemaSnapshot, SqlCommandError> {
        self.with_metadata_connection(binding, |entry| {
            let snapshot = entry
                .conn
                .list_schema_snapshot_bounded(schema, SCHEMA_SNAPSHOT_LIMITS)?;
            validate_bounded_snapshot(&snapshot, SCHEMA_SNAPSHOT_LIMITS)?;
            let mut objects: Vec<_> = snapshot
                .objects
                .into_iter()
                .map(|entry| {
                    let context_object = map_schema_object(entry.object.clone(), schema);
                    let mut columns = entry
                        .object
                        .columns
                        .into_iter()
                        .map(map_column)
                        .collect::<Vec<_>>();
                    columns.sort_by_key(|column| column.ordinal);
                    SchemaSnapshotObject {
                        object: context_object,
                        columns,
                        columns_truncated: entry.columns_truncated,
                    }
                })
                .collect();
            objects.sort_by(|left, right| {
                left.object
                    .schema
                    .cmp(&right.object.schema)
                    .then_with(|| left.object.name.cmp(&right.object.name))
                    .then_with(|| {
                        object_kind_rank(left.object.kind).cmp(&object_kind_rank(right.object.kind))
                    })
            });
            Ok(SchemaSnapshot {
                objects,
                truncated: snapshot.truncated,
            })
        })
    }

    fn load_relation_graph(
        &self,
        binding: &ValidatedMetadataBinding,
        schema: &str,
    ) -> Result<RelationGraphSnapshot, SqlCommandError> {
        self.with_metadata_connection(binding, |entry| {
            let snapshot = entry
                .conn
                .list_foreign_keys_bounded(schema, FOREIGN_KEY_SNAPSHOT_LIMITS)?;
            validate_bounded_foreign_key_snapshot(&snapshot, schema, FOREIGN_KEY_SNAPSHOT_LIMITS)?;
            Ok(RelationGraphSnapshot {
                edges: snapshot
                    .foreign_keys
                    .into_iter()
                    .map(|foreign_key| map_foreign_key(foreign_key, binding.metadata_revision))
                    .collect(),
                truncated: snapshot.truncated,
            })
        })
    }

    fn load_index_snapshot(
        &self,
        binding: &ValidatedMetadataBinding,
        schema: &str,
    ) -> Result<IndexSnapshot, SqlCommandError> {
        self.with_metadata_connection(binding, |entry| {
            let snapshot = entry
                .conn
                .list_indexes_bounded(schema, INDEX_SNAPSHOT_LIMITS)?;
            validate_bounded_index_snapshot(&snapshot, schema, INDEX_SNAPSHOT_LIMITS)?;
            Ok(IndexSnapshot {
                indexes: snapshot
                    .indexes
                    .into_iter()
                    .map(|index| map_index(index, binding.metadata_revision))
                    .collect(),
                scanned_table_count: snapshot.scanned_table_count,
                truncated: snapshot.truncated,
            })
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

fn validate_bounded_snapshot(
    snapshot: &BoundedSchemaSnapshotDto,
    limits: MetadataSnapshotLimits,
) -> Result<(), SqlCommandError> {
    let object_count = snapshot.objects.len();
    let column_count = snapshot.objects.iter().try_fold(0usize, |count, entry| {
        count.checked_add(entry.object.columns.len())
    });
    let inconsistent_truncation =
        !snapshot.truncated && snapshot.objects.iter().any(|entry| entry.columns_truncated);
    if object_count > limits.max_objects
        || column_count.is_none_or(|count| count > limits.max_columns)
        || inconsistent_truncation
    {
        return Err(SqlCommandError::new(
            "internal",
            "SQL driver violated the bounded schema snapshot contract",
        ));
    }
    let byte_count = serde_json::to_vec(snapshot)
        .map_err(|error| {
            SqlCommandError::new(
                "internal",
                format!("failed to validate schema metadata size: {error}"),
            )
        })?
        .len();
    if byte_count > limits.max_bytes {
        return Err(SqlCommandError::new(
            "internal",
            "SQL driver violated the bounded schema snapshot contract",
        ));
    }
    Ok(())
}

fn validate_bounded_foreign_key_snapshot(
    snapshot: &BoundedForeignKeySnapshotDto,
    schema: &str,
    limits: MetadataForeignKeyLimits,
) -> Result<(), SqlCommandError> {
    let column_count = snapshot
        .foreign_keys
        .iter()
        .try_fold(0usize, |count, foreign_key| {
            count.checked_add(foreign_key.columns.len())
        });
    let source_table_count = snapshot
        .foreign_keys
        .iter()
        .map(|foreign_key| {
            (
                foreign_key.source_schema.as_str(),
                foreign_key.source_table.as_str(),
            )
        })
        .collect::<HashSet<_>>()
        .len();
    let shape_is_valid = snapshot.scanned_table_count <= limits.max_tables
        && source_table_count <= snapshot.scanned_table_count
        && snapshot.foreign_keys.len() <= limits.max_foreign_keys
        && column_count.is_some_and(|count| count <= limits.max_columns)
        && snapshot
            .foreign_keys
            .iter()
            .all(|foreign_key| valid_foreign_key_shape(foreign_key, schema));
    if !shape_is_valid {
        return Err(foreign_key_snapshot_contract_error());
    }

    let byte_count = serde_json::to_vec(snapshot)
        .map_err(|error| {
            SqlCommandError::new(
                "internal",
                format!("failed to validate foreign-key metadata size: {error}"),
            )
        })?
        .len();
    if byte_count > limits.max_bytes {
        return Err(foreign_key_snapshot_contract_error());
    }
    Ok(())
}

fn validate_bounded_index_snapshot(
    snapshot: &BoundedIndexSnapshotDto,
    schema: &str,
    limits: MetadataIndexLimits,
) -> Result<(), SqlCommandError> {
    let column_count = snapshot.indexes.iter().try_fold(0usize, |count, index| {
        count.checked_add(index.columns.len())
    });
    let source_table_count = snapshot
        .indexes
        .iter()
        .map(|index| {
            (
                index.schema.to_ascii_lowercase(),
                index.table.to_ascii_lowercase(),
            )
        })
        .collect::<HashSet<_>>()
        .len();
    let unique_index_count = snapshot
        .indexes
        .iter()
        .map(|index| {
            (
                index.schema.to_ascii_lowercase(),
                index.table.to_ascii_lowercase(),
                index.name.to_ascii_lowercase(),
            )
        })
        .collect::<HashSet<_>>()
        .len();
    let shape_is_valid = snapshot.scanned_table_count <= limits.max_tables
        && source_table_count <= snapshot.scanned_table_count
        && snapshot.indexes.len() <= limits.max_indexes
        && unique_index_count == snapshot.indexes.len()
        && column_count.is_some_and(|count| count <= limits.max_columns)
        && snapshot
            .indexes
            .iter()
            .all(|index| valid_index_shape(index, schema));
    if !shape_is_valid {
        return Err(index_snapshot_contract_error());
    }

    let byte_count = serde_json::to_vec(snapshot)
        .map_err(|error| {
            SqlCommandError::new(
                "internal",
                format!("failed to validate index metadata size: {error}"),
            )
        })?
        .len();
    if byte_count > limits.max_bytes {
        return Err(index_snapshot_contract_error());
    }
    Ok(())
}

fn valid_index_shape(index: &IndexDto, schema: &str) -> bool {
    if index.schema != schema
        || !valid_metadata_name(&index.table)
        || !valid_metadata_name(&index.name)
        || index.columns.is_empty()
    {
        return false;
    }

    index.columns.iter().enumerate().all(|(ordinal, column)| {
        let name_is_valid = match column.kind {
            IndexColumnKindDto::Column => column.name.as_deref().is_some_and(valid_metadata_name),
            IndexColumnKindDto::Expression => column.name.is_none(),
        };
        i32::try_from(ordinal).is_ok_and(|expected| column.ordinal == expected)
            && name_is_valid
            && column.collation.as_deref().is_none_or(valid_metadata_name)
    })
}

fn valid_foreign_key_shape(foreign_key: &ForeignKeyDto, schema: &str) -> bool {
    if foreign_key.source_schema != schema
        || foreign_key.target_schema != schema
        || !valid_metadata_name(&foreign_key.source_table)
        || !valid_metadata_name(&foreign_key.target_table)
        || foreign_key.columns.is_empty()
    {
        return false;
    }

    foreign_key
        .columns
        .iter()
        .enumerate()
        .all(|(index, column)| {
            i32::try_from(index).is_ok_and(|expected| column.ordinal == expected)
                && valid_metadata_name(&column.source_column)
                && column
                    .target_column
                    .as_deref()
                    .is_none_or(valid_metadata_name)
        })
}

fn valid_metadata_name(value: &str) -> bool {
    !value.trim().is_empty() && !value.contains('\0')
}

fn foreign_key_snapshot_contract_error() -> SqlCommandError {
    SqlCommandError::new(
        "internal",
        "SQL driver violated the bounded foreign-key snapshot contract",
    )
}

fn index_snapshot_contract_error() -> SqlCommandError {
    SqlCommandError::new(
        "internal",
        "SQL driver violated the bounded index snapshot contract",
    )
}

fn map_foreign_key(foreign_key: ForeignKeyDto, metadata_revision: u64) -> RelationEdge {
    RelationEdge {
        source: SchemaContextObject {
            schema: foreign_key.source_schema,
            name: foreign_key.source_table,
            kind: SchemaContextObjectKind::Table,
        },
        target: SchemaContextObject {
            schema: foreign_key.target_schema,
            name: foreign_key.target_table,
            kind: SchemaContextObjectKind::Table,
        },
        columns: foreign_key
            .columns
            .into_iter()
            .map(|column| RelationColumnPair {
                ordinal: column.ordinal,
                source_column: column.source_column,
                target_column: column.target_column,
            })
            .collect(),
        evidence_kind: RelationEvidenceKind::DeclaredForeignKey,
        metadata_revision,
    }
}

fn map_index(index: IndexDto, metadata_revision: u64) -> IndexContextEntry {
    IndexContextEntry {
        schema: index.schema,
        table: index.table,
        name: index.name,
        unique: index.unique,
        partial: index.partial,
        origin: match index.origin {
            IndexOriginDto::Created => IndexContextOrigin::Created,
            IndexOriginDto::UniqueConstraint => IndexContextOrigin::UniqueConstraint,
            IndexOriginDto::PrimaryKey => IndexContextOrigin::PrimaryKey,
        },
        columns: index
            .columns
            .into_iter()
            .map(|column| IndexContextColumn {
                ordinal: column.ordinal,
                name: column.name,
                kind: match column.kind {
                    IndexColumnKindDto::Column => IndexContextColumnKind::Column,
                    IndexColumnKindDto::Expression => IndexContextColumnKind::Expression,
                },
                descending: column.descending,
                collation: column.collation,
            })
            .collect(),
        metadata_revision,
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
            metadata_revision: self.metadata_revision,
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

    let foreign_keys = match (driver, status) {
        (DriverId::Sqlite, RuntimeStatus::Stable) => SqlCapabilitySupport::Supported,
        (DriverId::Sqlite, _) => unsupported(SQLITE_METADATA_REQUIRES_STABLE),
        (DriverId::MySql, _) => unsupported(MYSQL_METADATA_UNSUPPORTED),
        (DriverId::Postgres, _) => unsupported(POSTGRES_METADATA_UNSUPPORTED),
    };

    let indexes = match (driver, status) {
        (DriverId::Sqlite, RuntimeStatus::Stable) => SqlCapabilitySupport::Supported,
        (DriverId::Sqlite, _) => unsupported(SQLITE_METADATA_REQUIRES_STABLE),
        (DriverId::MySql, _) => unsupported(MYSQL_METADATA_UNSUPPORTED),
        (DriverId::Postgres, _) => unsupported(POSTGRES_METADATA_UNSUPPORTED),
    };

    SqlMetadataCapabilities {
        schema_context,
        comments: unsupported(COMMENT_METADATA_UNSUPPORTED),
        indexes,
        foreign_keys,
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

fn ensure_foreign_keys_supported(
    binding: &ValidatedMetadataBinding,
) -> Result<(), SqlCommandError> {
    match metadata_capabilities(binding.driver, binding.status).foreign_keys {
        SqlCapabilitySupport::Supported => Ok(()),
        SqlCapabilitySupport::Unsupported { reason } => {
            Err(SqlCommandError::new("validation", reason))
        }
    }
}

fn ensure_indexes_supported(binding: &ValidatedMetadataBinding) -> Result<(), SqlCommandError> {
    match metadata_capabilities(binding.driver, binding.status).indexes {
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

fn normalize_relation_tables(
    schema: &str,
    tables: &[SqlTableRef],
) -> Result<Vec<SqlTableRef>, SqlCommandError> {
    tables
        .iter()
        .map(|table| {
            let table_schema = table.schema.as_deref().unwrap_or(schema);
            let table_schema = normalize_scope_name(table_schema, "relation table schema")?;
            if table_schema != schema {
                return Err(SqlCommandError::new(
                    "validation",
                    "relation.search cannot access a schema outside the requested scope",
                ));
            }
            Ok(SqlTableRef {
                schema: Some(schema.to_string()),
                name: normalize_scope_name(&table.name, "relation table")?.to_string(),
            })
        })
        .collect()
}

fn normalize_index_tables(
    schema: &str,
    tables: &[SqlTableRef],
) -> Result<Vec<SqlTableRef>, SqlCommandError> {
    let mut identities = HashSet::new();
    let mut normalized = Vec::new();
    for table in tables {
        let table_schema = table.schema.as_deref().unwrap_or(schema);
        let table_schema = normalize_scope_name(table_schema, "index table schema")?;
        if table_schema != schema {
            return Err(SqlCommandError::new(
                "validation",
                "index.list cannot access a schema outside the requested scope",
            ));
        }
        let name = normalize_scope_name(&table.name, "index table")?;
        let identity = (schema.to_ascii_lowercase(), name.to_ascii_lowercase());
        if identities.insert(identity) {
            normalized.push(SqlTableRef {
                schema: Some(schema.to_string()),
                name: name.to_string(),
            });
        }
    }
    normalized.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(normalized)
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
    use std::collections::VecDeque;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;
    use crate::commands::sql::connection_manager::ConnectionManager;
    use crate::commands::sql::demo_seed::ensure_demo_db;
    use crate::commands::sql::driver_registry::{
        default_registry, BoxedConnection, SqlConnection as DriverConnection, SqlDriver,
        SqlDriverRegistry,
    };
    use crate::commands::sql::metadata_v2::{
        BoundedForeignKeySnapshotDto, BoundedIndexSnapshotDto, BoundedSchemaObjectDto,
        BoundedSchemaSnapshotDto, ColumnDto, ForeignKeyColumnDto, ForeignKeyDto, IndexColumnDto,
        IndexColumnKindDto, IndexDto, IndexOriginDto, MetadataIndexLimits, MetadataSnapshotLimits,
        SchemaObjectDto, SchemataDto,
    };
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

    struct CountingSqliteDriver {
        table_count: usize,
        table_calls: Arc<AtomicUsize>,
        column_calls: Arc<AtomicUsize>,
        snapshot_calls: Arc<AtomicUsize>,
        snapshot_limits: Arc<Mutex<Vec<MetadataSnapshotLimits>>>,
    }

    impl SqlDriver for CountingSqliteDriver {
        fn id(&self) -> DriverId {
            DriverId::Sqlite
        }

        fn open(
            &self,
            _profile: &ConnectionProfile,
            _secret: &ConnectionSecret,
        ) -> Result<BoxedConnection, String> {
            Ok(Arc::new(CountingSqliteConnection {
                table_count: self.table_count,
                table_calls: Arc::clone(&self.table_calls),
                column_calls: Arc::clone(&self.column_calls),
                snapshot_calls: Arc::clone(&self.snapshot_calls),
                snapshot_limits: Arc::clone(&self.snapshot_limits),
            }))
        }
    }

    struct CountingSqliteConnection {
        table_count: usize,
        table_calls: Arc<AtomicUsize>,
        column_calls: Arc<AtomicUsize>,
        snapshot_calls: Arc<AtomicUsize>,
        snapshot_limits: Arc<Mutex<Vec<MetadataSnapshotLimits>>>,
    }

    impl std::fmt::Debug for CountingSqliteConnection {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("CountingSqliteConnection")
        }
    }

    impl DriverConnection for CountingSqliteConnection {
        fn close(&self) {}

        fn is_alive(&self) -> bool {
            true
        }

        fn list_schemas(&self) -> Result<Vec<SchemataDto>, SqlCommandError> {
            Ok(vec![SchemataDto {
                schema: "main".to_string(),
                is_default: true,
            }])
        }

        fn list_tables(&self, schema: &str) -> Result<Vec<SchemaObjectDto>, SqlCommandError> {
            self.table_calls.fetch_add(1, Ordering::Relaxed);
            let mut objects = (0..self.table_count.saturating_sub(1))
                .map(|index| SchemaObjectDto {
                    kind: SchemaObjectKind::Table,
                    name: format!("table_{index:03}"),
                    schema: Some(schema.to_string()),
                    columns: Vec::new(),
                    primary_key: Vec::new(),
                })
                .collect::<Vec<_>>();
            objects.push(SchemaObjectDto {
                kind: SchemaObjectKind::Table,
                name: "target_table".to_string(),
                schema: Some(schema.to_string()),
                columns: Vec::new(),
                primary_key: Vec::new(),
            });
            Ok(objects)
        }

        fn list_columns(
            &self,
            _schema: &str,
            _table: &str,
        ) -> Result<Vec<ColumnDto>, SqlCommandError> {
            self.column_calls.fetch_add(1, Ordering::Relaxed);
            Ok(vec![ColumnDto {
                name: "id".to_string(),
                data_type: "INTEGER".to_string(),
                is_nullable: false,
                is_primary_key: true,
                default_value: None,
                comment: None,
                ordinal: 0,
            }])
        }

        fn list_schema_snapshot_bounded(
            &self,
            schema: &str,
            limits: MetadataSnapshotLimits,
        ) -> Result<BoundedSchemaSnapshotDto, SqlCommandError> {
            self.snapshot_calls.fetch_add(1, Ordering::Relaxed);
            self.snapshot_limits
                .lock()
                .expect("snapshot limits poisoned")
                .push(limits);
            let mut schema_objects = (0..self.table_count.saturating_sub(1))
                .map(|index| SchemaObjectDto {
                    kind: SchemaObjectKind::Table,
                    name: format!("table_{index:03}"),
                    schema: Some(schema.to_string()),
                    columns: Vec::new(),
                    primary_key: Vec::new(),
                })
                .collect::<Vec<_>>();
            schema_objects.push(SchemaObjectDto {
                kind: SchemaObjectKind::Table,
                name: "target_table".to_string(),
                schema: Some(schema.to_string()),
                columns: Vec::new(),
                primary_key: Vec::new(),
            });
            let objects = schema_objects
                .into_iter()
                .take(limits.max_objects)
                .map(|mut object| {
                    object.columns = vec![ColumnDto {
                        name: "id".to_string(),
                        data_type: "INTEGER".to_string(),
                        is_nullable: false,
                        is_primary_key: true,
                        default_value: None,
                        comment: None,
                        ordinal: 0,
                    }];
                    BoundedSchemaObjectDto {
                        object,
                        columns_truncated: false,
                    }
                })
                .collect();
            Ok(BoundedSchemaSnapshotDto {
                objects,
                truncated: self.table_count > limits.max_objects,
            })
        }
    }

    struct ScriptedSnapshotSqliteDriver {
        snapshots: Arc<Mutex<VecDeque<BoundedSchemaSnapshotDto>>>,
        snapshot_calls: Arc<AtomicUsize>,
    }

    impl SqlDriver for ScriptedSnapshotSqliteDriver {
        fn id(&self) -> DriverId {
            DriverId::Sqlite
        }

        fn open(
            &self,
            _profile: &ConnectionProfile,
            _secret: &ConnectionSecret,
        ) -> Result<BoxedConnection, String> {
            Ok(Arc::new(ScriptedSnapshotSqliteConnection {
                snapshots: Arc::clone(&self.snapshots),
                snapshot_calls: Arc::clone(&self.snapshot_calls),
            }))
        }
    }

    struct ScriptedSnapshotSqliteConnection {
        snapshots: Arc<Mutex<VecDeque<BoundedSchemaSnapshotDto>>>,
        snapshot_calls: Arc<AtomicUsize>,
    }

    struct CountingRelationSqliteDriver {
        calls: Arc<AtomicUsize>,
        limits: Arc<Mutex<Vec<MetadataForeignKeyLimits>>>,
    }

    impl SqlDriver for CountingRelationSqliteDriver {
        fn id(&self) -> DriverId {
            DriverId::Sqlite
        }

        fn open(
            &self,
            _profile: &ConnectionProfile,
            _secret: &ConnectionSecret,
        ) -> Result<BoxedConnection, String> {
            Ok(Arc::new(CountingRelationSqliteConnection {
                calls: Arc::clone(&self.calls),
                limits: Arc::clone(&self.limits),
            }))
        }
    }

    struct CountingRelationSqliteConnection {
        calls: Arc<AtomicUsize>,
        limits: Arc<Mutex<Vec<MetadataForeignKeyLimits>>>,
    }

    impl std::fmt::Debug for CountingRelationSqliteConnection {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("CountingRelationSqliteConnection")
        }
    }

    impl DriverConnection for CountingRelationSqliteConnection {
        fn close(&self) {}

        fn is_alive(&self) -> bool {
            true
        }

        fn list_schemas(&self) -> Result<Vec<SchemataDto>, SqlCommandError> {
            Ok(vec![SchemataDto {
                schema: "main".to_string(),
                is_default: true,
            }])
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

        fn list_foreign_keys_bounded(
            &self,
            _schema: &str,
            limits: MetadataForeignKeyLimits,
        ) -> Result<BoundedForeignKeySnapshotDto, SqlCommandError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            self.limits
                .lock()
                .expect("foreign-key limits poisoned")
                .push(limits);
            Ok(BoundedForeignKeySnapshotDto {
                foreign_keys: vec![bounded_foreign_key("orders")],
                scanned_table_count: 2,
                truncated: false,
            })
        }
    }

    impl std::fmt::Debug for ScriptedSnapshotSqliteConnection {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("ScriptedSnapshotSqliteConnection")
        }
    }

    impl DriverConnection for ScriptedSnapshotSqliteConnection {
        fn close(&self) {}

        fn is_alive(&self) -> bool {
            true
        }

        fn list_schemas(&self) -> Result<Vec<SchemataDto>, SqlCommandError> {
            Ok(vec![SchemataDto {
                schema: "main".to_string(),
                is_default: true,
            }])
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

        fn list_schema_snapshot_bounded(
            &self,
            _schema: &str,
            _limits: MetadataSnapshotLimits,
        ) -> Result<BoundedSchemaSnapshotDto, SqlCommandError> {
            self.snapshot_calls.fetch_add(1, Ordering::Relaxed);
            self.snapshots
                .lock()
                .expect("scripted snapshots poisoned")
                .pop_front()
                .ok_or_else(|| SqlCommandError::new("internal", "missing scripted snapshot"))
        }
    }

    fn bounded_column(index: usize) -> ColumnDto {
        ColumnDto {
            name: format!("c{index}"),
            data_type: "TEXT".to_string(),
            is_nullable: true,
            is_primary_key: false,
            default_value: None,
            comment: None,
            ordinal: i32::try_from(index).expect("test column ordinal fits i32"),
        }
    }

    fn bounded_foreign_key(source_table: impl Into<String>) -> ForeignKeyDto {
        ForeignKeyDto {
            source_schema: "main".to_string(),
            source_table: source_table.into(),
            target_schema: "main".to_string(),
            target_table: "parents".to_string(),
            columns: vec![ForeignKeyColumnDto {
                ordinal: 0,
                source_column: "parent_id".to_string(),
                target_column: Some("id".to_string()),
            }],
        }
    }

    fn bounded_index(table: impl Into<String>, name: impl Into<String>) -> IndexDto {
        IndexDto {
            schema: "main".to_string(),
            table: table.into(),
            name: name.into(),
            unique: false,
            partial: false,
            origin: IndexOriginDto::Created,
            columns: vec![IndexColumnDto {
                ordinal: 0,
                name: Some("id".to_string()),
                kind: IndexColumnKindDto::Column,
                descending: false,
                collation: Some("BINARY".to_string()),
            }],
        }
    }

    fn bounded_object(
        name: impl Into<String>,
        columns: Vec<ColumnDto>,
        columns_truncated: bool,
    ) -> BoundedSchemaObjectDto {
        BoundedSchemaObjectDto {
            object: SchemaObjectDto {
                kind: SchemaObjectKind::Table,
                name: name.into(),
                schema: Some("main".to_string()),
                columns,
                primary_key: Vec::new(),
            },
            columns_truncated,
        }
    }

    fn scripted_snapshot_adapter(
        label: &str,
        snapshots: Vec<BoundedSchemaSnapshotDto>,
        snapshot_calls: Arc<AtomicUsize>,
    ) -> (TempRoot, LocalSqlCoreAdapter) {
        let root = TempRoot::new(label);
        let registry = SqlDriverRegistry::new(vec![Box::new(ScriptedSnapshotSqliteDriver {
            snapshots: Arc::new(Mutex::new(VecDeque::from(snapshots))),
            snapshot_calls,
        })]);
        let manager = Arc::new(ConnectionManager::new(registry, root.persistence("v2")));
        let profile = sqlite_profile("workspace", Path::new("unused.db"), true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());
        (root, adapter)
    }

    fn bounded_schema_search_request() -> SchemaSearchRequest {
        SchemaSearchRequest {
            connection_id: "workspace".to_string(),
            schema: "main".to_string(),
            query: "users".to_string(),
            explicit_tables: Vec::new(),
            budget: SchemaSearchBudget::default(),
        }
    }

    fn relation_search_request(table: &str) -> RelationSearchRequest {
        RelationSearchRequest {
            connection_id: "workspace".to_string(),
            schema: "main".to_string(),
            tables: vec![SqlTableRef {
                schema: Some("main".to_string()),
                name: table.to_string(),
            }],
            max_depth: 2,
            budget: RelationSearchBudget::default(),
        }
    }

    fn index_list_request(table: &str) -> IndexListRequest {
        IndexListRequest {
            connection_id: "workspace".to_string(),
            schema: "main".to_string(),
            tables: vec![SqlTableRef {
                schema: Some("main".to_string()),
                name: table.to_string(),
            }],
            budget: IndexListBudget::default(),
        }
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
        assert_eq!(
            capabilities.metadata.foreign_keys,
            SqlCapabilitySupport::Supported
        );
        assert_eq!(
            capabilities.metadata.indexes,
            SqlCapabilitySupport::Supported
        );
        assert!(matches!(
            capabilities.metadata.comments,
            SqlCapabilitySupport::Unsupported { .. }
        ));
    }

    #[test]
    fn runtime_capability_revision_advances_after_metadata_invalidation() {
        let root = TempRoot::new("runtime-capability-revision");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let before = adapter
            .runtime_capabilities("workspace")
            .expect("resolve initial capabilities");
        adapter
            .invalidate_schema_cache("workspace")
            .expect("invalidate metadata caches");
        let after = adapter
            .runtime_capabilities("workspace")
            .expect("resolve refreshed capabilities");

        assert!(after.metadata_revision > before.metadata_revision);
    }

    #[test]
    fn sqlite_index_list_returns_revision_bound_scoped_metadata() {
        let root = TempRoot::new("index-list");
        let database = root.database("main");
        let fixture = rusqlite::Connection::open(&database).expect("open index fixture");
        fixture
            .execute_batch(
                "CREATE TABLE users(\
                    id INTEGER PRIMARY KEY,\
                    email TEXT UNIQUE,\
                    tenant_id INTEGER\
                 );\
                 CREATE INDEX idx_users_tenant_email ON users(tenant_id, email DESC);\
                 CREATE TABLE orders(id INTEGER, user_id INTEGER);\
                 CREATE INDEX idx_orders_user ON orders(user_id);",
            )
            .expect("seed index fixture");
        drop(fixture);
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let result = adapter
            .list_indexes(index_list_request("users"))
            .expect("list scoped SQLite indexes");

        assert_eq!(result.connection_id, "workspace");
        assert_eq!(result.dialect, SqlDialect::Sqlite);
        assert_eq!(result.indexes.len(), 2);
        assert!(result.indexes.iter().all(|index| index.table == "users"));
        assert!(result
            .indexes
            .iter()
            .all(|index| index.metadata_revision == result.metadata_revision));
        let composite = result
            .indexes
            .iter()
            .find(|index| index.name == "idx_users_tenant_email")
            .expect("declared composite index");
        assert_eq!(
            composite
                .columns
                .iter()
                .map(|column| (column.name.as_deref(), column.descending))
                .collect::<Vec<_>>(),
            vec![(Some("tenant_id"), false), (Some("email"), true)]
        );
        assert!(result
            .indexes
            .iter()
            .any(|index| { index.unique && index.origin == IndexContextOrigin::UniqueConstraint }));
        assert_eq!(
            result.returned_byte_count,
            serde_json::to_vec(&result).unwrap().len()
        );
        assert!(!result.truncated);
    }

    #[test]
    fn metadata_invalidation_refreshes_index_snapshot_and_revision() {
        let root = TempRoot::new("index-invalidate");
        let database = root.database("main");
        let fixture = rusqlite::Connection::open(&database).expect("open index fixture");
        fixture
            .execute_batch("CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT);")
            .expect("seed index fixture");
        drop(fixture);
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let before = adapter
            .list_indexes(index_list_request("users"))
            .expect("load initial index snapshot");
        assert!(before.indexes.is_empty());

        let fixture = rusqlite::Connection::open(&database).expect("reopen index fixture");
        fixture
            .execute_batch("CREATE INDEX idx_users_email ON users(email);")
            .expect("add index outside metadata adapter");
        drop(fixture);
        let stale = adapter
            .list_indexes(index_list_request("users"))
            .expect("reuse cached index snapshot");
        assert!(stale.indexes.is_empty());

        adapter
            .invalidate_schema_cache("workspace")
            .expect("invalidate metadata caches");
        let refreshed = adapter
            .list_indexes(index_list_request("users"))
            .expect("refresh index snapshot");

        assert_eq!(refreshed.indexes.len(), 1);
        assert_eq!(refreshed.indexes[0].name, "idx_users_email");
        assert!(refreshed.metadata_revision > before.metadata_revision);
    }

    #[test]
    fn adapter_rejects_index_snapshots_that_violate_hard_caps_or_shape() {
        let limits = MetadataIndexLimits {
            max_tables: 1,
            max_indexes: 1,
            max_columns: 1,
            max_bytes: 4 * 1024,
        };
        let valid = BoundedIndexSnapshotDto {
            indexes: vec![bounded_index("users", "idx_users_id")],
            scanned_table_count: 1,
            truncated: false,
        };
        validate_bounded_index_snapshot(&valid, "main", limits).expect("valid index snapshot");

        let mut too_many_tables = valid.clone();
        too_many_tables.scanned_table_count = 2;
        let mut too_many_indexes = valid.clone();
        too_many_indexes
            .indexes
            .push(bounded_index("users", "idx_users_other"));
        let mut too_many_columns = valid.clone();
        too_many_columns.indexes[0].columns.push(IndexColumnDto {
            ordinal: 1,
            name: Some("other".to_string()),
            kind: IndexColumnKindDto::Column,
            descending: false,
            collation: None,
        });
        let mut bad_schema = valid.clone();
        bad_schema.indexes[0].schema = "temp".to_string();
        let mut duplicate_identity = valid.clone();
        duplicate_identity.indexes.push(valid.indexes[0].clone());
        let mut bad_expression = valid.clone();
        bad_expression.indexes[0].columns[0].kind = IndexColumnKindDto::Expression;

        for snapshot in [
            too_many_tables,
            too_many_indexes,
            too_many_columns,
            bad_schema,
            duplicate_identity,
            bad_expression,
        ] {
            let error = validate_bounded_index_snapshot(&snapshot, "main", limits).unwrap_err();
            assert!(matches!(error, SqlCommandError::Internal { .. }));
        }

        let byte_error = validate_bounded_index_snapshot(
            &valid,
            "main",
            MetadataIndexLimits {
                max_bytes: 1,
                ..limits
            },
        )
        .unwrap_err();
        assert!(matches!(byte_error, SqlCommandError::Internal { .. }));
    }

    #[test]
    fn sqlite_relation_search_returns_declared_demo_foreign_key() {
        let root = TempRoot::new("relation-search");
        let database = root.database("main");
        ensure_demo_db(&database).expect("seed demo database");
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let result = adapter
            .search_relations(relation_search_request("orders"))
            .expect("search declared relationships");

        assert_eq!(result.paths.len(), 1);
        assert_eq!(
            result.paths[0]
                .nodes
                .iter()
                .map(|node| node.name.as_str())
                .collect::<Vec<_>>(),
            vec!["orders", "users"]
        );
        let edge = &result.paths[0].edges[0];
        assert_eq!(edge.source.name, "orders");
        assert_eq!(edge.target.name, "users");
        assert_eq!(edge.evidence_kind, RelationEvidenceKind::DeclaredForeignKey);
        assert_eq!(edge.columns[0].source_column, "user_id");
        assert_eq!(edge.columns[0].target_column.as_deref(), Some("id"));
        assert_eq!(edge.metadata_revision, result.metadata_revision);
        assert!(!result.truncated);
    }

    #[test]
    fn sqlite_relation_search_preserves_supported_empty_graph() {
        let root = TempRoot::new("relation-empty");
        let database = root.database("main");
        let connection =
            rusqlite::Connection::open(&database).expect("open empty relation fixture");
        connection
            .execute_batch("CREATE TABLE standalone(id INTEGER PRIMARY KEY);")
            .expect("seed empty relation fixture");
        drop(connection);
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let result = adapter
            .search_relations(relation_search_request("standalone"))
            .expect("search supported empty graph");

        assert!(result.paths.is_empty());
        assert!(!result.truncated);
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
    fn cold_search_uses_one_fixed_bounded_snapshot_without_column_fanout() {
        let root = TempRoot::new("bounded-column-io");
        let table_calls = Arc::new(AtomicUsize::new(0));
        let column_calls = Arc::new(AtomicUsize::new(0));
        let snapshot_calls = Arc::new(AtomicUsize::new(0));
        let snapshot_limits = Arc::new(Mutex::new(Vec::new()));
        let registry = SqlDriverRegistry::new(vec![Box::new(CountingSqliteDriver {
            table_count: 64,
            table_calls: Arc::clone(&table_calls),
            column_calls: Arc::clone(&column_calls),
            snapshot_calls: Arc::clone(&snapshot_calls),
            snapshot_limits: Arc::clone(&snapshot_limits),
        })]);
        let manager = Arc::new(ConnectionManager::new(registry, root.persistence("v2")));
        let profile = sqlite_profile("workspace", Path::new("unused.db"), true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let result = adapter
            .search_schema(SchemaSearchRequest {
                connection_id: "workspace".to_string(),
                schema: "main".to_string(),
                query: "target_table".to_string(),
                explicit_tables: Vec::new(),
                budget: SchemaSearchBudget {
                    max_objects: 1,
                    max_columns: 8,
                    max_bytes: 4 * 1024,
                },
            })
            .expect("search exact object");

        assert_eq!(result.matches[0].object.name, "target_table");
        assert_eq!(snapshot_calls.load(Ordering::Relaxed), 1);
        assert_eq!(table_calls.load(Ordering::Relaxed), 0);
        assert_eq!(column_calls.load(Ordering::Relaxed), 0);
        assert_eq!(
            snapshot_limits
                .lock()
                .expect("snapshot limits poisoned")
                .as_slice(),
            &[MetadataSnapshotLimits {
                max_objects: 100,
                max_columns: 1_000,
                max_bytes: 256 * 1024,
            }]
        );
    }

    #[test]
    fn relation_search_reuses_one_fixed_hard_capped_graph_snapshot() {
        let root = TempRoot::new("bounded-relation-io");
        let calls = Arc::new(AtomicUsize::new(0));
        let limits = Arc::new(Mutex::new(Vec::new()));
        let registry = SqlDriverRegistry::new(vec![Box::new(CountingRelationSqliteDriver {
            calls: Arc::clone(&calls),
            limits: Arc::clone(&limits),
        })]);
        let manager = Arc::new(ConnectionManager::new(registry, root.persistence("v2")));
        let profile = sqlite_profile("workspace", Path::new("unused.db"), true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let first = adapter
            .search_relations(relation_search_request("orders"))
            .expect("search cold relation graph");
        let second = adapter
            .search_relations(relation_search_request("orders"))
            .expect("reuse relation graph");

        assert_eq!(first, second);
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        assert_eq!(
            limits
                .lock()
                .expect("foreign-key limits poisoned")
                .as_slice(),
            &[MetadataForeignKeyLimits {
                max_tables: 100,
                max_foreign_keys: 512,
                max_columns: 1_024,
                max_bytes: 256 * 1024,
            }]
        );
    }

    #[test]
    fn relation_search_rejects_invalid_limits_before_driver_metadata_io() {
        let root = TempRoot::new("invalid-relation-request");
        let calls = Arc::new(AtomicUsize::new(0));
        let limits = Arc::new(Mutex::new(Vec::new()));
        let registry = SqlDriverRegistry::new(vec![Box::new(CountingRelationSqliteDriver {
            calls: Arc::clone(&calls),
            limits,
        })]);
        let manager = Arc::new(ConnectionManager::new(registry, root.persistence("v2")));
        let profile = sqlite_profile("workspace", Path::new("unused.db"), true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let mut too_many_tables = relation_search_request("orders");
        too_many_tables.tables = (0..33)
            .map(|index| SqlTableRef {
                schema: Some("main".to_string()),
                name: format!("table_{index}"),
            })
            .collect();
        let mut invalid_depth = relation_search_request("orders");
        invalid_depth.max_depth = 3;
        let mut invalid_budget = relation_search_request("orders");
        invalid_budget.budget.max_paths = 129;

        for request in [too_many_tables, invalid_depth, invalid_budget] {
            let error = adapter.search_relations(request).unwrap_err();
            assert!(matches!(error, SqlCommandError::InvalidInput { .. }));
        }
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn adapter_rejects_driver_snapshots_that_exceed_each_hard_cap() {
        let object_overflow = BoundedSchemaSnapshotDto {
            objects: (0..=SCHEMA_SNAPSHOT_LIMITS.max_objects)
                .map(|index| bounded_object(format!("t{index}"), Vec::new(), false))
                .collect(),
            truncated: true,
        };
        let column_overflow = BoundedSchemaSnapshotDto {
            objects: vec![bounded_object(
                "users",
                (0..=SCHEMA_SNAPSHOT_LIMITS.max_columns)
                    .map(bounded_column)
                    .collect(),
                true,
            )],
            truncated: true,
        };
        let byte_overflow = BoundedSchemaSnapshotDto {
            objects: vec![bounded_object(
                "x".repeat(SCHEMA_SNAPSHOT_LIMITS.max_bytes),
                Vec::new(),
                false,
            )],
            truncated: true,
        };

        for (label, snapshot) in [
            ("object-contract", object_overflow),
            ("column-contract", column_overflow),
            ("byte-contract", byte_overflow),
        ] {
            let calls = Arc::new(AtomicUsize::new(0));
            let (_root, adapter) =
                scripted_snapshot_adapter(label, vec![snapshot], Arc::clone(&calls));

            let error = adapter
                .search_schema(bounded_schema_search_request())
                .unwrap_err();

            assert!(matches!(
                error,
                SqlCommandError::Internal { message }
                    if message == "SQL driver violated the bounded schema snapshot contract"
            ));
            assert_eq!(calls.load(Ordering::Relaxed), 1);
        }
    }

    #[test]
    fn adapter_rejects_foreign_key_snapshots_that_violate_hard_caps_or_shape() {
        let relation_overflow = BoundedForeignKeySnapshotDto {
            foreign_keys: vec![
                bounded_foreign_key("children");
                FOREIGN_KEY_SNAPSHOT_LIMITS.max_foreign_keys + 1
            ],
            scanned_table_count: 1,
            truncated: true,
        };
        let mut column_overflow_key = bounded_foreign_key("children");
        column_overflow_key.columns = (0..=FOREIGN_KEY_SNAPSHOT_LIMITS.max_columns)
            .map(|index| ForeignKeyColumnDto {
                ordinal: i32::try_from(index).expect("test ordinal fits i32"),
                source_column: format!("source_{index}"),
                target_column: Some(format!("target_{index}")),
            })
            .collect();
        let column_overflow = BoundedForeignKeySnapshotDto {
            foreign_keys: vec![column_overflow_key],
            scanned_table_count: 1,
            truncated: true,
        };
        let table_overflow = BoundedForeignKeySnapshotDto {
            foreign_keys: Vec::new(),
            scanned_table_count: FOREIGN_KEY_SNAPSHOT_LIMITS.max_tables + 1,
            truncated: true,
        };
        let byte_overflow = BoundedForeignKeySnapshotDto {
            foreign_keys: vec![bounded_foreign_key(
                "x".repeat(FOREIGN_KEY_SNAPSHOT_LIMITS.max_bytes),
            )],
            scanned_table_count: 1,
            truncated: true,
        };
        let malformed = BoundedForeignKeySnapshotDto {
            foreign_keys: vec![ForeignKeyDto {
                columns: Vec::new(),
                ..bounded_foreign_key("children")
            }],
            scanned_table_count: 1,
            truncated: false,
        };

        for snapshot in [
            relation_overflow,
            column_overflow,
            table_overflow,
            byte_overflow,
            malformed,
        ] {
            let error = validate_bounded_foreign_key_snapshot(
                &snapshot,
                "main",
                FOREIGN_KEY_SNAPSHOT_LIMITS,
            )
            .unwrap_err();
            assert!(matches!(
                error,
                SqlCommandError::Internal { message }
                    if message == "SQL driver violated the bounded foreign-key snapshot contract"
            ));
        }
    }

    #[test]
    fn adapter_rejects_non_contiguous_foreign_key_ordinals() {
        let mut nonzero_start = bounded_foreign_key("children");
        nonzero_start.columns[0].ordinal = 1;
        let mut ordinal_gap = bounded_foreign_key("children");
        ordinal_gap.columns.push(ForeignKeyColumnDto {
            ordinal: 2,
            source_column: "other_parent_id".to_string(),
            target_column: Some("other_id".to_string()),
        });

        for foreign_key in [nonzero_start, ordinal_gap] {
            let snapshot = BoundedForeignKeySnapshotDto {
                foreign_keys: vec![foreign_key],
                scanned_table_count: 1,
                truncated: false,
            };
            let error = validate_bounded_foreign_key_snapshot(
                &snapshot,
                "main",
                FOREIGN_KEY_SNAPSHOT_LIMITS,
            )
            .unwrap_err();
            assert!(matches!(error, SqlCommandError::Internal { .. }));
        }
    }

    #[test]
    fn adapter_rejects_inconsistent_truncation_and_does_not_cache_it() {
        let invalid = BoundedSchemaSnapshotDto {
            objects: vec![bounded_object("users", Vec::new(), true)],
            truncated: false,
        };
        let valid = BoundedSchemaSnapshotDto {
            objects: vec![bounded_object("users", Vec::new(), false)],
            truncated: false,
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let (_root, adapter) = scripted_snapshot_adapter(
            "truncation-contract",
            vec![invalid, valid],
            Arc::clone(&calls),
        );

        let error = adapter
            .search_schema(bounded_schema_search_request())
            .unwrap_err();
        let recovered = adapter
            .search_schema(bounded_schema_search_request())
            .expect("retry after rejected snapshot");

        assert!(matches!(
            error,
            SqlCommandError::Internal { message }
                if message == "SQL driver violated the bounded schema snapshot contract"
        ));
        assert_eq!(recovered.matches[0].object.name, "users");
        assert_eq!(calls.load(Ordering::Relaxed), 2);
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
    fn metadata_invalidation_refreshes_relation_graph_and_revision() {
        let root = TempRoot::new("relation-invalidate");
        let database = root.database("main");
        let fixture = rusqlite::Connection::open(&database).expect("open relation fixture");
        fixture
            .execute_batch(
                "CREATE TABLE users(id INTEGER PRIMARY KEY);\
                 CREATE TABLE orders(id INTEGER PRIMARY KEY, user_id INTEGER);",
            )
            .expect("seed relation fixture");
        drop(fixture);
        let manager = sqlite_manager(&root);
        let profile = sqlite_profile("workspace", &database, true);
        open_profile(&manager, &profile, ConnectionSecret::default());
        let adapter = LocalSqlCoreAdapter::new(manager, empty_legacy_store());

        let before = adapter
            .search_relations(relation_search_request("orders"))
            .expect("initial relation search");
        assert!(before.paths.is_empty());

        let fixture = rusqlite::Connection::open(&database).expect("reopen relation fixture");
        fixture
            .execute_batch(
                "DROP TABLE orders;\
                 CREATE TABLE orders(\
                    id INTEGER PRIMARY KEY,\
                    user_id INTEGER REFERENCES users(id)\
                 );",
            )
            .expect("add declared relation");
        drop(fixture);

        let stale = adapter
            .search_relations(relation_search_request("orders"))
            .expect("reuse cached relation graph");
        assert!(stale.paths.is_empty());

        adapter
            .invalidate_schema_cache("workspace")
            .expect("invalidate metadata caches");
        let refreshed = adapter
            .search_relations(relation_search_request("orders"))
            .expect("refresh relation graph");

        assert_eq!(refreshed.paths.len(), 1);
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

        fn list_foreign_keys_bounded(
            &self,
            _schema: &str,
            _limits: MetadataForeignKeyLimits,
        ) -> Result<BoundedForeignKeySnapshotDto, SqlCommandError> {
            self.metadata_calls.fetch_add(1, Ordering::Relaxed);
            Err(SqlCommandError::new(
                "internal",
                "MySQL foreign-key metadata must remain capability-gated",
            ))
        }

        fn list_indexes_bounded(
            &self,
            _schema: &str,
            _limits: MetadataIndexLimits,
        ) -> Result<BoundedIndexSnapshotDto, SqlCommandError> {
            self.metadata_calls.fetch_add(1, Ordering::Relaxed);
            Err(SqlCommandError::new(
                "internal",
                "MySQL index metadata must remain capability-gated",
            ))
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
        assert!(matches!(
            capabilities.metadata.foreign_keys,
            SqlCapabilitySupport::Unsupported { .. }
        ));
        assert!(matches!(
            capabilities.metadata.indexes,
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

        let error = adapter
            .list_indexes(IndexListRequest {
                connection_id: "workspace".to_string(),
                schema: "app".to_string(),
                tables: vec![SqlTableRef {
                    schema: Some("app".to_string()),
                    name: "users".to_string(),
                }],
                budget: IndexListBudget::default(),
            })
            .unwrap_err();
        assert!(matches!(
            error,
            SqlCommandError::Validation { message }
                if message == MYSQL_METADATA_UNSUPPORTED
        ));

        let error = adapter
            .search_relations(RelationSearchRequest {
                connection_id: "workspace".to_string(),
                schema: "app".to_string(),
                tables: vec![SqlTableRef {
                    schema: Some("app".to_string()),
                    name: "users".to_string(),
                }],
                max_depth: 1,
                budget: RelationSearchBudget::default(),
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
        assert!(matches!(
            capabilities.foreign_keys,
            SqlCapabilitySupport::Unsupported { .. }
        ));
        assert!(matches!(
            capabilities.indexes,
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
        assert!(matches!(
            capabilities.foreign_keys,
            SqlCapabilitySupport::Unsupported { .. }
        ));
        assert!(matches!(
            capabilities.indexes,
            SqlCapabilitySupport::Unsupported { .. }
        ));
    }
}
