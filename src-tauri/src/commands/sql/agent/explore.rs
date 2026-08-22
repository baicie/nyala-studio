//! Composite executor for the goal-grounded `SQLite` read-only Explore skill.

#![allow(dead_code)]

use std::sync::Arc;

use super::super::connection_manager::SharedConnectionManager;
use super::super::state::SqlConnectionStore;
use super::super::types::SqlCommandError;
use super::model::AgentModelContext;
use super::policy::{AgentAuthorizedTool, AgentTool};
use super::read_only::LocalReadOnlyAgentToolExecutor as LocalDatabaseReadOnlyAgentToolExecutor;
use super::runtime::{
    AgentToolExecution, ReadOnlyAgentToolExecutor, SuggestOnlyAgentToolExecution,
    SuggestOnlyAgentToolExecutor,
};
use super::suggest_only::LocalSuggestOnlyAgentToolExecutor;
use super::AgentCancellationToken;

/// Routes metadata/static-analysis calls and database calls to their existing
/// bounded local implementations. The runtime still owns ordering and scope
/// validation; this type only adapts the two tool result shapes.
pub struct LocalReadOnlyCompositeAgentToolExecutor {
    suggest: LocalSuggestOnlyAgentToolExecutor,
    read_only: LocalDatabaseReadOnlyAgentToolExecutor,
    connection_id: String,
}

impl LocalReadOnlyCompositeAgentToolExecutor {
    pub fn new(
        metadata_manager: SharedConnectionManager,
        sql_store: Arc<SqlConnectionStore>,
        connection_id: impl Into<String>,
        cancellation: AgentCancellationToken,
    ) -> Result<Self, SqlCommandError> {
        let connection_id = connection_id.into();
        Ok(Self {
            suggest: LocalSuggestOnlyAgentToolExecutor::new(
                metadata_manager,
                Arc::clone(&sql_store),
            ),
            read_only: LocalDatabaseReadOnlyAgentToolExecutor::new(
                sql_store,
                connection_id.clone(),
                cancellation,
            )?,
            connection_id,
        })
    }
}

/// Compatibility name retained for the A4 Explore bridge and tests.
pub type LocalReadOnlyExploreAgentToolExecutor = LocalReadOnlyCompositeAgentToolExecutor;

impl ReadOnlyAgentToolExecutor for LocalReadOnlyCompositeAgentToolExecutor {
    fn execute(
        &mut self,
        authorized: &AgentAuthorizedTool,
        context: &AgentModelContext,
    ) -> Result<AgentToolExecution, SqlCommandError> {
        match authorized.tool {
            AgentTool::SchemaSearch | AgentTool::IndexList | AgentTool::SqlParse => {
                let execution = self.suggest.execute(authorized, context)?;
                Ok(adapt_suggest_execution(execution))
            }
            AgentTool::SqlExplain => {
                let identity = self.suggest.sqlite_plan_identity(&self.connection_id)?;
                let execution = self
                    .read_only
                    .execute_explain_with_identity(authorized, identity.clone())?;
                let current_identity = self.suggest.sqlite_plan_identity(&self.connection_id)?;
                if current_identity != identity {
                    return Err(SqlCommandError::new(
                        "validation",
                        "SQLite metadata revision changed while the plan was being explained",
                    ));
                }
                Ok(execution)
            }
            AgentTool::SqlExecuteReadonly | AgentTool::ResultInspect | AgentTool::ResultSample => {
                self.read_only.execute(authorized, context)
            }
            _ => Err(SqlCommandError::new(
                "invalid_input",
                "Read-only Explore received an unsupported tool",
            )),
        }
    }
}

fn adapt_suggest_execution(execution: SuggestOnlyAgentToolExecution) -> AgentToolExecution {
    AgentToolExecution {
        evidence: execution.evidence,
        schema: execution.schema,
        relation_context: execution.relation_context,
        analysis: execution.analysis,
        index_context: execution.index_context,
        normalized_plan: None,
        result_ref: None,
        result_shape: None,
        warnings: execution.warnings,
        query_call_count: 0,
        result_rows: 0,
        result_bytes: 0,
        partial: false,
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::json;

    use super::*;
    use crate::commands::sql::agent::evidence::AgentEvidenceKind;
    use crate::commands::sql::agent::policy::AgentCapability;
    use crate::commands::sql::connection_manager::ConnectionManager;
    use crate::commands::sql::driver_registry::default_registry;
    use crate::commands::sql::types::{
        ConnectionProfile, ConnectionSecret, DriverIdDto, SqlConnectionInput, SqlConnectionKind,
    };

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
                "nyala-read-only-composite-{}-{label}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&root).expect("create composite fixture root");
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

    fn legacy_sqlite_input(path: &Path) -> SqlConnectionInput {
        SqlConnectionInput {
            id: Some("workspace".to_string()),
            name: Some("workspace".to_string()),
            kind: SqlConnectionKind::Sqlite,
            database_path: Some(path.to_string_lossy().into_owned()),
            host: None,
            port: None,
            database: None,
            username: None,
            password: None,
            ssl_mode: None,
            read_only: true,
            create_if_missing: false,
        }
    }

    #[test]
    fn read_only_composite_index_list_returns_secret_free_evidence_without_query_calls() {
        let fixture = SqliteFixture::new("index-list");
        let database_path = fixture.database();
        let connection = rusqlite::Connection::open(&database_path).expect("open index fixture");
        connection
            .execute_batch(
                "CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT, tenant_id INTEGER);\
                 CREATE INDEX idx_users_tenant_email ON users(tenant_id, email DESC);",
            )
            .expect("seed index fixture");
        drop(connection);

        let metadata_manager = Arc::new(ConnectionManager::new(
            default_registry(),
            fixture.root.join("profiles.json"),
        ));
        let profile = sqlite_profile(&database_path);
        metadata_manager
            .upsert_profile(profile.clone())
            .expect("save SQLite profile");
        metadata_manager
            .open(&profile, ConnectionSecret::default())
            .expect("open SQLite profile");
        let mut executor = LocalReadOnlyCompositeAgentToolExecutor::new(
            metadata_manager,
            Arc::new(SqlConnectionStore::new()),
            "workspace",
            AgentCancellationToken::default(),
        )
        .expect("create composite executor");
        let authorized = AgentAuthorizedTool {
            run_id: "run-index-list".to_string(),
            call_id: "call-index-list".to_string(),
            tool: AgentTool::IndexList,
            arguments: json!({
                "connectionId": "workspace",
                "dialect": "sqlite",
                "schema": "main",
                "tables": [{"schema": "main", "name": "users"}]
            }),
            required_capability: AgentCapability::DatabaseReadMetadata,
        };
        let context = AgentModelContext {
            connection_id: Some("workspace".to_string()),
            ..AgentModelContext::default()
        };

        let execution = executor
            .execute(&authorized, &context)
            .expect("list index evidence through Read Only executor");

        assert_eq!(execution.evidence.len(), 1);
        assert_eq!(execution.evidence[0].0, AgentEvidenceKind::Index);
        assert_eq!(execution.query_call_count, 0);
        assert_eq!(execution.result_rows, 0);
        let serialized = serde_json::to_string(&execution.evidence).expect("serialize evidence");
        for forbidden in [
            "\"sql\":",
            "\"rows\":",
            "password",
            "secret",
            "filePath",
            "file_path",
            "databasePath",
            "database_path",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "exposed {forbidden}: {serialized}"
            );
        }
        assert!(!serialized.contains(database_path.to_string_lossy().as_ref()));
    }

    #[test]
    fn read_only_composite_explain_returns_revision_bound_normalized_plan() {
        let fixture = SqliteFixture::new("normalized-plan");
        let database_path = fixture.database();
        let connection = rusqlite::Connection::open(&database_path).expect("open plan fixture");
        connection
            .execute_batch(
                "CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT NOT NULL);\
                 CREATE INDEX idx_users_email ON users(email);",
            )
            .expect("seed plan fixture");
        drop(connection);

        let metadata_manager = Arc::new(ConnectionManager::new(
            default_registry(),
            fixture.root.join("profiles.json"),
        ));
        let profile = sqlite_profile(&database_path);
        metadata_manager
            .upsert_profile(profile.clone())
            .expect("save SQLite profile");
        metadata_manager
            .open(&profile, ConnectionSecret::default())
            .expect("open V2 SQLite profile");
        let legacy_store = Arc::new(SqlConnectionStore::new());
        legacy_store
            .open_connection(legacy_sqlite_input(&database_path))
            .expect("open V1 SQLite connection");
        let mut executor = LocalReadOnlyCompositeAgentToolExecutor::new(
            metadata_manager,
            legacy_store,
            "workspace",
            AgentCancellationToken::default(),
        )
        .expect("create composite executor");
        let authorized = AgentAuthorizedTool {
            run_id: "run-plan".to_string(),
            call_id: "call-plan".to_string(),
            tool: AgentTool::SqlExplain,
            arguments: json!({
                "connectionId": "workspace",
                "dialect": "sqlite",
                "sql": "SELECT id FROM users WHERE email = 'a'"
            }),
            required_capability: AgentCapability::DatabaseExplain,
        };
        let context = AgentModelContext {
            connection_id: Some("workspace".to_string()),
            ..AgentModelContext::default()
        };

        let execution = executor
            .execute(&authorized, &context)
            .expect("explain through revision-bound composite executor");

        assert_eq!(execution.evidence.len(), 1);
        assert_eq!(execution.evidence[0].0, AgentEvidenceKind::Plan);
        assert_eq!(execution.query_call_count, 1);
        assert_eq!(execution.result_rows, 0);
        assert!(!execution.partial);
        let payload = &execution.evidence[0].2;
        assert_eq!(
            payload["normalizedPlan"]["identity"]["connectionId"],
            "workspace"
        );
        assert_eq!(payload["normalizedPlan"]["identity"]["dialect"], "sqlite");
        assert!(payload["normalizedPlan"]["identity"]["metadataRevision"]
            .as_u64()
            .is_some_and(|revision| revision > 0));
        assert!(payload["normalizedPlan"]["nodes"]
            .as_array()
            .is_some_and(|nodes| !nodes.is_empty()));
        assert!(payload.get("rows").is_none());
    }
}
