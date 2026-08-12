//! Deterministic model gateway contract for the A2.3 Suggest-only loop.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use super::super::dialect::SqlDialect;
use super::super::types::SqlCommandError;
use super::domain::{AgentTaskKind, AgentToolCall};

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelContext {
    pub dialect: SqlDialect,
    /// Opaque local connection identity used by A3 SQL tools. It is never
    /// resolved into credentials or serialized database connection details.
    #[serde(default)]
    pub connection_id: Option<String>,
    pub sql: Option<String>,
    pub selected_sql: Option<String>,
    pub error_message: Option<String>,
    pub user_prompt: Option<String>,
    pub explain_plan: Option<String>,
    #[serde(default)]
    pub schema: Vec<AgentModelSchemaTable>,
    #[serde(default)]
    pub result_shape: Option<AgentModelResultShape>,
}

impl Default for AgentModelContext {
    fn default() -> Self {
        Self {
            dialect: SqlDialect::Sqlite,
            connection_id: None,
            sql: None,
            selected_sql: None,
            error_message: None,
            user_prompt: None,
            explain_plan: None,
            schema: Vec::new(),
            result_shape: None,
        }
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
                content: format!(
                    "Review the SQL error with dialect-specific syntax and schema context.{}",
                    request
                        .context
                        .error_message
                        .as_deref()
                        .map(|error| format!(" Error: {error}"))
                        .unwrap_or_default()
                ),
                sql: None,
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
    use serde_json::json;

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
}
