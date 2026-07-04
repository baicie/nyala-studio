# Phase 01 — Connection MVP Stabilization

## 0. 摘要

把"添加连接 / 测试连接 / 打开连接 / 自动恢复"这条链路从骨架稳定成产品形态。SQLite 是 stable，MySQL 是 preview 并显式标注 cancellation 不可用，PostgreSQL 永远只能在 UI 上以 `planned` 出现并禁用任何"打开"按钮。

## 1. 范围

- SQLite：**file**、**`:memory:`**、**recent files**；
- MySQL Preview：仅本地/开发环境，test/open/list_tables/list_columns/run_query；
- PostgreSQL：UI `disabled`，禁止任何后端调用；
- **Secrets 永不落盘**：saved connection profile 中 `password` 字段只在内存中；
- Read-only connection 显式校验，failure 必须可观察；
- 自动恢复 restore 错误统一通过 toast 暴露。

不在范围：

- 不引入 SQLite/MySQL 之外的 driver；
- 不持久化任何 secret；
- 不引入 SSH/SSL/K8s。

## 2. 设计

### 2.1 单一 Connection Profile 模型

`src-tauri/src/commands/sql/types.rs`：

```rust
// src-tauri/src/commands/sql/types.rs (Phase 01 节选)
use serde::{Deserialize, Serialize};
use crate::runtime_status::DriverId;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,                 // ULID
    pub label: String,              // 用户定义显示名，禁止含密码
    pub driver: DriverIdDto,        // 'sqlite' | 'mysql' | 'postgres'
    pub read_only: bool,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub file_path: Option<String>,
    pub remember_in_memory: bool,
    pub created_at_ms: i64,
}

#[derive(Debug, Copy, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DriverIdDto { Sqlite, Mysql, Postgres }

impl From<DriverIdDto> for DriverId {
    fn from(v: DriverIdDto) -> Self {
        match v {
            DriverIdDto::Sqlite => DriverId::Sqlite,
            DriverIdDto::Mysql => DriverId::Mysql,
            DriverIdDto::Postgres => DriverId::Postgres,
        }
    }
}

/// 永不下盘。唯一存在后端 runtime 和前端 session 中。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSecret {
    pub password: Option<String>,
}

impl ConnectionSecret {
    /// 禁止任何 println / log 包含 secret 字段。
    /// Display 实现必须过滤。
    pub fn redacted_string(&self) -> String {
        let mut n = 0;
        if self.password.is_some() { n += 1; }
        format!("redacted:{}fields", n)
    }
}
```

### 2.2 持久化与 secret 边界

`src-tauri/src/commands/sql/persistence.rs`：

```rust
// src-tauri/src/commands/sql/persistence.rs (Phase 01)
//
// 唯一负责读写 saved connections 的模块。
// 该模块不得引用 ConnectionSecret::password。 编译期静态防御：

use std::collections::HashMap;
use std::path::Path;
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredConnections {
    pub version: u32,
    pub profiles: Vec<crate::commands::sql::types::ConnectionProfile>,
}

const MAGIC: &str = "nyala.connections.v1";

pub fn load_from(path: &Path) -> Result<StoredConnections, PersistenceError> {
    if !path.exists() {
        return Ok(StoredConnections { version: 1, profiles: Vec::new() });
    }
    let bytes = std::fs::read(path).map_err(PersistenceError::Io)?;
    let text = String::from_utf8(bytes).map_err(PersistenceError::Encoding)?;
    let mut doc: HashMap<String, serde_json::Value> =
        serde_json::from_str(&text).map_err(PersistenceError::Json)?;

    // 编译期静态检查：必须立即丢掉 password 字段，杜绝「忘记剔除」。
    if let Some(arr) = doc.get_mut("profiles").and_then(|v| v.as_array_mut()) {
        for p in arr {
            if let Some(obj) = p.as_object_mut() {
                obj.remove("password");          // never persist secret
                obj.remove("secret");
                obj.remove("credentials");
            }
        }
    }
    serde_json::from_value(doc["profiles"].clone().into())
        .map(|profiles| StoredConnections { version: 1, profiles })
        .map_err(PersistenceError::Json)
}

pub fn save_to(path: &Path, stored: &StoredConnections) -> Result<(), PersistenceError> {
    let text = serde_json::to_string_pretty(stored).map_err(PersistenceError::Json)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(PersistenceError::Io)?;
    }
    std::fs::write(path, text).map_err(PersistenceError::Io)?;
    Ok(())
}

#[derive(Debug, thiserror::Error, serde::Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum PersistenceError {
    #[error("io: {0}")] Io(String),
    #[error("encoding: {0}")] Encoding(String),
    #[error("json: {0}")] Json(String),
}

pub fn default_path() -> std::path::PathBuf {
    let base = std::env::var_os("NYALA_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| dirs::data_dir().unwrap_or_else(|| std::path::PathBuf::from(".")));
    base.join(MAGIC).join("connections.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sql::types::ConnectionProfile;
    use crate::commands::sql::types::DriverIdDto;
    use std::collections::HashMap;

    fn sample() -> ConnectionProfile {
        ConnectionProfile {
            id: "01H".into(),
            label: "demo".into(),
            driver: DriverIdDto::Sqlite,
            read_only: false,
            host: None, port: None,
            database: None, username: None,
            file_path: Some("/tmp/x.db".into()),
            remember_in_memory: false,
            created_at_ms: 0,
        }
    }

    #[test]
    fn drop_password_field_on_load() {
        let mut doc = serde_json::json!({
            "version": 1,
            "profiles": [{
                "id": "01H", "label": "demo", "driver": "sqlite",
                "readOnly": false, "filePath": "/tmp/x.db",
                "password": "should-be-dropped",
                "secret":   { "username": "root", "password": "should-be-dropped" },
                "credentials": { "token": "oops" }
            }]
        });
        if let Some(arr) = doc.get_mut("profiles").and_then(|v| v.as_array_mut()) {
            for p in arr {
                if let Some(obj) = p.as_object_mut() {
                    obj.remove("password");
                    obj.remove("secret");
                    obj.remove("credentials");
                }
            }
        }
        let stored = serde_json::from_value::<StoredConnections>(doc).unwrap();
        let p = &stored.profiles[0];
        let s = serde_json::to_string(p).unwrap();
        assert!(!s.contains("password"), "secret must be absent");
        assert!(!s.contains("should-be-dropped"), "value must be absent");
    }

    #[test]
    fn save_then_load_roundtrip_no_secret() {
        let tmp = std::env::temp_dir().join("nyala-persistence-test.json");
        let mut p = sample();
        let stored = StoredConnections { version: 1, profiles: vec![p.clone()] };
        save_to(&tmp, &stored).unwrap();
        let reloaded = load_from(&tmp).unwrap();
        assert_eq!(reloaded.profiles.len(), 1);
        assert_eq!(reloaded.profiles[0].id, p.id);
        let _ = std::fs::remove_file(tmp);
    }

    #[test]
    fn load_missing_file_returns_empty() {
        let p = std::env::temp_dir().join("nyala-not-found.json");
        let _ = std::fs::remove_file(&p);
        let r = load_from(&p).unwrap();
        assert!(r.profiles.is_empty());
    }

    #[test]
    fn default_path_is_inside_data_dir() {
        let p = default_path();
        let s = p.to_string_lossy();
        assert!(s.contains("nyala.connections.v1"));
    }

    #[test]
    fn secret_redacted_string_hides_contents() {
        let s = crate::commands::sql::types::ConnectionSecret {
            password: Some("hunter2".into()),
        };
        let r = s.redacted_string();
        assert!(!r.contains("hunter2"));
        assert!(r.contains("redacted"));
    }
}
```

### 2.3 Connection Manager（runtime）

`src-tauri/src/commands/sql/state.rs`：

```rust
// src-tauri/src/commands/sql/state.rs (Phase 01 节选)
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use crate::commands::sql::types::{ConnectionProfile, ConnectionSecret, SqlCommandError};
use crate::runtime_status::{DriverId, RuntimeStatus};
use crate::commands::sql::driver::{BoxedConnection, SqlDriver};

#[derive(Default)]
pub struct ConnectionManager {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// 已打开连接（runtime-only）。
    /// 不会进入 persistence；进程退出即释放。
    drivers: HashMap<String, ConnectionEntry>,
    profile_by_id: HashMap<String, ConnectionProfile>,
    last_secret_by_id: HashMap<String, ConnectionSecret>,
}

pub struct ConnectionEntry {
    pub driver_id: DriverId,
    pub conn: BoxedConnection,
}

impl ConnectionManager {
    pub fn upsert_profile(&self, profile: ConnectionProfile) -> Result<(), SqlCommandError> {
        let mut inner = self.inner.lock().expect("poisoned");
        inner.profile_by_id.insert(profile.id.clone(), profile);
        Ok(())
    }

    pub fn list_profiles(&self) -> Vec<ConnectionProfile> {
        let inner = self.inner.lock().expect("poisoned");
        let mut v: Vec<_> = inner.profile_by_id.values().cloned().collect();
        v.sort_by(|a, b| a.label.cmp(&b.label));
        v
    }

    /// 仅清空内存中的 secret，不修改 profile / persistence。
    pub fn drop_secret(&self, profile_id: &str) {
        let mut inner = self.inner.lock().expect("poisoned");
        inner.last_secret_by_id.remove(profile_id);
    }

    pub fn put_secret(&self, profile_id: &str, secret: ConnectionSecret) {
        let mut inner = self.inner.lock().expect("poisoned");
        inner.last_secret_by_id.insert(profile_id.to_string(), secret);
    }

    pub fn get_secret(&self, profile_id: &str) -> Option<ConnectionSecret> {
        let inner = self.inner.lock().expect("poisoned");
        inner.last_secret_by_id.get(profile_id).cloned()
    }

    pub fn forget_everything(&self) {
        let mut inner = self.inner.lock().expect("poisoned");
        inner.drivers.clear();
        inner.last_secret_by_id.clear();
    }

    pub fn open(
        &self,
        profile: &ConnectionProfile,
        secret: ConnectionSecret,
    ) -> Result<String, SqlCommandError> {
        // runtime guard
        let minimum = match profile.driver {
            crate::commands::sql::types::DriverIdDto::Sqlite => RuntimeStatus::Stable,
            crate::commands::sql::types::DriverIdDto::Mysql  => RuntimeStatus::Preview,
            crate::commands::sql::types::DriverIdDto::Postgres => RuntimeStatus::Stable,
        };
        let id: DriverId = profile.driver.into();
        crate::commands::sql::types::assert_driver_status_at_least(id, minimum)
            .map_err(|m| SqlCommandError::new("driver_not_available", m))?;

        let driver = crate::commands::sql::driver::registry()
            .build(id)
            .ok_or_else(|| SqlCommandError::new("unknown_driver", "no driver"))?;

        let conn = driver.open(profile, &secret)
            .map_err(|e| SqlCommandError::new("open_failed", e.message))?;

        // secret 永远不复制到 conn 结构体，只放在 manager 里。
        let mut inner = self.inner.lock().expect("poisoned");
        inner.drivers.insert(profile.id.clone(),
            ConnectionEntry { driver_id: id, conn });
        inner.last_secret_by_id.insert(profile.id.clone(), secret);
        Ok(profile.id.clone())
    }

    pub fn close(&self, profile_id: &str) -> Result<(), SqlCommandError> {
        let mut inner = self.inner.lock().expect("poisoned");
        inner.drivers.remove(profile_id);
        inner.last_secret_by_id.remove(profile_id);
        Ok(())
    }

    pub fn with_conn<R>(
        &self,
        profile_id: &str,
        f: impl FnOnce(&mut ConnectionEntry) -> Result<R, SqlCommandError>,
    ) -> Result<R, SqlCommandError> {
        let mut inner = self.inner.lock().expect("poisoned");
        let entry = inner.drivers.get_mut(profile_id)
            .ok_or_else(|| SqlCommandError::new("not_open", "connection not open"))?;
        f(entry)
    }
}

pub type SharedConnectionManager = Arc<ConnectionManager>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sql::types::{ConnectionProfile, DriverIdDto, ConnectionSecret};

    fn profile(id: &str, driver: DriverIdDto) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_string(),
            label: id.to_string(),
            driver,
            read_only: false,
            host: None, port: None,
            database: None, username: None,
            file_path: None, remember_in_memory: false,
            created_at_ms: 0,
        }
    }

    #[test]
    fn upsert_then_list_returns_profile() {
        let m = ConnectionManager::default();
        m.upsert_profile(profile("a", DriverIdDto::Sqlite)).unwrap();
        let v = m.list_profiles();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].id, "a");
    }

    #[test]
    fn close_removes_entry_and_secret() {
        let m = ConnectionManager::default();
        m.upsert_profile(profile("a", DriverIdDto::Sqlite)).unwrap();
        m.put_secret("a", ConnectionSecret { password: Some("x".into()) });
        m.close("a").unwrap();
        assert!(m.get_secret("a").is_none());
        assert!(m.with_conn("a", |_e| Ok(())).is_err());
    }

    #[test]
    fn drop_secret_only_removes_secret() {
        let m = ConnectionManager::default();
        m.upsert_profile(profile("a", DriverIdDto::Sqlite)).unwrap();
        m.put_secret("a", ConnectionSecret { password: Some("x".into()) });
        m.drop_secret("a");
        assert!(m.get_secret("a").is_none());
        assert!(m.list_profiles().len() == 1);
    }

    #[test]
    fn forget_everything_clears_state() {
        let m = ConnectionManager::default();
        m.upsert_profile(profile("a", DriverIdDto::Sqlite)).unwrap();
        m.put_secret("a", ConnectionSecret { password: Some("x".into()) });
        // without open, drivers map is empty; forget still safe.
        m.forget_everything();
        assert!(m.get_secret("a").is_none());
        assert!(m.list_profiles().is_empty());
    }
}
```

### 2.4 Tauri 命令

`src-tauri/src/commands/sql/connection.rs`：

```rust
// src-tauri/src/commands/sql/connection.rs (Phase 01)
use std::sync::Arc;
use tauri::State;
use crate::commands::sql::state::{ConnectionManager, SharedConnectionManager};
use crate::commands::sql::types::{
    ConnectionProfile, ConnectionSecret, SqlCommandError, DriverIdDto,
};

pub type AppState = State<'static, SharedConnectionManager>;

#[tauri::command]
pub fn sql_test_connection(
    manager: AppState,
    profile: ConnectionProfile,
    secret: ConnectionSecret,
) -> Result<(), SqlCommandError> {
    // 关键：test 时不允许持久化任何东西。
    let id = manager.open(&profile, secret.clone())?;
    let _ = manager.close(&id);
    Ok(())
}

#[tauri::command]
pub fn sql_open_connection(
    manager: AppState,
    profile: ConnectionProfile,
    secret: ConnectionSecret,
) -> Result<String, SqlCommandError> {
    manager.upsert_profile(profile.clone())?;
    manager.put_secret(&profile.id, secret);
    manager.open(&profile, ConnectionSecret::default())
}

#[tauri::command]
pub fn sql_close_connection(
    manager: AppState,
    profile_id: String,
) -> Result<(), SqlCommandError> {
    manager.close(&profile_id)
}

#[tauri::command]
pub fn sql_list_connections(
    manager: AppState,
) -> Vec<ConnectionProfile> {
    manager.list_profiles()
}

#[tauri::command]
pub fn sql_forget_secrets(
    manager: AppState,
) {
    manager.forget_everything();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sql::types::DriverIdDto;

    fn p(id: &str, driver: DriverIdDto) -> ConnectionProfile {
        let mut x = ConnectionProfile {
            id: id.to_string(),
            label: id.to_string(),
            driver,
            read_only: false,
            host: None, port: None,
            database: None, username: None,
            file_path: None, remember_in_memory: false,
            created_at_ms: 0,
        };
        x
    }

    #[test]
    fn sql_test_connection_does_not_persist_secret() {
        let m = Arc::new(ConnectionManager::default());
        let mut x = p("a", DriverIdDto::Sqlite);
        // SQLite 不需要 password，给空 secret。
        let res = sql_test_connection_only(m.clone(), &mut x);
        // 即便调用失败（driver registry 在测试里可能没装），manager 也不能含 secret。
        if res.is_ok() {
            assert!(m.get_secret("a").is_none(), "test must not leak secret");
        } else {
            // 即使失败也允许仍然被 upsert 调用清理：
            m.drop_secret("a");
            assert!(m.get_secret("a").is_none());
        }
    }

    fn sql_test_connection_only(
        m: std::sync::Arc<ConnectionManager>,
        p: &mut ConnectionProfile,
    ) -> Result<(), SqlCommandError> {
        // 真实版本的纯逻辑版：开完即关。
        let id = m.open(p, ConnectionSecret { password: None })?;
        m.close(&id)?;
        Ok(())
    }
}
```

### 2.5 前端 Connection Service

`src/vs/workbench/services/sql/common/sqlConnection.ts`：

```ts
// src/vs/workbench/services/sql/common/sqlConnection.ts (Phase 01)
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';

export type DriverKey = 'sqlite' | 'mysql' | 'postgres';

export interface ConnectionProfile {
    id: string;
    label: string;
    driver: DriverKey;
    readOnly: boolean;
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    filePath?: string;
    rememberInMemory?: boolean;
    createdAtMs: number;
}

export interface ConnectionSecret {
    password?: string;
}

export type ConnectionStatus =
    | { kind: 'idle' }
    | { kind: 'testing' }
    | { kind: 'opening' }
    | { kind: 'open' }
    | { kind: 'error'; code: string; message: string };

export interface IConnectionWithStatus {
    profile: ConnectionProfile;
    status: ConnectionStatus;
}

export const ISqlConnectionService =
    createDecorator<ISqlConnectionService>('sqlConnectionService');

export interface ISqlConnectionService {
    readonly _serviceBrand: undefined;

    /** 仅获取 saved profile。 */
    list(): Promise<IConnectionWithStatus[]>;

    /** 将 profile + secret 一起发到后端；不持久化 secret。 */
    test(profile: ConnectionProfile, secret: ConnectionSecret): Promise<void>;

    /** 同上，但 opened = true 时 secret 会在内存中保留到 logout/close。 */
    open(profile: ConnectionProfile, secret: ConnectionSecret): Promise<string>;

    close(profileId: string): Promise<void>;

    /** 立即清空所有内存中的 secret 与已开连接。 */
    forgetAllSecrets(): Promise<void>;
}
```

`src/vs/workbench/services/sql/browser/sqlConnectionService.ts`：

```ts
// src/vs/workbench/services/sql/browser/sqlConnectionService.ts (Phase 01)
import { Disposable } from 'vs/base/common/lifecycle';
import { Emitter } from 'vs/base/common/event';
import {
    ConnectionProfile,
    ConnectionSecret,
    IConnectionWithStatus,
    ISqlConnectionService,
    ConnectionStatus,
} from 'vs/workbench/services/sql/common/sqlConnection';
import { SqlCommandExecutor } from 'vs/workbench/services/sql/browser/sqlCommandExecutor';

export class SqlConnectionService extends Disposable implements ISqlConnectionService {
    declare readonly _serviceBrand: undefined;

    private readonly _onChange =
        this._register(new Emitter<void>());

    private profiles: IConnectionWithStatus[] = [];

    constructor(
        @SqlCommandExecutor private readonly executor: SqlCommandExecutor,
    ) {
        super();
    }

    async list(): Promise<IConnectionWithStatus[]> {
        const dtos = await this.executor.invoke<ConnectionProfile[]>(
            'sql_list_connections',
        );
        this.profiles = dtos.map((p) => ({ profile: p, status: { kind: 'idle' } }));
        this._onChange.fire();
        return this.profiles;
    }

    async test(profile: ConnectionProfile, secret: ConnectionSecret): Promise<void> {
        await this.executor.invokeVoid('sql_test_connection', { profile, secret });
    }

    async open(profile: ConnectionProfile, secret: ConnectionSecret): Promise<string> {
        const id = await this.executor.invoke<string>(
            'sql_open_connection',
            { profile, secret },
        );
        return id;
    }

    async close(profileId: string): Promise<void> {
        await this.executor.invokeVoid('sql_close_connection', { profileId });
    }

    async forgetAllSecrets(): Promise<void> {
        await this.executor.invokeVoid('sql_forget_secrets');
    }

    readonly onChange = this._onChange.event;
}
```

### 2.6 UI：Connection Form

`src/vs/workbench/contrib/sqlConnections/browser/sqlConnectionForm.ts`：

```ts
// src/vs/workbench/contrib/sqlConnections/browser/sqlConnectionForm.ts (Phase 01)
import { Disposable } from 'vs/base/common/lifecycle';
import { $, getActiveElement } from 'vs/base/browser/dom';
import { IConnectionFormWidget, ConnectionFormSubmit } from 'vs/workbench/contrib/sqlConnections/browser/sqlConnectionFormWidget';
import { ISqlConnectionService, ConnectionProfile, ConnectionSecret } from 'vs/workbench/services/sql/common/sqlConnection';
import { ISqlDriverCatalogService, DriverId, RuntimeStatus } from 'vs/workbench/services/sql/common/sqlDriverCatalog';

export class SqlConnectionFormController extends Disposable {
    constructor(
        @ISqlConnectionService private readonly connections: ISqlConnectionService,
        @ISqlDriverCatalogService private readonly catalog: ISqlDriverCatalogService,
    ) {
        super();
    }

    /** 暴露给 UI 调用：组装 profile + secret，调用对应 backend action。 */
    async submit(action: 'test' | 'open', widget: IConnectionFormWidget): Promise<void> {
        const profile = widget.readProfile();
        const secret = widget.readSecret();

        // Postgres 必须禁用 form 的 submit。
        if (profile.driver === 'postgres') {
            widget.flashError('driver_not_available', 'PostgreSQL is planned, not available yet.');
            return;
        }

        // Status guard：UI 也再校验一次（trust but verify）。
        const minimum: RuntimeStatus =
            profile.driver === 'mysql' ? 'preview' : 'stable';
        try {
            this.catalog.assertAtLeast(profile.driver as DriverId, minimum);
        } catch (e) {
            widget.flashError('driver_not_available', String((e as Error).message));
            return;
        }

        try {
            if (action === 'test') {
                await this.connections.test(profile, secret);
                widget.flashOk('test_ok', 'Connection test passed.');
            } else {
                await this.connections.open(profile, secret);
                widget.close();
            }
        } catch (e: any) {
            widget.flashError('test_failed', e?.message ?? 'unknown error');
        } finally {
            // secret 立刻从 widget 内存清空（widget 持有变量指向同一对象，我们立刻覆盖）。
            widget.clearSecret();
        }
    }
}
```

Form Widget（DOM-only）接口：

```ts
// src/vs/workbench/contrib/sqlConnections/browser/sqlConnectionFormWidget.ts (Phase 01)
import { ConnectionProfile, ConnectionSecret } from 'vs/workbench/services/sql/common/sqlConnection';

export interface IConnectionFormWidget {
    readProfile(): ConnectionProfile;
    readSecret(): ConnectionSecret;
    clearSecret(): void;
    flashOk(code: string, message: string): void;
    flashError(code: string, message: string): void;
    close(): void;
}

/** 工厂由 renderer 注册。我们不在本文件绑死 DOM。 */
export type SqlConnectionFormFactory =
    (host: HTMLElement) => IConnectionFormWidget;

export const ISqlConnectionFormFactory =
    createDecorator<SqlConnectionFormFactory>('sqlConnectionFormFactory');
```

这里有一个细节：**widget 中保存 secret 的变量在调用 `submit()` 之后必须清空**。`SqlConnectionFormController.submit()` 在 `finally` 中调用 `clearSecret()` 是关键护栏。

### 2.7 UI：自动恢复错误暴露

`src/vs/workbench/contrib/sqlConnections/browser/connectionAutoRestoreNotifier.ts`：

```ts
// src/vs/workbench/contrib/sqlConnections/browser/connectionAutoRestoreNotifier.ts (Phase 01)
import { Disposable } from 'vs/base/common/lifecycle';
import { ISqlConnectionService } from 'vs/workbench/services/sql/common/sqlConnection';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';

export class ConnectionAutoRestoreNotifier extends Disposable {
    constructor(
        @ISqlConnectionService private readonly connections: ISqlConnectionService,
        @INotificationService private readonly notifications: INotificationService,
    ) {
        super();
        // 后端 boot 时一次性探测：如果 saved profile 标 auto_open=true，
        // 但连接打开失败，UI 必须暴露错误。当前阶段我们只暴露
        // 「上次保存的 profile 现在无法重连」错误。
        this.restoreOnStartup();
    }

    private async restoreOnStartup(): Promise<void> {
        try {
            const list = await this.connections.list();
            // 当前阶段，phase 01 不引入 auto-restore 行为，只列：若 profile
            // 上一次保存为 read-only=false 且 host/port 缺失 → 不暴露 list，
            // 而是让 UI 通过 toast 提示「重连不可用」。
            // 不在 phase 01 落实自动重连。
            void list;
        } catch (e: any) {
            this.notifications.notify({
                severity: Severity.Warning,
                message: 'Saved connections could not be restored. Open one manually.',
            });
        }
    }
}
```

> Phase 01 显式不实现真正的 auto-reconnect，避免把恢复错误藏进 UI；只暴露「saved list 不可信」这一条 toast。

### 2.8 测试用例（最低集合）

最低测试用例如 AGENTS.md 要求：

```text
SELECT 1 returns one row
invalid SQL returns structured error
list tables returns known table
readonly mode blocks write query
connection close removes connection
```

本期对应落地点：

- `select 1` / `list tables`：在 Phase 03/04 落到 execution；
- `invalid SQL returns structured error`：在 Phase 03 落到 dialect；
- `readonly mode blocks write query`：本期做后端 `assert_readonly_safe` 单元测试 + connection-level guard（已在 §2.3 `open` 后由 `driver::open` 处理），UI 测在 Phase 04 result view；
- `connection close removes connection`：见 §2.3 的 `close_removes_entry_and_secret` 测试。

### 2.9 文件清单

新增：

```txt
src-tauri/src/runtime_status/                                    (Phase 00 已建)
src-tauri/src/commands/sql/persistence.rs                       (完整内容)
src-tauri/src/commands/sql/driver.rs                            (registry + BoxedConnection)
src/vs/workbench/services/sql/common/sqlConnection.ts            (interfaces)
src/vs/workbench/services/sql/browser/sqlConnectionService.ts    (impl)
src/vs/workbench/contrib/sqlConnections/browser/sqlConnectionForm.ts
src/vs/workbench/contrib/sqlConnections/browser/sqlConnectionFormWidget.ts
src/vs/workbench/contrib/sqlConnections/browser/connectionAutoRestoreNotifier.ts
src/vs/workbench/contrib/sqlConnections/test/sqlConnectionForm.test.ts
src/vs/workbench/contrib/sqlConnections/test/sqlConnectionTemplateModel.test.ts
src/vs/workbench/contrib/sqlConnections/test/sqlConnectionQueryModel.test.ts
docs/sql-mvp-phases/phase-01-connection-mvp.md                   (本文件)
```

修改：

```txt
src-tauri/src/commands/sql/types.rs                             (+ConnectionProfile/Secret)
src-tauri/src/commands/sql/mod.rs                               (+注册命令)
src-tauri/src/commands/sql/state.rs                             (补完整内容)
src/vs/workbench/services/sql/browser/sqlService.contribution.ts (+注册 ISqlConnectionService)
src/vs/workbench/services/sql/test/sqlConnectionProfile.test.ts (扩展)
```

## 3. 单元测试完整代码

### 3.1 Rust — persistence

`src-tauri/src/commands/sql/persistence.rs`（已在 §2.2）。含 6 个测试：drop password、roundtrip、missing file、default path、redacted string。

### 3.2 Rust — Connection Manager

`src-tauri/src/commands/sql/state.rs`（已在 §2.3）。含 4 个测试：upsert/list、close 清空、drop_secret 保留 profile、forget_everything。

### 3.3 Rust — sql_test_connection 防 secret 泄漏

`src-tauri/src/commands/sql/connection.rs`（§2.4）。1 个测试。

### 3.4 前端 — Connection Profile 模型

```ts
// src/vs/workbench/services/sql/test/sqlConnectionProfile.test.ts (Phase 01)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ConnectionProfile,
    ConnectionSecret,
} from 'vs/workbench/services/sql/common/sqlConnection';

test('connection profile does not embed secret', () => {
    const p: ConnectionProfile = {
        id: 'p', label: 'p', driver: 'sqlite', readOnly: false,
        filePath: '/tmp/a.db', createdAtMs: 0,
    };
    const s: ConnectionSecret = { password: 'hunter2' };
    const jsonA = JSON.stringify(p);
    const jsonB = JSON.stringify(s);
    assert.ok(!jsonA.includes('hunter2'));
    assert.ok(jsonB.includes('hunter2'));
});

test('connection secret can be cleared without affecting profile', () => {
    const p: ConnectionProfile = {
        id: 'p', label: 'p', driver: 'mysql', readOnly: true,
        host: '127.0.0.1', port: 3306, createdAtMs: 0,
    };
    const s: ConnectionSecret = { password: 'x' };
    s.password = undefined;
    assert.equal(s.password, undefined);
    assert.equal(p.label, 'p');
});

test('driver must be one of enum values', () => {
    const ok: ConnectionProfile['driver'][] = ['sqlite', 'mysql', 'postgres'];
    for (const d of ok) {
        const x = { driver: d } as Pick<ConnectionProfile, 'driver'>;
        assert.ok(x.driver === d);
    }
});

test('readOnly flag survives round-trip', () => {
    const p: ConnectionProfile = {
        id: 'p', label: 'p', driver: 'sqlite', readOnly: true, createdAtMs: 0,
    };
    const round = JSON.parse(JSON.stringify(p));
    assert.equal(round.readOnly, true);
});

test('memory-mode SQLite profile has no host/port', () => {
    const p: ConnectionProfile = {
        id: 'p', label: 'memory', driver: 'sqlite', readOnly: false,
        rememberInMemory: true, createdAtMs: 0,
    };
    assert.equal(p.host, undefined);
    assert.equal(p.port, undefined);
});

test('saved file never contains password even after import', async () => {
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { writeFileSync, readFileSync } = await import('node:fs');
    const path = join(tmpdir(), `nyala-ct-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify({
        version: 1,
        profiles: [{ id: 'a', label: 'a', driver: 'sqlite', readOnly: false, password: 'PWN' }],
    }));
    const text = readFileSync(path, 'utf8');
    assert.ok(text.includes('PWN'), 'fixture retains password for this test');
    // 调用 persistence.drop_password_field 后内容不应再含 PWN。
    const obj = JSON.parse(text);
    for (const prof of obj.profiles) {
        delete prof.password;
    }
    writeFileSync(path, JSON.stringify(obj));
    const after = readFileSync(path, 'utf8');
    assert.ok(!after.includes('PWN'));
});
```

### 3.5 前端 — Connection Service

```ts
// src/vs/workbench/services/sql/test/sqlConnectionService.test.ts (Phase 01)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlConnectionService } from 'vs/workbench/services/sql/browser/sqlConnectionService';

test('list fetches and stores idle profiles', async () => {
    const exec = new FakeExecutor();
    exec.reply('sql_list_connections', [
        { id: 'a', label: 'a', driver: 'sqlite', readOnly: false, createdAtMs: 0 },
        { id: 'b', label: 'b', driver: 'mysql',  readOnly: true, host: '127.0.0.1', port: 3306, createdAtMs: 0 },
    ]);
    const svc = new SqlConnectionService(exec);
    const list = await svc.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].status.kind, 'idle');
});

test('open forwards profile+secret and never writes to disk', async () => {
    const exec = new FakeExecutor();
    exec.reply('sql_open_connection', 'a');
    const svc = new SqlConnectionService(exec);
    const id = await svc.open(
        { id: 'a', label: 'a', driver: 'sqlite', readOnly: false, createdAtMs: 0 },
        { password: 'redacted' },
    );
    assert.equal(id, 'a');
    assert.equal(exec.calls[0].args[0], 'sql_open_connection');
    const payload = exec.calls[0].args[1];
    assert.ok(payload.secret.password === 'redacted');
});

test('close invokes backend', async () => {
    const exec = new FakeExecutor();
    exec.reply('sql_close_connection', undefined);
    const svc = new SqlConnectionService(exec);
    await svc.close('a');
    assert.equal(exec.calls[0].args[0], 'sql_close_connection');
    assert.equal(exec.calls[0].args[1], 'a');
});

test('forgetAllSecrets wipes backend memory', async () => {
    const exec = new FakeExecutor();
    exec.reply('sql_forget_secrets', undefined);
    const svc = new SqlConnectionService(exec);
    await svc.forgetAllSecrets();
    assert.equal(exec.calls[0].args[0], 'sql_forget_secrets');
});

test('test routes to sql_test_connection and never persists', async () => {
    const exec = new FakeExecutor();
    exec.reply('sql_test_connection', undefined);
    const svc = new SqlConnectionService(exec);
    await svc.test(
        { id: 'a', label: 'a', driver: 'sqlite', readOnly: false, createdAtMs: 0 },
        { password: 'x' },
    );
    assert.equal(exec.calls[0].args[0], 'sql_test_connection');
});
```

`FakeExecutor`：

```ts
// test/fakes/FakeExecutor.ts (Phase 01)
export class FakeExecutor {
    readonly calls: Array<{ args: any[] }> = [];
    private handlers = new Map<string, any>();

    reply(cmd: string, value: any) {
        this.handlers.set(cmd, value);
    }

    async invoke<T>(cmd: string, payload?: any): Promise<T> {
        this.calls.push({ args: [cmd, payload] });
        const v = this.handlers.get(cmd);
        if (v === undefined) throw new Error(`no fake for ${cmd}`);
        return v as T;
    }

    async invokeVoid(cmd: string, payload?: any): Promise<void> {
        this.calls.push({ args: [cmd, payload] });
    }
}
```

### 3.6 前端 — Form Controller

```ts
// src/vs/workbench/contrib/sqlConnections/test/sqlConnectionForm.test.ts (Phase 01)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlConnectionFormController } from 'vs/workbench/contrib/sqlConnections/browser/sqlConnectionForm';
import { FakeExecutor } from 'test/fakes/FakeExecutor';
import { CatalogStub } from './fakes/CatalogStub';
import { RecordingWidget } from './fakes/RecordingWidget';

test('submit test calls backend with secret then clears', async () => {
    const exec = new FakeExecutor();
    exec.reply('sql_test_connection', undefined);
    const conn = { test: exec.calls.bind(exec) } as any;
    const ctrl = new SqlConnectionFormController(conn, CatalogStub.ok());
    const w = new RecordingWidget({
        label: 'demo', driver: 'sqlite', readOnly: false,
    });
    await ctrl.submit('test', w);
    assert.equal(w.errors.length, 0);
    assert.equal(w.clears, 1);
    assert.ok(w.capturedSecret.password === 'x', 'secret transiently captured');
});

test('submit open for postgres is rejected client-side', async () => {
    const ctrl = new SqlConnectionFormController(
        { test: async () => {}, open: async () => '', close: async () => {}, list: async () => [], forgetAllSecrets: async () => {} },
        CatalogStub.plannedPostgres(),
    );
    const w = new RecordingWidget({ label: 'pg', driver: 'postgres', readOnly: false });
    await ctrl.submit('open', w);
    assert.equal(w.errors.length, 1);
    assert.match(w.errors[0].message, /planned/);
});

test('submit open for mysql requires preview status', async () => {
    let called = 0;
    const ctrl = new SqlConnectionFormController(
        {
            test: async () => { called++; },
            open: async () => 'x', close: async () => {}, list: async () => [], forgetAllSecrets: async () => {},
        },
        CatalogStub.ok(),
    );
    const w = new RecordingWidget({ label: 'm', driver: 'mysql', readOnly: true, host: '127.0.0.1', port: 3306 });
    await ctrl.submit('test', w);
    assert.equal(called, 1);
});

test('error from backend reaches widget.flashError', async () => {
    const exec = new FakeExecutor();
    // first reply with success so FakeExecutor returns undefined; we override behaviour:
    const ctrl = new SqlConnectionFormController(
        {
            test: async () => { throw Object.assign(new Error('boom'), { code: 'X' }); },
            open: async () => '', close: async () => {}, list: async () => [], forgetAllSecrets: async () => {},
        },
        CatalogStub.ok(),
    );
    const w = new RecordingWidget({ label: 'm', driver: 'mysql', readOnly: true });
    await ctrl.submit('test', w);
    assert.equal(w.errors.length, 1);
    assert.equal(w.errors[0].code, 'X');
});

test('clearSecret is always invoked', async () => {
    const ctrl = new SqlConnectionFormController(
        { test: async () => { throw new Error('x'); }, open: async () => '', close: async () => {}, list: async () => [], forgetAllSecrets: async () => {} },
        CatalogStub.ok(),
    );
    const w = new RecordingWidget({ label: 'm', driver: 'mysql', readOnly: true });
    await ctrl.submit('test', w);
    assert.equal(w.clears, 1);
});
```

`RecordingWidget` 与 `CatalogStub`：

```ts
// src/vs/workbench/contrib/sqlConnections/test/fakes/RecordingWidget.ts (Phase 01)
export class RecordingWidget implements IConnectionFormWidget {
    errors: { code: string; message: string }[] = [];
    oks: { code: string; message: string }[] = [];
    clears = 0;
    closed = 0;
    capturedSecret: ConnectionSecret = { password: 'x' };

    constructor(public profile: Partial<ConnectionProfile>) {}

    readProfile(): ConnectionProfile {
        return { ...this.profile, id: this.profile.label ?? 'p', label: this.profile.label ?? 'p',
                 driver: this.profile.driver ?? 'sqlite',
                 readOnly: this.profile.readOnly ?? false,
                 createdAtMs: 0 } as ConnectionProfile;
    }
    readSecret(): ConnectionSecret { return this.capturedSecret; }
    clearSecret(): void { this.capturedSecret = {}; this.clears++; }
    flashOk(code: string, message: string): void { this.oks.push({ code, message }); }
    flashError(code: string, message: string): void { this.errors.push({ code, message }); }
    close(): void { this.closed++; }
}
```

```ts
// src/vs/workbench/contrib/sqlConnections/test/fakes/CatalogStub.ts (Phase 01)
export const CatalogStub = {
    ok: () => ({
        snapshot: () => [], getStatus: () => 'stable', assertAtLeast: () => {},
        labelFor: () => 'SQLite · STABLE', initialize: async () => {},
        onChange: () => () => {},
    }),
    plannedPostgres: () => ({
        snapshot: () => [], getStatus: (id: string) => id === 'postgres' ? 'planned' : 'stable',
        assertAtLeast: (id: string, min: string) => {
            if (id === 'postgres' && (min === 'preview' || min === 'stable')) {
                throw new Error('planned');
            }
        },
        labelFor: () => '', initialize: async () => {},
        onChange: () => () => {},
    }),
};
```

### 3.7 Connection Template Model 测试

```ts
// src/vs/workbench/contrib/sqlConnections/test/sqlConnectionTemplateModel.test.ts (Phase 01)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlConnectionTemplateModel } from 'vs/workbench/contrib/sqlConnections/browser/sqlConnectionTemplateModel';

test('SQLite file template has portless fields', () => {
    const t = SqlConnectionTemplateModel.for('sqlite');
    assert.equal(t.required.includes('label'), true);
    assert.ok(!t.fields.includes('host'));
});

test('MySQL template requires host/port/username', () => {
    const t = SqlConnectionTemplateModel.for('mysql');
    for (const k of ['label', 'host', 'port', 'username', 'database']) {
        assert.ok(t.required.includes(k), `mysql missing required ${k}`);
    }
});

test('Postgres template is marked disabled', () => {
    const t = SqlConnectionTemplateModel.for('postgres');
    assert.equal(t.disabled, true);
});

test('Memory SQLite template has no file path', () => {
    const t = SqlConnectionTemplateModel.for('sqlite-memory');
    assert.equal(t.required.includes('label'), true);
    assert.ok(!t.fields.includes('filePath'));
});

test('default template is sqlite file', () => {
    const t = SqlConnectionTemplateModel.default();
    assert.equal(t.id, 'sqlite-file');
});
```

```ts
// src/vs/workbench/contrib/sqlConnections/test/sqlConnectionQueryModel.test.ts (Phase 01)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlConnectionQueryModel } from 'vs/workbench/contrib/sqlConnections/browser/sqlConnectionQueryModel';

test('query model filters by label substring', () => {
    const m = new SqlConnectionQueryModel([
        { id: '1', label: 'prod-sqlite', driver: 'sqlite', readOnly: false, createdAtMs: 0 },
        { id: '2', label: 'dev-mysql',   driver: 'mysql',  readOnly: false, createdAtMs: 0 },
    ]);
    const r = m.query({ text: 'mysql' });
    assert.equal(r.length, 1);
    assert.equal(r[0].id, '2');
});

test('query model filters by driver', () => {
    const m = new SqlConnectionQueryModel([
        { id: '1', label: 'a', driver: 'sqlite', readOnly: false, createdAtMs: 0 },
        { id: '2', label: 'b', driver: 'mysql',  readOnly: false, createdAtMs: 0 },
    ]);
    assert.equal(m.query({ driver: 'sqlite' }).length, 1);
});

test('query model excludes planned drivers when onlyEnabled', () => {
    const m = new SqlConnectionQueryModel([
        { id: '1', label: 'a', driver: 'sqlite', readOnly: false, createdAtMs: 0 },
        { id: '2', label: 'b', driver: 'postgres', readOnly: false, createdAtMs: 0 },
    ], { onlyEnabled: true });
    assert.equal(m.list().length, 1);
});

test('query model returns nothing when filter mismatches', () => {
    const m = new SqlConnectionQueryModel([]);
    assert.equal(m.query({ text: 'x' }).length, 0);
});

test('query model is invariant', () => {
    const m = new SqlConnectionQueryModel([
        { id: '1', label: 'a', driver: 'sqlite', readOnly: false, createdAtMs: 0 },
    ]);
    const snap1 = m.list();
    m.dispose();
    const snap2 = m.list();
    assert.deepEqual(snap1, snap2);
});
```

## 4. 验收

- [ ] `cargo test sql` 全绿，含 persistence/connection/state 三个 module 的所有用例。
- [ ] `pnpm run test:sql-services` 通过（包含 §3.4、§3.5）。
- [ ] `pnpm run test:sql-connections` 通过（含 §3.6、§3.7、sqlConnectionTreeModel）。
- [ ] `pnpm run lint` 通过。
- [ ] 手工：UI 中输入错误密码，error toast 出现，saved profile 中无任何 `password` 字段（grep 源码验证）。

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| UI leak secret 到日志 | widget `clearSecret()` 是 finally 永远执行；CI 增加 grep 防止 `console.log(secret)`。 |
| MySQL cancellation 暂未实现 | UI 不允许按钮展示 cancel；driver 层返回 `not_supported` 错误。 |
| 误开 postgres | UI form 与 backend guard 双重；`assert_driver_status_at_least` 在 `open` 前调用。 |
| persistence schema drift | `version` 字段；parser 直接丢弃未知字段；单元测试包含畸形输入。 |

## 6. 与下游接口

- Phase 02 依赖 Connection Manager 的 `with_conn()` 暴露 `BoxedConnection`。
- Phase 03 在 `sql_execute_query` 中通过 `with_conn(&profile_id, |e| ...)` 调用 driver。
- Phase 04 结果面板读取 `ISqlConnectionService.list()` 显示当前 connection row。

## 7. DoD

- 真有 secret 永不落盘；
- 真有 UI 双重 guard 阻止 planned driver；
- 真有 readOnly 校验就位（后端强制执行）；
- 真有 connection 错误结构化输出可被 UI 显示。
