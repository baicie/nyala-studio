//! Bounded, typed normalization for `SQLite` `EXPLAIN QUERY PLAN` evidence.
//!
//! `SQLite` exposes qualitative plan structure rather than a stable cost model.
//! This module therefore compares only explicit access modes and temporary
//! B-tree use. It never treats a structural verdict as measured performance.

#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde::Serialize;

use super::super::dialect::SqlDialect;
use super::super::types::{SqlCellKind, SqlCellValue, SqlCommandError, SqlQueryResult};

pub const SQLITE_PLAN_NORMALIZATION_VERSION: u16 = 1;
pub const MAX_SQLITE_PLAN_NODES: usize = 256;
pub const MAX_SQLITE_PLAN_DETAIL_BYTES: usize = 4 * 1024;
pub const MAX_SQLITE_PLAN_SERIALIZED_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlitePlanIdentity {
    pub connection_id: String,
    pub dialect: SqlDialect,
    pub metadata_revision: u64,
    pub normalization_version: u16,
}

impl SqlitePlanIdentity {
    pub fn new(
        connection_id: impl Into<String>,
        metadata_revision: u64,
    ) -> Result<Self, SqlCommandError> {
        let connection_id = connection_id.into();
        let connection_id = connection_id.trim();
        if connection_id.is_empty() || connection_id.contains('\0') {
            return Err(SqlCommandError::new(
                "invalid_input",
                "SQLite plan connection id must not be blank or contain NUL",
            ));
        }
        if metadata_revision == 0 {
            return Err(SqlCommandError::new(
                "invalid_input",
                "SQLite plan metadata revision must be greater than zero",
            ));
        }

        Ok(Self {
            connection_id: connection_id.to_string(),
            dialect: SqlDialect::Sqlite,
            metadata_revision,
            normalization_version: SQLITE_PLAN_NORMALIZATION_VERSION,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlitePlanSnapshot {
    pub identity: SqlitePlanIdentity,
    pub nodes: Vec<SqlitePlanNode>,
    pub source_row_count: usize,
    pub returned_node_count: usize,
    pub returned_byte_count: usize,
    pub malformed_row_count: usize,
    pub truncated: bool,
}

impl SqlitePlanSnapshot {
    pub fn is_complete(&self) -> bool {
        !self.truncated && self.malformed_row_count == 0 && !self.nodes.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlitePlanNode {
    pub ordinal: usize,
    pub id: i64,
    pub parent_id: i64,
    pub detail: String,
    pub operation: SqlitePlanOperation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loop_role: Option<SqlitePlanLoopRole>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SqlitePlanOperation {
    Scan {
        target: String,
        access: SqliteScanAccess,
    },
    IndexSearch {
        target: String,
        index: SqliteIndexSource,
        covering: bool,
    },
    TemporaryBTree {
        purpose: SqliteTemporaryBTreePurpose,
    },
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SqliteScanAccess {
    TableOrSubquery,
    Index {
        index: SqliteIndexSource,
        covering: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SqliteIndexSource {
    Named { name: String },
    Automatic { partial: bool },
    IntegerPrimaryKey,
    PrimaryKey,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SqliteTemporaryBTreePurpose {
    OrderBy,
    RightPartOfOrderBy,
    GroupBy,
    Distinct,
    CompoundQuery,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SqlitePlanLoopRole {
    Single,
    Join { position: usize },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SqlitePlanComparisonVerdict {
    StructurallyImproved,
    Equivalent,
    StructurallyRegressed,
    Uncertain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SqlitePlanUncertaintyReason {
    MissingOriginal,
    MissingRewritten,
    IndexMetadataUnavailable,
    OriginalIncomplete,
    RewrittenIncomplete,
    ConnectionMismatch,
    DialectMismatch,
    MetadataRevisionMismatch,
    NormalizationVersionMismatch,
    UnsupportedOperation,
    TopologyMismatch,
    UnrankedAccessChange,
    MixedStructuralSignals,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[expect(
    clippy::struct_field_names,
    reason = "the count suffix is part of the stable serialized plan evidence contract"
)]
pub struct SqlitePlanSummary {
    pub scan_count: usize,
    pub index_search_count: usize,
    pub join_input_count: usize,
    pub temporary_btree_count: usize,
    pub unknown_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SqlitePlanAccessClass {
    Scan,
    IndexSearch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SqlitePlanStructuralChange {
    AccessMode {
        target: String,
        loop_role: SqlitePlanLoopRole,
        before: SqlitePlanAccessClass,
        after: SqlitePlanAccessClass,
    },
    TemporaryBTreeCount {
        purpose: SqliteTemporaryBTreePurpose,
        before: usize,
        after: usize,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlitePlanComparison {
    pub verdict: SqlitePlanComparisonVerdict,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uncertainty_reason: Option<SqlitePlanUncertaintyReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original: Option<SqlitePlanSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rewritten: Option<SqlitePlanSummary>,
    pub changes: Vec<SqlitePlanStructuralChange>,
    pub performance_verified: bool,
}

/// Normalizes the documented `SQLite` plan columns by name. Node ids and parent
/// ids are retained for display and loop-role derivation, but comparisons do
/// not rely on their numeric values because `SQLite` does not stabilize them.
pub fn normalize_sqlite_plan(
    identity: SqlitePlanIdentity,
    plan: &SqlQueryResult,
) -> Result<SqlitePlanSnapshot, SqlCommandError> {
    validate_identity(&identity)?;

    let source_row_count = plan.rows.len();
    let mut malformed_row_count = usize::from(plan.row_count != source_row_count);
    let mut truncated = plan.truncated || source_row_count > MAX_SQLITE_PLAN_NODES;
    let Some(columns) = required_columns(plan) else {
        let mut snapshot = SqlitePlanSnapshot {
            identity,
            nodes: Vec::new(),
            source_row_count,
            returned_node_count: 0,
            returned_byte_count: 0,
            malformed_row_count: malformed_row_count.max(1),
            truncated,
        };
        finalize_snapshot_bytes(&mut snapshot)?;
        return Ok(snapshot);
    };

    let mut ids = HashSet::new();
    let mut candidates = Vec::with_capacity(source_row_count.min(MAX_SQLITE_PLAN_NODES));
    for (ordinal, row) in plan.rows.iter().take(MAX_SQLITE_PLAN_NODES).enumerate() {
        let Some(id) = integer_cell(row.get(columns.id)) else {
            malformed_row_count = malformed_row_count.saturating_add(1);
            continue;
        };
        let Some(parent_id) = integer_cell(row.get(columns.parent)) else {
            malformed_row_count = malformed_row_count.saturating_add(1);
            continue;
        };
        let Some(detail) = text_cell(row.get(columns.detail)) else {
            malformed_row_count = malformed_row_count.saturating_add(1);
            continue;
        };
        let detail = detail.trim();
        if detail.is_empty() || detail.contains('\0') {
            malformed_row_count = malformed_row_count.saturating_add(1);
            continue;
        }
        if detail.len() > MAX_SQLITE_PLAN_DETAIL_BYTES {
            truncated = true;
            break;
        }
        if id == parent_id || !ids.insert(id) {
            malformed_row_count = malformed_row_count.saturating_add(1);
            continue;
        }

        candidates.push(SqlitePlanNode {
            ordinal,
            id,
            parent_id,
            detail: detail.to_string(),
            operation: parse_operation(detail),
            loop_role: None,
        });
    }

    assign_loop_roles(&mut candidates);

    let mut snapshot = SqlitePlanSnapshot {
        identity,
        nodes: Vec::with_capacity(candidates.len()),
        source_row_count,
        returned_node_count: 0,
        returned_byte_count: 0,
        malformed_row_count,
        truncated,
    };
    for node in candidates {
        snapshot.nodes.push(node);
        snapshot.returned_node_count = snapshot.nodes.len();
        if measure_snapshot_bytes(&mut snapshot)? > MAX_SQLITE_PLAN_SERIALIZED_BYTES {
            snapshot.nodes.pop();
            snapshot.returned_node_count = snapshot.nodes.len();
            snapshot.truncated = true;
            break;
        }
    }
    finalize_snapshot_bytes(&mut snapshot)?;
    Ok(snapshot)
}

/// Compares only stable structural evidence. `performance_verified` is always
/// false because this module neither executes the statements nor has costs.
pub fn compare_sqlite_plans(
    original: Option<&SqlitePlanSnapshot>,
    rewritten: Option<&SqlitePlanSnapshot>,
) -> SqlitePlanComparison {
    let original_summary = original.map(summarize_plan);
    let rewritten_summary = rewritten.map(summarize_plan);
    let uncertain =
        |reason| uncertain_comparison(reason, original_summary.clone(), rewritten_summary.clone());

    let Some(original) = original else {
        return uncertain(SqlitePlanUncertaintyReason::MissingOriginal);
    };
    let Some(rewritten) = rewritten else {
        return uncertain(SqlitePlanUncertaintyReason::MissingRewritten);
    };
    if let Err(reason) = validate_comparable_plans(original, rewritten) {
        return uncertain(reason);
    }
    let mut signals = match compare_access_signals(original, rewritten) {
        Ok(signals) => signals,
        Err(reason) => return uncertain(reason),
    };
    append_temporary_btree_signals(original, rewritten, &mut signals);
    finish_plan_comparison(original_summary, rewritten_summary, signals)
}

fn validate_comparable_plans(
    original: &SqlitePlanSnapshot,
    rewritten: &SqlitePlanSnapshot,
) -> Result<(), SqlitePlanUncertaintyReason> {
    if original.identity.connection_id != rewritten.identity.connection_id {
        return Err(SqlitePlanUncertaintyReason::ConnectionMismatch);
    }
    if original.identity.dialect != SqlDialect::Sqlite
        || rewritten.identity.dialect != SqlDialect::Sqlite
        || original.identity.dialect != rewritten.identity.dialect
    {
        return Err(SqlitePlanUncertaintyReason::DialectMismatch);
    }
    if original.identity.metadata_revision != rewritten.identity.metadata_revision {
        return Err(SqlitePlanUncertaintyReason::MetadataRevisionMismatch);
    }
    if original.identity.normalization_version != SQLITE_PLAN_NORMALIZATION_VERSION
        || rewritten.identity.normalization_version != SQLITE_PLAN_NORMALIZATION_VERSION
        || original.identity.normalization_version != rewritten.identity.normalization_version
    {
        return Err(SqlitePlanUncertaintyReason::NormalizationVersionMismatch);
    }
    if !original.is_complete() {
        return Err(SqlitePlanUncertaintyReason::OriginalIncomplete);
    }
    if !rewritten.is_complete() {
        return Err(SqlitePlanUncertaintyReason::RewrittenIncomplete);
    }
    if has_unsupported_operation(original) || has_unsupported_operation(rewritten) {
        return Err(SqlitePlanUncertaintyReason::UnsupportedOperation);
    }
    Ok(())
}

#[derive(Default)]
struct StructuralSignals {
    changes: Vec<SqlitePlanStructuralChange>,
    improved: bool,
    regressed: bool,
}

fn compare_access_signals(
    original: &SqlitePlanSnapshot,
    rewritten: &SqlitePlanSnapshot,
) -> Result<StructuralSignals, SqlitePlanUncertaintyReason> {
    let original_accesses =
        access_slots(original).ok_or(SqlitePlanUncertaintyReason::TopologyMismatch)?;
    let rewritten_accesses =
        access_slots(rewritten).ok_or(SqlitePlanUncertaintyReason::TopologyMismatch)?;
    if original_accesses.len() != rewritten_accesses.len()
        || original_accesses
            .iter()
            .zip(&rewritten_accesses)
            .any(|(before, after)| {
                !before.target.eq_ignore_ascii_case(&after.target)
                    || before.loop_role != after.loop_role
            })
    {
        return Err(SqlitePlanUncertaintyReason::TopologyMismatch);
    }

    let mut signals = StructuralSignals::default();
    for (before, after) in original_accesses.iter().zip(&rewritten_accesses) {
        let ranked = match (before.class, after.class) {
            (SqlitePlanAccessClass::Scan, SqlitePlanAccessClass::IndexSearch) => {
                signals.improved = true;
                true
            }
            (SqlitePlanAccessClass::IndexSearch, SqlitePlanAccessClass::Scan) => {
                signals.regressed = true;
                true
            }
            _ => false,
        };
        if ranked {
            signals
                .changes
                .push(SqlitePlanStructuralChange::AccessMode {
                    target: before.target.clone(),
                    loop_role: before.loop_role.clone(),
                    before: before.class,
                    after: after.class,
                });
        } else if before.operation != after.operation
            || !before.detail.eq_ignore_ascii_case(&after.detail)
        {
            return Err(SqlitePlanUncertaintyReason::UnrankedAccessChange);
        }
    }
    Ok(signals)
}

fn append_temporary_btree_signals(
    original: &SqlitePlanSnapshot,
    rewritten: &SqlitePlanSnapshot,
    signals: &mut StructuralSignals,
) {
    let original_counts = temporary_btree_counts(original);
    let rewritten_counts = temporary_btree_counts(rewritten);
    for purpose in original_counts
        .keys()
        .chain(rewritten_counts.keys())
        .copied()
        .collect::<BTreeSet<_>>()
    {
        let before = original_counts.get(&purpose).copied().unwrap_or(0);
        let after = rewritten_counts.get(&purpose).copied().unwrap_or(0);
        if before == after {
            continue;
        }
        signals.improved |= after < before;
        signals.regressed |= after > before;
        signals
            .changes
            .push(SqlitePlanStructuralChange::TemporaryBTreeCount {
                purpose,
                before,
                after,
            });
    }
}

fn finish_plan_comparison(
    original: Option<SqlitePlanSummary>,
    rewritten: Option<SqlitePlanSummary>,
    signals: StructuralSignals,
) -> SqlitePlanComparison {
    let uncertainty_reason = (signals.improved && signals.regressed)
        .then_some(SqlitePlanUncertaintyReason::MixedStructuralSignals);
    let verdict = if uncertainty_reason.is_some() {
        SqlitePlanComparisonVerdict::Uncertain
    } else if signals.improved {
        SqlitePlanComparisonVerdict::StructurallyImproved
    } else if signals.regressed {
        SqlitePlanComparisonVerdict::StructurallyRegressed
    } else {
        SqlitePlanComparisonVerdict::Equivalent
    };
    SqlitePlanComparison {
        verdict,
        uncertainty_reason,
        original,
        rewritten,
        changes: signals.changes,
        performance_verified: false,
    }
}

#[derive(Clone, Copy)]
struct RequiredColumns {
    id: usize,
    parent: usize,
    detail: usize,
}

fn required_columns(plan: &SqlQueryResult) -> Option<RequiredColumns> {
    Some(RequiredColumns {
        id: unique_column_ordinal(plan, "id")?,
        parent: unique_column_ordinal(plan, "parent")?,
        detail: unique_column_ordinal(plan, "detail")?,
    })
}

fn unique_column_ordinal(plan: &SqlQueryResult, name: &str) -> Option<usize> {
    let mut matches = plan
        .columns
        .iter()
        .filter(|column| column.name.eq_ignore_ascii_case(name));
    let ordinal = matches.next()?.ordinal;
    matches.next().is_none().then_some(ordinal)
}

fn integer_cell(cell: Option<&SqlCellValue>) -> Option<i64> {
    let cell = cell?;
    (cell.kind == SqlCellKind::Integer)
        .then(|| cell.value.as_ref()?.as_i64())
        .flatten()
}

fn text_cell(cell: Option<&SqlCellValue>) -> Option<&str> {
    let cell = cell?;
    (cell.kind == SqlCellKind::Text)
        .then(|| cell.value.as_ref()?.as_str())
        .flatten()
}

fn parse_operation(detail: &str) -> SqlitePlanOperation {
    let detail = detail.trim_end();
    if let Some(detail) = strip_ascii_case_suffix(detail, " LEFT-JOIN") {
        return parse_unambiguous_left_join_search(detail).unwrap_or(SqlitePlanOperation::Unknown);
    }
    if strip_ascii_case_suffix(detail, " RIGHT-JOIN").is_some()
        || strip_ascii_case_suffix(detail, " FULL-JOIN").is_some()
    {
        return SqlitePlanOperation::Unknown;
    }
    if let Some(purpose) = strip_ascii_case_prefix(detail, "USE TEMP B-TREE FOR ") {
        return SqlitePlanOperation::TemporaryBTree {
            purpose: parse_temporary_btree_purpose(purpose),
        };
    }
    if let Some(rest) = strip_ascii_case_prefix(detail, "SCAN ") {
        return parse_scan(rest).unwrap_or(SqlitePlanOperation::Unknown);
    }
    if let Some(rest) = strip_ascii_case_prefix(detail, "SEARCH ") {
        return parse_search(rest).unwrap_or(SqlitePlanOperation::Unknown);
    }
    SqlitePlanOperation::Unknown
}

fn parse_unambiguous_left_join_search(detail: &str) -> Option<SqlitePlanOperation> {
    let rest = strip_ascii_case_prefix(detail, "SEARCH ")?;
    let (_, access) = split_ascii_case_once(rest, " USING ")?;
    let predicate_start = access.rfind(" (")?;
    let predicate = access.get(predicate_start + 1..)?.trim();
    if !predicate.starts_with('(') || !predicate.ends_with(')') {
        return None;
    }
    parse_search(rest)
}

fn parse_scan(rest: &str) -> Option<SqlitePlanOperation> {
    if rest.trim().eq_ignore_ascii_case("CONSTANT ROW") {
        return None;
    }
    let (target, access) = match split_ascii_case_once(rest, " USING ") {
        Some((target, access)) => {
            let (index, covering) = parse_index_access(access)?;
            (target.trim(), SqliteScanAccess::Index { index, covering })
        }
        None => (rest.trim(), SqliteScanAccess::TableOrSubquery),
    };
    valid_plan_name(target).then(|| SqlitePlanOperation::Scan {
        target: target.to_string(),
        access,
    })
}

fn parse_search(rest: &str) -> Option<SqlitePlanOperation> {
    let (target, access) = split_ascii_case_once(rest, " USING ")?;
    let target = target.trim();
    if !valid_plan_name(target) {
        return None;
    }
    let (index, covering) = parse_index_access(access)?;
    Some(SqlitePlanOperation::IndexSearch {
        target: target.to_string(),
        index,
        covering,
    })
}

fn parse_index_access(value: &str) -> Option<(SqliteIndexSource, bool)> {
    let value = value.trim();
    for (prefix, partial) in [
        ("AUTOMATIC PARTIAL COVERING INDEX", true),
        ("AUTOMATIC PARTIAL INDEX", true),
        ("AUTOMATIC COVERING INDEX", false),
        ("AUTOMATIC INDEX", false),
    ] {
        if let Some(suffix) = strip_ascii_case_prefix(value, prefix) {
            return valid_access_suffix(suffix).then_some((
                SqliteIndexSource::Automatic { partial },
                prefix.contains("COVERING"),
            ));
        }
    }
    if let Some(suffix) = strip_ascii_case_prefix(value, "INTEGER PRIMARY KEY") {
        return valid_access_suffix(suffix)
            .then_some((SqliteIndexSource::IntegerPrimaryKey, false));
    }
    if let Some(suffix) = strip_ascii_case_prefix(value, "PRIMARY KEY") {
        return valid_access_suffix(suffix).then_some((SqliteIndexSource::PrimaryKey, false));
    }
    if let Some(suffix) = strip_ascii_case_prefix(value, "COVERING INDEX ") {
        return parse_named_index(suffix).map(|name| (SqliteIndexSource::Named { name }, true));
    }
    strip_ascii_case_prefix(value, "INDEX ")
        .and_then(parse_named_index)
        .map(|name| (SqliteIndexSource::Named { name }, false))
}

fn parse_named_index(value: &str) -> Option<String> {
    let value = value.trim();
    let name = value
        .rfind(" (")
        .map_or(value, |predicate_start| &value[..predicate_start])
        .trim();
    valid_plan_name(name).then(|| name.to_string())
}

fn valid_access_suffix(value: &str) -> bool {
    let value = value.trim();
    value.is_empty() || (value.starts_with('(') && value.ends_with(')'))
}

fn valid_plan_name(value: &str) -> bool {
    !value.is_empty() && !value.contains('\0')
}

fn parse_temporary_btree_purpose(value: &str) -> SqliteTemporaryBTreePurpose {
    match value.trim().to_ascii_uppercase().as_str() {
        "ORDER BY" => SqliteTemporaryBTreePurpose::OrderBy,
        "RIGHT PART OF ORDER BY" => SqliteTemporaryBTreePurpose::RightPartOfOrderBy,
        "GROUP BY" => SqliteTemporaryBTreePurpose::GroupBy,
        "DISTINCT" => SqliteTemporaryBTreePurpose::Distinct,
        "COMPOUND QUERY" => SqliteTemporaryBTreePurpose::CompoundQuery,
        _ => SqliteTemporaryBTreePurpose::Other,
    }
}

fn strip_ascii_case_prefix<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value
        .get(..prefix.len())
        .filter(|candidate| candidate.eq_ignore_ascii_case(prefix))
        .map(|_| &value[prefix.len()..])
}

fn split_ascii_case_once<'a>(value: &'a str, separator: &str) -> Option<(&'a str, &'a str)> {
    let position = value
        .to_ascii_uppercase()
        .find(&separator.to_ascii_uppercase())?;
    Some((&value[..position], &value[position + separator.len()..]))
}

fn strip_ascii_case_suffix<'a>(value: &'a str, suffix: &str) -> Option<&'a str> {
    let start = value.len().checked_sub(suffix.len())?;
    value
        .get(start..)
        .filter(|candidate| candidate.eq_ignore_ascii_case(suffix))
        .map(|_| value[..start].trim_end())
}

fn assign_loop_roles(nodes: &mut [SqlitePlanNode]) {
    let ids = nodes.iter().map(|node| node.id).collect::<HashSet<_>>();
    let mut root_accesses = BTreeMap::<i64, Vec<usize>>::new();
    for (index, node) in nodes.iter().enumerate() {
        if is_access_operation(&node.operation) && !ids.contains(&node.parent_id) {
            root_accesses.entry(node.parent_id).or_default().push(index);
        }
    }
    for indexes in root_accesses.values() {
        if indexes.len() == 1 {
            nodes[indexes[0]].loop_role = Some(SqlitePlanLoopRole::Single);
        } else {
            for (position, index) in indexes.iter().copied().enumerate() {
                nodes[index].loop_role = Some(SqlitePlanLoopRole::Join { position });
            }
        }
    }
}

fn is_access_operation(operation: &SqlitePlanOperation) -> bool {
    matches!(
        operation,
        SqlitePlanOperation::Scan { .. } | SqlitePlanOperation::IndexSearch { .. }
    )
}

fn validate_identity(identity: &SqlitePlanIdentity) -> Result<(), SqlCommandError> {
    if identity.connection_id.trim().is_empty() || identity.connection_id.contains('\0') {
        return Err(SqlCommandError::new(
            "invalid_input",
            "SQLite plan connection id must not be blank or contain NUL",
        ));
    }
    if identity.metadata_revision == 0 {
        return Err(SqlCommandError::new(
            "invalid_input",
            "SQLite plan metadata revision must be greater than zero",
        ));
    }
    if identity.dialect != SqlDialect::Sqlite {
        return Err(SqlCommandError::new(
            "validation",
            "SQLite plan normalization requires the SQLite dialect",
        ));
    }
    if identity.normalization_version != SQLITE_PLAN_NORMALIZATION_VERSION {
        return Err(SqlCommandError::new(
            "validation",
            "SQLite plan normalization version is unsupported",
        ));
    }
    Ok(())
}

fn summarize_plan(plan: &SqlitePlanSnapshot) -> SqlitePlanSummary {
    let mut summary = SqlitePlanSummary {
        scan_count: 0,
        index_search_count: 0,
        join_input_count: 0,
        temporary_btree_count: 0,
        unknown_count: 0,
    };
    for node in &plan.nodes {
        match &node.operation {
            SqlitePlanOperation::Scan { .. } => summary.scan_count += 1,
            SqlitePlanOperation::IndexSearch { .. } => summary.index_search_count += 1,
            SqlitePlanOperation::TemporaryBTree { .. } => summary.temporary_btree_count += 1,
            SqlitePlanOperation::Unknown => summary.unknown_count += 1,
        }
        if matches!(&node.loop_role, Some(SqlitePlanLoopRole::Join { .. })) {
            summary.join_input_count += 1;
        }
    }
    summary
}

fn has_unsupported_operation(plan: &SqlitePlanSnapshot) -> bool {
    plan.nodes.iter().any(|node| {
        matches!(&node.operation, SqlitePlanOperation::Unknown)
            || matches!(
                &node.operation,
                SqlitePlanOperation::TemporaryBTree {
                    purpose: SqliteTemporaryBTreePurpose::Other
                }
            )
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AccessSlot {
    target: String,
    loop_role: SqlitePlanLoopRole,
    class: SqlitePlanAccessClass,
    operation: SqlitePlanOperation,
    detail: String,
}

fn access_slots(plan: &SqlitePlanSnapshot) -> Option<Vec<AccessSlot>> {
    plan.nodes
        .iter()
        .filter_map(|node| {
            let (target, class) = match &node.operation {
                SqlitePlanOperation::Scan { target, .. } => (target, SqlitePlanAccessClass::Scan),
                SqlitePlanOperation::IndexSearch { target, .. } => {
                    (target, SqlitePlanAccessClass::IndexSearch)
                }
                _ => return None,
            };
            Some(node.loop_role.clone().map(|loop_role| AccessSlot {
                target: target.clone(),
                loop_role,
                class,
                operation: node.operation.clone(),
                detail: node.detail.clone(),
            }))
        })
        .collect()
}

fn measure_snapshot_bytes(snapshot: &mut SqlitePlanSnapshot) -> Result<usize, SqlCommandError> {
    snapshot.returned_byte_count = 0;
    for _ in 0..8 {
        let measured = serde_json::to_vec(snapshot)
            .map_err(|error| SqlCommandError::new("internal", error.to_string()))?
            .len();
        if measured == snapshot.returned_byte_count {
            return Ok(measured);
        }
        snapshot.returned_byte_count = measured;
    }
    Err(SqlCommandError::new(
        "internal",
        "SQLite normalized plan byte count did not converge",
    ))
}

fn finalize_snapshot_bytes(snapshot: &mut SqlitePlanSnapshot) -> Result<(), SqlCommandError> {
    let measured = measure_snapshot_bytes(snapshot)?;
    if measured > MAX_SQLITE_PLAN_SERIALIZED_BYTES {
        return Err(SqlCommandError::new(
            "invalid_input",
            "SQLite normalized plan identity exceeds the serialized byte budget",
        ));
    }
    Ok(())
}

fn temporary_btree_counts(
    plan: &SqlitePlanSnapshot,
) -> BTreeMap<SqliteTemporaryBTreePurpose, usize> {
    let mut counts = BTreeMap::new();
    for node in &plan.nodes {
        if let SqlitePlanOperation::TemporaryBTree { purpose } = &node.operation {
            *counts.entry(*purpose).or_insert(0) += 1;
        }
    }
    counts
}

fn uncertain_comparison(
    reason: SqlitePlanUncertaintyReason,
    original: Option<SqlitePlanSummary>,
    rewritten: Option<SqlitePlanSummary>,
) -> SqlitePlanComparison {
    SqlitePlanComparison {
        verdict: SqlitePlanComparisonVerdict::Uncertain,
        uncertainty_reason: Some(reason),
        original,
        rewritten,
        changes: Vec::new(),
        performance_verified: false,
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::types::{SqlCellValue, SqlResultColumn};
    use super::*;

    fn identity(connection_id: &str, metadata_revision: u64) -> SqlitePlanIdentity {
        SqlitePlanIdentity::new(connection_id, metadata_revision).expect("valid plan identity")
    }

    fn plan_result(rows: &[(i64, i64, &str)]) -> SqlQueryResult {
        SqlQueryResult {
            columns: vec![
                SqlResultColumn {
                    name: "id".to_string(),
                    ordinal: 0,
                },
                SqlResultColumn {
                    name: "parent".to_string(),
                    ordinal: 1,
                },
                SqlResultColumn {
                    name: "notused".to_string(),
                    ordinal: 2,
                },
                SqlResultColumn {
                    name: "detail".to_string(),
                    ordinal: 3,
                },
            ],
            rows: rows
                .iter()
                .map(|(id, parent, detail)| {
                    vec![
                        SqlCellValue::integer(*id),
                        SqlCellValue::integer(*parent),
                        SqlCellValue::integer(0),
                        SqlCellValue::text(*detail),
                    ]
                })
                .collect(),
            affected_rows: None,
            row_count: rows.len(),
            elapsed_ms: 0,
            truncated: false,
        }
    }

    fn in_memory_plan_result(sql: &str) -> SqlQueryResult {
        in_memory_plan_result_with_schema(
            "CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT NOT NULL);\
             CREATE INDEX idx_users_email ON users(email);",
            sql,
        )
    }

    fn in_memory_plan_result_with_schema(schema: &str, sql: &str) -> SqlQueryResult {
        let connection = rusqlite::Connection::open_in_memory().expect("open in-memory SQLite");
        connection
            .execute_batch(schema)
            .expect("seed in-memory plan fixture");
        let explain_sql = format!("EXPLAIN QUERY PLAN {sql}");
        let mut statement = connection
            .prepare(&explain_sql)
            .expect("prepare real SQLite explain");
        let rows = statement
            .query_map([], |row| {
                Ok(vec![
                    SqlCellValue::integer(row.get(0)?),
                    SqlCellValue::integer(row.get(1)?),
                    SqlCellValue::integer(row.get(2)?),
                    SqlCellValue::text(row.get::<_, String>(3)?),
                ])
            })
            .expect("execute real SQLite explain")
            .collect::<Result<Vec<_>, _>>()
            .expect("read real SQLite explain rows");
        SqlQueryResult {
            columns: vec![
                SqlResultColumn {
                    name: "id".to_string(),
                    ordinal: 0,
                },
                SqlResultColumn {
                    name: "parent".to_string(),
                    ordinal: 1,
                },
                SqlResultColumn {
                    name: "notused".to_string(),
                    ordinal: 2,
                },
                SqlResultColumn {
                    name: "detail".to_string(),
                    ordinal: 3,
                },
            ],
            row_count: rows.len(),
            rows,
            affected_rows: None,
            elapsed_ms: 0,
            truncated: false,
        }
    }

    fn snapshot(rows: &[(i64, i64, &str)]) -> SqlitePlanSnapshot {
        normalize_sqlite_plan(identity("workspace", 7), &plan_result(rows))
            .expect("normalize plan fixture")
    }

    #[test]
    fn normalize_scan_returns_typed_single_loop() {
        let plan = snapshot(&[(3, 0, "SCAN users")]);

        assert_eq!(
            plan.nodes[0],
            SqlitePlanNode {
                ordinal: 0,
                id: 3,
                parent_id: 0,
                detail: "SCAN users".to_string(),
                operation: SqlitePlanOperation::Scan {
                    target: "users".to_string(),
                    access: SqliteScanAccess::TableOrSubquery,
                },
                loop_role: Some(SqlitePlanLoopRole::Single),
            }
        );
    }

    #[test]
    fn normalize_search_returns_named_covering_index() {
        let plan = snapshot(&[(
            4,
            0,
            "SEARCH users USING COVERING INDEX idx_email (email=?)",
        )]);

        assert_eq!(
            plan.nodes[0].operation,
            SqlitePlanOperation::IndexSearch {
                target: "users".to_string(),
                index: SqliteIndexSource::Named {
                    name: "idx_email".to_string(),
                },
                covering: true,
            }
        );
    }

    #[test]
    fn normalize_real_sqlite_plan_returns_typed_index_search() {
        let raw = in_memory_plan_result("SELECT id FROM users WHERE email = 'a'");

        let plan = normalize_sqlite_plan(identity("workspace", 7), &raw)
            .expect("normalize real SQLite plan");

        assert!(plan.is_complete());
        assert!(plan.nodes.iter().any(|node| matches!(
            &node.operation,
            SqlitePlanOperation::IndexSearch {
                target,
                index: SqliteIndexSource::Named { name },
                ..
            } if target == "users" && name == "idx_users_email"
        )));
    }

    #[test]
    fn normalize_real_sqlite_table_name_ending_in_left_join_is_unknown() {
        let raw = in_memory_plan_result_with_schema(
            "CREATE TABLE \"literal LEFT-JOIN\"(id INTEGER);",
            "SELECT * FROM \"literal LEFT-JOIN\"",
        );

        let plan = normalize_sqlite_plan(identity("workspace", 7), &raw)
            .expect("normalize real SQLite plan");

        assert_eq!(plan.nodes[0].operation, SqlitePlanOperation::Unknown);
    }

    #[test]
    fn normalize_real_sqlite_scan_index_ending_in_left_join_is_unknown() {
        let raw = in_memory_plan_result_with_schema(
            "CREATE TABLE t(value INTEGER);\
             CREATE INDEX \"idx LEFT-JOIN\" ON t(value);",
            "SELECT value FROM t INDEXED BY \"idx LEFT-JOIN\"",
        );

        let plan = normalize_sqlite_plan(identity("workspace", 7), &raw)
            .expect("normalize real SQLite plan");

        assert_eq!(plan.nodes[0].operation, SqlitePlanOperation::Unknown);
    }

    #[test]
    fn normalize_real_sqlite_search_index_ending_in_left_join_preserves_name() {
        let raw = in_memory_plan_result_with_schema(
            "CREATE TABLE t(value INTEGER);\
             CREATE INDEX \"idx LEFT-JOIN\" ON t(value);",
            "SELECT value FROM t INDEXED BY \"idx LEFT-JOIN\" WHERE value = 1",
        );

        let plan = normalize_sqlite_plan(identity("workspace", 7), &raw)
            .expect("normalize real SQLite plan");

        assert_eq!(
            plan.nodes[0].operation,
            SqlitePlanOperation::IndexSearch {
                target: "t".to_string(),
                index: SqliteIndexSource::Named {
                    name: "idx LEFT-JOIN".to_string(),
                },
                covering: true,
            }
        );
    }

    #[test]
    fn normalize_scan_with_left_join_suffix_is_unknown() {
        let plan = snapshot(&[(3, 0, "SCAN users LEFT-JOIN")]);

        assert_eq!(plan.nodes[0].operation, SqlitePlanOperation::Unknown);
    }

    #[test]
    fn normalize_scan_with_right_join_suffix_is_unknown() {
        let plan = snapshot(&[(3, 0, "SCAN users RIGHT-JOIN")]);

        assert_eq!(plan.nodes[0].operation, SqlitePlanOperation::Unknown);
    }

    #[test]
    fn normalize_scan_with_full_join_suffix_is_unknown() {
        let plan = snapshot(&[(3, 0, "SCAN users FULL-JOIN")]);

        assert_eq!(plan.nodes[0].operation, SqlitePlanOperation::Unknown);
    }

    #[test]
    fn normalize_search_with_predicate_then_left_join_suffix_preserves_named_index() {
        let plan = snapshot(&[(
            4,
            0,
            "SEARCH users USING INDEX idx_email (email=?) LEFT-JOIN",
        )]);

        assert_eq!(
            plan.nodes[0].operation,
            SqlitePlanOperation::IndexSearch {
                target: "users".to_string(),
                index: SqliteIndexSource::Named {
                    name: "idx_email".to_string(),
                },
                covering: false,
            }
        );
    }

    #[test]
    fn normalize_search_with_ambiguous_left_join_suffix_is_unknown() {
        let plan = snapshot(&[(4, 0, "SEARCH users USING INDEX idx_email LEFT-JOIN")]);

        assert_eq!(plan.nodes[0].operation, SqlitePlanOperation::Unknown);
    }

    #[test]
    fn normalize_search_with_right_join_suffix_is_unknown() {
        let plan = snapshot(&[(
            4,
            0,
            "SEARCH users USING INDEX idx_email (email=?) RIGHT-JOIN",
        )]);

        assert_eq!(plan.nodes[0].operation, SqlitePlanOperation::Unknown);
    }

    #[test]
    fn normalize_search_with_full_join_suffix_is_unknown() {
        let plan = snapshot(&[(
            4,
            0,
            "SEARCH users USING INDEX idx_email (email=?) FULL-JOIN",
        )]);

        assert_eq!(plan.nodes[0].operation, SqlitePlanOperation::Unknown);
    }

    #[test]
    fn normalize_constant_row_scan_returns_unknown_node() {
        let plan = snapshot(&[(3, 0, "SCAN CONSTANT ROW")]);

        assert_eq!(plan.nodes[0].operation, SqlitePlanOperation::Unknown);
    }

    #[test]
    fn normalize_sibling_accesses_marks_honest_join_order() {
        let plan = snapshot(&[
            (3, 0, "SCAN users"),
            (
                8,
                0,
                "SEARCH orders USING INDEX idx_orders_user (user_id=?)",
            ),
        ]);

        assert_eq!(
            plan.nodes
                .iter()
                .map(|node| node.loop_role.clone())
                .collect::<Vec<_>>(),
            vec![
                Some(SqlitePlanLoopRole::Join { position: 0 }),
                Some(SqlitePlanLoopRole::Join { position: 1 }),
            ]
        );
    }

    #[test]
    fn normalize_temporary_btree_preserves_purpose() {
        let plan = snapshot(&[(9, 0, "USE TEMP B-TREE FOR ORDER BY")]);

        assert_eq!(
            plan.nodes[0].operation,
            SqlitePlanOperation::TemporaryBTree {
                purpose: SqliteTemporaryBTreePurpose::OrderBy,
            }
        );
    }

    #[test]
    fn normalize_unrecognized_detail_returns_unknown_node() {
        let plan = snapshot(&[(5, 0, "BLOOM FILTER ON users (id=?)")]);

        assert_eq!(plan.nodes[0].operation, SqlitePlanOperation::Unknown);
    }

    #[test]
    fn normalize_malformed_row_marks_snapshot_incomplete() {
        let mut raw = plan_result(&[(3, 0, "SCAN users")]);
        raw.rows[0][3] = SqlCellValue::integer(42);

        let plan = normalize_sqlite_plan(identity("workspace", 7), &raw)
            .expect("normalize malformed fixture");

        assert_eq!(plan.malformed_row_count, 1);
        assert!(!plan.is_complete());
    }

    #[test]
    fn normalize_oversized_utf8_detail_truncates_without_partial_node() {
        let detail = format!("SCAN {}", "计划".repeat(MAX_SQLITE_PLAN_DETAIL_BYTES));
        let raw = plan_result(&[(3, 0, &detail)]);

        let plan = normalize_sqlite_plan(identity("workspace", 7), &raw)
            .expect("normalize oversized fixture");

        assert!(plan.truncated);
        assert!(plan.nodes.is_empty());
    }

    #[test]
    fn normalize_serialized_budget_keeps_only_atomic_nodes() {
        let details = (0..128)
            .map(|index| format!("SCAN table_{index}_{}", "x".repeat(400)))
            .collect::<Vec<_>>();
        let rows = details
            .iter()
            .enumerate()
            .map(|(index, detail)| (i64::try_from(index + 1).unwrap(), 0, detail.as_str()))
            .collect::<Vec<_>>();

        let plan = normalize_sqlite_plan(identity("workspace", 7), &plan_result(&rows))
            .expect("normalize byte-bounded fixture");

        assert!(plan.truncated);
        assert_eq!(
            plan.returned_byte_count,
            serde_json::to_vec(&plan).unwrap().len()
        );
        assert!(plan.returned_byte_count <= MAX_SQLITE_PLAN_SERIALIZED_BYTES);
        assert_eq!(plan.returned_node_count, plan.nodes.len());
    }

    #[test]
    fn compare_missing_original_is_uncertain() {
        let rewritten = snapshot(&[(3, 0, "SCAN users")]);

        let comparison = compare_sqlite_plans(None, Some(&rewritten));

        assert_eq!(
            comparison.uncertainty_reason,
            Some(SqlitePlanUncertaintyReason::MissingOriginal)
        );
        assert!(!comparison.performance_verified);
    }

    #[test]
    fn compare_truncated_original_is_uncertain() {
        let mut original = snapshot(&[(3, 0, "SCAN users")]);
        let rewritten = original.clone();
        original.truncated = true;

        let comparison = compare_sqlite_plans(Some(&original), Some(&rewritten));

        assert_eq!(
            comparison.uncertainty_reason,
            Some(SqlitePlanUncertaintyReason::OriginalIncomplete)
        );
    }

    #[test]
    fn compare_malformed_original_is_uncertain() {
        let mut original = snapshot(&[(3, 0, "SCAN users")]);
        let rewritten = original.clone();
        original.malformed_row_count = 1;

        let comparison = compare_sqlite_plans(Some(&original), Some(&rewritten));

        assert_eq!(
            comparison.uncertainty_reason,
            Some(SqlitePlanUncertaintyReason::OriginalIncomplete)
        );
    }

    #[test]
    fn compare_connection_mismatch_is_uncertain() {
        let original = snapshot(&[(3, 0, "SCAN users")]);
        let mut rewritten = original.clone();
        rewritten.identity.connection_id = "other".to_string();

        let comparison = compare_sqlite_plans(Some(&original), Some(&rewritten));

        assert_eq!(
            comparison.uncertainty_reason,
            Some(SqlitePlanUncertaintyReason::ConnectionMismatch)
        );
    }

    #[test]
    fn compare_metadata_revision_mismatch_is_uncertain() {
        let original = snapshot(&[(3, 0, "SCAN users")]);
        let mut rewritten = original.clone();
        rewritten.identity.metadata_revision += 1;

        let comparison = compare_sqlite_plans(Some(&original), Some(&rewritten));

        assert_eq!(
            comparison.uncertainty_reason,
            Some(SqlitePlanUncertaintyReason::MetadataRevisionMismatch)
        );
    }

    #[test]
    fn compare_dialect_mismatch_is_uncertain() {
        let original = snapshot(&[(3, 0, "SCAN users")]);
        let mut rewritten = original.clone();
        rewritten.identity.dialect = SqlDialect::MySql;

        let comparison = compare_sqlite_plans(Some(&original), Some(&rewritten));

        assert_eq!(
            comparison.uncertainty_reason,
            Some(SqlitePlanUncertaintyReason::DialectMismatch)
        );
    }

    #[test]
    fn compare_normalization_version_mismatch_is_uncertain() {
        let original = snapshot(&[(3, 0, "SCAN users")]);
        let mut rewritten = original.clone();
        rewritten.identity.normalization_version += 1;

        let comparison = compare_sqlite_plans(Some(&original), Some(&rewritten));

        assert_eq!(
            comparison.uncertainty_reason,
            Some(SqlitePlanUncertaintyReason::NormalizationVersionMismatch)
        );
    }

    #[test]
    fn compare_join_order_mismatch_is_uncertain() {
        let original = snapshot(&[
            (3, 0, "SCAN users"),
            (
                8,
                0,
                "SEARCH orders USING INDEX idx_orders_user (user_id=?)",
            ),
        ]);
        let rewritten = snapshot(&[
            (4, 0, "SCAN orders"),
            (9, 0, "SEARCH users USING INDEX idx_users_id (id=?)"),
        ]);

        let comparison = compare_sqlite_plans(Some(&original), Some(&rewritten));

        assert_eq!(
            comparison.uncertainty_reason,
            Some(SqlitePlanUncertaintyReason::TopologyMismatch)
        );
    }

    #[test]
    fn compare_scan_to_index_search_is_structurally_improved() {
        let original = snapshot(&[(3, 0, "SCAN users")]);
        let rewritten = snapshot(&[(8, 0, "SEARCH users USING INDEX idx_email (email=?)")]);

        let comparison = compare_sqlite_plans(Some(&original), Some(&rewritten));

        assert_eq!(
            comparison.verdict,
            SqlitePlanComparisonVerdict::StructurallyImproved
        );
        assert!(!comparison.performance_verified);
    }

    #[test]
    fn compare_index_search_to_scan_is_structurally_regressed() {
        let original = snapshot(&[(3, 0, "SEARCH users USING INDEX idx_email (email=?)")]);
        let rewritten = snapshot(&[(8, 0, "SCAN users")]);

        let comparison = compare_sqlite_plans(Some(&original), Some(&rewritten));

        assert_eq!(
            comparison.verdict,
            SqlitePlanComparisonVerdict::StructurallyRegressed
        );
    }

    #[test]
    fn compare_semantic_match_ignores_unstable_node_ids() {
        let original = snapshot(&[(3, 0, "SCAN users")]);
        let rewritten = snapshot(&[(99, 1, "SCAN users")]);

        let comparison = compare_sqlite_plans(Some(&original), Some(&rewritten));

        assert_eq!(comparison.verdict, SqlitePlanComparisonVerdict::Equivalent);
    }

    #[test]
    fn compare_changed_predicate_is_an_unranked_access_change() {
        let original = snapshot(&[(3, 0, "SEARCH users USING INDEX idx_email (email=?)")]);
        let rewritten = snapshot(&[(
            8,
            0,
            "SEARCH users USING INDEX idx_email (email>? AND email<?)",
        )]);

        let comparison = compare_sqlite_plans(Some(&original), Some(&rewritten));

        assert_eq!(
            comparison.uncertainty_reason,
            Some(SqlitePlanUncertaintyReason::UnrankedAccessChange)
        );
    }

    #[test]
    fn compare_mixed_access_and_temporary_btree_signals_is_uncertain() {
        let original = snapshot(&[(3, 0, "SCAN users")]);
        let rewritten = snapshot(&[
            (8, 0, "SEARCH users USING INDEX idx_email (email=?)"),
            (10, 0, "USE TEMP B-TREE FOR ORDER BY"),
        ]);

        let comparison = compare_sqlite_plans(Some(&original), Some(&rewritten));

        assert_eq!(
            comparison.uncertainty_reason,
            Some(SqlitePlanUncertaintyReason::MixedStructuralSignals)
        );
    }

    #[test]
    fn compare_unknown_operation_is_uncertain() {
        let original = snapshot(&[(3, 0, "SCAN users")]);
        let rewritten = snapshot(&[(8, 0, "BLOOM FILTER ON users (id=?)")]);

        let comparison = compare_sqlite_plans(Some(&original), Some(&rewritten));

        assert_eq!(
            comparison.uncertainty_reason,
            Some(SqlitePlanUncertaintyReason::UnsupportedOperation)
        );
    }
}
