//! A3.2 result shape, aggregate, and approved sample policy.
//!
//! Result rows are never part of the default shape or aggregate envelope.
//! Sampling is an explicit, bounded operation with a second redaction pass.

#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::super::types::{SqlCellKind, SqlCellValue, SqlCommandError, SqlQueryResult};

pub const DEFAULT_SAMPLE_MAX_ROWS: usize = 20;
pub const DEFAULT_SAMPLE_MAX_BYTES: usize = 16 * 1024;
pub const MAX_SAMPLE_MAX_ROWS: usize = 100;
pub const MAX_SAMPLE_MAX_BYTES: usize = 64 * 1024;
const MAX_RESULT_STORE_ENTRIES: usize = 64;
const MAX_RESULT_STORE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResultColumnShape {
    pub name: String,
    pub ordinal: usize,
    pub null_count: usize,
    pub value_kinds: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResultShape {
    pub columns: Vec<AgentResultColumnShape>,
    pub row_count: usize,
    pub affected_rows: Option<usize>,
    pub elapsed_ms: u64,
    pub truncated: bool,
    pub result_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAggregateColumn {
    pub name: String,
    pub null_count: usize,
    pub numeric_count: usize,
    pub min: Option<f64>,
    pub max: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResultAggregate {
    pub row_count: usize,
    pub columns: Vec<AgentAggregateColumn>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSampleRequest {
    pub approved: bool,
    pub max_rows: Option<usize>,
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResultSample {
    pub columns: Vec<super::super::types::SqlResultColumn>,
    pub rows: Vec<Vec<SqlCellValue>>,
    pub sampled_row_count: usize,
    pub truncated: bool,
    pub redacted_cells: usize,
    pub serialized_bytes: usize,
}

/// Ephemeral result handles used by the A3 loop. Rows never leave this
/// bounded in-memory store unless `sample_result` is explicitly approved.
#[derive(Default)]
pub struct AgentResultStore {
    entries: Mutex<HashMap<String, SqlQueryResult>>,
    next_id: Mutex<u64>,
}

impl AgentResultStore {
    pub fn insert(&self, result: SqlQueryResult) -> Result<String, SqlCommandError> {
        let serialized_bytes = serde_json::to_vec(&result)
            .map_err(|error| SqlCommandError::new("internal", error.to_string()))?
            .len();
        let mut entries = self.entries.lock().expect("agent result store poisoned");
        let current_bytes: usize = entries
            .values()
            .map(|entry| serde_json::to_vec(entry).map_or(0, |bytes| bytes.len()))
            .sum();
        if entries.len() >= MAX_RESULT_STORE_ENTRIES
            || current_bytes.saturating_add(serialized_bytes) > MAX_RESULT_STORE_BYTES
        {
            return Err(SqlCommandError::new(
                "invalid_input",
                "agent result store budget exceeded",
            ));
        }
        let mut next_id = self.next_id.lock().expect("agent result id poisoned");
        *next_id = next_id.saturating_add(1);
        let result_ref = format!("result-{}", *next_id);
        entries.insert(result_ref.clone(), result);
        Ok(result_ref)
    }

    pub fn get(&self, result_ref: &str) -> Result<SqlQueryResult, SqlCommandError> {
        let result_ref = result_ref.trim();
        if result_ref.is_empty() || result_ref.contains('\0') {
            return Err(SqlCommandError::new(
                "invalid_input",
                "resultRef must not be blank or contain NUL",
            ));
        }
        self.entries
            .lock()
            .expect("agent result store poisoned")
            .get(result_ref)
            .cloned()
            .ok_or_else(|| {
                SqlCommandError::new("invalid_input", "agent result reference was not found")
            })
    }
}

pub fn inspect_result(result: &SqlQueryResult) -> AgentResultShape {
    let mut columns: Vec<AgentResultColumnShape> = result
        .columns
        .iter()
        .map(|column| AgentResultColumnShape {
            name: column.name.clone(),
            ordinal: column.ordinal,
            null_count: 0,
            value_kinds: BTreeMap::new(),
        })
        .collect();

    for row in &result.rows {
        for (index, column) in columns.iter_mut().enumerate() {
            let Some(value) = row.get(index) else {
                continue;
            };
            let kind = cell_kind_name(&value.kind);
            *column.value_kinds.entry(kind).or_default() += 1;
            if value.kind == SqlCellKind::Null {
                column.null_count += 1;
            }
        }
    }

    AgentResultShape {
        columns,
        row_count: result.row_count,
        affected_rows: result.affected_rows,
        elapsed_ms: result.elapsed_ms,
        truncated: result.truncated,
        result_bytes: serde_json::to_vec(result).map_or(0, |bytes| bytes.len()),
    }
}

pub fn aggregate_result(result: &SqlQueryResult) -> AgentResultAggregate {
    let columns = result
        .columns
        .iter()
        .enumerate()
        .map(|(index, column)| {
            let mut summary = AgentAggregateColumn {
                name: column.name.clone(),
                null_count: 0,
                numeric_count: 0,
                min: None,
                max: None,
            };
            for row in &result.rows {
                let Some(value) = row.get(index) else {
                    continue;
                };
                if value.kind == SqlCellKind::Null {
                    summary.null_count += 1;
                }
                let number = match value.kind {
                    SqlCellKind::Integer | SqlCellKind::Real => {
                        value.value.as_ref().and_then(serde_json::Value::as_f64)
                    }
                    _ => None,
                };
                if let Some(number) = number {
                    summary.numeric_count += 1;
                    summary.min = Some(summary.min.map_or(number, |current| current.min(number)));
                    summary.max = Some(summary.max.map_or(number, |current| current.max(number)));
                }
            }
            summary
        })
        .collect();

    AgentResultAggregate {
        row_count: result.row_count,
        columns,
    }
}

pub fn sample_result(
    result: &SqlQueryResult,
    request: AgentSampleRequest,
) -> Result<AgentResultSample, SqlCommandError> {
    if !request.approved {
        return Err(SqlCommandError::new(
            "validation",
            "result.sample requires explicit user approval",
        ));
    }
    let max_rows = request.max_rows.unwrap_or(DEFAULT_SAMPLE_MAX_ROWS);
    let max_bytes = request.max_bytes.unwrap_or(DEFAULT_SAMPLE_MAX_BYTES);
    if max_rows == 0 || max_rows > MAX_SAMPLE_MAX_ROWS {
        return Err(SqlCommandError::new(
            "invalid_input",
            format!("sample row cap must be between 1 and {MAX_SAMPLE_MAX_ROWS}"),
        ));
    }
    if max_bytes == 0 || max_bytes > MAX_SAMPLE_MAX_BYTES {
        return Err(SqlCommandError::new(
            "invalid_input",
            format!("sample byte cap must be between 1 and {MAX_SAMPLE_MAX_BYTES}"),
        ));
    }

    let mut rows = Vec::new();
    let mut serialized_bytes = 0usize;
    let mut redacted_cells = 0usize;
    let mut truncated = result.truncated;

    for source_row in result.rows.iter().take(max_rows) {
        let mut row = Vec::with_capacity(source_row.len());
        for (index, cell) in source_row.iter().enumerate() {
            let column_name = result
                .columns
                .get(index)
                .map(|column| column.name.as_str())
                .unwrap_or_default();
            let (redacted, was_redacted) = redact_sample_cell(column_name, cell);
            redacted_cells += usize::from(was_redacted);
            row.push(redacted);
        }
        let row_bytes = serde_json::to_vec(&row)
            .map_err(|error| SqlCommandError::new("internal", error.to_string()))?
            .len();
        if serialized_bytes.saturating_add(row_bytes) > max_bytes {
            truncated = true;
            break;
        }
        serialized_bytes = serialized_bytes.saturating_add(row_bytes);
        rows.push(row);
    }
    if result.rows.len() > rows.len() {
        truncated = true;
    }

    Ok(AgentResultSample {
        columns: result.columns.clone(),
        sampled_row_count: rows.len(),
        rows,
        truncated,
        redacted_cells,
        serialized_bytes,
    })
}

fn cell_kind_name(kind: &SqlCellKind) -> String {
    serde_json::to_value(kind)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

fn redact_sample_cell(column_name: &str, cell: &SqlCellValue) -> (SqlCellValue, bool) {
    if cell.kind == SqlCellKind::Blob || is_sensitive_column(column_name) {
        return (SqlCellValue::text("[REDACTED]"), true);
    }
    if let Some(value) = cell.value.as_ref().and_then(|value| value.as_str()) {
        let lower = value.to_ascii_lowercase();
        if lower.starts_with("bearer ") || lower.contains("private key") {
            return (SqlCellValue::text("[REDACTED]"), true);
        }
    }
    (cell.clone(), false)
}

fn is_sensitive_column(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    [
        "password",
        "secret",
        "token",
        "authorization",
        "api_key",
        "apikey",
        "private_key",
        "credential",
        "cookie",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture_result() -> SqlQueryResult {
        SqlQueryResult {
            columns: vec![
                super::super::super::types::SqlResultColumn {
                    name: "id".to_string(),
                    ordinal: 0,
                },
                super::super::super::types::SqlResultColumn {
                    name: "password".to_string(),
                    ordinal: 1,
                },
                super::super::super::types::SqlResultColumn {
                    name: "total".to_string(),
                    ordinal: 2,
                },
            ],
            rows: vec![
                vec![
                    SqlCellValue::integer(1),
                    SqlCellValue::text("hidden"),
                    SqlCellValue::real(12.5),
                ],
                vec![
                    SqlCellValue::integer(2),
                    SqlCellValue::text("secret"),
                    SqlCellValue::null(),
                ],
            ],
            affected_rows: None,
            row_count: 2,
            elapsed_ms: 4,
            truncated: false,
        }
    }

    #[test]
    fn shape_and_aggregate_envelopes_never_serialize_rows() {
        let result = fixture_result();
        let shape = inspect_result(&result);
        let aggregate = aggregate_result(&result);
        let shape_json = serde_json::to_string(&shape).unwrap();
        let aggregate_json = serde_json::to_string(&aggregate).unwrap();
        assert!(!shape_json.contains("rows"));
        assert!(!aggregate_json.contains("rows"));
        assert_eq!(shape.row_count, 2);
        assert_eq!(aggregate.columns[2].numeric_count, 1);
        assert_eq!(aggregate.columns[2].min, Some(12.5));
    }

    #[test]
    fn sample_requires_approval_and_redacts_sensitive_columns() {
        let result = fixture_result();
        let error = sample_result(
            &result,
            AgentSampleRequest {
                approved: false,
                ..AgentSampleRequest::default()
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("approval"));

        let sample = sample_result(
            &result,
            AgentSampleRequest {
                approved: true,
                max_rows: Some(1),
                max_bytes: Some(1024),
            },
        )
        .unwrap();
        assert_eq!(sample.sampled_row_count, 1);
        assert_eq!(sample.redacted_cells, 1);
        assert_eq!(sample.rows[0][1], SqlCellValue::text("[REDACTED]"));
    }

    #[test]
    fn sample_caps_rows_and_bytes_without_partial_rows() {
        let mut result = fixture_result();
        result.rows.push(vec![
            SqlCellValue::integer(3),
            SqlCellValue::text("long"),
            SqlCellValue::text("x".repeat(500)),
        ]);
        result.row_count = 3;
        let sample = sample_result(
            &result,
            AgentSampleRequest {
                approved: true,
                max_rows: Some(100),
                max_bytes: Some(100),
            },
        )
        .unwrap();
        assert!(sample.truncated);
        assert!(sample.sampled_row_count < result.rows.len());
        assert!(sample.serialized_bytes <= 100);
    }

    #[test]
    fn sample_envelope_has_stable_wire_shape() {
        let sample = sample_result(
            &fixture_result(),
            AgentSampleRequest {
                approved: true,
                max_rows: Some(1),
                max_bytes: Some(1024),
            },
        )
        .unwrap();
        let value = serde_json::to_value(sample).unwrap();
        assert_eq!(value["sampledRowCount"], json!(1));
        assert_eq!(value["redactedCells"], json!(1));
        assert!(value.get("serializedBytes").is_some());
    }
}
