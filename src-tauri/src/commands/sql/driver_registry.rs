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

use super::metadata_v2::{
    BoundedForeignKeySnapshotDto, BoundedIndexSnapshotDto, BoundedSchemaObjectDto,
    BoundedSchemaSnapshotDto, ColumnDto, ForeignKeyColumnDto, ForeignKeyDto, IndexColumnDto,
    IndexColumnKindDto, IndexDto, IndexOriginDto, MetadataForeignKeyLimits, MetadataIndexLimits,
    MetadataSnapshotLimits, SchemaObjectDto, SchemaObjectKind, SchemataDto,
};
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

    /// Loads a driver-enforced schema snapshot. Implementations must stop
    /// before crossing any limit; an unsupported driver fails closed.
    fn list_schema_snapshot_bounded(
        &self,
        _schema: &str,
        _limits: MetadataSnapshotLimits,
    ) -> Result<BoundedSchemaSnapshotDto, SqlCommandError> {
        Err(SqlCommandError::new(
            "validation",
            "bounded schema snapshots are unsupported by this driver",
        ))
    }

    /// Loads declared foreign-key metadata under hard driver-enforced
    /// budgets. Unsupported drivers fail closed instead of returning an
    /// ambiguous empty result.
    fn list_foreign_keys_bounded(
        &self,
        _schema: &str,
        _limits: MetadataForeignKeyLimits,
    ) -> Result<BoundedForeignKeySnapshotDto, SqlCommandError> {
        Err(SqlCommandError::new(
            "validation",
            "bounded foreign-key metadata is unsupported by this driver",
        ))
    }

    /// Loads index metadata under hard driver-enforced budgets. Unsupported
    /// drivers fail closed instead of returning an ambiguous empty result.
    fn list_indexes_bounded(
        &self,
        _schema: &str,
        _limits: MetadataIndexLimits,
    ) -> Result<BoundedIndexSnapshotDto, SqlCommandError> {
        Err(SqlCommandError::new(
            "validation",
            "bounded index metadata is unsupported by this driver",
        ))
    }
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

use rusqlite::{Connection as SqliteRawConnection, Row as SqliteRow};

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

struct BoundedSchemaSnapshotBuilder {
    snapshot: BoundedSchemaSnapshotDto,
    serialized_bytes: usize,
    column_count: usize,
    limits: MetadataSnapshotLimits,
}

struct BoundedForeignKeySnapshotBuilder {
    snapshot: BoundedForeignKeySnapshotDto,
    column_count: usize,
    limits: MetadataForeignKeyLimits,
}

struct BoundedIndexSnapshotBuilder {
    snapshot: BoundedIndexSnapshotDto,
    column_count: usize,
    limits: MetadataIndexLimits,
}

impl BoundedIndexSnapshotBuilder {
    fn new(limits: MetadataIndexLimits) -> Result<Self, SqlCommandError> {
        let snapshot = BoundedIndexSnapshotDto {
            indexes: Vec::new(),
            scanned_table_count: 0,
            truncated: false,
        };
        if serialized_len(&snapshot)? > limits.max_bytes {
            return Err(SqlCommandError::new(
                "invalid_input",
                "index snapshot byte limit is too small for the result envelope",
            ));
        }
        Ok(Self {
            snapshot,
            column_count: 0,
            limits,
        })
    }

    fn push(&mut self, index: IndexDto) -> Result<bool, SqlCommandError> {
        let next_column_count = self
            .column_count
            .checked_add(index.columns.len())
            .ok_or_else(|| SqlCommandError::new("invalid_input", "index column limit overflow"))?;
        if self.snapshot.indexes.len() >= self.limits.max_indexes
            || next_column_count > self.limits.max_columns
        {
            self.snapshot.truncated = true;
            return Ok(false);
        }

        self.snapshot.indexes.push(index);
        if serialized_len(&self.snapshot)? > self.limits.max_bytes {
            self.snapshot.indexes.pop();
            self.snapshot.truncated = true;
            return Ok(false);
        }
        self.column_count = next_column_count;
        Ok(true)
    }

    fn remaining_index_capacity(&self) -> usize {
        self.limits
            .max_indexes
            .saturating_sub(self.snapshot.indexes.len())
    }

    fn remaining_column_capacity(&self) -> usize {
        self.limits.max_columns.saturating_sub(self.column_count)
    }

    fn record_scanned_table(&mut self) -> Result<bool, SqlCommandError> {
        if self.snapshot.scanned_table_count == self.limits.max_tables {
            self.mark_truncated();
            return Ok(false);
        }
        let previous_count = self.snapshot.scanned_table_count;
        self.snapshot.scanned_table_count = self
            .snapshot
            .scanned_table_count
            .checked_add(1)
            .ok_or_else(|| SqlCommandError::new("internal", "SQLite table count overflow"))?;
        if serialized_len(&self.snapshot)? > self.limits.max_bytes {
            self.snapshot.scanned_table_count = previous_count;
            self.mark_truncated();
            return Ok(false);
        }
        Ok(true)
    }

    fn mark_truncated(&mut self) {
        self.snapshot.truncated = true;
    }

    fn finish(self) -> Result<BoundedIndexSnapshotDto, SqlCommandError> {
        if serialized_len(&self.snapshot)? > self.limits.max_bytes {
            return Err(SqlCommandError::new(
                "internal",
                "bounded SQLite index snapshot exceeded its byte limit",
            ));
        }
        Ok(self.snapshot)
    }
}

impl BoundedForeignKeySnapshotBuilder {
    fn new(limits: MetadataForeignKeyLimits) -> Result<Self, SqlCommandError> {
        let snapshot = BoundedForeignKeySnapshotDto {
            foreign_keys: Vec::new(),
            scanned_table_count: 0,
            truncated: false,
        };
        if serialized_len(&snapshot)? > limits.max_bytes {
            return Err(SqlCommandError::new(
                "invalid_input",
                "foreign-key snapshot byte limit is too small for the result envelope",
            ));
        }
        Ok(Self {
            snapshot,
            column_count: 0,
            limits,
        })
    }

    fn push(&mut self, foreign_key: ForeignKeyDto) -> Result<bool, SqlCommandError> {
        let next_column_count = self
            .column_count
            .checked_add(foreign_key.columns.len())
            .ok_or_else(|| {
                SqlCommandError::new("invalid_input", "foreign-key column limit overflow")
            })?;
        if self.snapshot.foreign_keys.len() >= self.limits.max_foreign_keys
            || next_column_count > self.limits.max_columns
        {
            self.snapshot.truncated = true;
            return Ok(false);
        }

        self.snapshot.foreign_keys.push(foreign_key);
        if serialized_len(&self.snapshot)? > self.limits.max_bytes {
            self.snapshot.foreign_keys.pop();
            self.snapshot.truncated = true;
            return Ok(false);
        }
        self.column_count = next_column_count;
        Ok(true)
    }

    fn can_collect_foreign_key(&self) -> bool {
        self.snapshot.foreign_keys.len() < self.limits.max_foreign_keys
    }

    fn can_collect_column(&self, current_relation_columns: usize) -> bool {
        self.column_count
            .checked_add(current_relation_columns)
            .is_some_and(|count| count < self.limits.max_columns)
    }

    fn mark_truncated(&mut self) {
        self.snapshot.truncated = true;
    }

    fn record_scanned_table(&mut self) -> Result<bool, SqlCommandError> {
        if self.snapshot.scanned_table_count == self.limits.max_tables {
            self.mark_truncated();
            return Ok(false);
        }
        let previous_count = self.snapshot.scanned_table_count;
        self.snapshot.scanned_table_count = self
            .snapshot
            .scanned_table_count
            .checked_add(1)
            .ok_or_else(|| SqlCommandError::new("internal", "SQLite table count overflow"))?;
        if serialized_len(&self.snapshot)? > self.limits.max_bytes {
            self.snapshot.scanned_table_count = previous_count;
            self.mark_truncated();
            return Ok(false);
        }
        Ok(true)
    }

    fn finish(self) -> Result<BoundedForeignKeySnapshotDto, SqlCommandError> {
        if serialized_len(&self.snapshot)? > self.limits.max_bytes {
            return Err(SqlCommandError::new(
                "internal",
                "bounded SQLite foreign-key snapshot exceeded its byte limit",
            ));
        }
        Ok(self.snapshot)
    }
}

impl BoundedSchemaSnapshotBuilder {
    fn new(limits: MetadataSnapshotLimits) -> Result<Self, SqlCommandError> {
        let snapshot = BoundedSchemaSnapshotDto {
            objects: Vec::new(),
            truncated: false,
        };
        let serialized_bytes = serialized_len(&snapshot)?;
        if serialized_bytes > limits.max_bytes {
            return Err(SqlCommandError::new(
                "invalid_input",
                "schema snapshot byte limit is too small for the result envelope",
            ));
        }
        Ok(Self {
            snapshot,
            serialized_bytes,
            column_count: 0,
            limits,
        })
    }

    fn push_object(
        &mut self,
        schema: &str,
        kind: SchemaObjectKind,
        name: String,
    ) -> Result<bool, SqlCommandError> {
        if self.snapshot.objects.len() >= self.limits.max_objects {
            self.snapshot.truncated = true;
            return Ok(false);
        }
        let object = BoundedSchemaObjectDto {
            object: SchemaObjectDto {
                kind,
                name,
                schema: Some(schema.to_string()),
                columns: Vec::new(),
                primary_key: Vec::new(),
            },
            columns_truncated: false,
        };
        let separator_bytes = usize::from(!self.snapshot.objects.is_empty());
        let object_bytes = serialized_len(&object)?;
        if !self.has_byte_capacity(separator_bytes, object_bytes) {
            self.snapshot.truncated = true;
            return Ok(false);
        }
        self.serialized_bytes += separator_bytes + object_bytes;
        self.snapshot.objects.push(object);
        Ok(true)
    }

    fn has_column_capacity(&self) -> bool {
        self.column_count < self.limits.max_columns
    }

    fn truncate_current_columns(&mut self) {
        if let Some(object) = self.snapshot.objects.last_mut() {
            object.columns_truncated = true;
        }
        self.snapshot.truncated = true;
    }

    fn mark_truncated(&mut self) {
        self.snapshot.truncated = true;
    }

    fn push_column(&mut self, column: ColumnDto) -> Result<bool, SqlCommandError> {
        if !self.has_column_capacity() {
            self.truncate_current_columns();
            return Ok(false);
        }
        let current_object = self
            .snapshot
            .objects
            .last()
            .ok_or_else(|| SqlCommandError::new("internal", "schema row has no object"))?;
        let separator_bytes = usize::from(!current_object.object.columns.is_empty());
        let column_bytes = serialized_len(&column)?;
        if !self.has_byte_capacity(separator_bytes, column_bytes) {
            self.truncate_current_columns();
            return Ok(false);
        }
        self.serialized_bytes += separator_bytes + column_bytes;
        self.snapshot
            .objects
            .last_mut()
            .ok_or_else(|| SqlCommandError::new("internal", "schema row has no object"))?
            .object
            .columns
            .push(column);
        self.column_count += 1;
        Ok(true)
    }

    fn has_byte_capacity(&self, separator_bytes: usize, value_bytes: usize) -> bool {
        self.serialized_bytes
            .checked_add(separator_bytes)
            .and_then(|bytes| bytes.checked_add(value_bytes))
            .is_some_and(|bytes| bytes <= self.limits.max_bytes)
    }

    fn finish(self) -> Result<BoundedSchemaSnapshotDto, SqlCommandError> {
        if serialized_len(&self.snapshot)? > self.limits.max_bytes {
            return Err(SqlCommandError::new(
                "internal",
                "bounded SQLite schema snapshot exceeded its byte limit",
            ));
        }
        Ok(self.snapshot)
    }
}

fn sqlite_snapshot_object(
    row: &SqliteRow<'_>,
) -> Result<(SchemaObjectKind, String), SqlCommandError> {
    let object_type: String = row
        .get(0)
        .map_err(|error| SqlCommandError::new("sqlite_iter", error.to_string()))?;
    let object_name = row
        .get(1)
        .map_err(|error| SqlCommandError::new("sqlite_iter", error.to_string()))?;
    let kind = if object_type.eq_ignore_ascii_case("view") {
        SchemaObjectKind::View
    } else {
        SchemaObjectKind::Table
    };
    Ok((kind, object_name))
}

fn sqlite_snapshot_column(row: &SqliteRow<'_>) -> Result<ColumnDto, SqlCommandError> {
    Ok(ColumnDto {
        name: row
            .get(1)
            .map_err(|error| SqlCommandError::new("sqlite_iter", error.to_string()))?,
        data_type: row
            .get(2)
            .map_err(|error| SqlCommandError::new("sqlite_iter", error.to_string()))?,
        is_nullable: row
            .get::<_, i64>(3)
            .map_err(|error| SqlCommandError::new("sqlite_iter", error.to_string()))?
            == 0,
        is_primary_key: row
            .get::<_, i64>(4)
            .map_err(|error| SqlCommandError::new("sqlite_iter", error.to_string()))?
            > 0,
        default_value: None,
        comment: None,
        ordinal: row
            .get(0)
            .map_err(|error| SqlCommandError::new("sqlite_iter", error.to_string()))?,
    })
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

    fn list_schema_snapshot_bounded(
        &self,
        schema: &str,
        limits: MetadataSnapshotLimits,
    ) -> Result<BoundedSchemaSnapshotDto, SqlCommandError> {
        if schema != "main" {
            return Err(SqlCommandError::new(
                "invalid_schema",
                "SQLite only supports the 'main' schema",
            ));
        }

        let object_probe_limit = limits
            .max_objects
            .checked_add(1)
            .and_then(|limit| i64::try_from(limit).ok())
            .ok_or_else(|| {
                SqlCommandError::new("invalid_input", "schema object limit is too large")
            })?;
        let mut snapshot = BoundedSchemaSnapshotBuilder::new(limits)?;

        let conn = self.conn.lock().map_err(|err| {
            SqlCommandError::new(
                "sqlite_locked",
                format!("sqlite connection poisoned: {err}"),
            )
        })?;
        let objects = {
            let mut stmt = conn
                .prepare(
                    "SELECT type, name FROM sqlite_schema \
                     WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
                     ORDER BY type, name LIMIT ?1",
                )
                .map_err(|err| SqlCommandError::new("sqlite_prepare", err.to_string()))?;
            let mut rows = stmt
                .query([object_probe_limit])
                .map_err(|err| SqlCommandError::new("sqlite_query", err.to_string()))?;
            let mut objects = Vec::new();
            while let Some(row) = rows
                .next()
                .map_err(|err| SqlCommandError::new("sqlite_iter", err.to_string()))?
            {
                objects.push(sqlite_snapshot_object(row)?);
            }
            objects
        };
        let has_more_objects = objects.len() > limits.max_objects;
        let mut column_stmt = conn
            .prepare(
                "SELECT cid, name, type, [notnull], pk \
                 FROM pragma_table_info(?1) LIMIT ?2",
            )
            .map_err(|err| SqlCommandError::new("sqlite_prepare", err.to_string()))?;

        'objects: for (object_kind, object_name) in objects.into_iter().take(limits.max_objects) {
            if !snapshot.push_object(schema, object_kind, object_name.clone())? {
                break;
            }
            if !snapshot.has_column_capacity() {
                snapshot.truncate_current_columns();
                break;
            }
            let remaining_columns = limits.max_columns.saturating_sub(snapshot.column_count);
            let row_probe_limit = remaining_columns
                .checked_add(1)
                .and_then(|limit| i64::try_from(limit).ok())
                .ok_or_else(|| {
                    SqlCommandError::new("invalid_input", "schema column limit is too large")
                })?;
            let mut rows = column_stmt
                .query(rusqlite::params![object_name, row_probe_limit])
                .map_err(|err| SqlCommandError::new("sqlite_query", err.to_string()))?;
            while let Some(row) = rows
                .next()
                .map_err(|err| SqlCommandError::new("sqlite_iter", err.to_string()))?
            {
                if !snapshot.push_column(sqlite_snapshot_column(row)?)? {
                    break 'objects;
                }
            }
        }
        if has_more_objects {
            snapshot.mark_truncated();
        }

        snapshot.finish()
    }

    #[allow(clippy::too_many_lines)]
    fn list_foreign_keys_bounded(
        &self,
        schema: &str,
        limits: MetadataForeignKeyLimits,
    ) -> Result<BoundedForeignKeySnapshotDto, SqlCommandError> {
        if schema != "main" {
            return Err(SqlCommandError::new(
                "invalid_schema",
                "SQLite only supports the 'main' schema",
            ));
        }

        let table_probe_limit = limits
            .max_tables
            .checked_add(1)
            .and_then(|limit| i64::try_from(limit).ok())
            .ok_or_else(|| SqlCommandError::new("invalid_input", "table limit is too large"))?;
        let mut snapshot = BoundedForeignKeySnapshotBuilder::new(limits)?;
        let conn = self.conn.lock().map_err(|err| {
            SqlCommandError::new(
                "sqlite_locked",
                format!("sqlite connection poisoned: {err}"),
            )
        })?;
        let table_names = {
            let mut stmt = conn
                .prepare(
                    "SELECT name FROM sqlite_schema \
                     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
                     ORDER BY name LIMIT ?1",
                )
                .map_err(|err| SqlCommandError::new("sqlite_prepare", err.to_string()))?;
            let rows = stmt
                .query_map([table_probe_limit], |row| row.get::<_, String>(0))
                .map_err(|err| SqlCommandError::new("sqlite_query", err.to_string()))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|err| SqlCommandError::new("sqlite_iter", err.to_string()))?
        };
        let has_more_tables = table_names.len() > limits.max_tables;
        let mut foreign_key_stmt = conn
            .prepare(
                "SELECT id, seq, [table], [from], [to] \
                 FROM pragma_foreign_key_list(?1) LIMIT ?2",
            )
            .map_err(|err| SqlCommandError::new("sqlite_prepare", err.to_string()))?;

        'tables: for source_table in table_names.into_iter().take(limits.max_tables) {
            if !snapshot.record_scanned_table()? {
                break;
            }
            let remaining_columns = limits.max_columns.saturating_sub(snapshot.column_count);
            let row_probe_limit = remaining_columns
                .checked_add(1)
                .and_then(|limit| i64::try_from(limit).ok())
                .ok_or_else(|| {
                    SqlCommandError::new("invalid_input", "foreign-key row limit is too large")
                })?;
            let rows = foreign_key_stmt
                .query_map(rusqlite::params![source_table, row_probe_limit], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i32>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                })
                .map_err(|err| SqlCommandError::new("sqlite_query", err.to_string()))?;
            let mut foreign_key_rows = rows
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| SqlCommandError::new("sqlite_iter", err.to_string()))?;
            foreign_key_rows
                .sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));

            let mut current_foreign_key_id: Option<i64> = None;
            let mut current_foreign_key: Option<ForeignKeyDto> = None;
            for (foreign_key_id, ordinal, target_table, source_column, target_column) in
                foreign_key_rows
            {
                if current_foreign_key_id != Some(foreign_key_id) {
                    if let Some(foreign_key) = current_foreign_key.take() {
                        if !snapshot.push(foreign_key)? {
                            break 'tables;
                        }
                    }
                    if !snapshot.can_collect_foreign_key() {
                        snapshot.mark_truncated();
                        break 'tables;
                    }
                    current_foreign_key_id = Some(foreign_key_id);
                    current_foreign_key = Some(ForeignKeyDto {
                        source_schema: schema.to_string(),
                        source_table: source_table.clone(),
                        target_schema: schema.to_string(),
                        target_table,
                        columns: Vec::new(),
                    });
                }

                let current_relation = current_foreign_key.as_mut().ok_or_else(|| {
                    SqlCommandError::new("internal", "SQLite foreign-key row has no relation")
                })?;
                if !snapshot.can_collect_column(current_relation.columns.len()) {
                    snapshot.mark_truncated();
                    break 'tables;
                }
                current_relation.columns.push(ForeignKeyColumnDto {
                    ordinal,
                    source_column,
                    target_column,
                });
                if serialized_len(current_relation)? > limits.max_bytes {
                    snapshot.mark_truncated();
                    break 'tables;
                }
            }

            if let Some(foreign_key) = current_foreign_key {
                if !snapshot.push(foreign_key)? {
                    break;
                }
            }
        }
        if has_more_tables {
            snapshot.mark_truncated();
        }
        snapshot.finish()
    }

    #[allow(clippy::too_many_lines)]
    fn list_indexes_bounded(
        &self,
        schema: &str,
        limits: MetadataIndexLimits,
    ) -> Result<BoundedIndexSnapshotDto, SqlCommandError> {
        if schema != "main" {
            return Err(SqlCommandError::new(
                "invalid_schema",
                "SQLite only supports the 'main' schema",
            ));
        }

        let table_probe_limit = limits
            .max_tables
            .checked_add(1)
            .and_then(|limit| i64::try_from(limit).ok())
            .ok_or_else(|| SqlCommandError::new("invalid_input", "table limit is too large"))?;
        let mut snapshot = BoundedIndexSnapshotBuilder::new(limits)?;
        let conn = self.conn.lock().map_err(|err| {
            SqlCommandError::new(
                "sqlite_locked",
                format!("sqlite connection poisoned: {err}"),
            )
        })?;
        let table_names = sqlite_bounded_table_names(&conn, table_probe_limit)?;
        let has_more_tables = table_names.len() > limits.max_tables;
        let mut index_stmt = conn
            .prepare(
                "SELECT name, [unique], origin, partial \
                 FROM pragma_index_list(?1, 'main') LIMIT ?2",
            )
            .map_err(|err| SqlCommandError::new("sqlite_prepare", err.to_string()))?;
        let mut column_stmt = conn
            .prepare(
                "SELECT seqno, cid, name, [desc], coll \
                 FROM pragma_index_xinfo(?1, 'main') WHERE [key] = 1 LIMIT ?2",
            )
            .map_err(|err| SqlCommandError::new("sqlite_prepare", err.to_string()))?;

        'tables: for table in table_names.into_iter().take(limits.max_tables) {
            if !snapshot.record_scanned_table()? {
                break;
            }
            let index_probe_limit = snapshot
                .remaining_index_capacity()
                .checked_add(1)
                .and_then(|limit| i64::try_from(limit).ok())
                .ok_or_else(|| SqlCommandError::new("invalid_input", "index limit is too large"))?;
            let mut index_rows = index_stmt
                .query_map(rusqlite::params![table, index_probe_limit], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, bool>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, bool>(3)?,
                    ))
                })
                .map_err(|err| SqlCommandError::new("sqlite_query", err.to_string()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| SqlCommandError::new("sqlite_iter", err.to_string()))?;
            index_rows.sort_by(|left, right| left.0.cmp(&right.0));
            let has_more_indexes = index_rows.len() > snapshot.remaining_index_capacity();

            for (name, unique, origin, partial) in index_rows
                .into_iter()
                .take(snapshot.remaining_index_capacity())
            {
                let column_probe_limit = snapshot
                    .remaining_column_capacity()
                    .checked_add(1)
                    .and_then(|limit| i64::try_from(limit).ok())
                    .ok_or_else(|| {
                        SqlCommandError::new("invalid_input", "index column limit is too large")
                    })?;
                let mut column_rows = column_stmt
                    .query_map(rusqlite::params![name, column_probe_limit], |row| {
                        Ok((
                            row.get::<_, i32>(0)?,
                            row.get::<_, i32>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, bool>(3)?,
                            row.get::<_, Option<String>>(4)?,
                        ))
                    })
                    .map_err(|err| SqlCommandError::new("sqlite_query", err.to_string()))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|err| SqlCommandError::new("sqlite_iter", err.to_string()))?;
                column_rows.sort_by_key(|row| row.0);
                if column_rows.len() > snapshot.remaining_column_capacity() {
                    snapshot.mark_truncated();
                    break 'tables;
                }
                if column_rows.is_empty() {
                    return Err(SqlCommandError::new(
                        "internal",
                        "SQLite returned an index without key columns",
                    ));
                }
                let columns = column_rows
                    .into_iter()
                    .map(map_sqlite_index_column)
                    .collect::<Result<Vec<_>, _>>()?;
                let index = IndexDto {
                    schema: schema.to_string(),
                    table: table.clone(),
                    name,
                    unique,
                    partial,
                    origin: map_sqlite_index_origin(&origin)?,
                    columns,
                };
                if !snapshot.push(index)? {
                    break 'tables;
                }
            }

            if has_more_indexes {
                snapshot.mark_truncated();
                break;
            }
        }
        if has_more_tables {
            snapshot.mark_truncated();
        }
        snapshot.finish()
    }
}

fn sqlite_bounded_table_names(
    conn: &SqliteRawConnection,
    probe_limit: i64,
) -> Result<Vec<String>, SqlCommandError> {
    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_schema \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
             ORDER BY name LIMIT ?1",
        )
        .map_err(|err| SqlCommandError::new("sqlite_prepare", err.to_string()))?;
    let rows = stmt
        .query_map([probe_limit], |row| row.get::<_, String>(0))
        .map_err(|err| SqlCommandError::new("sqlite_query", err.to_string()))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| SqlCommandError::new("sqlite_iter", err.to_string()))
}

fn map_sqlite_index_origin(origin: &str) -> Result<IndexOriginDto, SqlCommandError> {
    match origin {
        "c" => Ok(IndexOriginDto::Created),
        "u" => Ok(IndexOriginDto::UniqueConstraint),
        "pk" => Ok(IndexOriginDto::PrimaryKey),
        _ => Err(SqlCommandError::new(
            "internal",
            format!("SQLite returned unknown index origin '{origin}'"),
        )),
    }
}

fn map_sqlite_index_column(
    (ordinal, column_id, name, descending, collation): (
        i32,
        i32,
        Option<String>,
        bool,
        Option<String>,
    ),
) -> Result<IndexColumnDto, SqlCommandError> {
    if ordinal < 0 {
        return Err(SqlCommandError::new(
            "internal",
            format!("SQLite returned invalid index column ordinal {ordinal}"),
        ));
    }
    let kind = match column_id {
        -2 => IndexColumnKindDto::Expression,
        0.. => IndexColumnKindDto::Column,
        _ => {
            return Err(SqlCommandError::new(
                "internal",
                format!("SQLite returned invalid index column id {column_id}"),
            ));
        }
    };
    if kind == IndexColumnKindDto::Column
        && name
            .as_deref()
            .is_none_or(|value| value.trim().is_empty() || value.contains('\0'))
    {
        return Err(SqlCommandError::new(
            "internal",
            "SQLite returned an unnamed index column",
        ));
    }
    if kind == IndexColumnKindDto::Expression && name.is_some() {
        return Err(SqlCommandError::new(
            "internal",
            "SQLite returned a named index expression",
        ));
    }
    Ok(IndexColumnDto {
        ordinal,
        name,
        kind,
        descending,
        collation,
    })
}

fn serialized_len(value: &impl serde::Serialize) -> Result<usize, SqlCommandError> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|err| {
            SqlCommandError::new("internal", format!("failed to size schema metadata: {err}"))
        })
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
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    use super::*;
    use mysql::Opts;

    static NEXT_SCHEMA_FIXTURE: AtomicU64 = AtomicU64::new(0);

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

    fn sqlite_schema_fixture(label: &str, sql: &str) -> (std::path::PathBuf, BoxedConnection) {
        let fixture_id = NEXT_SCHEMA_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "nyala-bounded-schema-{label}-{}-{fixture_id}.db",
            std::process::id()
        ));
        let fixture = SqliteRawConnection::open(&path).expect("open bounded schema fixture");
        fixture
            .execute_batch(sql)
            .expect("seed bounded schema fixture");
        drop(fixture);

        let mut profile = profile(DriverIdDto::Sqlite);
        profile.file_path = Some(path.to_string_lossy().into_owned());
        let connection = SqliteDriver
            .open(&profile, &ConnectionSecret::default())
            .expect("open bounded SQLite connection");
        (path, connection)
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
    fn sqlite_bounded_snapshot_stops_at_the_object_cap() {
        let (path, connection) = sqlite_schema_fixture(
            "objects",
            "CREATE TABLE alpha(id INTEGER);\
             CREATE TABLE beta(id INTEGER);\
             CREATE VIEW gamma AS SELECT id FROM alpha;",
        );
        let limits = MetadataSnapshotLimits {
            max_objects: 1,
            max_columns: 16,
            max_bytes: 64 * 1024,
        };

        let snapshot = connection
            .list_schema_snapshot_bounded("main", limits)
            .expect("load object-bounded snapshot");

        assert_eq!(snapshot.objects.len(), 1);
        assert!(snapshot.truncated);
        assert!(serde_json::to_vec(&snapshot).unwrap().len() <= limits.max_bytes);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_bounded_snapshot_stops_at_the_global_column_cap() {
        let (path, connection) = sqlite_schema_fixture(
            "columns",
            "CREATE TABLE alpha(id INTEGER, name TEXT, email TEXT);",
        );
        let limits = MetadataSnapshotLimits {
            max_objects: 8,
            max_columns: 2,
            max_bytes: 64 * 1024,
        };

        let snapshot = connection
            .list_schema_snapshot_bounded("main", limits)
            .expect("load column-bounded snapshot");

        assert_eq!(snapshot.objects.len(), 1);
        assert_eq!(snapshot.objects[0].object.columns.len(), 2);
        assert!(snapshot.objects[0].columns_truncated);
        assert!(snapshot.truncated);
        assert!(serde_json::to_vec(&snapshot).unwrap().len() <= limits.max_bytes);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_bounded_snapshot_never_exceeds_the_serialized_byte_cap() {
        let (path, connection) = sqlite_schema_fixture(
            "bytes",
            "CREATE TABLE alpha(a_very_long_column_name_for_budgeting TEXT);",
        );
        let roomy_limits = MetadataSnapshotLimits {
            max_objects: 8,
            max_columns: 8,
            max_bytes: 64 * 1024,
        };
        let mut object_only = connection
            .list_schema_snapshot_bounded("main", roomy_limits)
            .expect("load complete schema snapshot");
        object_only.objects[0].object.columns.clear();
        let byte_cap = serde_json::to_vec(&object_only).unwrap().len();
        let limits = MetadataSnapshotLimits {
            max_bytes: byte_cap,
            ..roomy_limits
        };

        let snapshot = connection
            .list_schema_snapshot_bounded("main", limits)
            .expect("load byte-bounded snapshot");

        assert_eq!(snapshot.objects.len(), 1);
        assert!(snapshot.objects[0].object.columns.is_empty());
        assert!(snapshot.objects[0].columns_truncated);
        assert!(snapshot.truncated);
        assert!(serde_json::to_vec(&snapshot).unwrap().len() <= limits.max_bytes);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_bounded_snapshot_stops_reading_a_dense_table_at_the_global_column_cap() {
        let columns = (0..1_500)
            .map(|index| format!("column_{index} TEXT"))
            .collect::<Vec<_>>()
            .join(",");
        let raw = SqliteRawConnection::open_in_memory().expect("open dense schema fixture");
        raw.execute_batch(&format!("CREATE TABLE alpha({columns});"))
            .expect("seed dense schema fixture");
        let progress_calls = Arc::new(AtomicUsize::new(0));
        let callback_calls = Arc::clone(&progress_calls);
        raw.progress_handler(
            100,
            Some(move || callback_calls.fetch_add(1, Ordering::Relaxed) >= 100),
        );
        let connection = SqliteConnection::new(raw);

        let snapshot = connection
            .list_schema_snapshot_bounded(
                "main",
                MetadataSnapshotLimits {
                    max_objects: 8,
                    max_columns: 1,
                    max_bytes: 64 * 1024,
                },
            )
            .expect("stop before materializing the dense table metadata");

        assert_eq!(snapshot.objects[0].object.columns.len(), 1);
        assert!(snapshot.objects[0].columns_truncated);
        assert!(snapshot.truncated);
        assert!(progress_calls.load(Ordering::Relaxed) < 100);
    }

    #[test]
    fn sqlite_foreign_key_snapshot_preserves_composite_columns_in_ordinal_order() {
        let (path, connection) = sqlite_schema_fixture(
            "foreign-key-composite",
            "CREATE TABLE parents(tenant_id INTEGER, id INTEGER, PRIMARY KEY(tenant_id, id));\
             CREATE TABLE children(parent_tenant INTEGER, parent_id INTEGER,\
               FOREIGN KEY(parent_tenant, parent_id) REFERENCES parents(tenant_id, id));",
        );
        let limits = MetadataForeignKeyLimits {
            max_tables: 8,
            max_foreign_keys: 8,
            max_columns: 16,
            max_bytes: 64 * 1024,
        };

        let snapshot = connection
            .list_foreign_keys_bounded("main", limits)
            .expect("load bounded foreign keys");

        assert_eq!(snapshot.foreign_keys.len(), 1);
        assert_eq!(snapshot.foreign_keys[0].source_table, "children");
        assert_eq!(snapshot.foreign_keys[0].target_table, "parents");
        assert_eq!(snapshot.scanned_table_count, 2);
        assert_eq!(
            snapshot.foreign_keys[0]
                .columns
                .iter()
                .map(|column| (
                    column.ordinal,
                    column.source_column.as_str(),
                    column.target_column.as_deref()
                ))
                .collect::<Vec<_>>(),
            vec![
                (0, "parent_tenant", Some("tenant_id")),
                (1, "parent_id", Some("id")),
            ]
        );
        assert!(!snapshot.truncated);
        assert!(serde_json::to_vec(&snapshot).unwrap().len() <= limits.max_bytes);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_index_snapshot_preserves_declared_index_semantics() {
        let (path, connection) = sqlite_schema_fixture(
            "indexes",
            "CREATE TABLE users(\
                id INTEGER PRIMARY KEY,\
                email TEXT UNIQUE,\
                tenant_id INTEGER,\
                name TEXT\
            );\
            CREATE INDEX idx_users_tenant_name ON users(tenant_id, name DESC);\
            CREATE INDEX idx_users_lower_name ON users(lower(name)) WHERE name IS NOT NULL;",
        );
        let limits = MetadataIndexLimits {
            max_tables: 8,
            max_indexes: 8,
            max_columns: 16,
            max_bytes: 64 * 1024,
        };

        let snapshot = connection
            .list_indexes_bounded("main", limits)
            .expect("load bounded SQLite index metadata");

        assert!(!snapshot.truncated);
        assert_eq!(snapshot.scanned_table_count, 1);
        assert_eq!(snapshot.indexes.len(), 3);

        let composite = snapshot
            .indexes
            .iter()
            .find(|index| index.name == "idx_users_tenant_name")
            .expect("declared composite index");
        assert_eq!(composite.origin, super::IndexOriginDto::Created);
        assert!(!composite.unique);
        assert!(!composite.partial);
        assert_eq!(
            composite
                .columns
                .iter()
                .map(|column| (
                    column.ordinal,
                    column.name.as_deref(),
                    column.kind,
                    column.descending
                ))
                .collect::<Vec<_>>(),
            vec![
                (
                    0,
                    Some("tenant_id"),
                    super::IndexColumnKindDto::Column,
                    false
                ),
                (1, Some("name"), super::IndexColumnKindDto::Column, true),
            ]
        );

        let expression = snapshot
            .indexes
            .iter()
            .find(|index| index.name == "idx_users_lower_name")
            .expect("declared expression index");
        assert!(expression.partial);
        assert_eq!(
            expression.columns[0].kind,
            super::IndexColumnKindDto::Expression
        );
        assert_eq!(expression.columns[0].name, None);

        let implicit = snapshot
            .indexes
            .iter()
            .find(|index| index.name.starts_with("sqlite_autoindex_users_"))
            .expect("implicit unique index");
        assert!(implicit.unique);
        assert_eq!(implicit.origin, super::IndexOriginDto::UniqueConstraint);
        assert_eq!(implicit.columns[0].name.as_deref(), Some("email"));
        assert!(serde_json::to_vec(&snapshot).unwrap().len() <= limits.max_bytes);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_index_snapshot_drops_whole_index_when_column_budget_is_too_small() {
        let (path, connection) = sqlite_schema_fixture(
            "index-column-budget",
            "CREATE TABLE users(tenant_id INTEGER, id INTEGER);\
             CREATE INDEX idx_users_composite ON users(tenant_id, id);",
        );
        let limits = MetadataIndexLimits {
            max_tables: 8,
            max_indexes: 8,
            max_columns: 1,
            max_bytes: 64 * 1024,
        };

        let snapshot = connection
            .list_indexes_bounded("main", limits)
            .expect("load column-bounded SQLite index metadata");

        assert!(snapshot.indexes.is_empty());
        assert!(snapshot.truncated);
        assert_eq!(snapshot.scanned_table_count, 1);
        assert!(serde_json::to_vec(&snapshot).unwrap().len() <= limits.max_bytes);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_index_snapshot_uses_main_when_temp_objects_shadow_names() {
        let raw = SqliteRawConnection::open_in_memory().expect("open shadowing fixture");
        raw.execute_batch(
            "CREATE TABLE users(main_email TEXT);\
             CREATE INDEX idx_users_main_email ON users(main_email);\
             CREATE TEMP TABLE users(temp_email TEXT);\
             CREATE INDEX temp.idx_users_temp_email ON users(temp_email);",
        )
        .expect("seed shadowing fixture");
        let connection = SqliteConnection::new(raw);

        let snapshot = connection
            .list_indexes_bounded(
                "main",
                MetadataIndexLimits {
                    max_tables: 8,
                    max_indexes: 8,
                    max_columns: 16,
                    max_bytes: 64 * 1024,
                },
            )
            .expect("load main index metadata");

        assert_eq!(snapshot.indexes.len(), 1);
        assert_eq!(snapshot.indexes[0].name, "idx_users_main_email");
        assert_eq!(
            snapshot.indexes[0].columns[0].name.as_deref(),
            Some("main_email")
        );
        assert!(!snapshot.truncated);
    }

    #[test]
    fn sqlite_index_snapshot_includes_without_rowid_primary_key_index() {
        let (path, connection) = sqlite_schema_fixture(
            "index-without-rowid-primary-key",
            "CREATE TABLE memberships(\
                tenant_id INTEGER,\
                user_id INTEGER,\
                PRIMARY KEY(tenant_id, user_id)\
             ) WITHOUT ROWID;",
        );

        let snapshot = connection
            .list_indexes_bounded(
                "main",
                MetadataIndexLimits {
                    max_tables: 8,
                    max_indexes: 8,
                    max_columns: 16,
                    max_bytes: 64 * 1024,
                },
            )
            .expect("load WITHOUT ROWID primary-key metadata");

        assert_eq!(snapshot.indexes.len(), 1);
        assert_eq!(snapshot.indexes[0].origin, IndexOriginDto::PrimaryKey);
        assert_eq!(
            snapshot.indexes[0]
                .columns
                .iter()
                .map(|column| column.name.as_deref())
                .collect::<Vec<_>>(),
            vec![Some("tenant_id"), Some("user_id")]
        );
        assert!(!snapshot.truncated);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_index_snapshot_distinguishes_supported_empty_metadata() {
        let (path, connection) = sqlite_schema_fixture(
            "index-empty",
            "CREATE TABLE standalone(id INTEGER PRIMARY KEY);",
        );

        let snapshot = connection
            .list_indexes_bounded(
                "main",
                MetadataIndexLimits {
                    max_tables: 8,
                    max_indexes: 8,
                    max_columns: 16,
                    max_bytes: 64 * 1024,
                },
            )
            .expect("load supported empty index metadata");

        assert!(snapshot.indexes.is_empty());
        assert_eq!(snapshot.scanned_table_count, 1);
        assert!(!snapshot.truncated);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_index_snapshot_stops_at_the_table_cap() {
        let (path, connection) = sqlite_schema_fixture(
            "index-table-budget",
            "CREATE TABLE alpha(id INTEGER);\
             CREATE INDEX idx_alpha_id ON alpha(id);\
             CREATE TABLE beta(id INTEGER);\
             CREATE INDEX idx_beta_id ON beta(id);",
        );

        let snapshot = connection
            .list_indexes_bounded(
                "main",
                MetadataIndexLimits {
                    max_tables: 1,
                    max_indexes: 8,
                    max_columns: 16,
                    max_bytes: 64 * 1024,
                },
            )
            .expect("apply index table budget");

        assert_eq!(snapshot.scanned_table_count, 1);
        assert_eq!(snapshot.indexes.len(), 1);
        assert_eq!(snapshot.indexes[0].table, "alpha");
        assert!(snapshot.truncated);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_index_snapshot_stops_at_the_index_cap() {
        let (path, connection) = sqlite_schema_fixture(
            "index-count-budget",
            "CREATE TABLE users(alpha INTEGER, beta INTEGER);\
             CREATE INDEX idx_users_beta ON users(beta);\
             CREATE INDEX idx_users_alpha ON users(alpha);",
        );

        let snapshot = connection
            .list_indexes_bounded(
                "main",
                MetadataIndexLimits {
                    max_tables: 8,
                    max_indexes: 1,
                    max_columns: 16,
                    max_bytes: 64 * 1024,
                },
            )
            .expect("apply index count budget");

        assert_eq!(snapshot.indexes.len(), 1);
        assert_eq!(snapshot.indexes[0].name, "idx_users_alpha");
        assert!(snapshot.truncated);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_index_snapshot_drops_whole_index_at_the_byte_cap() {
        let (path, connection) = sqlite_schema_fixture(
            "index-byte-budget",
            "CREATE TABLE users(email TEXT);\
             CREATE INDEX idx_users_email_with_a_long_name ON users(email);",
        );
        let initial_envelope = BoundedIndexSnapshotDto {
            indexes: Vec::new(),
            scanned_table_count: 0,
            truncated: false,
        };
        let truncated_envelope = BoundedIndexSnapshotDto {
            indexes: Vec::new(),
            scanned_table_count: 1,
            truncated: true,
        };
        let max_bytes = serialized_len(&initial_envelope)
            .unwrap()
            .max(serialized_len(&truncated_envelope).unwrap());
        let limits = MetadataIndexLimits {
            max_tables: 8,
            max_indexes: 8,
            max_columns: 16,
            max_bytes,
        };

        let snapshot = connection
            .list_indexes_bounded("main", limits)
            .expect("apply index byte budget");

        assert!(snapshot.indexes.is_empty());
        assert_eq!(snapshot.scanned_table_count, 1);
        assert!(snapshot.truncated);
        assert!(serde_json::to_vec(&snapshot).unwrap().len() <= limits.max_bytes);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_index_snapshot_rejects_non_main_schema() {
        let raw = SqliteRawConnection::open_in_memory().expect("open schema fixture");
        let connection = SqliteConnection::new(raw);

        let result = connection.list_indexes_bounded(
            "temp",
            MetadataIndexLimits {
                max_tables: 8,
                max_indexes: 8,
                max_columns: 16,
                max_bytes: 64 * 1024,
            },
        );

        assert!(result.is_err());
    }

    #[test]
    fn default_driver_index_metadata_fails_closed() {
        let error = MysqlProbeConnection
            .list_indexes_bounded(
                "app",
                MetadataIndexLimits {
                    max_tables: 8,
                    max_indexes: 8,
                    max_columns: 16,
                    max_bytes: 64 * 1024,
                },
            )
            .expect_err("unsupported driver must not return an empty success");

        assert!(matches!(error, SqlCommandError::Validation { .. }));
    }

    #[test]
    fn sqlite_foreign_key_snapshot_drops_whole_relation_when_column_budget_is_too_small() {
        let (path, connection) = sqlite_schema_fixture(
            "foreign-key-column-budget",
            "CREATE TABLE parents(a INTEGER, b INTEGER, PRIMARY KEY(a, b));\
             CREATE TABLE children(x INTEGER, y INTEGER,\
               FOREIGN KEY(x, y) REFERENCES parents(a, b));",
        );
        let limits = MetadataForeignKeyLimits {
            max_tables: 8,
            max_foreign_keys: 8,
            max_columns: 1,
            max_bytes: 64 * 1024,
        };

        let snapshot = connection
            .list_foreign_keys_bounded("main", limits)
            .expect("apply foreign-key column budget");

        assert!(snapshot.foreign_keys.is_empty());
        assert_eq!(snapshot.scanned_table_count, 1);
        assert!(snapshot.truncated);
        assert!(serde_json::to_vec(&snapshot).unwrap().len() <= limits.max_bytes);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_foreign_key_snapshot_stops_at_the_table_cap() {
        let (path, connection) = sqlite_schema_fixture(
            "foreign-key-table-budget",
            "CREATE TABLE alpha(id INTEGER PRIMARY KEY);\
             CREATE TABLE beta(id INTEGER PRIMARY KEY);",
        );
        let limits = MetadataForeignKeyLimits {
            max_tables: 1,
            max_foreign_keys: 8,
            max_columns: 16,
            max_bytes: 64 * 1024,
        };

        let snapshot = connection
            .list_foreign_keys_bounded("main", limits)
            .expect("apply foreign-key table budget");

        assert!(snapshot.foreign_keys.is_empty());
        assert_eq!(snapshot.scanned_table_count, 1);
        assert!(snapshot.truncated);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_foreign_key_snapshot_stops_at_the_relation_cap() {
        let (path, connection) = sqlite_schema_fixture(
            "foreign-key-relation-budget",
            "CREATE TABLE parents(id INTEGER PRIMARY KEY);\
             CREATE TABLE children(\
                first_parent INTEGER REFERENCES parents(id),\
                second_parent INTEGER REFERENCES parents(id)\
             );",
        );
        let limits = MetadataForeignKeyLimits {
            max_tables: 8,
            max_foreign_keys: 1,
            max_columns: 16,
            max_bytes: 64 * 1024,
        };

        let snapshot = connection
            .list_foreign_keys_bounded("main", limits)
            .expect("apply foreign-key relation budget");

        assert_eq!(snapshot.foreign_keys.len(), 1);
        assert!(snapshot.truncated);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_foreign_key_snapshot_never_exceeds_the_byte_cap() {
        let (path, connection) = sqlite_schema_fixture(
            "foreign-key-byte-budget",
            "CREATE TABLE parents(id INTEGER PRIMARY KEY);\
             CREATE TABLE children(\
                parent_identifier_with_a_long_budget_name INTEGER REFERENCES parents(id)\
             );",
        );
        let mut envelope = BoundedForeignKeySnapshotDto {
            foreign_keys: Vec::new(),
            scanned_table_count: 8,
            truncated: false,
        };
        let complete_envelope_bytes = serde_json::to_vec(&envelope).unwrap().len();
        envelope.truncated = true;
        let truncated_envelope_bytes = serde_json::to_vec(&envelope).unwrap().len();
        let byte_cap = complete_envelope_bytes.max(truncated_envelope_bytes);
        let limits = MetadataForeignKeyLimits {
            max_tables: 8,
            max_foreign_keys: 8,
            max_columns: 16,
            max_bytes: byte_cap,
        };

        let snapshot = connection
            .list_foreign_keys_bounded("main", limits)
            .expect("apply foreign-key byte budget");

        assert!(snapshot.foreign_keys.is_empty());
        assert!(snapshot.truncated);
        assert!(serde_json::to_vec(&snapshot).unwrap().len() <= limits.max_bytes);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_foreign_key_snapshot_truncates_before_table_count_crosses_byte_cap() {
        let schema = concat!(
            "CREATE TABLE table_0(id INTEGER PRIMARY KEY);",
            "CREATE TABLE table_1(id INTEGER PRIMARY KEY);",
            "CREATE TABLE table_2(id INTEGER PRIMARY KEY);",
            "CREATE TABLE table_3(id INTEGER PRIMARY KEY);",
            "CREATE TABLE table_4(id INTEGER PRIMARY KEY);",
            "CREATE TABLE table_5(id INTEGER PRIMARY KEY);",
            "CREATE TABLE table_6(id INTEGER PRIMARY KEY);",
            "CREATE TABLE table_7(id INTEGER PRIMARY KEY);",
            "CREATE TABLE table_8(id INTEGER PRIMARY KEY);",
            "CREATE TABLE table_9(id INTEGER PRIMARY KEY);",
        );
        let (path, connection) = sqlite_schema_fixture("foreign-key-table-count-bytes", schema);
        let envelope = BoundedForeignKeySnapshotDto {
            foreign_keys: Vec::new(),
            scanned_table_count: 0,
            truncated: false,
        };
        let limits = MetadataForeignKeyLimits {
            max_tables: 10,
            max_foreign_keys: 1,
            max_columns: 1,
            max_bytes: serde_json::to_vec(&envelope).unwrap().len(),
        };

        let snapshot = connection
            .list_foreign_keys_bounded("main", limits)
            .expect("truncate before the table count exceeds the byte cap");

        assert_eq!(snapshot.scanned_table_count, 9);
        assert!(snapshot.truncated);
        assert!(serde_json::to_vec(&snapshot).unwrap().len() <= limits.max_bytes);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_foreign_key_snapshot_distinguishes_supported_empty_metadata() {
        let (path, connection) = sqlite_schema_fixture(
            "foreign-key-empty",
            "CREATE TABLE standalone(id INTEGER PRIMARY KEY);",
        );
        let limits = MetadataForeignKeyLimits {
            max_tables: 8,
            max_foreign_keys: 8,
            max_columns: 16,
            max_bytes: 64 * 1024,
        };

        let snapshot = connection
            .list_foreign_keys_bounded("main", limits)
            .expect("load supported empty foreign keys");

        assert!(snapshot.foreign_keys.is_empty());
        assert_eq!(snapshot.scanned_table_count, 1);
        assert!(!snapshot.truncated);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_foreign_key_snapshot_stops_reading_a_dense_table_at_the_global_cap() {
        let foreign_keys = (0..2_000)
            .map(|_| "FOREIGN KEY(parent_id) REFERENCES parents(id)")
            .collect::<Vec<_>>()
            .join(",");
        let raw = SqliteRawConnection::open_in_memory().expect("open dense foreign-key fixture");
        raw.execute_batch(&format!(
            "CREATE TABLE parents(id INTEGER PRIMARY KEY);\
             CREATE TABLE children(parent_id INTEGER, {foreign_keys});"
        ))
        .expect("seed dense foreign-key fixture");
        let progress_calls = Arc::new(AtomicUsize::new(0));
        let callback_calls = Arc::clone(&progress_calls);
        raw.progress_handler(
            100,
            Some(move || callback_calls.fetch_add(1, Ordering::Relaxed) >= 100),
        );
        let connection = SqliteConnection::new(raw);

        let snapshot = connection
            .list_foreign_keys_bounded(
                "main",
                MetadataForeignKeyLimits {
                    max_tables: 8,
                    max_foreign_keys: 1,
                    max_columns: 1,
                    max_bytes: 64 * 1024,
                },
            )
            .expect("stop before materializing the dense foreign-key table");

        assert_eq!(snapshot.foreign_keys.len(), 1);
        assert!(snapshot.truncated);
        assert!(progress_calls.load(Ordering::Relaxed) < 100);
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
