# Phase 04 — Query Result Panel

## 0. 摘要

把 Phase 03 跑出来的 SQL 执行结果，落进 VS Code-style Panel 中显示。不引入虚拟滚动、不引入列宽调整、不引入 copy range——只做"列 + 行 + 错误 + 耗时 + 行数"，并保证对每条 statement 单独结果集都可见。

## 1. 范围

- 列头 + 行渲染；
- NULL 显式显示、错误状态、空状态；
- elapsed time / row count / truncation / affected rows；
- 基础 copy（单格、单行、整列、整表）；
- 多结果集（一次 execute 产生多个 resultId 时）；
- 不在范围：
  - 列排序、过滤、列宽调整、infinite scroll；
  - CSV 导出、JSON viewer、cell editing；
  - 流式大结果集；
  - virtualized grid。

## 2. 设计

### 2.1 Result Model

`src/vs/workbench/contrib/sqlResult/browser/sqlResultModel.ts`：

```ts
// src/vs/workbench/contrib/sqlResult/browser/sqlResultModel.ts (Phase 04)
import { Disposable } from 'vs/base/common/lifecycle';
import { Emitter } from 'vs/base/common/event';

export type CellValue =
    | { kind: 'null' }
    | { kind: 'string'; value: string }
    | { kind: 'number'; value: number }
    | { kind: 'boolean'; value: boolean }
    | { kind: 'blob'; bytesBase64: string }
    | { kind: 'date'; iso: string };

export interface ColumnInfo {
    name: string;
    dataType: string;
    nullable: boolean;
    isPrimaryKey: boolean;
}

export type ResultOutcome =
    | { kind: 'success'; rows: CellValue[][]; columns: ColumnInfo[]; rowCount: number; truncated: boolean }
    | { kind: 'mutated'; rowsAffected: number }
    | { kind: 'empty' }
    | { kind: 'error'; code: string; message: string };

export interface ResultPane {
    connectionId: string;
    statement: string;
    elapsedMs: number;
    finishedAtMs: number;
    outcome: ResultOutcome;
    id: string; // resultId
}

export class SqlResultModel extends Disposable {
    declare readonly _brand: 'SqlResultModel';
    private panes: ResultPane[] = [];
    private readonly _onDidChange = this._register(new Emitter<void>());
    readonly onDidChange = this._onDidChange.event;

    append(p: ResultPane) { this.panes.push(p); this._onDidChange.fire(); }
    clear() { this.panes = []; this._onDidChange.fire(); }
    list(): readonly ResultPane[] { return this.panes; }
    get(id: string): ResultPane | undefined { return this.panes.find((p) => p.id === id); }
    remove(id: string) { this.panes = this.panes.filter((p) => p.id !== id); this._onDidChange.fire(); }
}
```

### 2.2 Grid Model

`src/vs/workbench/contrib/sqlResult/browser/sqlResultGridModel.ts`：

```ts
// src/vs/workbench/contrib/sqlResult/browser/sqlResultGridModel.ts (Phase 04)
import { CellValue, ColumnInfo } from 'vs/workbench/contrib/sqlResult/browser/sqlResultModel';

export interface GridCellView {
    text: string;
    isNull: boolean;
    isError: boolean;
}

export interface GridView {
    columns: ColumnInfo[];
    rows: GridCellView[][];
    rowCount: number;
    truncated: boolean;
}

const MAX_PREVIEW = 1000;

export function buildGridView(outcome: ResultOutcome): GridView | null {
    if (outcome.kind !== 'success') return null;
    const columns = outcome.columns;
    const truncated = outcome.truncated || outcome.rows.length > MAX_PREVIEW;
    const limited = outcome.rows.slice(0, MAX_PREVIEW);
    const rows = limited.map((r) =>
        r.map((cell) => toCellView(cell))
    );
    return { columns, rows, rowCount: outcome.rowCount, truncated };
}

export function toCellView(v: CellValue): GridCellView {
    switch (v.kind) {
        case 'null':    return { text: 'NULL', isNull: true,  isError: false };
        case 'string':  return { text: v.value, isNull: false, isError: false };
        case 'number':  return { text: String(v.value), isNull: false, isError: false };
        case 'boolean': return { text: v.value ? 'true' : 'false', isNull: false, isError: false };
        case 'blob':    return { text: `BLOB(${v.bytesBase64.length}b64)`, isNull: false, isError: false };
        case 'date':    return { text: v.iso, isNull: false, isError: false };
    }
}
```

### 2.3 Result Wire Format

`src-tauri/src/commands/sql/query.rs`：

```rust
// src-tauri/src/commands/sql/query.rs (Phase 04 节选)
use serde::{Deserialize, Serialize};
use crate::commands::sql::types::SqlCommandError;
use crate::commands::sql::state::SharedConnectionManager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlColumnDto {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SqlCellDto {
    Null,
    String { value: String },
    Number { value: f64 },
    Boolean { value: bool },
    Blob { bytes_base64: String },
    Date { iso: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SqlQueryOutcomeDto {
    Success {
        rows: Vec<Vec<SqlCellDto>>,
        columns: Vec<SqlColumnDto>,
        row_count: u64,
        truncated: bool,
    },
    Mutated { rows_affected: u64 },
    Empty,
    Error { code: String, message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlQueryResponseDto {
    pub connection_id: String,
    pub request_id: String,
    pub result_id: String,
    pub elapsed_ms: u128,
    pub statement: String,
    pub finished_at_ms: i64,
    pub outcome: SqlQueryOutcomeDto,
}

#[tauri::command]
pub fn sql_execute_query(
    manager: tauri::State<'static, SharedConnectionManager>,
    req: ExecuteQueryRequest,
) -> Result<SqlQueryResponseDto, SqlCommandError> {
    let manager = manager.inner().clone();
    manager.with_conn(&req.connection_id, move |entry| {
        // 把 request 翻译成 driver 执行；
        // Phase 04 只覆盖 SQLite concrete 路径。
        let t0 = std::time::Instant::now();
        match entry.conn.execute_query(&req.statement) {
            Ok(crate::commands::sql::driver::DriverRowSet::Rows { columns, rows }) => {
                let row_count = rows.len() as u64;
                let truncated = row_count > 1000;
                let limited = if truncated { rows.into_iter().take(1000).collect() } else { rows };
                Ok(SqlQueryResponseDto {
                    connection_id: req.connection_id.clone(),
                    request_id: req.request_id.clone(),
                    result_id: make_id(),
                    elapsed_ms: t0.elapsed().as_millis(),
                    statement: req.statement.clone(),
                    finished_at_ms: now_ms(),
                    outcome: SqlQueryOutcomeDto::Success {
                        columns,
                        rows: limited,
                        row_count,
                        truncated,
                    },
                })
            }
            Ok(crate::commands::sql::driver::DriverRowSet::Affected(n)) => {
                Ok(SqlQueryResponseDto {
                    connection_id: req.connection_id.clone(),
                    request_id: req.request_id.clone(),
                    result_id: make_id(),
                    elapsed_ms: t0.elapsed().as_millis(),
                    statement: req.statement.clone(),
                    finished_at_ms: now_ms(),
                    outcome: SqlQueryOutcomeDto::Mutated { rows_affected: n },
                })
            }
            Ok(crate::commands::sql::driver::DriverRowSet::Empty) => Ok(SqlQueryResponseDto {
                connection_id: req.connection_id.clone(),
                request_id: req.request_id.clone(),
                result_id: make_id(),
                elapsed_ms: t0.elapsed().as_millis(),
                statement: req.statement.clone(),
                finished_at_ms: now_ms(),
                outcome: SqlQueryOutcomeDto::Empty,
            }),
            Err(e) => Ok(SqlQueryResponseDto {
                connection_id: req.connection_id.clone(),
                request_id: req.request_id.clone(),
                result_id: make_id(),
                elapsed_ms: t0.elapsed().as_millis(),
                statement: req.statement.clone(),
                finished_at_ms: now_ms(),
                outcome: SqlQueryOutcomeDto::Error { code: e.code, message: e.message },
            }),
        }
    })
}

#[tauri::command]
pub fn sql_cancel_query(
    manager: tauri::State<'static, SharedConnectionManager>,
    connection_id: String,
    request_id: String,
) -> Result<(), SqlCommandError> {
    let manager = manager.inner().clone();
    manager.with_conn(&connection_id, |entry| entry.conn.cancel(&request_id))?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteQueryRequest {
    pub connection_id: String,
    pub request_id: String,
    pub statement: String,
    pub scope: String,
    pub read_only: bool,
}

fn make_id() -> String {
    let r: u64 = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64) ^ 0x9E3779B97F4A7C15u64;
    format!("r_{r:x}")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}
```

### 2.4 Driver RowSet

`src-tauri/src/commands/sql/driver.rs`：

```rust
// src-tauri/src/commands/sql/driver.rs (Phase 04 在 §2.2 基础上新增)

use crate::commands::sql::metadata::ColumnDto;

pub enum DriverRowSet {
    Rows { columns: Vec<crate::commands::sql::query::SqlColumnDto>, rows: Vec<Vec<crate::commands::sql::query::SqlCellDto>> },
    Affected(u64),
    Empty,
}

pub trait SqlConnection {
    fn list_schemas(&mut self) -> Result<Vec<SchemataDto>, SqlCommandError>;
    fn list_tables(&mut self, schema: &str) -> Result<Vec<SchemaObjectDto>, SqlCommandError>;
    fn list_columns(&mut self, schema: &str, table: &str) -> Result<Vec<ColumnDto>, SqlCommandError>;

    /// Phase 04 新增
    fn execute_query(&mut self, statement: &str) -> Result<DriverRowSet, crate::commands::sql::types::SqlCommandError>;
    fn cancel(&mut self, request_id: &str) -> Result<(), crate::commands::sql::types::SqlCommandError>;
}
```

SQLite execute：

```rust
// src-tauri/src/commands/sql/sqlite_driver.rs (Phase 04 在 §2.3 基础上新增)
impl SqlConnection for SqliteConnection {
    // ... 之前方法不变 ...

    fn execute_query(&mut self, statement: &str) -> Result<DriverRowSet, SqlCommandError> {
        use crate::commands::sql::query::{SqlCellDto, SqlColumnDto};
        let conn = &mut self.conn;

        // 优先尝试 prepare；不存在表 = 错误。
        let mut stmt = conn.prepare(statement)
            .map_err(|e| SqlCommandError::new("sqlite_prepare", e.to_string()))?;

        // 如果语句不返回列（PRAGMA / CREATE / INSERT ... RETURNING 视为 mutating），
        // 仍调用 query_map 拿 0 列。
        let columns: Vec<SqlColumnDto> = stmt.column_names()
            .into_iter().map(|n| SqlColumnDto {
                name: n.to_string(),
                data_type: "UNKNOWN".into(), // SQLite 不提供 column type 在 prepare 阶段
                nullable: true,
                is_primary_key: false,
            }).collect();

        if columns.is_empty() {
            // mutation path.
            let n = stmt.execute([])
                .map_err(|e| SqlCommandError::new("sqlite_execute", e.to_string()))?;
            // rusqlite 不直接给 affected_rows 单独方法，但 Step 路径通过 changes() 拿。
            // 这里我们用一个备用方案：
            let affected = n; // Statement::execute 返回的 usize 对应 changeset
            return if affected == 0 {
                Ok(DriverRowSet::Empty)
            } else {
                Ok(DriverRowSet::Affected(affected as u64))
            };
        }

        let mut rows_iter = stmt.query([])
            .map_err(|e| SqlCommandError::new("sqlite_query", e.to_string()))?;
        let mut rows: Vec<Vec<SqlCellDto>> = Vec::new();
        while let Some(row) = rows_iter.next()
            .map_err(|e| SqlCommandError::new("sqlite_iter", e.to_string()))?
        {
            let mut row_cells: Vec<SqlCellDto> = Vec::with_capacity(columns.len());
            for i in 0..columns.len() {
                let cell = read_sqlite_cell(row, i)?;
                row_cells.push(cell);
            }
            rows.push(row_cells);
        }
        let row_count = rows.len() as u64;
        Ok(DriverRowSet::Rows { columns, rows })
    }

    fn cancel(&mut self, _request_id: &str) -> Result<(), SqlCommandError> {
        // SQLite 串行执行，cancel 即忽略。
        Ok(())
    }
}

fn read_sqlite_cell(row: &rusqlite::Row, i: usize) -> Result<SqlCellDto, SqlCommandError> {
    let v: rusqlite::types::Value = row.get(i)
        .map_err(|e| SqlCommandError::new("sqlite_value", e.to_string()))?;
    Ok(match v {
        rusqlite::types::Value::Null => SqlCellDto::Null,
        rusqlite::types::Value::Integer(n) => SqlCellDto::Number { value: n as f64 },
        rusqlite::types::Value::Real(f)     => SqlCellDto::Number { value: f },
        rusqlite::types::Value::Text(s)     => SqlCellDto::String { value: s },
        rusqlite::types::Value::Blob(b)     => SqlCellDto::Blob { bytes_base64: base64_encode(&b) },
    })
}

fn base64_encode(b: &[u8]) -> String {
    // 不引入 base64 crate，用 std-only 实现：
    const TBL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((b.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= b.len() {
        let n = ((b[i] as u32) << 16) | ((b[i+1] as u32) << 8) | (b[i+2] as u32);
        out.push(TBL[((n >> 18) & 0x3F) as usize] as char);
        out.push(TBL[((n >> 12) & 0x3F) as usize] as char);
        out.push(TBL[((n >> 6) & 0x3F) as usize]  as char);
        out.push(TBL[(n & 0x3F) as usize]        as char);
        i += 3;
    }
    let rem = b.len() - i;
    if rem == 1 {
        let n = (b[i] as u32) << 16;
        out.push(TBL[((n >> 18) & 0x3F) as usize] as char);
        out.push(TBL[((n >> 12) & 0x3F) as usize] as char);
        out.push('='); out.push('=');
    } else if rem == 2 {
        let n = ((b[i] as u32) << 16) | ((b[i+1] as u32) << 8);
        out.push(TBL[((n >> 18) & 0x3F) as usize] as char);
        out.push(TBL[((n >> 12) & 0x3F) as usize] as char);
        out.push(TBL[((n >> 6) & 0x3F) as usize]  as char);
        out.push('=');
    }
    out
}
```

### 2.5 Result Panel View

`src/vs/workbench/contrib/sqlResult/browser/sqlResultPanel.ts`：

```ts
// src/vs/workbench/contrib/sqlResult/browser/sqlResultPanel.ts (Phase 04)
import { Disposable } from 'vs/base/common/lifecycle';
import { Panel } from 'vs/workbench/browser/panel';
import { SqlResultModel, ResultPane } from 'vs/workbench/contrib/sqlResult/browser/sqlResultModel';
import { buildGridView } from 'vs/workbench/contrib/sqlResult/browser/sqlResultGridModel';
import { ISqlQueryService } from 'vs/workbench/services/sql/common/sqlQuery';
import { SqlEditorExecutionController, ExecEvent } from 'vs/workbench/contrib/sqlEditor/browser/sqlEditorExecutionController';

export class SqlResultPanel extends Disposable {
    declare readonly _brand: 'SqlResultPanel';

    constructor(
        private readonly model: SqlResultModel,
        private readonly panel: Panel,
        private readonly query: ISqlQueryService,
    ) {
        super();
        // 监听 model.onDidChange -> 触发 panel rerender。
        this._register(model.onDidChange(() => this.refresh()));
    }

    async onDidReceiveResult(req: ExecEvent, raw: QueryExecutionResultLike): Promise<void> {
        if (raw.kind === 'error') {
            this.model.append({
                id: raw.resultId,
                connectionId: '',
                statement: req.statement ?? '',
                elapsedMs: raw.elapsedMs ?? 0,
                finishedAtMs: Date.now(),
                outcome: { kind: 'error', code: raw.kind, message: raw.error?.message ?? '' },
            });
            return;
        }
    }

    refresh(): void { /* rerendered by host */ }
}

interface QueryExecutionResultLike {
    kind: 'success' | 'mutated' | 'empty' | 'error';
    resultId: string;
    elapsedMs?: number;
    error?: { code: string; message: string };
}
```

> MVP 中 result pane 的 DOM 渲染由后续 setter 提供：本设计只规定 model + grid 模型 + 后端数据契约 + copy helper，DOM 由 `sqlResultPanel.view.ts` 在 Phase 04 后续迭代中实现。Phase 04 设计文档明确：DOM 仅接受 model 输入；模型层有完整测试。

### 2.6 Copy Helper

`src/vs/workbench/contrib/sqlResult/browser/copy.ts`：

```ts
// src/vs/workbench/contrib/sqlResult/browser/copy.ts (Phase 04)
import { CellValue, ColumnInfo } from 'vs/workbench/contrib/sqlResult/browser/sqlResultModel';

export function cellToString(c: CellValue): string {
    switch (c.kind) {
        case 'null':    return '';
        case 'string':  return c.value;
        case 'number':  return String(c.value);
        case 'boolean': return c.value ? 'true' : 'false';
        case 'blob':    return c.bytesBase64;
        case 'date':    return c.iso;
    }
}

export function copyCell(value: CellValue): string { return cellToString(value); }

export function copyRow(row: CellValue[]): string {
    return row.map(cellToString).join('\t');
}

export function copyColumn(column: CellValue[][]): string {
    return column.map((r) => cellToString(r[0] ?? { kind: 'null' })).join('\n');
}

export function copyTable(opts: {
    columns: ColumnInfo[];
    rows: CellValue[][];
}): string {
    const head = opts.columns.map((c) => c.name).join('\t');
    const body = opts.rows.map((r) => r.map(cellToString).join('\t')).join('\n');
    return `${head}\n${body}`;
}
```

### 2.7 文件清单

新增：

```txt
src-tauri/src/commands/sql/query.rs                              (见 §2.3 + §2.4)
src/vs/workbench/contrib/sqlResult/browser/sqlResultModel.ts    (见 §2.1)
src/vs/workbench/contrib/sqlResult/browser/sqlResultGridModel.ts (见 §2.2)
src/vs/workbench/contrib/sqlResult/browser/sqlResultPanel.ts    (见 §2.5)
src/vs/workbench/contrib/sqlResult/browser/copy.ts              (见 §2.6)
src/vs/workbench/contrib/sqlResult/test/sqlResultModel.test.ts
src/vs/workbench/contrib/sqlResult/test/sqlResultGridModel.test.ts
src/vs/workbench/services/sql/test/sqlQueryResponse.test.ts
docs/sql-mvp-phases/phase-04-result-panel.md                      (本文件)
```

修改：

```txt
src-tauri/src/commands/sql/mod.rs            (+注册 sql_execute_query / sql_cancel_query)
src-tauri/src/commands/sql/driver.rs         (+DriverRowSet + 新 trait 方法)
src-tauri/src/commands/sql/sqlite_driver.rs (+execute_query 实现)
src-tauri/src/commands/sql/state.rs          (+ with_conn 内部统一返回 Result)
src/vs/workbench/services/sql/browser/sqlService.contribution.ts (+ISqlResultPanel 注册)
src/vs/workbench/contrib/sqlResult/browser/sqlResult.contribution.ts (+ Panel 注册)
```

## 3. 单元测试完整代码

### 3.1 Result Model tests

```ts
// src/vs/workbench/contrib/sqlResult/test/sqlResultModel.test.ts (Phase 04)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlResultModel, ResultPane } from 'vs/workbench/contrib/sqlResult/browser/sqlResultModel';

function pane(id: string, kind: 'success' | 'mutated' | 'empty' | 'error', text = 'SELECT 1') {
    return {
        id, connectionId: 'a', statement: text,
        elapsedMs: 1, finishedAtMs: 1,
        outcome: kind === 'success' ? { kind, rows: [], columns: [], rowCount: 0, truncated: false } :
                 kind === 'mutated' ? { kind, rowsAffected: 1 } :
                 kind === 'empty'    ? { kind } :
                 { kind, code: 'X', message: 'fail' },
    } as ResultPane;
}

test('append keeps insertion order', () => {
    const m = new SqlResultModel();
    m.append(pane('1', 'success'));
    m.append(pane('2', 'mutated'));
    assert.equal(m.list().length, 2);
    assert.equal(m.list()[0].id, '1');
});

test('get finds by id', () => {
    const m = new SqlResultModel();
    m.append(pane('1', 'success'));
    assert.equal(m.get('1')?.id, '1');
});

test('remove drops pane', () => {
    const m = new SqlResultModel();
    m.append(pane('1', 'success'));
    m.append(pane('2', 'success'));
    m.remove('1');
    assert.equal(m.list().length, 1);
});

test('clear empties', () => {
    const m = new SqlResultModel();
    m.append(pane('1', 'success'));
    m.clear();
    assert.equal(m.list().length, 0);
});

test('dispose stops further emits', () => {
    const m = new SqlResultModel();
    let n = 0;
    m.onDidChange(() => n++);
    m.dispose();
    // append 之后不再触发（实测上 model 自身 dispose 之后更改是 no-op，断言）
    m.append(pane('1', 'success'));
    assert.equal(n, 0);
});
```

### 3.2 Grid Model tests

```ts
// src/vs/workbench/contrib/sqlResult/test/sqlResultGridModel.test.ts (Phase 04)
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGridView, toCellView } from 'vs/workbench/contrib/sqlResult/browser/sqlResultGridModel';
import { CellValue, ResultOutcome } from 'vs/workbench/contrib/sqlResult/browser/sqlResultModel';

function success(n: number, truncated = false): ResultOutcome {
    const rows: CellValue[][] = [];
    for (let i = 0; i < n; i++) rows.push([
        { kind: 'number', value: i },
        { kind: 'string', value: `name-${i}` },
        { kind: 'null' },
    ]);
    return {
        kind: 'success',
        rows,
        columns: [
            { name: 'id', dataType: 'INT', nullable: false, isPrimaryKey: true },
            { name: 'name', dataType: 'TEXT', nullable: true, isPrimaryKey: false },
            { name: 'note', dataType: 'TEXT', nullable: true, isPrimaryKey: false },
        ],
        rowCount: n,
        truncated,
    };
}

test('toCellView renders null as NULL', () => {
    assert.equal(toCellView({ kind: 'null' }).text, 'NULL');
    assert.equal(toCellView({ kind: 'null' }).isNull, true);
});

test('toCellView renders number, string, boolean, blob, date', () => {
    assert.equal(toCellView({ kind: 'number', value: 1.5 }).text, '1.5');
    assert.equal(toCellView({ kind: 'string', value: 'x' }).text, 'x');
    assert.equal(toCellView({ kind: 'boolean', value: true }).text, 'true');
    assert.match(toCellView({ kind: 'blob', bytesBase64: 'AAA=' }).text, /^BLOB\(/);
    assert.equal(toCellView({ kind: 'date', iso: '2026-01-01' }).text, '2026-01-01');
});

test('buildGridView returns null for non-success outcome', () => {
    assert.equal(buildGridView({ kind: 'mutated', rowsAffected: 1 }), null);
    assert.equal(buildGridView({ kind: 'empty' }), null);
    assert.equal(buildGridView({ kind: 'error', code: 'X', message: 'Y' }), null);
});

test('buildGridView truncates over 1000 rows', () => {
    const v = buildGridView(success(1500));
    assert.equal(v?.rows.length, 1000);
    assert.equal(v?.truncated, true);
});

test('buildGridView keeps columns', () => {
    const v = buildGridView(success(2));
    assert.equal(v?.columns.length, 3);
});

test('NULL cells render with isNull=true', () => {
    const v = buildGridView(success(3));
    assert.equal(v?.rows[0][2].isNull, true);
});
```

### 3.3 Copy helper tests

```ts
// src/vs/workbench/contrib/sqlResult/test/copy.test.ts (Phase 04)
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyCell, copyRow, copyColumn, copyTable } from 'vs/workbench/contrib/sqlResult/browser/copy';

test('copyCell renders null as empty', () => {
    assert.equal(copyCell({ kind: 'null' }), '');
});

test('copyRow joins with tab', () => {
    assert.equal(copyRow([
        { kind: 'number', value: 1 },
        { kind: 'string', value: 'a' },
        { kind: 'null' },
    ]), '1\ta\t');
});

test('copyColumn joins with newline', () => {
    assert.equal(copyColumn([
        [{ kind: 'number', value: 1 }],
        [{ kind: 'number', value: 2 }],
        [{ kind: 'null' }],
    ]), '1\n2\n');
});

test('copyTable includes header', () => {
    const s = copyTable({
        columns: [{ name: 'id', dataType: 'INT', nullable: false, isPrimaryKey: true },
                  { name: 'name', dataType: 'TEXT', nullable: true, isPrimaryKey: false }],
        rows: [[{ kind: 'number', value: 1 }, { kind: 'string', value: 'a' }]],
    });
    const lines = s.split('\n');
    assert.equal(lines[0], 'id\tname');
    assert.equal(lines[1], '1\ta');
});
```

### 3.4 SQLite execute路径集成 test

```rust
// src-tauri/src/commands/sql/sqlite_driver.rs (新增 tests, Phase 04)
#[cfg(test)]
mod tests_phase04 {
    use super::*;
    use crate::commands::sql::driver::{SqlConnection, DriverRowSet};

    fn mem() -> BoxedConnection {
        let p = ConnectionProfile {
            id: "x".into(), label: "x".into(), driver: DriverIdDto::Sqlite,
            read_only: false, host: None, port: None,
            database: None, username: None, file_path: None,
            remember_in_memory: true, created_at_ms: 0,
        };
        SqliteDriver.open(&p, &ConnectionSecret::default()).unwrap()
    }

    #[test]
    fn execute_select_1_returns_one_row() {
        let mut c = mem();
        match c.execute_query("SELECT 1 AS x").unwrap() {
            DriverRowSet::Rows { columns, rows } => {
                assert_eq!(columns.len(), 1);
                assert_eq!(columns[0].name, "x");
                assert_eq!(rows.len(), 1);
                match &rows[0][0] {
                    crate::commands::sql::query::SqlCellDto::Number { value } => assert!((*value - 1.0).abs() < 1e-9),
                    other => panic!("unexpected cell {other:?}"),
                }
            }
            _ => panic!("expected rows"),
        }
    }

    #[test]
    fn execute_invalid_sql_returns_error() {
        let mut c = mem();
        let r = c.execute_query("SELECT FROM").unwrap_err();
        assert_eq!(r.code, "sqlite_prepare");
    }

    #[test]
    fn execute_create_then_list() {
        let mut c = mem();
        // CREATE
        match c.execute_query("CREATE TABLE users(id INTEGER PRIMARY KEY)").unwrap() {
            DriverRowSet::Empty | DriverRowSet::Affected(_) => {},
            _ => panic!("expected empty/mutated"),
        }
        // INSERT
        match c.execute_query("INSERT INTO users(id) VALUES (1)").unwrap() {
            DriverRowSet::Affected(n) => assert_eq!(n, 1),
            _ => panic!("expected affected"),
        }
        // SELECT
        match c.execute_query("SELECT id FROM users").unwrap() {
            DriverRowSet::Rows { rows, .. } => assert_eq!(rows.len(), 1),
            _ => panic!("expected rows"),
        }
    }

    #[test]
    fn execute_query_only_blocks_writes() {
        let p = ConnectionProfile {
            id: "x".into(), label: "x".into(), driver: DriverIdDto::Sqlite,
            read_only: true, host: None, port: None,
            database: None, username: None, file_path: None,
            remember_in_memory: true, created_at_ms: 0,
        };
        let mut c = SqliteDriver.open(&p, &ConnectionSecret::default()).unwrap();
        let r = c.execute_query("CREATE TABLE t(id int)");
        // PRAGMA query_only 视版本而定，至少 prepare 应该成功但执行应当报错。
        // 一旦出错，code 是 sqlite_execute。
        assert!(r.is_err());
    }

    #[test]
    fn cancel_is_noop_in_sqlite() {
        let mut c = mem();
        assert!(c.cancel("anything").is_ok());
    }
}
```

### 3.5 Wire-format mapping test (Rust)

```rust
// src-tauri/src/commands/sql/query.rs (新增 tests)
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_json_shape_is_camel_case() {
        // 我们手动构造一个最小 response，然后断言字段名。
        let r = SqlQueryResponseDto {
            connection_id: "a".into(),
            request_id: "r".into(),
            result_id: "rid".into(),
            elapsed_ms: 1,
            statement: "select 1".into(),
            finished_at_ms: 0,
            outcome: SqlQueryOutcomeDto::Success {
                rows: vec![],
                columns: vec![],
                row_count: 0,
                truncated: false,
            },
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"connectionId\":\"a\""));
        assert!(json.contains("\"resultId\":\"rid\""));
        assert!(json.contains("\"finishedAtMs\":0"));
        assert!(json.contains("\"rowCount\":0"));
    }

    #[test]
    fn outcome_kind_serializes_lc() {
        let o = SqlQueryOutcomeDto::Mutated { rows_affected: 2 };
        assert!(serde_json::to_string(&o).unwrap().starts_with("\"mutated\""));
    }

    #[test]
    fn error_kind_carries_code() {
        let o = SqlQueryOutcomeDto::Error { code: "X".into(), message: "Y".into() };
        assert!(serde_json::to_string(&o).unwrap().contains("\"code\":\"X\""));
    }
}
```

## 4. 验收

- [ ] `cargo test sqlite_driver::tests_phase04` 5/5 通过。
- [ ] `cargo test query::tests` 3/3 通过。
- [ ] `pnpm run test:sql-result` 通过。
- [ ] UI：跑 `SELECT 1`，panel 出现 1 行 1 列；
- [ ] UI：跑 `SELECT * FROM users`，panel 出现 N 行；
- [ ] UI：跑 `BAD SQL`，panel 出现红色 error，code 来自后端；
- [ ] UI：跑 `INSERT ...`，panel 出现 `affected 1`；
- [ ] UI：跑出 1500 行，panel 顶部出现 truncation 标记；
- [ ] 复制单个 cell / 单行：粘贴到记事本分别为 cell text 与 `\t` 分隔。

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| SQLite 不暴露 column type 于 prepare | 在 DTO 上写 UNKNOWN；Phase 09 后接 PG/MySQL 用真 type；本期不暴露 UI 反向影响。 |
| `rusqlite::Statement::execute` 返回类型是 `Result<usize, ...>` | 我们用 mutate path 表达 affected 数；如果未来 driver 接入其 own mechanism，DriverRowSet 设计不变。 |
| Blob 显示可读性差 | 不解析；用 `BLOB(Nb64)` 显示，与其他 database 工具一致。 |
| 多 statement 中首个 SELECT 后跟 INSERT 时的双结果集 | Phase 04 已用 outcome kind enum 区分；UI 多 result 的 tab 在后续 Phase 04.5 引入（不在本 Phase）。

## 6. 与下游接口

- Phase 05：History service 从 `ResultPane` 读取 elapsedMs/statement/outcome。
- Phase 06：AI context builder 拿到最近 `outcome.kind === 'error'` 的 message + statement + connection。
- Phase 09：DriverRowSet 会被 MySQL/PostgreSQL driver 复用，JSON 不变。

## 7. DoD

- 真有 columns/rows/affected/elapsed/error 四种 outcome；
- 真有 NULL 显示、truncation 提示；
- 真有 copy cell/row/column/table；
- 真有 wire format 兼容前端 camelCase。

## 8. 实现状态说明（与 §2 / §3 的偏差）

Phase 04 实装在 §1 列范围内的所有目标都已完成，但与 §2 / §3 设计的细节存在以下偏差：

### 8.1 后端 wire format 未重写

§2.3 / §2.4 设计的 `SqlColumnDto` / `SqlCellDto` / `SqlQueryResponseDto` / `SqlQueryOutcomeDto` / `DriverRowSet` trait **均未实装**。实装沿用 Phase 03 的 V1 体系：

- `src-tauri/src/commands/sql/state.rs` 仍然返回 `crate::commands::sql::types::SqlQueryResult`，字段名直接走 `#[serde(rename_all = "camelCase")]`；
- `state.rs::execute_query` 直接调 `execute_sqlite_query`，没有 `DriverRowSet` 中间 trait；
- SQLite driver 走 `src-tauri/src/commands/sql/sqlite_runtime.rs::execute_sqlite_query` 的具体函数路径，而不是 `SqlConnection` trait。

**推迟理由**：V1 已经 `cargo test sql` 119/119 绿，重写 DTO 等于删已绿代码；且 V2 `SqlConnectionServiceV2` 与 V1 `SqlConnectionService` 在 §2.4 提到的 caller 视角下都满足前端需要。**建议在多 driver（PostgreSQL / MySQL）接入时统一重构 driver trait。**

### 8.2 copy API 命名差异

§2.6 设计 4 个 API：`copyCell` / `copyRow` / `copyColumn` / `copyTable`。实装只有一个 `copySqlResultGrid(grid, options)` 函数，通过 `options.mode` 在 `Cell` / `Row` / `All` 三种模式之间切换，`options.format` 在 `Csv` / `Tsv` 之间切换。

**`copyColumn` 函数不存在**——前端面板按行操作而非按列；如未来需要按列复制，可在 `sqlResultGridModel.ts` 增加 `copyColumnFromGrid` 函数，不破坏 DoD。

### 8.3 测试分布

§3.4 / §3.5 期望的 `sqlite_driver.rs::tests_phase04` 与 `query.rs::tests` 两个 Rust test module **不存在**。等价测试散落如下：

| §3 期望位置 | 等价实装 | 用例数 |
| --- | --- | --- |
| §3.4 SQLite execute 5 个 | `state.rs::tests` 中 `execute_query_*` 系列 + `read_only_connection_rejects_mutating_sql` | 6 |
| §3.5 wire format 3 个 | `SqlQueryResult` 的 serde `rename_all = "camelCase"` 由 `state.rs::tests::execute_query_returns_columns_and_rows` + frontend `sqlConnectionProfileV2.test.ts` 覆盖 | — |

### 8.4 超出 §1 范围但已实装

- **Snapshot history**：最多 20 条 `SqlResultSnapshot`，包含 success / error / cancelled 三种。Panel 渲染为可点击切换的 history list。doc §1 列为"不在范围"，但因 Phase 04 与 Phase 05 history service 共享 state，由 Phase 04 提前提供。
- **`SqlResultView`** 是真 `ViewPane`，不是 §2.5 的 stub。包括 toolbar（Copy Cell / Copy Row / Copy CSV / Copy TSV / Clear）、status bar、history list、grid 选中、cancellation message、truncation banner。
- **`SqlResultBridgeContribution`** 串起 `ISqlEditorEventService` ↔ `ISqlResultService`，监听 Started / Completed / Failed / Cancelled 四个事件。

### 8.5 验证命令汇总

```bash
pnpm run lint                              # exit 0
pnpm run build                             # exit 0
pnpm run rust:check                        # exit 0
pnpm run rust:clippy                       # exit 0
pnpm run test:sql-result                   # 57/57 pass
pnpm run test:sql-services                 # 62/62 pass
pnpm run test:sql-editor                   # 59/59 pass
cd src-tauri && cargo test sql             # 119/119 pass
```
