//! Bounded foreign-key graph search for SQL Agent schema retrieval.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::super::sql_analysis::SqlTableRef;
use super::super::types::SqlCommandError;
use super::super::SqlDialect;
use super::core_adapter::{SchemaContextObject, SchemaContextObjectKind};

pub const DEFAULT_RELATION_CACHE_TTL: Duration = Duration::from_secs(30);
pub const DEFAULT_RELATION_SEARCH_PATHS: usize = 24;
pub const DEFAULT_RELATION_SEARCH_EDGES: usize = 48;
pub const DEFAULT_RELATION_SEARCH_BYTES: usize = 16 * 1024;

const MAX_RELATION_SEARCH_PATHS: usize = 128;
const MAX_RELATION_SEARCH_EDGES: usize = 256;
const MAX_RELATION_SEARCH_BYTES: usize = 256 * 1024;
const MAX_RELATION_SEARCH_TABLES: usize = 32;

#[allow(clippy::struct_field_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RelationSearchBudget {
    pub max_paths: usize,
    pub max_edges: usize,
    pub max_bytes: usize,
}

impl Default for RelationSearchBudget {
    fn default() -> Self {
        Self {
            max_paths: DEFAULT_RELATION_SEARCH_PATHS,
            max_edges: DEFAULT_RELATION_SEARCH_EDGES,
            max_bytes: DEFAULT_RELATION_SEARCH_BYTES,
        }
    }
}

impl RelationSearchBudget {
    fn validate(self) -> Result<Self, SqlCommandError> {
        validate_limit(
            self.max_paths,
            MAX_RELATION_SEARCH_PATHS,
            "relation search path budget",
        )?;
        validate_limit(
            self.max_edges,
            MAX_RELATION_SEARCH_EDGES,
            "relation search edge budget",
        )?;
        validate_limit(
            self.max_bytes,
            MAX_RELATION_SEARCH_BYTES,
            "relation search byte budget",
        )?;
        Ok(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelationSearchRequest {
    pub connection_id: String,
    pub schema: String,
    pub tables: Vec<SqlTableRef>,
    pub max_depth: u8,
    pub budget: RelationSearchBudget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationEvidenceKind {
    DeclaredForeignKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationColumnPair {
    pub ordinal: i32,
    pub source_column: String,
    pub target_column: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationEdge {
    pub source: SchemaContextObject,
    pub target: SchemaContextObject,
    pub columns: Vec<RelationColumnPair>,
    pub evidence_kind: RelationEvidenceKind,
    pub metadata_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationSearchPath {
    pub nodes: Vec<SchemaContextObject>,
    pub edges: Vec<RelationEdge>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationSearchResult {
    pub connection_id: String,
    pub schema: String,
    pub dialect: SqlDialect,
    pub metadata_revision: u64,
    pub paths: Vec<RelationSearchPath>,
    pub truncated: bool,
    pub returned_path_count: usize,
    pub returned_edge_count: usize,
    pub returned_byte_count: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct RelationGraphSnapshot {
    pub edges: Vec<RelationEdge>,
    pub truncated: bool,
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) struct RelationCacheKey {
    connection_id: String,
    schema: String,
    metadata_revision: u64,
}

impl RelationCacheKey {
    pub(crate) fn new(connection_id: &str, schema: &str, metadata_revision: u64) -> Self {
        Self {
            connection_id: connection_id.to_string(),
            schema: schema.to_string(),
            metadata_revision,
        }
    }
}

struct RelationCacheEntry {
    state: Mutex<RelationCacheEntryState>,
    ready: Condvar,
}

enum RelationCacheEntryState {
    Loading,
    Ready {
        inserted_at: Instant,
        snapshot: Arc<RelationGraphSnapshot>,
    },
    Failed(SqlCommandError),
}

pub(crate) struct RelationGraphCache {
    ttl: Duration,
    entries: Mutex<HashMap<RelationCacheKey, Arc<RelationCacheEntry>>>,
}

impl RelationGraphCache {
    pub(crate) fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn get_or_try_insert_with(
        &self,
        key: &RelationCacheKey,
        now: Instant,
        load: impl FnOnce() -> Result<RelationGraphSnapshot, SqlCommandError>,
    ) -> Result<Arc<RelationGraphSnapshot>, SqlCommandError> {
        let (entry, should_load) = {
            let mut entries = self.entries.lock().expect("relation cache poisoned");
            entries.retain(|_, entry| {
                let state = entry.state.lock().expect("relation cache entry poisoned");
                match &*state {
                    RelationCacheEntryState::Loading => true,
                    RelationCacheEntryState::Ready { inserted_at, .. } => {
                        now.saturating_duration_since(*inserted_at) < self.ttl
                    }
                    RelationCacheEntryState::Failed(_) => false,
                }
            });

            if let Some(entry) = entries.get(key) {
                (Arc::clone(entry), false)
            } else {
                let entry = Arc::new(RelationCacheEntry {
                    state: Mutex::new(RelationCacheEntryState::Loading),
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
                    let mut state = entry.state.lock().expect("relation cache entry poisoned");
                    *state = RelationCacheEntryState::Ready {
                        inserted_at: now,
                        snapshot: Arc::clone(&snapshot),
                    };
                    entry.ready.notify_all();
                    Ok(snapshot)
                }
                Err(error) => {
                    let mut entries = self.entries.lock().expect("relation cache poisoned");
                    if entries
                        .get(key)
                        .is_some_and(|cached| Arc::ptr_eq(cached, &entry))
                    {
                        entries.remove(key);
                    }
                    drop(entries);

                    let mut state = entry.state.lock().expect("relation cache entry poisoned");
                    *state = RelationCacheEntryState::Failed(error.clone());
                    entry.ready.notify_all();
                    Err(error)
                }
            };
        }

        let mut state = entry.state.lock().expect("relation cache entry poisoned");
        loop {
            match &*state {
                RelationCacheEntryState::Loading => {
                    state = entry
                        .ready
                        .wait(state)
                        .expect("relation cache entry poisoned while waiting");
                }
                RelationCacheEntryState::Ready { snapshot, .. } => return Ok(Arc::clone(snapshot)),
                RelationCacheEntryState::Failed(error) => return Err(error.clone()),
            }
        }
    }

    pub(crate) fn invalidate(&self, connection_id: &str) -> usize {
        let mut entries = self.entries.lock().expect("relation cache poisoned");
        let before = entries.len();
        entries.retain(|key, _| key.connection_id != connection_id);
        before - entries.len()
    }
}

pub(crate) fn search_relation_graph(
    request: &RelationSearchRequest,
    dialect: SqlDialect,
    metadata_revision: u64,
    snapshot: &RelationGraphSnapshot,
) -> Result<RelationSearchResult, SqlCommandError> {
    validate_relation_search_request(request)?;
    let budget = request.budget;

    let mut edges = snapshot.edges.clone();
    edges.sort_by(compare_edges);
    let seeds = normalized_seeds(request)?;
    let candidate_limit = budget.max_paths.saturating_add(1);
    let (candidates, collection_truncated) =
        collect_paths(&seeds, &edges, request.max_depth, candidate_limit);
    build_bounded_result(
        request,
        dialect,
        metadata_revision,
        candidates,
        budget,
        snapshot.truncated || collection_truncated,
    )
}

pub(crate) fn validate_relation_search_request(
    request: &RelationSearchRequest,
) -> Result<(), SqlCommandError> {
    request.budget.validate()?;
    validate_request(request)?;
    for table in &request.tables {
        validate_name(
            table.schema.as_deref().unwrap_or(&request.schema),
            "relation search table schema",
        )?;
        validate_name(&table.name, "relation search table name")?;
    }
    Ok(())
}

fn validate_request(request: &RelationSearchRequest) -> Result<(), SqlCommandError> {
    validate_name(&request.connection_id, "relation search connection id")?;
    validate_name(&request.schema, "relation search schema")?;
    if request.tables.is_empty() || request.tables.len() > MAX_RELATION_SEARCH_TABLES {
        return Err(SqlCommandError::new(
			"invalid_input",
			format!("relation search tables must contain between 1 and {MAX_RELATION_SEARCH_TABLES} entries"),
		));
    }
    if !(1..=2).contains(&request.max_depth) {
        return Err(SqlCommandError::new(
            "invalid_input",
            "relation search max depth must be 1 or 2",
        ));
    }
    Ok(())
}

fn normalized_seeds(
    request: &RelationSearchRequest,
) -> Result<Vec<SchemaContextObject>, SqlCommandError> {
    let mut identities = HashSet::new();
    let mut seeds = Vec::new();
    for table in &request.tables {
        let schema = table.schema.as_deref().unwrap_or(&request.schema);
        validate_name(schema, "relation search table schema")?;
        validate_name(&table.name, "relation search table name")?;
        let identity = object_identity(schema, &table.name);
        if identities.insert(identity) {
            seeds.push(SchemaContextObject {
                schema: schema.to_string(),
                name: table.name.clone(),
                kind: SchemaContextObjectKind::Table,
            });
        }
    }
    seeds.sort_by(compare_objects);
    Ok(seeds)
}

fn collect_paths(
    seeds: &[SchemaContextObject],
    edges: &[RelationEdge],
    max_depth: u8,
    candidate_limit: usize,
) -> (Vec<RelationSearchPath>, bool) {
    let mut first_hop = BoundedPathCandidates::new(candidate_limit);
    for seed in seeds {
        for edge in edges {
            let Some(next) = incident_neighbor(seed, edge) else {
                continue;
            };
            first_hop.consider(RelationSearchPath {
                nodes: vec![seed.clone(), next.clone()],
                edges: vec![edge.clone()],
            });
        }
    }
    let (mut paths, first_hop_truncated) = first_hop.into_paths();
    if max_depth == 1 || first_hop_truncated {
        return (paths, first_hop_truncated);
    }

    let mut second_hop = BoundedPathCandidates::new(candidate_limit.saturating_sub(paths.len()));
    for path in &paths {
        let current = path
            .nodes
            .last()
            .expect("one-hop relation path always has a node");
        for edge in edges {
            let Some(next) = incident_neighbor(current, edge) else {
                continue;
            };
            if path.nodes.iter().any(|node| same_object(node, next)) {
                continue;
            }
            let mut candidate = path.clone();
            candidate.nodes.push(next.clone());
            candidate.edges.push(edge.clone());
            second_hop.consider(candidate);
        }
    }
    let (second_hop_paths, second_hop_truncated) = second_hop.into_paths();
    paths.extend(second_hop_paths);
    (paths, second_hop_truncated)
}

type PathOrderKey = (String, String);

struct BoundedPathCandidates {
    limit: usize,
    paths: BTreeMap<PathOrderKey, RelationSearchPath>,
    signatures: HashMap<String, PathOrderKey>,
    truncated: bool,
}

impl BoundedPathCandidates {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            paths: BTreeMap::new(),
            signatures: HashMap::new(),
            truncated: false,
        }
    }

    fn consider(&mut self, path: RelationSearchPath) {
        let signature = path_signature(&path);
        let key = (path_sort_key(&path), signature.clone());
        if let Some(existing_key) = self.signatures.get(&signature).cloned() {
            if key >= existing_key {
                return;
            }
            self.paths.remove(&existing_key);
        } else if self.paths.len() == self.limit {
            self.truncated = true;
            let Some(largest_key) = self.paths.last_key_value().map(|(key, _)| key.clone()) else {
                return;
            };
            if key >= largest_key {
                return;
            }
            self.paths.pop_last();
            self.signatures.remove(&largest_key.1);
        }

        self.signatures.insert(signature, key.clone());
        self.paths.insert(key, path);
    }

    fn into_paths(self) -> (Vec<RelationSearchPath>, bool) {
        (self.paths.into_values().collect(), self.truncated)
    }
}

fn build_bounded_result(
    request: &RelationSearchRequest,
    dialect: SqlDialect,
    metadata_revision: u64,
    candidates: Vec<RelationSearchPath>,
    budget: RelationSearchBudget,
    source_truncated: bool,
) -> Result<RelationSearchResult, SqlCommandError> {
    let candidate_count = candidates.len();
    let mut result = RelationSearchResult {
        connection_id: request.connection_id.clone(),
        schema: request.schema.clone(),
        dialect,
        metadata_revision,
        paths: Vec::new(),
        truncated: source_truncated,
        returned_path_count: 0,
        returned_edge_count: 0,
        returned_byte_count: 0,
    };
    update_byte_count(&mut result)?;
    if result.returned_byte_count > budget.max_bytes {
        return Err(SqlCommandError::new(
            "invalid_input",
            "relation search byte budget is too small for the result envelope",
        ));
    }

    for candidate in candidates {
        if result.paths.len() == budget.max_paths
            || result.returned_edge_count + candidate.edges.len() > budget.max_edges
        {
            break;
        }
        result.paths.push(candidate);
        result.returned_path_count = result.paths.len();
        result.returned_edge_count = result.paths.iter().map(|path| path.edges.len()).sum();
        result.truncated = source_truncated || result.paths.len() < candidate_count;
        update_byte_count(&mut result)?;
        if result.returned_byte_count > budget.max_bytes {
            result.paths.pop();
            result.returned_path_count = result.paths.len();
            result.returned_edge_count = result.paths.iter().map(|path| path.edges.len()).sum();
            break;
        }
    }

    result.returned_path_count = result.paths.len();
    result.returned_edge_count = result.paths.iter().map(|path| path.edges.len()).sum();
    result.truncated = source_truncated || result.paths.len() < candidate_count;
    update_byte_count(&mut result)?;
    if result.returned_byte_count > budget.max_bytes {
        return Err(SqlCommandError::new(
            "internal",
            "bounded relation search exceeded its byte budget",
        ));
    }
    Ok(result)
}

fn incident_neighbor<'a>(
    node: &SchemaContextObject,
    edge: &'a RelationEdge,
) -> Option<&'a SchemaContextObject> {
    if same_object(node, &edge.source) {
        Some(&edge.target)
    } else if same_object(node, &edge.target) {
        Some(&edge.source)
    } else {
        None
    }
}

fn path_signature(path: &RelationSearchPath) -> String {
    let mut edges = path.edges.iter().map(edge_sort_key).collect::<Vec<_>>();
    edges.sort();
    edges.join("|")
}

fn path_sort_key(path: &RelationSearchPath) -> String {
    path.nodes
        .iter()
        .map(|node| object_identity(&node.schema, &node.name))
        .collect::<Vec<_>>()
        .join("|")
}

fn edge_sort_key(edge: &RelationEdge) -> String {
    let columns = edge
        .columns
        .iter()
        .map(|column| {
            format!(
                "{}:{}:{}",
                column.ordinal,
                column.source_column.to_lowercase(),
                column.target_column.as_deref().unwrap_or("").to_lowercase()
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{}>{}:{columns}",
        object_identity(&edge.source.schema, &edge.source.name),
        object_identity(&edge.target.schema, &edge.target.name)
    )
}

fn compare_edges(left: &RelationEdge, right: &RelationEdge) -> std::cmp::Ordering {
    edge_sort_key(left).cmp(&edge_sort_key(right))
}

fn compare_objects(left: &SchemaContextObject, right: &SchemaContextObject) -> std::cmp::Ordering {
    object_identity(&left.schema, &left.name).cmp(&object_identity(&right.schema, &right.name))
}

fn same_object(left: &SchemaContextObject, right: &SchemaContextObject) -> bool {
    left.schema.eq_ignore_ascii_case(&right.schema) && left.name.eq_ignore_ascii_case(&right.name)
}

fn object_identity(schema: &str, name: &str) -> String {
    format!("{}.{}", schema.to_lowercase(), name.to_lowercase())
}

fn validate_name(value: &str, label: &str) -> Result<(), SqlCommandError> {
    if value.trim().is_empty() || value.contains('\0') {
        Err(SqlCommandError::new(
            "invalid_input",
            format!("{label} must be a non-empty value without NUL"),
        ))
    } else {
        Ok(())
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

fn update_byte_count(result: &mut RelationSearchResult) -> Result<(), SqlCommandError> {
    for _ in 0..4 {
        let length = serde_json::to_vec(result)
            .map_err(|_| SqlCommandError::new("internal", "relation search serialization failed"))?
            .len();
        if result.returned_byte_count == length {
            return Ok(());
        }
        result.returned_byte_count = length;
    }
    Err(SqlCommandError::new(
        "internal",
        "relation search byte count did not converge",
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    fn object(name: &str) -> SchemaContextObject {
        SchemaContextObject {
            schema: "main".to_string(),
            name: name.to_string(),
            kind: SchemaContextObjectKind::Table,
        }
    }

    fn edge(source: &str, source_column: &str, target: &str, target_column: &str) -> RelationEdge {
        RelationEdge {
            source: object(source),
            target: object(target),
            columns: vec![RelationColumnPair {
                ordinal: 0,
                source_column: source_column.to_string(),
                target_column: Some(target_column.to_string()),
            }],
            evidence_kind: RelationEvidenceKind::DeclaredForeignKey,
            metadata_revision: 7,
        }
    }

    fn request(table: &str, max_depth: u8) -> RelationSearchRequest {
        RelationSearchRequest {
            connection_id: "workspace".to_string(),
            schema: "main".to_string(),
            tables: vec![SqlTableRef {
                schema: Some("main".to_string()),
                name: table.to_string(),
            }],
            max_depth,
            budget: RelationSearchBudget::default(),
        }
    }

    #[test]
    fn relation_search_returns_stable_one_and_two_hop_paths() {
        let snapshot = RelationGraphSnapshot {
            edges: vec![
                edge("payments", "order_id", "orders", "id"),
                edge("orders", "user_id", "users", "id"),
            ],
            truncated: false,
        };

        let result =
            search_relation_graph(&request("users", 2), SqlDialect::Sqlite, 7, &snapshot).unwrap();

        assert_eq!(result.paths.len(), 2);
        assert_eq!(
            result.paths[0]
                .nodes
                .iter()
                .map(|node| node.name.as_str())
                .collect::<Vec<_>>(),
            vec!["users", "orders"]
        );
        assert_eq!(
            result.paths[1]
                .nodes
                .iter()
                .map(|node| node.name.as_str())
                .collect::<Vec<_>>(),
            vec!["users", "orders", "payments"]
        );
        assert_eq!(result.returned_edge_count, 3);
        assert_eq!(
            result.returned_byte_count,
            serde_json::to_vec(&result).unwrap().len()
        );
        assert!(!result.truncated);
    }

    #[test]
    fn relation_search_prioritizes_every_seed_one_hop_before_two_hop_paths() {
        let snapshot = RelationGraphSnapshot {
            edges: vec![
                edge("a_mid", "leaf_one_id", "a_leaf_one", "id"),
                edge("a_mid", "leaf_two_id", "a_leaf_two", "id"),
                edge("a_mid", "seed_id", "a_seed", "id"),
                edge("z_seed", "leaf_id", "z_leaf", "id"),
            ],
            truncated: false,
        };
        let mut search_request = request("a_seed", 2);
        search_request.tables.push(SqlTableRef {
            schema: Some("main".to_string()),
            name: "z_seed".to_string(),
        });
        search_request.budget.max_paths = 2;

        let result =
            search_relation_graph(&search_request, SqlDialect::Sqlite, 7, &snapshot).unwrap();

        assert_eq!(
            result
                .paths
                .iter()
                .map(|path| {
                    path.nodes
                        .iter()
                        .map(|node| node.name.as_str())
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>(),
            vec![vec!["a_seed", "a_mid"], vec!["z_seed", "z_leaf"]]
        );
        assert!(result.paths.iter().all(|path| path.edges.len() == 1));
        assert!(result.truncated);
    }

    #[test]
    fn relation_search_drops_the_last_path_at_the_exact_complete_flag_byte_boundary() {
        let snapshot = RelationGraphSnapshot {
            edges: vec![edge("orders", "user_id", "users", "id")],
            truncated: false,
        };
        let mut search_request = request("orders", 1);
        search_request.budget.max_paths = 1;
        let complete =
            search_relation_graph(&search_request, SqlDialect::Sqlite, 7, &snapshot).unwrap();
        let mut truncated_encoding = complete.clone();
        truncated_encoding.truncated = true;
        update_byte_count(&mut truncated_encoding).unwrap();
        assert!(complete.returned_byte_count > truncated_encoding.returned_byte_count);
        search_request.budget.max_bytes = truncated_encoding.returned_byte_count;

        let result =
            search_relation_graph(&search_request, SqlDialect::Sqlite, 7, &snapshot).unwrap();

        assert!(result.paths.is_empty());
        assert!(result.truncated);
        assert!(result.returned_byte_count <= search_request.budget.max_bytes);
    }

    #[test]
    fn relation_search_distinguishes_supported_empty_graph_from_truncation() {
        let result = search_relation_graph(
            &request("users", 2),
            SqlDialect::Sqlite,
            7,
            &RelationGraphSnapshot {
                edges: Vec::new(),
                truncated: false,
            },
        )
        .unwrap();

        assert!(result.paths.is_empty());
        assert!(!result.truncated);
    }

    #[test]
    fn relation_search_applies_whole_path_and_byte_budgets() {
        let snapshot = RelationGraphSnapshot {
            edges: vec![
                edge("orders", "user_id", "users", "id"),
                edge("payments", "order_id", "orders", "id"),
            ],
            truncated: false,
        };
        let roomy =
            search_relation_graph(&request("users", 2), SqlDialect::Sqlite, 7, &snapshot).unwrap();
        let mut bounded = request("users", 2);
        bounded.budget.max_paths = 1;
        bounded.budget.max_edges = 1;
        bounded.budget.max_bytes = roomy.returned_byte_count;

        let result = search_relation_graph(&bounded, SqlDialect::Sqlite, 7, &snapshot).unwrap();

        assert_eq!(result.paths.len(), 1);
        assert_eq!(result.returned_edge_count, 1);
        assert!(result.truncated);
        assert!(result.returned_byte_count <= bounded.budget.max_bytes);
    }

    #[test]
    fn relation_search_rejects_unbounded_requests() {
        let snapshot = RelationGraphSnapshot {
            edges: Vec::new(),
            truncated: false,
        };
        let mut invalid_depth = request("users", 3);
        assert!(search_relation_graph(&invalid_depth, SqlDialect::Sqlite, 7, &snapshot).is_err());
        invalid_depth.max_depth = 1;
        invalid_depth.tables.clear();
        assert!(search_relation_graph(&invalid_depth, SqlDialect::Sqlite, 7, &snapshot).is_err());
    }

    #[test]
    fn relation_search_caps_dense_graph_candidates_before_result_building() {
        let edges = (0..20)
            .map(|index| edge("users", "id", &format!("orders_{index:02}"), "user_id"))
            .collect::<Vec<_>>();

        let (paths, truncated) = collect_paths(&[object("users")], &edges, 2, 4);

        assert_eq!(paths.len(), 4);
        assert!(truncated);
    }

    #[test]
    fn relation_cache_reuses_and_invalidates_revision_scoped_snapshots() {
        let cache = RelationGraphCache::new(Duration::from_secs(30));
        let key = RelationCacheKey::new("workspace", "main", 7);
        let loads = AtomicUsize::new(0);
        let first = cache
            .get_or_try_insert_with(&key, Instant::now(), || {
                loads.fetch_add(1, Ordering::Relaxed);
                Ok(RelationGraphSnapshot {
                    edges: Vec::new(),
                    truncated: false,
                })
            })
            .unwrap();
        let second = cache
            .get_or_try_insert_with(&key, Instant::now(), || {
                loads.fetch_add(1, Ordering::Relaxed);
                Ok(RelationGraphSnapshot {
                    edges: vec![edge("orders", "user_id", "users", "id")],
                    truncated: false,
                })
            })
            .unwrap();

        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(loads.load(Ordering::Relaxed), 1);
        let next_revision = RelationCacheKey::new("workspace", "main", 8);
        let revised = cache
            .get_or_try_insert_with(&next_revision, Instant::now(), || {
                loads.fetch_add(1, Ordering::Relaxed);
                Ok(RelationGraphSnapshot {
                    edges: Vec::new(),
                    truncated: false,
                })
            })
            .unwrap();
        assert!(!Arc::ptr_eq(&first, &revised));
        assert_eq!(loads.load(Ordering::Relaxed), 2);
        assert_eq!(cache.invalidate("workspace"), 2);
        let refreshed = cache
            .get_or_try_insert_with(&key, Instant::now(), || {
                loads.fetch_add(1, Ordering::Relaxed);
                Ok(RelationGraphSnapshot {
                    edges: vec![edge("orders", "user_id", "users", "id")],
                    truncated: false,
                })
            })
            .unwrap();
        assert_eq!(refreshed.edges.len(), 1);
        assert_eq!(loads.load(Ordering::Relaxed), 3);
    }

    #[test]
    fn relation_cache_does_not_retain_failed_snapshots() {
        let cache = RelationGraphCache::new(Duration::from_secs(30));
        let key = RelationCacheKey::new("workspace", "main", 7);
        let loads = AtomicUsize::new(0);

        let error = cache
            .get_or_try_insert_with(&key, Instant::now(), || {
                loads.fetch_add(1, Ordering::Relaxed);
                Err(SqlCommandError::new("internal", "invalid graph"))
            })
            .unwrap_err();
        let recovered = cache
            .get_or_try_insert_with(&key, Instant::now(), || {
                loads.fetch_add(1, Ordering::Relaxed);
                Ok(RelationGraphSnapshot {
                    edges: Vec::new(),
                    truncated: false,
                })
            })
            .unwrap();

        assert!(matches!(error, SqlCommandError::Internal { .. }));
        assert!(recovered.edges.is_empty());
        assert_eq!(loads.load(Ordering::Relaxed), 2);
    }
}
