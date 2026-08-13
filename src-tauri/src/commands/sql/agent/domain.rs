//! In-memory SQL Agent domain objects and the A2.1 run state machine.
//!
//! This module deliberately contains no model, query, or Tauri code. It owns
//! the lifecycle and resource accounting that later runtime slices must use.

#![allow(dead_code)]

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, LazyLock,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::super::types::SqlCommandError;

pub const DEFAULT_MAX_MODEL_TURNS: usize = 8;
pub const DEFAULT_MAX_TOOL_CALLS: usize = 16;
pub const DEFAULT_MAX_SCHEMA_OBJECTS: usize = 48;
pub const DEFAULT_MAX_RESULT_ROWS: usize = 1_000;
pub const DEFAULT_MAX_RESULT_BYTES: usize = 256 * 1024;
pub const DEFAULT_MAX_WALL_CLOCK_MS: u64 = 60_000;
pub const DEFAULT_MAX_TOKENS: usize = 32_000;

const MAX_MODEL_TURNS: usize = 64;
const MAX_TOOL_CALLS: usize = 128;
const MAX_SCHEMA_OBJECTS: usize = 1_000;
const MAX_RESULT_ROWS: usize = 100_000;
const MAX_RESULT_BYTES: usize = 4 * 1024 * 1024;
const MAX_WALL_CLOCK_MS: u64 = 15 * 60 * 1_000;
const MAX_TOKENS: usize = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentMode {
    SuggestOnly,
    ReadOnly,
    AllowWritesWithApproval,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRunState {
    Created,
    BuildingContext,
    Reasoning,
    AwaitingTool,
    AwaitingApproval,
    ExecutingTool,
    Completed,
    Failed,
    Cancelled,
}

impl AgentRunState {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    fn can_transition_to(self, next: Self) -> bool {
        match self {
            Self::Created => matches!(next, Self::BuildingContext),
            Self::BuildingContext => matches!(next, Self::Reasoning),
            Self::Reasoning => matches!(next, Self::AwaitingTool | Self::Completed | Self::Failed),
            Self::AwaitingTool => {
                matches!(
                    next,
                    Self::AwaitingApproval | Self::ExecutingTool | Self::Failed
                )
            }
            Self::AwaitingApproval => matches!(next, Self::ExecutingTool | Self::Failed),
            Self::ExecutingTool => matches!(next, Self::Reasoning | Self::Failed),
            Self::Completed | Self::Failed | Self::Cancelled => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTaskKind {
    Assistant,
    ExplainError,
    FixError,
    GenerateQuery,
    OptimizeQuery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTaskState {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTask {
    pub task_id: String,
    pub kind: AgentTaskKind,
    pub state: AgentTaskState,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentContextKind {
    Connection,
    Editor,
    Schema,
    Error,
    Result,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextRef {
    pub kind: AgentContextKind,
    pub id: String,
    pub version: Option<u64>,
}

impl AgentContextRef {
    pub fn new(
        kind: AgentContextKind,
        id: impl Into<String>,
        version: Option<u64>,
    ) -> Result<Self, SqlCommandError> {
        let id = id.into();
        let id = validate_identifier(&id, "context reference id")?;
        Ok(Self { kind, id, version })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurn {
    pub turn_id: String,
    pub sequence: usize,
    pub input_bytes: usize,
    pub output_bytes: usize,
    pub completed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolCall {
    pub run_id: String,
    pub call_id: String,
    pub tool: String,
    /// Arguments are kept only as a recursively redacted audit payload.
    pub arguments: serde_json::Value,
    pub context_refs: Vec<String>,
}

impl AgentToolCall {
    pub fn new(
        run_id: impl Into<String>,
        call_id: impl Into<String>,
        tool: impl Into<String>,
        arguments: serde_json::Value,
        context_refs: Vec<String>,
    ) -> Result<Self, SqlCommandError> {
        let run_id = run_id.into();
        let call_id = call_id.into();
        let tool = tool.into();
        Ok(Self {
            run_id: validate_identifier(&run_id, "tool call run id")?,
            call_id: validate_identifier(&call_id, "tool call id")?,
            tool: validate_identifier(&tool, "tool name")?,
            arguments: redact_json_value(arguments),
            context_refs,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentArtifactKind {
    SqlDraft,
    SqlPatch,
    Plan,
    Answer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentArtifact {
    pub artifact_id: String,
    pub run_id: String,
    pub kind: AgentArtifactKind,
    pub content: String,
    pub stale: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentApprovalDecision {
    Approved,
    Denied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentApproval {
    pub run_id: String,
    pub call_id: String,
    pub tool: String,
    pub argument_hash: String,
    pub decision: AgentApprovalDecision,
    pub created_at_ms: u64,
}

#[allow(clippy::struct_field_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBudget {
    pub max_model_turns: usize,
    pub max_tool_calls: usize,
    pub max_schema_objects: usize,
    pub max_result_rows: usize,
    pub max_result_bytes: usize,
    pub max_wall_clock_ms: u64,
    pub max_tokens: Option<usize>,
}

impl Default for AgentBudget {
    fn default() -> Self {
        Self {
            max_model_turns: DEFAULT_MAX_MODEL_TURNS,
            max_tool_calls: DEFAULT_MAX_TOOL_CALLS,
            max_schema_objects: DEFAULT_MAX_SCHEMA_OBJECTS,
            max_result_rows: DEFAULT_MAX_RESULT_ROWS,
            max_result_bytes: DEFAULT_MAX_RESULT_BYTES,
            max_wall_clock_ms: DEFAULT_MAX_WALL_CLOCK_MS,
            max_tokens: Some(DEFAULT_MAX_TOKENS),
        }
    }
}

impl AgentBudget {
    pub fn validate(self) -> Result<Self, SqlCommandError> {
        validate_positive_limit(self.max_model_turns, MAX_MODEL_TURNS, "model turn")?;
        validate_positive_limit(self.max_tool_calls, MAX_TOOL_CALLS, "tool call")?;
        validate_positive_limit(self.max_schema_objects, MAX_SCHEMA_OBJECTS, "schema object")?;
        validate_positive_limit(self.max_result_rows, MAX_RESULT_ROWS, "result row")?;
        validate_positive_limit(self.max_result_bytes, MAX_RESULT_BYTES, "result byte")?;
        if self.max_wall_clock_ms == 0 || self.max_wall_clock_ms > MAX_WALL_CLOCK_MS {
            return Err(SqlCommandError::new(
                "invalid_input",
                format!("wall-clock budget must be between 1 and {MAX_WALL_CLOCK_MS} ms"),
            ));
        }
        if let Some(max_tokens) = self.max_tokens {
            validate_positive_limit(max_tokens, MAX_TOKENS, "token")?;
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBudgetUsage {
    pub model_turns: usize,
    pub tool_calls: usize,
    pub schema_objects: usize,
    pub result_rows: usize,
    pub result_bytes: usize,
    pub tokens: usize,
}

impl AgentBudgetUsage {
    pub fn record_model_turn(&mut self, budget: &AgentBudget) -> Result<(), SqlCommandError> {
        let next = checked_increment(self.model_turns, "model turn")?;
        ensure_within(next, budget.max_model_turns, "model turn")?;
        self.model_turns = next;
        Ok(())
    }

    pub fn record_tool_call(&mut self, budget: &AgentBudget) -> Result<(), SqlCommandError> {
        let next = checked_increment(self.tool_calls, "tool call")?;
        ensure_within(next, budget.max_tool_calls, "tool call")?;
        self.tool_calls = next;
        Ok(())
    }

    pub fn add_schema_objects(
        &mut self,
        count: usize,
        budget: &AgentBudget,
    ) -> Result<(), SqlCommandError> {
        let next = checked_add(self.schema_objects, count, "schema object")?;
        ensure_within(next, budget.max_schema_objects, "schema object")?;
        self.schema_objects = next;
        Ok(())
    }

    pub fn record_result(
        &mut self,
        rows: usize,
        bytes: usize,
        budget: &AgentBudget,
    ) -> Result<(), SqlCommandError> {
        let next_rows = checked_add(self.result_rows, rows, "result row")?;
        let next_bytes = checked_add(self.result_bytes, bytes, "result byte")?;
        ensure_within(next_rows, budget.max_result_rows, "result row")?;
        ensure_within(next_bytes, budget.max_result_bytes, "result byte")?;
        self.result_rows = next_rows;
        self.result_bytes = next_bytes;
        Ok(())
    }

    pub fn add_tokens(
        &mut self,
        tokens: usize,
        budget: &AgentBudget,
    ) -> Result<(), SqlCommandError> {
        let next = checked_add(self.tokens, tokens, "token")?;
        if let Some(limit) = budget.max_tokens {
            ensure_within(next, limit, "token")?;
        }
        self.tokens = next;
        Ok(())
    }

    pub fn check(
        &self,
        budget: &AgentBudget,
        started_at: Instant,
        now: Instant,
    ) -> Result<(), SqlCommandError> {
        if now.saturating_duration_since(started_at)
            > Duration::from_millis(budget.max_wall_clock_ms)
        {
            return Err(budget_error(
                "wall_clock",
                usize::try_from(budget.max_wall_clock_ms).unwrap_or(usize::MAX),
            ));
        }
        ensure_within(self.model_turns, budget.max_model_turns, "model turn")?;
        ensure_within(self.tool_calls, budget.max_tool_calls, "tool call")?;
        ensure_within(
            self.schema_objects,
            budget.max_schema_objects,
            "schema object",
        )?;
        ensure_within(self.result_rows, budget.max_result_rows, "result row")?;
        ensure_within(self.result_bytes, budget.max_result_bytes, "result byte")?;
        if let Some(limit) = budget.max_tokens {
            ensure_within(self.tokens, limit, "token")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default)]
pub struct AgentCancellationToken(Arc<AtomicBool>);

impl AgentCancellationToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub run_id: String,
    pub goal: String,
    pub mode: AgentMode,
    pub budget: AgentBudget,
    pub state: AgentRunState,
    pub usage: AgentBudgetUsage,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub turns: Vec<AgentTurn>,
    pub tasks: Vec<AgentTask>,
    pub tool_calls: Vec<AgentToolCall>,
    pub evidence_refs: Vec<String>,
    #[serde(skip)]
    cancellation: AgentCancellationToken,
    #[serde(skip)]
    started_at: Instant,
}

impl AgentRun {
    pub fn new(
        run_id: impl Into<String>,
        goal: impl Into<String>,
        mode: AgentMode,
        budget: AgentBudget,
    ) -> Result<Self, SqlCommandError> {
        let now = Instant::now();
        Self::new_at(run_id, goal, mode, budget, now, unix_now_ms())
    }

    pub fn new_at(
        run_id: impl Into<String>,
        goal: impl Into<String>,
        mode: AgentMode,
        budget: AgentBudget,
        started_at: Instant,
        created_at_ms: u64,
    ) -> Result<Self, SqlCommandError> {
        let run_id = run_id.into();
        let run_id = validate_identifier(&run_id, "run id")?;
        let goal = validate_text(goal.into(), "run goal")?;
        let budget = budget.validate()?;
        Ok(Self {
            run_id,
            goal,
            mode,
            budget,
            state: AgentRunState::Created,
            usage: AgentBudgetUsage::default(),
            created_at_ms,
            updated_at_ms: created_at_ms,
            turns: Vec::new(),
            tasks: Vec::new(),
            tool_calls: Vec::new(),
            evidence_refs: Vec::new(),
            cancellation: AgentCancellationToken::default(),
            started_at,
        })
    }

    pub fn cancellation_token(&self) -> AgentCancellationToken {
        self.cancellation.clone()
    }

    pub fn transition(&mut self, next: AgentRunState) -> Result<(), SqlCommandError> {
        if next == AgentRunState::Cancelled {
            return self.cancel();
        }
        if !self.state.can_transition_to(next) {
            return Err(SqlCommandError::new(
                "invalid_input",
                format!(
                    "invalid agent run transition: {:?} -> {:?}",
                    self.state, next
                ),
            ));
        }
        self.state = next;
        self.updated_at_ms = unix_now_ms();
        Ok(())
    }

    /// Marks a run failed from any non-terminal lifecycle point. This is the
    /// error-path counterpart to the strict public transition table.
    pub fn mark_failed(&mut self) {
        if !self.state.is_terminal() {
            self.state = AgentRunState::Failed;
            self.updated_at_ms = unix_now_ms();
        }
    }

    pub fn cancel(&mut self) -> Result<(), SqlCommandError> {
        if self.state.is_terminal() {
            return Err(SqlCommandError::new(
                "invalid_input",
                "terminal agent run cannot be cancelled",
            ));
        }
        self.cancellation.cancel();
        self.state = AgentRunState::Cancelled;
        self.updated_at_ms = unix_now_ms();
        Ok(())
    }

    pub fn check_budget(&mut self, now: Instant) -> Result<(), SqlCommandError> {
        if self.cancellation.is_cancelled() {
            return Err(SqlCommandError::new(
                "invalid_input",
                "agent run was cancelled",
            ));
        }
        match self.usage.check(&self.budget, self.started_at, now) {
            Ok(()) => Ok(()),
            Err(error) => {
                if !self.state.is_terminal() {
                    self.state = AgentRunState::Failed;
                    self.updated_at_ms = unix_now_ms();
                }
                Err(error)
            }
        }
    }

    pub fn attach_evidence(
        &mut self,
        evidence_id: impl Into<String>,
    ) -> Result<(), SqlCommandError> {
        let evidence_id = evidence_id.into();
        let evidence_id = validate_identifier(&evidence_id, "evidence reference")?;
        if !self.evidence_refs.iter().any(|id| id == &evidence_id) {
            self.evidence_refs.push(evidence_id);
        }
        Ok(())
    }

    pub fn record_turn(&mut self, turn: AgentTurn) -> Result<(), SqlCommandError> {
        self.usage.record_model_turn(&self.budget)?;
        self.turns.push(turn);
        Ok(())
    }

    pub fn record_tool_call(&mut self, call: AgentToolCall) -> Result<(), SqlCommandError> {
        if call.run_id != self.run_id {
            return Err(SqlCommandError::new(
                "invalid_input",
                "tool call belongs to a different agent run",
            ));
        }
        self.usage.record_tool_call(&self.budget)?;
        self.tool_calls.push(call);
        Ok(())
    }
}

pub struct AgentRunStore {
    runs: std::sync::Mutex<std::collections::HashMap<String, AgentRun>>,
}

impl Default for AgentRunStore {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentRunStore {
    pub fn new() -> Self {
        Self {
            runs: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    pub fn insert(&self, run: AgentRun) -> Result<(), SqlCommandError> {
        let mut runs = self.runs.lock().expect("agent run store poisoned");
        if runs.contains_key(&run.run_id) {
            return Err(SqlCommandError::new(
                "invalid_input",
                "agent run id is already in use",
            ));
        }
        runs.insert(run.run_id.clone(), run);
        Ok(())
    }

    pub fn replace(&self, run: AgentRun) -> Result<(), SqlCommandError> {
        let mut runs = self.runs.lock().expect("agent run store poisoned");
        if !runs.contains_key(&run.run_id) {
            return Err(SqlCommandError::new(
                "invalid_input",
                "agent run was not found",
            ));
        }
        runs.insert(run.run_id.clone(), run);
        Ok(())
    }

    pub fn get(&self, run_id: &str) -> Option<AgentRun> {
        self.runs
            .lock()
            .expect("agent run store poisoned")
            .get(run_id)
            .cloned()
    }

    pub fn transition(
        &self,
        run_id: &str,
        next: AgentRunState,
    ) -> Result<AgentRun, SqlCommandError> {
        let mut runs = self.runs.lock().expect("agent run store poisoned");
        let run = runs
            .get_mut(run_id)
            .ok_or_else(|| SqlCommandError::new("invalid_input", "agent run was not found"))?;
        run.transition(next)?;
        Ok(run.clone())
    }

    pub fn cancel(&self, run_id: &str) -> Result<AgentRun, SqlCommandError> {
        let mut runs = self.runs.lock().expect("agent run store poisoned");
        let run = runs
            .get_mut(run_id)
            .ok_or_else(|| SqlCommandError::new("invalid_input", "agent run was not found"))?;
        run.cancel()?;
        Ok(run.clone())
    }
}

pub(crate) fn redact_json_value(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(object) => serde_json::Value::Object(
            object
                .into_iter()
                .map(|(key, value)| {
                    if is_sensitive_key(&key) {
                        (key, serde_json::Value::String("[REDACTED]".to_string()))
                    } else {
                        (key, redact_json_value(value))
                    }
                })
                .collect(),
        ),
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.into_iter().map(redact_json_value).collect())
        }
        other => other,
    }
}

pub(crate) fn redact_sensitive_text(value: &str) -> String {
    static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r"(?is)-----BEGIN [^-\r\n]*PRIVATE KEY-----.*?(?:-----END [^-\r\n]*PRIVATE KEY-----|\z)",
            r#"(?i)\b[a-z][a-z0-9+.-]*://[^\s<>\"']+"#,
            r"(?i)\bbearer\s+[a-z0-9._~+/=-]+",
            r"(?i)'[^'\r\n]*'@'[^'\r\n]*'",
            r#"(?i)\b(?:server\s+at|server\s+host|host(?:name)?)\s+(?:\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\r\n,;]+)"#,
            r#"(?i)\b(?:password|passwd|pwd|secret|token|api[_ -]?key|authorization|connection[_ -]?string|database[_ -]?url|host(?:name)?|server)\s*[:=]\s*(?:\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\r\n,;]+)"#,
        ]
        .into_iter()
        .map(|pattern| Regex::new(pattern).expect("static redaction pattern must compile"))
        .collect()
    });

    PATTERNS
        .iter()
        .fold(value.to_string(), |redacted, pattern| {
            pattern.replace_all(&redacted, "[REDACTED]").into_owned()
        })
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect();
    [
        "password",
        "passwd",
        "secret",
        "token",
        "apikey",
        "privatekey",
        "authorization",
        "connectionstring",
        "databaseurl",
    ]
    .iter()
    .any(|candidate| normalized.contains(candidate))
}

fn validate_identifier(value: &str, label: &str) -> Result<String, SqlCommandError> {
    let value = value.trim().to_string();
    if value.is_empty() || value.contains('\0') {
        return Err(SqlCommandError::new(
            "invalid_input",
            format!("{label} must not be blank or contain NUL"),
        ));
    }
    Ok(value)
}

fn validate_text(value: String, label: &str) -> Result<String, SqlCommandError> {
    if value.trim().is_empty() || value.contains('\0') {
        return Err(SqlCommandError::new(
            "invalid_input",
            format!("{label} must not be blank or contain NUL"),
        ));
    }
    Ok(value)
}

fn validate_positive_limit(
    value: usize,
    maximum: usize,
    label: &str,
) -> Result<(), SqlCommandError> {
    if value == 0 || value > maximum {
        return Err(SqlCommandError::new(
            "invalid_input",
            format!("{label} budget must be between 1 and {maximum}"),
        ));
    }
    Ok(())
}

fn checked_increment(value: usize, label: &str) -> Result<usize, SqlCommandError> {
    checked_add(value, 1, label)
}

fn checked_add(value: usize, addition: usize, label: &str) -> Result<usize, SqlCommandError> {
    value
        .checked_add(addition)
        .ok_or_else(|| SqlCommandError::new("invalid_input", format!("{label} budget overflow")))
}

fn ensure_within(value: usize, limit: usize, label: &str) -> Result<(), SqlCommandError> {
    if value > limit {
        return Err(budget_error(label, limit));
    }
    Ok(())
}

fn budget_error(dimension: &str, limit: usize) -> SqlCommandError {
    SqlCommandError::new(
        "invalid_input",
        format!("agent budget exceeded for {dimension} (limit {limit})"),
    )
}

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run() -> AgentRun {
        AgentRun::new_at(
            "run-1",
            "generate a query",
            AgentMode::SuggestOnly,
            AgentBudget::default(),
            Instant::now(),
            1,
        )
        .unwrap()
    }

    #[test]
    fn state_machine_rejects_invalid_transition() {
        let mut run = run();
        let error = run.transition(AgentRunState::ExecutingTool).unwrap_err();
        assert!(matches!(error, SqlCommandError::InvalidInput { .. }));
        assert_eq!(run.state, AgentRunState::Created);
    }

    #[test]
    fn state_machine_accepts_suggest_only_happy_path() {
        let mut run = run();
        for state in [
            AgentRunState::BuildingContext,
            AgentRunState::Reasoning,
            AgentRunState::AwaitingTool,
            AgentRunState::ExecutingTool,
            AgentRunState::Reasoning,
            AgentRunState::Completed,
        ] {
            run.transition(state).unwrap();
        }
        assert!(run.state.is_terminal());
    }

    #[test]
    fn cancellation_is_terminal_and_token_is_shared() {
        let mut run = run();
        let token = run.cancellation_token();
        run.transition(AgentRunState::Cancelled).unwrap();
        assert_eq!(run.state, AgentRunState::Cancelled);
        assert!(token.is_cancelled());
        assert!(run.cancel().is_err());
    }

    #[test]
    fn timeout_fails_run_without_sleeping() {
        let started = Instant::now();
        let mut run = AgentRun::new_at(
            "run-timeout",
            "timeout",
            AgentMode::SuggestOnly,
            AgentBudget {
                max_wall_clock_ms: 1,
                ..AgentBudget::default()
            },
            started,
            1,
        )
        .unwrap();
        let error = run
            .check_budget(started + Duration::from_millis(2))
            .unwrap_err();
        assert!(matches!(error, SqlCommandError::InvalidInput { .. }));
        assert_eq!(run.state, AgentRunState::Failed);
    }

    #[test]
    fn budget_recording_is_atomic_when_limit_is_exceeded() {
        let budget = AgentBudget {
            max_result_rows: 2,
            max_result_bytes: 10,
            ..AgentBudget::default()
        };
        let mut usage = AgentBudgetUsage::default();
        usage.record_result(2, 10, &budget).unwrap();
        assert!(usage.record_result(1, 0, &budget).is_err());
        assert_eq!(usage.result_rows, 2);
        assert_eq!(usage.result_bytes, 10);
    }

    #[test]
    fn tool_call_arguments_are_redacted_recursively() {
        let call = AgentToolCall::new(
            "run-1",
            "call-1",
            "workspace.current",
            json!({
                "password": "do-not-store",
                "nested": {"api_key": "also-secret", "value": 1},
                "items": [{"token": "hidden"}]
            }),
            vec![],
        )
        .unwrap();
        let serialized = serde_json::to_string(&call).unwrap();
        assert!(!serialized.contains("do-not-store"));
        assert!(!serialized.contains("also-secret"));
        assert!(!serialized.contains("hidden"));
        assert!(serialized.contains("[REDACTED]"));
    }

    #[test]
    fn run_serialization_does_not_include_cancellation_or_clock_state() {
        let serialized = serde_json::to_string(&run()).unwrap();
        assert!(!serialized.contains("cancellation"));
        assert!(!serialized.contains("started_at"));
    }

    #[test]
    fn store_rejects_duplicate_ids_and_returns_snapshots() {
        let store = AgentRunStore::new();
        store.insert(run()).unwrap();
        assert!(store.insert(run()).is_err());
        let snapshot = store
            .transition("run-1", AgentRunState::BuildingContext)
            .unwrap();
        assert_eq!(snapshot.state, AgentRunState::BuildingContext);
        assert_eq!(
            store.get("run-1").unwrap().state,
            AgentRunState::BuildingContext
        );
    }
}
