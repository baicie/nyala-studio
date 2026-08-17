//! Secret-free, bounded in-memory evidence storage for SQL Agent runs.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::super::types::SqlCommandError;
use super::domain::redact_json_value;

pub const DEFAULT_EVIDENCE_TTL: Duration = Duration::from_mins(5);
pub const DEFAULT_EVIDENCE_MAX_ENTRIES: usize = 256;
pub const DEFAULT_EVIDENCE_MAX_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentEvidenceKind {
    Schema,
    Index,
    Analysis,
    Plan,
    Error,
    ResultShape,
    Aggregate,
    ResultSample,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentEvidenceSensitivity {
    Public,
    Workspace,
    Sensitive,
}

pub type AgentEvidenceInput = (
    AgentEvidenceKind,
    AgentEvidenceSensitivity,
    serde_json::Value,
);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvidenceRef {
    pub evidence_id: String,
    pub run_id: String,
    pub kind: AgentEvidenceKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvidence {
    pub evidence_id: String,
    pub run_id: String,
    pub kind: AgentEvidenceKind,
    pub sensitivity: AgentEvidenceSensitivity,
    pub payload: serde_json::Value,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub serialized_bytes: usize,
}

struct StoredEvidence {
    evidence: AgentEvidence,
    inserted_at: Instant,
    serialized_bytes: usize,
}

struct PreparedEvidence {
    kind: AgentEvidenceKind,
    sensitivity: AgentEvidenceSensitivity,
    payload: serde_json::Value,
    serialized_bytes: usize,
}

pub struct AgentEvidenceStore {
    ttl: Duration,
    max_entries: usize,
    max_bytes: usize,
    next_id: Mutex<u64>,
    entries: Mutex<HashMap<String, StoredEvidence>>,
}

impl Default for AgentEvidenceStore {
    fn default() -> Self {
        Self::new(
            DEFAULT_EVIDENCE_TTL,
            DEFAULT_EVIDENCE_MAX_ENTRIES,
            DEFAULT_EVIDENCE_MAX_BYTES,
        )
    }
}

impl AgentEvidenceStore {
    pub fn new(ttl: Duration, max_entries: usize, max_bytes: usize) -> Self {
        Self {
            ttl,
            max_entries,
            max_bytes,
            next_id: Mutex::new(0),
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub fn append(
        &self,
        run_id: impl Into<String>,
        kind: AgentEvidenceKind,
        sensitivity: AgentEvidenceSensitivity,
        payload: serde_json::Value,
    ) -> Result<AgentEvidenceRef, SqlCommandError> {
        self.append_batch_at(
            run_id,
            vec![(kind, sensitivity, payload)],
            Instant::now(),
            unix_now_ms(),
        )?
        .into_iter()
        .next()
        .ok_or_else(|| SqlCommandError::new("internal", "evidence append returned no reference"))
    }

    pub fn append_batch(
        &self,
        run_id: impl Into<String>,
        evidence: Vec<AgentEvidenceInput>,
    ) -> Result<Vec<AgentEvidenceRef>, SqlCommandError> {
        self.append_batch_at(run_id, evidence, Instant::now(), unix_now_ms())
    }

    pub fn append_at(
        &self,
        run_id: impl Into<String>,
        kind: AgentEvidenceKind,
        sensitivity: AgentEvidenceSensitivity,
        payload: serde_json::Value,
        now: Instant,
        created_at_ms: u64,
    ) -> Result<AgentEvidenceRef, SqlCommandError> {
        self.append_batch_at(
            run_id,
            vec![(kind, sensitivity, payload)],
            now,
            created_at_ms,
        )?
        .into_iter()
        .next()
        .ok_or_else(|| SqlCommandError::new("internal", "evidence append returned no reference"))
    }

    fn append_batch_at(
        &self,
        run_id: impl Into<String>,
        evidence: Vec<AgentEvidenceInput>,
        now: Instant,
        created_at_ms: u64,
    ) -> Result<Vec<AgentEvidenceRef>, SqlCommandError> {
        let run_id = run_id.into();
        let run_id = validate_id(&run_id, "evidence run id")?;
        if self.max_entries == 0 || self.max_bytes == 0 {
            return Err(SqlCommandError::new(
                "invalid_input",
                "evidence store capacity must be greater than zero",
            ));
        }
        if evidence.is_empty() {
            return Ok(Vec::new());
        }
        let prepared = evidence
            .into_iter()
            .map(|(kind, sensitivity, payload)| {
                let payload = redact_json_value(payload);
                let serialized_bytes = serde_json::to_vec(&payload)
                    .map_err(|error| SqlCommandError::new("invalid_input", error.to_string()))?
                    .len();
                if serialized_bytes > self.max_bytes {
                    return Err(SqlCommandError::new(
                        "invalid_input",
                        format!("evidence exceeds {} byte budget", self.max_bytes),
                    ));
                }
                Ok(PreparedEvidence {
                    kind,
                    sensitivity,
                    payload,
                    serialized_bytes,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let batch_bytes = prepared.iter().try_fold(0usize, |total, entry| {
            total.checked_add(entry.serialized_bytes).ok_or_else(|| {
                SqlCommandError::new("invalid_input", "evidence batch byte count overflow")
            })
        })?;

        let mut entries = self.entries.lock().expect("agent evidence store poisoned");
        prune_expired(&mut entries, now, self.ttl);
        let current_bytes: usize = entries.values().map(|entry| entry.serialized_bytes).sum();
        let next_entry_count = entries.len().checked_add(prepared.len()).ok_or_else(|| {
            SqlCommandError::new("invalid_input", "evidence entry count overflow")
        })?;
        let next_byte_count = current_bytes.checked_add(batch_bytes).ok_or_else(|| {
            SqlCommandError::new("invalid_input", "evidence store byte count overflow")
        })?;
        if next_entry_count > self.max_entries || next_byte_count > self.max_bytes {
            return Err(SqlCommandError::new(
                "invalid_input",
                "agent evidence store budget exceeded",
            ));
        }

        let mut next_id = self.next_id.lock().expect("agent evidence id poisoned");
        let batch_len = u64::try_from(prepared.len()).map_err(|_| {
            SqlCommandError::new("invalid_input", "evidence batch entry count is too large")
        })?;
        let first_id = next_id.checked_add(1).ok_or_else(|| {
            SqlCommandError::new("invalid_input", "agent evidence id space exhausted")
        })?;
        let final_id = next_id.checked_add(batch_len).ok_or_else(|| {
            SqlCommandError::new("invalid_input", "agent evidence id space exhausted")
        })?;
        let expires_at_ms =
            created_at_ms.saturating_add(u64::try_from(self.ttl.as_millis()).unwrap_or(u64::MAX));
        let mut references = Vec::with_capacity(prepared.len());
        for (offset, prepared) in prepared.into_iter().enumerate() {
            let offset = u64::try_from(offset).map_err(|_| {
                SqlCommandError::new("invalid_input", "evidence batch entry count is too large")
            })?;
            let evidence_id = format!("evidence-{}", first_id + offset);
            let reference = AgentEvidenceRef {
                evidence_id: evidence_id.clone(),
                run_id: run_id.clone(),
                kind: prepared.kind,
            };
            let evidence = AgentEvidence {
                evidence_id: evidence_id.clone(),
                run_id: run_id.clone(),
                kind: prepared.kind,
                sensitivity: prepared.sensitivity,
                payload: prepared.payload,
                created_at_ms,
                expires_at_ms,
                serialized_bytes: prepared.serialized_bytes,
            };
            entries.insert(
                evidence_id,
                StoredEvidence {
                    evidence,
                    inserted_at: now,
                    serialized_bytes: prepared.serialized_bytes,
                },
            );
            references.push(reference);
        }
        *next_id = final_id;
        Ok(references)
    }

    pub fn get(&self, evidence_id: &str) -> Option<AgentEvidence> {
        let now = Instant::now();
        let mut entries = self.entries.lock().expect("agent evidence store poisoned");
        prune_expired(&mut entries, now, self.ttl);
        entries.get(evidence_id).map(|entry| entry.evidence.clone())
    }

    pub fn list_for_run(&self, run_id: &str) -> Vec<AgentEvidence> {
        let now = Instant::now();
        let mut entries = self.entries.lock().expect("agent evidence store poisoned");
        prune_expired(&mut entries, now, self.ttl);
        let mut values: Vec<_> = entries
            .values()
            .filter(|entry| entry.evidence.run_id == run_id)
            .map(|entry| entry.evidence.clone())
            .collect();
        values.sort_by(|left, right| {
            left.created_at_ms
                .cmp(&right.created_at_ms)
                .then_with(|| left.evidence_id.cmp(&right.evidence_id))
        });
        values
    }

    pub fn remove_for_run(&self, run_id: &str) -> usize {
        let mut entries = self.entries.lock().expect("agent evidence store poisoned");
        let before = entries.len();
        entries.retain(|_, entry| entry.evidence.run_id != run_id);
        before - entries.len()
    }

    pub fn prune(&self) -> usize {
        let mut entries = self.entries.lock().expect("agent evidence store poisoned");
        let before = entries.len();
        prune_expired(&mut entries, Instant::now(), self.ttl);
        before - entries.len()
    }
}

fn prune_expired(entries: &mut HashMap<String, StoredEvidence>, now: Instant, ttl: Duration) {
    entries.retain(|_, entry| now.saturating_duration_since(entry.inserted_at) < ttl);
}

fn validate_id(value: &str, label: &str) -> Result<String, SqlCommandError> {
    let value = value.trim().to_string();
    if value.is_empty() || value.contains('\0') {
        return Err(SqlCommandError::new(
            "invalid_input",
            format!("{label} must not be blank or contain NUL"),
        ));
    }
    Ok(value)
}

fn unix_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn append_redacts_secret_payloads_before_storage() {
        let store = AgentEvidenceStore::new(Duration::from_mins(1), 4, 4096);
        let reference = store
            .append(
                "run-1",
                AgentEvidenceKind::Error,
                AgentEvidenceSensitivity::Sensitive,
                json!({
                    "message": "bad sql",
                    "password": "never-store",
                    "nested": {"authorization": "Bearer secret"}
                }),
            )
            .unwrap();
        let evidence = store.get(&reference.evidence_id).unwrap();
        let serialized = serde_json::to_string(&evidence).unwrap();
        assert!(!serialized.contains("never-store"));
        assert!(!serialized.contains("Bearer secret"));
        assert!(serialized.contains("[REDACTED]"));
    }

    #[test]
    fn evidence_store_is_bounded_and_reports_rejection() {
        let store = AgentEvidenceStore::new(Duration::from_mins(1), 1, 32);
        store
            .append(
                "run-1",
                AgentEvidenceKind::Analysis,
                AgentEvidenceSensitivity::Workspace,
                json!({"ok": true}),
            )
            .unwrap();
        let error = store
            .append(
                "run-1",
                AgentEvidenceKind::Analysis,
                AgentEvidenceSensitivity::Workspace,
                json!({"second": true}),
            )
            .unwrap_err();
        assert!(matches!(error, SqlCommandError::InvalidInput { .. }));
    }

    #[test]
    fn evidence_batch_rejection_does_not_store_a_partial_batch() {
        let store = AgentEvidenceStore::new(Duration::from_mins(1), 1, 4096);

        let error = store
            .append_batch(
                "run-1",
                vec![
                    (
                        AgentEvidenceKind::ResultShape,
                        AgentEvidenceSensitivity::Workspace,
                        json!({"shape": {"rowCount": 1}}),
                    ),
                    (
                        AgentEvidenceKind::Aggregate,
                        AgentEvidenceSensitivity::Workspace,
                        json!({"aggregate": {"rowCount": 1}}),
                    ),
                ],
            )
            .unwrap_err();

        assert!(error.to_string().contains("budget exceeded"));
        assert!(store.list_for_run("run-1").is_empty());
        let reference = store
            .append(
                "run-1",
                AgentEvidenceKind::Analysis,
                AgentEvidenceSensitivity::Workspace,
                json!({"ok": true}),
            )
            .unwrap();
        assert_eq!(reference.evidence_id, "evidence-1");
    }

    #[test]
    fn expired_evidence_is_pruned_without_sleeping() {
        let started = Instant::now();
        let store = AgentEvidenceStore::new(Duration::from_mins(1), 4, 4096);
        let reference = store
            .append_at(
                "run-1",
                AgentEvidenceKind::Schema,
                AgentEvidenceSensitivity::Workspace,
                json!({"table": "users"}),
                started,
                100,
            )
            .unwrap();
        assert_eq!(
            store.get(&reference.evidence_id).unwrap().created_at_ms,
            100
        );
        {
            let mut entries = store.entries.lock().unwrap();
            prune_expired(&mut entries, started + Duration::from_secs(61), store.ttl);
        }
        assert!(store.get(&reference.evidence_id).is_none());
    }

    #[test]
    fn list_for_run_is_stable_and_scoped() {
        let store = AgentEvidenceStore::new(Duration::from_mins(1), 8, 4096);
        store
            .append_at(
                "run-a",
                AgentEvidenceKind::Schema,
                AgentEvidenceSensitivity::Workspace,
                json!({"order": 2}),
                Instant::now(),
                20,
            )
            .unwrap();
        store
            .append_at(
                "run-b",
                AgentEvidenceKind::Schema,
                AgentEvidenceSensitivity::Workspace,
                json!({"order": 1}),
                Instant::now(),
                10,
            )
            .unwrap();
        let values = store.list_for_run("run-a");
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].payload["order"], 2);
    }

    #[test]
    fn remove_for_run_deletes_only_owned_evidence() {
        let store = AgentEvidenceStore::new(Duration::from_mins(1), 8, 4096);
        for run_id in ["run-a", "run-a", "run-b"] {
            store
                .append(
                    run_id,
                    AgentEvidenceKind::Analysis,
                    AgentEvidenceSensitivity::Workspace,
                    json!({"run": run_id}),
                )
                .unwrap();
        }

        assert_eq!(store.remove_for_run("run-a"), 2);
        assert!(store.list_for_run("run-a").is_empty());
        assert_eq!(store.list_for_run("run-b").len(), 1);
    }
}
