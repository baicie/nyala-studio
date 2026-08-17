//! Local metadata and static-analysis tools for Suggest-only Agent runs.

#![allow(dead_code)]

use std::collections::BTreeSet;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::json;

use crate::runtime_status::RuntimeStatus;

use super::super::connection_manager::SharedConnectionManager;
use super::super::dialect::SqlDialect;
use super::super::sql_analysis::SqlTableRef;
use super::super::state::SqlConnectionStore;
use super::super::types::SqlCommandError;
use super::core_adapter::{
    IndexListBudget, IndexListRequest, LocalSqlCoreAdapter, SqlCapabilitySupport, SqlCoreAdapter,
};
use super::evidence::{AgentEvidenceKind, AgentEvidenceSensitivity};
use super::model::{AgentModelContext, AgentModelRelationContext, AgentModelSchemaTable};
use super::plan::SqlitePlanIdentity;
use super::policy::{AgentAuthorizedTool, AgentTool};
use super::relation_context::{RelationSearchBudget, RelationSearchRequest};
use super::runtime::{
    execute_context_suggest_tool, SuggestOnlyAgentToolExecution, SuggestOnlyAgentToolExecutor,
};
use super::schema_context::{SchemaSearchBudget, SchemaSearchRequest};

const MAX_DISCOVERY_TERMS: usize = 16;
const MAX_DISCOVERY_TABLES: usize = 32;

pub struct LocalSuggestOnlyAgentToolExecutor {
    adapter: LocalSqlCoreAdapter,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RelationSearchArguments {
    connection_id: String,
    schema: String,
    tables: Vec<RelationSearchTableArgument>,
    max_depth: u8,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RelationSearchTableArgument {
    #[serde(default)]
    schema: Option<String>,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IndexListArguments {
    connection_id: String,
    dialect: String,
    schema: String,
    tables: Vec<RelationSearchTableArgument>,
}

struct SchemaDiscovery {
    explicit_tables: Vec<SqlTableRef>,
    identities: BTreeSet<(String, String)>,
}

impl LocalSuggestOnlyAgentToolExecutor {
    pub fn new(
        metadata_manager: SharedConnectionManager,
        legacy_store: Arc<SqlConnectionStore>,
    ) -> Self {
        Self {
            adapter: LocalSqlCoreAdapter::new(metadata_manager, legacy_store),
        }
    }

    pub(crate) fn sqlite_plan_identity(
        &self,
        connection_id: &str,
    ) -> Result<SqlitePlanIdentity, SqlCommandError> {
        let capabilities = self.adapter.runtime_capabilities(connection_id)?;
        if capabilities.connection_id != connection_id.trim()
            || capabilities.dialect != SqlDialect::Sqlite
            || capabilities.status != RuntimeStatus::Stable
            || !capabilities.read_only
        {
            return Err(SqlCommandError::new(
                "validation",
                "normalized plans require the matching Stable read-only SQLite runtime",
            ));
        }
        SqlitePlanIdentity::new(capabilities.connection_id, capabilities.metadata_revision)
    }

    fn discover_schema_tables(
        &self,
        connection_id: &str,
        schema: &str,
        query: &str,
    ) -> Result<SchemaDiscovery, SqlCommandError> {
        let mut explicit_tables = Vec::new();
        let mut identities = BTreeSet::new();
        for term in schema_search_terms(query)
            .into_iter()
            .take(MAX_DISCOVERY_TERMS)
        {
            let discovery = self.adapter.search_schema(SchemaSearchRequest {
                connection_id: connection_id.to_string(),
                schema: schema.to_string(),
                query: term,
                explicit_tables: Vec::new(),
                budget: SchemaSearchBudget {
                    max_objects: 8,
                    max_columns: 8,
                    max_bytes: 8 * 1024,
                },
            })?;
            for matched in discovery.matches {
                let identity = (
                    matched.object.schema.to_lowercase(),
                    matched.object.name.to_lowercase(),
                );
                if identities.insert(identity) {
                    explicit_tables.push(SqlTableRef {
                        schema: Some(matched.object.schema),
                        name: matched.object.name,
                    });
                }
                if explicit_tables.len() == MAX_DISCOVERY_TABLES {
                    break;
                }
            }
            if explicit_tables.len() == MAX_DISCOVERY_TABLES {
                break;
            }
        }
        Ok(SchemaDiscovery {
            explicit_tables,
            identities,
        })
    }

    fn search_schema(
        &self,
        authorized: &AgentAuthorizedTool,
        context: &AgentModelContext,
    ) -> Result<SuggestOnlyAgentToolExecution, SqlCommandError> {
        let connection_id = required_string(&authorized.arguments, "connectionId")?;
        let expected_connection_id = context.connection_id.as_deref().ok_or_else(|| {
            SqlCommandError::new("invalid_input", "schema.search requires connection context")
        })?;
        if connection_id != expected_connection_id {
            return Err(SqlCommandError::new(
                "validation",
                "schema.search cannot access a connection outside the Agent context",
            ));
        }
        let schema = required_string(&authorized.arguments, "schema")?;
        let query = required_string(&authorized.arguments, "query")?;

        let SchemaDiscovery {
            mut explicit_tables,
            mut identities,
        } = self.discover_schema_tables(connection_id, schema, query)?;

        let seed_result = self.adapter.search_schema(SchemaSearchRequest {
            connection_id: connection_id.to_string(),
            schema: schema.to_string(),
            query: query.to_string(),
            explicit_tables: explicit_tables.clone(),
            budget: SchemaSearchBudget::default(),
        })?;
        validate_schema_search_identity(&seed_result, connection_id, schema, context, None)?;

        let relation_seeds = seed_result
            .matches
            .iter()
            .map(|matched| SqlTableRef {
                schema: Some(matched.object.schema.clone()),
                name: matched.object.name.clone(),
            })
            .collect::<Vec<_>>();
        let relation_context = self.load_relation_context(
            connection_id,
            schema,
            relation_seeds,
            context,
            Some(seed_result.metadata_revision),
            2,
        )?;
        let (expanded, relation_expansion_truncated) = expand_relation_tables(
            &mut explicit_tables,
            &mut identities,
            relation_context.as_ref(),
        );

        let result = if expanded {
            self.adapter.search_schema(SchemaSearchRequest {
                connection_id: connection_id.to_string(),
                schema: schema.to_string(),
                query: query.to_string(),
                explicit_tables,
                budget: SchemaSearchBudget::default(),
            })?
        } else {
            seed_result
        };
        validate_schema_search_identity(
            &result,
            connection_id,
            schema,
            context,
            relation_context.as_ref().and_then(relation_revision),
        )?;
        let schema = agent_schema_tables(&result);
        let mut warnings = result
            .truncated
            .then(|| "Schema evidence was truncated by the metadata budget.".to_string())
            .into_iter()
            .collect::<Vec<_>>();
        if relation_expansion_truncated {
            warnings.push(
                "Schema relation expansion was truncated by the explicit-table budget.".to_string(),
            );
        }
        append_relation_warnings(&mut warnings, relation_context.as_ref());

        Ok(SuggestOnlyAgentToolExecution {
            evidence: vec![(
                AgentEvidenceKind::Schema,
                AgentEvidenceSensitivity::Workspace,
                json!({
                    "tool": authorized.tool.wire_name(),
                    "search": result,
                    "relations": relation_context,
                }),
            )],
            schema: Some(schema),
            relation_context,
            analysis: None,
            index_context: None,
            warnings,
        })
    }

    fn search_relations(
        &self,
        authorized: &AgentAuthorizedTool,
        context: &AgentModelContext,
    ) -> Result<SuggestOnlyAgentToolExecution, SqlCommandError> {
        let arguments: RelationSearchArguments =
            serde_json::from_value(authorized.arguments.clone()).map_err(|error| {
                SqlCommandError::new(
                    "invalid_input",
                    format!("relation.search arguments are invalid: {error}"),
                )
            })?;
        let connection_id = valid_argument_string(&arguments.connection_id, "connectionId")?;
        let expected_connection_id = context.connection_id.as_deref().ok_or_else(|| {
            SqlCommandError::new(
                "invalid_input",
                "relation.search requires connection context",
            )
        })?;
        if connection_id != expected_connection_id {
            return Err(SqlCommandError::new(
                "validation",
                "relation.search cannot access a connection outside the Agent context",
            ));
        }
        let schema = valid_argument_string(&arguments.schema, "schema")?;
        let tables = arguments
            .tables
            .into_iter()
            .map(|table| {
                Ok(SqlTableRef {
                    schema: table
                        .schema
                        .map(|value| {
                            valid_argument_string(&value, "table schema").map(str::to_string)
                        })
                        .transpose()?,
                    name: valid_argument_string(&table.name, "table name")?.to_string(),
                })
            })
            .collect::<Result<Vec<_>, SqlCommandError>>()?;
        if tables.is_empty() {
            return Err(SqlCommandError::new(
                "invalid_input",
                "relation.search requires at least one table",
            ));
        }
        let relation_context = self
            .load_relation_context(
                connection_id,
                schema,
                tables,
                context,
                None,
                arguments.max_depth,
            )?
            .ok_or_else(|| {
                SqlCommandError::new("internal", "relation.search returned no typed context")
            })?;
        let mut warnings = Vec::new();
        append_relation_warnings(&mut warnings, Some(&relation_context));
        Ok(SuggestOnlyAgentToolExecution {
            evidence: vec![(
                AgentEvidenceKind::Schema,
                AgentEvidenceSensitivity::Workspace,
                json!({
                    "tool": authorized.tool.wire_name(),
                    "relations": relation_context,
                }),
            )],
            schema: None,
            relation_context: Some(relation_context),
            analysis: None,
            index_context: None,
            warnings,
        })
    }

    fn list_indexes(
        &self,
        authorized: &AgentAuthorizedTool,
        context: &AgentModelContext,
    ) -> Result<SuggestOnlyAgentToolExecution, SqlCommandError> {
        let arguments: IndexListArguments = serde_json::from_value(authorized.arguments.clone())
            .map_err(|error| {
                SqlCommandError::new(
                    "invalid_input",
                    format!("index.list arguments are invalid: {error}"),
                )
            })?;
        let connection_id = index_argument_string(&arguments.connection_id, "connectionId")?;
        let expected_connection_id = context.connection_id.as_deref().ok_or_else(|| {
            SqlCommandError::new("invalid_input", "index.list requires connection context")
        })?;
        if connection_id != expected_connection_id {
            return Err(SqlCommandError::new(
                "validation",
                "index.list cannot access a connection outside the Agent context",
            ));
        }
        if arguments.dialect != "sqlite" || context.dialect != SqlDialect::Sqlite {
            return Err(SqlCommandError::new(
                "validation",
                "index.list supports SQLite context only",
            ));
        }
        let schema = index_argument_string(&arguments.schema, "schema")?;
        let tables = arguments
            .tables
            .into_iter()
            .map(|table| {
                Ok(SqlTableRef {
                    schema: table
                        .schema
                        .map(|value| {
                            index_argument_string(&value, "table schema").map(str::to_string)
                        })
                        .transpose()?,
                    name: index_argument_string(&table.name, "table name")?.to_string(),
                })
            })
            .collect::<Result<Vec<_>, SqlCommandError>>()?;

        let capabilities = self.adapter.runtime_capabilities(connection_id)?;
        if capabilities.connection_id != connection_id
            || capabilities.dialect != context.dialect
            || capabilities.dialect != SqlDialect::Sqlite
        {
            return Err(SqlCommandError::new(
                "validation",
                "index metadata identity does not match the Agent context",
            ));
        }
        if let SqlCapabilitySupport::Unsupported { reason } = capabilities.metadata.indexes {
            return Err(SqlCommandError::new("validation", reason));
        }

        let result = self.adapter.list_indexes(IndexListRequest {
            connection_id: connection_id.to_string(),
            schema: schema.to_string(),
            tables,
            budget: IndexListBudget::default(),
        })?;
        if result.connection_id != connection_id
            || result.schema != schema
            || result.dialect != context.dialect
            || result
                .indexes
                .iter()
                .any(|index| index.metadata_revision != result.metadata_revision)
        {
            return Err(SqlCommandError::new(
                "validation",
                "index.list result does not match the Agent context",
            ));
        }
        let warnings = result
            .truncated
            .then(|| "Index evidence was truncated by the metadata budget.".to_string())
            .into_iter()
            .collect();
        Ok(SuggestOnlyAgentToolExecution {
            evidence: vec![(
                AgentEvidenceKind::Index,
                AgentEvidenceSensitivity::Workspace,
                json!({
                    "tool": authorized.tool.wire_name(),
                    "indexes": &result,
                }),
            )],
            schema: None,
            relation_context: None,
            analysis: None,
            index_context: Some(result),
            warnings,
        })
    }

    fn load_relation_context(
        &self,
        connection_id: &str,
        schema: &str,
        tables: Vec<SqlTableRef>,
        context: &AgentModelContext,
        expected_revision: Option<u64>,
        max_depth: u8,
    ) -> Result<Option<AgentModelRelationContext>, SqlCommandError> {
        let capabilities = self.adapter.runtime_capabilities(connection_id)?;
        if capabilities.connection_id != connection_id || capabilities.dialect != context.dialect {
            return Err(SqlCommandError::new(
                "validation",
                "relation metadata identity does not match the Agent context",
            ));
        }
        match capabilities.metadata.foreign_keys {
            SqlCapabilitySupport::Supported => {}
            SqlCapabilitySupport::Unsupported { reason } => {
                return Ok(Some(AgentModelRelationContext::Unsupported { reason }));
            }
        }
        if tables.is_empty() {
            return Ok(None);
        }

        let search = self.adapter.search_relations(RelationSearchRequest {
            connection_id: connection_id.to_string(),
            schema: schema.to_string(),
            tables,
            max_depth,
            budget: RelationSearchBudget::default(),
        })?;
        if search.connection_id != connection_id
            || search.schema != schema
            || search.dialect != context.dialect
            || expected_revision.is_some_and(|revision| search.metadata_revision != revision)
        {
            return Err(SqlCommandError::new(
                "validation",
                "relation.search result does not match schema.search identity",
            ));
        }
        Ok(Some(AgentModelRelationContext::Supported { search }))
    }
}

impl SuggestOnlyAgentToolExecutor for LocalSuggestOnlyAgentToolExecutor {
    fn execute(
        &mut self,
        authorized: &AgentAuthorizedTool,
        context: &AgentModelContext,
    ) -> Result<SuggestOnlyAgentToolExecution, SqlCommandError> {
        match authorized.tool {
            AgentTool::SchemaSearch => self.search_schema(authorized, context),
            AgentTool::RelationSearch => self.search_relations(authorized, context),
            AgentTool::IndexList => self.list_indexes(authorized, context),
            _ => execute_context_suggest_tool(authorized, context),
        }
    }
}

fn valid_argument_string<'a>(value: &'a str, name: &str) -> Result<&'a str, SqlCommandError> {
    let value = value.trim();
    if value.is_empty() || value.contains('\0') {
        Err(SqlCommandError::new(
            "invalid_input",
            format!("relation.search requires a valid {name}"),
        ))
    } else {
        Ok(value)
    }
}

fn index_argument_string<'a>(value: &'a str, name: &str) -> Result<&'a str, SqlCommandError> {
    let value = value.trim();
    if value.is_empty() || value.contains('\0') {
        Err(SqlCommandError::new(
            "invalid_input",
            format!("index.list requires a valid {name}"),
        ))
    } else {
        Ok(value)
    }
}

fn validate_schema_search_identity(
    result: &super::schema_context::SchemaSearchResult,
    connection_id: &str,
    schema: &str,
    context: &AgentModelContext,
    relation_revision: Option<u64>,
) -> Result<(), SqlCommandError> {
    if result.connection_id != connection_id
        || result.schema != schema
        || result.dialect != context.dialect
        || relation_revision.is_some_and(|revision| result.metadata_revision != revision)
    {
        Err(SqlCommandError::new(
            "validation",
            "schema.search result does not match the Agent context",
        ))
    } else {
        Ok(())
    }
}

fn relation_revision(context: &AgentModelRelationContext) -> Option<u64> {
    match context {
        AgentModelRelationContext::Supported { search } => Some(search.metadata_revision),
        AgentModelRelationContext::Unsupported { .. } => None,
    }
}

fn agent_schema_tables(
    result: &super::schema_context::SchemaSearchResult,
) -> Vec<AgentModelSchemaTable> {
    result
        .matches
        .iter()
        .map(|matched| AgentModelSchemaTable {
            schema: Some(matched.object.schema.clone()),
            name: matched.object.name.clone(),
            columns: matched
                .columns
                .iter()
                .map(|column| column.name.clone())
                .collect(),
        })
        .collect()
}

fn append_relation_warnings(
    warnings: &mut Vec<String>,
    context: Option<&AgentModelRelationContext>,
) {
    match context {
        Some(AgentModelRelationContext::Supported { search }) if search.truncated => {
            warnings.push("Relation evidence was truncated by the metadata budget.".to_string());
        }
        Some(AgentModelRelationContext::Unsupported { reason }) => warnings.push(format!(
            "Foreign-key relation metadata is unavailable: {reason}"
        )),
        _ => {}
    }
}

fn expand_relation_tables(
    explicit_tables: &mut Vec<SqlTableRef>,
    identities: &mut BTreeSet<(String, String)>,
    context: Option<&AgentModelRelationContext>,
) -> (bool, bool) {
    let Some(AgentModelRelationContext::Supported { search }) = context else {
        return (false, false);
    };
    let mut expanded = false;
    for node in search.paths.iter().flat_map(|path| path.nodes.iter()) {
        let identity = (node.schema.to_lowercase(), node.name.to_lowercase());
        if identities.insert(identity) {
            if explicit_tables.len() == MAX_DISCOVERY_TABLES {
                return (expanded, true);
            }
            explicit_tables.push(SqlTableRef {
                schema: Some(node.schema.clone()),
                name: node.name.clone(),
            });
            expanded = true;
        }
    }
    (expanded, false)
}

fn required_string<'a>(
    arguments: &'a serde_json::Value,
    name: &str,
) -> Result<&'a str, SqlCommandError> {
    arguments
        .get(name)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.contains('\0'))
        .ok_or_else(|| {
            SqlCommandError::new(
                "invalid_input",
                format!("schema.search requires a valid {name}"),
            )
        })
}

fn schema_search_terms(query: &str) -> Vec<String> {
    let normalized = query.to_lowercase();
    let mut terms = Vec::new();
    for raw in normalized.split(|character: char| !character.is_alphanumeric() && character != '_')
    {
        let term = raw.trim();
        if term.len() < 2 || term.chars().all(|character| character.is_ascii_digit()) {
            continue;
        }
        if matches!(
            term,
            "a" | "an"
                | "and"
                | "by"
                | "for"
                | "from"
                | "in"
                | "list"
                | "of"
                | "the"
                | "to"
                | "with"
        ) {
            continue;
        }
        push_unique(&mut terms, singularize(term));
    }

    for (needles, expansion) in [
        (&["customer", "user", "客户", "用户"][..], "user"),
        (&["order", "purchase", "订单", "消费"][..], "order"),
        (&["name", "customer", "姓名", "名称"][..], "name"),
        (&["amount", "spend", "total", "金额", "消费"][..], "amount"),
        (
            &["recent", "date", "created", "最近", "日期", "天"][..],
            "created_at",
        ),
    ] {
        if needles.iter().any(|needle| normalized.contains(needle)) {
            push_unique(&mut terms, expansion.to_string());
        }
    }
    terms
}

fn singularize(value: &str) -> String {
    if let Some(stem) = value.strip_suffix("ies") {
        return format!("{stem}y");
    }
    value
        .strip_suffix('s')
        .filter(|stem| stem.len() > 2)
        .unwrap_or(value)
        .to_string()
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|candidate| candidate == &value) {
        values.push(value);
    }
}

#[cfg(test)]
mod tests {
    use super::super::policy::AgentCapability;
    use super::*;
    use crate::commands::sql::connection_manager::ConnectionManager;
    use crate::commands::sql::demo_seed::ensure_demo_db;
    use crate::commands::sql::driver_registry::default_registry;
    use crate::commands::sql::types::{ConnectionProfile, ConnectionSecret, DriverIdDto};
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct SqliteFixture {
        root: PathBuf,
    }

    impl SqliteFixture {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "nyala-suggest-relations-{}-{label}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&root).expect("create relation fixture root");
            Self { root }
        }

        fn database(&self) -> PathBuf {
            self.root.join("fixture.db")
        }
    }

    impl Drop for SqliteFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn sqlite_profile(path: &Path) -> ConnectionProfile {
        ConnectionProfile {
            id: "workspace".to_string(),
            label: "workspace".to_string(),
            driver: DriverIdDto::Sqlite,
            read_only: true,
            host: None,
            port: None,
            database: None,
            username: None,
            ssl_mode: None,
            file_path: Some(path.to_string_lossy().into_owned()),
            remember_in_memory: false,
            created_at_ms: 0,
        }
    }

    fn sqlite_executor(fixture: &SqliteFixture) -> LocalSuggestOnlyAgentToolExecutor {
        let manager = Arc::new(ConnectionManager::new(
            default_registry(),
            fixture.root.join("profiles.json"),
        ));
        let profile = sqlite_profile(&fixture.database());
        manager
            .upsert_profile(profile.clone())
            .expect("save SQLite profile");
        manager
            .open(&profile, ConnectionSecret::default())
            .expect("open SQLite profile");
        LocalSuggestOnlyAgentToolExecutor::new(manager, Arc::new(SqlConnectionStore::new()))
    }

    fn authorized(tool: AgentTool, arguments: serde_json::Value) -> AgentAuthorizedTool {
        AgentAuthorizedTool {
            run_id: "run-1".to_string(),
            call_id: format!("call-{}", tool.wire_name()),
            tool,
            arguments,
            required_capability: AgentCapability::DatabaseReadMetadata,
        }
    }

    fn workspace_context() -> AgentModelContext {
        AgentModelContext {
            connection_id: Some("workspace".to_string()),
            dialect: super::super::super::dialect::SqlDialect::Sqlite,
            ..AgentModelContext::default()
        }
    }

    #[test]
    fn schema_search_terms_expand_english_and_chinese_demo_intents() {
        let english = schema_search_terms("list recent orders with customer names");
        let chinese = schema_search_terms("查询最近 30 天消费金额最高的 10 个用户");

        for expected in ["order", "user", "name", "amount", "created_at"] {
            assert!(
                english.iter().any(|term| term == expected)
                    || chinese.iter().any(|term| term == expected),
                "missing expansion {expected}"
            );
        }
        assert!(english.iter().any(|term| term == "order"));
        assert!(english.iter().any(|term| term == "name"));
        assert!(chinese.iter().any(|term| term == "user"));
        assert!(chinese.iter().any(|term| term == "amount"));
    }

    #[test]
    fn schema_search_rejects_cross_connection_metadata_access_before_dispatch() {
        let manager = Arc::new(ConnectionManager::new(
            default_registry(),
            std::env::temp_dir().join(format!(
                "nyala-agent-cross-connection-{}.json",
                std::process::id()
            )),
        ));
        let mut executor =
            LocalSuggestOnlyAgentToolExecutor::new(manager, Arc::new(SqlConnectionStore::new()));
        let authorized = AgentAuthorizedTool {
            run_id: "run-1".to_string(),
            call_id: "call-schema".to_string(),
            tool: AgentTool::SchemaSearch,
            arguments: json!({
                "connectionId": "other-connection",
                "schema": "main",
                "query": "orders"
            }),
            required_capability: AgentCapability::DatabaseReadMetadata,
        };
        let context = AgentModelContext {
            connection_id: Some("trusted-connection".to_string()),
            ..AgentModelContext::default()
        };

        let error = executor.execute(&authorized, &context).unwrap_err();

        assert!(error.to_string().contains("outside the Agent context"));
    }

    #[test]
    fn schema_search_expands_demo_tables_through_declared_foreign_key() {
        let fixture = SqliteFixture::new("demo");
        ensure_demo_db(&fixture.database()).expect("seed demo database");
        let mut executor = sqlite_executor(&fixture);

        let execution = executor
            .execute(
                &authorized(
                    AgentTool::SchemaSearch,
                    json!({
                        "connectionId": "workspace",
                        "schema": "main",
                        "query": "orders"
                    }),
                ),
                &workspace_context(),
            )
            .expect("search schema with relations");

        let schema = execution.schema.expect("typed schema");
        assert!(schema.iter().any(|table| table.name == "orders"));
        assert!(schema.iter().any(|table| table.name == "users"));
        let AgentModelRelationContext::Supported { search } =
            execution.relation_context.expect("typed relation context")
        else {
            panic!("SQLite relation context must be supported");
        };
        assert_eq!(search.paths.len(), 1);
        assert_eq!(search.paths[0].edges[0].source.name, "orders");
        assert_eq!(search.paths[0].edges[0].target.name, "users");
        assert!(execution.warnings.is_empty());
    }

    #[test]
    fn explicit_relation_search_returns_declared_direction() {
        let fixture = SqliteFixture::new("explicit");
        ensure_demo_db(&fixture.database()).expect("seed demo database");
        let mut executor = sqlite_executor(&fixture);

        let execution = executor
            .execute(
                &authorized(
                    AgentTool::RelationSearch,
                    json!({
                        "connectionId": "workspace",
                        "schema": "main",
                        "tables": [{"schema": "main", "name": "users"}],
                        "maxDepth": 2
                    }),
                ),
                &workspace_context(),
            )
            .expect("search relations explicitly");

        let AgentModelRelationContext::Supported { search } =
            execution.relation_context.expect("typed relation context")
        else {
            panic!("SQLite relation context must be supported");
        };
        assert_eq!(search.paths[0].nodes[0].name, "users");
        assert_eq!(search.paths[0].edges[0].source.name, "orders");
        assert_eq!(search.paths[0].edges[0].target.name, "users");
    }

    #[test]
    fn index_list_returns_typed_workspace_evidence_without_rows_or_sql() {
        let fixture = SqliteFixture::new("indexes");
        let connection =
            rusqlite::Connection::open(fixture.database()).expect("open index fixture");
        connection
            .execute_batch(
                "CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT, tenant_id INTEGER);\
                 CREATE INDEX idx_users_tenant_email ON users(tenant_id, email DESC);",
            )
            .expect("seed index fixture");
        drop(connection);
        let mut executor = sqlite_executor(&fixture);

        let execution = executor
            .execute(
                &authorized(
                    AgentTool::IndexList,
                    json!({
                        "connectionId": "workspace",
                        "dialect": "sqlite",
                        "schema": "main",
                        "tables": [{"schema": "main", "name": "users"}]
                    }),
                ),
                &workspace_context(),
            )
            .expect("list index evidence");

        assert_eq!(execution.evidence.len(), 1);
        let (kind, sensitivity, payload) = &execution.evidence[0];
        assert_eq!(*kind, AgentEvidenceKind::Index);
        assert_eq!(*sensitivity, AgentEvidenceSensitivity::Workspace);
        assert_eq!(payload["tool"], "index.list");
        assert_eq!(payload["indexes"]["connectionId"], "workspace");
        assert_eq!(payload["indexes"]["dialect"], "sqlite");
        assert_eq!(
            payload["indexes"]["indexes"][0]["name"],
            "idx_users_tenant_email"
        );
        assert_eq!(
            payload["indexes"]["indexes"][0]["columns"][1]["descending"],
            true
        );
        let serialized = serde_json::to_string(payload).unwrap();
        for forbidden in ["rows", "password", "filePath", "databasePath", "sql\""] {
            assert!(
                !serialized.contains(forbidden),
                "exposed {forbidden}: {serialized}"
            );
        }
        assert!(execution.schema.is_none());
        assert!(execution.relation_context.is_none());
        assert!(execution.analysis.is_none());
        assert!(execution.warnings.is_empty());
    }

    #[test]
    fn index_list_rejects_cross_connection_or_non_sqlite_context() {
        let manager = Arc::new(ConnectionManager::new(
            default_registry(),
            std::env::temp_dir().join(format!(
                "nyala-agent-index-scope-{}.json",
                std::process::id()
            )),
        ));
        let mut executor =
            LocalSuggestOnlyAgentToolExecutor::new(manager, Arc::new(SqlConnectionStore::new()));
        let authorized = authorized(
            AgentTool::IndexList,
            json!({
                "connectionId": "other",
                "dialect": "sqlite",
                "schema": "main",
                "tables": [{"name": "users"}]
            }),
        );

        let cross_connection = executor
            .execute(&authorized, &workspace_context())
            .unwrap_err();
        assert!(cross_connection
            .to_string()
            .contains("outside the Agent context"));

        let mysql_context = AgentModelContext {
            connection_id: Some("other".to_string()),
            dialect: SqlDialect::MySql,
            ..AgentModelContext::default()
        };
        let wrong_dialect = executor.execute(&authorized, &mysql_context).unwrap_err();
        assert!(wrong_dialect.to_string().contains("SQLite context only"));
    }

    #[test]
    fn index_list_rejects_caller_controlled_budgets_rows_and_secrets() {
        let manager = Arc::new(ConnectionManager::new(
            default_registry(),
            std::env::temp_dir().join(format!(
                "nyala-agent-index-forged-arguments-{}.json",
                std::process::id()
            )),
        ));
        let mut executor =
            LocalSuggestOnlyAgentToolExecutor::new(manager, Arc::new(SqlConnectionStore::new()));

        for forged in [
            json!({"maxIndexes": usize::MAX}),
            json!({"rows": [["private"]]}),
            json!({"password": "private"}),
        ] {
            let mut arguments = json!({
                "connectionId": "workspace",
                "dialect": "sqlite",
                "schema": "main",
                "tables": [{"name": "users"}]
            });
            arguments
                .as_object_mut()
                .expect("index arguments are an object")
                .extend(
                    forged
                        .as_object()
                        .expect("forged fields are an object")
                        .clone(),
                );
            let error = executor
                .execute(
                    &authorized(AgentTool::IndexList, arguments),
                    &workspace_context(),
                )
                .unwrap_err();

            assert!(error.to_string().contains("arguments are invalid"));
        }
    }

    #[test]
    fn schema_search_preserves_supported_empty_relation_state() {
        let fixture = SqliteFixture::new("empty");
        let connection =
            rusqlite::Connection::open(fixture.database()).expect("open supported-empty fixture");
        connection
            .execute_batch("CREATE TABLE standalone(id INTEGER PRIMARY KEY);")
            .expect("seed supported-empty fixture");
        drop(connection);
        let mut executor = sqlite_executor(&fixture);

        let execution = executor
            .execute(
                &authorized(
                    AgentTool::SchemaSearch,
                    json!({
                        "connectionId": "workspace",
                        "schema": "main",
                        "query": "standalone"
                    }),
                ),
                &workspace_context(),
            )
            .expect("search supported-empty relations");

        let AgentModelRelationContext::Supported { search } =
            execution.relation_context.expect("typed relation context")
        else {
            panic!("SQLite relation context must be supported");
        };
        assert!(search.paths.is_empty());
        assert!(!search.truncated);
        assert!(execution.warnings.is_empty());
    }
}
