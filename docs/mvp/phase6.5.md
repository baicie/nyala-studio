# Phase 6.5：Connection Persistence

Phase 6 完成后，SQL Studio 的核心路径已经闭环：

```txt
SQLite connection
  -> Connection Tree
  -> SQL Editor
  -> Execute Query
  -> Result Panel
```

但当前还有一个明显产品问题：**连接是内存态，应用重启后全部丢失**。Rust 侧 `SqlConnectionStore` 当前只维护 `connections: Mutex<HashMap<...>>`，`list_connections()` 也是直接从内存 map 读取。

当前 Tauri 初始化时也是直接 `.manage(Arc::new(SqlConnectionStore::new()))`，还没有持久化路径配置。

所以 Phase 6.5 的目标是：

```txt
保存 SQLite 连接配置
  -> 重启后可恢复
  -> 支持 autoConnect
  -> 支持 remove saved connection
  -> 不保存密码 / secret
```

当前 `SqlConnectionInput` 已经包含 SQLite 需要的字段：`id / name / kind / databasePath / readOnly / createIfMissing`。

---

# Phase 6.5 边界

本阶段做：

```txt
1. Rust 后端新增 saved connections JSON 存储
2. 新增 sql_save_connection
3. 新增 sql_list_saved_connections
4. 新增 sql_remove_saved_connection
5. 新增 sql_restore_saved_connections
6. 前端 ISqlConnectionService 增加持久化方法
7. SQL Connections View 增加 Save / Auto connect
8. SQL Connections View 显示 Saved Connections
9. 单元测试覆盖持久化读写、恢复、删除、TS 类型模型
```

本阶段不做：

```txt
1. MySQL / Postgres
2. 密码保存
3. Secret Store
4. 连接分组
5. 云同步
6. Recent workspace
7. 多用户 profile
```

---

# 持久化文件

保存到 Tauri app data dir：

```txt
<app_data>/sql-connections.json
```

格式：

```json
{
	"version": 1,
	"connections": [
		{
			"id": "local",
			"name": "Local SQLite",
			"kind": "sqlite",
			"databasePath": "/Users/me/app.db",
			"readOnly": false,
			"createIfMissing": false,
			"autoConnect": true
		}
	]
}
```

---

# 后端实现

## 1. 修改 `src-tauri/src/commands/sql/types.rs`

在 `SqlConnection` 后面追加：

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlSavedConnection {
    pub id: String,
    pub name: String,
    pub kind: SqlConnectionKind,
    pub database_path: String,
    pub read_only: bool,
    pub create_if_missing: bool,
    pub auto_connect: bool,
}

impl SqlSavedConnection {
    pub fn to_input(&self) -> SqlConnectionInput {
        SqlConnectionInput {
            id: Some(self.id.clone()),
            name: Some(self.name.clone()),
            kind: self.kind.clone(),
            database_path: self.database_path.clone(),
            read_only: self.read_only,
            create_if_missing: self.create_if_missing,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlSaveConnectionRequest {
    pub input: SqlConnectionInput,

    #[serde(default)]
    pub auto_connect: bool,

    #[serde(default)]
    pub open_now: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlRemoveSavedConnectionRequest {
    pub connection_id: String,

    #[serde(default)]
    pub close_if_open: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlRestoreSavedConnectionError {
    pub connection_id: String,
    pub name: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlRestoreSavedConnectionsResult {
    pub opened: Vec<SqlConnection>,
    pub errors: Vec<SqlRestoreSavedConnectionError>,
}
```

然后把顶部原来的导出类型保持不动。最终 `types.rs` 里会同时包含：

```rust
SqlConnectionInput
SqlConnection
SqlSavedConnection
SqlSaveConnectionRequest
SqlRemoveSavedConnectionRequest
SqlRestoreSavedConnectionsResult
```

---

## 2. 新增 `src-tauri/src/commands/sql/persistence.rs`

```rust
use super::types::SqlSavedConnection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const SQL_CONNECTIONS_DOCUMENT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SqlConnectionsDocument {
    version: u32,
    connections: Vec<SqlSavedConnection>,
}

pub fn load_saved_connections(path: &Path) -> Result<Vec<SqlSavedConnection>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(path)
        .map_err(|err| format!("failed to read saved SQL connections: {err}"))?;

    if content.trim().is_empty() {
        return Ok(Vec::new());
    }

    let document: SqlConnectionsDocument = serde_json::from_str(&content)
        .map_err(|err| format!("failed to parse saved SQL connections: {err}"))?;

    if document.version != SQL_CONNECTIONS_DOCUMENT_VERSION {
        return Err(format!(
            "unsupported saved SQL connections version: {}",
            document.version
        ));
    }

    Ok(document.connections)
}

pub fn save_saved_connections(
    path: &Path,
    connections: &[SqlSavedConnection],
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "failed to create saved SQL connections directory {}: {err}",
                parent.display()
            )
        })?;
    }

    let document = SqlConnectionsDocument {
        version: SQL_CONNECTIONS_DOCUMENT_VERSION,
        connections: connections.to_vec(),
    };

    let content = serde_json::to_string_pretty(&document)
        .map_err(|err| format!("failed to serialize saved SQL connections: {err}"))?;

    let tmp_path = temporary_path(path);

    fs::write(&tmp_path, content).map_err(|err| {
        format!(
            "failed to write saved SQL connections temp file {}: {err}",
            tmp_path.display()
        )
    })?;

    fs::rename(&tmp_path, path).map_err(|err| {
        format!(
            "failed to replace saved SQL connections file {}: {err}",
            path.display()
        )
    })?;

    Ok(())
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut tmp = path.to_path_buf();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!("{value}.tmp"))
        .unwrap_or_else(|| "tmp".to_string());

    tmp.set_extension(extension);
    tmp
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sql::types::SqlConnectionKind;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn load_saved_connections_returns_empty_when_file_is_missing() {
        let path = temp_file("missing");
        assert_eq!(load_saved_connections(&path).unwrap(), Vec::new());
    }

    #[test]
    fn save_and_load_saved_connections_round_trip() {
        let path = temp_file("round-trip");

        let connections = vec![SqlSavedConnection {
            id: "local".to_string(),
            name: "Local SQLite".to_string(),
            kind: SqlConnectionKind::Sqlite,
            database_path: "/tmp/app.db".to_string(),
            read_only: false,
            create_if_missing: true,
            auto_connect: true,
        }];

        save_saved_connections(&path, &connections).unwrap();

        let loaded = load_saved_connections(&path).unwrap();
        assert_eq!(loaded, connections);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn load_saved_connections_rejects_unknown_version() {
        let path = temp_file("bad-version");

        fs::write(
            &path,
            r#"{
              "version": 999,
              "connections": []
            }"#,
        )
        .unwrap();

        let err = load_saved_connections(&path).unwrap_err();
        assert!(err.contains("unsupported saved SQL connections version"));

        let _ = fs::remove_file(path);
    }

    fn temp_file(name: &str) -> PathBuf {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();

        std::env::temp_dir().join(format!("sql-studio-next-{name}-{now}.json"))
    }
}
```

---

## 3. 修改 `src-tauri/src/commands/sql/mod.rs`

```rust
mod connection;
mod metadata;
mod persistence;
mod query;
mod state;
mod types;

pub use connection::*;
pub use metadata::*;
pub use query::*;
pub use state::SqlConnectionStore;
pub use types::*;
```

---

## 4. 修改 `src-tauri/src/commands/sql/state.rs`

### 4.1 修改 imports

把顶部 imports 改成：

```rust
use super::persistence::{load_saved_connections, save_saved_connections};
use super::types::{
    SqlCancelQueryRequest, SqlCancelQueryResult, SqlCellValue, SqlColumn, SqlConnection,
    SqlConnectionInput, SqlConnectionKind, SqlConnectionTestResult, SqlExecuteQueryRequest,
    SqlListColumnsRequest, SqlQueryResult, SqlRemoveSavedConnectionRequest,
    SqlRestoreSavedConnectionError, SqlRestoreSavedConnectionsResult, SqlResultColumn,
    SqlSaveConnectionRequest, SqlSavedConnection, SqlTable, SqlTableType,
    DEFAULT_QUERY_ROW_LIMIT, MAX_QUERY_ROW_LIMIT, MAX_SQL_BYTES,
};
use base64::{engine::general_purpose, Engine as _};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, InterruptHandle, OpenFlags};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;
use uuid::Uuid;
```

### 4.2 替换 `SqlConnectionStore`

```rust
type ConnectionMap = HashMap<String, Arc<SqlConnectionHandle>>;
type SavedConnectionMap = HashMap<String, SqlSavedConnection>;

struct SqlConnectionHandle {
    info: SqlConnection,
    conn: Mutex<Connection>,
    interrupt: InterruptHandle,
}

pub struct SqlConnectionStore {
    connections: Mutex<ConnectionMap>,
    saved_connections: Mutex<SavedConnectionMap>,
    persistence_path: Mutex<Option<PathBuf>>,
}
```

### 4.3 替换 `new()`

```rust
impl SqlConnectionStore {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            saved_connections: Mutex::new(HashMap::new()),
            persistence_path: Mutex::new(None),
        }
    }

    pub fn initialize_persistence(&self, path: PathBuf) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| {
                format!(
                    "failed to create SQL connection persistence directory {}: {err}",
                    parent.display()
                )
            })?;
        }

        let saved = load_saved_connections(&path)?;
        let mut saved_map = self.saved_connections()?;
        saved_map.clear();

        for connection in saved {
            saved_map.insert(connection.id.clone(), connection);
        }

        *self.persistence_path()? = Some(path);

        Ok(())
    }
```

然后保留原本已有的 `test_connection / open_connection / close_connection / list_connections / list_tables / list_columns / execute_query / cancel_query`。

### 4.4 在 `impl SqlConnectionStore` 里追加持久化方法

建议放在 `list_connections()` 后面：

```rust
    #[allow(clippy::needless_pass_by_value)]
    pub fn save_connection(
        &self,
        request: SqlSaveConnectionRequest,
    ) -> Result<SqlSavedConnection, String> {
        let connection = normalize_connection_input(&request.input)?;

        let saved = SqlSavedConnection {
            id: connection.id.clone(),
            name: connection.name.clone(),
            kind: connection.kind.clone(),
            database_path: connection.database_path.clone(),
            read_only: connection.read_only,
            create_if_missing: request.input.create_if_missing,
            auto_connect: request.auto_connect,
        };

        {
            let mut saved_connections = self.saved_connections()?;
            saved_connections.insert(saved.id.clone(), saved.clone());
        }

        self.flush_saved_connections()?;

        if request.open_now {
            let already_open = {
                let connections = self.connections()?;
                connections.contains_key(&saved.id)
            };

            if !already_open {
                self.open_connection(saved.to_input())?;
            }
        }

        Ok(saved)
    }

    pub fn list_saved_connections(&self) -> Result<Vec<SqlSavedConnection>, String> {
        let mut saved = self
            .saved_connections()?
            .values()
            .cloned()
            .collect::<Vec<_>>();

        saved.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));

        Ok(saved)
    }

    #[allow(clippy::needless_pass_by_value)]
    pub fn remove_saved_connection(
        &self,
        request: SqlRemoveSavedConnectionRequest,
    ) -> Result<(), String> {
        let connection_id = request.connection_id.trim();

        if connection_id.is_empty() {
            return Err("connectionId must not be empty".to_string());
        }

        {
            let mut saved_connections = self.saved_connections()?;
            if saved_connections.remove(connection_id).is_none() {
                return Err(format!("saved connection '{connection_id}' does not exist"));
            }
        }

        self.flush_saved_connections()?;

        if request.close_if_open {
            let is_open = {
                let connections = self.connections()?;
                connections.contains_key(connection_id)
            };

            if is_open {
                self.close_connection(connection_id)?;
            }
        }

        Ok(())
    }

    pub fn restore_saved_connections(&self) -> Result<SqlRestoreSavedConnectionsResult, String> {
        let saved_connections = self.list_saved_connections()?;

        let mut opened = Vec::new();
        let mut errors = Vec::new();

        for saved in saved_connections
            .into_iter()
            .filter(|connection| connection.auto_connect)
        {
            let already_open = {
                let connections = self.connections()?;
                connections.contains_key(&saved.id)
            };

            if already_open {
                if let Ok(connection) = self.connection(&saved.id) {
                    opened.push(connection.info.clone());
                }
                continue;
            }

            match self.open_connection(saved.to_input()) {
                Ok(connection) => opened.push(connection),
                Err(error) => errors.push(SqlRestoreSavedConnectionError {
                    connection_id: saved.id,
                    name: saved.name,
                    error,
                }),
            }
        }

        Ok(SqlRestoreSavedConnectionsResult { opened, errors })
    }

    fn flush_saved_connections(&self) -> Result<(), String> {
        let path = self
            .persistence_path()?
            .clone()
            .ok_or_else(|| "SQL connection persistence has not been initialized".to_string())?;

        let saved = self.list_saved_connections()?;
        save_saved_connections(&path, &saved)
    }
```

### 4.5 在 `impl SqlConnectionStore` 底部追加 mutex helper

找到原本的：

```rust
fn connections(&self) -> Result<MutexGuard<'_, ConnectionMap>, String>
```

保留它，并追加：

```rust
    fn saved_connections(&self) -> Result<MutexGuard<'_, SavedConnectionMap>, String> {
        self.saved_connections.lock().map_err(|err| err.to_string())
    }

    fn persistence_path(&self) -> Result<MutexGuard<'_, Option<PathBuf>>, String> {
        self.persistence_path.lock().map_err(|err| err.to_string())
    }
```

---

## 5. 修改 `src-tauri/src/commands/sql/connection.rs`

替换为完整文件：

```rust
use super::state::SqlConnectionStore;
use super::types::{
    SqlConnection, SqlConnectionInput, SqlConnectionTestResult, SqlRemoveSavedConnectionRequest,
    SqlRestoreSavedConnectionsResult, SqlSaveConnectionRequest, SqlSavedConnection,
};
use std::sync::Arc;
use tauri::State;

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn sql_test_connection(
    state: State<'_, Arc<SqlConnectionStore>>,
    input: SqlConnectionInput,
) -> Result<SqlConnectionTestResult, String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.test_connection(input))
        .await
        .map_err(|err| format!("sql_test_connection task failed: {err}"))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn sql_open_connection(
    state: State<'_, Arc<SqlConnectionStore>>,
    input: SqlConnectionInput,
) -> Result<SqlConnection, String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.open_connection(input))
        .await
        .map_err(|err| format!("sql_open_connection task failed: {err}"))?
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn sql_close_connection(
    state: State<'_, Arc<SqlConnectionStore>>,
    connection_id: String,
) -> Result<(), String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.close_connection(&connection_id))
        .await
        .map_err(|err| format!("sql_close_connection task failed: {err}"))?
}

#[tauri::command]
pub async fn sql_list_connections(
    state: State<'_, Arc<SqlConnectionStore>>,
) -> Result<Vec<SqlConnection>, String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.list_connections())
        .await
        .map_err(|err| format!("sql_list_connections task failed: {err}"))?
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn sql_save_connection(
    state: State<'_, Arc<SqlConnectionStore>>,
    request: SqlSaveConnectionRequest,
) -> Result<SqlSavedConnection, String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.save_connection(request))
        .await
        .map_err(|err| format!("sql_save_connection task failed: {err}"))?
}

#[tauri::command]
pub async fn sql_list_saved_connections(
    state: State<'_, Arc<SqlConnectionStore>>,
) -> Result<Vec<SqlSavedConnection>, String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.list_saved_connections())
        .await
        .map_err(|err| format!("sql_list_saved_connections task failed: {err}"))?
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn sql_remove_saved_connection(
    state: State<'_, Arc<SqlConnectionStore>>,
    request: SqlRemoveSavedConnectionRequest,
) -> Result<(), String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.remove_saved_connection(request))
        .await
        .map_err(|err| format!("sql_remove_saved_connection task failed: {err}"))?
}

#[tauri::command]
pub async fn sql_restore_saved_connections(
    state: State<'_, Arc<SqlConnectionStore>>,
) -> Result<SqlRestoreSavedConnectionsResult, String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.restore_saved_connections())
        .await
        .map_err(|err| format!("sql_restore_saved_connections task failed: {err}"))?
}
```

---

## 6. 修改 `src-tauri/src/lib.rs`

### 6.1 在 setup 里初始化持久化路径

在 `.setup(|app| {` 里拿到 `app_data` 后，`app.manage(Arc::new(db));` 之后追加：

```rust
            {
                let sql_store = app.state::<Arc<SqlConnectionStore>>();
                let sql_connections_path = app_data.join("sql-connections.json");

                if let Err(err) = sql_store.initialize_persistence(sql_connections_path) {
                    log::warn!("SQL connection persistence disabled: {err}");
                }
            }
```

放置位置建议在这里：

```rust
            app.manage(Arc::new(db));

            {
                let sql_store = app.state::<Arc<SqlConnectionStore>>();
                let sql_connections_path = app_data.join("sql-connections.json");

                if let Err(err) = sql_store.initialize_persistence(sql_connections_path) {
                    log::warn!("SQL connection persistence disabled: {err}");
                }
            }
```

### 6.2 注册 command

在 `tauri::generate_handler![...]` 里追加：

```rust
commands::sql_save_connection,
commands::sql_list_saved_connections,
commands::sql_remove_saved_connection,
commands::sql_restore_saved_connections,
```

最终 SQL command 区域至少要有：

```rust
commands::sql_test_connection,
commands::sql_open_connection,
commands::sql_close_connection,
commands::sql_list_connections,
commands::sql_save_connection,
commands::sql_list_saved_connections,
commands::sql_remove_saved_connection,
commands::sql_restore_saved_connections,
commands::sql_list_tables,
commands::sql_list_columns,
commands::sql_execute_query,
commands::sql_cancel_query,
```

---

# 后端单元测试

在 `src-tauri/src/commands/sql/state.rs` 的 `#[cfg(test)] mod tests` 里追加：

```rust
#[test]
fn save_connection_persists_and_lists_saved_connections() {
    let store = SqlConnectionStore::new();
    let path = temp_json_file("save-list");

    store.initialize_persistence(path.clone()).unwrap();

    let db = TempDb::new("save-list-db");

    let saved = store
        .save_connection(SqlSaveConnectionRequest {
            input: db.input("local"),
            auto_connect: true,
            open_now: false,
        })
        .unwrap();

    assert_eq!(saved.id, "local");
    assert!(saved.auto_connect);

    let saved_connections = store.list_saved_connections().unwrap();
    assert_eq!(saved_connections.len(), 1);
    assert_eq!(saved_connections[0].id, "local");

    let reloaded = SqlConnectionStore::new();
    reloaded.initialize_persistence(path.clone()).unwrap();

    let saved_connections = reloaded.list_saved_connections().unwrap();
    assert_eq!(saved_connections.len(), 1);
    assert_eq!(saved_connections[0].id, "local");

    let _ = std::fs::remove_file(path);
}

#[test]
fn save_connection_can_open_connection_immediately() {
    let store = SqlConnectionStore::new();
    let path = temp_json_file("save-open-now");

    store.initialize_persistence(path.clone()).unwrap();

    let db = TempDb::new("save-open-now-db");

    store
        .save_connection(SqlSaveConnectionRequest {
            input: db.input("local"),
            auto_connect: true,
            open_now: true,
        })
        .unwrap();

    let opened = store.list_connections().unwrap();
    assert_eq!(opened.len(), 1);
    assert_eq!(opened[0].id, "local");

    let _ = std::fs::remove_file(path);
}

#[test]
fn remove_saved_connection_deletes_saved_entry_and_optionally_closes_open_connection() {
    let store = SqlConnectionStore::new();
    let path = temp_json_file("remove");

    store.initialize_persistence(path.clone()).unwrap();

    let db = TempDb::new("remove-db");

    store
        .save_connection(SqlSaveConnectionRequest {
            input: db.input("local"),
            auto_connect: true,
            open_now: true,
        })
        .unwrap();

    store
        .remove_saved_connection(SqlRemoveSavedConnectionRequest {
            connection_id: "local".to_string(),
            close_if_open: true,
        })
        .unwrap();

    assert_eq!(store.list_saved_connections().unwrap().len(), 0);
    assert_eq!(store.list_connections().unwrap().len(), 0);

    let _ = std::fs::remove_file(path);
}

#[test]
fn restore_saved_connections_opens_auto_connect_connections() {
    let path = temp_json_file("restore");

    let store = SqlConnectionStore::new();
    store.initialize_persistence(path.clone()).unwrap();

    let db = TempDb::new("restore-db");

    store
        .save_connection(SqlSaveConnectionRequest {
            input: db.input("local"),
            auto_connect: true,
            open_now: false,
        })
        .unwrap();

    let restored = SqlConnectionStore::new();
    restored.initialize_persistence(path.clone()).unwrap();

    let result = restored.restore_saved_connections().unwrap();

    assert_eq!(result.opened.len(), 1);
    assert_eq!(result.errors.len(), 0);
    assert_eq!(result.opened[0].id, "local");
    assert_eq!(restored.list_connections().unwrap().len(), 1);

    let _ = std::fs::remove_file(path);
}

#[test]
fn restore_saved_connections_reports_failed_auto_connect() {
    let path = temp_json_file("restore-error");

    let store = SqlConnectionStore::new();
    store.initialize_persistence(path.clone()).unwrap();

    store
        .save_connection(SqlSaveConnectionRequest {
            input: SqlConnectionInput {
                id: Some("missing".to_string()),
                name: Some("Missing".to_string()),
                kind: SqlConnectionKind::Sqlite,
                database_path: "/definitely/missing/sql-studio-next.db".to_string(),
                read_only: false,
                create_if_missing: false,
            },
            auto_connect: true,
            open_now: false,
        })
        .unwrap();

    let restored = SqlConnectionStore::new();
    restored.initialize_persistence(path.clone()).unwrap();

    let result = restored.restore_saved_connections().unwrap();

    assert_eq!(result.opened.len(), 0);
    assert_eq!(result.errors.len(), 1);
    assert_eq!(result.errors[0].connection_id, "missing");

    let _ = std::fs::remove_file(path);
}

fn temp_json_file(name: &str) -> std::path::PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();

    std::env::temp_dir().join(format!("sql-studio-next-{name}-{now}.json"))
}
```

> 如果当前 `TempDb` helper 是私有或命名不同，把上面测试里的 `TempDb::new(...).input(...)` 换成当前 `state.rs` 测试模块已有的 helper 写法即可。

---

# 前端实现

## 1. 修改 `src/vs/workbench/services/sql/common/sqlTypes.ts`

追加：

```ts
export interface SqlSavedConnection {
	id: string;
	name: string;
	kind: SqlConnectionKind;
	databasePath: string;
	readOnly: boolean;
	createIfMissing: boolean;
	autoConnect: boolean;
}

export interface SqlSaveConnectionRequest {
	input: SqlConnectionInput;
	autoConnect?: boolean;
	openNow?: boolean;
}

export interface SqlRemoveSavedConnectionRequest {
	connectionId: string;
	closeIfOpen?: boolean;
}

export interface SqlRestoreSavedConnectionError {
	connectionId: string;
	name: string;
	error: string;
}

export interface SqlRestoreSavedConnectionsResult {
	opened: SqlConnection[];
	errors: SqlRestoreSavedConnectionError[];
}
```

---

## 2. 修改 `src/vs/workbench/services/sql/common/sqlConnection.ts`

替换为完整文件：

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL connection service contract.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	SqlConnection,
	SqlConnectionInput,
	SqlConnectionTestResult,
	SqlRemoveSavedConnectionRequest,
	SqlRestoreSavedConnectionsResult,
	SqlSaveConnectionRequest,
	SqlSavedConnection
} from './sqlTypes.js';

export const ISqlConnectionService = createDecorator<ISqlConnectionService>('sqlConnectionService');

export interface ISqlConnectionService {
	readonly _serviceBrand: undefined;

	testConnection(input: SqlConnectionInput): Promise<SqlConnectionTestResult>;

	openConnection(input: SqlConnectionInput): Promise<SqlConnection>;

	closeConnection(connectionId: string): Promise<void>;

	listConnections(): Promise<SqlConnection[]>;

	saveConnection(request: SqlSaveConnectionRequest): Promise<SqlSavedConnection>;

	listSavedConnections(): Promise<SqlSavedConnection[]>;

	removeSavedConnection(request: SqlRemoveSavedConnectionRequest): Promise<void>;

	restoreSavedConnections(): Promise<SqlRestoreSavedConnectionsResult>;
}
```

---

## 3. 修改 `src/vs/workbench/services/sql/common/sqlValidation.ts`

追加：

```ts
import { SqlRemoveSavedConnectionRequest, SqlSaveConnectionRequest } from './sqlTypes.js';
```

如果已有 import，则合并进去。

然后追加函数：

```ts
export function normalizeSqlSaveConnectionRequest(request: SqlSaveConnectionRequest): SqlSaveConnectionRequest {
	if (!request || typeof request !== 'object') {
		throw new Error('save connection request must be an object');
	}

	return {
		input: normalizeSqlConnectionInput(request.input),
		autoConnect: request.autoConnect === true,
		openNow: request.openNow === true
	};
}

export function normalizeSqlRemoveSavedConnectionRequest(
	request: SqlRemoveSavedConnectionRequest
): SqlRemoveSavedConnectionRequest {
	if (!request || typeof request !== 'object') {
		throw new Error('remove saved connection request must be an object');
	}

	return {
		connectionId: normalizeConnectionId(request.connectionId),
		closeIfOpen: request.closeIfOpen === true
	};
}
```

---

## 4. 修改 `src/vs/workbench/services/sql/browser/sqlCommandExecutor.ts`

把 `SqlCommandName` 扩展为：

```ts
export type SqlCommandName =
	| 'sql_test_connection'
	| 'sql_open_connection'
	| 'sql_close_connection'
	| 'sql_list_connections'
	| 'sql_save_connection'
	| 'sql_list_saved_connections'
	| 'sql_remove_saved_connection'
	| 'sql_restore_saved_connections'
	| 'sql_list_tables'
	| 'sql_list_columns'
	| 'sql_execute_query'
	| 'sql_cancel_query';
```

---

## 5. 替换 `src/vs/workbench/services/sql/browser/sqlConnectionService.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL connection service implementation.
 *--------------------------------------------------------------------------------------------*/

import { ISqlConnectionService } from '../common/sqlConnection.js';
import {
	SqlConnection,
	SqlConnectionInput,
	SqlConnectionTestResult,
	SqlRemoveSavedConnectionRequest,
	SqlRestoreSavedConnectionsResult,
	SqlSaveConnectionRequest,
	SqlSavedConnection
} from '../common/sqlTypes.js';
import {
	normalizeConnectionId,
	normalizeSqlConnectionInput,
	normalizeSqlRemoveSavedConnectionRequest,
	normalizeSqlSaveConnectionRequest
} from '../common/sqlValidation.js';
import { ISqlCommandExecutor, TauriSqlCommandExecutor, toSqlServiceError } from './sqlCommandExecutor.js';

export class SqlConnectionService implements ISqlConnectionService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly executor: ISqlCommandExecutor = new TauriSqlCommandExecutor()) {}

	async testConnection(input: SqlConnectionInput): Promise<SqlConnectionTestResult> {
		const normalized = normalizeSqlConnectionInput(input);

		try {
			return await this.executor.execute<SqlConnectionTestResult>('sql_test_connection', {
				input: normalized
			});
		} catch (error) {
			throw toSqlServiceError('sql_test_connection', error);
		}
	}

	async openConnection(input: SqlConnectionInput): Promise<SqlConnection> {
		const normalized = normalizeSqlConnectionInput(input);

		try {
			return await this.executor.execute<SqlConnection>('sql_open_connection', {
				input: normalized
			});
		} catch (error) {
			throw toSqlServiceError('sql_open_connection', error);
		}
	}

	async closeConnection(connectionId: string): Promise<void> {
		const normalizedConnectionId = normalizeConnectionId(connectionId);

		try {
			await this.executor.execute<void>('sql_close_connection', {
				connectionId: normalizedConnectionId
			});
		} catch (error) {
			throw toSqlServiceError('sql_close_connection', error);
		}
	}

	async listConnections(): Promise<SqlConnection[]> {
		try {
			const connections = await this.executor.execute<SqlConnection[]>('sql_list_connections');
			return Array.isArray(connections) ? connections : [];
		} catch (error) {
			throw toSqlServiceError('sql_list_connections', error);
		}
	}

	async saveConnection(request: SqlSaveConnectionRequest): Promise<SqlSavedConnection> {
		const normalized = normalizeSqlSaveConnectionRequest(request);

		try {
			return await this.executor.execute<SqlSavedConnection>('sql_save_connection', {
				request: normalized
			});
		} catch (error) {
			throw toSqlServiceError('sql_save_connection', error);
		}
	}

	async listSavedConnections(): Promise<SqlSavedConnection[]> {
		try {
			const connections = await this.executor.execute<SqlSavedConnection[]>('sql_list_saved_connections');
			return Array.isArray(connections) ? connections : [];
		} catch (error) {
			throw toSqlServiceError('sql_list_saved_connections', error);
		}
	}

	async removeSavedConnection(request: SqlRemoveSavedConnectionRequest): Promise<void> {
		const normalized = normalizeSqlRemoveSavedConnectionRequest(request);

		try {
			await this.executor.execute<void>('sql_remove_saved_connection', {
				request: normalized
			});
		} catch (error) {
			throw toSqlServiceError('sql_remove_saved_connection', error);
		}
	}

	async restoreSavedConnections(): Promise<SqlRestoreSavedConnectionsResult> {
		try {
			return await this.executor.execute<SqlRestoreSavedConnectionsResult>('sql_restore_saved_connections');
		} catch (error) {
			throw toSqlServiceError('sql_restore_saved_connections', error);
		}
	}
}
```

---

# 前端单元测试

在 `src/vs/workbench/services/sql/test/sqlServices.test.ts` 追加：

```ts
test('SqlConnectionService.saveConnection invokes sql_save_connection with normalized request', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_save_connection', {
		id: 'local',
		name: 'Local SQLite',
		kind: SqlConnectionKind.Sqlite,
		databasePath: '/tmp/app.db',
		readOnly: false,
		createIfMissing: true,
		autoConnect: true
	});

	const service = new SqlConnectionService(executor);

	const saved = await service.saveConnection({
		input: {
			id: ' local ',
			name: ' Local SQLite ',
			kind: SqlConnectionKind.Sqlite,
			databasePath: ' /tmp/app.db ',
			createIfMissing: true
		},
		autoConnect: true,
		openNow: true
	});

	assert.equal(saved.id, 'local');

	assert.deepEqual(executor.lastCall(), {
		command: 'sql_save_connection',
		args: {
			request: {
				input: {
					id: 'local',
					name: 'Local SQLite',
					kind: SqlConnectionKind.Sqlite,
					databasePath: '/tmp/app.db',
					readOnly: false,
					createIfMissing: true
				},
				autoConnect: true,
				openNow: true
			}
		}
	});
});

test('SqlConnectionService.listSavedConnections returns empty array for non-array backend value', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_list_saved_connections', null);

	const service = new SqlConnectionService(executor);

	assert.deepEqual(await service.listSavedConnections(), []);
});

test('SqlConnectionService.removeSavedConnection invokes sql_remove_saved_connection', async () => {
	const executor = new FakeSqlCommandExecutor();
	const service = new SqlConnectionService(executor);

	await service.removeSavedConnection({
		connectionId: ' local ',
		closeIfOpen: true
	});

	assert.deepEqual(executor.lastCall(), {
		command: 'sql_remove_saved_connection',
		args: {
			request: {
				connectionId: 'local',
				closeIfOpen: true
			}
		}
	});
});

test('SqlConnectionService.restoreSavedConnections invokes sql_restore_saved_connections', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_restore_saved_connections', {
		opened: [],
		errors: []
	});

	const service = new SqlConnectionService(executor);
	const result = await service.restoreSavedConnections();

	assert.deepEqual(result, {
		opened: [],
		errors: []
	});

	assert.deepEqual(executor.lastCall(), {
		command: 'sql_restore_saved_connections',
		args: {}
	});
});
```

---

# UI 修改：SQL Connections View

Phase 6.5 可以先做最小 UI：

```txt
Add Connection Form
  [x] Save connection
  [x] Auto connect

Saved Connections
  Local SQLite
    Open
    Remove
```

实现建议：

1. `SqlConnectionsView` 增加字段：

```ts
private saveConnectionInput!: HTMLInputElement;
private autoConnectInput!: HTMLInputElement;
private savedConnectionsElement!: HTMLElement;
private savedConnections: SqlSavedConnection[] = [];
private didRestoreSavedConnections = false;
```

2. `renderConnectionForm()` 的 options 里增加：

```ts
const saveLabel = append(options, $('label.sql-connections-checkbox'));
this.saveConnectionInput = append(saveLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
this.saveConnectionInput.checked = true;
append(saveLabel, $('span', undefined, 'Save'));

const autoConnectLabel = append(options, $('label.sql-connections-checkbox'));
this.autoConnectInput = append(autoConnectLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
this.autoConnectInput.checked = true;
append(autoConnectLabel, $('span', undefined, 'Auto connect'));
```

3. `renderBody()` 里在 message 前追加：

```ts
this.savedConnectionsElement = append(this.body, $('.sql-saved-connections'));
```

4. `refresh()` 开头追加一次 restore：

```ts
if (!this.didRestoreSavedConnections) {
	this.didRestoreSavedConnections = true;
	await this.sqlConnectionService.restoreSavedConnections();
}
```

5. `refresh()` 中同时加载 saved：

```ts
this.savedConnections = await this.sqlConnectionService.listSavedConnections();
this.renderSavedConnections();
```

6. `addConnectionFromForm()` 里把原来的 `openConnection()` 改成：

```ts
if (this.saveConnectionInput.checked) {
	await this.sqlConnectionService.saveConnection({
		input: {
			name: name || undefined,
			kind: SqlConnectionKind.Sqlite,
			databasePath,
			readOnly: this.readOnlyInput.checked,
			createIfMissing: this.createIfMissingInput.checked
		},
		autoConnect: this.autoConnectInput.checked,
		openNow: true
	});
} else {
	await this.sqlConnectionService.openConnection({
		name: name || undefined,
		kind: SqlConnectionKind.Sqlite,
		databasePath,
		readOnly: this.readOnlyInput.checked,
		createIfMissing: this.createIfMissingInput.checked
	});
}
```

7. 增加方法：

```ts
private renderSavedConnections(): void {
	clearNode(this.savedConnectionsElement);

	if (this.savedConnections.length === 0) {
		return;
	}

	const title = append(this.savedConnectionsElement, $('.sql-saved-connections-title'));
	title.textContent = 'Saved Connections';

	for (const saved of this.savedConnections) {
		const row = append(this.savedConnectionsElement, $('.sql-saved-connection-row'));

		append(row, $('span.sql-saved-connection-name', undefined, saved.name));

		const openButton = append(
			row,
			$('button.sql-saved-connection-action', { type: 'button' }, 'Open')
		) as HTMLButtonElement;

		const removeButton = append(
			row,
			$('button.sql-saved-connection-action.danger', { type: 'button' }, 'Remove')
		) as HTMLButtonElement;

		this.treeRenderDisposables.add(
			addDisposableListener(openButton, EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				this.openSavedConnection(saved).catch(error => this.showError(error));
			})
		);

		this.treeRenderDisposables.add(
			addDisposableListener(removeButton, EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				this.removeSavedConnection(saved.id).catch(error => this.showError(error));
			})
		);
	}
}

private async openSavedConnection(saved: SqlSavedConnection): Promise<void> {
	await this.sqlConnectionService.openConnection({
		id: saved.id,
		name: saved.name,
		kind: saved.kind,
		databasePath: saved.databasePath,
		readOnly: saved.readOnly,
		createIfMissing: saved.createIfMissing
	});

	this.showInfo(`Connected to ${saved.name}.`);
	await this.refresh();
}

private async removeSavedConnection(connectionId: string): Promise<void> {
	await this.sqlConnectionService.removeSavedConnection({
		connectionId,
		closeIfOpen: false
	});

	this.showInfo('Saved connection removed.');
	await this.refresh();
}
```

> 注意：`renderSavedConnections()` 使用 `treeRenderDisposables` 前，确保 `refresh()` / `renderTree()` 前会清理；或者单独新增 `savedRenderDisposables`，更干净。

---

# CSS 追加

在 `sqlConnections.css` 追加：

```css
.sql-saved-connections {
	display: flex;
	flex-direction: column;
	gap: 4px;
	padding: 4px 0;
	border-bottom: 1px solid var(--vscode-editorGroup-border);
}

.sql-saved-connections-title {
	font-size: 11px;
	font-weight: 600;
	opacity: 0.75;
	padding: 2px 0;
}

.sql-saved-connection-row {
	display: flex;
	align-items: center;
	gap: 6px;
	min-height: 24px;
}

.sql-saved-connection-name {
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.sql-saved-connection-action {
	height: 22px;
	padding: 0 8px;
	border: 1px solid var(--vscode-button-border);
	color: var(--vscode-button-secondaryForeground);
	background: var(--vscode-button-secondaryBackground);
	cursor: pointer;
	font-size: 11px;
}

.sql-saved-connection-action:hover {
	background: var(--vscode-button-hoverBackground);
}

.sql-saved-connection-action.danger:hover {
	color: var(--vscode-errorForeground);
}
```

---

# 验收命令

```bash
cd src-tauri
cargo test sql

cd ..
pnpm run test:sql-services
pnpm run test
pnpm run lint
pnpm run build
```

---

# 手动验收

```txt
1. pnpm tauri dev
2. 添加 SQLite 连接，勾选 Save + Auto connect
3. 退出应用
4. 重新打开应用
5. SQL Connections 自动恢复连接
6. Saved Connections 区域显示连接
7. 点击 Remove
8. 重启后不再恢复该连接
```

---

# Phase 6.5 完成后的状态

```txt
Phase 2：Rust SQL Commands
Phase 3：Workbench SQL Services
Phase 4：SQL Connections Activity
Phase 4.5：Tree -> SQL Editor
Phase 5：SQL Editor
Phase 6：Result Panel
Phase 6.5：Connection Persistence
```

这个阶段完成后，SQLite MVP 已经具备“日常可用”的基础体验。下一步建议：

```txt
Phase 7：迁移旧 sql-studio/mvp 领域资产
```

优先迁移：

```txt
1. sqlgui-db 的数据库抽象
2. sqlgui-common 的类型定义
3. Result Grid 交互经验
4. SQL formatter / dialect 基础
```

不要马上做 AI Agent。先把 MySQL/Postgres 的连接模型、secret 存储和数据库抽象补上，否则 AI 只会挂在一个还不稳定的数据底座上。
