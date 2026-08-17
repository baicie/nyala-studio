//! A2.3 deterministic Suggest-only loop.

#![allow(dead_code)]

use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use serde_json::json;

use super::super::sql_analysis::{analyze_sql, SqlAnalysis, StatementRisk};
use super::super::types::SqlCommandError;
use super::domain::{
    AgentBudget, AgentBudgetUsage, AgentMode, AgentRun, AgentRunState, AgentTaskKind,
    AgentToolCall, AgentTurn,
};
use super::evidence::{
    AgentEvidenceInput, AgentEvidenceKind, AgentEvidenceSensitivity, AgentEvidenceStore,
};
use super::index_context::IndexListResult;
use super::model::{
    parse_model_response, AgentFinalResponse, AgentModelContext, AgentModelGateway,
    AgentModelRelationContext, AgentModelRequest, AgentModelResponse, AgentModelResultShape,
    AgentModelSchemaTable,
};
use super::plan::{SqlitePlanComparison, SqlitePlanSnapshot};
use super::policy::{AgentAuthorizedTool, AgentPolicy, AgentTool};

#[derive(Debug, Clone)]
pub struct AgentToolExecution {
    pub evidence: Vec<AgentEvidenceInput>,
    pub schema: Option<Vec<AgentModelSchemaTable>>,
    pub relation_context: Option<AgentModelRelationContext>,
    pub analysis: Option<SqlAnalysis>,
    pub index_context: Option<IndexListResult>,
    pub normalized_plan: Option<SqlitePlanSnapshot>,
    pub result_ref: Option<String>,
    pub result_shape: Option<AgentModelResultShape>,
    pub warnings: Vec<String>,
    pub query_call_count: usize,
    pub result_rows: usize,
    pub result_bytes: usize,
    pub partial: bool,
}

pub trait ReadOnlyAgentToolExecutor: Send {
    fn execute(
        &mut self,
        authorized: &AgentAuthorizedTool,
        context: &AgentModelContext,
    ) -> Result<AgentToolExecution, SqlCommandError>;
}

#[derive(Debug, Clone)]
pub struct SuggestOnlyAgentToolExecution {
    pub evidence: Vec<AgentEvidenceInput>,
    pub schema: Option<Vec<AgentModelSchemaTable>>,
    pub relation_context: Option<AgentModelRelationContext>,
    pub analysis: Option<SqlAnalysis>,
    pub index_context: Option<IndexListResult>,
    pub warnings: Vec<String>,
}

pub trait SuggestOnlyAgentToolExecutor: Send {
    fn execute(
        &mut self,
        authorized: &AgentAuthorizedTool,
        context: &AgentModelContext,
    ) -> Result<SuggestOnlyAgentToolExecution, SqlCommandError>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct ContextOnlySuggestAgentToolExecutor;

impl SuggestOnlyAgentToolExecutor for ContextOnlySuggestAgentToolExecutor {
    fn execute(
        &mut self,
        authorized: &AgentAuthorizedTool,
        context: &AgentModelContext,
    ) -> Result<SuggestOnlyAgentToolExecution, SqlCommandError> {
        execute_context_suggest_tool(authorized, context)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOptimizeEvidence {
    pub index_metadata_available: bool,
    pub comparison: SqlitePlanComparison,
    pub semantics_verified: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLoopResult {
    pub run_id: String,
    pub state: AgentRunState,
    pub answer: Option<AgentFinalResponse>,
    pub evidence_refs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub optimize_evidence: Option<AgentOptimizeEvidence>,
    pub warnings: Vec<String>,
    pub partial: bool,
    pub query_call_count: usize,
}

pub struct SuggestOnlyAgentLoop<G, E = ContextOnlySuggestAgentToolExecutor> {
    gateway: G,
    policy: AgentPolicy,
    executor: E,
    evidence_store: Arc<AgentEvidenceStore>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SchemaDraftVerification {
    NotRequired,
    AwaitingSchema { task: AgentTaskKind },
    AwaitingParse { task: AgentTaskKind },
    Complete { task: AgentTaskKind, sql: String },
}

#[derive(Clone)]
struct SuggestLoopOutput {
    model_context: AgentModelContext,
    evidence_refs: Vec<String>,
    warnings: Vec<String>,
    schema_draft_verification: SchemaDraftVerification,
}

impl<G: AgentModelGateway> SuggestOnlyAgentLoop<G, ContextOnlySuggestAgentToolExecutor> {
    pub fn new(gateway: G, policy: AgentPolicy, evidence_store: Arc<AgentEvidenceStore>) -> Self {
        Self {
            gateway,
            policy,
            executor: ContextOnlySuggestAgentToolExecutor,
            evidence_store,
        }
    }
}

impl<G: AgentModelGateway, E: SuggestOnlyAgentToolExecutor> SuggestOnlyAgentLoop<G, E> {
    pub fn with_executor(
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
        self.run_with_progress(run, task, context, |_| Ok(()))
    }

    pub fn run_with_progress<F>(
        &mut self,
        run: &mut AgentRun,
        task: AgentTaskKind,
        context: &AgentModelContext,
        mut on_progress: F,
    ) -> Result<AgentLoopResult, SqlCommandError>
    where
        F: FnMut(&AgentRun) -> Result<(), SqlCommandError>,
    {
        let result = self.run_inner(run, task, context, &mut on_progress);
        match result {
            Ok(result) => Ok(result),
            Err(error) => fail_run(run, error),
        }
    }

    fn run_inner<F>(
        &mut self,
        run: &mut AgentRun,
        task: AgentTaskKind,
        context: &AgentModelContext,
        on_progress: &mut F,
    ) -> Result<AgentLoopResult, SqlCommandError>
    where
        F: FnMut(&AgentRun) -> Result<(), SqlCommandError>,
    {
        let mut output = start_suggest_run(run, task, context, on_progress)?;
        loop {
            match self.next_response(run, task, &output, on_progress)? {
                AgentModelResponse::Final(answer) => {
                    return complete_suggest_run(run, answer, output);
                }
                AgentModelResponse::ToolCall(call) => {
                    self.execute_tool_call(run, call, &mut output, on_progress)?;
                }
            }
        }
    }

    fn next_response<F>(
        &mut self,
        run: &mut AgentRun,
        task: AgentTaskKind,
        output: &SuggestLoopOutput,
        on_progress: &mut F,
    ) -> Result<AgentModelResponse, SqlCommandError>
    where
        F: FnMut(&AgentRun) -> Result<(), SqlCommandError>,
    {
        run.check_budget(Instant::now())?;
        let request = AgentModelRequest {
            run_id: run.run_id.clone(),
            task,
            context: output.model_context.clone(),
            evidence_refs: output.evidence_refs.clone(),
        };
        let raw_response = self.gateway.generate(&request)?;
        run.record_turn(AgentTurn {
            turn_id: format!("turn-{}", run.usage.model_turns + 1),
            sequence: run.usage.model_turns + 1,
            input_bytes: serde_json::to_vec(&request).map_or(0, |value| value.len()),
            output_bytes: raw_response.len(),
            completed: true,
        })?;
        on_progress(run)?;
        parse_model_response(&run.run_id, &raw_response)
    }

    fn execute_tool_call<F>(
        &mut self,
        run: &mut AgentRun,
        call: AgentToolCall,
        output: &mut SuggestLoopOutput,
        on_progress: &mut F,
    ) -> Result<(), SqlCommandError>
    where
        F: FnMut(&AgentRun) -> Result<(), SqlCommandError>,
    {
        run.transition(AgentRunState::AwaitingTool)?;
        let authorized = self.policy.authorize(&call)?;
        validate_schema_draft_tool_order(&authorized, &output.schema_draft_verification)?;
        run.record_tool_call(call)?;
        on_progress(run)?;
        run.transition(AgentRunState::ExecutingTool)?;
        on_progress(run)?;
        let execution = self.executor.execute(&authorized, &output.model_context)?;
        run.check_budget(Instant::now())?;

        let mut next_output = output.clone();
        let mut next_usage = run.usage;
        advance_schema_draft_parse(&authorized, &execution, &mut next_output)?;
        let awaiting_schema_task = match &next_output.schema_draft_verification {
            SchemaDraftVerification::AwaitingSchema { task } => Some(*task),
            _ => None,
        };
        if authorized.tool == AgentTool::SchemaSearch
            && awaiting_schema_task.is_some()
            && execution.schema.is_none()
        {
            return Err(SqlCommandError::new(
                "internal",
                "schema.search did not return typed schema context",
            ));
        }
        if let Some(schema) = execution.schema {
            next_usage.add_schema_objects(schema.len(), &run.budget)?;
            if let Some(task) = awaiting_schema_task {
                if schema.is_empty() {
                    return Err(SqlCommandError::new(
                        "validation",
                        format!(
                            "{} requires at least one real schema object",
                            schema_draft_label(task)
                        ),
                    ));
                }
                next_output.schema_draft_verification =
                    SchemaDraftVerification::AwaitingParse { task };
            }
            next_output.model_context.schema = schema;
        }
        if let Some(relation_context) = execution.relation_context {
            next_output.model_context.relation_context = Some(relation_context);
        }
        next_output.warnings.extend(execution.warnings);
        run.check_budget(Instant::now())?;
        let evidence = self
            .evidence_store
            .append_batch(&run.run_id, execution.evidence)?;
        for evidence in evidence {
            run.attach_evidence(&evidence.evidence_id)?;
            next_output.evidence_refs.push(evidence.evidence_id);
        }
        run.usage = next_usage;
        *output = next_output;
        run.transition(AgentRunState::Reasoning)?;
        on_progress(run)
    }
}

fn start_suggest_run<F>(
    run: &mut AgentRun,
    task: AgentTaskKind,
    context: &AgentModelContext,
    on_progress: &mut F,
) -> Result<SuggestLoopOutput, SqlCommandError>
where
    F: FnMut(&AgentRun) -> Result<(), SqlCommandError>,
{
    if run.mode == AgentMode::AllowWritesWithApproval {
        return Err(SqlCommandError::new(
            "invalid_input",
            "A2 Suggest-only loop cannot run in write mode",
        ));
    }
    if run.state != AgentRunState::Created {
        return Err(SqlCommandError::new(
            "invalid_input",
            "Agent loop requires a newly created run",
        ));
    }
    if task == AgentTaskKind::FixError
        && context
            .connection_id
            .as_deref()
            .is_none_or(|connection_id| connection_id.trim().is_empty())
    {
        return Err(SqlCommandError::new(
            "invalid_input",
            "Schema-aware Fix requires an open connection",
        ));
    }
    run.transition(AgentRunState::BuildingContext)?;
    on_progress(run)?;
    let connected_schema_task = connected_schema_draft_task(task, context);
    if connected_schema_task.is_none() {
        record_schema_context_budget(run, context)?;
    }
    let mut model_context = context.redacted_for_model();
    if connected_schema_task.is_some() {
        model_context.schema.clear();
        model_context.relation_context = None;
    }
    run.check_budget(Instant::now())?;
    run.transition(AgentRunState::Reasoning)?;
    on_progress(run)?;
    Ok(SuggestLoopOutput {
        model_context,
        evidence_refs: Vec::new(),
        warnings: Vec::new(),
        schema_draft_verification: connected_schema_task
            .map_or(SchemaDraftVerification::NotRequired, |task| {
                SchemaDraftVerification::AwaitingSchema { task }
            }),
    })
}

fn connected_schema_draft_task(
    task: AgentTaskKind,
    context: &AgentModelContext,
) -> Option<AgentTaskKind> {
    let has_connection = context
        .connection_id
        .as_deref()
        .is_some_and(|connection_id| !connection_id.trim().is_empty());
    (has_connection && matches!(task, AgentTaskKind::GenerateQuery | AgentTaskKind::FixError))
        .then_some(task)
}

fn advance_schema_draft_parse(
    authorized: &AgentAuthorizedTool,
    execution: &SuggestOnlyAgentToolExecution,
    output: &mut SuggestLoopOutput,
) -> Result<(), SqlCommandError> {
    if authorized.tool != AgentTool::SqlParse
        || output.schema_draft_verification == SchemaDraftVerification::NotRequired
    {
        return Ok(());
    }
    let task = match &output.schema_draft_verification {
        SchemaDraftVerification::AwaitingParse { task } => *task,
        _ => {
            return Err(SqlCommandError::new(
                "validation",
                "Schema-aware draft must search schema before parsing its draft",
            ));
        }
    };
    let analysis = execution.analysis.as_ref().ok_or_else(|| {
        SqlCommandError::new("internal", "sql.parse did not return typed analysis")
    })?;
    if analysis.statement_count != 1 || analysis.risk != StatementRisk::ReadOnly {
        return Err(SqlCommandError::new(
            "validation",
            format!(
                "{} draft must be one read-only statement",
                schema_draft_label(task)
            ),
        ));
    }
    let sql = authorized
        .arguments
        .get("sql")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| SqlCommandError::new("internal", "sql.parse did not retain its SQL"))?;
    output.schema_draft_verification = SchemaDraftVerification::Complete {
        task,
        sql: sql.to_string(),
    };
    Ok(())
}

fn validate_schema_draft_tool_order(
    authorized: &AgentAuthorizedTool,
    verification: &SchemaDraftVerification,
) -> Result<(), SqlCommandError> {
    let (valid, task) = match verification {
        SchemaDraftVerification::NotRequired => (true, None),
        SchemaDraftVerification::AwaitingSchema { task } => {
            (authorized.tool == AgentTool::SchemaSearch, Some(*task))
        }
        SchemaDraftVerification::AwaitingParse { task } => {
            (authorized.tool == AgentTool::SqlParse, Some(*task))
        }
        SchemaDraftVerification::Complete { task, .. } => (false, Some(*task)),
    };
    if !valid {
        return Err(SqlCommandError::new(
            "validation",
            format!(
                "{} requires the exact schema.search, sql.parse, final sequence",
                task.map_or("Schema-aware draft", schema_draft_label)
            ),
        ));
    }
    Ok(())
}

fn schema_draft_label(task: AgentTaskKind) -> &'static str {
    match task {
        AgentTaskKind::GenerateQuery => "Schema-aware Generate",
        AgentTaskKind::FixError => "Schema-aware Fix",
        _ => "Schema-aware draft",
    }
}

fn complete_suggest_run(
    run: &mut AgentRun,
    answer: AgentFinalResponse,
    output: SuggestLoopOutput,
) -> Result<AgentLoopResult, SqlCommandError> {
    match &output.schema_draft_verification {
        SchemaDraftVerification::NotRequired => {}
        SchemaDraftVerification::AwaitingSchema { task }
        | SchemaDraftVerification::AwaitingParse { task } => {
            return Err(SqlCommandError::new(
                "validation",
                format!(
                    "{} requires schema.search and a read-only sql.parse result",
                    schema_draft_label(*task)
                ),
            ));
        }
        SchemaDraftVerification::Complete { task, sql } => {
            if answer.sql.as_deref() != Some(sql.as_str()) {
                return Err(SqlCommandError::new(
                    "validation",
                    format!(
                        "{} final SQL must match the parsed draft",
                        schema_draft_label(*task)
                    ),
                ));
            }
        }
    }
    run.transition(AgentRunState::Completed)?;
    Ok(AgentLoopResult {
        run_id: run.run_id.clone(),
        state: run.state,
        answer: Some(answer),
        evidence_refs: output.evidence_refs,
        optimize_evidence: None,
        warnings: output.warnings,
        partial: false,
        query_call_count: 0,
    })
}

/// A3 loop with a typed tool executor. The default query path records only
/// result shape/aggregate evidence; rows require the result.sample approval
/// policy in the executor.
pub struct ReadOnlyAgentLoop<G, E> {
    gateway: G,
    policy: AgentPolicy,
    executor: E,
    evidence_store: Arc<AgentEvidenceStore>,
    contract: ReadOnlyLoopContract,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadOnlyLoopContract {
    Direct,
    Explore,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExploreBinding {
    goal: String,
    connection_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ExploreVerification {
    NotRequired,
    AwaitingSchema {
        binding: ExploreBinding,
    },
    AwaitingParse {
        binding: ExploreBinding,
    },
    AwaitingExecute {
        binding: ExploreBinding,
        sql: String,
    },
    AwaitingInspect {
        binding: ExploreBinding,
        sql: String,
        result_ref: String,
    },
    Complete {
        sql: String,
    },
}

#[derive(Clone)]
struct ReadOnlyLoopOutput {
    model_context: AgentModelContext,
    evidence_refs: Vec<String>,
    warnings: Vec<String>,
    query_call_count: usize,
    partial: bool,
    verification: ExploreVerification,
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
            contract: ReadOnlyLoopContract::Direct,
        }
    }

    pub fn new_explore(
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
            contract: ReadOnlyLoopContract::Explore,
        }
    }

    pub fn run(
        &mut self,
        run: &mut AgentRun,
        task: AgentTaskKind,
        context: &AgentModelContext,
    ) -> Result<AgentLoopResult, SqlCommandError> {
        self.run_with_progress(run, task, context, |_| Ok(()))
    }

    pub fn run_with_progress<F>(
        &mut self,
        run: &mut AgentRun,
        task: AgentTaskKind,
        context: &AgentModelContext,
        mut on_progress: F,
    ) -> Result<AgentLoopResult, SqlCommandError>
    where
        F: FnMut(&AgentRun) -> Result<(), SqlCommandError>,
    {
        let result = self.run_inner(run, task, context, &mut on_progress);
        match result {
            Ok(result) => Ok(result),
            Err(error) => fail_run(run, error),
        }
    }

    fn run_inner<F>(
        &mut self,
        run: &mut AgentRun,
        task: AgentTaskKind,
        context: &AgentModelContext,
        on_progress: &mut F,
    ) -> Result<AgentLoopResult, SqlCommandError>
    where
        F: FnMut(&AgentRun) -> Result<(), SqlCommandError>,
    {
        let mut output = start_read_only_run(run, task, context, self.contract, on_progress)?;
        loop {
            run.check_budget(Instant::now())?;
            let request = AgentModelRequest {
                run_id: run.run_id.clone(),
                task,
                context: output.model_context.clone(),
                evidence_refs: output.evidence_refs.clone(),
            };
            let raw_response = self.gateway.generate(&request)?;
            run.check_budget(Instant::now())?;
            run.record_turn(AgentTurn {
                turn_id: format!("turn-{}", run.usage.model_turns + 1),
                sequence: run.usage.model_turns + 1,
                input_bytes: serde_json::to_vec(&request).map_or(0, |value| value.len()),
                output_bytes: raw_response.len(),
                completed: true,
            })?;
            on_progress(run)?;
            match parse_model_response(&run.run_id, &raw_response)? {
                AgentModelResponse::Final(answer) => {
                    return complete_read_only_run(run, answer, output);
                }
                AgentModelResponse::ToolCall(call) => {
                    self.execute_tool_call(run, call, &mut output, on_progress)?;
                }
            }
        }
    }

    fn execute_tool_call<F>(
        &mut self,
        run: &mut AgentRun,
        call: AgentToolCall,
        output: &mut ReadOnlyLoopOutput,
        on_progress: &mut F,
    ) -> Result<(), SqlCommandError>
    where
        F: FnMut(&AgentRun) -> Result<(), SqlCommandError>,
    {
        run.transition(AgentRunState::AwaitingTool)?;
        let authorized = authorize_read_only_call(&self.policy, &call, &output.verification)?;
        validate_explore_tool_order(&authorized, &output.verification)?;
        run.record_tool_call(call)?;
        on_progress(run)?;
        run.transition(AgentRunState::ExecutingTool)?;
        on_progress(run)?;
        let execution = self.executor.execute(&authorized, &output.model_context)?;
        run.check_budget(Instant::now())?;

        validate_explore_stage_evidence(&output.verification, &execution)?;
        let mut next_output = output.clone();
        let mut next_usage = run.usage;
        advance_explore_verification(
            &run.budget,
            &mut next_usage,
            &authorized,
            &execution,
            &mut next_output,
        )?;
        next_usage.record_result(execution.result_rows, execution.result_bytes, &run.budget)?;
        next_output.query_call_count = next_output
            .query_call_count
            .saturating_add(execution.query_call_count);
        if execution.partial && !next_output.partial {
            next_output
                .warnings
                .push("Result evidence was truncated; the final answer is partial.".to_string());
        }
        next_output.partial |= execution.partial;
        next_output.warnings.extend(execution.warnings);
        run.check_budget(Instant::now())?;
        let evidence = self
            .evidence_store
            .append_batch(&run.run_id, execution.evidence)?;
        for evidence in evidence {
            run.attach_evidence(&evidence.evidence_id)?;
            next_output.evidence_refs.push(evidence.evidence_id);
        }
        run.usage = next_usage;
        *output = next_output;
        run.transition(AgentRunState::Reasoning)?;
        on_progress(run)
    }
}

fn start_read_only_run<F>(
    run: &mut AgentRun,
    task: AgentTaskKind,
    context: &AgentModelContext,
    contract: ReadOnlyLoopContract,
    on_progress: &mut F,
) -> Result<ReadOnlyLoopOutput, SqlCommandError>
where
    F: FnMut(&AgentRun) -> Result<(), SqlCommandError>,
{
    if run.mode != AgentMode::ReadOnly {
        return Err(SqlCommandError::new(
            "invalid_input",
            "A3 read-only loop requires Read Only mode",
        ));
    }
    if run.state != AgentRunState::Created {
        return Err(SqlCommandError::new(
            "invalid_input",
            "Agent loop requires a newly created run",
        ));
    }
    if contract == ReadOnlyLoopContract::Explore && task != AgentTaskKind::Assistant {
        return Err(SqlCommandError::new(
            "invalid_input",
            "Read-only Explore only accepts Assistant tasks",
        ));
    }

    run.transition(AgentRunState::BuildingContext)?;
    on_progress(run)?;
    let mut model_context = context.redacted_for_model();
    let verification = if contract == ReadOnlyLoopContract::Explore {
        let connection_id = model_context
            .connection_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty() && !value.contains('\0'))
            .ok_or_else(|| {
                SqlCommandError::new(
                    "invalid_input",
                    "Read-only Explore requires a valid connection id",
                )
            })?
            .to_string();
        model_context.connection_id = Some(connection_id.clone());
        let binding = ExploreBinding {
            goal: run.goal.clone(),
            connection_id,
        };
        if binding.goal.trim().is_empty() {
            return Err(SqlCommandError::new(
                "invalid_input",
                "Read-only Explore requires a run goal",
            ));
        }
        model_context.schema.clear();
        model_context.relation_context = None;
        model_context.result_shape = None;
        model_context.result_ref = None;
        ExploreVerification::AwaitingSchema { binding }
    } else {
        record_schema_context_budget(run, &model_context)?;
        ExploreVerification::NotRequired
    };
    run.transition(AgentRunState::Reasoning)?;
    on_progress(run)?;
    Ok(ReadOnlyLoopOutput {
        model_context,
        evidence_refs: Vec::new(),
        warnings: Vec::new(),
        query_call_count: 0,
        partial: false,
        verification,
    })
}

fn authorize_read_only_call(
    policy: &AgentPolicy,
    call: &AgentToolCall,
    verification: &ExploreVerification,
) -> Result<AgentAuthorizedTool, SqlCommandError> {
    if *verification == ExploreVerification::NotRequired {
        return policy.authorize_read_only(call);
    }
    match AgentTool::parse(&call.tool)? {
        AgentTool::SchemaSearch | AgentTool::SqlParse => policy.authorize(call),
        AgentTool::SqlExecuteReadonly | AgentTool::ResultInspect => {
            policy.authorize_read_only(call)
        }
        tool => Err(SqlCommandError::new(
            "invalid_input",
            format!(
                "Agent tool '{}' is not part of Read-only Explore",
                tool.wire_name()
            ),
        )),
    }
}

fn validate_explore_tool_order(
    authorized: &AgentAuthorizedTool,
    verification: &ExploreVerification,
) -> Result<(), SqlCommandError> {
    match verification {
        ExploreVerification::NotRequired => Ok(()),
        ExploreVerification::AwaitingSchema { binding } => {
            if authorized.tool != AgentTool::SchemaSearch {
                return Err(explore_sequence_error());
            }
            let connection_id = authorized
                .arguments
                .get("connectionId")
                .and_then(serde_json::Value::as_str);
            let query = authorized
                .arguments
                .get("query")
                .and_then(serde_json::Value::as_str);
            if connection_id != Some(binding.connection_id.as_str())
                || query != Some(binding.goal.as_str())
            {
                return Err(SqlCommandError::new(
                    "validation",
                    "Read-only Explore schema.search must match the run goal and connection",
                ));
            }
            Ok(())
        }
        ExploreVerification::AwaitingParse { .. } => {
            if authorized.tool != AgentTool::SqlParse {
                return Err(explore_sequence_error());
            }
            Ok(())
        }
        ExploreVerification::AwaitingExecute { binding, sql } => {
            if authorized.tool != AgentTool::SqlExecuteReadonly {
                return Err(explore_sequence_error());
            }
            if authorized
                .arguments
                .get("sql")
                .and_then(serde_json::Value::as_str)
                != Some(sql.as_str())
            {
                return Err(SqlCommandError::new(
                    "validation",
                    "Read-only Explore execution SQL must match the parsed draft",
                ));
            }
            if authorized
                .arguments
                .get("connectionId")
                .and_then(serde_json::Value::as_str)
                != Some(binding.connection_id.as_str())
            {
                return Err(SqlCommandError::new(
                    "validation",
                    "Read-only Explore execution must use the run connection",
                ));
            }
            Ok(())
        }
        ExploreVerification::AwaitingInspect { result_ref, .. } => {
            if authorized.tool != AgentTool::ResultInspect {
                return Err(explore_sequence_error());
            }
            if authorized
                .arguments
                .get("resultRef")
                .and_then(serde_json::Value::as_str)
                != Some(result_ref.as_str())
            {
                return Err(SqlCommandError::new(
                    "validation",
                    "Read-only Explore inspect must use the execution result reference",
                ));
            }
            Ok(())
        }
        ExploreVerification::Complete { .. } => Err(explore_sequence_error()),
    }
}

fn explore_sequence_error() -> SqlCommandError {
    SqlCommandError::new(
        "validation",
        "Read-only Explore requires the exact schema.search, sql.parse, parsed draft execution, result.inspect, final sequence",
    )
}

fn validate_explore_stage_evidence(
    verification: &ExploreVerification,
    execution: &AgentToolExecution,
) -> Result<(), SqlCommandError> {
    let required: &[(AgentEvidenceKind, &str)] = match verification {
        ExploreVerification::NotRequired => return Ok(()),
        ExploreVerification::AwaitingSchema { .. } => {
            &[(AgentEvidenceKind::Schema, "Schema evidence")]
        }
        ExploreVerification::AwaitingParse { .. } => {
            &[(AgentEvidenceKind::Analysis, "Analysis evidence")]
        }
        ExploreVerification::AwaitingExecute { .. }
        | ExploreVerification::AwaitingInspect { .. } => &[
            (AgentEvidenceKind::ResultShape, "ResultShape evidence"),
            (AgentEvidenceKind::Aggregate, "Aggregate evidence"),
        ],
        ExploreVerification::Complete { .. } => return Err(explore_sequence_error()),
    };
    for (required_kind, label) in required {
        if !execution
            .evidence
            .iter()
            .any(|(kind, _, _)| kind == required_kind)
        {
            return Err(SqlCommandError::new(
                "internal",
                format!("Read-only Explore stage did not return {label}"),
            ));
        }
    }
    Ok(())
}

fn advance_explore_verification(
    budget: &AgentBudget,
    usage: &mut AgentBudgetUsage,
    authorized: &AgentAuthorizedTool,
    execution: &AgentToolExecution,
    output: &mut ReadOnlyLoopOutput,
) -> Result<(), SqlCommandError> {
    match output.verification.clone() {
        ExploreVerification::NotRequired => Ok(()),
        ExploreVerification::AwaitingSchema { binding } => {
            advance_explore_schema(budget, usage, binding, execution, output)
        }
        ExploreVerification::AwaitingParse { binding } => {
            advance_explore_parse(binding, authorized, execution, output)
        }
        ExploreVerification::AwaitingExecute { binding, sql } => {
            advance_explore_execute(binding, sql, execution, output)
        }
        ExploreVerification::AwaitingInspect {
            sql, result_ref, ..
        } => advance_explore_inspect(sql, &result_ref, execution, output),
        ExploreVerification::Complete { .. } => Err(SqlCommandError::new(
            "validation",
            "Read-only Explore already completed its tool sequence",
        )),
    }
}

fn advance_explore_schema(
    budget: &AgentBudget,
    usage: &mut AgentBudgetUsage,
    binding: ExploreBinding,
    execution: &AgentToolExecution,
    output: &mut ReadOnlyLoopOutput,
) -> Result<(), SqlCommandError> {
    let schema = execution.schema.as_ref().ok_or_else(|| {
        SqlCommandError::new("internal", "schema.search did not return typed schema")
    })?;
    if schema.is_empty() {
        return Err(SqlCommandError::new(
            "validation",
            "Read-only Explore requires at least one real schema object",
        ));
    }
    if execution.query_call_count != 0 {
        return Err(SqlCommandError::new(
            "internal",
            "schema.search must not execute a query",
        ));
    }
    usage.add_schema_objects(schema.len(), budget)?;
    output.model_context.schema.clone_from(schema);
    if let Some(relation_context) = &execution.relation_context {
        output.model_context.relation_context = Some(relation_context.clone());
    }
    output.verification = ExploreVerification::AwaitingParse { binding };
    Ok(())
}

fn advance_explore_parse(
    binding: ExploreBinding,
    authorized: &AgentAuthorizedTool,
    execution: &AgentToolExecution,
    output: &mut ReadOnlyLoopOutput,
) -> Result<(), SqlCommandError> {
    let analysis = execution.analysis.as_ref().ok_or_else(|| {
        SqlCommandError::new("internal", "sql.parse did not return typed analysis")
    })?;
    if analysis.statement_count != 1 || analysis.risk != StatementRisk::ReadOnly {
        return Err(SqlCommandError::new(
            "validation",
            "Read-only Explore draft must be one read-only statement",
        ));
    }
    if execution.query_call_count != 0 {
        return Err(SqlCommandError::new(
            "internal",
            "sql.parse must not execute a query",
        ));
    }
    let sql = authorized
        .arguments
        .get("sql")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| SqlCommandError::new("internal", "sql.parse did not retain SQL"))?;
    output.verification = ExploreVerification::AwaitingExecute {
        binding,
        sql: sql.to_string(),
    };
    Ok(())
}

fn advance_explore_execute(
    binding: ExploreBinding,
    sql: String,
    execution: &AgentToolExecution,
    output: &mut ReadOnlyLoopOutput,
) -> Result<(), SqlCommandError> {
    if execution.query_call_count != 1 {
        return Err(SqlCommandError::new(
            "internal",
            "Read-only Explore execution must report exactly one query call",
        ));
    }
    let result_ref = execution
        .result_ref
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.contains('\0'))
        .ok_or_else(|| {
            SqlCommandError::new(
                "internal",
                "Read-only Explore execution did not return a result reference",
            )
        })?;
    let result_shape = execution.result_shape.clone().ok_or_else(|| {
        SqlCommandError::new(
            "internal",
            "Read-only Explore execution did not return result shape",
        )
    })?;
    output.model_context.result_ref = Some(result_ref.to_string());
    output.model_context.result_shape = Some(result_shape);
    output.verification = ExploreVerification::AwaitingInspect {
        binding,
        sql,
        result_ref: result_ref.to_string(),
    };
    Ok(())
}

fn advance_explore_inspect(
    sql: String,
    result_ref: &str,
    execution: &AgentToolExecution,
    output: &mut ReadOnlyLoopOutput,
) -> Result<(), SqlCommandError> {
    if execution.query_call_count != 0 {
        return Err(SqlCommandError::new(
            "internal",
            "result.inspect must not execute a query",
        ));
    }
    if execution.result_ref.as_deref() != Some(result_ref) {
        return Err(SqlCommandError::new(
            "validation",
            "Read-only Explore inspect returned a different result reference",
        ));
    }
    output.verification = ExploreVerification::Complete { sql };
    Ok(())
}

fn complete_read_only_run(
    run: &mut AgentRun,
    answer: AgentFinalResponse,
    output: ReadOnlyLoopOutput,
) -> Result<AgentLoopResult, SqlCommandError> {
    match &output.verification {
        ExploreVerification::NotRequired => {}
        ExploreVerification::Complete { sql } => {
            if answer.sql.as_deref() != Some(sql.as_str()) {
                return Err(SqlCommandError::new(
                    "validation",
                    "Read-only Explore final SQL must match the parsed draft",
                ));
            }
            if output.query_call_count != 1 {
                return Err(SqlCommandError::new(
                    "internal",
                    "Read-only Explore must complete with exactly one query call",
                ));
            }
        }
        _ => {
            return Err(SqlCommandError::new(
                "validation",
                "Read-only Explore requires schema.search, sql.parse, execute, and result.inspect before final",
            ));
        }
    }
    run.transition(AgentRunState::Completed)?;
    Ok(AgentLoopResult {
        run_id: run.run_id.clone(),
        state: run.state,
        answer: Some(answer),
        evidence_refs: output.evidence_refs,
        optimize_evidence: None,
        warnings: output.warnings,
        partial: output.partial,
        query_call_count: output.query_call_count,
    })
}

fn record_schema_context_budget(
    run: &mut AgentRun,
    context: &AgentModelContext,
) -> Result<(), SqlCommandError> {
    run.usage
        .add_schema_objects(context.schema.len(), &run.budget)
}

pub(crate) fn execute_context_suggest_tool(
    authorized: &AgentAuthorizedTool,
    context: &AgentModelContext,
) -> Result<SuggestOnlyAgentToolExecution, SqlCommandError> {
    let mut typed_analysis = None;
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
            typed_analysis = Some(analysis.clone());
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
                "status": "context_only",
                "message": "relation.search requires the local SQL core adapter",
            }),
        ),
        "index.list" => (
            AgentEvidenceKind::Index,
            json!({
                "tool": authorized.tool.wire_name(),
                "status": "context_only",
                "message": "index.list requires the local SQL core adapter",
            }),
        ),
        _ => {
            return Err(SqlCommandError::new(
                "invalid_input",
                "A2 tool dispatch received a non-Suggest-only tool",
            ));
        }
    };
    let warnings = matches!(
        authorized.tool,
        AgentTool::RelationSearch | AgentTool::IndexList
    )
    .then(|| {
        format!(
            "{} requires the local SQL core adapter",
            authorized.tool.wire_name()
        )
    })
    .into_iter()
    .collect();
    Ok(SuggestOnlyAgentToolExecution {
        evidence: vec![(kind, AgentEvidenceSensitivity::Workspace, payload)],
        schema: None,
        relation_context: None,
        analysis: typed_analysis,
        index_context: None,
        warnings,
    })
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
    use super::super::model::{
        AgentModelErrorContext, AgentModelRequest, AgentModelResultShape,
        AgentModelResultShapeColumn, AgentModelSchemaTable,
    };
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

    fn read_only_explore_policy() -> AgentPolicy {
        AgentPolicy::new(
            AgentMode::ReadOnly,
            AgentCapabilitySet::from_capabilities([
                AgentCapability::AgentTool,
                AgentCapability::DatabaseReadMetadata,
                AgentCapability::DatabaseExecuteRead,
                AgentCapability::DatabaseReadResultShape,
            ]),
        )
    }

    fn schema_generate_policy() -> AgentPolicy {
        AgentPolicy::new(
            AgentMode::SuggestOnly,
            AgentCapabilitySet::from_capabilities([
                AgentCapability::AgentTool,
                AgentCapability::DatabaseReadMetadata,
            ]),
        )
    }

    fn connected_generate_context() -> AgentModelContext {
        AgentModelContext {
            connection_id: Some("demo".to_string()),
            ..AgentModelContext::default()
        }
    }

    fn connected_fix_context() -> AgentModelContext {
        AgentModelContext {
            connection_id: Some("demo".to_string()),
            editor_id: Some("query-editor-secret".to_string()),
            editor_version_id: Some(7),
            sql: Some("SELECT amunt FROM orders".to_string()),
            error_context: Some(AgentModelErrorContext {
                code: Some("no_such_column".to_string()),
                message: "no such column: amunt".to_string(),
                detail: None,
            }),
            schema: vec![AgentModelSchemaTable {
                schema: Some("forged".to_string()),
                name: "orders".to_string(),
                columns: vec!["amunt".to_string()],
            }],
            ..AgentModelContext::default()
        }
    }

    fn schema_search_json() -> String {
        json!({
            "type": "tool_call",
            "call_id": "call-schema",
            "tool": "schema.search",
            "arguments": {
                "connectionId": "demo",
                "schema": "main",
                "query": "orders"
            }
        })
        .to_string()
    }

    fn explore_schema_search_json(connection_id: &str, query: &str) -> String {
        json!({
            "type": "tool_call",
            "call_id": "call-schema",
            "tool": "schema.search",
            "arguments": {
                "connectionId": connection_id,
                "schema": "main",
                "query": query
            }
        })
        .to_string()
    }

    fn sql_parse_json(sql: &str) -> String {
        json!({
            "type": "tool_call",
            "call_id": "call-parse",
            "tool": "sql.parse",
            "arguments": {"sql": sql}
        })
        .to_string()
    }

    fn final_sql_json(sql: &str) -> String {
        json!({
            "type": "final",
            "title": "Done",
            "content": "draft",
            "sql": sql
        })
        .to_string()
    }

    struct SchemaSuggestExecutor {
        schema: Vec<AgentModelSchemaTable>,
    }

    impl SuggestOnlyAgentToolExecutor for SchemaSuggestExecutor {
        fn execute(
            &mut self,
            authorized: &AgentAuthorizedTool,
            context: &AgentModelContext,
        ) -> Result<SuggestOnlyAgentToolExecution, SqlCommandError> {
            if authorized.tool != AgentTool::SchemaSearch {
                return execute_context_suggest_tool(authorized, context);
            }
            Ok(SuggestOnlyAgentToolExecution {
                evidence: vec![(
                    AgentEvidenceKind::Schema,
                    AgentEvidenceSensitivity::Workspace,
                    json!({"tool": "schema.search"}),
                )],
                schema: Some(self.schema.clone()),
                relation_context: None,
                analysis: None,
                index_context: None,
                warnings: Vec::new(),
            })
        }
    }

    fn schema_executor(table_count: usize) -> SchemaSuggestExecutor {
        SchemaSuggestExecutor {
            schema: (0..table_count)
                .map(|index| AgentModelSchemaTable {
                    schema: Some("main".to_string()),
                    name: format!("table_{index}"),
                    columns: vec!["id".to_string()],
                })
                .collect(),
        }
    }

    fn read_only_run(budget: AgentBudget) -> AgentRun {
        AgentRun::new("run-1", "explore data", AgentMode::ReadOnly, budget).unwrap()
    }

    struct ScriptedExecutor {
        tools: Vec<AgentTool>,
        partial: bool,
        cancellation: Option<super::super::domain::AgentCancellationToken>,
    }

    struct ExploreExecutor {
        tools: Arc<std::sync::Mutex<Vec<AgentTool>>>,
        inspect_result_ref: String,
    }

    impl ReadOnlyAgentToolExecutor for ExploreExecutor {
        fn execute(
            &mut self,
            authorized: &AgentAuthorizedTool,
            context: &AgentModelContext,
        ) -> Result<AgentToolExecution, SqlCommandError> {
            self.tools.lock().unwrap().push(authorized.tool);
            let evidence_kinds = match authorized.tool {
                AgentTool::SchemaSearch => vec![AgentEvidenceKind::Schema],
                AgentTool::SqlParse => vec![AgentEvidenceKind::Analysis],
                AgentTool::SqlExecuteReadonly | AgentTool::ResultInspect => {
                    vec![AgentEvidenceKind::ResultShape, AgentEvidenceKind::Aggregate]
                }
                _ => {
                    return Err(SqlCommandError::new(
                        "invalid_input",
                        "unexpected Explore tool",
                    ));
                }
            };
            let mut execution = AgentToolExecution {
                evidence: evidence_kinds
                    .into_iter()
                    .map(|kind| {
                        (
                            kind,
                            AgentEvidenceSensitivity::Workspace,
                            json!({"tool": authorized.tool.wire_name()}),
                        )
                    })
                    .collect(),
                schema: None,
                relation_context: None,
                analysis: None,
                index_context: None,
                normalized_plan: None,
                result_ref: None,
                result_shape: None,
                warnings: Vec::new(),
                query_call_count: 0,
                result_rows: 0,
                result_bytes: 0,
                partial: false,
            };
            match authorized.tool {
                AgentTool::SchemaSearch => {
                    execution.schema = Some(vec![AgentModelSchemaTable {
                        schema: Some("main".to_string()),
                        name: "orders".to_string(),
                        columns: vec!["amount".to_string(), "created_at".to_string()],
                    }]);
                }
                AgentTool::SqlParse => {
                    let sql = authorized.arguments["sql"].as_str().unwrap();
                    execution.analysis = Some(analyze_sql(sql, context.dialect));
                }
                AgentTool::SqlExecuteReadonly => {
                    execution.result_ref = Some("result-9".to_string());
                    execution.result_shape = Some(AgentModelResultShape {
                        columns: vec![AgentModelResultShapeColumn {
                            name: "total_amount".to_string(),
                            ordinal: 0,
                        }],
                        row_count: 3,
                        elapsed_ms: 2,
                        truncated: false,
                    });
                    execution.query_call_count = 1;
                    execution.result_rows = 3;
                    execution.result_bytes = 24;
                }
                AgentTool::ResultInspect => {
                    assert_eq!(authorized.arguments["resultRef"], "result-9");
                    execution.result_ref = Some(self.inspect_result_ref.clone());
                }
                _ => unreachable!(),
            }
            Ok(execution)
        }
    }

    struct MissingEvidenceExploreExecutor {
        inner: ExploreExecutor,
        missing_for: AgentTool,
    }

    impl ReadOnlyAgentToolExecutor for MissingEvidenceExploreExecutor {
        fn execute(
            &mut self,
            authorized: &AgentAuthorizedTool,
            context: &AgentModelContext,
        ) -> Result<AgentToolExecution, SqlCommandError> {
            let mut execution = self.inner.execute(authorized, context)?;
            if authorized.tool == self.missing_for {
                execution.evidence.clear();
            }
            Ok(execution)
        }
    }

    impl ReadOnlyAgentToolExecutor for ScriptedExecutor {
        fn execute(
            &mut self,
            authorized: &AgentAuthorizedTool,
            _context: &AgentModelContext,
        ) -> Result<AgentToolExecution, SqlCommandError> {
            self.tools.push(authorized.tool);
            if let Some(token) = &self.cancellation {
                token.cancel();
            }
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
                schema: None,
                relation_context: None,
                analysis: None,
                index_context: None,
                normalized_plan: None,
                result_ref: matches!(
                    authorized.tool,
                    AgentTool::SqlExecuteReadonly | AgentTool::ResultInspect
                )
                .then(|| "result-1".to_string()),
                result_shape: matches!(
                    authorized.tool,
                    AgentTool::SqlExecuteReadonly | AgentTool::ResultInspect
                )
                .then(|| AgentModelResultShape {
                    columns: Vec::new(),
                    row_count: 3,
                    elapsed_ms: 1,
                    truncated: self.partial,
                }),
                warnings: Vec::new(),
                query_call_count,
                result_rows,
                result_bytes,
                partial: self.partial,
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
    fn connected_generate_requires_metadata_capability_before_schema_dispatch() {
        let mut loop_runtime = SuggestOnlyAgentLoop::with_executor(
            ScriptedGateway::new([schema_search_json()]),
            policy(),
            schema_executor(1),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget::default());

        let error = loop_runtime
            .run(
                &mut run,
                AgentTaskKind::GenerateQuery,
                &connected_generate_context(),
            )
            .unwrap_err();

        assert!(error.to_string().contains("database.readMetadata"));
        assert_eq!(run.state, AgentRunState::Failed);
        assert_eq!(run.usage.tool_calls, 0);
    }

    #[test]
    fn connected_generate_rejects_final_before_schema_and_parse() {
        let mut loop_runtime = SuggestOnlyAgentLoop::with_executor(
            ScriptedGateway::new([final_json()]),
            schema_generate_policy(),
            schema_executor(1),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget::default());

        let error = loop_runtime
            .run(
                &mut run,
                AgentTaskKind::GenerateQuery,
                &connected_generate_context(),
            )
            .unwrap_err();

        assert!(error.to_string().contains("schema.search"));
        assert!(error.to_string().contains("sql.parse"));
        assert_eq!(run.state, AgentRunState::Failed);
    }

    #[test]
    fn connected_generate_rejects_final_before_parse() {
        let mut loop_runtime = SuggestOnlyAgentLoop::with_executor(
            ScriptedGateway::new([schema_search_json(), final_json()]),
            schema_generate_policy(),
            schema_executor(1),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget::default());

        let error = loop_runtime
            .run(
                &mut run,
                AgentTaskKind::GenerateQuery,
                &connected_generate_context(),
            )
            .unwrap_err();

        assert!(error.to_string().contains("sql.parse"));
        assert_eq!(run.state, AgentRunState::Failed);
    }

    #[test]
    fn connected_generate_rejects_parse_before_schema() {
        let mut loop_runtime = SuggestOnlyAgentLoop::with_executor(
            ScriptedGateway::new([sql_parse_json("SELECT 1")]),
            schema_generate_policy(),
            schema_executor(1),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget::default());

        let error = loop_runtime
            .run(
                &mut run,
                AgentTaskKind::GenerateQuery,
                &connected_generate_context(),
            )
            .unwrap_err();

        assert!(error.to_string().contains("exact schema.search"));
        assert_eq!(run.state, AgentRunState::Failed);
    }

    #[test]
    fn connected_generate_rejects_extra_tool_after_verified_parse() {
        let mut loop_runtime = SuggestOnlyAgentLoop::with_executor(
            ScriptedGateway::new([
                schema_search_json(),
                sql_parse_json("SELECT id FROM table_0"),
                sql_parse_json("SELECT id FROM table_0"),
            ]),
            schema_generate_policy(),
            schema_executor(1),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget::default());

        let error = loop_runtime
            .run(
                &mut run,
                AgentTaskKind::GenerateQuery,
                &connected_generate_context(),
            )
            .unwrap_err();

        assert!(error.to_string().contains("exact schema.search"));
        assert_eq!(run.state, AgentRunState::Failed);
        assert_eq!(run.usage.tool_calls, 2);
    }

    #[test]
    fn connected_generate_rejects_non_read_only_parsed_draft() {
        let mut loop_runtime = SuggestOnlyAgentLoop::with_executor(
            ScriptedGateway::new([
                schema_search_json(),
                sql_parse_json("UPDATE table_0 SET id = 1"),
            ]),
            schema_generate_policy(),
            schema_executor(1),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget::default());

        let error = loop_runtime
            .run(
                &mut run,
                AgentTaskKind::GenerateQuery,
                &connected_generate_context(),
            )
            .unwrap_err();

        assert!(error.to_string().contains("one read-only statement"));
        assert_eq!(run.state, AgentRunState::Failed);
        assert_eq!(run.usage.schema_objects, 1);
    }

    #[test]
    fn connected_generate_rejects_schema_retrieval_over_run_budget() {
        let mut loop_runtime = SuggestOnlyAgentLoop::with_executor(
            ScriptedGateway::new([schema_search_json()]),
            schema_generate_policy(),
            schema_executor(2),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget {
            max_schema_objects: 1,
            ..AgentBudget::default()
        });

        let error = loop_runtime
            .run(
                &mut run,
                AgentTaskKind::GenerateQuery,
                &connected_generate_context(),
            )
            .unwrap_err();

        assert!(error.to_string().contains("schema object"));
        assert_eq!(run.state, AgentRunState::Failed);
        assert_eq!(run.usage.schema_objects, 0);
        assert!(run.evidence_refs.is_empty());
    }

    #[test]
    fn connected_generate_rejects_final_sql_that_was_not_parsed() {
        let unverified_sql = "SELECT secret FROM another_table";
        let final_response = json!({
            "type": "final",
            "title": "Done",
            "content": "draft",
            "sql": unverified_sql
        })
        .to_string();
        let mut loop_runtime = SuggestOnlyAgentLoop::with_executor(
            ScriptedGateway::new([
                schema_search_json(),
                sql_parse_json("SELECT id FROM table_0"),
                final_response,
            ]),
            schema_generate_policy(),
            schema_executor(1),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget::default());

        let error = loop_runtime
            .run(
                &mut run,
                AgentTaskKind::GenerateQuery,
                &connected_generate_context(),
            )
            .unwrap_err();

        assert!(error.to_string().contains("must match the parsed draft"));
        assert_eq!(run.state, AgentRunState::Failed);
    }

    #[test]
    fn connected_fix_rejects_final_before_schema_and_parse() {
        let mut loop_runtime = SuggestOnlyAgentLoop::with_executor(
            ScriptedGateway::new([final_sql_json("SELECT amount FROM orders")]),
            schema_generate_policy(),
            schema_executor(1),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget::default());

        let error = loop_runtime
            .run(&mut run, AgentTaskKind::FixError, &connected_fix_context())
            .unwrap_err();

        assert!(error.to_string().contains("schema.search"));
        assert!(error.to_string().contains("sql.parse"));
        assert_eq!(run.state, AgentRunState::Failed);
    }

    #[test]
    fn connected_fix_requires_metadata_capability_before_schema_dispatch() {
        let mut loop_runtime = SuggestOnlyAgentLoop::with_executor(
            ScriptedGateway::new([schema_search_json()]),
            policy(),
            schema_executor(1),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget::default());

        let error = loop_runtime
            .run(&mut run, AgentTaskKind::FixError, &connected_fix_context())
            .unwrap_err();

        assert!(error.to_string().contains("database.readMetadata"));
        assert_eq!(run.usage.tool_calls, 0);
    }

    #[test]
    fn connected_fix_clears_renderer_schema_before_first_model_turn() {
        let mut loop_runtime = SuggestOnlyAgentLoop::with_executor(
            ScriptedGateway::new([
                schema_search_json(),
                sql_parse_json("SELECT amount FROM orders"),
                final_sql_json("SELECT amount FROM orders"),
            ]),
            schema_generate_policy(),
            schema_executor(1),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget::default());

        loop_runtime
            .run(&mut run, AgentTaskKind::FixError, &connected_fix_context())
            .unwrap();

        assert!(loop_runtime.gateway.requests[0].context.schema.is_empty());
        assert!(loop_runtime.gateway.requests.iter().all(|request| {
            request.context.editor_id.is_none() && request.context.editor_version_id.is_none()
        }));
    }

    #[test]
    fn connected_fix_rejects_parse_before_schema() {
        let mut loop_runtime = SuggestOnlyAgentLoop::with_executor(
            ScriptedGateway::new([sql_parse_json("SELECT amount FROM orders")]),
            schema_generate_policy(),
            schema_executor(1),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget::default());

        let error = loop_runtime
            .run(&mut run, AgentTaskKind::FixError, &connected_fix_context())
            .unwrap_err();

        assert!(error.to_string().contains("exact schema.search"));
        assert_eq!(run.usage.tool_calls, 0);
    }

    #[test]
    fn connected_fix_rejects_non_read_only_parsed_draft() {
        let mut loop_runtime = SuggestOnlyAgentLoop::with_executor(
            ScriptedGateway::new([
                schema_search_json(),
                sql_parse_json("UPDATE orders SET amount = 0"),
            ]),
            schema_generate_policy(),
            schema_executor(1),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget::default());

        let error = loop_runtime
            .run(&mut run, AgentTaskKind::FixError, &connected_fix_context())
            .unwrap_err();

        assert!(error.to_string().contains("one read-only statement"));
        assert_eq!(run.state, AgentRunState::Failed);
    }

    #[test]
    fn connected_fix_rejects_multi_statement_parsed_draft() {
        let mut loop_runtime = SuggestOnlyAgentLoop::with_executor(
            ScriptedGateway::new([
                schema_search_json(),
                sql_parse_json("SELECT amount FROM orders; SELECT 1"),
            ]),
            schema_generate_policy(),
            schema_executor(1),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget::default());

        let error = loop_runtime
            .run(&mut run, AgentTaskKind::FixError, &connected_fix_context())
            .unwrap_err();

        assert!(error.to_string().contains("one read-only statement"));
        assert_eq!(run.state, AgentRunState::Failed);
    }

    #[test]
    fn connected_fix_rejects_extra_tool_after_verified_parse() {
        let mut loop_runtime = SuggestOnlyAgentLoop::with_executor(
            ScriptedGateway::new([
                schema_search_json(),
                sql_parse_json("SELECT amount FROM orders"),
                sql_parse_json("SELECT amount FROM orders"),
            ]),
            schema_generate_policy(),
            schema_executor(1),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget::default());

        let error = loop_runtime
            .run(&mut run, AgentTaskKind::FixError, &connected_fix_context())
            .unwrap_err();

        assert!(error.to_string().contains("exact schema.search"));
        assert_eq!(run.state, AgentRunState::Failed);
        assert_eq!(run.usage.tool_calls, 2);
    }

    #[test]
    fn connected_fix_rejects_final_sql_that_was_not_parsed() {
        let mut loop_runtime = SuggestOnlyAgentLoop::with_executor(
            ScriptedGateway::new([
                schema_search_json(),
                sql_parse_json("SELECT amount FROM orders"),
                final_sql_json("SELECT secret FROM another_table"),
            ]),
            schema_generate_policy(),
            schema_executor(1),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget::default());

        let error = loop_runtime
            .run(&mut run, AgentTaskKind::FixError, &connected_fix_context())
            .unwrap_err();

        assert!(error.to_string().contains("must match the parsed draft"));
        assert_eq!(run.state, AgentRunState::Failed);
    }

    #[test]
    fn connected_fix_schema_budget_failure_commits_no_schema_usage_or_evidence() {
        let evidence_store = Arc::new(AgentEvidenceStore::default());
        let mut loop_runtime = SuggestOnlyAgentLoop::with_executor(
            ScriptedGateway::new([schema_search_json()]),
            schema_generate_policy(),
            schema_executor(2),
            Arc::clone(&evidence_store),
        );
        let mut run = run(AgentBudget {
            max_schema_objects: 1,
            ..AgentBudget::default()
        });

        let error = loop_runtime
            .run(&mut run, AgentTaskKind::FixError, &connected_fix_context())
            .unwrap_err();

        assert!(error.to_string().contains("schema object"));
        assert_eq!(run.usage.schema_objects, 0);
        assert!(run.evidence_refs.is_empty());
        assert!(evidence_store.list_for_run(&run.run_id).is_empty());
    }

    #[test]
    fn fix_error_without_connection_rejects_renderer_schema_before_model_request() {
        let evidence_store = Arc::new(AgentEvidenceStore::default());
        let mut loop_runtime = SuggestOnlyAgentLoop::new(
            ScriptedGateway::new([final_sql_json("SELECT forged_total FROM orders")]),
            policy(),
            Arc::clone(&evidence_store),
        );
        let mut run = run(AgentBudget::default());
        let context = AgentModelContext {
            sql: Some("SELECT amunt FROM orders".to_string()),
            error_context: Some(AgentModelErrorContext {
                code: Some("no_such_column".to_string()),
                message: "no such column: amunt".to_string(),
                detail: None,
            }),
            schema: vec![AgentModelSchemaTable {
                schema: Some("forged".to_string()),
                name: "orders".to_string(),
                columns: vec!["forged_total".to_string()],
            }],
            ..AgentModelContext::default()
        };

        let error = loop_runtime
            .run(&mut run, AgentTaskKind::FixError, &context)
            .unwrap_err();

        assert!(error.to_string().contains("open connection"));
        assert!(loop_runtime.gateway.requests.is_empty());
        assert_eq!(run.state, AgentRunState::Failed);
        assert_eq!(run.usage.schema_objects, 0);
        assert_eq!(run.usage.tool_calls, 0);
        assert!(run.evidence_refs.is_empty());
        assert!(evidence_store.list_for_run(&run.run_id).is_empty());
    }

    #[test]
    fn model_request_redacts_sensitive_database_error_text() {
        let mut loop_runtime = SuggestOnlyAgentLoop::new(
            ScriptedGateway::new([final_json()]),
            policy(),
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = run(AgentBudget::default());
        let context = AgentModelContext {
            error_message: Some(
                "legacy databaseUrl=postgresql://alice:url-secret@db.internal/app".to_string(),
            ),
            error_context: Some(AgentModelErrorContext {
                code: Some("query_failed".to_string()),
                message: "no such column: totl; token=token-canary".to_string(),
                detail: Some(
                    "password=hunter2; host=db.internal; Authorization: Bearer bearer-canary"
                        .to_string(),
                ),
            }),
            ..AgentModelContext::default()
        };

        loop_runtime
            .run(&mut run, AgentTaskKind::Assistant, &context)
            .unwrap();

        let serialized = serde_json::to_string(&loop_runtime.gateway.requests[0]).unwrap();
        for secret in [
            "url-secret",
            "db.internal",
            "token-canary",
            "hunter2",
            "bearer-canary",
        ] {
            assert!(
                !serialized.contains(secret),
                "model request leaked {secret}"
            );
        }
        assert!(serialized.contains("[REDACTED]"));
        assert!(serialized.contains("no such column: totl"));
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
    fn suggest_only_progress_reports_each_non_terminal_lifecycle_state_in_order() {
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
        let mut states = Vec::new();

        loop_runtime
            .run_with_progress(
                &mut run,
                AgentTaskKind::Assistant,
                &AgentModelContext::default(),
                |snapshot| {
                    states.push(snapshot.state);
                    Ok(())
                },
            )
            .unwrap();
        states.dedup();

        assert_eq!(
            states,
            vec![
                AgentRunState::BuildingContext,
                AgentRunState::Reasoning,
                AgentRunState::AwaitingTool,
                AgentRunState::ExecutingTool,
                AgentRunState::Reasoning,
            ]
        );
        assert_eq!(run.state, AgentRunState::Completed);
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
        let executor = ScriptedExecutor {
            tools: Vec::new(),
            partial: false,
            cancellation: None,
        };
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
    fn read_only_loop_marks_tool_budget_failure_terminal() {
        let tool = || {
            json!({
                "type": "tool_call",
                "call_id": "call-execute",
                "tool": "sql.execute_readonly",
                "arguments": {
                    "connectionId": "reader",
                    "dialect": "sqlite",
                    "sql": "SELECT id FROM users"
                }
            })
            .to_string()
        };
        let mut loop_runtime = ReadOnlyAgentLoop::new(
            ScriptedGateway::new([tool(), tool()]),
            read_only_policy(),
            ScriptedExecutor {
                tools: Vec::new(),
                partial: false,
                cancellation: None,
            },
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = read_only_run(AgentBudget {
            max_tool_calls: 1,
            ..AgentBudget::default()
        });

        let error = loop_runtime
            .run(
                &mut run,
                AgentTaskKind::Assistant,
                &AgentModelContext::default(),
            )
            .unwrap_err();

        assert!(error.to_string().contains("tool call"));
        assert_eq!(run.state, AgentRunState::Failed);
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
            ScriptedExecutor {
                tools: Vec::new(),
                partial: false,
                cancellation: None,
            },
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

    #[test]
    fn read_only_loop_reports_truncated_tool_evidence_as_partial() {
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
            ScriptedGateway::new([execute, final_json()]),
            read_only_policy(),
            ScriptedExecutor {
                tools: Vec::new(),
                partial: true,
                cancellation: None,
            },
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

        assert!(result.partial);
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("truncated")));
    }

    #[test]
    fn read_only_loop_discards_tool_results_when_cancelled_during_execution() {
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
        let mut run = read_only_run(AgentBudget::default());
        let evidence_store = Arc::new(AgentEvidenceStore::default());
        let mut loop_runtime = ReadOnlyAgentLoop::new(
            ScriptedGateway::new([execute]),
            read_only_policy(),
            ScriptedExecutor {
                tools: Vec::new(),
                partial: false,
                cancellation: Some(run.cancellation_token()),
            },
            Arc::clone(&evidence_store),
        );

        let error = loop_runtime
            .run(
                &mut run,
                AgentTaskKind::Assistant,
                &AgentModelContext::default(),
            )
            .unwrap_err();

        assert!(error.to_string().contains("cancelled"));
        assert_eq!(run.state, AgentRunState::Cancelled);
        assert_eq!(run.usage.result_rows, 0);
        assert!(run.evidence_refs.is_empty());
        assert!(evidence_store.list_for_run(&run.run_id).is_empty());
    }

    #[test]
    fn read_only_explore_enforces_schema_parse_execute_inspect_sequence() {
        let sql = "SELECT date(\"created_at\"), SUM(\"amount\") FROM \"main\".\"orders\" GROUP BY date(\"created_at\")";
        let execute = json!({
            "type": "tool_call",
            "call_id": "call-execute",
            "tool": "sql.execute_readonly",
            "arguments": {
                "connectionId": "reader",
                "dialect": "sqlite",
                "sql": sql
            }
        })
        .to_string();
        let inspect = json!({
            "type": "tool_call",
            "call_id": "call-inspect",
            "tool": "result.inspect",
            "arguments": {"resultRef": "result-9"}
        })
        .to_string();
        let final_response = json!({
            "type": "final",
            "title": "Explore complete",
            "content": "Inspected bounded result evidence.",
            "sql": sql
        })
        .to_string();
        let tools = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut loop_runtime = ReadOnlyAgentLoop::new_explore(
            ScriptedGateway::new([
                explore_schema_search_json("reader", "explore data"),
                sql_parse_json(sql),
                execute,
                inspect,
                final_response,
            ]),
            read_only_explore_policy(),
            ExploreExecutor {
                tools: Arc::clone(&tools),
                inspect_result_ref: "result-9".to_string(),
            },
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = read_only_run(AgentBudget::default());
        let context = AgentModelContext {
            connection_id: Some("reader".to_string()),
            schema: vec![AgentModelSchemaTable {
                schema: Some("forged".to_string()),
                name: "forged".to_string(),
                columns: vec!["secret".to_string()],
            }],
            ..AgentModelContext::default()
        };

        let result = loop_runtime
            .run(&mut run, AgentTaskKind::Assistant, &context)
            .unwrap();

        assert_eq!(result.state, AgentRunState::Completed);
        assert_eq!(result.query_call_count, 1);
        assert_eq!(run.usage.schema_objects, 1);
        assert_eq!(result.answer.unwrap().sql.as_deref(), Some(sql));
        assert_eq!(
            *tools.lock().unwrap(),
            vec![
                AgentTool::SchemaSearch,
                AgentTool::SqlParse,
                AgentTool::SqlExecuteReadonly,
                AgentTool::ResultInspect,
            ]
        );
    }

    #[test]
    fn read_only_explore_rejects_sql_replacement_before_query_execution() {
        let parsed_sql = "SELECT amount FROM orders";
        let execute = json!({
            "type": "tool_call",
            "call_id": "call-execute",
            "tool": "sql.execute_readonly",
            "arguments": {
                "connectionId": "reader",
                "dialect": "sqlite",
                "sql": "SELECT created_at FROM orders"
            }
        })
        .to_string();
        let tools = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut loop_runtime = ReadOnlyAgentLoop::new_explore(
            ScriptedGateway::new([
                explore_schema_search_json("reader", "explore data"),
                sql_parse_json(parsed_sql),
                execute,
            ]),
            read_only_explore_policy(),
            ExploreExecutor {
                tools: Arc::clone(&tools),
                inspect_result_ref: "result-9".to_string(),
            },
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = read_only_run(AgentBudget::default());
        let context = AgentModelContext {
            connection_id: Some("reader".to_string()),
            ..AgentModelContext::default()
        };

        let error = loop_runtime
            .run(&mut run, AgentTaskKind::Assistant, &context)
            .unwrap_err();

        assert!(error.to_string().contains("parsed draft"));
        assert!(!tools
            .lock()
            .unwrap()
            .contains(&AgentTool::SqlExecuteReadonly));
        assert_eq!(run.usage.result_rows, 0);
    }

    #[test]
    fn read_only_explore_rejects_execute_connection_outside_run_scope() {
        let sql = "SELECT amount FROM orders";
        let execute = json!({
            "type": "tool_call",
            "call_id": "call-execute",
            "tool": "sql.execute_readonly",
            "arguments": {
                "connectionId": "other-reader",
                "dialect": "sqlite",
                "sql": sql
            }
        })
        .to_string();
        let tools = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut loop_runtime = ReadOnlyAgentLoop::new_explore(
            ScriptedGateway::new([
                explore_schema_search_json("reader", "explore data"),
                sql_parse_json(sql),
                execute,
            ]),
            read_only_explore_policy(),
            ExploreExecutor {
                tools: Arc::clone(&tools),
                inspect_result_ref: "result-9".to_string(),
            },
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = read_only_run(AgentBudget::default());
        let context = AgentModelContext {
            connection_id: Some("reader".to_string()),
            ..AgentModelContext::default()
        };

        let error = loop_runtime
            .run(&mut run, AgentTaskKind::Assistant, &context)
            .unwrap_err();

        assert!(error.to_string().contains("run connection"));
        assert!(!tools
            .lock()
            .unwrap()
            .contains(&AgentTool::SqlExecuteReadonly));
        assert_eq!(run.usage.result_rows, 0);
    }

    #[test]
    fn read_only_explore_rejects_schema_search_outside_run_scope() {
        let tools = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut loop_runtime = ReadOnlyAgentLoop::new_explore(
            ScriptedGateway::new([explore_schema_search_json("other-reader", "other goal")]),
            read_only_explore_policy(),
            ExploreExecutor {
                tools: Arc::clone(&tools),
                inspect_result_ref: "result-9".to_string(),
            },
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = read_only_run(AgentBudget::default());
        let context = AgentModelContext {
            connection_id: Some("reader".to_string()),
            ..AgentModelContext::default()
        };

        let error = loop_runtime
            .run(&mut run, AgentTaskKind::Assistant, &context)
            .unwrap_err();

        assert!(error.to_string().contains("run goal and connection"));
        assert!(tools.lock().unwrap().is_empty());
        assert_eq!(run.usage.schema_objects, 0);
    }

    #[test]
    fn read_only_explore_rejects_missing_schema_evidence_without_committing_usage() {
        let tools = Arc::new(std::sync::Mutex::new(Vec::new()));
        let evidence_store = Arc::new(AgentEvidenceStore::default());
        let mut loop_runtime = ReadOnlyAgentLoop::new_explore(
            ScriptedGateway::new([explore_schema_search_json("reader", "explore data")]),
            read_only_explore_policy(),
            MissingEvidenceExploreExecutor {
                inner: ExploreExecutor {
                    tools,
                    inspect_result_ref: "result-9".to_string(),
                },
                missing_for: AgentTool::SchemaSearch,
            },
            Arc::clone(&evidence_store),
        );
        let mut run = read_only_run(AgentBudget::default());
        let context = AgentModelContext {
            connection_id: Some("reader".to_string()),
            ..AgentModelContext::default()
        };

        let error = loop_runtime
            .run(&mut run, AgentTaskKind::Assistant, &context)
            .unwrap_err();

        assert!(error.to_string().contains("Schema evidence"));
        assert_eq!(run.usage.schema_objects, 0);
        assert!(run.evidence_refs.is_empty());
        assert!(evidence_store.list_for_run(&run.run_id).is_empty());
    }

    #[test]
    fn read_only_explore_does_not_execute_after_gateway_cancellation() {
        let tools = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut run = read_only_run(AgentBudget::default());
        let mut gateway =
            ScriptedGateway::new([explore_schema_search_json("reader", "explore data")]);
        gateway.cancel_on_first_request = true;
        gateway.cancellation = Some(run.cancellation_token());
        let mut loop_runtime = ReadOnlyAgentLoop::new_explore(
            gateway,
            read_only_explore_policy(),
            ExploreExecutor {
                tools: Arc::clone(&tools),
                inspect_result_ref: "result-9".to_string(),
            },
            Arc::new(AgentEvidenceStore::default()),
        );
        let context = AgentModelContext {
            connection_id: Some("reader".to_string()),
            ..AgentModelContext::default()
        };

        let error = loop_runtime
            .run(&mut run, AgentTaskKind::Assistant, &context)
            .unwrap_err();

        assert!(error.to_string().contains("cancelled"));
        assert_eq!(run.state, AgentRunState::Cancelled);
        assert_eq!(run.usage.model_turns, 0);
        assert!(tools.lock().unwrap().is_empty());
    }

    #[test]
    fn read_only_explore_rejects_inspect_result_handle_mismatch() {
        let sql = "SELECT amount FROM orders";
        let execute = json!({
            "type": "tool_call",
            "call_id": "call-execute",
            "tool": "sql.execute_readonly",
            "arguments": {
                "connectionId": "reader",
                "dialect": "sqlite",
                "sql": sql
            }
        })
        .to_string();
        let inspect = json!({
            "type": "tool_call",
            "call_id": "call-inspect",
            "tool": "result.inspect",
            "arguments": {"resultRef": "result-9"}
        })
        .to_string();
        let tools = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut loop_runtime = ReadOnlyAgentLoop::new_explore(
            ScriptedGateway::new([
                explore_schema_search_json("reader", "explore data"),
                sql_parse_json(sql),
                execute,
                inspect,
            ]),
            read_only_explore_policy(),
            ExploreExecutor {
                tools,
                inspect_result_ref: "result-other".to_string(),
            },
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = read_only_run(AgentBudget::default());
        let context = AgentModelContext {
            connection_id: Some("reader".to_string()),
            ..AgentModelContext::default()
        };

        let error = loop_runtime
            .run(&mut run, AgentTaskKind::Assistant, &context)
            .unwrap_err();

        assert!(error.to_string().contains("result reference"));
        assert_eq!(run.usage.result_rows, 3);
        assert_eq!(run.evidence_refs.len(), 4);
    }
}
