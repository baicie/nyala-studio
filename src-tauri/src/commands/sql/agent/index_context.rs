//! Bounded, revision-aware index metadata for SQL Agent optimization.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::super::sql_analysis::SqlTableRef;
use super::super::types::SqlCommandError;
use super::super::SqlDialect;

pub const DEFAULT_INDEX_CACHE_TTL: Duration = Duration::from_secs(30);
pub const DEFAULT_INDEX_LIST_INDEXES: usize = 64;
pub const DEFAULT_INDEX_LIST_COLUMNS: usize = 256;
pub const DEFAULT_INDEX_LIST_BYTES: usize = 32 * 1024;

const MAX_INDEX_LIST_TABLES: usize = 32;
const MAX_INDEX_LIST_INDEXES: usize = 512;
const MAX_INDEX_LIST_COLUMNS: usize = 1_024;
const MAX_INDEX_LIST_BYTES: usize = 256 * 1024;

#[allow(clippy::struct_field_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexListBudget {
    pub max_indexes: usize,
    pub max_columns: usize,
    pub max_bytes: usize,
}

impl Default for IndexListBudget {
    fn default() -> Self {
        Self {
            max_indexes: DEFAULT_INDEX_LIST_INDEXES,
            max_columns: DEFAULT_INDEX_LIST_COLUMNS,
            max_bytes: DEFAULT_INDEX_LIST_BYTES,
        }
    }
}

impl IndexListBudget {
    fn validate(self) -> Result<Self, SqlCommandError> {
        validate_limit(
            self.max_indexes,
            MAX_INDEX_LIST_INDEXES,
            "index list index budget",
        )?;
        validate_limit(
            self.max_columns,
            MAX_INDEX_LIST_COLUMNS,
            "index list column budget",
        )?;
        validate_limit(
            self.max_bytes,
            MAX_INDEX_LIST_BYTES,
            "index list byte budget",
        )?;
        Ok(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexListRequest {
    pub connection_id: String,
    pub schema: String,
    pub tables: Vec<SqlTableRef>,
    pub budget: IndexListBudget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexContextOrigin {
    Created,
    UniqueConstraint,
    PrimaryKey,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexContextColumnKind {
    Column,
    Expression,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexContextColumn {
    pub ordinal: i32,
    pub name: Option<String>,
    pub kind: IndexContextColumnKind,
    pub descending: bool,
    pub collation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexContextEntry {
    pub schema: String,
    pub table: String,
    pub name: String,
    pub unique: bool,
    pub partial: bool,
    pub origin: IndexContextOrigin,
    pub columns: Vec<IndexContextColumn>,
    pub metadata_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexListResult {
    pub connection_id: String,
    pub schema: String,
    pub dialect: SqlDialect,
    pub metadata_revision: u64,
    pub indexes: Vec<IndexContextEntry>,
    pub scanned_table_count: usize,
    pub truncated: bool,
    pub returned_index_count: usize,
    pub returned_column_count: usize,
    pub returned_byte_count: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct IndexSnapshot {
    pub indexes: Vec<IndexContextEntry>,
    pub scanned_table_count: usize,
    pub truncated: bool,
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) struct IndexCacheKey {
    connection_id: String,
    schema: String,
    metadata_revision: u64,
}

impl IndexCacheKey {
    pub(crate) fn new(connection_id: &str, schema: &str, metadata_revision: u64) -> Self {
        Self {
            connection_id: connection_id.to_string(),
            schema: schema.to_string(),
            metadata_revision,
        }
    }
}

struct IndexCacheEntry {
    state: Mutex<IndexCacheEntryState>,
    ready: Condvar,
}

enum IndexCacheEntryState {
    Loading,
    Ready {
        inserted_at: Instant,
        snapshot: Arc<IndexSnapshot>,
    },
    Failed(SqlCommandError),
}

pub(crate) struct IndexSnapshotCache {
    ttl: Duration,
    entries: Mutex<HashMap<IndexCacheKey, Arc<IndexCacheEntry>>>,
}

impl IndexSnapshotCache {
    pub(crate) fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn get_or_try_insert_with(
        &self,
        key: &IndexCacheKey,
        now: Instant,
        load: impl FnOnce() -> Result<IndexSnapshot, SqlCommandError>,
    ) -> Result<Arc<IndexSnapshot>, SqlCommandError> {
        let (entry, should_load) = {
            let mut entries = self.entries.lock().expect("index cache poisoned");
            entries.retain(|_, entry| {
                let state = entry.state.lock().expect("index cache entry poisoned");
                match &*state {
                    IndexCacheEntryState::Loading => true,
                    IndexCacheEntryState::Ready { inserted_at, .. } => {
                        now.saturating_duration_since(*inserted_at) < self.ttl
                    }
                    IndexCacheEntryState::Failed(_) => false,
                }
            });

            if let Some(entry) = entries.get(key) {
                (Arc::clone(entry), false)
            } else {
                let entry = Arc::new(IndexCacheEntry {
                    state: Mutex::new(IndexCacheEntryState::Loading),
                    ready: Condvar::new(),
                });
                entries.insert(key.clone(), Arc::clone(&entry));
                (entry, true)
            }
        };

        if should_load {
            return match load() {
                Ok(snapshot) => {
                    let snapshot = Arc::new(snapshot);
                    let mut state = entry.state.lock().expect("index cache entry poisoned");
                    *state = IndexCacheEntryState::Ready {
                        inserted_at: now,
                        snapshot: Arc::clone(&snapshot),
                    };
                    entry.ready.notify_all();
                    Ok(snapshot)
                }
                Err(error) => {
                    let mut entries = self.entries.lock().expect("index cache poisoned");
                    if entries
                        .get(key)
                        .is_some_and(|cached| Arc::ptr_eq(cached, &entry))
                    {
                        entries.remove(key);
                    }
                    drop(entries);

                    let mut state = entry.state.lock().expect("index cache entry poisoned");
                    *state = IndexCacheEntryState::Failed(error.clone());
                    entry.ready.notify_all();
                    Err(error)
                }
            };
        }

        let mut state = entry.state.lock().expect("index cache entry poisoned");
        loop {
            match &*state {
                IndexCacheEntryState::Loading => {
                    state = entry
                        .ready
                        .wait(state)
                        .expect("index cache entry poisoned while waiting");
                }
                IndexCacheEntryState::Ready { snapshot, .. } => {
                    return Ok(Arc::clone(snapshot));
                }
                IndexCacheEntryState::Failed(error) => return Err(error.clone()),
            }
        }
    }

    pub(crate) fn invalidate(&self, connection_id: &str) -> usize {
        let mut entries = self.entries.lock().expect("index cache poisoned");
        let before = entries.len();
        entries.retain(|key, _| key.connection_id != connection_id);
        before - entries.len()
    }
}

pub(crate) fn list_snapshot(
    request: &IndexListRequest,
    dialect: SqlDialect,
    metadata_revision: u64,
    snapshot: &IndexSnapshot,
) -> Result<IndexListResult, SqlCommandError> {
    validate_index_list_request(request)?;
    let table_scope = normalized_table_scope(request)?;
    let mut candidates = snapshot
        .indexes
        .iter()
        .filter(|index| {
            table_scope.contains(&(
                index.schema.to_ascii_lowercase(),
                index.table.to_ascii_lowercase(),
            ))
        })
        .cloned()
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        left.schema
            .cmp(&right.schema)
            .then_with(|| left.table.cmp(&right.table))
            .then_with(|| left.name.cmp(&right.name))
    });

    build_bounded_result(
        request,
        dialect,
        metadata_revision,
        candidates,
        snapshot.scanned_table_count,
        snapshot.truncated,
    )
}

pub(crate) fn validate_index_list_request(
    request: &IndexListRequest,
) -> Result<(), SqlCommandError> {
    request.budget.validate()?;
    validate_name(&request.connection_id, "index list connection id")?;
    validate_name(&request.schema, "index list schema")?;
    if request.tables.is_empty() || request.tables.len() > MAX_INDEX_LIST_TABLES {
        return Err(SqlCommandError::new(
            "invalid_input",
            format!("index list tables must contain between 1 and {MAX_INDEX_LIST_TABLES} entries"),
        ));
    }
    for table in &request.tables {
        validate_name(
            table.schema.as_deref().unwrap_or(&request.schema),
            "index list table schema",
        )?;
        validate_name(&table.name, "index list table name")?;
    }
    Ok(())
}

fn normalized_table_scope(
    request: &IndexListRequest,
) -> Result<HashSet<(String, String)>, SqlCommandError> {
    request
        .tables
        .iter()
        .map(|table| {
            let schema = table.schema.as_deref().unwrap_or(&request.schema);
            validate_name(schema, "index list table schema")?;
            validate_name(&table.name, "index list table name")?;
            Ok((schema.to_ascii_lowercase(), table.name.to_ascii_lowercase()))
        })
        .collect()
}

fn build_bounded_result(
    request: &IndexListRequest,
    dialect: SqlDialect,
    metadata_revision: u64,
    candidates: Vec<IndexContextEntry>,
    scanned_table_count: usize,
    source_truncated: bool,
) -> Result<IndexListResult, SqlCommandError> {
    let candidate_count = candidates.len();
    let budget = request.budget;
    let mut result = IndexListResult {
        connection_id: request.connection_id.clone(),
        schema: request.schema.clone(),
        dialect,
        metadata_revision,
        indexes: Vec::new(),
        scanned_table_count,
        truncated: source_truncated,
        returned_index_count: 0,
        returned_column_count: 0,
        returned_byte_count: 0,
    };
    update_byte_count(&mut result)?;
    if result.returned_byte_count > budget.max_bytes {
        return Err(SqlCommandError::new(
            "invalid_input",
            "index list byte budget is too small for the result envelope",
        ));
    }

    for candidate in candidates {
        let next_column_count = result
            .returned_column_count
            .checked_add(candidate.columns.len())
            .ok_or_else(|| SqlCommandError::new("internal", "index list column count overflow"))?;
        if result.indexes.len() == budget.max_indexes || next_column_count > budget.max_columns {
            break;
        }

        result.indexes.push(candidate);
        result.returned_index_count = result.indexes.len();
        result.returned_column_count = next_column_count;
        result.truncated = source_truncated || result.indexes.len() < candidate_count;
        update_byte_count(&mut result)?;
        if result.returned_byte_count > budget.max_bytes {
            result.indexes.pop();
            result.returned_index_count = result.indexes.len();
            result.returned_column_count =
                result.indexes.iter().map(|index| index.columns.len()).sum();
            break;
        }
    }

    result.returned_index_count = result.indexes.len();
    result.returned_column_count = result.indexes.iter().map(|index| index.columns.len()).sum();
    result.truncated = source_truncated || result.indexes.len() < candidate_count;
    update_byte_count(&mut result)?;
    if result.returned_byte_count > budget.max_bytes {
        return Err(SqlCommandError::new(
            "internal",
            "bounded index list exceeded its byte budget",
        ));
    }
    Ok(result)
}

fn validate_limit(value: usize, maximum: usize, label: &str) -> Result<(), SqlCommandError> {
    if value == 0 || value > maximum {
        Err(SqlCommandError::new(
            "invalid_input",
            format!("{label} must be between 1 and {maximum}"),
        ))
    } else {
        Ok(())
    }
}

fn validate_name(value: &str, label: &str) -> Result<(), SqlCommandError> {
    if value.trim().is_empty() {
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
        Ok(())
    }
}

fn update_byte_count(result: &mut IndexListResult) -> Result<(), SqlCommandError> {
    for _ in 0..4 {
        let length = serde_json::to_vec(result)
            .map_err(|_| SqlCommandError::new("internal", "index list serialization failed"))?
            .len();
        if result.returned_byte_count == length {
            return Ok(());
        }
        result.returned_byte_count = length;
    }
    Err(SqlCommandError::new(
        "internal",
        "index list byte count did not converge",
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    fn request(tables: &[&str]) -> IndexListRequest {
        IndexListRequest {
            connection_id: "workspace".to_string(),
            schema: "main".to_string(),
            tables: tables
                .iter()
                .map(|table| SqlTableRef {
                    schema: Some("main".to_string()),
                    name: (*table).to_string(),
                })
                .collect(),
            budget: IndexListBudget::default(),
        }
    }

    fn index(table: &str, name: &str, columns: &[&str]) -> IndexContextEntry {
        IndexContextEntry {
            schema: "main".to_string(),
            table: table.to_string(),
            name: name.to_string(),
            unique: false,
            partial: false,
            origin: IndexContextOrigin::Created,
            columns: columns
                .iter()
                .enumerate()
                .map(|(ordinal, name)| IndexContextColumn {
                    ordinal: i32::try_from(ordinal).unwrap(),
                    name: Some((*name).to_string()),
                    kind: IndexContextColumnKind::Column,
                    descending: false,
                    collation: Some("BINARY".to_string()),
                })
                .collect(),
            metadata_revision: 7,
        }
    }

    fn snapshot(indexes: Vec<IndexContextEntry>) -> IndexSnapshot {
        IndexSnapshot {
            indexes,
            scanned_table_count: 3,
            truncated: false,
        }
    }

    #[test]
    fn index_list_filters_to_bounded_table_scope_and_sorts_entries() {
        let snapshot = snapshot(vec![
            index("orders", "idx_orders_user", &["user_id"]),
            index("users", "idx_users_name", &["name"]),
            index("users", "idx_users_email", &["email"]),
        ]);

        let result = list_snapshot(&request(&["users"]), SqlDialect::Sqlite, 7, &snapshot)
            .expect("list scoped indexes");

        assert_eq!(
            result
                .indexes
                .iter()
                .map(|index| index.name.as_str())
                .collect::<Vec<_>>(),
            vec!["idx_users_email", "idx_users_name"]
        );
        assert_eq!(result.metadata_revision, 7);
        assert_eq!(result.returned_index_count, 2);
        assert_eq!(result.returned_column_count, 2);
        assert_eq!(
            result.returned_byte_count,
            serde_json::to_vec(&result).unwrap().len()
        );
        assert!(!result.truncated);
    }

    #[test]
    fn index_list_drops_whole_composite_index_at_column_budget() {
        let snapshot = snapshot(vec![index("users", "idx_users_tenant", &["tenant", "id"])]);
        let mut request = request(&["users"]);
        request.budget.max_columns = 1;

        let result = list_snapshot(&request, SqlDialect::Sqlite, 7, &snapshot)
            .expect("apply index column budget");

        assert!(result.indexes.is_empty());
        assert_eq!(result.returned_column_count, 0);
        assert!(result.truncated);
    }

    #[test]
    fn index_list_byte_budget_keeps_only_whole_indexes() {
        let snapshot = snapshot(vec![
            index("users", "idx_users_email", &["email"]),
            index("users", "idx_users_name", &["name"]),
        ]);
        let roomy = list_snapshot(&request(&["users"]), SqlDialect::Sqlite, 7, &snapshot)
            .expect("measure full result");
        let one = list_snapshot(
            &IndexListRequest {
                budget: IndexListBudget {
                    max_indexes: 1,
                    ..IndexListBudget::default()
                },
                ..request(&["users"])
            },
            SqlDialect::Sqlite,
            7,
            &snapshot,
        )
        .expect("measure one-index result");
        let mut bounded = request(&["users"]);
        bounded.budget.max_bytes = one.returned_byte_count;

        let result = list_snapshot(&bounded, SqlDialect::Sqlite, 7, &snapshot)
            .expect("apply exact byte budget");

        assert!(result.returned_byte_count <= bounded.budget.max_bytes);
        assert!(result.indexes.len() < roomy.indexes.len());
        assert!(result.truncated);
        assert!(result.indexes.iter().all(|index| !index.columns.is_empty()));
    }

    #[test]
    fn index_list_rejects_empty_or_unbounded_table_scope() {
        let empty = validate_index_list_request(&request(&[])).unwrap_err();
        let tables = (0..=MAX_INDEX_LIST_TABLES)
            .map(|index| format!("table_{index}"))
            .collect::<Vec<_>>();
        let unbounded = validate_index_list_request(&IndexListRequest {
            connection_id: "workspace".to_string(),
            schema: "main".to_string(),
            tables: tables
                .iter()
                .map(|table| SqlTableRef {
                    schema: Some("main".to_string()),
                    name: table.clone(),
                })
                .collect(),
            budget: IndexListBudget::default(),
        })
        .unwrap_err();

        assert!(matches!(empty, SqlCommandError::InvalidInput { .. }));
        assert!(matches!(unbounded, SqlCommandError::InvalidInput { .. }));
    }

    #[test]
    fn index_cache_uses_revision_key_and_explicit_invalidation() {
        let cache = IndexSnapshotCache::new(DEFAULT_INDEX_CACHE_TTL);
        let key = IndexCacheKey::new("workspace", "main", 3);
        let calls = AtomicUsize::new(0);

        for _ in 0..2 {
            cache
                .get_or_try_insert_with(&key, Instant::now(), || {
                    calls.fetch_add(1, Ordering::Relaxed);
                    Ok(snapshot(vec![index("users", "idx_users_id", &["id"])]))
                })
                .expect("load cached index snapshot");
        }
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        assert_eq!(cache.invalidate("workspace"), 1);
        cache
            .get_or_try_insert_with(&key, Instant::now(), || {
                calls.fetch_add(1, Ordering::Relaxed);
                Ok(snapshot(Vec::new()))
            })
            .expect("reload invalidated index snapshot");
        assert_eq!(calls.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn failed_index_cache_load_is_retryable() {
        let cache = IndexSnapshotCache::new(DEFAULT_INDEX_CACHE_TTL);
        let key = IndexCacheKey::new("workspace", "main", 3);
        let calls = AtomicUsize::new(0);

        let first = cache.get_or_try_insert_with(&key, Instant::now(), || {
            calls.fetch_add(1, Ordering::Relaxed);
            Err(SqlCommandError::new("internal", "scripted failure"))
        });
        let second = cache.get_or_try_insert_with(&key, Instant::now(), || {
            calls.fetch_add(1, Ordering::Relaxed);
            Ok(snapshot(Vec::new()))
        });

        assert!(first.is_err());
        assert!(second.is_ok());
        assert_eq!(calls.load(Ordering::Relaxed), 2);
    }
}
