//! A2.2 capability vocabulary and Rust-side Agent tool policy.
//!
//! The Workbench declaration is only a hint. Every model/tool request must
//! pass this table again, so a manifest or model cannot invent a capability or
//! invoke a future query tool during Suggest-only runtime.

#![allow(dead_code)]

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::super::sql_analysis::{analyze_sql, StatementRisk};
use super::super::types::SqlCommandError;
use super::super::SqlDialect;
use super::domain::{AgentMode, AgentToolCall};
use super::result_policy::{MAX_SAMPLE_MAX_BYTES, MAX_SAMPLE_MAX_ROWS};

const MAX_AGENT_TOOL_ARGUMENT_BYTES: usize = 32 * 1024;
const MAX_INDEX_LIST_TABLES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Ord, PartialOrd, Serialize, Deserialize)]
pub enum AgentCapability {
    #[serde(rename = "database.readMetadata")]
    DatabaseReadMetadata,
    #[serde(rename = "database.executeRead")]
    DatabaseExecuteRead,
    #[serde(rename = "database.executeWrite")]
    DatabaseExecuteWrite,
    #[serde(rename = "filesystem.read")]
    FilesystemRead,
    #[serde(rename = "filesystem.write")]
    FilesystemWrite,
    #[serde(rename = "network.request")]
    NetworkRequest,
    #[serde(rename = "agent.tool")]
    AgentTool,
    #[serde(rename = "workspace.readSql")]
    WorkspaceReadSql,
    #[serde(rename = "database.readResultShape")]
    DatabaseReadResultShape,
    #[serde(rename = "database.readResultSample")]
    DatabaseReadResultSample,
    #[serde(rename = "database.explain")]
    DatabaseExplain,
    #[serde(rename = "history.read")]
    HistoryRead,
}

impl AgentCapability {
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::DatabaseReadMetadata => "database.readMetadata",
            Self::DatabaseExecuteRead => "database.executeRead",
            Self::DatabaseExecuteWrite => "database.executeWrite",
            Self::FilesystemRead => "filesystem.read",
            Self::FilesystemWrite => "filesystem.write",
            Self::NetworkRequest => "network.request",
            Self::AgentTool => "agent.tool",
            Self::WorkspaceReadSql => "workspace.readSql",
            Self::DatabaseReadResultShape => "database.readResultShape",
            Self::DatabaseReadResultSample => "database.readResultSample",
            Self::DatabaseExplain => "database.explain",
            Self::HistoryRead => "history.read",
        }
    }

    pub fn parse(value: &str) -> Result<Self, SqlCommandError> {
        match value {
            "database.readMetadata" => Ok(Self::DatabaseReadMetadata),
            "database.executeRead" => Ok(Self::DatabaseExecuteRead),
            "database.executeWrite" => Ok(Self::DatabaseExecuteWrite),
            "filesystem.read" => Ok(Self::FilesystemRead),
            "filesystem.write" => Ok(Self::FilesystemWrite),
            "network.request" => Ok(Self::NetworkRequest),
            "agent.tool" => Ok(Self::AgentTool),
            "workspace.readSql" => Ok(Self::WorkspaceReadSql),
            "database.readResultShape" => Ok(Self::DatabaseReadResultShape),
            "database.readResultSample" => Ok(Self::DatabaseReadResultSample),
            "database.explain" => Ok(Self::DatabaseExplain),
            "history.read" => Ok(Self::HistoryRead),
            _ => Err(SqlCommandError::new(
                "invalid_input",
                format!("unknown SQL capability '{value}'"),
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilitySet {
    pub capabilities: BTreeSet<AgentCapability>,
}

impl AgentCapabilitySet {
    pub fn empty() -> Self {
        Self {
            capabilities: BTreeSet::new(),
        }
    }

    pub fn from_capabilities(capabilities: impl IntoIterator<Item = AgentCapability>) -> Self {
        Self {
            capabilities: capabilities.into_iter().collect(),
        }
    }

    pub fn from_wire(values: impl IntoIterator<Item = String>) -> Result<Self, SqlCommandError> {
        values
            .into_iter()
            .map(|value| AgentCapability::parse(&value))
            .collect::<Result<BTreeSet<_>, _>>()
            .map(|capabilities| Self { capabilities })
    }

    pub fn contains(&self, capability: AgentCapability) -> bool {
        self.capabilities.contains(&capability)
    }

    pub fn intersection(&self, allowed: &Self) -> Self {
        Self::from_capabilities(
            self.capabilities
                .intersection(&allowed.capabilities)
                .copied(),
        )
    }

    pub fn wire_names(&self) -> Vec<&'static str> {
        self.capabilities
            .iter()
            .map(|capability| capability.wire_name())
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTool {
    #[serde(rename = "workspace.current")]
    WorkspaceCurrent,
    #[serde(rename = "schema.search")]
    SchemaSearch,
    #[serde(rename = "table.describe")]
    TableDescribe,
    #[serde(rename = "relation.search")]
    RelationSearch,
    #[serde(rename = "index.list")]
    IndexList,
    #[serde(rename = "sql.parse")]
    SqlParse,
    #[serde(rename = "sql.validate")]
    SqlValidate,
    #[serde(rename = "sql.explain")]
    SqlExplain,
    #[serde(rename = "sql.execute_readonly")]
    SqlExecuteReadonly,
    #[serde(rename = "result.inspect")]
    ResultInspect,
    #[serde(rename = "result.sample")]
    ResultSample,
    #[serde(rename = "history.search")]
    HistorySearch,
}

impl AgentTool {
    pub fn parse(value: &str) -> Result<Self, SqlCommandError> {
        match value {
            "workspace.current" => Ok(Self::WorkspaceCurrent),
            "schema.search" => Ok(Self::SchemaSearch),
            "table.describe" => Ok(Self::TableDescribe),
            "relation.search" => Ok(Self::RelationSearch),
            "index.list" => Ok(Self::IndexList),
            "sql.parse" => Ok(Self::SqlParse),
            "sql.validate" => Ok(Self::SqlValidate),
            "sql.explain" => Ok(Self::SqlExplain),
            "sql.execute_readonly" => Ok(Self::SqlExecuteReadonly),
            "result.inspect" => Ok(Self::ResultInspect),
            "result.sample" => Ok(Self::ResultSample),
            "history.search" => Ok(Self::HistorySearch),
            _ => Err(SqlCommandError::new(
                "invalid_input",
                format!("unknown Agent tool '{value}'"),
            )),
        }
    }

    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::WorkspaceCurrent => "workspace.current",
            Self::SchemaSearch => "schema.search",
            Self::TableDescribe => "table.describe",
            Self::RelationSearch => "relation.search",
            Self::IndexList => "index.list",
            Self::SqlParse => "sql.parse",
            Self::SqlValidate => "sql.validate",
            Self::SqlExplain => "sql.explain",
            Self::SqlExecuteReadonly => "sql.execute_readonly",
            Self::ResultInspect => "result.inspect",
            Self::ResultSample => "result.sample",
            Self::HistorySearch => "history.search",
        }
    }

    fn required_capability(self) -> AgentCapability {
        match self {
            Self::WorkspaceCurrent => AgentCapability::WorkspaceReadSql,
            Self::SchemaSearch | Self::TableDescribe | Self::RelationSearch | Self::IndexList => {
                AgentCapability::DatabaseReadMetadata
            }
            Self::SqlParse | Self::SqlValidate => AgentCapability::AgentTool,
            Self::SqlExplain => AgentCapability::DatabaseExplain,
            Self::SqlExecuteReadonly => AgentCapability::DatabaseExecuteRead,
            Self::ResultInspect => AgentCapability::DatabaseReadResultShape,
            Self::ResultSample => AgentCapability::DatabaseReadResultSample,
            Self::HistorySearch => AgentCapability::HistoryRead,
        }
    }

    fn enabled_in_a2(self, mode: AgentMode) -> bool {
        matches!(
            (mode, self),
            (
                AgentMode::SuggestOnly | AgentMode::ReadOnly,
                Self::WorkspaceCurrent
                    | Self::SchemaSearch
                    | Self::TableDescribe
                    | Self::RelationSearch
                    | Self::IndexList
                    | Self::SqlParse
                    | Self::SqlValidate
            )
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAuthorizedTool {
    pub run_id: String,
    pub call_id: String,
    pub tool: AgentTool,
    pub arguments: serde_json::Value,
    pub required_capability: AgentCapability,
}

#[derive(Debug, Clone)]
pub struct AgentPolicy {
    mode: AgentMode,
    capabilities: AgentCapabilitySet,
}

impl AgentPolicy {
    pub fn new(mode: AgentMode, capabilities: AgentCapabilitySet) -> Self {
        Self { mode, capabilities }
    }

    pub fn authorize(&self, call: &AgentToolCall) -> Result<AgentAuthorizedTool, SqlCommandError> {
        let tool = AgentTool::parse(&call.tool)?;
        if !tool.enabled_in_a2(self.mode) {
            return Err(SqlCommandError::new(
                "invalid_input",
                format!(
                    "Agent tool '{}' is not enabled in A2 runtime",
                    tool.wire_name()
                ),
            ));
        }
        let required_capability = tool.required_capability();
        if !self.capabilities.contains(required_capability) {
            return Err(SqlCommandError::new(
                "invalid_input",
                format!(
                    "Agent tool '{}' requires capability '{}'",
                    tool.wire_name(),
                    required_capability.wire_name()
                ),
            ));
        }
        let argument_bytes = serde_json::to_vec(&call.arguments)
            .map_err(|error| SqlCommandError::new("invalid_input", error.to_string()))?
            .len();
        if argument_bytes > MAX_AGENT_TOOL_ARGUMENT_BYTES {
            return Err(SqlCommandError::new(
                "invalid_input",
                format!("Agent tool arguments exceed {MAX_AGENT_TOOL_ARGUMENT_BYTES} bytes"),
            ));
        }
        if tool == AgentTool::IndexList {
            validate_index_list_arguments(&call.arguments)?;
        }
        Ok(AgentAuthorizedTool {
            run_id: call.run_id.clone(),
            call_id: call.call_id.clone(),
            tool,
            arguments: call.arguments.clone(),
            required_capability,
        })
    }

    /// A3-only authorization for database-backed read-only and result tools.
    /// Static SQL safety and the `SQLite` connection/read-only checks happen in
    /// `agent::read_only`; this method keeps capability and mode enforcement
    /// at the model/tool boundary.
    pub fn authorize_read_only(
        &self,
        call: &AgentToolCall,
    ) -> Result<AgentAuthorizedTool, SqlCommandError> {
        let tool = AgentTool::parse(&call.tool)?;
        if self.mode != AgentMode::ReadOnly
            || !matches!(
                tool,
                AgentTool::IndexList
                    | AgentTool::SqlExplain
                    | AgentTool::SqlExecuteReadonly
                    | AgentTool::ResultInspect
                    | AgentTool::ResultSample
            )
        {
            return Err(SqlCommandError::new(
                "invalid_input",
                format!(
                    "Agent tool '{}' requires A3 Read Only mode",
                    tool.wire_name()
                ),
            ));
        }
        let required_capability = tool.required_capability();
        if !self.capabilities.contains(required_capability) {
            return Err(SqlCommandError::new(
                "invalid_input",
                format!(
                    "Agent tool '{}' requires capability '{}'",
                    tool.wire_name(),
                    required_capability.wire_name()
                ),
            ));
        }
        let argument_bytes = serde_json::to_vec(&call.arguments)
            .map_err(|error| SqlCommandError::new("invalid_input", error.to_string()))?
            .len();
        if argument_bytes > MAX_AGENT_TOOL_ARGUMENT_BYTES {
            return Err(SqlCommandError::new(
                "invalid_input",
                format!("Agent tool arguments exceed {MAX_AGENT_TOOL_ARGUMENT_BYTES} bytes"),
            ));
        }
        validate_read_only_arguments(tool, &call.arguments)?;
        Ok(AgentAuthorizedTool {
            run_id: call.run_id.clone(),
            call_id: call.call_id.clone(),
            tool,
            arguments: call.arguments.clone(),
            required_capability,
        })
    }
}

fn validate_read_only_arguments(
    tool: AgentTool,
    arguments: &serde_json::Value,
) -> Result<(), SqlCommandError> {
    if tool == AgentTool::IndexList {
        return validate_index_list_arguments(arguments);
    }
    if matches!(tool, AgentTool::ResultInspect | AgentTool::ResultSample) {
        let result_ref = arguments
            .get("resultRef")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                SqlCommandError::new("invalid_input", "result tool requires a resultRef")
            })?;
        if result_ref.contains('\0') {
            return Err(SqlCommandError::new(
                "invalid_input",
                "resultRef must not contain NUL",
            ));
        }
        if arguments.get("rows").is_some() {
            return Err(SqlCommandError::new(
                "validation",
                "result tool arguments must not contain result rows",
            ));
        }
        if tool == AgentTool::ResultSample {
            if arguments
                .get("approved")
                .and_then(serde_json::Value::as_bool)
                != Some(true)
            {
                return Err(SqlCommandError::new(
                    "validation",
                    "result.sample requires explicit user approval",
                ));
            }
            let max_rows = arguments
                .get("maxRows")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(20);
            let max_bytes = arguments
                .get("maxBytes")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(16 * 1024);
            if max_rows == 0 || max_rows > MAX_SAMPLE_MAX_ROWS as u64 {
                return Err(SqlCommandError::new(
                    "invalid_input",
                    format!("sample row cap must be between 1 and {MAX_SAMPLE_MAX_ROWS}"),
                ));
            }
            if max_bytes == 0 || max_bytes > MAX_SAMPLE_MAX_BYTES as u64 {
                return Err(SqlCommandError::new(
                    "invalid_input",
                    format!("sample byte cap must be between 1 and {MAX_SAMPLE_MAX_BYTES}"),
                ));
            }
        }
        return Ok(());
    }

    let dialect = arguments
        .get("dialect")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            SqlCommandError::new("invalid_input", "A3 SQL tool requires sqlite dialect")
        })?;
    if dialect != "sqlite" {
        return Err(SqlCommandError::new(
            "validation",
            "A3 SQL tools support SQLite only",
        ));
    }
    let sql = arguments
        .get("sql")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            SqlCommandError::new("invalid_input", "A3 SQL tool requires a sql string")
        })?;
    let analysis = analyze_sql(sql, SqlDialect::Sqlite);
    let allowed = match tool {
        AgentTool::SqlExplain => {
            analysis.statement_count == 1
                && matches!(
                    analysis.risk,
                    StatementRisk::ReadOnly | StatementRisk::ExplainReadOnly
                )
        }
        AgentTool::SqlExecuteReadonly => {
            analysis.statement_count == 1 && analysis.risk == StatementRisk::ReadOnly
        }
        _ => true,
    };
    if !allowed {
        return Err(SqlCommandError::new(
            "validation",
            "A3 SQL tool only allows one read-only SQLite statement",
        ));
    }
    Ok(())
}

fn validate_index_list_arguments(arguments: &serde_json::Value) -> Result<(), SqlCommandError> {
    let connection_id = arguments
        .get("connectionId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.contains('\0'))
        .ok_or_else(|| {
            SqlCommandError::new("invalid_input", "index.list requires a connectionId")
        })?;
    let _ = connection_id;
    let dialect = arguments
        .get("dialect")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| SqlCommandError::new("invalid_input", "index.list requires a dialect"))?;
    if dialect != "sqlite" {
        return Err(SqlCommandError::new(
            "validation",
            "index.list supports SQLite only",
        ));
    }
    let schema = arguments
        .get("schema")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.contains('\0'))
        .ok_or_else(|| SqlCommandError::new("invalid_input", "index.list requires a schema"))?;
    if schema != "main" {
        return Err(SqlCommandError::new(
            "validation",
            "index.list only supports the SQLite 'main' schema",
        ));
    }
    let tables = arguments
        .get("tables")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| SqlCommandError::new("invalid_input", "index.list requires tables"))?;
    if tables.is_empty() || tables.len() > MAX_INDEX_LIST_TABLES {
        return Err(SqlCommandError::new(
            "invalid_input",
            format!("index.list tables must contain between 1 and {MAX_INDEX_LIST_TABLES} entries"),
        ));
    }
    for table in tables {
        let name = table
            .get("name")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && !value.contains('\0'))
            .ok_or_else(|| {
                SqlCommandError::new("invalid_input", "index.list table requires a name")
            })?;
        let _ = name;
        if table
            .get("schema")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|table_schema| table_schema.trim() != schema)
        {
            return Err(SqlCommandError::new(
                "validation",
                "index.list table schema must match the requested schema",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(tool: &str, arguments: serde_json::Value) -> AgentToolCall {
        AgentToolCall::new("run-1", "call-1", tool, arguments, vec![]).unwrap()
    }

    #[test]
    fn canonical_wire_capabilities_round_trip_and_reject_unknown_values() {
        let set = AgentCapabilitySet::from_wire(vec![
            "agent.tool".to_string(),
            "workspace.readSql".to_string(),
            "workspace.readSql".to_string(),
        ])
        .unwrap();
        assert_eq!(set.capabilities.len(), 2);
        assert_eq!(set.wire_names(), vec!["agent.tool", "workspace.readSql"]);
        assert!(AgentCapabilitySet::from_wire(vec!["agent.all".to_string()]).is_err());
    }

    #[test]
    fn capability_intersection_cannot_add_a_backend_grant() {
        let requested = AgentCapabilitySet::from_capabilities([
            AgentCapability::AgentTool,
            AgentCapability::DatabaseReadMetadata,
        ]);
        let backend_grant = AgentCapabilitySet::from_capabilities([
            AgentCapability::AgentTool,
            AgentCapability::WorkspaceReadSql,
        ]);

        let effective = requested.intersection(&backend_grant);

        assert_eq!(effective.wire_names(), vec!["agent.tool"]);
    }

    #[test]
    fn policy_allows_only_declared_a2_tool_capabilities() {
        let policy = AgentPolicy::new(
            AgentMode::SuggestOnly,
            AgentCapabilitySet::from_capabilities([
                AgentCapability::WorkspaceReadSql,
                AgentCapability::AgentTool,
            ]),
        );
        assert_eq!(
            policy
                .authorize(&call("workspace.current", json!({})))
                .unwrap()
                .tool,
            AgentTool::WorkspaceCurrent
        );
        assert_eq!(
            policy
                .authorize(&call("sql.parse", json!({"sql": "SELECT 1"})))
                .unwrap()
                .tool,
            AgentTool::SqlParse
        );
        assert!(policy.authorize(&call("schema.search", json!({}))).is_err());
    }

    #[test]
    fn future_query_tools_are_denied_even_when_manifest_declares_execute_capability() {
        let policy = AgentPolicy::new(
            AgentMode::ReadOnly,
            AgentCapabilitySet::from_capabilities([
                AgentCapability::DatabaseExecuteRead,
                AgentCapability::DatabaseExplain,
            ]),
        );
        let execute_error = policy
            .authorize(&call("sql.execute_readonly", json!({"sql": "SELECT 1"})))
            .unwrap_err();
        let explain_error = policy
            .authorize(&call("sql.explain", json!({"sql": "SELECT 1"})))
            .unwrap_err();
        assert!(execute_error.to_string().contains("not enabled"));
        assert!(explain_error.to_string().contains("not enabled"));
    }

    #[test]
    fn unknown_model_tool_is_denied_before_capability_lookup() {
        let policy = AgentPolicy::new(
            AgentMode::SuggestOnly,
            AgentCapabilitySet::from_capabilities([AgentCapability::AgentTool]),
        );
        let error = policy.authorize(&call("tauri.invoke", json!({"command": "sql_query"})));
        assert!(error.is_err());
        assert!(error
            .unwrap_err()
            .to_string()
            .contains("unknown Agent tool"));
    }

    #[test]
    fn oversized_arguments_are_rejected_after_tool_and_capability_checks() {
        let policy = AgentPolicy::new(
            AgentMode::SuggestOnly,
            AgentCapabilitySet::from_capabilities([AgentCapability::AgentTool]),
        );
        let error = policy
            .authorize(&call("sql.parse", json!({"sql": "x".repeat(40 * 1024)})))
            .unwrap_err();
        assert!(error.to_string().contains("arguments exceed"));
    }

    #[test]
    fn read_only_policy_allows_only_a3_sql_tools_with_matching_capabilities() {
        let policy = AgentPolicy::new(
            AgentMode::ReadOnly,
            AgentCapabilitySet::from_capabilities([
                AgentCapability::DatabaseExecuteRead,
                AgentCapability::DatabaseExplain,
            ]),
        );
        assert_eq!(
            policy
                .authorize_read_only(&call(
                    "sql.execute_readonly",
                    json!({"dialect": "sqlite", "sql": "SELECT 1"}),
                ))
                .unwrap()
                .tool,
            AgentTool::SqlExecuteReadonly
        );
        assert_eq!(
            policy
                .authorize_read_only(&call(
                    "sql.explain",
                    json!({"dialect": "sqlite", "sql": "SELECT 1"}),
                ))
                .unwrap()
                .tool,
            AgentTool::SqlExplain
        );
        let write_error = policy
            .authorize_read_only(&call(
                "sql.execute_readonly",
                json!({"dialect": "sqlite", "sql": "INSERT INTO users VALUES (1)"}),
            ))
            .unwrap_err();
        assert!(write_error.to_string().contains("read-only SQLite"));
    }

    #[test]
    fn index_list_requires_metadata_capability_and_bounded_sqlite_scope() {
        let arguments = json!({
            "connectionId": "workspace",
            "dialect": "sqlite",
            "schema": "main",
            "tables": [{"schema": "main", "name": "users"}]
        });
        let missing_capability = AgentPolicy::new(
            AgentMode::ReadOnly,
            AgentCapabilitySet::from_capabilities([AgentCapability::DatabaseExplain]),
        )
        .authorize_read_only(&call("index.list", arguments.clone()))
        .unwrap_err();
        assert!(missing_capability
            .to_string()
            .contains("database.readMetadata"));

        let policy = AgentPolicy::new(
            AgentMode::ReadOnly,
            AgentCapabilitySet::from_capabilities([AgentCapability::DatabaseReadMetadata]),
        );
        let authorized = policy
            .authorize_read_only(&call("index.list", arguments))
            .expect("authorize bounded SQLite index metadata");
        assert_eq!(authorized.tool, AgentTool::IndexList);
        assert_eq!(
            authorized.required_capability,
            AgentCapability::DatabaseReadMetadata
        );

        for invalid in [
            json!({
                "connectionId": "workspace",
                "dialect": "mysql",
                "schema": "main",
                "tables": [{"name": "users"}]
            }),
            json!({
                "connectionId": "workspace",
                "dialect": "sqlite",
                "schema": "temp",
                "tables": [{"name": "users"}]
            }),
            json!({
                "connectionId": "workspace",
                "dialect": "sqlite",
                "schema": "main",
                "tables": []
            }),
            json!({
                "connectionId": "workspace",
                "dialect": "sqlite",
                "schema": "main",
                "tables": [{"schema": "other", "name": "users"}]
            }),
        ] {
            assert!(policy
                .authorize_read_only(&call("index.list", invalid))
                .is_err());
        }
    }

    #[test]
    fn suggest_only_policy_authorizes_index_list_without_query_capability() {
        let policy = AgentPolicy::new(
            AgentMode::SuggestOnly,
            AgentCapabilitySet::from_capabilities([AgentCapability::DatabaseReadMetadata]),
        );

        let authorized = policy
            .authorize(&call(
                "index.list",
                json!({
                    "connectionId": "workspace",
                    "dialect": "sqlite",
                    "schema": "main",
                    "tables": [{"name": "users"}]
                }),
            ))
            .expect("authorize metadata-only index list");

        assert_eq!(authorized.tool, AgentTool::IndexList);
        assert_eq!(
            authorized.required_capability,
            AgentCapability::DatabaseReadMetadata
        );
    }

    #[test]
    fn read_only_policy_rejects_suggest_only_mode() {
        let policy = AgentPolicy::new(
            AgentMode::SuggestOnly,
            AgentCapabilitySet::from_capabilities([AgentCapability::DatabaseExecuteRead]),
        );
        let error = policy
            .authorize_read_only(&call(
                "sql.execute_readonly",
                json!({"dialect": "sqlite", "sql": "SELECT 1"}),
            ))
            .unwrap_err();
        assert!(error.to_string().contains("A3 Read Only mode"));
    }

    #[test]
    fn result_policy_requires_refs_and_explicit_sample_approval() {
        let policy = AgentPolicy::new(
            AgentMode::ReadOnly,
            AgentCapabilitySet::from_capabilities([
                AgentCapability::DatabaseReadResultShape,
                AgentCapability::DatabaseReadResultSample,
            ]),
        );
        assert_eq!(
            policy
                .authorize_read_only(&call("result.inspect", json!({"resultRef": "result-1"}),))
                .unwrap()
                .tool,
            AgentTool::ResultInspect
        );
        let approval_error = policy
            .authorize_read_only(&call(
                "result.sample",
                json!({"resultRef": "result-1", "approved": false}),
            ))
            .unwrap_err();
        assert!(approval_error.to_string().contains("approval"));
        let rows_error = policy
            .authorize_read_only(&call(
                "result.inspect",
                json!({"resultRef": "result-1", "rows": [[1]]}),
            ))
            .unwrap_err();
        assert!(rows_error
            .to_string()
            .contains("must not contain result rows"));
        assert!(policy
            .authorize_read_only(&call(
                "result.sample",
                json!({"resultRef": "result-1", "approved": true, "maxRows": 2}),
            ))
            .is_ok());
    }
}
