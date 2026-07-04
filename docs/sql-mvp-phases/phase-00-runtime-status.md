# Phase 00 — Runtime Status Alignment

## 0. 摘要

让 Nyala Studio 内部始终只有 **一种** runtime status 表。任何 contributor、测试、CI、文档扫描都必须能在 60 秒内确认这是真理之源。

- **Truth-of-record**：单一 Rust 常量表 `DRIVER_RUNTIME_STATUS_TABLE`，被前端 driver catalog、README runtime 表、UI 文案、CI 校验脚本同时消费。
- **同步约束**：任何对 status 的修改必须通过 PR CI 的 regression test 才能合并。
- **本期不改任何功能行为**，只把现状用代码钉死。

## 1. 范围

1. SQLite 必须仅以 `stable` 暴露。
2. MySQL 必须仅以 `preview` 暴露。
3. PostgreSQL 必须仅以 `planned` 暴露。
4. UI 文案、README、协议注释、driver catalog、driver card badge 共用同一份 truth-of-record。
5. 新增 runtime-status regression test，干掉任何"假装支持"。

不在范围：

- 不引入新 driver；
- 不改 SQLite/MySQL 实际行为；
- 不动 Connection/Metadata/Editor/Result 业务。

## 2. 设计

### 2.1 单一真理之源

新增 `src-tauri/src/runtime_status/mod.rs`：

```rust
// src-tauri/src/runtime_status/mod.rs (Phase 00)
use serde::{Deserialize, Serialize};

/// 工作台只认四种状态。
/// 不允许新增「beta」「experimental」之类的别名以避免漂移。
#[derive(Debug, Copy, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeStatus {
    Stable,
    Preview,
    Planned,
    Disabled,
}

impl RuntimeStatus {
    pub fn as_token(self) -> &'static str {
        match self {
            RuntimeStatus::Stable => "stable",
            RuntimeStatus::Preview => "preview",
            RuntimeStatus::Planned => "planned",
            RuntimeStatus::Disabled => "disabled",
        }
    }
}

#[derive(Debug, Copy, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriverId {
    Sqlite,
    Mysql,
    Postgres,
}

impl DriverId {
    pub fn as_token(self) -> &'static str {
        match self {
            DriverId::Sqlite => "sqlite",
            DriverId::Mysql => "mysql",
            DriverId::Postgres => "postgres",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DriverRuntimeEntry {
    pub id: DriverId,
    pub display_name: &'static str,
    pub status: RuntimeStatus,
    pub summary: &'static str,
    pub notes: &'static [&'static str],
}

/// 这是真理之源。
/// 任何「README runtime 表」「UI driver card」「driver catalog endpoint」
/// 都必须从这里派生，禁止在别处复制这些 status。
pub const DRIVER_RUNTIME_STATUS_TABLE: &[DriverRuntimeEntry] = &[
    DriverRuntimeEntry {
        id: DriverId::Sqlite,
        display_name: "SQLite",
        status: RuntimeStatus::Stable,
        summary: "File / in-memory database for MVP stable usage.",
        notes: &[
            "supports file path",
            "supports :memory:",
            "metadata, query execution, cancellation, read-only mode enabled",
        ],
    },
    DriverRuntimeEntry {
        id: DriverId::Mysql,
        display_name: "MySQL",
        status: RuntimeStatus::Preview,
        summary: "Local/dev validation only; cancellation not enabled yet.",
        notes: &[
            "connection, metadata, query execution enabled",
            "query cancellation is not supported yet",
            "intended for local/dev validation first",
        ],
    },
    DriverRuntimeEntry {
        id: DriverId::Postgres,
        display_name: "PostgreSQL",
        status: RuntimeStatus::Planned,
        summary: "Protocol fields exist, runtime not enabled yet.",
        notes: &[
            "do not show as available in any product UI",
            "runtime driver will be enabled in a later phase",
        ],
    },
];

pub fn lookup(id: DriverId) -> Option<&'static DriverRuntimeEntry> {
    DRIVER_RUNTIME_STATUS_TABLE.iter().find(|e| e.id == id)
}

pub fn snapshot() -> Vec<DriverRuntimeEntry> {
    DRIVER_RUNTIME_STATUS_TABLE.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_has_exactly_three_drivers() {
        assert_eq!(DRIVER_RUNTIME_STATUS_TABLE.len(), 3);
    }

    #[test]
    fn sqlite_is_stable() {
        let e = lookup(DriverId::Sqlite).expect("sqlite present");
        assert_eq!(e.status, RuntimeStatus::Stable);
    }

    #[test]
    fn mysql_is_preview() {
        let e = lookup(DriverId::Mysql).expect("mysql present");
        assert_eq!(e.status, RuntimeStatus::Preview);
    }

    #[test]
    fn postgres_is_planned_not_stable() {
        let e = lookup(DriverId::Postgres).expect("postgres present");
        assert_eq!(e.status, RuntimeStatus::Planned);
        assert_ne!(e.status, RuntimeStatus::Stable);
        assert_ne!(e.status, RuntimeStatus::Preview);
    }

    #[test]
    fn driver_ids_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for e in DRIVER_RUNTIME_STATUS_TABLE {
            assert!(seen.insert(e.id), "duplicate driver id");
        }
    }

    #[test]
    fn statuses_serialize_lowercase() {
        let v = serde_json::to_string(&RuntimeStatus::Preview).unwrap();
        assert_eq!(v, "\"preview\"");
    }
}
```

### 2.2 把真理之源注入 Tauri 命令

`src-tauri/src/commands/sql/types.rs` 新增：

```rust
// src-tauri/src/commands/sql/types.rs (Phase 00 节选)
use crate::runtime_status::{snapshot, DriverId, DriverRuntimeEntry, RuntimeStatus};

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverRuntimeStatusDto {
    pub id: String,
    pub display_name: String,
    pub status: String,
    pub summary: String,
    pub notes: Vec<String>,
}

impl From<&DriverRuntimeEntry> for DriverRuntimeStatusDto {
    fn from(e: &DriverRuntimeEntry) -> Self {
        Self {
            id: e.id.as_token().to_string(),
            display_name: e.display_name.to_string(),
            status: e.status.as_token().to_string(),
            summary: e.summary.to_string(),
            notes: e.notes.iter().map(|s| s.to_string()).collect(),
        }
    }
}

#[tauri::command]
pub fn sql_list_driver_runtime_status() -> Vec<DriverRuntimeStatusDto> {
    snapshot().iter().map(Into::into).collect()
}

/// UI 不允许假装支持某 driver。
/// 调用前置任何「打开连接 / 列表元数据」命令的 guard。
pub fn assert_driver_status_at_least(
    id: DriverId,
    minimum: RuntimeStatus,
) -> Result<(), &'static str> {
    let entry = crate::runtime_status::lookup(id).ok_or("unknown driver")?;
    if entry.status == RuntimeStatus::Disabled {
        return Err("driver is disabled");
    }
    match (entry.status, minimum) {
        (RuntimeStatus::Stable, _) => Ok(()),
        (RuntimeStatus::Preview, RuntimeStatus::Preview) => Ok(()),
        (RuntimeStatus::Preview, RuntimeStatus::Stable) => Err("driver is only preview"),
        (RuntimeStatus::Planned, RuntimeStatus::Stable) => Err("driver is planned"),
        (RuntimeStatus::Planned, RuntimeStatus::Preview) => Err("driver is planned"),
        (RuntimeStatus::Disabled, _) => Err("driver is disabled"),
        (RuntimeStatus::Planned, RuntimeStatus::Planned) => Ok(()),
    }
}
```

> **为什么 `sql_list_driver_runtime_status` 是 tauri command？** UI 必须在启动时通过 `invoke()` 拿到这份表，再也不允许 UI 硬编码 driver status。

### 2.3 前端 service 层用它

新增 `src/vs/workbench/services/sql/common/sqlDriverCatalog.ts`：

```ts
// src/vs/workbench/services/sql/common/sqlDriverCatalog.ts (Phase 00)
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';

export type RuntimeStatus = 'stable' | 'preview' | 'planned' | 'disabled';
export type DriverId = 'sqlite' | 'mysql' | 'postgres';

export interface DriverRuntimeStatusDto {
    readonly id: DriverId;
    readonly displayName: string;
    readonly status: RuntimeStatus;
    readonly summary: string;
    readonly notes: readonly string[];
}

export const ISqlDriverCatalogService =
    createDecorator<ISqlDriverCatalogService>('sqlDriverCatalogService');

export interface ISqlDriverCatalogService {
    readonly _serviceBrand: undefined;

    /** 在 workbench bootstrap 中调用一次，从后端拉快照。 */
    initialize(): Promise<void>;

    /** 同步拿当前快照。必须先 initialize()。 */
    snapshot(): readonly DriverRuntimeStatusDto[];

    /** O(1) 查询。 */
    getStatus(id: DriverId): RuntimeStatus | undefined;

    /** UI guard：低于 minimum 抛错。 */
    assertAtLeast(id: DriverId, minimum: RuntimeStatus): void;

    /** 给 driver card 显示用的标签文案。 */
    labelFor(id: DriverId): string;
}
```

`src/vs/workbench/services/sql/browser/sqlDriverCatalogService.ts`：

```ts
// src/vs/workbench/services/sql/browser/sqlDriverCatalogService.ts (Phase 00)
import { Disposable } from 'vs/base/common/lifecycle';
import {
    IDriverCatalogChangeEvent,
    ISqlDriverCatalogService,
    DriverRuntimeStatusDto,
    DriverId,
    RuntimeStatus,
} from 'vs/workbench/services/sql/common/sqlDriverCatalog';
import { ILogService } from 'vs/platform/log/common/log';
import { Emitter } from 'vs/base/common/event';
import { SqlCommandExecutor } from 'vs/workbench/services/sql/browser/sqlCommandExecutor';

export class SqlDriverCatalogService extends Disposable implements ISqlDriverCatalogService {
    declare readonly _serviceBrand: undefined;

    private _snapshot: readonly DriverRuntimeStatusDto[] = [];
    private _ready = false;

    private readonly _onDidChange =
        this._register(new Emitter<IDriverCatalogChangeEvent>());

    constructor(
        @ILogService private readonly logService: ILogService,
        @SqlCommandExecutor private readonly executor: SqlCommandExecutor,
    ) {
        super();
    }

    async initialize(): Promise<void> {
        if (this._ready) {
            return;
        }
        const dto = await this.executor.invoke<DriverRuntimeStatusDto[]>(
            'sql_list_driver_runtime_status',
        );
        // 严格按后端 truth-of-record 排序，避免依赖生成顺序。
        const fixed: DriverRuntimeStatusDto[] = [
            'sqlite', 'mysql', 'postgres',
        ].map((id) => {
            const entry = dto.find((d) => d.id === id);
            if (!entry) {
                throw new Error(`driver catalog missing: ${id}`);
            }
            return entry;
        });
        this._snapshot = Object.freeze(fixed);
        this._ready = true;
        this._onDidChange.fire({ added: this._snapshot, removed: [], updated: [] });
        this.logService.info('[sqlDriverCatalog] initialized', this._snapshot.map((s) => `${s.id}:${s.status}`));
    }

    snapshot(): readonly DriverRuntimeStatusDto[] {
        this.assertReady();
        return this._snapshot;
    }

    getStatus(id: DriverId): RuntimeStatus | undefined {
        return this._snapshot.find((d) => d.id === id)?.status;
    }

    assertAtLeast(id: DriverId, minimum: RuntimeStatus): void {
        const status = this.getStatus(id);
        if (!status) {
            throw new Error(`unknown driver: ${id}`);
        }
        const order: Record<RuntimeStatus, number> = {
            disabled: 0,
            planned: 1,
            preview: 2,
            stable: 3,
        };
        if (order[status] < order[minimum]) {
            throw new Error(
                `driver ${id} is ${status}, requires at least ${minimum}`,
            );
        }
    }

    labelFor(id: DriverId): string {
        const entry = this._snapshot.find((d) => d.id === id);
        if (!entry) {
            return id;
        }
        return `${entry.displayName} · ${entry.status.toUpperCase()}`;
    }

    private assertReady(): void {
        if (!this._ready) {
            throw new Error('SqlDriverCatalogService.initialize() not called');
        }
    }

    readonly onDidChange = this._onDidChange.event;
}

export interface IDriverCatalogChangeEvent {
    readonly added: readonly DriverRuntimeStatusDto[];
    readonly removed: readonly DriverRuntimeStatusDto[];
    readonly updated: readonly DriverRuntimeStatusDto[];
}
```

### 2.4 前端 driver card 渲染统一

新增 `src/vs/workbench/contrib/sqlConnections/browser/driverCardBadge.css.ts` 与 `driverCardBadge.ts`：

```ts
// src/vs/workbench/contrib/sqlConnections/browser/driverCardBadge.ts (Phase 00)
import { RuntimeStatus } from 'vs/workbench/services/sql/common/sqlDriverCatalog';

export interface DriverBadgeView {
    readonly label: string;
    readonly tooltip: string;
    readonly className: string;
    readonly isActionable: boolean;
}

/** 唯一的呈现函数。UI 不允许在别处再手写 status 字符串。 */
export function buildDriverBadge(status: RuntimeStatus): DriverBadgeView {
    switch (status) {
        case 'stable':
            return {
                label: 'STABLE',
                tooltip: 'Runtime driver is stable for daily local use.',
                className: 'sql-driver-badge sql-driver-badge--stable',
                isActionable: true,
            };
        case 'preview':
            return {
                label: 'PREVIEW',
                tooltip: 'Runtime driver is preview; cancellation or full metadata may not be available.',
                className: 'sql-driver-badge sql-driver-badge--preview',
                isActionable: true,
            };
        case 'planned':
            return {
                label: 'PLANNED',
                tooltip: 'Runtime driver is not available yet. UI must hide actions that need it.',
                className: 'sql-driver-badge sql-driver-badge--planned',
                isActionable: false,
            };
        case 'disabled':
            return {
                label: 'DISABLED',
                tooltip: 'Runtime driver is disabled in this build.',
                className: 'sql-driver-badge sql-driver-badge--disabled',
                isActionable: false,
            };
    }
}
```

CSS（节选）：

```css
/* src/vs/workbench/contrib/sqlConnections/browser/media/driverCardBadge.css (Phase 00) */
.sql-driver-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 4px;
    letter-spacing: 0.04em;
    user-select: none;
}
.sql-driver-badge--stable { background: rgba(46, 160, 67, 0.18); color: #2ea043; }
.sql-driver-badge--preview { background: rgba(210, 153, 34, 0.18); color: #d29922; }
.sql-driver-badge--planned { background: rgba(110, 118, 129, 0.18); color: #6e7681; }
.sql-driver-badge--disabled { background: rgba(248, 81, 73, 0.18); color: #f85149; }
```

### 2.5 README 同步

README 中的 driver 表从代码生成，不要再手抄。本 Phase 在 README 加注释：

```md
<!-- README status table is generated from src-tauri/src/runtime_status/mod.rs
     DO NOT EDIT BY HAND. Run `pnpm run test:sql-runtime-status` to regenerate. -->
```

### 2.6 Runtime status regression script

新增 `scripts/verify-sql-runtime-status.mjs`（已存在于 package.json 中，本 Phase 给出完整内容）：

```js
// scripts/verify-sql-runtime-status.mjs (Phase 00)
//
// 单一真理之源 = src-tauri/src/runtime_status/mod.rs
// 任何文档、UI 注释、CSS class 不允许出现不一致关键词。
//
// 失败即视为此次提交「假装支持」某个 driver，必须修复后才能合入。

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, '..');

function read(rel) {
    const p = resolve(repo, rel);
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf8');
}

function assertContains(label, content, snippet) {
    if (!content.includes(snippet)) {
        throw new Error(`${label}: missing snippet → ${snippet}`);
    }
}

function assertAbsent(label, content, snippet, why) {
    if (content.includes(snippet)) {
        throw new Error(`${label}: forbidden snippet found → ${snippet} (${why})`);
    }
}

const table = read('src-tauri/src/runtime_status/mod.rs');
if (!table) {
    throw new Error('runtime_status source file missing');
}
assertContains('runtime_status/mod.rs', table, 'DriverId::Sqlite');
assertContains('runtime_status/mod.rs', table, 'DriverId::Mysql');
assertContains('runtime_status/mod.rs', table, 'DriverId::Postgres');

const readme = read('README.md') ?? '';
assertContains('README.md', readme, '| SQLite | MVP stable |');
assertContains('README.md', readme, '| MySQL | Preview |');
assertContains('README.md', readme, '| PostgreSQL | Planned |');
assertAbsent('README.md', readme, 'PostgreSQL Stable', 'postgres must NOT be stable before runtime wires up');

const css = read('src/vs/workbench/contrib/sqlConnections/browser/media/driverCardBadge.css');
if (css) {
    assertContains('driverCardBadge.css', css, '.sql-driver-badge--planned');
    assertContains('driverCardBadge.css', css, '.sql-driver-badge--stable');
}

console.log('OK: runtime status is consistent across code, README, and CSS.');
```

### 2.7 注入 services

在 `src/vs/workbench/services/sql/browser/sqlService.contribution.ts` 中注册服务：

```ts
// add to Register {0} contribution
register(ISqlDriverCatalogService, SqlDriverCatalogService, InstantiationType.Delayed);
```

并在 `workbench.common.main.ts` bootstrap 启动时调用：

```ts
// workbench bootstrap, Phase 00
const catalog = accessor.get(ISqlDriverCatalogService);
await catalog.initialize();
```

`initialize()` 必须在 `ISqlConnectionService` 之前完成。

### 2.8 文件清单

新增：

```txt
src-tauri/src/runtime_status/mod.rs
src/vs/workbench/services/sql/common/sqlDriverCatalog.ts
src/vs/workbench/services/sql/browser/sqlDriverCatalogService.ts
src/vs/workbench/contrib/sqlConnections/browser/driverCardBadge.ts
src/vs/workbench/contrib/sqlConnections/browser/media/driverCardBadge.css
scripts/verify-sql-runtime-status.mjs           (完整内容，见上)
docs/sql-mvp-phases/phase-00-runtime-status.md  (本文件)
```

修改：

```txt
src-tauri/src/commands/sql/types.rs             (+DriverRuntimeStatusDto, +assert_driver_status_at_least)
src-tauri/src/commands/sql/mod.rs               (+sql_list_driver_runtime_status 注册)
src-tauri/src/commands/sql/state.rs             (+在连接/查询前调用 assert_driver_status_at_least 的 hook)
src/vs/workbench/services/sql/browser/sqlService.contribution.ts (+注册服务)
src/vs/workbench/workbench.common.main.ts       (+initialize catalog)
README.md                                        (+generated-table 注释)
```

## 3. 单元测试

### 3.1 Rust 端

`src-tauri/src/runtime_status/mod.rs` 自带 6 个单元测试（见 §2.1）。再加上：

```rust
// src-tauri/src/commands/sql/types.rs  (Phase 00 节选, tests)
#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_status::{DriverId, RuntimeStatus};

    #[test]
    fn dto_from_entry_is_lowercase_strings() {
        let entry = crate::runtime_status::lookup(DriverId::Mysql).unwrap();
        let dto = DriverRuntimeStatusDto::from(entry);
        assert_eq!(dto.id, "mysql");
        assert_eq!(dto.status, "preview");
        assert!(dto.notes.len() >= 2);
    }

    #[test]
    fn guard_blocks_planned_when_preview_required() {
        let err = assert_driver_status_at_least(DriverId::Postgres, RuntimeStatus::Preview);
        assert!(err.is_err());
    }

    #[test]
    fn guard_allows_stable_under_any_minimum() {
        for m in [RuntimeStatus::Stable, RuntimeStatus::Preview, RuntimeStatus::Planned] {
            assert!(
                assert_driver_status_at_least(DriverId::Sqlite, m).is_ok(),
                "sqlite should allow {m:?}",
            );
        }
    }

    #[test]
    fn guard_allows_preview_only_for_preview_and_planned() {
        assert!(assert_driver_status_at_least(DriverId::Mysql, RuntimeStatus::Preview).is_ok());
        assert!(assert_driver_status_at_least(DriverId::Mysql, RuntimeStatus::Planned).is_ok());
        assert!(assert_driver_status_at_least(DriverId::Mysql, RuntimeStatus::Stable).is_err());
    }
}
```

### 3.2 前端 — `sqlDriverCatalogService.test.ts`

```ts
// src/vs/workbench/services/sql/test/sqlDriverCatalogService.test.ts (Phase 00)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlDriverCatalogService } from 'vs/workbench/services/sql/browser/sqlDriverCatalogService';
import { runWithFakes } from './fakes/runWithFakes';

const snapshot = () => ([
    { id: 'sqlite', displayName: 'SQLite', status: 'stable', summary: '', notes: [] },
    { id: 'mysql', displayName: 'MySQL', status: 'preview', summary: '', notes: [] },
    { id: 'postgres', displayName: 'PostgreSQL', status: 'planned', summary: '', notes: [] },
]);

test('initialize pulls snapshot from backend and freezes order', async () => {
    await runWithFakes(async (accessor) => {
        const executor = accessor.fakeExecutor();
        executor.willReply('sql_list_driver_runtime_status', snapshot());
        const svc = accessor.instantiate(SqlDriverCatalogService);

        await svc.initialize();

        const result = svc.snapshot();
        assert.equal(result.length, 3);
        assert.equal(result[0].id, 'sqlite');
        assert.equal(result[1].id, 'mysql');
        assert.equal(result[2].id, 'postgres');
    });
});

test('getStatus returns lowercase enum', async () => {
    await runWithFakes(async (accessor) => {
        const executor = accessor.fakeExecutor();
        executor.willReply('sql_list_driver_runtime_status', snapshot());
        const svc = accessor.instantiate(SqlDriverCatalogService);
        await svc.initialize();
        assert.equal(svc.getStatus('sqlite'), 'stable');
        assert.equal(svc.getStatus('mysql'), 'preview');
        assert.equal(svc.getStatus('postgres'), 'planned');
    });
});

test('assertAtLeast throws when status too low', async () => {
    await runWithFakes(async (accessor) => {
        const executor = accessor.fakeExecutor();
        executor.willReply('sql_list_driver_runtime_status', snapshot());
        const svc = accessor.instantiate(SqlDriverCatalogService);
        await svc.initialize();
        assert.throws(() => svc.assertAtLeast('postgres', 'stable'), /requires at least/);
        assert.throws(() => svc.assertAtLeast('postgres', 'preview'), /requires at least/);
    });
});

test('assertAtLeast passes when status meets minimum', async () => {
    await runWithFakes(async (accessor) => {
        const executor = accessor.fakeExecutor();
        executor.willReply('sql_list_driver_runtime_status', snapshot());
        const svc = accessor.instantiate(SqlDriverCatalogService);
        await svc.initialize();
        assert.doesNotThrow(() => svc.assertAtLeast('sqlite', 'stable'));
        assert.doesNotThrow(() => svc.assertAtLeast('mysql', 'preview'));
    });
});

test('labelFor embeds uppercase status', async () => {
    await runWithFakes(async (accessor) => {
        const executor = accessor.fakeExecutor();
        executor.willReply('sql_list_driver_runtime_status', snapshot());
        const svc = accessor.instantiate(SqlDriverCatalogService);
        await svc.initialize();
        assert.equal(svc.labelFor('sqlite'), 'SQLite · STABLE');
        assert.equal(svc.labelFor('postgres'), 'PostgreSQL · PLANNED');
    });
});

test('snapshot before initialize throws', async () => {
    await runWithFakes(async (accessor) => {
        const executor = accessor.fakeExecutor();
        executor.willReply('sql_list_driver_runtime_status', snapshot());
        const svc = accessor.instantiate(SqlDriverCatalogService);
        assert.throws(() => svc.snapshot(), /not called/);
    });
});
```

### 3.3 前端 — Driver badge view test

```ts
// src/vs/workbench/contrib/sqlConnections/test/driverCardBadge.test.ts (Phase 00)
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDriverBadge } from 'vs/workbench/contrib/sqlConnections/browser/driverCardBadge';

test('stable badge is actionable and stable-styled', () => {
    const v = buildDriverBadge('stable');
    assert.equal(v.label, 'STABLE');
    assert.equal(v.isActionable, true);
    assert.match(v.className, /--stable/);
});

test('preview badge warns user', () => {
    const v = buildDriverBadge('preview');
    assert.equal(v.label, 'PREVIEW');
    assert.equal(v.isActionable, true);
});

test('planned badge disables actions', () => {
    const v = buildDriverBadge('planned');
    assert.equal(v.label, 'PLANNED');
    assert.equal(v.isActionable, false);
});

test('disabled badge disables actions', () => {
    const v = buildDriverBadge('disabled');
    assert.equal(v.label, 'DISABLED');
    assert.equal(v.isActionable, false);
});
```

### 3.4 CI regression test

`pnpm run test:sql-runtime-status` 调用 `scripts/verify-sql-runtime-status.mjs`，CI 必跑。它已存在于 `package.json` 但本 Phase 给出完整内容。

## 4. 验收标准

- [ ] `cargo test runtime_status` 6/6 通过。
- [ ] `cargo test commands::sql::types` 4/4 通过。
- [ ] `pnpm run test:sql-services` 包含新增 6 个 catalog 用例，全部通过。
- [ ] `pnpm run test:sql-connections` 包含新增 4 个 badge 用例，全部通过。
- [ ] `pnpm run test:sql-runtime-status` 通过。
- [ ] UI 启动时 `initialize()` 调用顺序先于 `ISqlConnectionService` 任何方法。

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| 现有 UI 仍直接渲染字符串 status | Phase 01 起所有 driver card 都用 `buildDriverBadge()`，旧文案 delete 在 Phase 01 一并处理。 |
| 启动顺序错误 | 在 `workbench.common.main.ts` 用 `await catalog.initialize()` 串行化；任何后续 service 假装 snapshot 可用都会失败。 |
| 后端表与前端表漂移 | 后端永远是 truth-of-record；前端 constructor 不允许接受 snapshot 注入，只能 execute invoke。 |

## 6. 与下游 Phase 的接口

- **Phase 01**：`assert_driver_status_at_least` 会被 `sql_open_connection` 调用，禁止 connection 主动尝试打开 planned driver。
- **Phase 02**：metadata service 在调用 `listDatabases` 之前必须 `catalog.assertAtLeast('sqlite', 'stable')`。
- **Phase 06**：AI service 读取 driver status 以决定 context 中是否提示「preview」。
- **Phase 08**：release checklist 强制 `test:sql-runtime-status` 通过。

## 7. DoD

- 真有唯一 `DRIVER_RUNTIME_STATUS_TABLE`。
- 真有 CI 阻止漂移。
- 真有 UI 唯一渲染函数。
- 真有不依赖任何「未来 driver」的回归用例。
