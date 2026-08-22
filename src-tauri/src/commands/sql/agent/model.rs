//! Deterministic model gateway contract for the A2.3 Suggest-only loop.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use super::super::dialect::SqlDialect;
use super::super::sql_lexer::{sql_tokens, SqlToken};
use super::super::types::SqlCommandError;
use super::domain::{redact_sensitive_text, AgentTaskKind, AgentToolCall};
use super::relation_context::{RelationEdge, RelationEvidenceKind, RelationSearchResult};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelSchemaTable {
    pub schema: Option<String>,
    pub name: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelResultShapeColumn {
    pub name: String,
    pub ordinal: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelResultShape {
    pub columns: Vec<AgentModelResultShapeColumn>,
    pub row_count: usize,
    pub elapsed_ms: u128,
    pub truncated: bool,
}

/// Structured database error context supplied to a Fix/Explain Agent task.
///
/// The legacy `error_message` field remains on [`AgentModelContext`] for wire
/// compatibility with older Workbench clients. New callers should populate
/// this typed envelope so the deterministic provider can distinguish the
/// stable error code/message from optional diagnostic detail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelErrorContext {
    pub code: Option<String>,
    pub message: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AgentModelRelationContext {
    Supported { search: RelationSearchResult },
    Unsupported { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelContext {
    pub dialect: SqlDialect,
    /// Opaque local connection identity used by A3 SQL tools. It is never
    /// resolved into credentials or serialized database connection details.
    #[serde(default)]
    pub connection_id: Option<String>,
    #[serde(default)]
    pub editor_id: Option<String>,
    #[serde(default)]
    pub editor_version_id: Option<u64>,
    pub sql: Option<String>,
    pub selected_sql: Option<String>,
    pub error_message: Option<String>,
    #[serde(default)]
    pub error_context: Option<AgentModelErrorContext>,
    pub user_prompt: Option<String>,
    pub explain_plan: Option<String>,
    #[serde(default)]
    pub schema: Vec<AgentModelSchemaTable>,
    /// Backend-owned declared relationship evidence. Renderer input is
    /// ignored so a caller cannot manufacture JOIN authority.
    #[serde(default, skip_deserializing)]
    pub relation_context: Option<AgentModelRelationContext>,
    #[serde(default)]
    pub result_shape: Option<AgentModelResultShape>,
    #[serde(default)]
    pub result_ref: Option<String>,
}

impl Default for AgentModelContext {
    fn default() -> Self {
        Self {
            dialect: SqlDialect::Sqlite,
            connection_id: None,
            editor_id: None,
            editor_version_id: None,
            sql: None,
            selected_sql: None,
            error_message: None,
            error_context: None,
            user_prompt: None,
            explain_plan: None,
            schema: Vec::new(),
            relation_context: None,
            result_shape: None,
            result_ref: None,
        }
    }
}

impl AgentModelContext {
    pub(crate) fn redacted_for_model(&self) -> Self {
        let mut context = self.clone();
        context.editor_id = None;
        context.editor_version_id = None;
        if let Some(error) = context.error_context.as_mut() {
            context.error_message = None;
            if let Some(code) = error.code.as_mut() {
                *code = redact_sensitive_text(code);
            }
            error.message = redact_sensitive_text(&error.message);
            error.detail = None;
        } else if let Some(message) = context.error_message.as_mut() {
            *message = redact_sensitive_text(message);
        }
        context
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelRequest {
    pub run_id: String,
    pub task: AgentTaskKind,
    pub context: AgentModelContext,
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFinalResponse {
    pub title: String,
    pub content: String,
    pub sql: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AgentModelResponse {
    Final(AgentFinalResponse),
    ToolCall(AgentToolCall),
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum AgentModelResponseWire {
    Final {
        title: String,
        content: String,
        #[serde(default)]
        sql: Option<String>,
    },
    ToolCall {
        call_id: String,
        tool: String,
        arguments: serde_json::Value,
        #[serde(default)]
        context_refs: Vec<String>,
    },
}

pub trait AgentModelGateway: Send {
    /// Returns a strict JSON payload. Parsing and authorization remain in Rust.
    fn generate(&mut self, request: &AgentModelRequest) -> Result<String, SqlCommandError>;
}

pub fn parse_model_response(
    run_id: &str,
    payload: &str,
) -> Result<AgentModelResponse, SqlCommandError> {
    let wire: AgentModelResponseWire = serde_json::from_str(payload).map_err(|error| {
        SqlCommandError::new(
            "invalid_input",
            format!("invalid Agent model JSON: {error}"),
        )
    })?;
    match wire {
        AgentModelResponseWire::Final {
            title,
            content,
            sql,
        } => {
            if title.trim().is_empty() || content.trim().is_empty() {
                return Err(SqlCommandError::new(
                    "invalid_input",
                    "Agent final response title and content are required",
                ));
            }
            Ok(AgentModelResponse::Final(AgentFinalResponse {
                title,
                content,
                sql,
            }))
        }
        AgentModelResponseWire::ToolCall {
            call_id,
            tool,
            arguments,
            context_refs,
        } => Ok(AgentModelResponse::ToolCall(AgentToolCall::new(
            run_id,
            call_id,
            tool,
            arguments,
            context_refs,
        )?)),
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct DeterministicAgentModelGateway;

impl AgentModelGateway for DeterministicAgentModelGateway {
    fn generate(&mut self, request: &AgentModelRequest) -> Result<String, SqlCommandError> {
        let response = match request.task {
            AgentTaskKind::Assistant => AgentFinalResponse {
                title: "SQL Assistant".to_string(),
                content: format_assistant_content(&request.context),
                sql: None,
            },
            AgentTaskKind::ExplainError => AgentFinalResponse {
                title: "AI Explain Error".to_string(),
                content: format_error_explanation(&request.context),
                sql: None,
            },
            AgentTaskKind::FixError => AgentFinalResponse {
                title: "AI Fix Error".to_string(),
                content: format_fix_explanation(&request.context),
                sql: deterministic_fix_query(&request.context),
            },
            AgentTaskKind::GenerateQuery => AgentFinalResponse {
                title: "AI Generate Query".to_string(),
                content: "Generated deterministic SQL draft.".to_string(),
                sql: Some(deterministic_query(&request.context)),
            },
            AgentTaskKind::OptimizeQuery => AgentFinalResponse {
                title: "AI Optimize Query".to_string(),
                content: "Review filters, indexes, join order, and selected columns.".to_string(),
                sql: request.context.sql.clone(),
            },
        };
        serde_json::to_string(&serde_json::json!({
            "type": "final",
            "title": response.title,
            "content": response.content,
            "sql": response.sql,
        }))
        .map_err(|error| SqlCommandError::new("internal", error.to_string()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SchemaDraftStep {
    SearchSchema,
    ParseDraft,
    Final,
}

/// Fixed local skill for connected Schema-aware Generate runs.
///
/// The gateway can only request metadata and static SQL analysis. Database
/// access and evidence ownership remain in the Rust tool runtime.
#[derive(Debug, Clone)]
pub struct DeterministicSchemaGenerateAgentModelGateway {
    goal: String,
    step: SchemaDraftStep,
    draft: Option<String>,
}

impl DeterministicSchemaGenerateAgentModelGateway {
    pub fn new(goal: impl Into<String>) -> Self {
        Self {
            goal: goal.into(),
            step: SchemaDraftStep::SearchSchema,
            draft: None,
        }
    }
}

impl AgentModelGateway for DeterministicSchemaGenerateAgentModelGateway {
    fn generate(&mut self, request: &AgentModelRequest) -> Result<String, SqlCommandError> {
        if request.task != AgentTaskKind::GenerateQuery {
            return Err(SqlCommandError::new(
                "invalid_input",
                "Schema Generate gateway only accepts Generate Query tasks",
            ));
        }

        let response = match self.step {
            SchemaDraftStep::SearchSchema => {
                let connection_id = request.context.connection_id.as_deref().ok_or_else(|| {
                    SqlCommandError::new(
                        "invalid_input",
                        "Schema-aware Generate requires an open connection",
                    )
                })?;
                self.step = SchemaDraftStep::ParseDraft;
                serde_json::json!({
                    "type": "tool_call",
                    "call_id": "schema-generate-search",
                    "tool": "schema.search",
                    "arguments": {
                        "connectionId": connection_id,
                        "schema": default_schema(request.context.dialect),
                        "query": self.goal,
                    }
                })
            }
            SchemaDraftStep::ParseDraft => {
                if request.context.schema.is_empty() {
                    return Err(SqlCommandError::new(
                        "validation",
                        "Schema search returned no real tables for Generate Query",
                    ));
                }
                let draft = deterministic_schema_query(&self.goal, &request.context)?;
                self.draft = Some(draft.clone());
                self.step = SchemaDraftStep::Final;
                serde_json::json!({
                    "type": "tool_call",
                    "call_id": "schema-generate-parse",
                    "tool": "sql.parse",
                    "arguments": {"sql": draft}
                })
            }
            SchemaDraftStep::Final => {
                let draft = self.draft.clone().ok_or_else(|| {
                    SqlCommandError::new("internal", "Schema Generate draft was not prepared")
                })?;
                serde_json::json!({
                    "type": "final",
                    "title": "AI Generate Query",
                    "content": "Generated a deterministic SQL draft from real schema metadata and verified it as one read-only statement.",
                    "sql": draft,
                })
            }
        };
        serde_json::to_string(&response)
            .map_err(|error| SqlCommandError::new("internal", error.to_string()))
    }
}

/// Fixed local skill for connected Schema-aware Fix runs.
///
/// The renderer supplies only the failed SQL and structured error. Real schema
/// metadata and static SQL analysis are produced by backend-owned tools.
#[derive(Debug, Clone)]
pub struct DeterministicSchemaFixAgentModelGateway {
    step: SchemaDraftStep,
    draft: Option<String>,
}

impl DeterministicSchemaFixAgentModelGateway {
    pub fn new() -> Self {
        Self {
            step: SchemaDraftStep::SearchSchema,
            draft: None,
        }
    }
}

impl AgentModelGateway for DeterministicSchemaFixAgentModelGateway {
    fn generate(&mut self, request: &AgentModelRequest) -> Result<String, SqlCommandError> {
        if request.task != AgentTaskKind::FixError {
            return Err(SqlCommandError::new(
                "invalid_input",
                "Schema Fix gateway only accepts Fix Error tasks",
            ));
        }
        let (connection_id, failed_sql) = schema_fix_inputs(&request.context)?;

        let response = match self.step {
            SchemaDraftStep::SearchSchema => {
                self.step = SchemaDraftStep::ParseDraft;
                serde_json::json!({
                    "type": "tool_call",
                    "call_id": "schema-fix-search",
                    "tool": "schema.search",
                    "arguments": {
                        "connectionId": connection_id,
                        "schema": default_schema(request.context.dialect),
                        "query": failed_sql,
                    }
                })
            }
            SchemaDraftStep::ParseDraft => {
                if request.context.schema.is_empty() {
                    return Err(SqlCommandError::new(
                        "validation",
                        "Schema search returned no real tables for Fix Error",
                    ));
                }
                let draft = deterministic_fix_query(&request.context).ok_or_else(|| {
                    SqlCommandError::new(
                        "validation",
                        "Schema Fix could not prepare a draft from the failed SQL",
                    )
                })?;
                self.draft = Some(draft.clone());
                self.step = SchemaDraftStep::Final;
                serde_json::json!({
                    "type": "tool_call",
                    "call_id": "schema-fix-parse",
                    "tool": "sql.parse",
                    "arguments": {"sql": draft}
                })
            }
            SchemaDraftStep::Final => {
                let draft = self.draft.as_deref().ok_or_else(|| {
                    SqlCommandError::new("internal", "Schema Fix draft was not prepared")
                })?;
                serde_json::json!({
                    "type": "final",
                    "title": "AI Fix Error",
                    "content": "Prepared a deterministic SQL fix from real schema metadata and verified it as one read-only statement. The draft was not executed.",
                    "sql": draft,
                })
            }
        };
        serde_json::to_string(&response)
            .map_err(|error| SqlCommandError::new("internal", error.to_string()))
    }
}

fn schema_fix_inputs(context: &AgentModelContext) -> Result<(&str, &str), SqlCommandError> {
    let connection_id = context
        .connection_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            SqlCommandError::new(
                "invalid_input",
                "Schema-aware Fix requires an open connection",
            )
        })?;
    let failed_sql = context
        .sql
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            SqlCommandError::new("invalid_input", "Schema-aware Fix requires failed SQL")
        })?;
    if context
        .error_context
        .as_ref()
        .is_none_or(|error| error.message.trim().is_empty())
    {
        return Err(SqlCommandError::new(
            "invalid_input",
            "Schema-aware Fix requires structured error context",
        ));
    }
    Ok((connection_id, failed_sql))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadOnlyExploreStep {
    SearchSchema,
    ParseDraft,
    ExecuteDraft,
    InspectResult,
    Final,
}

/// Fixed local skill for a schema-grounded `SQLite` read-only exploration.
/// The runtime still authorizes and binds every tool call; this gateway only
/// supplies the deterministic next step and never receives query rows.
#[derive(Debug, Clone)]
pub struct DeterministicReadOnlyExploreAgentModelGateway {
    goal: String,
    step: ReadOnlyExploreStep,
    draft: Option<String>,
}

impl DeterministicReadOnlyExploreAgentModelGateway {
    pub fn new(goal: impl Into<String>) -> Self {
        Self {
            goal: goal.into(),
            step: ReadOnlyExploreStep::SearchSchema,
            draft: None,
        }
    }

    fn draft(&self) -> Result<&str, SqlCommandError> {
        self.draft.as_deref().ok_or_else(|| {
            SqlCommandError::new("internal", "Read-only Explore draft was not prepared")
        })
    }
}

impl AgentModelGateway for DeterministicReadOnlyExploreAgentModelGateway {
    fn generate(&mut self, request: &AgentModelRequest) -> Result<String, SqlCommandError> {
        if request.task != AgentTaskKind::Assistant {
            return Err(SqlCommandError::new(
                "invalid_input",
                "Read-only Explore gateway only accepts Assistant tasks",
            ));
        }
        let connection_id = request.context.connection_id.as_deref().ok_or_else(|| {
            SqlCommandError::new(
                "invalid_input",
                "Read-only Explore requires an open connection",
            )
        })?;

        let response = match self.step {
            ReadOnlyExploreStep::SearchSchema => {
                self.step = ReadOnlyExploreStep::ParseDraft;
                serde_json::json!({
                    "type": "tool_call",
                    "call_id": "explore-schema-search",
                    "tool": "schema.search",
                    "arguments": {
                        "connectionId": connection_id,
                        "schema": default_schema(request.context.dialect),
                        "query": self.goal,
                    }
                })
            }
            ReadOnlyExploreStep::ParseDraft => {
                if request.context.schema.is_empty() {
                    return Err(SqlCommandError::new(
                        "validation",
                        "Schema search returned no real tables for Read-only Explore",
                    ));
                }
                let draft = deterministic_explore_query(&self.goal, &request.context)?;
                self.draft = Some(draft.clone());
                self.step = ReadOnlyExploreStep::ExecuteDraft;
                serde_json::json!({
                    "type": "tool_call",
                    "call_id": "explore-parse",
                    "tool": "sql.parse",
                    "arguments": {"sql": draft}
                })
            }
            ReadOnlyExploreStep::ExecuteDraft => {
                let draft = self.draft()?.to_string();
                self.step = ReadOnlyExploreStep::InspectResult;
                serde_json::json!({
                    "type": "tool_call",
                    "call_id": "explore-execute",
                    "tool": "sql.execute_readonly",
                    "arguments": {
                        "connectionId": connection_id,
                        "dialect": "sqlite",
                        "sql": draft,
                    }
                })
            }
            ReadOnlyExploreStep::InspectResult => {
                let result_ref = request.context.result_ref.as_deref().ok_or_else(|| {
                    SqlCommandError::new(
                        "internal",
                        "Read-only Explore execution did not return a result reference",
                    )
                })?;
                self.step = ReadOnlyExploreStep::Final;
                serde_json::json!({
                    "type": "tool_call",
                    "call_id": "explore-inspect",
                    "tool": "result.inspect",
                    "arguments": {"resultRef": result_ref}
                })
            }
            ReadOnlyExploreStep::Final => {
                let shape = request.context.result_shape.as_ref().ok_or_else(|| {
                    SqlCommandError::new(
                        "internal",
                        "Read-only Explore result shape was not available",
                    )
                })?;
                let truncation = if shape.truncated {
                    "truncated"
                } else {
                    "not truncated"
                };
                serde_json::json!({
                    "type": "final",
                    "title": "SQL Read Only Explore",
                    "content": format!(
                        "Executed one schema-grounded read-only SQLite query and inspected evidence for {} row(s); the result was {truncation}.",
                        shape.row_count
                    ),
                    "sql": self.draft()?,
                })
            }
        };
        serde_json::to_string(&response)
            .map_err(|error| SqlCommandError::new("internal", error.to_string()))
    }
}

fn default_schema(dialect: SqlDialect) -> &'static str {
    match dialect {
        SqlDialect::Sqlite => "main",
        SqlDialect::PostgreSql => "public",
        SqlDialect::MySql => "",
    }
}

fn deterministic_schema_query(
    goal: &str,
    context: &AgentModelContext,
) -> Result<String, SqlCommandError> {
    let users = context
        .schema
        .iter()
        .find(|table| table.name.eq_ignore_ascii_case("users"));
    let orders = context
        .schema
        .iter()
        .find(|table| table.name.eq_ignore_ascii_case("orders"));
    if let (Some(users), Some(orders)) = (users, orders) {
        let required_users = ["id", "name"];
        let required_orders = ["amount", "created_at"];
        if required_users
            .iter()
            .all(|column| has_column(users, column))
            && required_orders
                .iter()
                .all(|column| has_column(orders, column))
        {
            let Some(join_predicate) = declared_join_predicate(context, orders, "o", users, "u")?
            else {
                return deterministic_single_table_query(context);
            };
            let users_name = context
                .dialect
                .format_qualified_name(users.schema.as_deref(), &users.name)
                .map_err(|error| SqlCommandError::new("validation", error))?;
            let orders_name = context
                .dialect
                .format_qualified_name(orders.schema.as_deref(), &orders.name)
                .map_err(|error| SqlCommandError::new("validation", error))?;
            if context.dialect == SqlDialect::Sqlite && asks_for_top_user_spend(goal) {
                return Ok(format!(
					"SELECT \"u\".\"id\", \"u\".\"name\", SUM(\"o\".\"amount\") AS \"total_amount\"\nFROM {orders_name} AS \"o\"\nJOIN {users_name} AS \"u\" ON {join_predicate}\nWHERE date(\"o\".\"created_at\") >= date('now', '-30 days')\nGROUP BY \"u\".\"id\", \"u\".\"name\"\nORDER BY \"total_amount\" DESC\nLIMIT 10;"
				));
            }
            return Ok(format!(
				"SELECT \"u\".\"name\", \"o\".\"amount\", \"o\".\"created_at\"\nFROM {orders_name} AS \"o\"\nJOIN {users_name} AS \"u\" ON {join_predicate}\nORDER BY \"o\".\"created_at\" DESC\nLIMIT 100;"
            ));
        }
    }

    deterministic_single_table_query(context)
}

fn declared_join_predicate(
    context: &AgentModelContext,
    left: &AgentModelSchemaTable,
    left_alias: &str,
    right: &AgentModelSchemaTable,
    right_alias: &str,
) -> Result<Option<String>, SqlCommandError> {
    let Some(AgentModelRelationContext::Supported { search }) = &context.relation_context else {
        return Ok(None);
    };
    if search.dialect != context.dialect
        || context.connection_id.as_deref() != Some(search.connection_id.as_str())
    {
        return Ok(None);
    }

    for edge in search.paths.iter().flat_map(|path| path.edges.iter()) {
        if edge.evidence_kind != RelationEvidenceKind::DeclaredForeignKey
            || edge.metadata_revision != search.metadata_revision
        {
            continue;
        }
        let Some((source_table, source_alias, target_table, target_alias)) =
            relation_join_sides(edge, left, left_alias, right, right_alias)
        else {
            continue;
        };
        let mut predicates = Vec::with_capacity(edge.columns.len());
        for column in &edge.columns {
            let Some(target_column) = column.target_column.as_deref() else {
                predicates.clear();
                break;
            };
            if !has_column(source_table, &column.source_column)
                || !has_column(target_table, target_column)
            {
                predicates.clear();
                break;
            }
            let source_alias = context
                .dialect
                .quote_identifier(source_alias)
                .map_err(|error| SqlCommandError::new("validation", error))?;
            let target_alias = context
                .dialect
                .quote_identifier(target_alias)
                .map_err(|error| SqlCommandError::new("validation", error))?;
            let source_column = context
                .dialect
                .quote_identifier(&column.source_column)
                .map_err(|error| SqlCommandError::new("validation", error))?;
            let target_column = context
                .dialect
                .quote_identifier(target_column)
                .map_err(|error| SqlCommandError::new("validation", error))?;
            predicates.push(format!(
                "{source_alias}.{source_column} = {target_alias}.{target_column}"
            ));
        }
        if !predicates.is_empty() {
            return Ok(Some(predicates.join(" AND ")));
        }
    }
    Ok(None)
}

fn relation_join_sides<'a>(
    edge: &RelationEdge,
    left: &'a AgentModelSchemaTable,
    left_alias: &'a str,
    right: &'a AgentModelSchemaTable,
    right_alias: &'a str,
) -> Option<(
    &'a AgentModelSchemaTable,
    &'a str,
    &'a AgentModelSchemaTable,
    &'a str,
)> {
    if relation_object_matches_table(&edge.source, left)
        && relation_object_matches_table(&edge.target, right)
    {
        Some((left, left_alias, right, right_alias))
    } else if relation_object_matches_table(&edge.source, right)
        && relation_object_matches_table(&edge.target, left)
    {
        Some((right, right_alias, left, left_alias))
    } else {
        None
    }
}

fn relation_object_matches_table(
    object: &super::core_adapter::SchemaContextObject,
    table: &AgentModelSchemaTable,
) -> bool {
    object.name.eq_ignore_ascii_case(&table.name)
        && table
            .schema
            .as_deref()
            .is_none_or(|schema| object.schema.eq_ignore_ascii_case(schema))
}

fn deterministic_single_table_query(
    context: &AgentModelContext,
) -> Result<String, SqlCommandError> {
    let table = &context.schema[0];
    let table_name = context
        .dialect
        .format_qualified_name(table.schema.as_deref(), &table.name)
        .map_err(|error| SqlCommandError::new("validation", error))?;
    let columns = if table.columns.is_empty() {
        "*".to_string()
    } else {
        table
            .columns
            .iter()
            .map(|column| {
                context
                    .dialect
                    .quote_identifier(column)
                    .map_err(|error| SqlCommandError::new("validation", error))
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(", ")
    };
    Ok(format!("SELECT {columns}\nFROM {table_name}\nLIMIT 100;"))
}

fn asks_for_top_user_spend(goal: &str) -> bool {
    let normalized = goal.to_lowercase();
    let asks_for_thirty_days = normalized.contains("30")
        && ["day", "days", "天"]
            .iter()
            .any(|term| normalized.contains(term));
    let asks_for_top_ten = normalized.contains("10")
        && ["top", "highest", "most", "最高", "前"]
            .iter()
            .any(|term| normalized.contains(term));
    let asks_for_spend = ["spend", "spending", "amount", "消费", "金额"]
        .iter()
        .any(|term| normalized.contains(term));
    let asks_for_users = ["user", "users", "customer", "customers", "用户", "客户"]
        .iter()
        .any(|term| normalized.contains(term));
    asks_for_thirty_days && asks_for_top_ten && asks_for_spend && asks_for_users
}

fn deterministic_explore_query(
    goal: &str,
    context: &AgentModelContext,
) -> Result<String, SqlCommandError> {
    let normalized_goal = goal.to_lowercase();
    let asks_for_daily = ["daily", "by day", "per day", "按天", "每天"]
        .iter()
        .any(|term| normalized_goal.contains(term));
    let asks_for_seven_days = normalized_goal.contains('7')
        && ["day", "days", "天"]
            .iter()
            .any(|term| normalized_goal.contains(term));
    let orders = context
        .schema
        .iter()
        .find(|table| table.name.eq_ignore_ascii_case("orders"));

    if asks_for_daily && asks_for_seven_days {
        if let Some(orders) =
            orders.filter(|table| has_column(table, "amount") && has_column(table, "created_at"))
        {
            let table_name = context
                .dialect
                .format_qualified_name(orders.schema.as_deref(), &orders.name)
                .map_err(|error| SqlCommandError::new("validation", error))?;
            let amount = context
                .dialect
                .quote_identifier("amount")
                .map_err(|error| SqlCommandError::new("validation", error))?;
            let created_at = context
                .dialect
                .quote_identifier("created_at")
                .map_err(|error| SqlCommandError::new("validation", error))?;
            let order_day = context
                .dialect
                .quote_identifier("order_day")
                .map_err(|error| SqlCommandError::new("validation", error))?;
            let total_amount = context
                .dialect
                .quote_identifier("total_amount")
                .map_err(|error| SqlCommandError::new("validation", error))?;
            return Ok(format!(
                "SELECT date({created_at}) AS {order_day}, SUM({amount}) AS {total_amount}\nFROM {table_name}\nWHERE date({created_at}) >= date((SELECT MAX(date({created_at})) FROM {table_name}), '-6 days')\nGROUP BY date({created_at})\nORDER BY {order_day} ASC\nLIMIT 100;"
            ));
        }
    }

    deterministic_schema_query(goal, context)
}

fn has_column(table: &AgentModelSchemaTable, name: &str) -> bool {
    table
        .columns
        .iter()
        .any(|column| column.eq_ignore_ascii_case(name))
}

fn deterministic_query(context: &AgentModelContext) -> String {
    let Some(table) = context.schema.first() else {
        let request = context
            .user_prompt
            .as_deref()
            .map(|value| value.trim().replace(['\r', '\n'], " "))
            .filter(|value| !value.is_empty());
        return request.map_or_else(
            || "SELECT 1 AS value;".to_string(),
            |value| format!("-- {value}\nSELECT 1 AS value;"),
        );
    };
    let table_name = table.schema.as_deref().map_or_else(
        || table.name.clone(),
        |schema| format!("{schema}.{}", table.name),
    );
    let columns = if table.columns.is_empty() {
        "*".to_string()
    } else {
        table.columns.join(", ")
    };
    format!("SELECT {columns}\nFROM {table_name}\nLIMIT 100;")
}

/// Produces a conservative SQL draft for a failed query.
///
/// The provider never executes or validates this text. It only replaces a
/// clearly reported missing column when a bounded schema context contains a
/// real replacement. If the error cannot be mapped safely, the original SQL
/// is returned unchanged so the Workbench can present it as a reviewable
/// proposal rather than inventing a query.
fn deterministic_fix_query(context: &AgentModelContext) -> Option<String> {
    let sql = context
        .sql
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    if context.schema.is_empty() {
        return None;
    }

    let Some(missing_column) = missing_column_from_error(context) else {
        return Some(sql.to_string());
    };

    let referenced_tables = context
        .schema
        .iter()
        .filter(|table| sql_mentions_identifier(sql, &table.name, context.dialect))
        .collect::<Vec<_>>();
    let table = match referenced_tables.as_slice() {
        [table] => *table,
        [] if context.schema.len() == 1 => &context.schema[0],
        _ => return Some(sql.to_string()),
    };
    if table.columns.is_empty() {
        return Some(sql.to_string());
    }

    let missing_name = missing_column
        .rsplit_once('.')
        .map_or(missing_column.as_str(), |(_, name)| name);
    let mut candidates = table.columns.iter().filter_map(|column| {
        let column = column.trim();
        (!column.is_empty()
            && !column.eq_ignore_ascii_case(missing_name)
            && identifier_distance(missing_name, column) == 1)
            .then_some(column)
    });
    let Some(replacement) = candidates.next() else {
        return Some(sql.to_string());
    };
    if candidates.next().is_some() {
        return Some(sql.to_string());
    }

    let replaced = replace_identifier_token(sql, &missing_column, replacement);
    Some(replaced)
}

fn format_error_explanation(context: &AgentModelContext) -> String {
    let error = format_error_context(context);
    format!("Review the SQL error with dialect-specific syntax and schema context.{error}")
}

fn format_fix_explanation(context: &AgentModelContext) -> String {
    let error = format_error_context(context);
    let schema_hint = context
        .schema
        .first()
        .map(|table| {
            let columns = if table.columns.is_empty() {
                "*".to_string()
            } else {
                table.columns.join(", ")
            };
            format!(" Candidate schema: {}({columns}).", table.name)
        })
        .unwrap_or_default();
    format!(
        "Prepared a deterministic SQL fix draft for review.{error}{schema_hint} The draft is never executed automatically."
    )
}

fn format_error_context(context: &AgentModelContext) -> String {
    if let Some(error) = context.error_context.as_ref() {
        let code = error
            .code
            .as_deref()
            .map(|value| format!(" Code: {value}."))
            .unwrap_or_default();
        let detail = error
            .detail
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!(" Detail: {value}."))
            .unwrap_or_default();
        return format!(" Error: {}.{code}{detail}", error.message.trim());
    }

    context
        .error_message
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!(" Error: {}.", value.trim()))
        .unwrap_or_default()
}

fn missing_column_from_error(context: &AgentModelContext) -> Option<String> {
    let message = context
        .error_context
        .as_ref()
        .map(|error| error.message.as_str())
        .or(context.error_message.as_deref())?;
    let normalized = message.trim();
    let lower = normalized.to_ascii_lowercase();

    for marker in ["no such column:", "unknown column"] {
        let Some(start) = lower.find(marker) else {
            continue;
        };
        let tail = normalized[start + marker.len()..].trim();
        let tail = tail.strip_prefix(':').map_or(tail, str::trim);
        let candidate = tail
            .split(|character: char| {
                matches!(character, '\n' | '\r' | ';' | '(' | ')' | ' ' | '\t')
            })
            .next()
            .unwrap_or_default()
            .trim()
            .trim_matches(|character| matches!(character, '\'' | '"' | '`'))
            .trim();
        if !candidate.is_empty()
            && candidate.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '_' | '$' | '.')
            })
        {
            return Some(candidate.to_string());
        }
    }

    None
}

fn sql_mentions_identifier(sql: &str, identifier: &str, dialect: SqlDialect) -> bool {
    sql_tokens(sql, dialect).iter().any(|token| {
        matches!(token, SqlToken::Word(value) | SqlToken::QuotedIdentifier(value) if value.eq_ignore_ascii_case(identifier))
    })
}

fn identifier_distance(left: &str, right: &str) -> usize {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut previous = (0..=right.len()).collect::<Vec<_>>();
    let mut current = vec![0; right.len() + 1];

    for (left_index, left_byte) in left.iter().enumerate() {
        current[0] = left_index + 1;
        for (right_index, right_byte) in right.iter().enumerate() {
            let substitution = previous[right_index] + usize::from(left_byte != right_byte);
            let insertion = current[right_index] + 1;
            let deletion = previous[right_index + 1] + 1;
            current[right_index + 1] = substitution.min(insertion).min(deletion);
        }
        std::mem::swap(&mut previous, &mut current);
    }

    previous[right.len()]
}

fn replace_identifier_token(sql: &str, needle: &str, replacement: &str) -> String {
    #[derive(Clone, Copy)]
    enum ScanState {
        Code,
        SingleQuote,
        DoubleQuote,
        Backtick,
        Bracket,
        LineComment,
        BlockComment,
    }

    let mut output = String::with_capacity(sql.len());
    let mut cursor = 0;
    let mut state = ScanState::Code;
    let is_boundary = |character: Option<char>| {
        character.is_none_or(|value| !value.is_ascii_alphanumeric() && !matches!(value, '_' | '$'))
    };

    while cursor < sql.len() {
        let remaining = &sql[cursor..];
        let character = remaining.chars().next().unwrap_or_default();
        let next = remaining[character.len_utf8()..].chars().next();

        match state {
            ScanState::Code => {
                let candidate_end = cursor + needle.len();
                if let Some(candidate) = sql.get(cursor..candidate_end) {
                    if candidate.eq_ignore_ascii_case(needle)
                        && is_boundary(sql[..cursor].chars().next_back())
                        && is_boundary(sql[candidate_end..].chars().next())
                    {
                        if let Some((qualifier, _)) = candidate.rsplit_once('.') {
                            output.push_str(qualifier);
                            output.push('.');
                        }
                        output.push_str(replacement);
                        cursor = candidate_end;
                        continue;
                    }
                }

                state = match (character, next) {
                    ('-', Some('-')) | ('#', _) => ScanState::LineComment,
                    ('/', Some('*')) => ScanState::BlockComment,
                    ('\'', _) => ScanState::SingleQuote,
                    ('"', _) => ScanState::DoubleQuote,
                    ('`', _) => ScanState::Backtick,
                    ('[', _) => ScanState::Bracket,
                    _ => ScanState::Code,
                };
            }
            ScanState::SingleQuote | ScanState::DoubleQuote | ScanState::Backtick => {
                let delimiter = match state {
                    ScanState::SingleQuote => '\'',
                    ScanState::DoubleQuote => '"',
                    ScanState::Backtick => '`',
                    _ => unreachable!(),
                };
                if character == '\\' && next.is_some() {
                    output.push(character);
                    cursor += character.len_utf8();
                    let escaped = sql[cursor..].chars().next().unwrap_or_default();
                    output.push(escaped);
                    cursor += escaped.len_utf8();
                    continue;
                }
                if character == delimiter {
                    if next == Some(delimiter) {
                        output.push(character);
                        cursor += character.len_utf8();
                    } else {
                        state = ScanState::Code;
                    }
                }
            }
            ScanState::Bracket => {
                if character == ']' {
                    if next == Some(']') {
                        output.push(character);
                        cursor += character.len_utf8();
                    } else {
                        state = ScanState::Code;
                    }
                }
            }
            ScanState::LineComment => {
                if matches!(character, '\n' | '\r') {
                    state = ScanState::Code;
                }
            }
            ScanState::BlockComment => {
                if character == '*' && next == Some('/') {
                    output.push_str("*/");
                    cursor += 2;
                    state = ScanState::Code;
                    continue;
                }
            }
        }

        output.push(character);
        cursor += character.len_utf8();
    }

    output
}

fn format_assistant_content(context: &AgentModelContext) -> String {
    format!(
        "Prepared assistant context for {:?}. SQL present: {}. Schema tables: {}. Result shape: {}.",
        context.dialect,
        context.sql.is_some() || context.selected_sql.is_some(),
        context.schema.len(),
        context.result_shape.is_some()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sql::agent::core_adapter::{SchemaContextObject, SchemaContextObjectKind};
    use crate::commands::sql::agent::relation_context::{RelationColumnPair, RelationSearchPath};
    use serde_json::json;

    fn schema_fix_request() -> AgentModelRequest {
        AgentModelRequest {
            run_id: "run-fix".to_string(),
            task: AgentTaskKind::FixError,
            context: AgentModelContext {
                connection_id: Some("demo".to_string()),
                editor_id: Some("query-7".to_string()),
                editor_version_id: Some(9),
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
            },
            evidence_refs: Vec::new(),
        }
    }

    fn declared_relation_context(
        source_column: &str,
        target_column: &str,
    ) -> AgentModelRelationContext {
        let object = |name: &str| SchemaContextObject {
            schema: "main".to_string(),
            name: name.to_string(),
            kind: SchemaContextObjectKind::Table,
        };
        let edge = RelationEdge {
            source: object("orders"),
            target: object("users"),
            columns: vec![RelationColumnPair {
                ordinal: 0,
                source_column: source_column.to_string(),
                target_column: Some(target_column.to_string()),
            }],
            evidence_kind: RelationEvidenceKind::DeclaredForeignKey,
            metadata_revision: 7,
        };
        AgentModelRelationContext::Supported {
            search: RelationSearchResult {
                connection_id: "demo".to_string(),
                schema: "main".to_string(),
                dialect: SqlDialect::Sqlite,
                metadata_revision: 7,
                paths: vec![RelationSearchPath {
                    nodes: vec![object("orders"), object("users")],
                    edges: vec![edge],
                }],
                truncated: false,
                returned_path_count: 1,
                returned_edge_count: 1,
                returned_byte_count: 0,
            },
        }
    }

    #[test]
    fn malformed_model_json_is_structured_error() {
        let error = parse_model_response("run-1", "not-json").unwrap_err();
        assert!(matches!(error, SqlCommandError::InvalidInput { .. }));
    }

    #[test]
    fn unknown_model_shape_is_rejected_without_fallback() {
        let error =
            parse_model_response("run-1", r#"{"type":"tool","name":"sql_query"}"#).unwrap_err();
        assert!(matches!(error, SqlCommandError::InvalidInput { .. }));
    }

    #[test]
    fn tool_call_json_is_typed_and_keeps_the_opaque_run_id() {
        let response = parse_model_response(
            "run-1",
            &json!({
                "type": "tool_call",
                "call_id": "call-1",
                "tool": "sql.parse",
                "arguments": {"sql": "SELECT 1"}
            })
            .to_string(),
        )
        .unwrap();
        let AgentModelResponse::ToolCall(call) = response else {
            panic!("expected tool call");
        };
        assert_eq!(call.run_id, "run-1");
        assert_eq!(call.tool, "sql.parse");
    }

    #[test]
    fn deterministic_generate_query_uses_real_schema_columns() {
        let mut gateway = DeterministicAgentModelGateway;
        let raw = gateway
            .generate(&AgentModelRequest {
                run_id: "run-1".to_string(),
                task: AgentTaskKind::GenerateQuery,
                context: AgentModelContext {
                    schema: vec![AgentModelSchemaTable {
                        schema: Some("main".to_string()),
                        name: "orders".to_string(),
                        columns: vec!["id".to_string(), "total".to_string()],
                    }],
                    ..AgentModelContext::default()
                },
                evidence_refs: vec![],
            })
            .unwrap();
        let response = parse_model_response("run-1", &raw).unwrap();
        let AgentModelResponse::Final(response) = response else {
            panic!("expected final response");
        };
        assert_eq!(
            response.sql.as_deref(),
            Some("SELECT id, total\nFROM main.orders\nLIMIT 100;")
        );
    }

    #[test]
    fn deterministic_schema_generate_joins_demo_relationship_columns() {
        let mut gateway = DeterministicSchemaGenerateAgentModelGateway::new(
            "list recent orders with customer names",
        );
        let mut request = AgentModelRequest {
            run_id: "run-1".to_string(),
            task: AgentTaskKind::GenerateQuery,
            context: AgentModelContext {
                connection_id: Some("demo".to_string()),
                ..AgentModelContext::default()
            },
            evidence_refs: Vec::new(),
        };
        let search = parse_model_response("run-1", &gateway.generate(&request).unwrap()).unwrap();
        let AgentModelResponse::ToolCall(search) = search else {
            panic!("expected schema search");
        };
        assert_eq!(search.tool, "schema.search");

        request.context.schema = vec![
            AgentModelSchemaTable {
                schema: Some("main".to_string()),
                name: "orders".to_string(),
                columns: vec![
                    "id".to_string(),
                    "user_id".to_string(),
                    "amount".to_string(),
                    "created_at".to_string(),
                ],
            },
            AgentModelSchemaTable {
                schema: Some("main".to_string()),
                name: "users".to_string(),
                columns: vec!["id".to_string(), "name".to_string(), "email".to_string()],
            },
        ];
        request.context.relation_context = Some(declared_relation_context("user_id", "id"));
        request.evidence_refs.push("evidence-schema".to_string());
        let parse = parse_model_response("run-1", &gateway.generate(&request).unwrap()).unwrap();
        let AgentModelResponse::ToolCall(parse) = parse else {
            panic!("expected SQL parse");
        };
        assert_eq!(parse.tool, "sql.parse");
        let sql = parse.arguments["sql"].as_str().unwrap();
        assert!(sql.contains("JOIN"));
        assert!(sql.contains("user_id"));
        assert!(sql.contains("name"));

        request.evidence_refs.push("evidence-analysis".to_string());
        let final_response =
            parse_model_response("run-1", &gateway.generate(&request).unwrap()).unwrap();
        let AgentModelResponse::Final(final_response) = final_response else {
            panic!("expected final response");
        };
        assert_eq!(final_response.sql.as_deref(), Some(sql));
    }

    #[test]
    fn deterministic_schema_generate_does_not_guess_a_join_from_column_names() {
        let context = AgentModelContext {
            connection_id: Some("demo".to_string()),
            schema: vec![
                AgentModelSchemaTable {
                    schema: Some("main".to_string()),
                    name: "orders".to_string(),
                    columns: vec![
                        "user_id".to_string(),
                        "amount".to_string(),
                        "created_at".to_string(),
                    ],
                },
                AgentModelSchemaTable {
                    schema: Some("main".to_string()),
                    name: "users".to_string(),
                    columns: vec!["id".to_string(), "name".to_string()],
                },
            ],
            ..AgentModelContext::default()
        };

        let sql = deterministic_schema_query("recent orders with user names", &context).unwrap();

        assert!(!sql.contains("JOIN"));
        assert!(sql.contains("FROM \"orders\""), "{sql}");
    }

    #[test]
    fn deterministic_schema_generate_uses_declared_nonconventional_columns() {
        let context = AgentModelContext {
            connection_id: Some("demo".to_string()),
            schema: vec![
                AgentModelSchemaTable {
                    schema: Some("main".to_string()),
                    name: "orders".to_string(),
                    columns: vec![
                        "account_ref".to_string(),
                        "amount".to_string(),
                        "created_at".to_string(),
                    ],
                },
                AgentModelSchemaTable {
                    schema: Some("main".to_string()),
                    name: "users".to_string(),
                    columns: vec!["id".to_string(), "user_key".to_string(), "name".to_string()],
                },
            ],
            relation_context: Some(declared_relation_context("account_ref", "user_key")),
            ..AgentModelContext::default()
        };

        let sql = deterministic_schema_query("recent orders with user names", &context).unwrap();

        assert!(
            sql.contains("JOIN \"users\" AS \"u\" ON \"o\".\"account_ref\" = \"u\".\"user_key\""),
            "{sql}"
        );
    }

    #[test]
    fn deterministic_schema_generate_grounds_the_mvp_top_spend_story() {
        let mut gateway = DeterministicSchemaGenerateAgentModelGateway::new(
            "查询最近 30 天消费金额最高的 10 个用户",
        );
        let mut request = AgentModelRequest {
            run_id: "run-top-spend".to_string(),
            task: AgentTaskKind::GenerateQuery,
            context: AgentModelContext {
                connection_id: Some("demo".to_string()),
                ..AgentModelContext::default()
            },
            evidence_refs: Vec::new(),
        };
        let _ = gateway.generate(&request).expect("request schema search");
        request.context.schema = vec![
            AgentModelSchemaTable {
                schema: Some("main".to_string()),
                name: "orders".to_string(),
                columns: vec![
                    "id".to_string(),
                    "user_id".to_string(),
                    "amount".to_string(),
                    "created_at".to_string(),
                ],
            },
            AgentModelSchemaTable {
                schema: Some("main".to_string()),
                name: "users".to_string(),
                columns: vec!["id".to_string(), "name".to_string()],
            },
        ];
        request.context.relation_context = Some(declared_relation_context("user_id", "id"));
        request.evidence_refs.push("evidence-schema".to_string());

        let parsed = parse_model_response(
            "run-top-spend",
            &gateway.generate(&request).expect("request SQL parse"),
        )
        .expect("parse gateway response");
        let AgentModelResponse::ToolCall(parsed) = parsed else {
            panic!("expected SQL parse");
        };
        let sql = parsed.arguments["sql"].as_str().expect("generated SQL");

        for expected in [
            "SUM(\"o\".\"amount\")",
            "date(\"o\".\"created_at\")",
            "'-30 days'",
            "GROUP BY \"u\".\"id\", \"u\".\"name\"",
            "ORDER BY \"total_amount\" DESC",
            "LIMIT 10",
        ] {
            assert!(sql.contains(expected), "missing {expected}: {sql}");
        }
        assert!(!sql.contains("LIMIT 100"));
    }

    #[test]
    fn schema_fix_gateway_searches_failed_sql_on_context_connection() {
        let mut gateway = DeterministicSchemaFixAgentModelGateway::new();
        let request = schema_fix_request();

        let response = parse_model_response(
            "run-fix",
            &gateway.generate(&request).expect("request schema search"),
        )
        .expect("parse schema search");
        let AgentModelResponse::ToolCall(call) = response else {
            panic!("expected schema search");
        };

        assert_eq!(call.tool, "schema.search");
        assert_eq!(call.arguments["connectionId"], "demo");
        assert_eq!(call.arguments["query"], "SELECT amunt FROM orders");
    }

    #[test]
    fn schema_fix_gateway_parses_repaired_draft_and_returns_it_unchanged() {
        let mut gateway = DeterministicSchemaFixAgentModelGateway::new();
        let mut request = schema_fix_request();
        gateway.generate(&request).expect("request schema search");
        request.context.schema = vec![AgentModelSchemaTable {
            schema: Some("main".to_string()),
            name: "orders".to_string(),
            columns: vec!["id".to_string(), "amount".to_string()],
        }];

        let parse = parse_model_response(
            "run-fix",
            &gateway.generate(&request).expect("request SQL parse"),
        )
        .expect("parse SQL tool call");
        let AgentModelResponse::ToolCall(parse) = parse else {
            panic!("expected SQL parse");
        };
        let parsed_sql = parse.arguments["sql"]
            .as_str()
            .expect("parsed SQL")
            .to_string();
        let final_response = parse_model_response(
            "run-fix",
            &gateway.generate(&request).expect("return final response"),
        )
        .expect("parse final response");
        let AgentModelResponse::Final(final_response) = final_response else {
            panic!("expected final response");
        };

        assert_eq!(parsed_sql, "SELECT amount FROM orders");
        assert_eq!(final_response.sql.as_deref(), Some(parsed_sql.as_str()));
    }

    #[test]
    fn schema_fix_gateway_requires_failed_sql() {
        let mut gateway = DeterministicSchemaFixAgentModelGateway::new();
        let mut request = schema_fix_request();
        request.context.sql = None;

        let error = gateway.generate(&request).unwrap_err();

        assert!(error.to_string().contains("requires failed SQL"));
    }

    #[test]
    fn schema_fix_gateway_requires_structured_error_context() {
        let mut gateway = DeterministicSchemaFixAgentModelGateway::new();
        let mut request = schema_fix_request();
        request.context.error_context = None;
        request.context.error_message = Some("legacy error".to_string());

        let error = gateway.generate(&request).unwrap_err();

        assert!(error.to_string().contains("structured error context"));
    }

    #[test]
    fn model_context_redaction_removes_workbench_editor_identity() {
        let context = schema_fix_request().context;

        let redacted = context.redacted_for_model();

        assert_eq!(redacted.editor_id, None);
        assert_eq!(redacted.editor_version_id, None);
    }

    #[test]
    fn model_context_deserialization_ignores_forged_relation_evidence() {
        let context = AgentModelContext {
            connection_id: Some("demo".to_string()),
            relation_context: Some(declared_relation_context("user_id", "id")),
            ..AgentModelContext::default()
        };
        let value = serde_json::to_value(&context).expect("serialize relation context");
        assert_eq!(value["relationContext"]["status"], "supported");

        let decoded: AgentModelContext =
            serde_json::from_value(value).expect("deserialize model context");

        assert!(decoded.relation_context.is_none());
    }

    #[test]
    fn deterministic_read_only_explore_grounds_daily_aggregation_in_real_schema() {
        let mut gateway =
            DeterministicReadOnlyExploreAgentModelGateway::new("按天汇总最近 7 天订单");
        let mut request = AgentModelRequest {
            run_id: "run-explore".to_string(),
            task: AgentTaskKind::Assistant,
            context: AgentModelContext {
                connection_id: Some("demo-reader".to_string()),
                ..AgentModelContext::default()
            },
            evidence_refs: Vec::new(),
        };

        let search =
            parse_model_response("run-explore", &gateway.generate(&request).unwrap()).unwrap();
        let AgentModelResponse::ToolCall(search) = search else {
            panic!("expected schema search");
        };
        assert_eq!(search.tool, "schema.search");
        assert_eq!(search.arguments["query"], "按天汇总最近 7 天订单");

        request.context.schema = vec![AgentModelSchemaTable {
            schema: Some("main".to_string()),
            name: "orders".to_string(),
            columns: vec![
                "id".to_string(),
                "user_id".to_string(),
                "amount".to_string(),
                "created_at".to_string(),
            ],
        }];
        request.evidence_refs.push("evidence-schema".to_string());
        let parse =
            parse_model_response("run-explore", &gateway.generate(&request).unwrap()).unwrap();
        let AgentModelResponse::ToolCall(parse) = parse else {
            panic!("expected SQL parse");
        };
        assert_eq!(parse.tool, "sql.parse");
        let sql = parse.arguments["sql"].as_str().unwrap().to_string();
        assert!(sql.contains("SUM(\"amount\")"));
        assert!(sql.contains("date(\"created_at\")"));
        assert!(sql.contains("-6 days"));
        assert!(!sql.contains("SELECT 1"));

        request.evidence_refs.push("evidence-analysis".to_string());
        let execute =
            parse_model_response("run-explore", &gateway.generate(&request).unwrap()).unwrap();
        let AgentModelResponse::ToolCall(execute) = execute else {
            panic!("expected read-only execution");
        };
        assert_eq!(execute.tool, "sql.execute_readonly");
        assert_eq!(execute.arguments["sql"], sql);

        request.context.result_ref = Some("result-7".to_string());
        request.context.result_shape = Some(AgentModelResultShape {
            columns: vec![
                AgentModelResultShapeColumn {
                    name: "order_day".to_string(),
                    ordinal: 0,
                },
                AgentModelResultShapeColumn {
                    name: "total_amount".to_string(),
                    ordinal: 1,
                },
            ],
            row_count: 3,
            elapsed_ms: 2,
            truncated: false,
        });
        request.evidence_refs.push("evidence-result".to_string());
        let inspect =
            parse_model_response("run-explore", &gateway.generate(&request).unwrap()).unwrap();
        let AgentModelResponse::ToolCall(inspect) = inspect else {
            panic!("expected result inspection");
        };
        assert_eq!(inspect.tool, "result.inspect");
        assert_eq!(inspect.arguments["resultRef"], "result-7");

        request.evidence_refs.push("evidence-inspect".to_string());
        let final_response =
            parse_model_response("run-explore", &gateway.generate(&request).unwrap()).unwrap();
        let AgentModelResponse::Final(final_response) = final_response else {
            panic!("expected evidence answer");
        };
        assert_eq!(final_response.sql.as_deref(), Some(sql.as_str()));
        assert!(final_response.content.contains("3 row(s)"));
        assert!(final_response.content.contains("not truncated"));
    }

    #[test]
    fn result_shape_context_serializes_metadata_without_rows() {
        let context = AgentModelContext {
            result_shape: Some(AgentModelResultShape {
                columns: vec![AgentModelResultShapeColumn {
                    name: "id".to_string(),
                    ordinal: 0,
                }],
                row_count: 2,
                elapsed_ms: 4,
                truncated: false,
            }),
            ..AgentModelContext::default()
        };
        let serialized = serde_json::to_string(&context).unwrap();
        assert!(serialized.contains("resultShape"));
        assert!(!serialized.contains("rows"));
        assert!(!serialized.contains("secret"));
    }

    #[test]
    fn fix_error_model_contract_uses_fix_error_and_structured_error_context() {
        let request = AgentModelRequest {
            run_id: "run-fix".to_string(),
            task: AgentTaskKind::FixError,
            context: AgentModelContext {
                sql: Some("SELECT missing FROM orders".to_string()),
                error_context: Some(AgentModelErrorContext {
                    code: Some("no_such_column".to_string()),
                    message: "no such column: missing".to_string(),
                    detail: Some("orders exposes id and total".to_string()),
                }),
                ..AgentModelContext::default()
            },
            evidence_refs: Vec::new(),
        };
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["task"], "fix_error");
        assert_eq!(value["context"]["errorContext"]["code"], "no_such_column");
        assert_eq!(
            value["context"]["errorContext"]["message"],
            "no such column: missing"
        );
        assert!(!value.to_string().contains("rows"));
    }

    #[test]
    fn deterministic_fix_error_replaces_missing_column_with_real_schema_column() {
        let mut gateway = DeterministicAgentModelGateway;
        let raw = gateway
            .generate(&AgentModelRequest {
                run_id: "run-fix".to_string(),
                task: AgentTaskKind::FixError,
                context: AgentModelContext {
                    sql: Some("SELECT totl FROM orders".to_string()),
                    error_context: Some(AgentModelErrorContext {
                        code: Some("no_such_column".to_string()),
                        message: "no such column: totl".to_string(),
                        detail: Some("orders exposes id and total".to_string()),
                    }),
                    schema: vec![AgentModelSchemaTable {
                        schema: Some("main".to_string()),
                        name: "orders".to_string(),
                        columns: vec!["id".to_string(), "total".to_string()],
                    }],
                    ..AgentModelContext::default()
                },
                evidence_refs: Vec::new(),
            })
            .unwrap();
        let AgentModelResponse::Final(response) = parse_model_response("run-fix", &raw).unwrap()
        else {
            panic!("expected a final response");
        };
        let draft = response.sql.expect("FixError should return a SQL draft");
        assert_eq!(draft, "SELECT total FROM orders");
        assert!(response.content.contains("no_such_column"));
        assert!(response.content.contains("no such column: totl"));
        assert!(response.content.contains("never executed"));
    }

    #[test]
    fn deterministic_fix_error_preserves_qualified_column_reference() {
        let context = AgentModelContext {
            sql: Some("SELECT orders.totl FROM orders".to_string()),
            error_context: Some(AgentModelErrorContext {
                code: Some("no_such_column".to_string()),
                message: "no such column: orders.totl".to_string(),
                detail: None,
            }),
            schema: vec![AgentModelSchemaTable {
                schema: Some("main".to_string()),
                name: "orders".to_string(),
                columns: vec!["total".to_string()],
            }],
            ..AgentModelContext::default()
        };

        assert_eq!(
            deterministic_fix_query(&context).as_deref(),
            Some("SELECT orders.total FROM orders")
        );
    }

    #[test]
    fn deterministic_fix_error_does_not_replace_missing_column_inside_string_literal() {
        let context = AgentModelContext {
            sql: Some("SELECT 'totl', totl FROM orders".to_string()),
            error_context: Some(AgentModelErrorContext {
                code: Some("no_such_column".to_string()),
                message: "no such column: totl".to_string(),
                detail: None,
            }),
            schema: vec![AgentModelSchemaTable {
                schema: Some("main".to_string()),
                name: "orders".to_string(),
                columns: vec!["total".to_string()],
            }],
            ..AgentModelContext::default()
        };

        assert_eq!(
            deterministic_fix_query(&context).as_deref(),
            Some("SELECT 'totl', total FROM orders")
        );
    }

    #[test]
    fn deterministic_fix_error_does_not_replace_missing_column_inside_line_comment() {
        let context = AgentModelContext {
            sql: Some("SELECT totl -- keep totl in explanation\nFROM orders".to_string()),
            error_context: Some(AgentModelErrorContext {
                code: Some("no_such_column".to_string()),
                message: "no such column: totl".to_string(),
                detail: None,
            }),
            schema: vec![AgentModelSchemaTable {
                schema: Some("main".to_string()),
                name: "orders".to_string(),
                columns: vec!["total".to_string()],
            }],
            ..AgentModelContext::default()
        };

        assert_eq!(
            deterministic_fix_query(&context).as_deref(),
            Some("SELECT total -- keep totl in explanation\nFROM orders")
        );
    }

    #[test]
    fn deterministic_fix_error_does_not_replace_missing_column_inside_block_comment() {
        let context = AgentModelContext {
            sql: Some("SELECT /* totl is invalid */ totl FROM orders".to_string()),
            error_context: Some(AgentModelErrorContext {
                code: Some("no_such_column".to_string()),
                message: "no such column: totl".to_string(),
                detail: None,
            }),
            schema: vec![AgentModelSchemaTable {
                schema: Some("main".to_string()),
                name: "orders".to_string(),
                columns: vec!["total".to_string()],
            }],
            ..AgentModelContext::default()
        };

        assert_eq!(
            deterministic_fix_query(&context).as_deref(),
            Some("SELECT /* totl is invalid */ total FROM orders")
        );
    }

    #[test]
    fn deterministic_fix_error_ignores_table_names_inside_comments() {
        let context = AgentModelContext {
            sql: Some("SELECT totl /* orders */".to_string()),
            error_context: Some(AgentModelErrorContext {
                code: Some("no_such_column".to_string()),
                message: "no such column: totl".to_string(),
                detail: None,
            }),
            schema: vec![
                AgentModelSchemaTable {
                    schema: Some("main".to_string()),
                    name: "orders".to_string(),
                    columns: vec!["total".to_string()],
                },
                AgentModelSchemaTable {
                    schema: Some("main".to_string()),
                    name: "customers".to_string(),
                    columns: vec!["name".to_string()],
                },
            ],
            ..AgentModelContext::default()
        };

        assert_eq!(
            deterministic_fix_query(&context).as_deref(),
            Some("SELECT totl /* orders */")
        );
    }

    #[test]
    fn deterministic_fix_error_preserves_sql_when_table_mapping_is_ambiguous() {
        let context = AgentModelContext {
            sql: Some("SELECT missing".to_string()),
            error_context: Some(AgentModelErrorContext {
                code: Some("no_such_column".to_string()),
                message: "no such column: missing".to_string(),
                detail: None,
            }),
            schema: vec![
                AgentModelSchemaTable {
                    schema: Some("main".to_string()),
                    name: "orders".to_string(),
                    columns: vec!["id".to_string()],
                },
                AgentModelSchemaTable {
                    schema: Some("main".to_string()),
                    name: "users".to_string(),
                    columns: vec!["user_id".to_string()],
                },
            ],
            ..AgentModelContext::default()
        };

        assert_eq!(
            deterministic_fix_query(&context).as_deref(),
            Some("SELECT missing")
        );
    }

    #[test]
    fn deterministic_fix_error_preserves_sql_when_schema_columns_are_unrelated() {
        let context = AgentModelContext {
            sql: Some("SELECT missing FROM orders".to_string()),
            error_context: Some(AgentModelErrorContext {
                code: Some("no_such_column".to_string()),
                message: "no such column: missing".to_string(),
                detail: None,
            }),
            schema: vec![AgentModelSchemaTable {
                schema: Some("main".to_string()),
                name: "orders".to_string(),
                columns: vec!["id".to_string(), "total".to_string()],
            }],
            ..AgentModelContext::default()
        };

        assert_eq!(
            deterministic_fix_query(&context).as_deref(),
            Some("SELECT missing FROM orders")
        );
    }

    #[test]
    fn deterministic_fix_error_preserves_sql_when_column_mapping_is_ambiguous() {
        let context = AgentModelContext {
            sql: Some("SELECT cat FROM orders".to_string()),
            error_context: Some(AgentModelErrorContext {
                code: Some("no_such_column".to_string()),
                message: "no such column: cat".to_string(),
                detail: None,
            }),
            schema: vec![AgentModelSchemaTable {
                schema: Some("main".to_string()),
                name: "orders".to_string(),
                columns: vec!["bat".to_string(), "car".to_string()],
            }],
            ..AgentModelContext::default()
        };

        assert_eq!(
            deterministic_fix_query(&context).as_deref(),
            Some("SELECT cat FROM orders")
        );
    }

    #[test]
    fn deterministic_fix_error_preserves_original_sql_when_no_safe_schema_mapping_exists() {
        let mut gateway = DeterministicAgentModelGateway;
        let raw = gateway
            .generate(&AgentModelRequest {
                run_id: "run-fix".to_string(),
                task: AgentTaskKind::FixError,
                context: AgentModelContext {
                    sql: Some("SELECT 1".to_string()),
                    error_context: Some(AgentModelErrorContext {
                        code: Some("syntax_error".to_string()),
                        message: "near SELECT".to_string(),
                        detail: None,
                    }),
                    schema: vec![AgentModelSchemaTable {
                        schema: Some("main".to_string()),
                        name: "orders".to_string(),
                        columns: vec!["id".to_string(), "total".to_string()],
                    }],
                    ..AgentModelContext::default()
                },
                evidence_refs: Vec::new(),
            })
            .unwrap();
        let AgentModelResponse::Final(response) = parse_model_response("run-fix", &raw).unwrap()
        else {
            panic!("expected a final response");
        };
        assert_eq!(response.sql.as_deref(), Some("SELECT 1"));
    }

    #[test]
    fn deterministic_fix_error_requires_original_sql_and_schema() {
        let mut gateway = DeterministicAgentModelGateway;
        for context in [
            AgentModelContext {
                error_context: Some(AgentModelErrorContext {
                    code: Some("syntax_error".to_string()),
                    message: "near SELECT".to_string(),
                    detail: None,
                }),
                schema: vec![AgentModelSchemaTable {
                    schema: Some("main".to_string()),
                    name: "orders".to_string(),
                    columns: vec!["id".to_string()],
                }],
                ..AgentModelContext::default()
            },
            AgentModelContext {
                sql: Some("SELECT missing FROM orders".to_string()),
                error_context: Some(AgentModelErrorContext {
                    code: Some("no_such_column".to_string()),
                    message: "no such column: missing".to_string(),
                    detail: None,
                }),
                ..AgentModelContext::default()
            },
        ] {
            let raw = gateway
                .generate(&AgentModelRequest {
                    run_id: "run-fix".to_string(),
                    task: AgentTaskKind::FixError,
                    context,
                    evidence_refs: Vec::new(),
                })
                .unwrap();
            let AgentModelResponse::Final(response) =
                parse_model_response("run-fix", &raw).unwrap()
            else {
                panic!("expected a final response");
            };
            assert!(response.sql.is_none());
        }
    }

    #[test]
    fn structured_error_context_round_trips_without_secret_fields() {
        let context = AgentModelContext {
            error_context: Some(AgentModelErrorContext {
                code: Some("query_failed".to_string()),
                message: "no such column: token".to_string(),
                detail: Some("safe local detail".to_string()),
            }),
            ..AgentModelContext::default()
        };
        let serialized = serde_json::to_string(&context).unwrap();
        assert!(serialized.contains("errorContext"));
        assert!(serialized.contains("safe local detail"));
        assert!(!serialized.contains("password"));
        assert!(!serialized.contains("connectionString"));
    }

    #[test]
    fn legacy_error_message_remains_readable_without_typed_context() {
        let decoded: AgentModelContext = serde_json::from_value(json!({
            "dialect": "sqlite",
            "errorMessage": "legacy database error"
        }))
        .unwrap();
        assert_eq!(
            decoded.error_message.as_deref(),
            Some("legacy database error")
        );
        assert!(decoded.error_context.is_none());
    }
}
