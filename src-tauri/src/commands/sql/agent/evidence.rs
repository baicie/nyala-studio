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
        self.append_at(
            run_id,
            kind,
            sensitivity,
            payload,
            Instant::now(),
            unix_now_ms(),
        )
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
        let run_id = run_id.into();
        let run_id = validate_id(&run_id, "evidence run id")?;
        if self.max_entries == 0 || self.max_bytes == 0 {
            return Err(SqlCommandError::new(
                "invalid_input",
                "evidence store capacity must be greater than zero",
            ));
        }
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

        let mut entries = self.entries.lock().expect("agent evidence store poisoned");
        prune_expired(&mut entries, now, self.ttl);
        let current_bytes: usize = entries.values().map(|entry| entry.serialized_bytes).sum();
        if entries.len() >= self.max_entries
            || current_bytes.saturating_add(serialized_bytes) > self.max_bytes
        {
            return Err(SqlCommandError::new(
                "invalid_input",
                "agent evidence store budget exceeded",
            ));
        }

        let evidence_id = {
            let mut next_id = self.next_id.lock().expect("agent evidence id poisoned");
            *next_id = next_id.saturating_add(1);
            format!("evidence-{}", *next_id)
        };
        let expires_at_ms =
            created_at_ms.saturating_add(u64::try_from(self.ttl.as_millis()).unwrap_or(u64::MAX));
        let evidence = AgentEvidence {
            evidence_id: evidence_id.clone(),
            run_id: run_id.clone(),
            kind,
            sensitivity,
            payload,
            created_at_ms,
            expires_at_ms,
            serialized_bytes,
        };
        entries.insert(
            evidence_id.clone(),
            StoredEvidence {
                evidence,
                inserted_at: now,
                serialized_bytes,
            },
        );
        Ok(AgentEvidenceRef {
            evidence_id,
            run_id,
            kind,
        })
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
    fn expired_evidence_is_pruned_without_sleeping() {
        let started = Instant::now();
        let store = AgentEvidenceStore::new(Duration::from_millis(10), 4, 4096);
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
            prune_expired(&mut entries, started + Duration::from_millis(11), store.ttl);
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
}
