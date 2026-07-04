# Phase 03 — SQL Editor Execution Loop

## 0. 摘要

让用户在 Nyala Studio 里能写、能选、能跑 SQL，并把结果丢给 Phase 04 的 result panel。本期不优化结果呈现，只优化"输入 → 命令发出 → 执行 → 结果回灌"。

最小闭环：

```text
SQL editor tab 绑定 connection
→ execute all / execute selection / execute current statement
→ Ctrl/Cmd + Enter = execute current
→ Shift + Enter      = execute selection
→ running / success / error 三态在 editor 状态栏
```

## 1. 范围

- SQL editor tab 绑定到某个 `ConnectionProfile.id`；
- 三种执行：all / selected / current statement；
- 多 statement 自动 split；
- Safety guard（read-only、disabled driver、dangerous DDL 在 read-only mode 拦截）；
- 不在本期做：history 持久化（→ Phase 05）、rich inline result（→ Phase 04）、AI draft（→ Phase 06）。

## 2. 设计

### 2.1 SqlEditorInput

`src/vs/workbench/contrib/sqlEditor/browser/sqlEditorInput.ts`：

```ts
// src/vs/workbench/contrib/sqlEditor/browser/sqlEditorInput.ts (Phase 03)
import { EditorInput } from 'vs/workbench/common/editor/editorInput';
import { URI } from 'vs/base/common/uri';

export interface SqlEditorState {
    connectionId: string | null;
    draft: string;
    lastSavedAtMs: number;
    dirty: boolean;
}

export class SqlEditorInput extends EditorInput {
    declare readonly _brand: 'SqlEditorInput';

    static readonly ID = 'workbench.editor.sqlEditor';

    private _state: SqlEditorState;

    constructor(
        public readonly resource: URI,
        initialState?: Partial<SqlEditorState>,
    ) {
        super();
        this._state = {
            connectionId: initialState?.connectionId ?? null,
            draft: initialState?.draft ?? '',
            lastSavedAtMs: initialState?.lastSavedAtMs ?? 0,
            dirty: initialState?.dirty ?? false,
        };
    }

    override get typeId() { return SqlEditorInput.ID; }

    get state(): SqlEditorState { return this._state; }

    bindConnection(connectionId: string | null): void {
        this._state = { ...this._state, connectionId, dirty: true };
        this._onDidChangeLabel.fire();
        this._onDidChangeDirty.fire();
    }

    setDraft(text: string, markDirty: boolean): void {
        this._state = { ...this._state, draft: text, dirty: this._state.dirty || markDirty };
        this._onDidChangeDirty.fire();
    }
}
```

### 2.2 Statement Splitter / Current Statement

`src/vs/workbench/contrib/sqlEditor/common/sqlStatementSplitter.ts`：

```ts
// src/vs/workbench/contrib/sqlEditor/common/sqlStatementSplitter.ts (Phase 03)
export interface SqlStatement {
    text: string;
    startOffset: number;
    endOffset: number;
    kind: SqlStatementKind;
}

export type SqlStatementKind =
    | 'select'
    | 'insert' | 'update' | 'delete'
    | 'ddl'
    | 'tx'       // BEGIN / COMMIT / ROLLBACK
    | 'pragma'
    | 'other';

/** 基于换行 + ';' 分隔，保留行注释/块注释原文。 */
export function splitStatements(input: string): SqlStatement[] {
    const trimmed = input ?? '';
    const stmts: SqlStatement[] = [];
    let buf = '';
    let start = 0;
    let inLineComment = false;
    let inBlockComment = false;
    let inString = false;
    let stringCh = '"';
    let i = 0;
    for (; i < trimmed.length; i++) {
        const c = trimmed[i];
        const next = trimmed[i + 1];
        if (inLineComment) {
            if (c === '\n') {
                buf += c;
                inLineComment = false;
                continue;
            }
            buf += c;
            continue;
        }
        if (inBlockComment) {
            if (c === '*' && next === '/') { buf += '*/'; i++; inBlockComment = false; continue; }
            buf += c;
            continue;
        }
        if (inString) {
            if (c === stringCh && trimmed[i - 1] !== '\\') {
                buf += c;
                inString = false;
                continue;
            }
            buf += c;
            continue;
        }
        if (c === '-' && next === '-') { inLineComment = true; buf += '--'; i++; continue; }
        if (c === '/' && next === '*') { inBlockComment = true; buf += '/*'; i++; continue; }
        if (c === '\'' || c === '"') { inString = true; stringCh = c; buf += c; continue; }
        if (c === ';') {
            const text = buf.trim();
            if (text.length > 0) {
                stmts.push({
                    text,
                    startOffset: start,
                    endOffset: start + text.length,
                    kind: classify(text),
                });
            }
            buf = '';
            start = i + 1;
            continue;
        }
        buf += c;
    }
    const tail = buf.trim();
    if (tail.length > 0) {
        stmts.push({
            text: tail,
            startOffset: start,
            endOffset: start + tail.length,
            kind: classify(tail),
        });
    }
    return stmts;
}

/** 当前光标所在的 statement。offset = caret position in input string. */
export function currentStatement(input: string, offset: number): SqlStatement | null {
    const stmts = splitStatements(input);
    for (const s of stmts) {
        if (offset >= s.startOffset && offset <= s.endOffset) {
            return s;
        }
    }
    return stmts.length > 0 ? stmts[stmts.length - 1] : null;
}

/** 类标签：仅 uppercase 第一个 token + 余下匹配关键字。 */
export function classify(text: string): SqlStatementKind {
    const t = text.trim().toUpperCase();
    if (t.startsWith('SELECT') || t.startsWith('WITH')) return 'select';
    if (t.startsWith('INSERT')) return 'insert';
    if (t.startsWith('UPDATE')) return 'update';
    if (t.startsWith('DELETE')) return 'delete';
    if (
        t.startsWith('CREATE') || t.startsWith('DROP') || t.startsWith('ALTER') ||
        t.startsWith('TRUNCATE') || t.startsWith('VACUUM') || t.startsWith('ATTACH') ||
        t.startsWith('DETACH')
    ) return 'ddl';
    if (t.startsWith('BEGIN') || t.startsWith('COMMIT') || t.startsWith('ROLLBACK')) return 'tx';
    if (t.startsWith('PRAGMA')) return 'pragma';
    return 'other';
}
```

### 2.3 Dialect Safety

`src-tauri/src/commands/sql/dialect.rs`：

```rust
// src-tauri/src/commands/sql/dialect.rs (Phase 03)
use crate::commands::sql::types::SqlCommandError;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum SqlDialect { Sqlite, Mysql, Postgres }

impl SqlDialect {
    pub fn detect(profile_driver: crate::runtime_status::DriverId) -> Self {
        match profile_driver {
            crate::runtime_status::DriverId::Sqlite => SqlDialect::Sqlite,
            crate::runtime_status::DriverId::Mysql  => SqlDialect::Mysql,
            crate::runtime_status::DriverId::Postgres => SqlDialect::Postgres,
        }
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadOnlyViolationKind { Drop, DdlNonSelect, Mutation }

#[derive(Debug, Clone, serde::Serialize)]
pub struct ReadOnlyViolation {
    pub kind: ReadOnlyViolationKind,
    pub statement: String,
    pub hint: String,
}

pub fn check_read_only(stmt: &str, read_only: bool) -> Result<(), ReadOnlyViolation> {
    if !read_only { return Ok(()); }
    let head = stmt.trim_start().to_ascii_uppercase();
    let head2: String = head.chars().take(64).collect();
    let first = head2.split_whitespace().next().unwrap_or("");
    let kind = match first {
        "DROP"     => Some(ReadOnlyViolationKind::Drop),
        "CREATE" | "ALTER" | "TRUNCATE" | "VACUUM" | "ATTACH" | "DETACH" =>
            Some(ReadOnlyViolationKind::DdlNonSelect),
        "INSERT" | "UPDATE" | "DELETE" =>
            Some(ReadOnlyViolationKind::Mutation),
        _ => None,
    };
    if let Some(k) = kind {
        return Err(ReadOnlyViolation {
            kind: k,
            statement: stmt.chars().take(120).collect(),
            hint: match k {
                ReadOnlyViolationKind::Drop       => "Open without read-only to drop tables.".to_string(),
                ReadOnlyViolationKind::DdlNonSelect => "DDL requires write connection.".to_string(),
                ReadOnlyViolationKind::Mutation   => "Mutation requires write connection.".to_string(),
            },
        });
    }
    Ok(())
}

pub fn quote_identifier(name: &str, d: SqlDialect) -> String {
    match d {
        SqlDialect::Sqlite | SqlDialect::Mysql => format!("`{}`", name.replace('`', "``")),
        SqlDialect::Postgres => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readonly_blocks_drop() {
        assert!(check_read_only("drop table users", true).is_err());
    }
    #[test]
    fn readonly_blocks_insert() {
        assert!(check_read_only("INSERT INTO users VALUES (1)", true).is_err());
    }
    #[test]
    fn readonly_blocks_update() {
        assert!(check_read_only("update users set name='x'", true).is_err());
    }
    #[test]
    fn readonly_blocks_create() {
        assert!(check_read_only("create table x(id int)", true).is_err());
    }
    #[test]
    fn readonly_allows_select() {
        assert!(check_read_only("select 1", true).is_ok());
    }
    #[test]
    fn readonly_off_allows_everything() {
        assert!(check_read_only("drop table a", false).is_ok());
    }
    #[test]
    fn readonly_off_blocks_nothing() {
        for s in ["select 1", "with x as (select 1) select * from x",
                  "insert into t values(1)", "delete from t", "update t set a=1"] {
            assert!(check_read_only(s, false).is_ok(), "{s} should pass when not readonly");
        }
    }
    #[test]
    fn readonly_blocks_truncate_vacuum() {
        assert!(check_read_only("truncate t", true).is_err());
        assert!(check_read_only("vacuum", true).is_err());
    }
    #[test]
    fn readonly_blocks_attach_detach() {
        assert!(check_read_only("attach database 'x.db' as aux", true).is_err());
        assert!(check_read_only("detach database aux", true).is_err());
    }
    #[test]
    fn classifier_recognizes_with() {
        assert!(check_read_only("WITH x AS (SELECT 1) SELECT * FROM x", true).is_ok());
    }
}
```

### 2.4 Statement Splitter 行为表（共享）

`src/vs/workbench/contrib/sqlEditor/common/sqlStatementSplitter.test.ts`：

```ts
// (test file content, 见 §3.1)
```

### 2.5 Execution Controller

`src/vs/workbench/contrib/sqlEditor/browser/sqlEditorExecutionController.ts`：

```ts
// src/vs/workbench/contrib/sqlEditor/browser/sqlEditorExecutionController.ts (Phase 03)
import { Disposable } from 'vs/base/common/lifecycle';
import { Emitter } from 'vs/base/common/event';
import { SqlEditorInput } from 'vs/workbench/contrib/sqlEditor/browser/sqlEditorInput';
import { ISqlQueryService, QueryExecutionRequest, QueryExecutionResult } from 'vs/workbench/services/sql/common/sqlQuery';
import { currentStatement, splitStatements, SqlStatementKind } from 'vs/workbench/contrib/sqlEditor/common/sqlStatementSplitter';

export type ExecScope = 'all' | 'selection' | 'current';
export type ExecState = 'idle' | 'running' | 'success' | 'error';

export interface ExecEvent {
    state: ExecState;
    statement?: string;
    error?: { code: string; message: string };
    elapsedMs?: number;
    resultId?: string;
}

export class SqlEditorExecutionController extends Disposable {
    declare readonly _brand: 'SqlEditorExecutionController';

    private readonly _onDidEmit = this._register(new Emitter<ExecEvent>());
    readonly onDidEmit = this._onDidEmit.event;

    private state: ExecState = 'idle';

    constructor(
        private readonly editor: SqlEditorInput,
        private readonly query: ISqlQueryService,
        private readonly getActiveText: () => string,
        private readonly getSelectionOrCursorOffset: () => { text: string; offset: number },
    ) {
        super();
    }

    async run(scope: ExecScope): Promise<void> {
        const connectionId = this.editor.state.connectionId;
        if (!connectionId) {
            this.emit({ state: 'error', error: { code: 'no_connection', message: 'No connection bound.' } });
            return;
        }
        if (this.state === 'running') {
            this.emit({ state: 'error', error: { code: 'busy', message: 'Already running.' } });
            return;
        }

        const text = this.getActiveText();
        const { text: selectionOrCursor, offset } = this.getSelectionOrCursorOffset();
        const stmts = (() => {
            switch (scope) {
                case 'all':       return splitStatements(text);
                case 'selection': return splitStatements(selectionOrCursor);
                case 'current':   return currentStatement(text, offset)
                                      ? [currentStatement(text, offset)!] : [];
            }
        })();

        if (stmts.length === 0) {
            this.emit({ state: 'error', error: { code: 'empty', message: 'No SQL statement to execute.' } });
            return;
        }

        for (const stmt of stmts) {
            await this.runOne(connectionId, stmt.text);
            if (this.state === 'error') break;
        }
    }

    cancel(): void {
        this.query.cancel(this.editor.state.connectionId ?? '', this.currentRequestId ?? '');
        this.state = 'idle';
        this.emit({ state: 'idle' });
    }

    private currentRequestId: string | undefined;

    private async runOne(connectionId: string, statement: string): Promise<void> {
        this.state = 'running';
        this.emit({ state: 'running', statement });
        const t0 = Date.now();
        const req: QueryExecutionRequest = {
            connectionId,
            statement,
            scope: 'current',
            readOnly: false,
            requestId: makeId(),
        };
        this.currentRequestId = req.requestId;
        try {
            const r = await this.query.execute(req);
            this.state = 'success';
            this.emit({
                state: 'success',
                statement,
                elapsedMs: r.elapsedMs ?? (Date.now() - t0),
                resultId: r.resultId,
            });
        } catch (e: any) {
            this.state = 'error';
            this.emit({ state: 'error', error: { code: e?.code ?? 'sql_error', message: e?.message ?? 'failed' } });
        }
        this.currentRequestId = undefined;
    }

    private emit(p: ExecEvent) { this._onDidEmit.fire(p); }
}

function makeId() { return Math.random().toString(36).slice(2); }
```

### 2.6 Query Service 接口与实现

`src/vs/workbench/services/sql/common/sqlQuery.ts`：

```ts
// src/vs/workbench/services/sql/common/sqlQuery.ts (Phase 03)
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';

export interface QueryExecutionRequest {
    connectionId: string;
    statement: string;
    scope: 'all' | 'selection' | 'current';
    readOnly: boolean;
    requestId: string;
}

export interface QueryExecutionResult {
    connectionId: string;
    requestId: string;
    elapsedMs: number;
    rowsAffected?: number;
    resultId: string;
}

export const ISqlQueryService =
    createDecorator<ISqlQueryService>('sqlQueryService');

export interface ISqlQueryService {
    readonly _serviceBrand: undefined;
    execute(req: QueryExecutionRequest): Promise<QueryExecutionResult>;
    cancel(connectionId: string, requestId: string): Promise<void>;
}
```

`src/vs/workbench/services/sql/browser/sqlQueryService.ts`：

```ts
// src/vs/workbench/services/sql/browser/sqlQueryService.ts (Phase 03)
import { Disposable } from 'vs/base/common/lifecycle';
import {
    ISqlQueryService, QueryExecutionRequest, QueryExecutionResult,
} from 'vs/workbench/services/sql/common/sqlQuery';
import { SqlCommandExecutor } from 'vs/workbench/services/sql/browser/sqlCommandExecutor';

export class SqlQueryService extends Disposable implements ISqlQueryService {
    declare readonly _serviceBrand: undefined;

    constructor(
        @SqlCommandExecutor private readonly executor: SqlCommandExecutor,
    ) {
        super();
    }

    async execute(req: QueryExecutionRequest): Promise<QueryExecutionResult> {
        return this.executor.invoke<QueryExecutionResult>('sql_execute_query', { req });
    }
    async cancel(connectionId: string, requestId: string): Promise<void> {
        await this.executor.invokeVoid('sql_cancel_query', { connectionId, requestId });
    }
}
```

### 2.7 Keybindings

`src/vs/workbench/contrib/sqlEditor/browser/sql.editor.commands.ts`：

```ts
// src/vs/workbench/contrib/sqlEditor/browser/sql.editor.commands.ts (Phase 03)
import { KeyMod, KeyCode } from 'vs/base/common/keyCodes';
import { EditorExtensions } from 'vs/workbench/browser/editor';
import { MenuId, MenuRegistry, registerAction } from 'vs/platform/actions/common/actions';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { ISqlEditorInput } from 'vs/workbench/contrib/sqlEditor/common/interfaces';

export function registerSqlEditorCommands() {
    registerAction({
        id: 'sql.executeCurrent', title: 'Execute Current Statement',
        keybinding: { primary: KeyMod.CtrlCmd | KeyCode.Enter },
        menu: { id: MenuId.CommandPalette },
        run: async (accessor) => {
            const ctrl = accessor.get(ISqlEditorInput).activeController();
            await ctrl?.run('current');
        },
    });
    registerAction({
        id: 'sql.executeSelection', title: 'Execute Selection',
        keybinding: { primary: KeyMod.Shift | KeyCode.Enter },
        menu: { id: MenuId.CommandPalette },
        run: async (accessor) => {
            const ctrl = accessor.get(ISqlEditorInput).activeController();
            await ctrl?.run('selection');
        },
    });
    registerAction({
        id: 'sql.executeAll', title: 'Execute All',
        menu: { id: MenuId.CommandPalette },
        run: async (accessor) => {
            const ctrl = accessor.get(ISqlEditorInput).activeController();
            await ctrl?.run('all');
        },
    });
    registerAction({
        id: 'sql.cancel', title: 'Cancel Query',
        menu: { id: MenuId.CommandPalette },
        run: async (accessor) => {
            const ctrl = accessor.get(ISqlEditorInput).activeController();
            ctrl?.cancel();
        },
    });
}
```

### 2.8 文件清单

新增：

```txt
src/vs/workbench/contrib/sqlEditor/browser/sqlEditorInput.ts                    (见 §2.1)
src/vs/workbench/contrib/sqlEditor/common/sqlStatementSplitter.ts              (见 §2.2)
src/vs/workbench/contrib/sqlEditor/browser/sqlEditorExecutionController.ts     (见 §2.5)
src/vs/workbench/contrib/sqlEditor/browser/sql.editor.commands.ts              (见 §2.7)
src/vs/workbench/services/sql/common/sqlQuery.ts                              (见 §2.6)
src/vs/workbench/services/sql/browser/sqlQueryService.ts                      (见 §2.6)
src/vs/workbench/contrib/sqlEditor/test/sqlEditor.test.ts
src/vs/workbench/contrib/sqlEditor/test/sqlEditorModel.test.ts
src/vs/workbench/contrib/sqlEditor/test/sqlEditorExecutionController.test.ts
src/vs/workbench/contrib/sqlEditor/test/sqlEditorDraftService.test.ts
src/vs/workbench/services/sql/test/sqlQueryService.test.ts
src-tauri/src/commands/sql/dialect.rs                                          (见 §2.3)
src-tauri/src/commands/sql/execution.rs                                       (sql_execute_query & sql_cancel_query)
docs/sql-mvp-phases/phase-03-editor-execution.md                                (本文件)
```

修改：

```txt
src-tauri/src/commands/sql/mod.rs            (+注册 sql_execute_query / sql_cancel_query)
src-tauri/src/commands/sql/state.rs          (暴露 with_conn 给元数据 + 查询)
src-tauri/src/commands/sql/query.rs           (继续执行 + 取消)
src/vs/workbench/services/sql/browser/sqlService.contribution.ts  (+ISqlQueryService 注册)
src/vs/workbench/contrib/sqlEditor/browser/sqlEditor.contribution.ts (+commands/keybindings 注册)
```

## 3. 单元测试完整代码

### 3.1 Rust dialect tests

`src-tauri/src/commands/sql/dialect.rs`（已在 §2.3）。10 个测试覆盖：drop/insert/update/create/select/multi-statement all-pass/truncate/vacuum/attach/detach/with。

### 3.2 SqlStatementSplitter test

```ts
// src/vs/workbench/contrib/sqlEditor/test/sqlEditor.test.ts (Phase 03)
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitStatements, currentStatement, classify } from 'vs/workbench/contrib/sqlEditor/common/sqlStatementSplitter';

test('split single select', () => {
    const s = splitStatements('SELECT 1');
    assert.equal(s.length, 1);
    assert.equal(s[0].text, 'SELECT 1');
    assert.equal(s[0].kind, 'select');
});

test('split multiple statements by ;', () => {
    const s = splitStatements('SELECT 1; SELECT 2;');
    assert.equal(s.length, 2);
});

test('split does not break on string literal with ;', () => {
    const s = splitStatements(`SELECT 'a;b' AS x; SELECT 1`);
    assert.equal(s.length, 2);
    assert.match(s[0].text, /'a;b'/);
});

test('split keeps line comments inside statement', () => {
    const s = splitStatements('-- hi\nSELECT 1;');
    assert.equal(s.length, 1);
    assert.match(s[0].text, /^-- hi/);
});

test('split keeps block comments inside statement', () => {
    const s = splitStatements('/* x;y */ SELECT 1;');
    assert.equal(s.length, 1);
    assert.match(s[0].text, /\/\* x;y \*\//);
});

test('split empty input yields no statements', () => {
    assert.deepEqual(splitStatements(''), []);
});

test('split only-whitespace yields no statements', () => {
    assert.deepEqual(splitStatements('   \n\n  '), []);
});

test('currentStatement picks the one at offset', () => {
    const s = currentStatement('SELECT 1; SELECT 2; SELECT 3', 12);
    assert.equal(s?.text, 'SELECT 2');
});

test('currentStatement at end picks last', () => {
    const s = currentStatement('SELECT 1; SELECT 2', 14);
    assert.equal(s?.text, 'SELECT 2');
});

test('classify detects common kinds', () => {
    for (const [sql, kind] of [
        ['select 1', 'select'],
        ['with x as (select 1) select * from x', 'select'],
        ['insert into t values(1)', 'insert'],
        ['update t set a=1', 'update'],
        ['delete from t', 'delete'],
        ['drop table t', 'ddl'],
        ['create table t(x int)', 'ddl'],
        ['alter table t add column y int', 'ddl'],
        ['begin', 'tx'],
        ['commit', 'tx'],
        ['rollback', 'tx'],
        ['pragma table_info(t)', 'pragma'],
    ] as const) {
        assert.equal(classify(sql), kind, `classify ${sql}`);
    }
});
```

### 3.3 Execution Controller test

```ts
// src/vs/workbench/contrib/sqlEditor/test/sqlEditorExecutionController.test.ts (Phase 03)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlEditorExecutionController } from 'vs/workbench/contrib/sqlEditor/browser/sqlEditorExecutionController';
import { SqlEditorInput } from 'vs/workbench/contrib/sqlEditor/browser/sqlEditorInput';
import { URI } from 'vs/base/common/uri';

class FakeQuery {
    log: any[] = [];
    cancelLog: any[] = [];
    async execute(req: any) {
        this.log.push(req);
        if (req.statement === 'BAD SQL') throw { code: 'sql_error', message: 'parse error' };
        return { connectionId: req.connectionId, requestId: req.requestId,
                 elapsedMs: 5, rowsAffected: 0, resultId: 'rid-' + this.log.length };
    }
    async cancel(c: string, r: string) { this.cancelLog.push({ c, r }); }
}

function ctrl(q: FakeQuery, getText = () => 'SELECT 1', getSel = () => ({ text: 'SELECT 1', offset: 0 }), conn = 'a') {
    const input = new SqlEditorInput(URI.parse('inmemory://sql/test.sql'),
        { connectionId: conn, draft: 'SELECT 1', dirty: false, lastSavedAtMs: 0 });
    const c = new SqlEditorExecutionController(input, q as any, getText, getSel);
    return { input, c };
}

test('run all issues single statement execute', async () => {
    const q = new FakeQuery();
    const { c } = ctrl(q, () => 'SELECT 1');
    const events: string[] = [];
    c.onDidEmit((e) => events.push(e.state));
    await c.run('all');
    assert.equal(q.log.length, 1);
    assert.deepEqual(events, ['running', 'success']);
});

test('run selection executes only selected text', async () => {
    const q = new FakeQuery();
    const { c } = ctrl(q,
        () => 'SELECT 1; SELECT 2',
        () => ({ text: 'SELECT 2', offset: 0 }));
    await c.run('selection');
    assert.equal(q.log.length, 1);
    assert.equal(q.log[0].statement, 'SELECT 2');
});

test('run current picks by offset', async () => {
    const q = new FakeQuery();
    const { c } = ctrl(q,
        () => 'SELECT 1; SELECT 2',
        () => ({ text: '', offset: 10 }));
    await c.run('current');
    assert.equal(q.log[0].statement, 'SELECT 2');
});

test('run with no connection emits error', async () => {
    const q = new FakeQuery();
    const { c } = ctrl(q, () => 'SELECT 1', () => ({ text: '', offset: 0 }), '');
    const events: any[] = [];
    c.onDidEmit((e) => events.push(e));
    await c.run('all');
    assert.equal(events[1].state, 'error');
    assert.equal(q.log.length, 0);
});

test('error stops multi statement loop', async () => {
    const q = new FakeQuery();
    const { c } = ctrl(q, () => 'SELECT 1; BAD SQL; SELECT 3');
    const seen: string[] = [];
    c.onDidEmit((e) => { if (e.state === 'success' || e.state === 'error') seen.push(e.state); });
    await c.run('all');
    assert.deepEqual(seen, ['success', 'error']);
});

test('cancel after running invokes backend cancel', async () => {
    const q = new FakeQuery();
    let resolveExec: any;
    q.execute = (req: any) => new Promise<any>((r) => { resolveExec = () => r({
        connectionId: req.connectionId, requestId: req.requestId,
        elapsedMs: 1, rowsAffected: 0, resultId: 'r' }); });
    const { c } = ctrl(q);
    const p = c.run('all');
    c.cancel();
    resolveExec();
    await p;
    assert.equal(q.cancelLog.length, 1);
});

test('busy returns error without invoking execute', async () => {
    let resolveExec: any;
    const q = new FakeQuery();
    q.execute = () => new Promise((r) => { resolveExec = r; });
    const { c } = ctrl(q);
    const p1 = c.run('all');
    const evs: string[] = [];
    const sub = c.onDidEmit((e) => evs.push(e.state));
    await c.run('all');
    assert.equal(evs[1], 'error');
    resolveExec();
    await p1;
    sub.dispose();
});
```

### 3.4 Editor model + draft

```ts
// src/vs/workbench/contrib/sqlEditor/test/sqlEditorModel.test.ts (Phase 03)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlEditorInput } from 'vs/workbench/contrib/sqlEditor/browser/sqlEditorInput';
import { URI } from 'vs/base/common/uri';

test('input initializes state with defaults', () => {
    const i = new SqlEditorInput(URI.parse('inmemory://sql/test.sql'));
    assert.equal(i.state.connectionId, null);
    assert.equal(i.state.draft, '');
    assert.equal(i.state.dirty, false);
});

test('bindConnection sets connection and marks dirty', () => {
    const i = new SqlEditorInput(URI.parse('inmemory://sql/test.sql'));
    let dirty = 0, label = 0;
    i.onDidChangeDirty(() => dirty++);
    i.onDidChangeLabel(() => label++);
    i.bindConnection('a');
    assert.equal(i.state.connectionId, 'a');
    assert.equal(i.state.dirty, true);
    assert.ok(dirty >= 1);
    assert.ok(label >= 1);
});

test('setDraft marks dirty exactly once per change', () => {
    const i = new SqlEditorInput(URI.parse('inmemory://sql/test.sql'));
    let dirty = 0;
    i.onDidChangeDirty(() => dirty++);
    i.setDraft('SELECT 1', true);
    assert.equal(i.state.draft, 'SELECT 1');
    assert.equal(dirty, 1);
    i.setDraft('SELECT 1', false);
    assert.equal(dirty, 1, 'no extra dirty fires if not marked');
});

test('id and typeId are stable', () => {
    const a = new SqlEditorInput(URI.parse('inmemory://sql/a.sql'));
    const b = new SqlEditorInput(URI.parse('inmemory://sql/b.sql'));
    assert.equal(a.typeId, b.typeId);
    assert.equal(a.typeId, SqlEditorInput.ID);
});

test('clears connection when bound to null', () => {
    const i = new SqlEditorInput(URI.parse('inmemory://sql/a.sql'),
        { connectionId: 'a', draft: 'SELECT 1', dirty: false, lastSavedAtMs: 1 });
    i.bindConnection(null);
    assert.equal(i.state.connectionId, null);
    assert.equal(i.state.draft, 'SELECT 1');
});
```

### 3.5 Draft Service

```ts
// src/vs/workbench/contrib/sqlEditor/test/sqlEditorDraftService.test.ts (Phase 03)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlEditorDraftService } from 'vs/workbench/contrib/sqlEditor/browser/sqlEditorDraftService';

test('save and load draft returns prior content', async () => {
    const storage = new Map<string, string>();
    const svc = new SqlEditorDraftService({
        async read(key) { return storage.get(key); },
        async write(key, value) { storage.set(key, value); },
    });
    await svc.save('id-1', 'SELECT 1');
    assert.equal(await svc.load('id-1'), 'SELECT 1');
});

test('clear removes draft', async () => {
    const storage = new Map<string, string>();
    const svc = new SqlEditorDraftService({
        async read(key) { return storage.get(key); },
        async write(key, value) { storage.set(key, value); },
        async remove(key) { storage.delete(key); },
    });
    await svc.save('id-2', 'SELECT 2');
    await svc.clear('id-2');
    assert.equal(await svc.load('id-2'), null);
});

test('missing draft returns null not undefined', async () => {
    const svc = new SqlEditorDraftService({
        async read() { return undefined; },
        async write() {},
    });
    assert.equal(await svc.load('nope'), null);
});
```

### 3.6 Service-level query tests

```ts
// src/vs/workbench/services/sql/test/sqlQueryService.test.ts (Phase 03)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlQueryService } from 'vs/workbench/services/sql/browser/sqlQueryService';

class FakeExecutor {
    log: any[] = [];
    async invoke<T>(cmd: string, payload: any): Promise<T> {
        this.log.push({ cmd, payload });
        return { connectionId: payload.req.connectionId, requestId: payload.req.requestId,
                 elapsedMs: 1, rowsAffected: 0, resultId: 'r' } as any;
    }
    async invokeVoid(cmd: string, payload: any) { this.log.push({ cmd, payload }); }
}

test('execute forwards request to backend', async () => {
    const f = new FakeExecutor();
    const svc = new SqlQueryService(f as any);
    await svc.execute({ connectionId: 'a', statement: 'SELECT 1',
                         scope: 'current', readOnly: false, requestId: 'r1' });
    assert.equal(f.log[0].cmd, 'sql_execute_query');
});

test('cancel invokes sql_cancel_query', async () => {
    const f = new FakeExecutor();
    const svc = new SqlQueryService(f as any);
    await svc.cancel('a', 'r1');
    assert.equal(f.log[0].cmd, 'sql_cancel_query');
    assert.equal(f.log[0].payload.connectionId, 'a');
});
```

## 4. 验收

- [ ] `cargo test dialect` 11/11 通过。
- [ ] `pnpm run test:sql-editor` 通过（包含 §3.2 / §3.3 / §3.4 / §3.5）。
- [ ] `pnpm run test:sql-services` 包含 §3.6 通过。
- [ ] UI 行为：
  - 打开 SQL editor tab，连接选择 SQLite；
  - 写 `SELECT 1`，Ctrl+Enter，结果在 panel；
  - 选 `SELECT 2`，Shift+Enter，结果在 panel；
  - 写 `DROP TABLE x`，read-only connection 时被拦截，editor 红色错误；
  - 当前光标在第二个语句，按 Ctrl+Enter，只执行第二个。

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| Statement splitter 不识别方言注释 | MVP 仅支持 `--` 与 `/* */`；方言注释 (`#` 等) 在后续 Phase 09。 |
| Multiple statement 中途报错 | 已用 "error stops loop" 行为，避免 half-baked result。 |
| Cancel 弱类型 | `requestId` 强制 unique；UI 在 run() 内部持有 currentRequestId；后端若不存在则忽略。 |
| Read-only mode 不阻挡 `PRAGMA` | SQLite `PRAGMA` 在 query_only 下是安全的；其它 DDL/INSERT/UPDATE/DELETE 全部拦截。 |

## 6. 与下游接口

- Phase 04：`SqlEditorExecutionController.emit('success', { resultId })` 触发 panel 渲染。
- Phase 05：history service 监听 `success` / `error` event 写入 history。
- Phase 06：AI context builder 读取当前 editor text + 最近一次 `running/success/error` 状态。

## 7. DoD

- 真有 all / selection / current 三种执行模式；
- 真有 read-only guard 在 dialects 层；
- 真有多语句错即停；
- 真有 Ctrl+Enter / Shift+Enter 绑定；
- 真有 controller 没有 UI 直连 `@tauri-apps/api/core`。
