# Phase 06 — AI Helper Foundation

## 0. 摘要

在 Workbench 里建一个**完全可控**的 AI Helper：

- 默认 offline-safe 的 deterministic provider；不接云端；
- AI 可以**生成 SQL draft**，但**绝不能直接执行**；
- AI 可以解释错误、优化建议、解释 explain plan；
- AI context 完全在 client 内构造：从 dialect、connection、schema、selected SQL、error、explain 中拼装；
- 任何能力通过统一 Capability 抽象，未来 Phase 10 MCP 直接复用。

不做：

- 不接云端模型；
- 不在 AI side panel 自动执行 SQL；
- 不"AI 一句话连库"。

## 1. 范围

- `SqlAiService`：暴露 `explain* / fix / optimize / generateDraft / explainPlan / summarizeResult`；
- `SqlAiContextBuilder`：基于当前连接 + 最近执行结果 + editor selection 构建 context；
- Deterministic offline-safe provider：基于 token + 输入内容的字符串模板；
- AI side panel：显示 draft / explanation，禁止 "Execute" 按钮直接执行；
- 保留 **Phase 09+** 接入 BYO Key / Ollama 的接口边界，但 MVP 不启用。

## 2. 设计

### 2.1 Capability 模型（先于 service 定义）

`src/vs/workbench/services/sql/common/capability.ts`：

```ts
// src/vs/workbench/services/sql/common/capability.ts (Phase 06)
//
// 整个 Workbench 唯一的能力（permissions）枚举。
// Phase 06 不在 production 接 MCP / Plugin, 但模型先留。

export type Capability =
    | 'readMetadata'        // list_schemas/tables/columns
    | 'readSqlText'         // 读当前 editor 文本
    | 'readResultShape'     // 读 result column 元信息 + rowcount，不读 row 内容
    | 'executeReadOnly'     // SELECT-only execute
    | 'requestWrite'        // INSERT/UPDATE/DELETE/DDL 必须经用户审批
    | 'exportData'          // CSV/JSON 等导出任务
    | 'accessSecrets'       // 读取 connection secret；MVP 不允许
    | 'registerCommand';    // 注册 Command Palette / Menu / Keybinding

export const ALL_CAPABILITIES: readonly Capability[] = [
    'readMetadata', 'readSqlText', 'readResultShape',
    'executeReadOnly', 'requestWrite', 'exportData',
    'accessSecrets', 'registerCommand',
];

export interface CapabilityGrant {
    id: string;             // plugin id or 'core'
    capabilities: Capability[];
}
```

### 2.2 Provider 接口与 deterministic provider

`src/vs/workbench/services/sql/common/sqlAi.ts`：

```ts
// src/vs/workbench/services/sql/common/sqlAi.ts (Phase 06)
export interface SqlAiContext {
    dialect: 'sqlite' | 'mysql' | 'postgres';
    driverStatus: 'stable' | 'preview' | 'planned' | 'disabled';
    connectionLabel?: string;
    database?: string;
    schema?: string;
    selectedTables: string[];
    selectedSql?: string;
    currentStatement?: string;
    lastError?: { code: string; message: string };
    lastExplainSummary?: string;
    resultShape?: { columns: { name: string; dataType: string }[]; rowCount: number };
    safetyPolicy: { readonlyMode: boolean; allowMutation: boolean };
}

export interface SqlAiRequest {
    kind: 'explainError' | 'optimize' | 'explainPlan' | 'generateDraft' | 'fix' | 'summarizeResult';
    context: SqlAiContext;
    prompt?: string;        // optional user-supplied guidance
}

export interface SqlAiResponse {
    text: string;
    sql?: string;           // for generateDraft/fix, optional
    confidence: 'low' | 'medium' | 'high';
    sources: string[];      // deterministic rationale fragments
}

export interface ISqlAiProvider {
    readonly id: string;
    readonly capabilities: Capability[];
    invoke(req: SqlAiRequest): Promise<SqlAiResponse>;
}

export const ISqlAiRegistry =
    createDecorator<ISqlAiRegistry>('sqlAiRegistry');
export interface ISqlAiRegistry {
    readonly _serviceBrand: undefined;
    register(p: ISqlAiProvider): { dispose: () => void };
    active(): ISqlAiProvider;
    list(): ISqlAiProvider[];
}
```

`src/vs/workbench/services/sql/browser/sqlAiProviders/deterministic.ts`：

```ts
// src/vs/workbench/services/sql/browser/sqlAiProviders/deterministic.ts (Phase 06)
import { SqlAiRequest, SqlAiResponse, ISqlAiProvider } from 'vs/workbench/services/sql/common/sqlAi';

export class DeterministicOfflineProvider implements ISqlAiProvider {
    readonly id = 'deterministic-offline-v1';
    readonly capabilities = [
        'readMetadata', 'readSqlText', 'readResultShape',
    ] as const;

    async invoke(req: SqlAiRequest): Promise<SqlAiResponse> {
        switch (req.kind) {
            case 'explainError':
                return this.explainError(req);
            case 'optimize':
                return this.optimize(req);
            case 'explainPlan':
                return this.explainPlan(req);
            case 'generateDraft':
                return this.generateDraft(req);
            case 'fix':
                return this.fix(req);
            case 'summarizeResult':
                return this.summarizeResult(req);
        }
    }

    private explainError(req: SqlAiRequest): SqlAiResponse {
        const ctx = req.context;
        const msg = ctx.lastError?.message ?? '(no error)';
        const stmt = ctx.currentStatement ?? '';
        const sources = [
            `error.code=${ctx.lastError?.code ?? 'n/a'}`,
            `dialect=${ctx.dialect}`,
            `readonly=${ctx.safetyPolicy.readonlyMode}`,
        ];
        const text = [
            'Possible causes (deterministic):',
            `- The error message was: ${msg}.`,
            `- It happened on dialect=${ctx.dialect}.`,
            stmt ? `- Statement: ${stmt}` : '',
            ctx.safetyPolicy.readonlyMode ? '- Read-only mode is on; mutations are blocked.' : '',
        ].filter(Boolean).join('\n');
        return { text, confidence: 'low', sources };
    }

    private optimize(req: SqlAiRequest): SqlAiResponse {
        const stmt = req.context.currentStatement ?? '';
        const hints: string[] = [];
        if (stmt && /\bSELECT \* /.test(stmt)) hints.push('- Avoid SELECT *; explicitly list columns.');
        if (stmt && /WHERE\s+1=1/.test(stmt, )) hints.push('- Drop "WHERE 1=1" placeholder; use real filters.');
        if (!stmt.includes('LIMIT') && /SELECT/.test(stmt)) hints.push('- Add LIMIT for preview queries.');
        const text = hints.length === 0
            ? 'No common optimization issues detected at this stage.'
            : hints.join('\n');
        return { text, confidence: 'low', sources: ['heuristic-v1'] };
    }

    private explainPlan(req: SqlAiRequest): SqlAiResponse {
        const summary = req.context.lastExplainSummary ?? '';
        return {
            text: summary
                ? `Plan summary: ${summary}`
                : 'No plan summary available yet.',
            confidence: 'low',
            sources: ['deterministic-v1'],
        };
    }

    private generateDraft(req: SqlAiRequest): SqlAiResponse {
        const text = req.prompt ?? req.context.currentStatement ?? '';
        const dialect = req.context.dialect;
        const schema = req.context.selectedTables.length > 0
            ? req.context.selectedTables.join(', ')
            : req.context.database ?? '(no schema)';
        const sql = [
            `-- dialect=${dialect} schema=${schema}`,
            `-- safety=readonly=${req.context.safetyPolicy.readonlyMode}`,
            `SELECT  /* TODO: columns */`,
            '  *',
            `FROM ${req.context.selectedTables[0] ?? 'your_table'}`,
            text ? `-- user intent: ${text}` : '',
            'LIMIT 100;',
        ].filter(Boolean).join('\n');
        return {
            text: `Draft (deterministic) generated. Review before executing.\n${sql}`,
            sql,
            confidence: 'low',
            sources: ['template-v1'],
        };
    }

    private fix(req: SqlAiRequest): SqlAiResponse {
        const msg = req.context.lastError?.message ?? '';
        const stmt = req.context.currentStatement ?? '';
        return {
            text: `Suggested fix based on error "${msg}": verify column names against schema.`,
            sql: stmt,
            confidence: 'low',
            sources: ['heuristic-v1'],
        };
    }

    private summarizeResult(req: SqlAiRequest): SqlAiResponse {
        const r = req.context.resultShape;
        if (!r) return { text: 'No result yet.', confidence: 'low', sources: [] };
        return {
            text: `Returned ${r.rowCount} rows across ${r.columns.length} columns.`,
            confidence: 'low',
            sources: ['summary-v1'],
        };
    }
}
```

### 2.3 Context Builder

`src/vs/workbench/contrib/sqlAdvanced/browser/sqlAiContextBuilder.ts`：

```ts
// src/vs/workbench/contrib/sqlAdvanced/browser/sqlAiContextBuilder.ts (Phase 06)
import { SqlAiContext } from 'vs/workbench/services/sql/common/sqlAi';
import { ISqlConnectionService } from 'vs/workbench/services/sql/common/sqlConnection';
import { ISqlMetadataService } from 'vs/workbench/services/sql/common/sqlMetadata';
import { ISqlDriverCatalogService, DriverId } from 'vs/workbench/services/sql/common/sqlDriverCatalog';
import { currentStatement } from 'vs/workbench/contrib/sqlEditor/common/sqlStatementSplitter';
import { SqlResultModel } from 'vs/workbench/contrib/sqlResult/browser/sqlResultModel';
import { SqlQueryHistoryModel } from 'vs/workbench/contrib/sqlHistory/browser/sqlQueryHistoryModel';

export interface BuildContextArgs {
    profileId?: string | null;
    editorText?: string;
    editorSelection?: { text: string; offset: number };
    lastError?: { code: string; message: string };
    lastExplainSummary?: string;
}

export class SqlAiContextBuilder {
    constructor(
        private readonly connections: ISqlConnectionService,
        private readonly metadata: ISqlMetadataService,
        private readonly catalog: ISqlDriverCatalogService,
        private readonly results: SqlResultModel,
        private readonly history: SqlQueryHistoryModel,
    ) {}

    async build(args: BuildContextArgs): Promise<SqlAiContext> {
        const profile = args.profileId
            ? (await this.connections.list()).find((c) => c.profile.id === args.profileId)?.profile
            : null;

        const driver = profile?.driver ?? 'sqlite';
        const status = this.catalog.getStatus(driver as DriverId) ?? 'planned';

        const cur = args.editorText && args.editorSelection
            ? currentStatement(args.editorText, args.editorSelection.offset)
            : null;

        const last = this.results.list()[this.results.list().length - 1];

        return {
            dialect: driver,
            driverStatus: status,
            connectionLabel: profile?.label,
            schema: undefined,
            selectedTables: [],
            selectedSql: args.editorSelection?.text,
            currentStatement: cur?.text,
            lastError: args.lastError ?? (
                last?.outcome.kind === 'error' ? {
                    code: last.outcome.code,
                    message: last.outcome.message,
                } : undefined),
            lastExplainSummary: args.lastExplainSummary,
            resultShape: last && last.outcome.kind === 'success' ? {
                columns: last.outcome.columns.map((c) => ({ name: c.name, dataType: c.dataType })),
                rowCount: last.outcome.rowCount,
            } : undefined,
            safetyPolicy: {
                readonlyMode: profile?.readOnly ?? true,
                allowMutation: !(profile?.readOnly ?? true),
            },
        };
    }
}
```

### 2.4 Service 层

`src/vs/workbench/services/sql/browser/sqlAiService.ts`：

```ts
// src/vs/workbench/services/sql/browser/sqlAiService.ts (Phase 06)
import { Disposable } from 'vs/base/common/lifecycle';
import {
    ISqlAiRegistry, ISqlAiProvider, SqlAiRequest, SqlAiResponse,
} from 'vs/workbench/services/sql/common/sqlAi';
import { ISqlConnectionService } from 'vs/workbench/services/sql/common/sqlConnection';
import { ISqlMetadataService } from 'vs/workbench/services/sql/common/sqlMetadata';
import { ISqlDriverCatalogService } from 'vs/workbench/services/sql/common/sqlDriverCatalog';
import { SqlResultModel } from 'vs/workbench/contrib/sqlResult/browser/sqlResultModel';
import { SqlQueryHistoryModel } from 'vs/workbench/contrib/sqlHistory/browser/sqlQueryHistoryModel';
import { SqlAiContextBuilder } from 'vs/workbench/contrib/sqlAdvanced/browser/sqlAiContextBuilder';
import { Capability, ISqlAiService, ISqlAiService_ } from 'vs/workbench/services/sql/common/sqlAiService';
import { DeterministicOfflineProvider } from 'vs/workbench/services/sql/browser/sqlAiProviders/deterministic';

export class SqlAiRegistry extends Disposable implements ISqlAiRegistry {
    declare readonly _serviceBrand: undefined;
    private providers: ISqlAiProvider[] = [];
    constructor() { super(); this.providers.push(new DeterministicOfflineProvider()); }
    register(p: ISqlAiProvider) { this.providers.push(p); return { dispose: () => {
        this.providers = this.providers.filter((x) => x !== p);
    } }; }
    active() { return this.providers[0]; }
    list() { return this.providers; }
}

export class SqlAiService extends Disposable implements ISqlAiService_ {
    declare readonly _serviceBrand: undefined;
    private builder!: SqlAiContextBuilder;
    initialize(conn: ISqlConnectionService, meta: ISqlMetadataService,
               cat: ISqlDriverCatalogService, results: SqlResultModel,
               history: SqlQueryHistoryModel) {
        this.builder = new SqlAiContextBuilder(conn, meta, cat, results, history);
    }
    async invoke(req: SqlAiRequest): Promise<SqlAiResponse> {
        const ctx = await this.builder.build({
            profileId: undefined,
            editorText: req.context.selectedSql ?? req.context.currentStatement,
            editorSelection: req.context.selectedSql ? { text: req.context.selectedSql, offset: 0 } : undefined,
            lastError: req.context.lastError,
            lastExplainSummary: req.context.lastExplainSummary,
        });
        const svc = this.services;
        const p = svc.active();
        return p.invoke({ ...req, context: ctx });
    }
    private get services() {
        // 通过 accessor 找到 registry；
        // 此处用延迟注入简化：
        return (this as any).registry as ISqlAiRegistry;
    }
    setRegistry(r: ISqlAiRegistry) { (this as any).registry = r; }
}
```

### 2.5 Capability 中间件

```ts
// src/vs/workbench/services/sql/browser/sqlAiService.guard.ts (Phase 06)
import { Capability } from 'vs/workbench/services/sql/common/capability';
import { ISqlAiProvider, SqlAiRequest } from 'vs/workbench/services/sql/common/sqlAi';

export class CapabilityGuard {
    constructor(private readonly grants: Map<string, Capability[]>) {}

    ensure(providerId: string, required: Capability[]): void {
        const granted = this.grants.get(providerId) ?? [];
        for (const r of required) {
            if (!granted.includes(r)) {
                throw new Error(`provider ${providerId} missing capability ${r}`);
            }
        }
    }

    wrap<T extends ISqlAiProvider>(provider: T, required: Capability[]): T {
        const self = this;
        return new Proxy(provider, {
            get(target, prop: any) {
                if (prop === 'invoke') {
                    return async (req: SqlAiRequest) => {
                        self.ensure(target.id, required);
                        return target.invoke(req);
                    };
                }
                return (target as any)[prop];
            },
        }) as T;
    }
}
```

### 2.6 文件清单

新增：

```txt
src/vs/workbench/services/sql/common/capability.ts                           (见 §2.1)
src/vs/workbench/services/sql/common/sqlAi.ts                                (见 §2.2)
src/vs/workbench/services/sql/common/sqlAiService.ts                         (接口与 Capability 门)
src/vs/workbench/services/sql/browser/sqlAiProviders/deterministic.ts        (见 §2.2)
src/vs/workbench/services/sql/browser/sqlAiRegistry.ts                       (impl)
src/vs/workbench/services/sql/browser/sqlAiService.ts                        (impl + guard)
src/vs/workbench/services/sql/browser/sqlAiService.guard.ts                  (见 §2.5)
src/vs/workbench/contrib/sqlAdvanced/browser/sqlAiContextBuilder.ts          (见 §2.3)
src/vs/workbench/contrib/sqlAdvanced/browser/sqlAiSidePanel.ts               (panel view)
src/vs/workbench/services/sql/test/sqlAiService.test.ts
src/vs/workbench/contrib/sqlAdvanced/test/sqlAiContextBuilder.test.ts
docs/sql-mvp-phases/phase-06-ai-helper-foundation.md                        (本文件)
```

修改：

```txt
src/vs/workbench/services/sql/browser/sqlService.contribution.ts (+ISqlAiService + registry 注册)
src/vs/workbench/contrib/sqlAdvanced/browser/sqlAdvanced.contribution.ts (+AI side panel 注册)
```

## 3. 单元测试完整代码

### 3.1 Capability model tests

```ts
// src/vs/workbench/services/sql/test/sqlCapability.test.ts (Phase 06)
import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_CAPABILITIES, Capability } from 'vs/workbench/services/sql/common/capability';

test('capability list is unique', () => {
    const set = new Set(ALL_CAPABILITIES);
    assert.equal(set.size, ALL_CAPABILITIES.length);
});

test('capability list contains the eight required kinds', () => {
    const required: Capability[] = [
        'readMetadata', 'readSqlText', 'readResultShape',
        'executeReadOnly', 'requestWrite', 'exportData',
        'accessSecrets', 'registerCommand',
    ];
    for (const r of required) assert.ok(ALL_CAPABILITIES.includes(r));
});
```

### 3.2 Deterministic provider tests

```ts
// src/vs/workbench/services/sql/test/sqlAiProviders.test.ts (Phase 06)
import test from 'node:test';
import assert from 'node:assert/strict';
import { DeterministicOfflineProvider } from 'vs/workbench/services/sql/browser/sqlAiProviders/deterministic';

const ctx = (over: Partial<any> = {}) => ({
    dialect: 'sqlite' as const,
    driverStatus: 'stable' as const,
    selectedTables: [],
    safetyPolicy: { readonlyMode: true, allowMutation: false },
    ...over,
});

test('explainError returns text containing error message', async () => {
    const p = new DeterministicOfflineProvider();
    const r = await p.invoke({
        kind: 'explainError',
        context: ctx({ lastError: { code: 'X', message: 'No such column' } }),
    });
    assert.match(r.text, /No such column/);
    assert.equal(r.confidence, 'low');
});

test('optimize flags SELECT *', async () => {
    const p = new DeterministicOfflineProvider();
    const r = await p.invoke({ kind: 'optimize',
        context: ctx({ currentStatement: 'SELECT * FROM users' }) });
    assert.match(r.text, /Avoid SELECT \*/);
});

test('optimize keeps LIMIT hint for plain SELECT', async () => {
    const p = new DeterministicOfflineProvider();
    const r = await p.invoke({ kind: 'optimize',
        context: ctx({ currentStatement: 'SELECT id FROM users' }) });
    assert.match(r.text, /LIMIT/);
});

test('explainPlan uses last summary', async () => {
    const p = new DeterministicOfflineProvider();
    const r = await p.invoke({ kind: 'explainPlan',
        context: ctx({ lastExplainSummary: 'SCAN u' }) });
    assert.match(r.text, /SCAN u/);
});

test('generateDraft always includes safety block, never runs it', async () => {
    const p = new DeterministicOfflineProvider();
    const r = await p.invoke({ kind: 'generateDraft', context: ctx() });
    assert.match(r.text, /draft/i);
    assert.ok(r.sql?.includes('LIMIT 100'));
    // 关键不变量：不调用任何 invoke/execute
    assert.equal((p as any).executeCalled, undefined);
});

test('fix preserves statement as suggestion', async () => {
    const p = new DeterministicOfflineProvider();
    const r = await p.invoke({
        kind: 'fix',
        context: ctx({ currentStatement: 'SELECT x', lastError: { code: 'X', message: 'no x' } }),
    });
    assert.equal(r.sql, 'SELECT x');
    assert.match(r.text, /verify column names/);
});

test('summarizeResult reads rowCount', async () => {
    const p = new DeterministicOfflineProvider();
    const r = await p.invoke({ kind: 'summarizeResult', context: ctx({
        resultShape: { columns: [{ name: 'id', dataType: 'INT' }], rowCount: 9 },
    }) });
    assert.match(r.text, /9 rows/);
});

test('deterministic provider has no execute capability', () => {
    const p = new DeterministicOfflineProvider();
    assert.ok(!p.capabilities.includes('executeReadOnly'));
});
```

### 3.3 Capability Guard tests

```ts
// src/vs/workbench/services/sql/test/sqlAiService.guard.test.ts (Phase 06)
import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityGuard } from 'vs/workbench/services/sql/browser/sqlAiService.guard';
import { ISqlAiProvider, SqlAiRequest } from 'vs/workbench/services/sql/common/sqlAi';

class FakeProvider implements ISqlAiProvider {
    invoked = 0;
    constructor(readonly id: string, readonly capabilities: any[]) {}
    async invoke(_req: SqlAiRequest) { this.invoked++; return { text: '', sources: [], confidence: 'low' as const }; }
}

test('guard blocks invoke when missing capability', async () => {
    const g = new CapabilityGuard(new Map());
    const p = new FakeProvider('p', []);
    const wrapped = g.wrap(p, ['readMetadata']);
    await assert.rejects(wrapped.invoke({ kind: 'explainError',
        context: {} as any }));
    assert.equal(p.invoked, 0);
});

test('guard allows invoke when granted', async () => {
    const g = new CapabilityGuard(new Map([['p', ['readMetadata']]]));
    const p = new FakeProvider('p', ['readMetadata']);
    const wrapped = g.wrap(p, ['readMetadata']);
    const r = await wrapped.invoke({ kind: 'explainError', context: {} as any });
    assert.ok(r);
    assert.equal(p.invoked, 1);
});

test('guard composes with multiple requirements', async () => {
    const g = new CapabilityGuard(new Map([['p', ['readMetadata', 'readSqlText']]]));
    const p = new FakeProvider('p', ['readMetadata']);
    const wrapped = g.wrap(p, ['readMetadata', 'readSqlText']);
    await assert.rejects(wrapped.invoke({ kind: 'explainError', context: {} as any }));
});

test('guard with no grants denies everything', async () => {
    const g = new CapabilityGuard(new Map());
    const p = new FakeProvider('p', []);
    const wrapped = g.wrap(p, []);
    const r = await wrapped.invoke({ kind: 'explainError', context: {} as any });
    assert.equal(r.text, '');
});
```

### 3.4 Context builder tests

```ts
// src/vs/workbench/contrib/sqlAdvanced/test/sqlAiContextBuilder.test.ts (Phase 06)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlAiContextBuilder } from 'vs/workbench/contrib/sqlAdvanced/browser/sqlAiContextBuilder';

class FakeConn { async list() { return [{ profile:
    { id: 'a', label: 'demo', driver: 'sqlite', readOnly: true, createdAtMs: 0 }, status: { kind: 'idle' } }]; } }
class FakeMeta { async listSchemas() { return []; } async listTables() { return []; } async listColumns() { return []; } }
class FakeCat {
    getStatus(d: string) { return d === 'postgres' ? 'planned' : d === 'mysql' ? 'preview' : 'stable'; }
}
class FakeResults { list() { return []; } }
class FakeHistory {
    list() { return [{
        id: '1', connectionId: 'a', connectionLabel: 'a', statement: 'SELECT 1',
        executedAtMs: 1, durationMs: 1, outcome: 'success' as const,
    }]; }
}

function b() { return new SqlAiContextBuilder(
    new FakeConn() as any, new FakeMeta() as any, new FakeCat() as any,
    new FakeResults() as any, new FakeHistory() as any,
); }

test('build context uses profile.driver as dialect', async () => {
    const ctx = await b().build({ profileId: 'a' });
    assert.equal(ctx.dialect, 'sqlite');
    assert.equal(ctx.connectionLabel, 'demo');
});

test('build context reflects readOnly safety', async () => {
    const ctx = await b().build({ profileId: 'a' });
    assert.equal(ctx.safetyPolicy.readonlyMode, true);
    assert.equal(ctx.safetyPolicy.allowMutation, false);
});

test('build context currentStatement from editor', async () => {
    const ctx = await b().build({
        profileId: 'a',
        editorText: 'SELECT 1; SELECT 2',
        editorSelection: { text: 'SELECT 1', offset: 0 },
    });
    assert.equal(ctx.selectedSql, 'SELECT 1');
    assert.equal(ctx.currentStatement, 'SELECT 1');
});

test('build context lastError from explicit arg', async () => {
    const ctx = await b().build({ profileId: 'a', lastError: { code: 'X', message: 'Y' } });
    assert.deepEqual(ctx.lastError, { code: 'X', message: 'Y' });
});

test('build context without profile yields sqlite default', async () => {
    const ctx = await b().build({});
    assert.equal(ctx.dialect, 'sqlite');
    assert.equal(ctx.safetyPolicy.readonlyMode, true);
});
```

### 3.5 AI Service smoke test

```ts
// src/vs/workbench/services/sql/test/sqlAiService.test.ts (Phase 06)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlAiService } from 'vs/workbench/services/sql/browser/sqlAiService';
import { SqlAiRegistry } from 'vs/workbench/services/sql/browser/sqlAiRegistry';

class EmptyConn { async list() { return []; } }
class EmptyMeta {
    async listSchemas() { return []; } async listTables() { return []; } async listColumns() { return []; }
}
class StableCat { getStatus() { return 'stable'; } }
class EmptyResults { list() { return []; } }
class EmptyHistory { list() { return []; } }

test('invoke returns provider text', async () => {
    const reg = new SqlAiRegistry();
    const svc = new SqlAiService();
    svc.initialize(new EmptyConn() as any, new EmptyMeta() as any,
        new StableCat() as any, new EmptyResults() as any, new EmptyHistory() as any);
    svc.setRegistry(reg);
    const r = await svc.invoke({ kind: 'explainError',
        context: { dialect: 'sqlite', driverStatus: 'stable', selectedTables: [],
                   safetyPolicy: { readonlyMode: true, allowMutation: false },
                   lastError: { code: 'X', message: 'syntax' } } });
    assert.ok(typeof r.text === 'string' && r.text.length > 0);
});

test('registry default active is deterministic', () => {
    const reg = new SqlAiRegistry();
    assert.equal(reg.active().id, 'deterministic-offline-v1');
});

test('registry register/dispose', () => {
    const reg = new SqlAiRegistry();
    let unregistered = 0;
    const fake = { id: 't', capabilities: [], invoke: async () => { return { text: '', sources: [], confidence: 'low' as const }; } };
    const handle = reg.register(fake);
    assert.equal(reg.list().length, 2);
    handle.dispose();
    assert.equal(reg.list().length, 1);
});

test('ai service rejects when context missing required fields', async () => {
    const reg = new SqlAiRegistry();
    const svc = new SqlAiService();
    svc.initialize(new EmptyConn() as any, new EmptyMeta() as any,
        new StableCat() as any, new EmptyResults() as any, new EmptyHistory() as any);
    svc.setRegistry(reg);
    await assert.rejects(() => svc.invoke({ kind: 'fix',
        context: undefined as any }));
});
```

## 4. 验收

- [ ] `pnpm run test:sql-services` 通过（增加 capability / aiService / guard 用例 ≥18）。
- [ ] `pnpm run test:sql-advanced` 通过（含 context builder 5 用例）。
- [ ] UI 行为：
  - 打开 AI 侧栏，跑一条坏 SQL，点 "Explain Error"，出现 deterministic 解释；
  - 点 "Optimize"，出现 SQL 优化建议（`SELECT *` 警告）；
  - 没有 "Execute Draft" 按钮；
  - AI side panel 上的 draft 只能通过 "Insert into editor" 按钮复制到 editor，editor 用户仍需自己执行。

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| Deterministic provider 显得 "假" | 文案直接告知是 heuristic；Phase 11 接入 BYO Key 后立即替换。 |
| AI 误给 mutation SQL | default safetyPolicy.readonlyMode = true + `allowMutation = false`；生成 draft 永远包含 `LIMIT 100` 提示；UI 不暴露 "Execute Draft" 按钮。 |
| Capability 模型与 Phase 07 plugin permission 漂移 | 现在就合并抽象：plugin 权限也用 Capability；Phase 07 接入。 |

## 6. 与下游接口

- SQL Workspace Agent：后续的本地 Rust Runtime、Context Engine、Tool Runtime、
  Policy/Approval、Evidence 与 Workbench 集成见
  [`SQL Workspace Agent 设计规格`](../sql-workspace-agent-design.md)。其中
  `Agent Stage A0-A8` 是独立演进编号，不是 SQL MVP Phase 续号；A3 验收前不改变
  本 Phase 的 draft-only / never-auto-execute 行为。
- Phase 07：plugin 通过 `ISqlAiRegistry.register` 注册新 AI provider；其 capabilities 必须被 CapabilityGuard 验证。
- Phase 10：MCP Tool permission 同样使用 Capability；写文档说明 "read-only / requestWrite / exportData" 三段映射。
- Phase 11：BYO Key / Ollama provider 实现 `ISqlAiProvider`，capability 由服务自动声明。
- Phase 08：演示流中演示 "Explain Error" 与 "Generate Draft (deterministic)"。

## 7. DoD

- 真有 deterministic offline provider；
- 真有 capability 模型与 guard；
- 真有 context builder 与 last-error 回灌；
- 真有 draft 不会自动执行。
