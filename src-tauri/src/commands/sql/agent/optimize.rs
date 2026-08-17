//! Deterministic, evidence-bound `SQLite` query optimization workflow.

#![allow(dead_code)]

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Instant;

use serde_json::json;

use super::super::dialect::SqlDialect;
use super::super::sql_analysis::{analyze_sql, SqlTableRef, StatementRisk};
use super::super::types::SqlCommandError;
use super::domain::{AgentMode, AgentRun, AgentRunState, AgentTaskKind, AgentToolCall, AgentTurn};
use super::evidence::{
    AgentEvidenceInput, AgentEvidenceKind, AgentEvidenceSensitivity, AgentEvidenceStore,
};
use super::index_context::IndexListResult;
use super::model::{
    parse_model_response, AgentFinalResponse, AgentModelContext, AgentModelGateway,
    AgentModelRequest, AgentModelResponse,
};
use super::plan::{
    compare_sqlite_plans, SqlitePlanComparison, SqlitePlanComparisonVerdict, SqlitePlanSnapshot,
    SqlitePlanUncertaintyReason,
};
use super::policy::{AgentAuthorizedTool, AgentPolicy, AgentTool};
use super::runtime::{
    AgentLoopResult, AgentOptimizeEvidence, AgentToolExecution, ReadOnlyAgentToolExecutor,
};

const OPTIMIZE_SEQUENCE_ERROR: &str = "Optimize requires the exact sql.parse(original), index.list, sql.explain(original), sql.parse(rewrite), sql.explain(rewrite), final sequence";

#[derive(Debug, Clone, PartialEq, Eq)]
struct OptimizeBinding {
    connection_id: String,
    original_sql: String,
    tables: Vec<SqlTableRef>,
}

#[derive(Debug, Clone)]
enum OptimizeVerification {
    AwaitingOriginalAnalysis {
        connection_id: String,
        original_sql: String,
    },
    AwaitingIndexes {
        binding: OptimizeBinding,
    },
    AwaitingOriginalPlan {
        binding: OptimizeBinding,
        index_revision: Option<u64>,
    },
    AwaitingRewriteAnalysis {
        binding: OptimizeBinding,
        original_plan: SqlitePlanSnapshot,
        index_metadata_available: bool,
    },
    AwaitingRewrittenPlan {
        binding: OptimizeBinding,
        original_plan: SqlitePlanSnapshot,
        rewritten_sql: String,
        index_metadata_available: bool,
    },
    Complete {
        rewritten_sql: String,
        comparison: SqlitePlanComparison,
        index_metadata_available: bool,
    },
}

#[derive(Clone)]
struct OptimizeLoopOutput {
    model_context: AgentModelContext,
    evidence_refs: Vec<String>,
    warnings: Vec<String>,
    query_call_count: usize,
    partial: bool,
    verification: OptimizeVerification,
}

pub struct OptimizeAgentLoop<G, E> {
    gateway: G,
    policy: AgentPolicy,
    executor: E,
    evidence_store: Arc<AgentEvidenceStore>,
}

impl<G: AgentModelGateway, E: ReadOnlyAgentToolExecutor> OptimizeAgentLoop<G, E> {
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
            Err(error) => fail_optimize_run(run, error),
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
        let mut output = start_optimize_run(run, task, context, on_progress)?;
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
                    return complete_optimize_run(run, &answer, output);
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
        output: &mut OptimizeLoopOutput,
        on_progress: &mut F,
    ) -> Result<(), SqlCommandError>
    where
        F: FnMut(&AgentRun) -> Result<(), SqlCommandError>,
    {
        run.transition(AgentRunState::AwaitingTool)?;
        let authorized = authorize_optimize_call(&self.policy, &call)?;
        validate_optimize_tool_order(&authorized, &output.verification)?;
        run.record_tool_call(call)?;
        on_progress(run)?;
        run.transition(AgentRunState::ExecutingTool)?;
        on_progress(run)?;
        let execution = self.executor.execute(&authorized, &output.model_context)?;
        run.check_budget(Instant::now())?;

        validate_no_result_rows(&execution)?;
        let mut next_output = output.clone();
        let comparison_evidence =
            advance_optimize_verification(&authorized, &execution, &mut next_output)?;
        let mut next_usage = run.usage;
        next_usage.record_result(0, execution.result_bytes, &run.budget)?;
        next_output.query_call_count = next_output
            .query_call_count
            .checked_add(execution.query_call_count)
            .ok_or_else(|| SqlCommandError::new("internal", "Optimize query count overflow"))?;
        next_output.partial |= execution.partial;
        next_output.warnings.extend(execution.warnings);

        let mut evidence = execution.evidence;
        if let Some(comparison) = comparison_evidence {
            evidence.push(comparison);
        }
        let appended = self.evidence_store.append_batch(&run.run_id, evidence)?;
        for evidence_ref in appended {
            run.attach_evidence(&evidence_ref.evidence_id)?;
            next_output.evidence_refs.push(evidence_ref.evidence_id);
        }
        run.usage = next_usage;
        *output = next_output;
        run.transition(AgentRunState::Reasoning)?;
        on_progress(run)
    }
}

fn start_optimize_run<F>(
    run: &mut AgentRun,
    task: AgentTaskKind,
    context: &AgentModelContext,
    on_progress: &mut F,
) -> Result<OptimizeLoopOutput, SqlCommandError>
where
    F: FnMut(&AgentRun) -> Result<(), SqlCommandError>,
{
    if task != AgentTaskKind::OptimizeQuery || run.mode != AgentMode::ReadOnly {
        return Err(SqlCommandError::new(
            "invalid_input",
            "Optimize requires the Optimize Query task in Read Only mode",
        ));
    }
    if run.state != AgentRunState::Created {
        return Err(SqlCommandError::new(
            "invalid_input",
            "Agent loop requires a newly created run",
        ));
    }
    if context.dialect != SqlDialect::Sqlite {
        return Err(SqlCommandError::new(
            "validation",
            "Optimize supports Stable SQLite only",
        ));
    }
    let connection_id = valid_text(context.connection_id.as_deref(), "connection id")?;
    let original_sql = context
        .selected_sql
        .as_deref()
        .filter(|sql| !sql.trim().is_empty())
        .or(context.sql.as_deref())
        .and_then(|sql| {
            let sql = sql.trim();
            (!sql.is_empty() && !sql.contains('\0')).then_some(sql)
        })
        .ok_or_else(|| SqlCommandError::new("invalid_input", "Optimize requires SQL"))?;

    run.transition(AgentRunState::BuildingContext)?;
    on_progress(run)?;
    let mut model_context = context.redacted_for_model();
    model_context.connection_id = Some(connection_id.to_string());
    model_context.sql = Some(original_sql.to_string());
    model_context.selected_sql = None;
    model_context.schema.clear();
    model_context.relation_context = None;
    model_context.result_shape = None;
    model_context.result_ref = None;
    model_context.explain_plan = None;
    run.check_budget(Instant::now())?;
    run.transition(AgentRunState::Reasoning)?;
    on_progress(run)?;
    Ok(OptimizeLoopOutput {
        model_context,
        evidence_refs: Vec::new(),
        warnings: Vec::new(),
        query_call_count: 0,
        partial: false,
        verification: OptimizeVerification::AwaitingOriginalAnalysis {
            connection_id: connection_id.to_string(),
            original_sql: original_sql.to_string(),
        },
    })
}

fn authorize_optimize_call(
    policy: &AgentPolicy,
    call: &AgentToolCall,
) -> Result<AgentAuthorizedTool, SqlCommandError> {
    match AgentTool::parse(&call.tool)? {
        AgentTool::SqlParse | AgentTool::IndexList => policy.authorize(call),
        AgentTool::SqlExplain => policy.authorize_read_only(call),
        tool => Err(SqlCommandError::new(
            "validation",
            format!("Agent tool '{}' is not part of Optimize", tool.wire_name()),
        )),
    }
}

fn validate_optimize_tool_order(
    authorized: &AgentAuthorizedTool,
    verification: &OptimizeVerification,
) -> Result<(), SqlCommandError> {
    match verification {
        OptimizeVerification::AwaitingOriginalAnalysis { original_sql, .. } => {
            require_exact_sql_call(authorized, AgentTool::SqlParse, original_sql)
        }
        OptimizeVerification::AwaitingIndexes { binding } => {
            if authorized.tool != AgentTool::IndexList
                || authorized.arguments != index_arguments(binding)
            {
                return Err(optimize_sequence_error());
            }
            Ok(())
        }
        OptimizeVerification::AwaitingOriginalPlan { binding, .. } => {
            require_exact_explain_call(authorized, binding, &binding.original_sql)
        }
        OptimizeVerification::AwaitingRewriteAnalysis { .. } => {
            if authorized.tool != AgentTool::SqlParse
                || authorized
                    .arguments
                    .as_object()
                    .is_none_or(|value| value.len() != 1)
                || authorized
                    .arguments
                    .get("sql")
                    .and_then(serde_json::Value::as_str)
                    .is_none_or(|sql| sql.trim().is_empty() || sql.contains('\0'))
            {
                return Err(optimize_sequence_error());
            }
            Ok(())
        }
        OptimizeVerification::AwaitingRewrittenPlan {
            binding,
            rewritten_sql,
            ..
        } => require_exact_explain_call(authorized, binding, rewritten_sql),
        OptimizeVerification::Complete { .. } => Err(optimize_sequence_error()),
    }
}

fn require_exact_sql_call(
    authorized: &AgentAuthorizedTool,
    expected_tool: AgentTool,
    sql: &str,
) -> Result<(), SqlCommandError> {
    if authorized.tool != expected_tool || authorized.arguments != json!({"sql": sql}) {
        return Err(optimize_sequence_error());
    }
    Ok(())
}

fn require_exact_explain_call(
    authorized: &AgentAuthorizedTool,
    binding: &OptimizeBinding,
    sql: &str,
) -> Result<(), SqlCommandError> {
    if authorized.tool != AgentTool::SqlExplain
        || authorized.arguments
            != json!({
                "connectionId": binding.connection_id,
                "dialect": "sqlite",
                "sql": sql,
            })
    {
        return Err(optimize_sequence_error());
    }
    Ok(())
}

fn index_arguments(binding: &OptimizeBinding) -> serde_json::Value {
    json!({
        "connectionId": binding.connection_id,
        "dialect": "sqlite",
        "schema": "main",
        "tables": binding.tables.iter().map(|table| json!({
            "schema": table.schema.as_deref().unwrap_or("main"),
            "name": table.name,
        })).collect::<Vec<_>>(),
    })
}

fn advance_optimize_verification(
    authorized: &AgentAuthorizedTool,
    execution: &AgentToolExecution,
    output: &mut OptimizeLoopOutput,
) -> Result<Option<AgentEvidenceInput>, SqlCommandError> {
    match output.verification.clone() {
        OptimizeVerification::AwaitingOriginalAnalysis {
            connection_id,
            original_sql,
        } => {
            output.verification =
                advance_original_analysis(connection_id, original_sql, execution)?;
            Ok(None)
        }
        OptimizeVerification::AwaitingIndexes { binding } => {
            output.verification = advance_indexes(binding, execution)?;
            Ok(None)
        }
        OptimizeVerification::AwaitingOriginalPlan {
            binding,
            index_revision,
        } => {
            output.verification = advance_original_plan(binding, index_revision, execution)?;
            Ok(None)
        }
        OptimizeVerification::AwaitingRewriteAnalysis {
            binding,
            original_plan,
            index_metadata_available,
        } => {
            output.verification = advance_rewrite_analysis(
                binding,
                original_plan,
                index_metadata_available,
                authorized,
                execution,
            )?;
            Ok(None)
        }
        OptimizeVerification::AwaitingRewrittenPlan {
            binding,
            original_plan,
            rewritten_sql,
            index_metadata_available,
        } => {
            let (verification, evidence) = advance_rewritten_plan(
                &binding,
                &original_plan,
                rewritten_sql,
                index_metadata_available,
                execution,
            )?;
            output.verification = verification;
            Ok(Some(evidence))
        }
        OptimizeVerification::Complete { .. } => Err(optimize_sequence_error()),
    }
}

fn advance_original_analysis(
    connection_id: String,
    original_sql: String,
    execution: &AgentToolExecution,
) -> Result<OptimizeVerification, SqlCommandError> {
    require_evidence(execution, AgentEvidenceKind::Analysis, "analysis")?;
    require_query_count(execution, 0, "sql.parse")?;
    let analysis = execution.analysis.as_ref().ok_or_else(|| {
        SqlCommandError::new("internal", "sql.parse did not return typed analysis")
    })?;
    let expected = analyze_sql(&original_sql, SqlDialect::Sqlite);
    if analysis != &expected
        || analysis.statement_count != 1
        || analysis.risk != StatementRisk::ReadOnly
    {
        return Err(SqlCommandError::new(
            "validation",
            "Optimize original SQL must be one parsed read-only SQLite statement",
        ));
    }
    let tables = normalized_main_tables(&analysis.referenced_tables)?;
    if tables.is_empty() {
        return Err(SqlCommandError::new(
            "validation",
            "Optimize requires at least one statically referenced SQLite table",
        ));
    }
    Ok(OptimizeVerification::AwaitingIndexes {
        binding: OptimizeBinding {
            connection_id,
            original_sql,
            tables,
        },
    })
}

fn advance_indexes(
    binding: OptimizeBinding,
    execution: &AgentToolExecution,
) -> Result<OptimizeVerification, SqlCommandError> {
    require_evidence(execution, AgentEvidenceKind::Index, "index")?;
    require_query_count(execution, 0, "index.list")?;
    let index_revision = validate_index_context(execution.index_context.as_ref(), &binding)?;
    if index_revision.is_none() && execution.warnings.is_empty() {
        return Err(SqlCommandError::new(
            "internal",
            "index.list did not return typed capability or an unsupported warning",
        ));
    }
    Ok(OptimizeVerification::AwaitingOriginalPlan {
        binding,
        index_revision,
    })
}

fn advance_original_plan(
    binding: OptimizeBinding,
    index_revision: Option<u64>,
    execution: &AgentToolExecution,
) -> Result<OptimizeVerification, SqlCommandError> {
    require_evidence(execution, AgentEvidenceKind::Plan, "original plan")?;
    require_query_count(execution, 1, "sql.explain")?;
    let original_plan = require_plan(execution, &binding.connection_id)?;
    if index_revision.is_some_and(|revision| original_plan.identity.metadata_revision != revision) {
        return Err(SqlCommandError::new(
            "validation",
            "SQLite metadata revision changed between index and original plan evidence",
        ));
    }
    Ok(OptimizeVerification::AwaitingRewriteAnalysis {
        binding,
        original_plan,
        index_metadata_available: index_revision.is_some(),
    })
}

fn advance_rewrite_analysis(
    binding: OptimizeBinding,
    original_plan: SqlitePlanSnapshot,
    index_metadata_available: bool,
    authorized: &AgentAuthorizedTool,
    execution: &AgentToolExecution,
) -> Result<OptimizeVerification, SqlCommandError> {
    require_evidence(execution, AgentEvidenceKind::Analysis, "rewrite analysis")?;
    require_query_count(execution, 0, "sql.parse")?;
    let rewritten_sql = authorized.arguments["sql"]
        .as_str()
        .ok_or_else(optimize_sequence_error)?
        .to_string();
    let analysis = execution.analysis.as_ref().ok_or_else(|| {
        SqlCommandError::new(
            "internal",
            "rewrite sql.parse did not return typed analysis",
        )
    })?;
    if analysis != &analyze_sql(&rewritten_sql, SqlDialect::Sqlite)
        || analysis.statement_count != 1
        || analysis.risk != StatementRisk::ReadOnly
    {
        return Err(SqlCommandError::new(
            "validation",
            "Optimize rewrite must be one parsed read-only SQLite statement",
        ));
    }
    if normalized_main_tables(&analysis.referenced_tables)? != binding.tables {
        return Err(SqlCommandError::new(
            "validation",
            "Optimize rewrite must preserve the statically referenced table set",
        ));
    }
    Ok(OptimizeVerification::AwaitingRewrittenPlan {
        binding,
        original_plan,
        rewritten_sql,
        index_metadata_available,
    })
}

fn advance_rewritten_plan(
    binding: &OptimizeBinding,
    original_plan: &SqlitePlanSnapshot,
    rewritten_sql: String,
    index_metadata_available: bool,
    execution: &AgentToolExecution,
) -> Result<(OptimizeVerification, AgentEvidenceInput), SqlCommandError> {
    require_evidence(execution, AgentEvidenceKind::Plan, "rewritten plan")?;
    require_query_count(execution, 1, "sql.explain")?;
    let rewritten_plan = require_plan(execution, &binding.connection_id)?;
    let mut comparison = compare_sqlite_plans(Some(original_plan), Some(&rewritten_plan));
    if !index_metadata_available && comparison.verdict != SqlitePlanComparisonVerdict::Uncertain {
        comparison.verdict = SqlitePlanComparisonVerdict::Uncertain;
        comparison.uncertainty_reason = Some(SqlitePlanUncertaintyReason::IndexMetadataUnavailable);
    }
    let comparison_evidence = (
        AgentEvidenceKind::Plan,
        AgentEvidenceSensitivity::Workspace,
        json!({
            "tool": "plan.compare",
            "indexMetadataAvailable": index_metadata_available,
            "comparison": &comparison,
        }),
    );
    Ok((
        OptimizeVerification::Complete {
            rewritten_sql,
            comparison,
            index_metadata_available,
        },
        comparison_evidence,
    ))
}

fn validate_no_result_rows(execution: &AgentToolExecution) -> Result<(), SqlCommandError> {
    if execution.result_rows != 0
        || execution.result_ref.is_some()
        || execution.result_shape.is_some()
        || execution.evidence.iter().any(|(kind, _, _)| {
            matches!(
                kind,
                AgentEvidenceKind::ResultShape
                    | AgentEvidenceKind::Aggregate
                    | AgentEvidenceKind::ResultSample
            )
        })
    {
        return Err(SqlCommandError::new(
            "internal",
            "Optimize tools must not return query result rows or result evidence",
        ));
    }
    Ok(())
}

fn require_evidence(
    execution: &AgentToolExecution,
    kind: AgentEvidenceKind,
    label: &str,
) -> Result<(), SqlCommandError> {
    if execution
        .evidence
        .iter()
        .any(|(candidate, _, _)| *candidate == kind)
    {
        Ok(())
    } else {
        Err(SqlCommandError::new(
            "internal",
            format!("Optimize {label} stage did not return typed evidence"),
        ))
    }
}

fn require_query_count(
    execution: &AgentToolExecution,
    expected: usize,
    tool: &str,
) -> Result<(), SqlCommandError> {
    if execution.query_call_count == expected {
        Ok(())
    } else {
        Err(SqlCommandError::new(
            "internal",
            format!("Optimize {tool} reported an invalid query-call count"),
        ))
    }
}

fn validate_index_context(
    indexes: Option<&IndexListResult>,
    binding: &OptimizeBinding,
) -> Result<Option<u64>, SqlCommandError> {
    let Some(indexes) = indexes else {
        return Ok(None);
    };
    if indexes.connection_id != binding.connection_id
        || indexes.schema != "main"
        || indexes.dialect != SqlDialect::Sqlite
        || indexes.metadata_revision == 0
        || indexes
            .indexes
            .iter()
            .any(|index| index.metadata_revision != indexes.metadata_revision)
    {
        return Err(SqlCommandError::new(
            "validation",
            "Optimize index evidence identity does not match the run",
        ));
    }
    let expected = binding
        .tables
        .iter()
        .map(|table| table.name.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    if indexes.indexes.iter().any(|index| {
        index.schema != "main" || !expected.contains(&index.table.to_ascii_lowercase())
    }) {
        return Err(SqlCommandError::new(
            "validation",
            "Optimize index evidence contains a table outside the original query",
        ));
    }
    Ok(Some(indexes.metadata_revision))
}

fn require_plan(
    execution: &AgentToolExecution,
    connection_id: &str,
) -> Result<SqlitePlanSnapshot, SqlCommandError> {
    let plan = execution.normalized_plan.clone().ok_or_else(|| {
        SqlCommandError::new(
            "internal",
            "sql.explain did not return a normalized SQLite plan",
        )
    })?;
    if plan.identity.connection_id != connection_id || plan.identity.dialect != SqlDialect::Sqlite {
        return Err(SqlCommandError::new(
            "validation",
            "Optimize plan evidence identity does not match the run",
        ));
    }
    Ok(plan)
}

fn normalized_main_tables(tables: &[SqlTableRef]) -> Result<Vec<SqlTableRef>, SqlCommandError> {
    let mut identities = BTreeSet::new();
    for table in tables {
        let schema = table.schema.as_deref().unwrap_or("main");
        if !schema.eq_ignore_ascii_case("main")
            || table.name.trim().is_empty()
            || table.name.contains('\0')
        {
            return Err(SqlCommandError::new(
                "validation",
                "Optimize supports statically referenced tables in SQLite main only",
            ));
        }
        identities.insert(table.name.to_ascii_lowercase());
    }
    Ok(identities
        .into_iter()
        .map(|name| SqlTableRef {
            schema: Some("main".to_string()),
            name,
        })
        .collect())
}

fn complete_optimize_run(
    run: &mut AgentRun,
    answer: &AgentFinalResponse,
    output: OptimizeLoopOutput,
) -> Result<AgentLoopResult, SqlCommandError> {
    let OptimizeVerification::Complete {
        rewritten_sql,
        comparison,
        index_metadata_available,
    } = output.verification
    else {
        return Err(optimize_sequence_error());
    };
    if answer.sql.as_deref() != Some(rewritten_sql.as_str()) {
        return Err(SqlCommandError::new(
            "validation",
            "Optimize final SQL must match the parsed and explained rewrite",
        ));
    }
    if output.query_call_count != 2 {
        return Err(SqlCommandError::new(
            "internal",
            "Optimize must complete with exactly two explain query calls",
        ));
    }
    let grounded_answer = AgentFinalResponse {
        title: "AI Optimize Query".to_string(),
        content: grounded_comparison_content(&comparison, index_metadata_available),
        sql: Some(rewritten_sql),
    };
    let optimize_evidence = AgentOptimizeEvidence {
        index_metadata_available,
        comparison,
        semantics_verified: false,
    };
    run.transition(AgentRunState::Completed)?;
    Ok(AgentLoopResult {
        run_id: run.run_id.clone(),
        state: run.state,
        answer: Some(grounded_answer),
        evidence_refs: output.evidence_refs,
        optimize_evidence: Some(optimize_evidence),
        warnings: output.warnings,
        partial: output.partial,
        query_call_count: output.query_call_count,
    })
}

fn grounded_comparison_content(
    comparison: &SqlitePlanComparison,
    index_metadata_available: bool,
) -> String {
    if !index_metadata_available {
        return "Index metadata was unavailable, so the optimization assessment is uncertain. Query semantics were not verified; review the draft before running it. Runtime performance was not measured and remains unverified."
				.to_string();
    }
    let verdict = match comparison.verdict {
        SqlitePlanComparisonVerdict::StructurallyImproved => "structurally improved",
        SqlitePlanComparisonVerdict::Equivalent => "structurally equivalent",
        SqlitePlanComparisonVerdict::StructurallyRegressed => "structurally regressed",
        SqlitePlanComparisonVerdict::Uncertain => "structurally uncertain",
    };
    format!(
			"The normalized SQLite plan is {verdict}. Query semantics were not verified; review the draft before running it. Runtime performance was not measured and remains unverified."
		)
}

fn valid_text<'a>(value: Option<&'a str>, label: &str) -> Result<&'a str, SqlCommandError> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.contains('\0'))
        .ok_or_else(|| {
            SqlCommandError::new(
                "invalid_input",
                format!("Optimize requires a valid {label}"),
            )
        })
}

fn optimize_sequence_error() -> SqlCommandError {
    SqlCommandError::new("validation", OPTIMIZE_SEQUENCE_ERROR)
}

fn fail_optimize_run<T>(run: &mut AgentRun, error: SqlCommandError) -> Result<T, SqlCommandError> {
    if !run.state.is_terminal() {
        if run.cancellation_token().is_cancelled() {
            let _ = run.transition(AgentRunState::Cancelled);
        } else {
            run.mark_failed();
        }
    }
    Err(error)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeterministicOptimizeStep {
    ParseOriginal,
    ListIndexes,
    ExplainOriginal,
    ParseRewrite,
    ExplainRewrite,
    Final,
}

#[derive(Debug, Clone)]
pub struct DeterministicOptimizeAgentModelGateway {
    step: DeterministicOptimizeStep,
    rewritten_sql: Option<String>,
}

impl Default for DeterministicOptimizeAgentModelGateway {
    fn default() -> Self {
        Self {
            step: DeterministicOptimizeStep::ParseOriginal,
            rewritten_sql: None,
        }
    }
}

impl AgentModelGateway for DeterministicOptimizeAgentModelGateway {
    fn generate(&mut self, request: &AgentModelRequest) -> Result<String, SqlCommandError> {
        if request.task != AgentTaskKind::OptimizeQuery {
            return Err(SqlCommandError::new(
                "invalid_input",
                "Optimize gateway only accepts Optimize Query tasks",
            ));
        }
        let connection_id = valid_text(request.context.connection_id.as_deref(), "connection id")?;
        let original_sql = valid_text(request.context.sql.as_deref(), "SQL")?;
        let response = match self.step {
            DeterministicOptimizeStep::ParseOriginal => {
                self.step = DeterministicOptimizeStep::ListIndexes;
                json!({
                    "type": "tool_call",
                    "call_id": "optimize-parse-original",
                    "tool": "sql.parse",
                    "arguments": {"sql": original_sql},
                })
            }
            DeterministicOptimizeStep::ListIndexes => {
                let analysis = analyze_sql(original_sql, SqlDialect::Sqlite);
                let tables = normalized_main_tables(&analysis.referenced_tables)?;
                if tables.is_empty() {
                    return Err(SqlCommandError::new(
                        "validation",
                        "Optimize requires at least one statically referenced SQLite table",
                    ));
                }
                self.step = DeterministicOptimizeStep::ExplainOriginal;
                json!({
                    "type": "tool_call",
                    "call_id": "optimize-indexes",
                    "tool": "index.list",
                    "arguments": {
                        "connectionId": connection_id,
                        "dialect": "sqlite",
                        "schema": "main",
                        "tables": tables,
                    },
                })
            }
            DeterministicOptimizeStep::ExplainOriginal => {
                self.step = DeterministicOptimizeStep::ParseRewrite;
                json!({
                    "type": "tool_call",
                    "call_id": "optimize-explain-original",
                    "tool": "sql.explain",
                    "arguments": {
                        "connectionId": connection_id,
                        "dialect": "sqlite",
                        "sql": original_sql,
                    },
                })
            }
            DeterministicOptimizeStep::ParseRewrite => {
                let rewritten_sql = original_sql.to_string();
                self.rewritten_sql = Some(rewritten_sql.clone());
                self.step = DeterministicOptimizeStep::ExplainRewrite;
                json!({
                    "type": "tool_call",
                    "call_id": "optimize-parse-rewrite",
                    "tool": "sql.parse",
                    "arguments": {"sql": rewritten_sql},
                })
            }
            DeterministicOptimizeStep::ExplainRewrite => {
                let rewritten_sql = self.rewritten_sql.as_deref().ok_or_else(|| {
                    SqlCommandError::new("internal", "Optimize rewrite was not prepared")
                })?;
                self.step = DeterministicOptimizeStep::Final;
                json!({
                    "type": "tool_call",
                    "call_id": "optimize-explain-rewrite",
                    "tool": "sql.explain",
                    "arguments": {
                        "connectionId": connection_id,
                        "dialect": "sqlite",
                        "sql": rewritten_sql,
                    },
                })
            }
            DeterministicOptimizeStep::Final => {
                let rewritten_sql = self.rewritten_sql.as_deref().ok_or_else(|| {
                    SqlCommandError::new("internal", "Optimize rewrite was not prepared")
                })?;
                json!({
                    "type": "final",
                    "title": "AI Optimize Query",
                    "content": "Typed plan comparison is ready for backend verification.",
                    "sql": rewritten_sql,
                })
            }
        };
        serde_json::to_string(&response)
            .map_err(|error| SqlCommandError::new("internal", error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::super::super::dialect::SqlDialect;
    use super::super::super::sql_analysis::analyze_sql;
    use super::super::super::types::SqlCommandError;
    use super::super::domain::{
        AgentBudget, AgentCancellationToken, AgentMode, AgentRun, AgentRunState, AgentTaskKind,
    };
    use super::super::evidence::{AgentEvidenceKind, AgentEvidenceSensitivity, AgentEvidenceStore};
    use super::super::index_context::{
        IndexContextColumn, IndexContextColumnKind, IndexContextEntry, IndexContextOrigin,
        IndexListResult,
    };
    use super::super::model::{AgentModelContext, AgentModelGateway, AgentModelRequest};
    use super::super::plan::{
        SqliteIndexSource, SqlitePlanIdentity, SqlitePlanLoopRole, SqlitePlanNode,
        SqlitePlanOperation, SqlitePlanSnapshot, SqliteScanAccess,
    };
    use super::super::policy::{
        AgentAuthorizedTool, AgentCapability, AgentCapabilitySet, AgentPolicy, AgentTool,
    };
    use super::super::runtime::{AgentToolExecution, ReadOnlyAgentToolExecutor};
    use super::*;

    const ORIGINAL_SQL: &str = "SELECT email FROM users";
    const REWRITTEN_SQL: &str = "SELECT email FROM users INDEXED BY idx_users_email";

    struct ScriptedGateway {
        responses: VecDeque<String>,
    }

    impl ScriptedGateway {
        fn new(responses: impl IntoIterator<Item = String>) -> Self {
            Self {
                responses: responses.into_iter().collect(),
            }
        }
    }

    impl AgentModelGateway for ScriptedGateway {
        fn generate(&mut self, _request: &AgentModelRequest) -> Result<String, SqlCommandError> {
            self.responses.pop_front().ok_or_else(|| {
                SqlCommandError::new("invalid_input", "scripted model has no response")
            })
        }
    }

    struct ScriptedOptimizeExecutor {
        tools: Arc<Mutex<Vec<AgentTool>>>,
    }

    struct MissingIndexOptimizeExecutor {
        inner: ScriptedOptimizeExecutor,
    }

    struct IncomparablePlanOptimizeExecutor {
        inner: ScriptedOptimizeExecutor,
    }

    struct MissingIndexIncomparablePlanOptimizeExecutor {
        inner: ScriptedOptimizeExecutor,
    }

    struct CancellingOptimizeExecutor {
        inner: ScriptedOptimizeExecutor,
        cancellation: AgentCancellationToken,
    }

    impl ReadOnlyAgentToolExecutor for MissingIndexOptimizeExecutor {
        fn execute(
            &mut self,
            authorized: &AgentAuthorizedTool,
            context: &AgentModelContext,
        ) -> Result<AgentToolExecution, SqlCommandError> {
            let mut execution = self.inner.execute(authorized, context)?;
            if authorized.tool == AgentTool::IndexList {
                execution.index_context = None;
                execution
                    .warnings
                    .push("Index metadata capability is unavailable.".to_string());
            }
            Ok(execution)
        }
    }

    impl ReadOnlyAgentToolExecutor for IncomparablePlanOptimizeExecutor {
        fn execute(
            &mut self,
            authorized: &AgentAuthorizedTool,
            context: &AgentModelContext,
        ) -> Result<AgentToolExecution, SqlCommandError> {
            let mut execution = self.inner.execute(authorized, context)?;
            if authorized.tool == AgentTool::SqlExplain
                && authorized.arguments["sql"] == REWRITTEN_SQL
            {
                execution
                    .normalized_plan
                    .as_mut()
                    .expect("rewritten normalized plan")
                    .identity
                    .metadata_revision = 8;
            }
            Ok(execution)
        }
    }

    impl ReadOnlyAgentToolExecutor for MissingIndexIncomparablePlanOptimizeExecutor {
        fn execute(
            &mut self,
            authorized: &AgentAuthorizedTool,
            context: &AgentModelContext,
        ) -> Result<AgentToolExecution, SqlCommandError> {
            let mut execution = self.inner.execute(authorized, context)?;
            if authorized.tool == AgentTool::IndexList {
                execution.index_context = None;
                execution
                    .warnings
                    .push("Index metadata capability is unavailable.".to_string());
            }
            if authorized.tool == AgentTool::SqlExplain
                && authorized.arguments["sql"] == REWRITTEN_SQL
            {
                execution
                    .normalized_plan
                    .as_mut()
                    .expect("rewritten normalized plan")
                    .identity
                    .metadata_revision = 8;
            }
            Ok(execution)
        }
    }

    impl ReadOnlyAgentToolExecutor for CancellingOptimizeExecutor {
        fn execute(
            &mut self,
            authorized: &AgentAuthorizedTool,
            context: &AgentModelContext,
        ) -> Result<AgentToolExecution, SqlCommandError> {
            let execution = self.inner.execute(authorized, context)?;
            if authorized.tool == AgentTool::SqlExplain {
                self.cancellation.cancel();
            }
            Ok(execution)
        }
    }

    impl ReadOnlyAgentToolExecutor for ScriptedOptimizeExecutor {
        fn execute(
            &mut self,
            authorized: &AgentAuthorizedTool,
            _context: &AgentModelContext,
        ) -> Result<AgentToolExecution, SqlCommandError> {
            self.tools.lock().expect("tools lock").push(authorized.tool);
            let mut execution = AgentToolExecution {
                evidence: Vec::new(),
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
                AgentTool::SqlParse => {
                    let sql = authorized.arguments["sql"].as_str().expect("parse SQL");
                    execution.analysis = Some(analyze_sql(sql, SqlDialect::Sqlite));
                    execution.evidence.push((
                        AgentEvidenceKind::Analysis,
                        AgentEvidenceSensitivity::Workspace,
                        json!({"tool": "sql.parse"}),
                    ));
                }
                AgentTool::IndexList => {
                    execution.index_context = Some(index_context());
                    execution.evidence.push((
                        AgentEvidenceKind::Index,
                        AgentEvidenceSensitivity::Workspace,
                        json!({"tool": "index.list"}),
                    ));
                }
                AgentTool::SqlExplain => {
                    let sql = authorized.arguments["sql"].as_str().expect("explain SQL");
                    execution.normalized_plan = Some(if sql == ORIGINAL_SQL {
                        plan(SqlitePlanOperation::Scan {
                            target: "users".to_string(),
                            access: SqliteScanAccess::TableOrSubquery,
                        })
                    } else {
                        plan(SqlitePlanOperation::IndexSearch {
                            target: "users".to_string(),
                            index: SqliteIndexSource::Named {
                                name: "idx_users_email".to_string(),
                            },
                            covering: true,
                        })
                    });
                    execution.evidence.push((
                        AgentEvidenceKind::Plan,
                        AgentEvidenceSensitivity::Workspace,
                        json!({"tool": "sql.explain"}),
                    ));
                    execution.query_call_count = 1;
                    execution.result_bytes = 128;
                }
                _ => {
                    return Err(SqlCommandError::new(
                        "invalid_input",
                        "unexpected Optimize tool",
                    ))
                }
            }
            Ok(execution)
        }
    }

    fn tool(call_id: &str, tool: &str, arguments: &serde_json::Value) -> String {
        json!({
            "type": "tool_call",
            "call_id": call_id,
            "tool": tool,
            "arguments": arguments,
        })
        .to_string()
    }

    fn final_response() -> String {
        json!({
			"type": "final",
			"title": "AI Optimize Query",
			"content": "The rewrite has a structurally improved plan; runtime performance remains unverified.",
			"sql": REWRITTEN_SQL,
		})
		.to_string()
    }

    fn optimize_responses() -> Vec<String> {
        vec![
            tool("parse-original", "sql.parse", &json!({"sql": ORIGINAL_SQL})),
            tool(
                "indexes",
                "index.list",
                &json!({
                    "connectionId": "reader",
                    "dialect": "sqlite",
                    "schema": "main",
                    "tables": [{"schema": "main", "name": "users"}],
                }),
            ),
            tool(
                "explain-original",
                "sql.explain",
                &json!({"connectionId": "reader", "dialect": "sqlite", "sql": ORIGINAL_SQL}),
            ),
            tool("parse-rewrite", "sql.parse", &json!({"sql": REWRITTEN_SQL})),
            tool(
                "explain-rewrite",
                "sql.explain",
                &json!({"connectionId": "reader", "dialect": "sqlite", "sql": REWRITTEN_SQL}),
            ),
            final_response(),
        ]
    }

    fn index_context() -> IndexListResult {
        IndexListResult {
            connection_id: "reader".to_string(),
            schema: "main".to_string(),
            dialect: SqlDialect::Sqlite,
            metadata_revision: 7,
            indexes: vec![IndexContextEntry {
                schema: "main".to_string(),
                table: "users".to_string(),
                name: "idx_users_email".to_string(),
                unique: false,
                partial: false,
                origin: IndexContextOrigin::Created,
                columns: vec![IndexContextColumn {
                    ordinal: 0,
                    name: Some("email".to_string()),
                    kind: IndexContextColumnKind::Column,
                    descending: false,
                    collation: None,
                }],
                metadata_revision: 7,
            }],
            scanned_table_count: 1,
            truncated: false,
            returned_index_count: 1,
            returned_column_count: 1,
            returned_byte_count: 256,
        }
    }

    fn plan(operation: SqlitePlanOperation) -> SqlitePlanSnapshot {
        SqlitePlanSnapshot {
            identity: SqlitePlanIdentity::new("reader", 7).expect("plan identity"),
            nodes: vec![SqlitePlanNode {
                ordinal: 0,
                id: 3,
                parent_id: 0,
                detail: "fixture".to_string(),
                operation,
                loop_role: Some(SqlitePlanLoopRole::Single),
            }],
            source_row_count: 1,
            returned_node_count: 1,
            returned_byte_count: 256,
            malformed_row_count: 0,
            truncated: false,
        }
    }

    fn optimize_policy() -> AgentPolicy {
        AgentPolicy::new(
            AgentMode::ReadOnly,
            AgentCapabilitySet::from_capabilities([
                AgentCapability::AgentTool,
                AgentCapability::DatabaseReadMetadata,
                AgentCapability::DatabaseExplain,
            ]),
        )
    }

    #[test]
    fn optimize_records_fixed_sequence_and_structural_comparison_without_rows() {
        let tools = Arc::new(Mutex::new(Vec::new()));
        let evidence_store = Arc::new(AgentEvidenceStore::default());
        let gateway = ScriptedGateway::new(optimize_responses());
        let executor = ScriptedOptimizeExecutor {
            tools: Arc::clone(&tools),
        };
        let mut runtime = OptimizeAgentLoop::new(
            gateway,
            optimize_policy(),
            executor,
            Arc::clone(&evidence_store),
        );
        let mut run = AgentRun::new(
            "run-optimize",
            "optimize the current query",
            AgentMode::ReadOnly,
            AgentBudget::default(),
        )
        .expect("create Optimize run");
        let context = AgentModelContext {
            connection_id: Some("reader".to_string()),
            sql: Some(ORIGINAL_SQL.to_string()),
            ..AgentModelContext::default()
        };

        let result = runtime
            .run(&mut run, AgentTaskKind::OptimizeQuery, &context)
            .expect("complete Optimize run");

        assert_eq!(result.query_call_count, 2);
        let optimize_evidence = result
            .optimize_evidence
            .as_ref()
            .expect("typed Optimize evidence");
        assert!(optimize_evidence.index_metadata_available);
        assert!(!optimize_evidence.semantics_verified);
        assert!(!optimize_evidence.comparison.performance_verified);
        assert_eq!(
            optimize_evidence.comparison.verdict,
            SqlitePlanComparisonVerdict::StructurallyImproved
        );
        assert!(result
            .answer
            .as_ref()
            .is_some_and(|answer| answer.content.contains("Query semantics were not verified")));
        assert_eq!(run.usage.result_rows, 0);
        assert_eq!(
            *tools.lock().expect("tools lock"),
            vec![
                AgentTool::SqlParse,
                AgentTool::IndexList,
                AgentTool::SqlExplain,
                AgentTool::SqlParse,
                AgentTool::SqlExplain,
            ]
        );
        assert!(!run
            .tool_calls
            .iter()
            .any(|call| call.tool == "sql.execute_readonly"));
        let evidence = evidence_store.list_for_run(&run.run_id);
        let comparison = evidence
            .iter()
            .find(|entry| entry.payload.get("comparison").is_some())
            .expect("plan comparison evidence");
        assert_eq!(
            comparison.payload["comparison"]["verdict"],
            "structurally_improved"
        );
        assert_eq!(
            result.answer.and_then(|answer| answer.sql),
            Some(REWRITTEN_SQL.to_string())
        );
    }

    #[test]
    fn optimize_marks_missing_index_capability_as_explicitly_uncertain() {
        let tools = Arc::new(Mutex::new(Vec::new()));
        let evidence_store = Arc::new(AgentEvidenceStore::default());
        let mut runtime = OptimizeAgentLoop::new(
            ScriptedGateway::new(optimize_responses()),
            optimize_policy(),
            MissingIndexOptimizeExecutor {
                inner: ScriptedOptimizeExecutor { tools },
            },
            Arc::clone(&evidence_store),
        );
        let mut run = AgentRun::new(
            "run-missing-index",
            "optimize the current query",
            AgentMode::ReadOnly,
            AgentBudget::default(),
        )
        .expect("create Optimize run");
        let context = AgentModelContext {
            connection_id: Some("reader".to_string()),
            sql: Some(ORIGINAL_SQL.to_string()),
            ..AgentModelContext::default()
        };

        let result = runtime
            .run(&mut run, AgentTaskKind::OptimizeQuery, &context)
            .expect("complete degraded Optimize run");

        let answer = result.answer.expect("Optimize answer");
        assert!(answer.content.contains("Index metadata was unavailable"));
        assert!(answer.content.contains("uncertain"));
        assert!(answer.content.contains("unverified"));
        let comparison = evidence_store
            .list_for_run(&run.run_id)
            .into_iter()
            .find(|entry| entry.payload.get("comparison").is_some())
            .expect("comparison evidence");
        assert_eq!(comparison.payload["indexMetadataAvailable"], false);
        assert_eq!(comparison.payload["comparison"]["verdict"], "uncertain");
        assert_eq!(
            comparison.payload["comparison"]["uncertaintyReason"],
            "index_metadata_unavailable"
        );
        assert_eq!(run.usage.result_rows, 0);
    }

    #[test]
    fn optimize_marks_revision_mismatched_plans_as_uncertain() {
        let tools = Arc::new(Mutex::new(Vec::new()));
        let evidence_store = Arc::new(AgentEvidenceStore::default());
        let mut runtime = OptimizeAgentLoop::new(
            ScriptedGateway::new(optimize_responses()),
            optimize_policy(),
            IncomparablePlanOptimizeExecutor {
                inner: ScriptedOptimizeExecutor { tools },
            },
            Arc::clone(&evidence_store),
        );
        let mut run = AgentRun::new(
            "run-incomparable",
            "optimize the current query",
            AgentMode::ReadOnly,
            AgentBudget::default(),
        )
        .expect("create Optimize run");
        let context = AgentModelContext {
            connection_id: Some("reader".to_string()),
            sql: Some(ORIGINAL_SQL.to_string()),
            ..AgentModelContext::default()
        };

        let result = runtime
            .run(&mut run, AgentTaskKind::OptimizeQuery, &context)
            .expect("complete incomparable Optimize run");

        let answer = result.answer.expect("Optimize answer");
        assert!(answer.content.contains("structurally uncertain"));
        assert!(answer.content.contains("unverified"));
        let comparison = evidence_store
            .list_for_run(&run.run_id)
            .into_iter()
            .find(|entry| entry.payload.get("comparison").is_some())
            .expect("comparison evidence");
        assert_eq!(comparison.payload["comparison"]["verdict"], "uncertain");
        assert_eq!(
            comparison.payload["comparison"]["uncertaintyReason"],
            "metadata_revision_mismatch"
        );
        assert_eq!(result.query_call_count, 2);
        assert_eq!(run.usage.result_rows, 0);
    }

    #[test]
    fn optimize_preserves_revision_mismatch_when_index_metadata_is_unavailable() {
        let evidence_store = Arc::new(AgentEvidenceStore::default());
        let mut runtime = OptimizeAgentLoop::new(
            ScriptedGateway::new(optimize_responses()),
            optimize_policy(),
            MissingIndexIncomparablePlanOptimizeExecutor {
                inner: ScriptedOptimizeExecutor {
                    tools: Arc::new(Mutex::new(Vec::new())),
                },
            },
            Arc::clone(&evidence_store),
        );
        let mut run = AgentRun::new(
            "run-missing-index-incomparable",
            "optimize the current query",
            AgentMode::ReadOnly,
            AgentBudget::default(),
        )
        .expect("create combined uncertainty Optimize run");
        let context = AgentModelContext {
            connection_id: Some("reader".to_string()),
            sql: Some(ORIGINAL_SQL.to_string()),
            ..AgentModelContext::default()
        };

        let result = runtime
            .run(&mut run, AgentTaskKind::OptimizeQuery, &context)
            .expect("complete combined uncertainty Optimize run");

        let comparison = evidence_store
            .list_for_run(&run.run_id)
            .into_iter()
            .find(|entry| entry.payload.get("comparison").is_some())
            .expect("comparison evidence");
        assert_eq!(comparison.payload["comparison"]["verdict"], "uncertain");
        assert_eq!(
            comparison.payload["comparison"]["uncertaintyReason"],
            "metadata_revision_mismatch"
        );
        assert_eq!(result.query_call_count, 2);
    }

    #[test]
    fn optimize_cancellation_stops_after_the_first_explain_without_plan_commit() {
        let tools = Arc::new(Mutex::new(Vec::new()));
        let evidence_store = Arc::new(AgentEvidenceStore::default());
        let mut run = AgentRun::new(
            "run-cancelled",
            "optimize the current query",
            AgentMode::ReadOnly,
            AgentBudget::default(),
        )
        .expect("create Optimize run");
        let cancellation = run.cancellation_token();
        let mut runtime = OptimizeAgentLoop::new(
            ScriptedGateway::new(optimize_responses()),
            optimize_policy(),
            CancellingOptimizeExecutor {
                inner: ScriptedOptimizeExecutor {
                    tools: Arc::clone(&tools),
                },
                cancellation,
            },
            Arc::clone(&evidence_store),
        );
        let context = AgentModelContext {
            connection_id: Some("reader".to_string()),
            sql: Some(ORIGINAL_SQL.to_string()),
            ..AgentModelContext::default()
        };

        let error = runtime
            .run(&mut run, AgentTaskKind::OptimizeQuery, &context)
            .expect_err("cancel Optimize run");

        assert!(error.to_string().contains("cancelled"));
        assert_eq!(run.state, AgentRunState::Cancelled);
        assert_eq!(
            *tools.lock().expect("tools lock"),
            vec![
                AgentTool::SqlParse,
                AgentTool::IndexList,
                AgentTool::SqlExplain,
            ]
        );
        assert_eq!(run.usage.result_rows, 0);
        assert_eq!(evidence_store.list_for_run(&run.run_id).len(), 2);
    }

    #[test]
    fn optimize_tool_budget_exhaustion_stops_before_the_rewritten_explain() {
        let tools = Arc::new(Mutex::new(Vec::new()));
        let evidence_store = Arc::new(AgentEvidenceStore::default());
        let mut runtime = OptimizeAgentLoop::new(
            ScriptedGateway::new(optimize_responses()),
            optimize_policy(),
            ScriptedOptimizeExecutor {
                tools: Arc::clone(&tools),
            },
            Arc::clone(&evidence_store),
        );
        let mut run = AgentRun::new(
            "run-budget",
            "optimize the current query",
            AgentMode::ReadOnly,
            AgentBudget {
                max_tool_calls: 4,
                ..AgentBudget::default()
            },
        )
        .expect("create budgeted Optimize run");
        let context = AgentModelContext {
            connection_id: Some("reader".to_string()),
            sql: Some(ORIGINAL_SQL.to_string()),
            ..AgentModelContext::default()
        };

        let error = runtime
            .run(&mut run, AgentTaskKind::OptimizeQuery, &context)
            .expect_err("exhaust Optimize tool budget");

        assert!(
            error
                .to_string()
                .contains("agent budget exceeded for tool call (limit 4)"),
            "unexpected error: {error}"
        );
        assert_eq!(run.state, AgentRunState::Failed);
        assert_eq!(run.usage.tool_calls, 4);
        assert_eq!(tools.lock().expect("tools lock").len(), 4);
        assert_eq!(run.usage.result_rows, 0);
        assert_eq!(evidence_store.list_for_run(&run.run_id).len(), 4);
    }

    #[test]
    fn optimize_rejects_model_attempt_to_execute_a_query_before_dispatch() {
        let tools = Arc::new(Mutex::new(Vec::new()));
        let mut runtime = OptimizeAgentLoop::new(
            ScriptedGateway::new([tool(
                "execute",
                "sql.execute_readonly",
                &json!({
                    "connectionId": "reader",
                    "dialect": "sqlite",
                    "sql": ORIGINAL_SQL,
                }),
            )]),
            optimize_policy(),
            ScriptedOptimizeExecutor {
                tools: Arc::clone(&tools),
            },
            Arc::new(AgentEvidenceStore::default()),
        );
        let mut run = AgentRun::new(
            "run-forged-execute",
            "optimize the current query",
            AgentMode::ReadOnly,
            AgentBudget::default(),
        )
        .expect("create Optimize run");
        let context = AgentModelContext {
            connection_id: Some("reader".to_string()),
            sql: Some(ORIGINAL_SQL.to_string()),
            ..AgentModelContext::default()
        };

        let error = runtime
            .run(&mut run, AgentTaskKind::OptimizeQuery, &context)
            .expect_err("reject execute tool");

        assert!(error.to_string().contains("not part of Optimize"));
        assert_eq!(run.state, AgentRunState::Failed);
        assert!(tools.lock().expect("tools lock").is_empty());
        assert_eq!(run.usage.tool_calls, 0);
        assert_eq!(run.usage.result_rows, 0);
    }

    #[test]
    fn optimize_rejects_final_response_that_skips_required_tools() {
        let tools = Arc::new(Mutex::new(Vec::new()));
        let evidence_store = Arc::new(AgentEvidenceStore::default());
        let mut runtime = OptimizeAgentLoop::new(
            ScriptedGateway::new([final_response()]),
            optimize_policy(),
            ScriptedOptimizeExecutor {
                tools: Arc::clone(&tools),
            },
            Arc::clone(&evidence_store),
        );
        let mut run = AgentRun::new(
            "run-skipped-tools",
            "optimize the current query",
            AgentMode::ReadOnly,
            AgentBudget::default(),
        )
        .expect("create Optimize run");
        let context = AgentModelContext {
            connection_id: Some("reader".to_string()),
            sql: Some(ORIGINAL_SQL.to_string()),
            ..AgentModelContext::default()
        };

        let error = runtime
            .run(&mut run, AgentTaskKind::OptimizeQuery, &context)
            .expect_err("reject early final");

        assert!(error.to_string().contains(OPTIMIZE_SEQUENCE_ERROR));
        assert_eq!(run.state, AgentRunState::Failed);
        assert!(tools.lock().expect("tools lock").is_empty());
        assert_eq!(run.usage.tool_calls, 0);
        assert!(evidence_store.list_for_run(&run.run_id).is_empty());
    }

    #[test]
    fn optimize_rejects_reordered_index_call_before_dispatch() {
        let tools = Arc::new(Mutex::new(Vec::new()));
        let evidence_store = Arc::new(AgentEvidenceStore::default());
        let mut runtime = OptimizeAgentLoop::new(
            ScriptedGateway::new([tool(
                "indexes-first",
                "index.list",
                &json!({
                    "connectionId": "reader",
                    "dialect": "sqlite",
                    "schema": "main",
                    "tables": [{"schema": "main", "name": "users"}],
                }),
            )]),
            optimize_policy(),
            ScriptedOptimizeExecutor {
                tools: Arc::clone(&tools),
            },
            Arc::clone(&evidence_store),
        );
        let mut run = AgentRun::new(
            "run-reordered-tools",
            "optimize the current query",
            AgentMode::ReadOnly,
            AgentBudget::default(),
        )
        .expect("create Optimize run");
        let context = AgentModelContext {
            connection_id: Some("reader".to_string()),
            sql: Some(ORIGINAL_SQL.to_string()),
            ..AgentModelContext::default()
        };

        let error = runtime
            .run(&mut run, AgentTaskKind::OptimizeQuery, &context)
            .expect_err("reject reordered tool");

        assert!(error.to_string().contains(OPTIMIZE_SEQUENCE_ERROR));
        assert_eq!(run.state, AgentRunState::Failed);
        assert!(tools.lock().expect("tools lock").is_empty());
        assert_eq!(run.usage.tool_calls, 0);
        assert!(evidence_store.list_for_run(&run.run_id).is_empty());
    }
}
