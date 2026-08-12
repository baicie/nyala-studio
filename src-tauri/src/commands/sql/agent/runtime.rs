//! A2.3 deterministic Suggest-only loop.

#![allow(dead_code)]

use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use serde_json::json;

use super::super::sql_analysis::analyze_sql;
use super::super::types::SqlCommandError;
use super::domain::{AgentMode, AgentRun, AgentRunState, AgentTaskKind, AgentTurn};
use super::evidence::{AgentEvidenceKind, AgentEvidenceSensitivity, AgentEvidenceStore};
use super::model::{
    parse_model_response, AgentFinalResponse, AgentModelContext, AgentModelGateway,
    AgentModelRequest, AgentModelResponse,
};
use super::policy::{AgentAuthorizedTool, AgentPolicy};

#[derive(Debug, Clone)]
pub struct AgentToolExecution {
    pub evidence: Vec<(
        AgentEvidenceKind,
        AgentEvidenceSensitivity,
        serde_json::Value,
    )>,
    pub warnings: Vec<String>,
    pub query_call_count: usize,
    pub result_rows: usize,
    pub result_bytes: usize,
}

pub trait ReadOnlyAgentToolExecutor: Send {
    fn execute(
        &mut self,
        authorized: &AgentAuthorizedTool,
    ) -> Result<AgentToolExecution, SqlCommandError>;
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLoopResult {
    pub run_id: String,
    pub state: AgentRunState,
    pub answer: Option<AgentFinalResponse>,
    pub evidence_refs: Vec<String>,
    pub warnings: Vec<String>,
    pub partial: bool,
    pub query_call_count: usize,
}

pub struct SuggestOnlyAgentLoop<G> {
    gateway: G,
    policy: AgentPolicy,
    evidence_store: Arc<AgentEvidenceStore>,
}

impl<G: AgentModelGateway> SuggestOnlyAgentLoop<G> {
    pub fn new(gateway: G, policy: AgentPolicy, evidence_store: Arc<AgentEvidenceStore>) -> Self {
        Self {
            gateway,
            policy,
            evidence_store,
        }
    }

    pub fn run(
        &mut self,
        run: &mut AgentRun,
        task: AgentTaskKind,
        context: &AgentModelContext,
    ) -> Result<AgentLoopResult, SqlCommandError> {
        if run.mode == AgentMode::AllowWritesWithApproval {
            return fail_run(
                run,
                SqlCommandError::new(
                    "invalid_input",
                    "A2 Suggest-only loop cannot run in write mode",
                ),
            );
        }
        if run.state != AgentRunState::Created {
            return fail_run(
                run,
                SqlCommandError::new("invalid_input", "Agent loop requires a newly created run"),
            );
        }
        run.transition(AgentRunState::BuildingContext)?;
        run.transition(AgentRunState::Reasoning)?;
        if let Err(error) = record_schema_context_budget(run, context) {
            return fail_run(run, error);
        }

        let mut evidence_refs = Vec::new();
        let mut warnings = Vec::new();
        loop {
            if let Err(error) = run.check_budget(Instant::now()) {
                return fail_run(run, error);
            }
            let request = AgentModelRequest {
                run_id: run.run_id.clone(),
                task,
                context: context.clone(),
                evidence_refs: evidence_refs.clone(),
            };
            let raw_response = match self.gateway.generate(&request) {
                Ok(response) => response,
                Err(error) => return fail_run(run, error),
            };
            if let Err(error) = run.record_turn(AgentTurn {
                turn_id: format!("turn-{}", run.usage.model_turns + 1),
                sequence: run.usage.model_turns + 1,
                input_bytes: serde_json::to_vec(&request).map_or(0, |value| value.len()),
                output_bytes: raw_response.len(),
                completed: true,
            }) {
                return fail_run(run, error);
            }
            let response = match parse_model_response(&run.run_id, &raw_response) {
                Ok(response) => response,
                Err(error) => return fail_run(run, error),
            };
            match response {
                AgentModelResponse::Final(answer) => {
                    run.transition(AgentRunState::Completed)?;
                    return Ok(AgentLoopResult {
                        run_id: run.run_id.clone(),
                        state: run.state,
                        answer: Some(answer),
                        evidence_refs,
                        warnings,
                        partial: false,
                        query_call_count: 0,
                    });
                }
                AgentModelResponse::ToolCall(call) => {
                    if let Err(error) = run.transition(AgentRunState::AwaitingTool) {
                        return fail_run(run, error);
                    }
                    let authorized = match self.policy.authorize(&call) {
                        Ok(authorized) => authorized,
                        Err(error) => return fail_run(run, error),
                    };
                    if let Err(error) = run.record_tool_call(call) {
                        return fail_run(run, error);
                    }
                    if let Err(error) = run.transition(AgentRunState::ExecutingTool) {
                        return fail_run(run, error);
                    }
                    let evidence =
                        match execute_suggest_tool(&authorized, context, &self.evidence_store) {
                            Ok(evidence) => evidence,
                            Err(error) => return fail_run(run, error),
                        };
                    run.attach_evidence(&evidence.evidence_id)?;
                    evidence_refs.push(evidence.evidence_id);
                    if authorized.tool.wire_name() == "relation.search" {
                        warnings.push(
                            "relation.search is not available without FK metadata".to_string(),
                        );
                    }
                    run.transition(AgentRunState::Reasoning)?;
                }
            }
        }
    }
}

/// A3 loop with a typed tool executor. The default query path records only
/// result shape/aggregate evidence; rows require the result.sample approval
/// policy in the executor.
pub struct ReadOnlyAgentLoop<G, E> {
    gateway: G,
    policy: AgentPolicy,
    executor: E,
    evidence_store: Arc<AgentEvidenceStore>,
}

impl<G: AgentModelGateway, E: ReadOnlyAgentToolExecutor> ReadOnlyAgentLoop<G, E> {
    pub fn new(
        gateway: G,
        policy: AgentPolicy,
        executor: E,
        evidence_store: Arc<AgentEvidenceStore>,
    ) -> Self {
        Self {
            gateway,
            policy,
            executor,
            evidence_store,
        }
    }

    pub fn run(
        &mut self,
        run: &mut AgentRun,
        task: AgentTaskKind,
        context: &AgentModelContext,
    ) -> Result<AgentLoopResult, SqlCommandError> {
        if run.mode != AgentMode::ReadOnly {
            return fail_run(
                run,
                SqlCommandError::new("invalid_input", "A3 read-only loop requires Read Only mode"),
            );
        }
        if run.state != AgentRunState::Created {
            return fail_run(
                run,
                SqlCommandError::new("invalid_input", "Agent loop requires a newly created run"),
            );
        }
        run.transition(AgentRunState::BuildingContext)?;
        run.transition(AgentRunState::Reasoning)?;
        if let Err(error) = record_schema_context_budget(run, context) {
            return fail_run(run, error);
        }

        let mut evidence_refs = Vec::new();
        let mut warnings = Vec::new();
        let mut query_call_count = 0usize;
        loop {
            if let Err(error) = run.check_budget(Instant::now()) {
                return fail_run(run, error);
            }
            let request = AgentModelRequest {
                run_id: run.run_id.clone(),
                task,
                context: context.clone(),
                evidence_refs: evidence_refs.clone(),
            };
            let raw_response = match self.gateway.generate(&request) {
                Ok(response) => response,
                Err(error) => return fail_run(run, error),
            };
            if let Err(error) = run.record_turn(AgentTurn {
                turn_id: format!("turn-{}", run.usage.model_turns + 1),
                sequence: run.usage.model_turns + 1,
                input_bytes: serde_json::to_vec(&request).map_or(0, |value| value.len()),
                output_bytes: raw_response.len(),
                completed: true,
            }) {
                return fail_run(run, error);
            }
            let response = match parse_model_response(&run.run_id, &raw_response) {
                Ok(response) => response,
                Err(error) => return fail_run(run, error),
            };
            match response {
                AgentModelResponse::Final(answer) => {
                    run.transition(AgentRunState::Completed)?;
                    return Ok(AgentLoopResult {
                        run_id: run.run_id.clone(),
                        state: run.state,
                        answer: Some(answer),
                        evidence_refs,
                        warnings,
                        partial: false,
                        query_call_count,
                    });
                }
                AgentModelResponse::ToolCall(call) => {
                    run.transition(AgentRunState::AwaitingTool)?;
                    let authorized = match self.policy.authorize_read_only(&call) {
                        Ok(authorized) => authorized,
                        Err(error) => return fail_run(run, error),
                    };
                    run.record_tool_call(call)?;
                    run.transition(AgentRunState::ExecutingTool)?;
                    let execution = match self.executor.execute(&authorized) {
                        Ok(execution) => execution,
                        Err(error) => return fail_run(run, error),
                    };
                    if let Err(error) = run.usage.record_result(
                        execution.result_rows,
                        execution.result_bytes,
                        &run.budget,
                    ) {
                        return fail_run(run, error);
                    }
                    query_call_count = query_call_count.saturating_add(execution.query_call_count);
                    warnings.extend(execution.warnings);
                    for (kind, sensitivity, payload) in execution.evidence {
                        let evidence = match self.evidence_store.append(
                            &run.run_id,
                            kind,
                            sensitivity,
                            payload,
                        ) {
                            Ok(evidence) => evidence,
                            Err(error) => return fail_run(run, error),
                        };
                        run.attach_evidence(&evidence.evidence_id)?;
                        evidence_refs.push(evidence.evidence_id);
                    }
                    run.transition(AgentRunState::Reasoning)?;
                }
            }
        }
    }
}

fn record_schema_context_budget(
    run: &mut AgentRun,
    context: &AgentModelContext,
) -> Result<(), SqlCommandError> {
    run.usage
        .add_schema_objects(context.schema.len(), &run.budget)
}

fn execute_suggest_tool(
    authorized: &AgentAuthorizedTool,
    context: &AgentModelContext,
    evidence_store: &AgentEvidenceStore,
) -> Result<super::evidence::AgentEvidenceRef, SqlCommandError> {
    let (kind, payload) = match authorized.tool.wire_name() {
        "workspace.current" => (
            AgentEvidenceKind::Schema,
            json!({
                "tool": authorized.tool.wire_name(),
                "dialect": context.dialect,
                "sqlPresent": context.sql.is_some() || context.selected_sql.is_some(),
                "schemaObjectCount": context.schema.len(),
            }),
        ),
        "sql.parse" | "sql.validate" => {
            let sql = authorized
                .arguments
                .get("sql")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    SqlCommandError::new("invalid_input", "sql tool requires a string sql argument")
                })?;
            let analysis = analyze_sql(sql, context.dialect);
            (
                AgentEvidenceKind::Analysis,
                json!({
                    "tool": authorized.tool.wire_name(),
                    "analysis": analysis,
                }),
            )
        }
        "schema.search" | "table.describe" => (
            AgentEvidenceKind::Schema,
            json!({
                "tool": authorized.tool.wire_name(),
                "status": "context_only",
                "message": "schema adapter results must be supplied by the local SQL core",
            }),
        ),
        "relation.search" => (
            AgentEvidenceKind::Schema,
            json!({
                "tool": authorized.tool.wire_name(),
                "status": "unsupported",
                "message": "foreign-key metadata is not available in A2",
            }),
        ),
        _ => {
            return Err(SqlCommandError::new(
                "invalid_input",
                "A2 tool dispatch received a non-Suggest-only tool",
            ));
        }
    };
    evidence_store.append(
        &authorized.run_id,
        kind,
        AgentEvidenceSensitivity::Workspace,
        payload,
    )
}

fn fail_run<T>(run: &mut AgentRun, error: SqlCommandError) -> Result<T, SqlCommandError> {
    if !run.state.is_terminal() {
        if run.cancellation_token().is_cancelled() {
            let _ = run.transition(AgentRunState::Cancelled);
        } else {
            run.mark_failed();
        }
    }
    Err(error)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::super::domain::{AgentBudget, AgentMode};
    use super::super::evidence::AgentEvidenceStore;
    use super::super::model::{AgentModelRequest, AgentModelSchemaTable};
    use super::super::policy::{AgentCapability, AgentCapabilitySet, AgentPolicy, AgentTool};
    use super::*;

    struct ScriptedGateway {
        responses: VecDeque<String>,
        requests: Vec<AgentModelRequest>,
        cancel_on_first_request: bool,
        cancellation: Option<super::super::domain::AgentCancellationToken>,
    }

    impl ScriptedGateway {
        fn new(responses: impl IntoIterator<Item = String>) -> Self {
            Self {
                responses: responses.into_iter().collect(),
                requests: Vec::new(),
                cancel_on_first_request: false,
                cancellation: None,
            }
        }
    }

    impl AgentModelGateway for ScriptedGateway {
        fn generate(&mut self, request: &AgentModelRequest) -> Result<String, SqlCommandError> {
            self.requests.push(request.clone());
            if self.cancel_on_first_request && self.requests.len() == 1 {
                if let Some(token) = &self.cancellation {
                    token.cancel();
                }
            }
            self.responses.pop_front().ok_or_else(|| {
                SqlCommandError::new("invalid_input", "scripted model has no response")
            })
        }
    }

    fn run(budget: AgentBudget) -> AgentRun {
        AgentRun::new("run-1", "generate a query", AgentMode::SuggestOnly, budget).unwrap()
    }

    fn policy() -> AgentPolicy {
        AgentPolicy::new(
            AgentMode::SuggestOnly,
            AgentCapabilitySet::from_capabilities([
                AgentCapability::AgentTool,
                AgentCapability::WorkspaceReadSql,
            ]),
        )
    }

    fn read_only_policy() -> AgentPolicy {
        AgentPolicy::new(
            AgentMode::ReadOnly,
            AgentCapabilitySet::from_capabilities([
                AgentCapability::DatabaseExecuteRead,
                AgentCapability::DatabaseExplain,
                AgentCapability::DatabaseReadResultShape,
                AgentCapability::DatabaseReadResultSample,
            ]),
        )
    }

    fn read_only_run(budget: AgentBudget) -> AgentRun {
        AgentRun::new("run-1", "explore data", AgentMode::ReadOnly, budget).unwrap()
    }

    struct ScriptedExecutor {
        tools: Vec<AgentTool>,
    }

    impl ReadOnlyAgentToolExecutor for ScriptedExecutor {
        fn execute(
            &mut self,
            authorized: &AgentAuthorizedTool,
        ) -> Result<AgentToolExecution, SqlCommandError> {
            self.tools.push(authorized.tool);
            let (evidence, query_call_count, result_rows, result_bytes) = match authorized.tool {
                AgentTool::SqlExecuteReadonly => (
                    vec![
                        (
                            AgentEvidenceKind::ResultShape,
                            AgentEvidenceSensitivity::Workspace,
                            json!({"resultRef":"result-1","shape":{"rowCount":3}}),
                        ),
                        (
                            AgentEvidenceKind::Aggregate,
                            AgentEvidenceSensitivity::Workspace,
                            json!({"resultRef":"result-1","aggregate":{"rowCount":3}}),
                        ),
                    ],
                    1,
                    3,
                    30,
                ),
                AgentTool::ResultInspect => (
                    vec![(
                        AgentEvidenceKind::ResultShape,
                        AgentEvidenceSensitivity::Workspace,
                        json!({"resultRef":"result-1","shape":{"rowCount":3}}),
                    )],
                    0,
                    0,
                    0,
                ),
                AgentTool::ResultSample => (
                    vec![(
                        AgentEvidenceKind::ResultSample,
                        AgentEvidenceSensitivity::Sensitive,
                        json!({"resultRef":"result-1","sample":{"sampledRowCount":1,"rows":[["[REDACTED]"]],"redactedCells":1}}),
                    )],
                    0,
                    1,
                    12,
                ),
                _ => {
                    return Err(SqlCommandError::new(
                        "invalid_input",
                        "unexpected scripted read-only tool",
                    ));
                }
            };
            Ok(AgentToolExecution {
                evidence,
                warnings: Vec::new(),
                query_call_count,
                result_rows,
                result_bytes,
            })
        }
    }

    fn final_json() -> String {
        json!({"type":"final","title":"Done","content":"draft"}).to_string()
    }

    #[test]
    fn scripted_final_response_completes_without_query_calls() {
        let mut loop_runtime = SuggestOnlyAgentLoop::new(
            ScriptedGateway::new([final_json()]),
            policy(),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget::default());
        let result = loop_runtime
            .run(
                &mut run,
                AgentTaskKind::GenerateQuery,
                &AgentModelContext::default(),
            )
            .unwrap();
        assert_eq!(result.state, AgentRunState::Completed);
        assert_eq!(result.query_call_count, 0);
        assert_eq!(run.usage.model_turns, 1);
    }

    #[test]
    fn schema_context_is_recorded_against_the_run_budget() {
        let mut loop_runtime = SuggestOnlyAgentLoop::new(
            ScriptedGateway::new([final_json()]),
            policy(),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget {
            max_schema_objects: 2,
            ..AgentBudget::default()
        });
        let context = AgentModelContext {
            schema: vec![
                AgentModelSchemaTable {
                    schema: None,
                    name: "users".to_string(),
                    columns: vec!["id".to_string()],
                },
                AgentModelSchemaTable {
                    schema: None,
                    name: "orders".to_string(),
                    columns: vec!["id".to_string()],
                },
            ],
            ..AgentModelContext::default()
        };

        loop_runtime
            .run(&mut run, AgentTaskKind::GenerateQuery, &context)
            .unwrap();

        assert_eq!(run.usage.schema_objects, 2);
    }

    #[test]
    fn schema_context_over_budget_fails_before_model_generation() {
        let mut loop_runtime = SuggestOnlyAgentLoop::new(
            ScriptedGateway::new([final_json()]),
            policy(),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget {
            max_schema_objects: 1,
            ..AgentBudget::default()
        });
        let context = AgentModelContext {
            schema: vec![
                AgentModelSchemaTable {
                    schema: None,
                    name: "users".to_string(),
                    columns: Vec::new(),
                },
                AgentModelSchemaTable {
                    schema: None,
                    name: "orders".to_string(),
                    columns: Vec::new(),
                },
            ],
            ..AgentModelContext::default()
        };

        let error = loop_runtime
            .run(&mut run, AgentTaskKind::GenerateQuery, &context)
            .unwrap_err();

        assert!(error.to_string().contains("schema object"));
        assert_eq!(run.state, AgentRunState::Failed);
        assert_eq!(run.usage.schema_objects, 0);
        assert_eq!(run.usage.model_turns, 0);
    }

    #[test]
    fn bad_json_fails_run_with_structured_error() {
        let mut loop_runtime = SuggestOnlyAgentLoop::new(
            ScriptedGateway::new(["{bad".to_string()]),
            policy(),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget::default());
        let error = loop_runtime
            .run(
                &mut run,
                AgentTaskKind::Assistant,
                &AgentModelContext::default(),
            )
            .unwrap_err();
        assert!(matches!(error, SqlCommandError::InvalidInput { .. }));
        assert_eq!(run.state, AgentRunState::Failed);
    }

    #[test]
    fn unknown_tool_is_rejected_before_any_query_dispatch() {
        let unknown = json!({
            "type": "tool_call",
            "call_id": "call-1",
            "tool": "tauri.invoke",
            "arguments": {"command": "sql_query"}
        })
        .to_string();
        let mut loop_runtime = SuggestOnlyAgentLoop::new(
            ScriptedGateway::new([unknown]),
            policy(),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget::default());
        let error = loop_runtime
            .run(
                &mut run,
                AgentTaskKind::Assistant,
                &AgentModelContext::default(),
            )
            .unwrap_err();
        assert!(error.to_string().contains("unknown Agent tool"));
        assert_eq!(run.state, AgentRunState::Failed);
    }

    #[test]
    fn tool_then_final_preserves_evidence_refs_and_zero_query_calls() {
        let tool = json!({
            "type": "tool_call",
            "call_id": "call-1",
            "tool": "sql.parse",
            "arguments": {"sql": "SELECT 1"}
        })
        .to_string();
        let mut loop_runtime = SuggestOnlyAgentLoop::new(
            ScriptedGateway::new([tool, final_json()]),
            policy(),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget::default());
        let result = loop_runtime
            .run(
                &mut run,
                AgentTaskKind::Assistant,
                &AgentModelContext::default(),
            )
            .unwrap();
        assert_eq!(result.evidence_refs.len(), 1);
        assert_eq!(result.query_call_count, 0);
        assert_eq!(run.usage.tool_calls, 1);
    }

    #[test]
    fn model_turn_budget_stops_scripted_loop_before_second_model_call() {
        let tool = json!({
            "type": "tool_call",
            "call_id": "call-1",
            "tool": "sql.parse",
            "arguments": {"sql": "SELECT 1"}
        })
        .to_string();
        let mut loop_runtime = SuggestOnlyAgentLoop::new(
            ScriptedGateway::new([tool, final_json()]),
            policy(),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget {
            max_model_turns: 1,
            ..AgentBudget::default()
        });
        let error = loop_runtime
            .run(
                &mut run,
                AgentTaskKind::Assistant,
                &AgentModelContext::default(),
            )
            .unwrap_err();
        assert!(error.to_string().contains("model turn"));
        assert_eq!(run.state, AgentRunState::Failed);
        assert_eq!(run.usage.model_turns, 1);
    }

    #[test]
    fn cancellation_from_gateway_stops_before_next_turn() {
        let mut run = run(AgentBudget::default());
        let token = run.cancellation_token();
        let mut gateway = ScriptedGateway::new([json!({
            "type": "tool_call",
            "call_id": "call-1",
            "tool": "sql.parse",
            "arguments": {"sql": "SELECT 1"}
        })
        .to_string()]);
        gateway.cancel_on_first_request = true;
        gateway.cancellation = Some(token.clone());
        let mut loop_runtime =
            SuggestOnlyAgentLoop::new(gateway, policy(), Arc::new(AgentEvidenceStore::default()));
        let _ = loop_runtime.run(
            &mut run,
            AgentTaskKind::Assistant,
            &AgentModelContext::default(),
        );
        assert!(token.is_cancelled());
        assert_eq!(run.state, AgentRunState::Cancelled);
    }

    #[test]
    fn read_only_loop_executes_inspects_samples_and_finishes_with_bounded_usage() {
        let execute = json!({
            "type": "tool_call",
            "call_id": "call-execute",
            "tool": "sql.execute_readonly",
            "arguments": {
                "connectionId": "reader",
                "dialect": "sqlite",
                "sql": "SELECT id FROM users"
            }
        })
        .to_string();
        let inspect = json!({
            "type": "tool_call",
            "call_id": "call-inspect",
            "tool": "result.inspect",
            "arguments": {"resultRef": "result-1"}
        })
        .to_string();
        let sample = json!({
            "type": "tool_call",
            "call_id": "call-sample",
            "tool": "result.sample",
            "arguments": {
                "resultRef": "result-1",
                "approved": true,
                "maxRows": 1,
                "maxBytes": 64
            }
        })
        .to_string();
        let executor = ScriptedExecutor { tools: Vec::new() };
        let mut loop_runtime = ReadOnlyAgentLoop::new(
            ScriptedGateway::new([execute, inspect, sample, final_json()]),
            read_only_policy(),
            executor,
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = read_only_run(AgentBudget::default());
        let result = loop_runtime
            .run(
                &mut run,
                AgentTaskKind::Assistant,
                &AgentModelContext::default(),
            )
            .unwrap();

        assert_eq!(result.state, AgentRunState::Completed);
        assert_eq!(result.query_call_count, 1);
        assert_eq!(result.evidence_refs.len(), 4);
        assert_eq!(run.usage.result_rows, 4);
        assert_eq!(run.usage.result_bytes, 42);
    }

    #[test]
    fn read_only_loop_fails_atomically_when_result_budget_is_exceeded() {
        let execute = json!({
            "type": "tool_call",
            "call_id": "call-execute",
            "tool": "sql.execute_readonly",
            "arguments": {
                "connectionId": "reader",
                "dialect": "sqlite",
                "sql": "SELECT id FROM users"
            }
        })
        .to_string();
        let mut loop_runtime = ReadOnlyAgentLoop::new(
            ScriptedGateway::new([execute]),
            read_only_policy(),
            ScriptedExecutor { tools: Vec::new() },
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = read_only_run(AgentBudget {
            max_result_rows: 2,
            ..AgentBudget::default()
        });
        let error = loop_runtime
            .run(
                &mut run,
                AgentTaskKind::Assistant,
                &AgentModelContext::default(),
            )
            .unwrap_err();
        assert!(error.to_string().contains("result row"));
        assert_eq!(run.state, AgentRunState::Failed);
        assert_eq!(run.usage.result_rows, 0);
    }
}
