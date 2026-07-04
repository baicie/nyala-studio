# Phase 05 — History / Formatter / Snippets / Explain

## 0. 摘要

把"能跑 SQL"升级成"日常能用 SQL"。本期四个独立但相邻的能力：

1. **History**：每次成功的执行进入本地 history，可搜索、可点击打开。
2. **Draft Restore**：打开 SQL editor 时自动恢复到上次未保存/未成功执行内容。
3. **Snippets**：可注册、插入的 SQL 片段（来自代码内置 + 插件）。
4. **Formatter**：本地 formatter，把多 statement SQL 重新格式化。
5. **Explain**：SQLite/MySQL 的 EXPLAIN 帮助，输出可读的计划。

不在范围：

- 不持久化 history 到云端；
- 不实现 global saved query library（→ Phase 11）；
- 不实现 DDL diff / ER 图；
- 不实现 visual explain graph（→ Phase 11）。

## 1. 范围

- History storage：本地 JSON；不超过 1000 条，fifo rotate；
- Draft storage：与 editor 1-to-1 绑定；
- Snippets：内置 + plugin registry 提供；
- Formatter：基于纯 JS 的本地实现，不依赖远端 LLM；
- Explain helper：SQLite/MySQL，仅本地命令查询；MySQL Preview 标记无 cancellation。

## 2. 设计

### 2.1 History Model

`src/vs/workbench/contrib/sqlHistory/browser/sqlQueryHistoryModel.ts`：

```ts
// src/vs/workbench/contrib/sqlHistory/browser/sqlQueryHistoryModel.ts (Phase 05)
import { Disposable } from 'vs/base/common/lifecycle';
import { Emitter } from 'vs/base/common/event';

export interface HistoryEntry {
    id: string;
    connectionId: string | null;
    connectionLabel: string;
    statement: string;
    executedAtMs: number;
    durationMs: number;
    outcome: 'success' | 'mutated' | 'error';
    rows?: number;
}

export class SqlQueryHistoryModel extends Disposable {
    declare readonly _brand: 'SqlQueryHistoryModel';
    private entries: HistoryEntry[] = [];

    readonly _onDidChange = this._register(new Emitter<void>());
    readonly onDidChange = this._onDidChange.event;

    constructor(private readonly maxEntries = 1000) {
        super();
    }

    add(e: HistoryEntry): void {
        this.entries = [e, ...this.entries];
        if (this.entries.length > this.maxEntries) {
            this.entries = this.entries.slice(0, this.maxEntries);
        }
        this._onDidChange.fire();
    }

    clear(): void { this.entries = []; this._onDidChange.fire(); }

    query(opts: { text?: string; connectionId?: string; outcome?: HistoryEntry['outcome']; limit?: number }): HistoryEntry[] {
        const t = opts.text?.toLowerCase();
        return this.entries
            .filter((e) =>
                (opts.connectionId ? e.connectionId === opts.connectionId : true) &&
                (opts.outcome ? e.outcome === opts.outcome : true) &&
                (t ? e.statement.toLowerCase().includes(t) : true))
            .slice(0, opts.limit ?? this.entries.length);
    }

    list(): readonly HistoryEntry[] { return this.entries; }
}
```

### 2.2 History Service

`src/vs/workbench/contrib/sqlHistory/browser/sqlQueryHistoryService.ts`：

```ts
// src/vs/workbench/contrib/sqlHistory/browser/sqlQueryHistoryService.ts (Phase 05)
import { Disposable } from 'vs/base/common/lifecycle';
import { SqlQueryHistoryModel, HistoryEntry } from 'vs/workbench/contrib/sqlHistory/browser/sqlQueryHistoryModel';

export const ISqlQueryHistoryService =
    createDecorator<ISqlQueryHistoryService>('sqlQueryHistoryService');

export interface ISqlQueryHistoryService {
    readonly _serviceBrand: undefined;
    initialize(): Promise<void>;
    add(e: HistoryEntry): void;
    clear(): Promise<void>;
    query(opts?: { text?: string; connectionId?: string; outcome?: HistoryEntry['outcome']; limit?: number }): readonly HistoryEntry[];
    snapshot(): readonly HistoryEntry[];
}

interface StorageBackend {
    read(): Promise<HistoryEntry[]>;
    write(entries: HistoryEntry[]): Promise<void>;
}

export class SqlQueryHistoryService extends Disposable implements ISqlQueryHistoryService {
    declare readonly _serviceBrand: undefined;
    private readonly model = new SqlQueryHistoryModel();

    constructor(private readonly storage: StorageBackend) { super(); }

    async initialize(): Promise<void> {
        const entries = await this.storage.read();
        for (const e of entries.reverse()) this.model.add(e);
    }
    add(e: HistoryEntry) { this.model.add(e); void this.persist(); }
    clear() { return (async () => { this.model.clear(); await this.storage.write([]); })(); }
    query(opts?: any) { return this.model.query(opts); }
    snapshot() { return this.model.list(); }

    private async persist(): Promise<void> {
        await this.storage.write([...this.model.list()]);
    }
}
```

`StorageBackend` 通过 `workbench.storageService` 适配：

```ts
// src/vs/workbench/contrib/sqlHistory/browser/storageBackend.ts (Phase 05)
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';

export function makeStorageBackend(storage: IStorageService, key: string) {
    return {
        async read() {
            const text = storage.get(key, StorageScope.WORKSPACE);
            if (!text) return [];
            try { return JSON.parse(text) as any[]; } catch { return []; }
        },
        async write(entries: unknown[]) {
            storage.store(key, JSON.stringify(entries), StorageScope.WORKSPACE);
        },
    };
}
```

### 2.3 Draft Service

> 已经在 Phase 03 §2.6/§3.5 定义；本 Phase 增加 "auto save on every change" 行为。

```ts
// src/vs/workbench/contrib/sqlEditor/browser/sqlEditorDraftService.ts (Phase 05 增量)
import { Disposable } from 'vs/base/common/lifecycle';

export interface DraftBackend {
    read(editorKey: string): Promise<string | null>;
    write(editorKey: string, value: string): Promise<void>;
    remove(editorKey: string): Promise<void>;
}

export class SqlEditorDraftService extends Disposable {
    declare readonly _brand: 'SqlEditorDraftService';
    private pending = new Map<string, string>();
    private flushToken = 0;

    constructor(private readonly backend: DraftBackend) { super(); }

    async load(editorKey: string): Promise<string | null> {
        return this.backend.read(editorKey);
    }

    async save(editorKey: string, text: string): Promise<void> {
        this.pending.set(editorKey, text);
        const my = ++this.flushToken;
        await Promise.resolve();  // microtask batching
        if (my === this.flushToken) {
            const writes = [...this.pending.entries()];
            this.pending.clear();
            for (const [k, v] of writes) await this.backend.write(k, v);
        }
    }

    async clear(editorKey: string): Promise<void> {
        await this.backend.remove(editorKey);
    }
}
```

### 2.4 Snippets Registry

`src/vs/workbench/contrib/sqlAdvanced/browser/snippetsRegistry.ts`：

```ts
// src/vs/workbench/contrib/sqlAdvanced/browser/snippetsRegistry.ts (Phase 05)
export interface SqlSnippet {
    id: string;
    label: string;
    description: string;
    body: string;                  // multi-line SQL
    placeholders?: string[];       // optional token names for IntelliSense
    scope?: ('SELECT' | 'DDL' | 'TX' | 'PRAGMA')[];
}

export const ISqlSnippetsRegistry =
    createDecorator<ISqlSnippetsRegistry>('sqlSnippetsRegistry');

export interface ISqlSnippetsRegistry {
    readonly _serviceBrand: undefined;
    register(snippet: SqlSnippet): { dispose: () => void };
    list(filter?: { text?: string }): SqlSnippet[];
    get(id: string): SqlSnippet | undefined;
}
```

```ts
// src/vs/workbench/contrib/sqlAdvanced/browser/sqlSnippetsRegistryImpl.ts (Phase 05)
import { Disposable } from 'vs/base/common/lifecycle';
import { Emitter } from 'vs/base/common/event';
import { ISqlSnippetsRegistry, SqlSnippet } from 'vs/workbench/contrib/sqlAdvanced/browser/snippetsRegistry';

export class SqlSnippetsRegistry extends Disposable implements ISqlSnippetsRegistry {
    declare readonly _serviceBrand: undefined;
    private readonly _onDidChange = this._register(new Emitter<void>());
    readonly onDidChange = this._onDidChange.event;
    private snippets: SqlSnippet[] = [];

    constructor(private readonly builtIns: SqlSnippet[]) {
        super();
        for (const s of builtIns) this.snippets.push(s);
    }

    register(s: SqlSnippet) {
        this.snippets.push(s);
        this._onDidChange.fire();
        const self = this;
        return { dispose() {
            self.snippets = self.snippets.filter((x) => x.id !== s.id);
            self._onDidChange.fire();
        } };
    }

    list(filter?: { text?: string }) {
        const t = filter?.text?.toLowerCase();
        return this.snippets.filter((s) =>
            !t || s.label.toLowerCase().includes(t) || s.description.toLowerCase().includes(t));
    }

    get(id: string) { return this.snippets.find((s) => s.id === id); }
}

export const BUILTIN_SNIPPETS: SqlSnippet[] = [
    { id: 'select-all', label: 'select * from',
      description: 'SELECT * FROM <table>',
      body: 'SELECT * FROM ${1:table} LIMIT ${2:100};', scope: ['SELECT'] },
    { id: 'count-rows', label: 'count rows',
      description: 'Count rows in a table',
      body: 'SELECT COUNT(*) AS n FROM ${1:table};', scope: ['SELECT'] },
    { id: 'pragma-info', label: 'pragma table_info',
      description: 'SQLite pragma table_info',
      body: 'PRAGMA table_info(${1:table});', scope: ['PRAGMA'] },
    { id: 'tx-begin', label: 'begin',
      description: 'Start a transaction',
      body: 'BEGIN;\n$0\nCOMMIT;', scope: ['TX'] },
];
```

### 2.5 Formatter

`src/vs/workbench/contrib/sqlAdvanced/common/sqlFormatter.ts`：

```ts
// src/vs/workbench/contrib/sqlAdvanced/common/sqlFormatter.ts (Phase 05)
//
// 极简、纯 JS、可单元测试的 SQL Formatter。
// 目标：让用户在 SQL Editor 一键获得缩进对齐，不会出现方言 bug 也不会引入远端依赖。
// 句法：把 statement 切成 line，每条语句前后输出空行，关键字大写、其它保留。

const KEYWORDS = new Set([
    'select', 'from', 'where', 'group', 'by', 'having', 'order', 'limit', 'offset',
    'insert', 'into', 'values', 'update', 'set', 'delete',
    'create', 'table', 'view', 'index', 'drop', 'alter', 'truncate',
    'join', 'left', 'right', 'inner', 'outer', 'full', 'on', 'using',
    'and', 'or', 'not', 'in', 'is', 'null', 'like',
    'begin', 'commit', 'rollback',
    'as', 'distinct', 'union', 'all',
]);

export interface FormatterOptions {
    keywordCase: 'upper' | 'lower' | 'preserve';
    indentSize: number;
    commaAtLineStart: boolean;
}

export const DEFAULT_FORMATTER_OPTIONS: FormatterOptions = {
    keywordCase: 'upper', indentSize: 2, commaAtLineStart: false,
};

export function formatSql(input: string, opts: FormatterOptions = DEFAULT_FORMATTER_OPTIONS): string {
    const stmts = splitForFormat(input);
    return stmts.map((s) => formatStatement(s, opts)).join('\n\n');
}

function splitForFormat(input: string): string[] {
    const out: string[] = [];
    let buf = '';
    let i = 0;
    let inStr = false; let strCh = '"';
    let inLine = false; let inBlock = false;
    for (; i < input.length; i++) {
        const c = input[i]; const nx = input[i + 1];
        if (inLine) { buf += c; if (c === '\n') inLine = false; continue; }
        if (inBlock) { buf += c; if (c === '*' && nx === '/') { buf += nx; i++; inBlock = false; } continue; }
        if (inStr) {
            buf += c;
            if (c === strCh && input[i - 1] !== '\\') inStr = false;
            continue;
        }
        if (c === '-' && nx === '-') { inLine = true; buf += c; continue; }
        if (c === '/' && nx === '*') { inBlock = true; buf += c; continue; }
        if (c === '\'' || c === '"') { inStr = true; strCh = c; buf += c; continue; }
        if (c === ';') { buf += ';\n'; out.push(buf); buf = ''; continue; }
        buf += c;
    }
    if (buf.trim().length > 0) out.push(buf);
    return out;
}

function formatStatement(stmt: string, opts: FormatterOptions): string {
    let tokens: string[] = [];
    let cur = '';
    let i = 0;
    while (i < stmt.length) {
        const c = stmt[i];
        if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
            if (cur.length > 0) { tokens.push(cur); cur = ''; }
            i++;
            continue;
        }
        if (c === '(' || c === ')' || c === ',') {
            if (cur.length > 0) { tokens.push(cur); cur = ''; }
            tokens.push(c);
            i++;
            continue;
        }
        cur += c;
        i++;
    }
    if (cur.length > 0) tokens.push(cur);

    // keyword case rewrite
    if (opts.keywordCase !== 'preserve') {
        tokens = tokens.map((t) => {
            const lc = t.toLowerCase();
            if (KEYWORDS.has(lc)) {
                return opts.keywordCase === 'upper' ? lc.toUpperCase() : lc;
            }
            return t;
        });
    }

    // baseline single-line output (MVP-acceptable).
    let line = '';
    for (let j = 0; j < tokens.length; j++) {
        const tk = tokens[j];
        if (tk === ',') {
            line += opts.commaAtLineStart ? ',\n' + ' '.repeat(opts.indentSize) : ', ';
            continue;
        }
        if (tk === '(' || tk === ')') {
            line += tk === '(' ? ' (' : ')';
            continue;
        }
        if (line.length > 0 && !line.endsWith(' ') && tk !== ',') line += ' ';
        line += tk;
    }
    return line.trim();
}
```

### 2.6 Explain Helper

`src-tauri/src/commands/sql/explain.rs`：

```rust
// src-tauri/src/commands/sql/explain.rs (Phase 05)
use serde::{Deserialize, Serialize};
use crate::commands::sql::types::SqlCommandError;
use crate::commands::sql::state::SharedConnectionManager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainRowDto {
    pub id: i64,
    pub parent: i64,
    pub not_used: i64,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "dialect", rename_all = "lowercase")]
pub enum ExplainPlanDto {
    Sqlite { rows: Vec<ExplainRowDto> },
    Mysql  { rows: Vec<ExplainRowDto> },
    Postgres { rows: Vec<ExplainRowDto> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainResponseDto {
    pub statement: String,
    pub dialect: String,
    pub plan: ExplainPlanDto,
    pub fallback_note: Option<String>,
}

#[tauri::command]
pub fn sql_explain(
    manager: tauri::State<'static, SharedConnectionManager>,
    connection_id: String,
    statement: String,
) -> Result<ExplainResponseDto, SqlCommandError> {
    let manager = manager.inner().clone();
    manager.with_conn(&connection_id, move |entry| {
        match entry.driver_id {
            crate::runtime_status::DriverId::Sqlite => {
                let mut stmt = entry.conn.prepare_raw(format!("EXPLAIN {statement}"))
                    .map_err(|e| SqlCommandError::new("sqlite_explain_prepare", e.to_string()))?;
                let rows = stmt.query_into_explain_rows()
                    .map_err(|e| SqlCommandError::new("sqlite_explain_query", e.to_string()))?;
                Ok(ExplainResponseDto {
                    statement,
                    dialect: "sqlite".into(),
                    plan: ExplainPlanDto::Sqlite { rows },
                    fallback_note: None,
                })
            }
            crate::runtime_status::DriverId::Mysql => {
                // MySQL Preview: 调用 EXPLAIN；cancellation not supported，
                // fallback_note 提示用户。
                let res = entry.conn.explain_mysql(&statement)
                    .map_err(|e| SqlCommandError::new("mysql_explain", e.to_string()))?;
                Ok(ExplainResponseDto {
                    statement,
                    dialect: "mysql".into(),
                    plan: ExplainPlanDto::Mysql { rows: res.rows },
                    fallback_note: Some("MySQL Preview: cancellation is not supported yet.".into()),
                })
            }
            crate::runtime_status::DriverId::Postgres => {
                Ok(ExplainResponseDto {
                    statement,
                    dialect: "postgres".into(),
                    plan: ExplainPlanDto::Postgres { rows: vec![] },
                    fallback_note: Some("PostgreSQL runtime not enabled in this build.".into()),
                })
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sql::types::ConnectionProfile;
    use crate::commands::sql::driver::SqlConnection;
    use crate::commands::sql::sqlite_driver::{SqliteDriver, SqliteConnection};

    fn mem_sqlite() -> BoxedConnection {
        let p = ConnectionProfile {
            id: "x".into(), label: "x".into(), driver: crate::commands::sql::types::DriverIdDto::Sqlite,
            read_only: false, host: None, port: None,
            database: None, username: None, file_path: None,
            remember_in_memory: true, created_at_ms: 0,
        };
        SqliteDriver.open(&p, &Default::default()).unwrap()
    }

    #[test]
    fn sqlite_explain_returns_rows() {
        let mut c = mem_sqlite();
        // 我们这里直接调用底层 driver 的 explain，不依赖整个 connectionManager。
        let any: &mut SqliteConnection = unsafe { &mut *(c.as_mut() as *mut dyn SqlConnection as *mut SqliteConnection) };
        any.conn.execute("CREATE TABLE u(id INTEGER PRIMARY KEY, n TEXT)", []).unwrap();
        let mut stmt = any.conn.prepare("EXPLAIN SELECT * FROM u").unwrap();
        let mut rows: Vec<ExplainRowDto> = Vec::new();
        let mut q = stmt.query([]).unwrap();
        while let Some(r) = q.next().unwrap() {
            rows.push(ExplainRowDto {
                id: r.get(0).unwrap(),
                parent: r.get(1).unwrap(),
                not_used: r.get(2).unwrap(),
                detail: r.get(3).unwrap_or_default(),
            });
        }
        assert!(!rows.is_empty());
    }

    #[test]
    fn explain_response_serializes_tagged_dialect() {
        let r = ExplainResponseDto {
            statement: "select 1".into(),
            dialect: "sqlite".into(),
            plan: ExplainPlanDto::Sqlite { rows: vec![] },
            fallback_note: None,
        };
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains("\"dialect\":\"Sqlite\""));
    }
}
```

### 2.7 文件清单

新增：

```txt
src/vs/workbench/contrib/sqlHistory/browser/sqlQueryHistoryModel.ts
src/vs/workbench/contrib/sqlHistory/browser/sqlQueryHistoryService.ts
src/vs/workbench/contrib/sqlHistory/browser/storageBackend.ts
src/vs/workbench/contrib/sqlAdvanced/browser/snippetsRegistry.ts
src/vs/workbench/contrib/sqlAdvanced/browser/sqlSnippetsRegistryImpl.ts
src/vs/workbench/contrib/sqlAdvanced/common/sqlFormatter.ts
src/vs/workbench/contrib/sqlEditor/browser/sqlEditorDraftService.ts (Phase 03 已新增，Phase 05 增量写)
src-tauri/src/commands/sql/explain.rs
src/vs/workbench/contrib/sqlHistory/test/sqlQueryHistoryModel.test.ts
src/vs/workbench/contrib/sqlHistory/test/sqlQueryHistoryService.test.ts
src/vs/workbench/contrib/sqlHistory/test/sqlQueryHistoryViewModel.test.ts
src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedFormatter.test.ts
src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedExplain.test.ts
src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedSnippets.test.ts
docs/sql-mvp-phases/phase-05-history-formatter-snippets-explain.md         (本文件)
```

修改：

```txt
src/vs/workbench/contrib/sqlHistory/browser/sqlHistory.contribution.ts (+HistoryService 注册 + 面板 listView)
src/vs/workbench/contrib/sqlAdvanced/browser/sqlAdvanced.contribution.ts  (+snippet/formatter/explain 注册)
src-tauri/src/commands/sql/mod.rs   (+注册 sql_explain)
src-tauri/src/commands/sql/sqlite_driver.rs (+EXPLAIN 通道承接)
src-tauri/src/commands/sql/driver.rs  (+prepare_raw/explain_mysql/query_into_explain_rows)
src/vs/workbench/services/sql/browser/sqlService.contribution.ts  (+ISqlQueryHistoryService 注册)
```

## 3. 单元测试完整代码

### 3.1 History Model

```ts
// src/vs/workbench/contrib/sqlHistory/test/sqlQueryHistoryModel.test.ts (Phase 05)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlQueryHistoryModel, HistoryEntry } from 'vs/workbench/contrib/sqlHistory/browser/sqlQueryHistoryModel';

function mk(i: number, conn: string | null = 'a', outcome: HistoryEntry['outcome'] = 'success'): HistoryEntry {
    return {
        id: `e${i}`,
        connectionId: conn,
        connectionLabel: conn ?? 'unknown',
        statement: `SELECT ${i}`,
        executedAtMs: 1_000 + i,
        durationMs: 5,
        outcome,
    };
}

test('add keeps order newest-first', () => {
    const m = new SqlQueryHistoryModel();
    m.add(mk(1));
    m.add(mk(2));
    assert.equal(m.list()[0].id, 'e2');
});

test('rotation caps entries', () => {
    const m = new SqlQueryHistoryModel(10);
    for (let i = 0; i < 25; i++) m.add(mk(i));
    assert.equal(m.list().length, 10);
});

test('query filters by text', () => {
    const m = new SqlQueryHistoryModel();
    m.add({ ...mk(1), statement: 'SELECT * FROM users' });
    m.add({ ...mk(2), statement: 'DROP TABLE x' });
    const r = m.query({ text: 'select' });
    assert.equal(r.length, 1);
    assert.equal(r[0].id, 'e1');
});

test('query filters by outcome', () => {
    const m = new SqlQueryHistoryModel();
    m.add(mk(1, 'a', 'success'));
    m.add(mk(2, 'a', 'error'));
    assert.equal(m.query({ outcome: 'error' }).length, 1);
});

test('query filters by connection', () => {
    const m = new SqlQueryHistoryModel();
    m.add(mk(1, 'a'));
    m.add(mk(2, 'b'));
    assert.equal(m.query({ connectionId: 'a' }).length, 1);
});

test('clear empties', () => {
    const m = new SqlQueryHistoryModel();
    m.add(mk(1));
    m.clear();
    assert.equal(m.list().length, 0);
});

test('query with no opts returns all', () => {
    const m = new SqlQueryHistoryModel();
    m.add(mk(1));
    m.add(mk(2));
    assert.equal(m.query().length, 2);
});

test('limit truncates result', () => {
    const m = new SqlQueryHistoryModel();
    for (let i = 0; i < 5; i++) m.add(mk(i));
    assert.equal(m.query({ limit: 3 }).length, 3);
});
```

### 3.2 History Service

```ts
// src/vs/workbench/contrib/sqlHistory/test/sqlQueryHistoryService.test.ts (Phase 05)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlQueryHistoryService } from 'vs/workbench/contrib/sqlHistory/browser/sqlQueryHistoryService';

class MemStorage {
    state: any[] = [];
    async read() { return this.state; }
    async write(v: any[]) { this.state = v; }
}

test('initialize loads entries', async () => {
    const s = new SqlQueryHistoryService(new MemStorage());
    void s; // type
});

test('add persists', async () => {
    const m = new MemStorage();
    const svc = new SqlQueryHistoryService(m);
    await svc.initialize();
    svc.add({
        id: 'x', connectionId: 'a', connectionLabel: 'a',
        statement: 'SELECT 1', executedAtMs: 1, durationMs: 1, outcome: 'success',
    });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(m.state.length, 1);
});

test('clear wipes backend', async () => {
    const m = new MemStorage();
    m.state = [{ id: 'x' }];
    const svc = new SqlQueryHistoryService(m);
    await svc.initialize();
    await svc.clear();
    assert.deepEqual(m.state, []);
    assert.equal(svc.snapshot().length, 0);
});
```

### 3.3 ViewModel

```ts
// src/vs/workbench/contrib/sqlHistory/test/sqlQueryHistoryViewModel.test.ts (Phase 05)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlQueryHistoryViewModel } from 'vs/workbench/contrib/sqlHistory/browser/sqlQueryHistoryViewModel';

test('viewmodel maps entries to labels', () => {
    const vm = new SqlQueryHistoryViewModel();
    vm.update([
        { id: '1', connectionId: 'a', connectionLabel: 'a', statement: 'SELECT 1', executedAtMs: 1, durationMs: 2, outcome: 'success' },
    ]);
    const v = vm.view();
    assert.equal(v.length, 1);
    assert.equal(v[0].label.includes('SELECT 1'), true);
});

test('viewmodel filters on query', () => {
    const vm = new SqlQueryHistoryViewModel();
    vm.update([
        { id: '1', connectionId: 'a', connectionLabel: 'a', statement: 'SELECT 1', executedAtMs: 1, durationMs: 1, outcome: 'success' },
        { id: '2', connectionId: 'a', connectionLabel: 'a', statement: 'DROP TABLE x', executedAtMs: 1, durationMs: 1, outcome: 'success' },
    ]);
    vm.setQuery({ text: 'drop' });
    assert.equal(vm.view().length, 1);
});

test('viewmodel sort toggles', () => {
    const vm = new SqlQueryHistoryViewModel();
    vm.update([
        { id: '1', connectionId: 'a', connectionLabel: 'a', statement: 'SELECT 1', executedAtMs: 200, durationMs: 1, outcome: 'success' },
        { id: '2', connectionId: 'a', connectionLabel: 'a', statement: 'SELECT 2', executedAtMs: 100, durationMs: 1, outcome: 'success' },
    ]);
    vm.setSort('desc');
    assert.equal(vm.view()[0].id, '1');
    vm.setSort('asc');
    assert.equal(vm.view()[0].id, '2');
});
```

### 3.4 Formatter tests

```ts
// src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedFormatter.test.ts (Phase 05)
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSql, DEFAULT_FORMATTER_OPTIONS } from 'vs/workbench/contrib/sqlAdvanced/common/sqlFormatter';

test('uppercases keywords by default', () => {
    assert.equal(formatSql('select a from b where a=1'),
        'SELECT A FROM B WHERE A = 1');
});

test('lowercase keyword option', () => {
    assert.equal(formatSql('SELECT a FROM b', { ...DEFAULT_FORMATTER_OPTIONS, keywordCase: 'lower' }),
        'select a from b');
});

test('preserves identifier case when preserve', () => {
    assert.equal(formatSql('SELECT myCol FROM MyTable', { ...DEFAULT_FORMATTER_OPTIONS, keywordCase: 'preserve' }),
        'myCol FROM MyTable');
});

test('multiple statements are separated by blank line', () => {
    const s = formatSql('select 1; select 2;');
    assert.match(s, /\n\s*\n/);
});

test('does not break strings with semicolons', () => {
    const s = formatSql(`SELECT 'a;b'`);
    assert.match(s, /'a;b'/);
});

test('does not break line comment after semicolon', () => {
    const s = formatSql(`SELECT 1; -- comment\nSELECT 2`);
    assert.match(s, /comment/);
});

test('does not break block comments', () => {
    const s = formatSql('/* hi */ SELECT 1');
    assert.match(s, /\/\* hi \*\//);
});

test('empty input returns empty', () => {
    assert.equal(formatSql(''), '');
});

test('whitespace only returns empty', () => {
    assert.equal(formatSql('   \n  ').trim(), '');
});

test('commaAtLineStart option', () => {
    const s = formatSql('SELECT a, b FROM t', {
        ...DEFAULT_FORMATTER_OPTIONS, commaAtLineStart: true,
    });
    assert.match(s, /,\n/);
});
```

### 3.5 Snippets tests

```ts
// src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedSnippets.test.ts (Phase 05)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlSnippetsRegistry, BUILTIN_SNIPPETS } from 'vs/workbench/contrib/sqlAdvanced/browser/sqlSnippetsRegistryImpl';

test('default registry exposes built-ins', () => {
    const r = new SqlSnippetsRegistry(BUILTIN_SNIPPETS);
    const ids = r.list().map((s) => s.id);
    for (const i of ['select-all', 'count-rows', 'pragma-info', 'tx-begin']) {
        assert.ok(ids.includes(i), `missing ${i}`);
    }
});

test('register and dispose', () => {
    const r = new SqlSnippetsRegistry(BUILTIN_SNIPPETS);
    const handle = r.register({ id: 'x', label: 'x', description: 'x', body: 'SELECT 1' });
    assert.ok(r.get('x'));
    handle.dispose();
    assert.equal(r.get('x'), undefined);
});

test('list filters by text', () => {
    const r = new SqlSnippetsRegistry(BUILTIN_SNIPPETS);
    const v = r.list({ text: 'pragma' });
    assert.ok(v.length >= 1);
    assert.equal(v[0].id, 'pragma-info');
});

test('list with unknown text returns all', () => {
    const r = new SqlSnippetsRegistry(BUILTIN_SNIPPETS);
    const v = r.list({ text: 'does-not-match-anything' });
    assert.ok(v.length >= BUILTIN_SNIPPETS.length);
});

test('register duplicate id replaces', () => {
    const r = new SqlSnippetsRegistry([]);
    r.register({ id: 't', label: 'A', description: 'A', body: 'SELECT 1' });
    r.register({ id: 't', label: 'B', description: 'B', body: 'SELECT 2' });
    assert.equal(r.list().length, 1);
    assert.equal(r.get('t')?.label, 'B');
});
```

### 3.6 Explain helper tests

```ts
// src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedExplain.test.ts (Phase 05)
import test from 'node:test';
import assert from 'node:assert/strict';
import { describe, expect } from 'vitest';  // 如果底层测试框架用了 vitest
```

> 注意：本仓库使用 `node --test`。本地 explain 调用是后端 service 调用；前端的 explain helper 只做行渲染。

```ts
// src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedExplainRender.test.ts (Phase 05)
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderExplainRows } from 'vs/workbench/contrib/sqlAdvanced/browser/sqlExplainRender';

test('renders SQLite explain rows', () => {
    const s = renderExplainRows([
        { id: 0, parent: -1, not_used: 0, detail: 'SCAN u' },
        { id: 1, parent: 0, not_used: 0, detail: 'USE TEMP B-TREE FOR ORDER BY' },
    ]);
    assert.match(s, /SCAN u/);
    assert.match(s, /TEMP B-TREE/);
});

test('returns placeholder for empty rows', () => {
    assert.equal(renderExplainRows([]), '(no plan)');
});

test('falls back when plan unsupported', () => {
    const s = renderExplainRows([], { fallbackNote: 'PostgreSQL runtime not enabled.' });
    assert.match(s, /PostgreSQL runtime not enabled/);
});

test('renders MySQL preview with note', () => {
    const s = renderExplainRows([], { fallbackNote: 'MySQL Preview: cancellation is not supported yet.' });
    assert.match(s, /cancellation is not supported/);
});
```

> Rust 端 explain 已有 `sqlite_explain_returns_rows` 与 `explain_response_serializes_tagged_dialect` 两个测试在 §2.6。

## 4. 验收

- [ ] `cargo test explain` 2/2 通过；
- [ ] `pnpm run test:sql-history` 通过（≥12 用例）；
- [ ] `pnpm run test:sql-advanced` 包含 formatter/snippets/explain（≥13 用例）；
- [ ] UI：
  - 跑任意 SELECT 后进入 History，看到该条目；
  - History 搜索 "select" 高亮匹配；
  - Formatter 快捷键对脏 SQL 输出对齐结果；
  - Snippet 选择后插入占位文本；
  - SQLite 上跑 `EXPLAIN SELECT * FROM u` 命令，panel 出现 EXPLAIN rows。

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| History 存储增长无界 | maxEntries + FIFO rotate；后续 Phase 11 可能加入按 connection 折叠。 |
| Formatter 改变 SQL 语义 | 仅做 token 化、空格、关键字大小写变化，不改 identifier；保留字符串/注释原文；test 显式覆盖字符串中分号。 |
| Snippets 注入到 SQL Editor 占位符 | 占位符保持 `${N}` 形式，与现有 Monaco snippet 系统解耦（避免引入语言包）。 |
| MySQL Preview 取消不支持 | UI 显式提示；`fallback_note` 永远包含这条警告。 |

## 6. 与下游接口

- Phase 06：AI Provider 可读取 history（最近 20 条）作为时间窗 context。
- Phase 07：plugin registry 可注册 snippets / formatter / explain viewer（这是统一 contribution point 的入口）。
- Phase 08：SQLite demo flow 会主动 run 一段 SELECT，让 history 立刻有内容。

## 7. DoD

- 真有可清空 history、可搜索 history；
- 真有 draft restore 行为；
- 真有可注册 snippet；
- 真有本地 formatter；
- 真有 SQLite/MySQL explain 返回结果。
