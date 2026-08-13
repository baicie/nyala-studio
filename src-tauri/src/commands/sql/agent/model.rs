//! Deterministic model gateway contract for the A2.3 Suggest-only loop.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use super::super::dialect::SqlDialect;
use super::super::sql_lexer::{sql_tokens, SqlToken};
use super::super::types::SqlCommandError;
use super::domain::{redact_sensitive_text, AgentTaskKind, AgentToolCall};

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
    #[serde(default)]
    pub error_context: Option<AgentModelErrorContext>,
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
            error_context: None,
            user_prompt: None,
            explain_plan: None,
            schema: Vec::new(),
            result_shape: None,
        }
    }
}

impl AgentModelContext {
    pub(crate) fn redacted_for_model(&self) -> Self {
        let mut context = self.clone();
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

    #[test]
    fn fix_error_wire_contract_uses_fix_error_and_structured_error_context() {
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
