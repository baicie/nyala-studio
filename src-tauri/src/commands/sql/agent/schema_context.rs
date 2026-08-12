//! Bounded schema retrieval and per-runtime metadata snapshots for the SQL Agent.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::super::sql_analysis::SqlTableRef;
use super::super::types::SqlCommandError;
use super::super::SqlDialect;
use super::core_adapter::{SchemaContextColumn, SchemaContextObject, SchemaContextObjectKind};

pub const DEFAULT_SCHEMA_CACHE_TTL: Duration = Duration::from_secs(30);
pub const DEFAULT_SCHEMA_SEARCH_OBJECTS: usize = 24;
pub const DEFAULT_SCHEMA_SEARCH_COLUMNS: usize = 192;
pub const DEFAULT_SCHEMA_SEARCH_BYTES: usize = 12 * 1024;

const MAX_SCHEMA_SEARCH_OBJECTS: usize = 100;
const MAX_SCHEMA_SEARCH_COLUMNS: usize = 1_000;
const MAX_SCHEMA_SEARCH_BYTES: usize = 256 * 1024;
const MAX_SCHEMA_SEARCH_QUERY_BYTES: usize = 4 * 1024;
const MAX_SCHEMA_SEARCH_EXPLICIT_TABLES: usize = 32;

#[allow(clippy::struct_field_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SchemaSearchBudget {
    pub max_objects: usize,
    pub max_columns: usize,
    pub max_bytes: usize,
}

impl Default for SchemaSearchBudget {
    fn default() -> Self {
        Self {
            max_objects: DEFAULT_SCHEMA_SEARCH_OBJECTS,
            max_columns: DEFAULT_SCHEMA_SEARCH_COLUMNS,
            max_bytes: DEFAULT_SCHEMA_SEARCH_BYTES,
        }
    }
}

impl SchemaSearchBudget {
    fn validate(self) -> Result<Self, SqlCommandError> {
        validate_limit(
            self.max_objects,
            MAX_SCHEMA_SEARCH_OBJECTS,
            "schema search object budget",
        )?;
        validate_limit(
            self.max_columns,
            MAX_SCHEMA_SEARCH_COLUMNS,
            "schema search column budget",
        )?;
        validate_limit(
            self.max_bytes,
            MAX_SCHEMA_SEARCH_BYTES,
            "schema search byte budget",
        )?;
        Ok(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaSearchRequest {
    pub connection_id: String,
    pub schema: String,
    pub query: String,
    pub explicit_tables: Vec<SqlTableRef>,
    pub budget: SchemaSearchBudget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SchemaMatchKind {
    ExplicitTable,
    ExactObject,
    ExactColumn,
    ObjectToken,
    ColumnToken,
    Fuzzy,
    Browse,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSearchMatch {
    pub object: SchemaContextObject,
    pub columns: Vec<SchemaContextColumn>,
    pub columns_truncated: bool,
    pub match_kind: SchemaMatchKind,
    pub score: u16,
    pub metadata_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSearchResult {
    pub connection_id: String,
    pub schema: String,
    pub dialect: SqlDialect,
    pub metadata_revision: u64,
    pub matches: Vec<SchemaSearchMatch>,
    pub truncated: bool,
    pub returned_object_count: usize,
    pub returned_column_count: usize,
    pub returned_byte_count: usize,
}

#[derive(Clone)]
pub(crate) struct SchemaSnapshotObject {
    pub object: SchemaContextObject,
    pub columns: Vec<SchemaContextColumn>,
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) struct SchemaCacheKey {
    connection_id: String,
    schema: String,
    metadata_revision: u64,
}

impl SchemaCacheKey {
    pub(crate) fn new(connection_id: &str, schema: &str, metadata_revision: u64) -> Self {
        Self {
            connection_id: connection_id.to_string(),
            schema: schema.to_string(),
            metadata_revision,
        }
    }
}

struct SchemaCacheEntry {
    inserted_at: Instant,
    objects: Arc<Vec<SchemaSnapshotObject>>,
}

pub(crate) struct SchemaSnapshotCache {
    ttl: Duration,
    entries: Mutex<HashMap<SchemaCacheKey, SchemaCacheEntry>>,
}

impl SchemaSnapshotCache {
    pub(crate) fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn get_or_try_insert_with(
        &self,
        key: SchemaCacheKey,
        now: Instant,
        load: impl FnOnce() -> Result<Vec<SchemaSnapshotObject>, SqlCommandError>,
    ) -> Result<Arc<Vec<SchemaSnapshotObject>>, SqlCommandError> {
        if let Some(objects) = self.get_fresh(&key, now) {
            return Ok(objects);
        }

        // Metadata I/O deliberately runs without the cache lock held.
        let objects = Arc::new(load()?);
        let mut entries = self.entries.lock().expect("schema cache poisoned");
        entries.retain(|_, entry| now.saturating_duration_since(entry.inserted_at) < self.ttl);
        entries.insert(
            key,
            SchemaCacheEntry {
                inserted_at: now,
                objects: Arc::clone(&objects),
            },
        );
        Ok(objects)
    }

    pub(crate) fn invalidate(&self, connection_id: &str) -> usize {
        let mut entries = self.entries.lock().expect("schema cache poisoned");
        let before = entries.len();
        entries.retain(|key, _| key.connection_id != connection_id);
        before - entries.len()
    }

    fn get_fresh(
        &self,
        key: &SchemaCacheKey,
        now: Instant,
    ) -> Option<Arc<Vec<SchemaSnapshotObject>>> {
        let mut entries = self.entries.lock().expect("schema cache poisoned");
        let entry = entries.get(key)?;
        if now.saturating_duration_since(entry.inserted_at) < self.ttl {
            Some(Arc::clone(&entry.objects))
        } else {
            entries.remove(key);
            None
        }
    }
}

pub(crate) fn search_snapshot(
    request: &SchemaSearchRequest,
    dialect: SqlDialect,
    metadata_revision: u64,
    snapshot: &[SchemaSnapshotObject],
) -> Result<SchemaSearchResult, SqlCommandError> {
    let budget = request.budget.validate()?;
    if request.query.len() > MAX_SCHEMA_SEARCH_QUERY_BYTES {
        return Err(SqlCommandError::new(
            "invalid_input",
            format!("schema search query exceeds {MAX_SCHEMA_SEARCH_QUERY_BYTES} bytes"),
        ));
    }
    if request.explicit_tables.len() > MAX_SCHEMA_SEARCH_EXPLICIT_TABLES {
        return Err(SqlCommandError::new(
            "invalid_input",
            format!(
                "schema search explicit table budget exceeds {MAX_SCHEMA_SEARCH_EXPLICIT_TABLES}"
            ),
        ));
    }
    let query = normalize_search_text(&request.query);
    let terms = search_terms(&query);
    let mut ranked: Vec<_> = snapshot
        .iter()
        .filter_map(|entry| {
            rank_entry(entry, &query, &terms, &request.explicit_tables).map(
                |(score, match_kind)| RankedMatch {
                    entry,
                    score,
                    match_kind,
                },
            )
        })
        .collect();

    ranked.sort_by(|left, right| {
        left.score
            .cmp(&right.score)
            .then_with(|| {
                left.entry
                    .object
                    .schema
                    .to_lowercase()
                    .cmp(&right.entry.object.schema.to_lowercase())
            })
            .then_with(|| {
                object_kind_rank(left.entry.object.kind)
                    .cmp(&object_kind_rank(right.entry.object.kind))
            })
            .then_with(|| {
                left.entry
                    .object
                    .name
                    .to_lowercase()
                    .cmp(&right.entry.object.name.to_lowercase())
            })
            .then_with(|| left.entry.object.name.cmp(&right.entry.object.name))
    });

    build_bounded_result(request, dialect, metadata_revision, ranked, budget)
}

struct RankedMatch<'a> {
    entry: &'a SchemaSnapshotObject,
    score: u16,
    match_kind: SchemaMatchKind,
}

fn build_bounded_result(
    request: &SchemaSearchRequest,
    dialect: SqlDialect,
    metadata_revision: u64,
    ranked: Vec<RankedMatch<'_>>,
    budget: SchemaSearchBudget,
) -> Result<SchemaSearchResult, SqlCommandError> {
    let ranked_count = ranked.len();
    let mut result = SchemaSearchResult {
        connection_id: request.connection_id.clone(),
        schema: request.schema.clone(),
        dialect,
        metadata_revision,
        matches: Vec::new(),
        truncated: false,
        returned_object_count: 0,
        returned_column_count: 0,
        returned_byte_count: 0,
    };
    update_byte_count(&mut result)?;
    if result.returned_byte_count > budget.max_bytes {
        return Err(SqlCommandError::new(
            "invalid_input",
            "schema search byte budget is too small for the result envelope",
        ));
    }

    let mut remaining_columns = budget.max_columns;
    let mut any_columns_truncated = false;
    for candidate in ranked {
        if result.matches.len() == budget.max_objects {
            break;
        }

        let take_columns = candidate.entry.columns.len().min(remaining_columns);
        let mut matched = SchemaSearchMatch {
            object: candidate.entry.object.clone(),
            columns: candidate.entry.columns[..take_columns].to_vec(),
            columns_truncated: take_columns < candidate.entry.columns.len(),
            match_kind: candidate.match_kind,
            score: candidate.score,
            metadata_revision,
        };

        loop {
            result.matches.push(matched.clone());
            result.returned_object_count = result.matches.len();
            result.returned_column_count =
                result.matches.iter().map(|entry| entry.columns.len()).sum();
            result.truncated = true;
            update_byte_count(&mut result)?;

            if result.returned_byte_count <= budget.max_bytes {
                remaining_columns -= matched.columns.len();
                any_columns_truncated |= matched.columns_truncated;
                break;
            }

            result.matches.pop();
            if matched.columns.pop().is_none() {
                result.returned_object_count = result.matches.len();
                result.returned_column_count =
                    result.matches.iter().map(|entry| entry.columns.len()).sum();
                break;
            }
            matched.columns_truncated = true;
        }

        if result.returned_object_count != result.matches.len()
            || result
                .matches
                .last()
                .is_none_or(|last| last.object != candidate.entry.object)
        {
            break;
        }
    }

    result.returned_object_count = result.matches.len();
    result.returned_column_count = result.matches.iter().map(|entry| entry.columns.len()).sum();
    result.truncated = result.matches.len() < ranked_count || any_columns_truncated;
    update_byte_count(&mut result)?;

    if result.returned_byte_count > budget.max_bytes {
        // The final `truncated` flag can be one byte shorter than the
        // conservative sizing pass. Shrink the last match until the exact
        // serialized envelope fits, never cutting an identifier or type.
        while result.returned_byte_count > budget.max_bytes {
            let Some(last) = result.matches.last_mut() else {
                break;
            };
            if last.columns.pop().is_some() {
                last.columns_truncated = true;
            } else {
                result.matches.pop();
            }
            result.returned_object_count = result.matches.len();
            result.returned_column_count =
                result.matches.iter().map(|entry| entry.columns.len()).sum();
            result.truncated = true;
            update_byte_count(&mut result)?;
        }
        if result.returned_byte_count > budget.max_bytes {
            return Err(SqlCommandError::new(
                "internal",
                "bounded schema search exceeded its byte budget",
            ));
        }
    }
    Ok(result)
}

fn rank_entry(
    entry: &SchemaSnapshotObject,
    query: &str,
    terms: &[String],
    explicit_tables: &[SqlTableRef],
) -> Option<(u16, SchemaMatchKind)> {
    if is_explicit_table(&entry.object, explicit_tables) {
        return Some((0, SchemaMatchKind::ExplicitTable));
    }
    if query.is_empty() {
        return Some((700, SchemaMatchKind::Browse));
    }

    let schema = normalize_search_text(&entry.object.schema);
    let name = normalize_search_text(&entry.object.name);
    let qualified_name = format!("{schema}.{name}");
    if query == name || query == qualified_name {
        return Some((100, SchemaMatchKind::ExactObject));
    }

    let normalized_columns: Vec<_> = entry
        .columns
        .iter()
        .map(|column| normalize_search_text(&column.name))
        .collect();
    if normalized_columns.iter().any(|column| column == query) {
        return Some((200, SchemaMatchKind::ExactColumn));
    }

    if name.starts_with(query)
        || qualified_name.starts_with(query)
        || terms
            .iter()
            .all(|term| name.contains(term) || schema.contains(term))
    {
        return Some((300, SchemaMatchKind::ObjectToken));
    }

    if terms.iter().all(|term| {
        normalized_columns
            .iter()
            .any(|column| column.contains(term))
    }) {
        return Some((400, SchemaMatchKind::ColumnToken));
    }

    let object_haystack = format!("{schema}{name}");
    if is_subsequence(
        &query.replace([' ', '.', '_'], ""),
        &object_haystack.replace('_', ""),
    ) || normalized_columns.iter().any(|column| {
        is_subsequence(
            &query.replace([' ', '.', '_'], ""),
            &column.replace('_', ""),
        )
    }) {
        return Some((500, SchemaMatchKind::Fuzzy));
    }

    None
}

fn is_explicit_table(object: &SchemaContextObject, explicit_tables: &[SqlTableRef]) -> bool {
    explicit_tables.iter().any(|table| {
        table.name.eq_ignore_ascii_case(&object.name)
            && table
                .schema
                .as_deref()
                .is_none_or(|schema| schema.eq_ignore_ascii_case(&object.schema))
    })
}

fn normalize_search_text(value: &str) -> String {
    value.trim().to_lowercase()
}

fn search_terms(query: &str) -> Vec<String> {
    query
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .map(str::to_string)
        .collect()
}

fn is_subsequence(needle: &str, haystack: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let mut needle = needle.chars();
    let mut next = needle.next();
    for character in haystack.chars() {
        if next == Some(character) {
            next = needle.next();
            if next.is_none() {
                return true;
            }
        }
    }
    false
}

fn object_kind_rank(kind: SchemaContextObjectKind) -> u8 {
    match kind {
        SchemaContextObjectKind::Table => 0,
        SchemaContextObjectKind::View => 1,
        SchemaContextObjectKind::System => 2,
    }
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

fn update_byte_count(result: &mut SchemaSearchResult) -> Result<(), SqlCommandError> {
    for _ in 0..4 {
        let length = serde_json::to_vec(result)
            .map_err(|_| SqlCommandError::new("internal", "schema search serialization failed"))?
            .len();
        if result.returned_byte_count == length {
            return Ok(());
        }
        result.returned_byte_count = length;
    }
    Err(SqlCommandError::new(
        "internal",
        "schema search byte count did not converge",
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    fn column(name: &str, ordinal: i32) -> SchemaContextColumn {
        SchemaContextColumn {
            name: name.to_string(),
            data_type: "TEXT".to_string(),
            is_nullable: true,
            is_primary_key: false,
            ordinal,
        }
    }

    fn object(
        schema: &str,
        name: &str,
        kind: SchemaContextObjectKind,
        columns: &[&str],
    ) -> SchemaSnapshotObject {
        SchemaSnapshotObject {
            object: SchemaContextObject {
                schema: schema.to_string(),
                name: name.to_string(),
                kind,
            },
            columns: columns
                .iter()
                .enumerate()
                .map(|(ordinal, name)| column(name, i32::try_from(ordinal).unwrap()))
                .collect(),
        }
    }

    fn request(query: &str, budget: SchemaSearchBudget) -> SchemaSearchRequest {
        SchemaSearchRequest {
            connection_id: "workspace".to_string(),
            schema: "main".to_string(),
            query: query.to_string(),
            explicit_tables: Vec::new(),
            budget,
        }
    }

    #[test]
    fn ranking_is_stable_and_prefers_explicit_then_exact_matches() {
        let snapshot = vec![
            object(
                "main",
                "users_archive",
                SchemaContextObjectKind::View,
                &["id"],
            ),
            object(
                "main",
                "orders",
                SchemaContextObjectKind::Table,
                &["user_id"],
            ),
            object("main", "users", SchemaContextObjectKind::Table, &["id"]),
        ];
        let mut search = request("users", SchemaSearchBudget::default());
        search.explicit_tables.push(SqlTableRef {
            schema: Some("main".to_string()),
            name: "orders".to_string(),
        });

        let first = search_snapshot(&search, SqlDialect::Sqlite, 7, &snapshot).unwrap();
        let second = search_snapshot(&search, SqlDialect::Sqlite, 7, &snapshot).unwrap();

        assert_eq!(first, second);
        assert_eq!(first.matches[0].object.name, "orders");
        assert_eq!(first.matches[0].match_kind, SchemaMatchKind::ExplicitTable);
        assert_eq!(first.matches[1].object.name, "users");
        assert_eq!(first.matches[1].match_kind, SchemaMatchKind::ExactObject);
    }

    #[test]
    fn exact_column_match_is_returned_without_fabricating_comments() {
        let snapshot = vec![
            object(
                "main",
                "orders",
                SchemaContextObjectKind::Table,
                &["customer_id"],
            ),
            object("main", "customers", SchemaContextObjectKind::Table, &["id"]),
        ];

        let result = search_snapshot(
            &request("customer_id", SchemaSearchBudget::default()),
            SqlDialect::Sqlite,
            2,
            &snapshot,
        )
        .unwrap();

        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].object.name, "orders");
        assert_eq!(result.matches[0].match_kind, SchemaMatchKind::ExactColumn);
    }

    #[test]
    fn object_and_column_budgets_report_truncation() {
        let snapshot = vec![
            object(
                "main",
                "a",
                SchemaContextObjectKind::Table,
                &["a", "b", "c"],
            ),
            object("main", "b", SchemaContextObjectKind::Table, &["d"]),
        ];
        let result = search_snapshot(
            &request(
                "",
                SchemaSearchBudget {
                    max_objects: 1,
                    max_columns: 2,
                    max_bytes: 4_096,
                },
            ),
            SqlDialect::Sqlite,
            1,
            &snapshot,
        )
        .unwrap();

        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].columns.len(), 2);
        assert!(result.matches[0].columns_truncated);
        assert!(result.truncated);
    }

    #[test]
    fn utf8_byte_budget_never_returns_a_partial_identifier() {
        let snapshot = vec![object(
            "main",
            "订单明细",
            SchemaContextObjectKind::Table,
            &["客户名称", "订单编号"],
        )];
        let roomy = search_snapshot(
            &request("", SchemaSearchBudget::default()),
            SqlDialect::Sqlite,
            1,
            &snapshot,
        )
        .unwrap();
        let identity_only_budget = roomy.returned_byte_count - 1;
        let result = search_snapshot(
            &request(
                "",
                SchemaSearchBudget {
                    max_objects: 1,
                    max_columns: 2,
                    max_bytes: identity_only_budget,
                },
            ),
            SqlDialect::Sqlite,
            1,
            &snapshot,
        )
        .unwrap();

        assert!(result.returned_byte_count <= identity_only_budget);
        assert_eq!(
            serde_json::to_vec(&result).unwrap().len(),
            result.returned_byte_count
        );
        assert!(result.truncated);
        if let Some(matched) = result.matches.first() {
            assert_eq!(matched.object.name, "订单明细");
        }
    }

    #[test]
    fn cache_ttl_and_revision_are_testable_without_sleeping() {
        let cache = SchemaSnapshotCache::new(Duration::from_secs(30));
        let start = Instant::now();
        let loads = AtomicUsize::new(0);
        let key = SchemaCacheKey::new("workspace", "main", 1);
        let load = || {
            loads.fetch_add(1, Ordering::Relaxed);
            Ok(vec![object(
                "main",
                "users",
                SchemaContextObjectKind::Table,
                &["id"],
            )])
        };

        cache
            .get_or_try_insert_with(key.clone(), start, load)
            .unwrap();
        cache
            .get_or_try_insert_with(key.clone(), start + Duration::from_secs(29), load)
            .unwrap();
        assert_eq!(loads.load(Ordering::Relaxed), 1);

        cache
            .get_or_try_insert_with(key, start + Duration::from_secs(30), load)
            .unwrap();
        assert_eq!(loads.load(Ordering::Relaxed), 2);

        cache
            .get_or_try_insert_with(
                SchemaCacheKey::new("workspace", "main", 2),
                start + Duration::from_secs(30),
                load,
            )
            .unwrap();
        assert_eq!(loads.load(Ordering::Relaxed), 3);
    }

    #[test]
    fn explicit_invalidation_only_removes_the_target_connection() {
        let cache = SchemaSnapshotCache::new(Duration::from_secs(30));
        let start = Instant::now();
        for connection_id in ["one", "two"] {
            cache
                .get_or_try_insert_with(
                    SchemaCacheKey::new(connection_id, "main", 1),
                    start,
                    || Ok(Vec::new()),
                )
                .unwrap();
        }

        assert_eq!(cache.invalidate("one"), 1);
        let one_loads = AtomicUsize::new(0);
        cache
            .get_or_try_insert_with(SchemaCacheKey::new("one", "main", 1), start, || {
                one_loads.fetch_add(1, Ordering::Relaxed);
                Ok(Vec::new())
            })
            .unwrap();
        let two_loads = AtomicUsize::new(0);
        cache
            .get_or_try_insert_with(SchemaCacheKey::new("two", "main", 1), start, || {
                two_loads.fetch_add(1, Ordering::Relaxed);
                Ok(Vec::new())
            })
            .unwrap();

        assert_eq!(one_loads.load(Ordering::Relaxed), 1);
        assert_eq!(two_loads.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn serialized_result_contains_no_store_or_secret_identity_fields() {
        let snapshot = vec![object(
            "main",
            "users",
            SchemaContextObjectKind::Table,
            &["password_hint"],
        )];
        let result = search_snapshot(
            &request("users", SchemaSearchBudget::default()),
            SqlDialect::Sqlite,
            9,
            &snapshot,
        )
        .unwrap();
        let serialized = serde_json::to_string(&result).unwrap();

        for forbidden in [
            "filePath",
            "databasePath",
            "profileId",
            "legacyConnectionId",
            "host",
            "username",
            "secret",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "exposed {forbidden}: {serialized}"
            );
        }
    }
}
