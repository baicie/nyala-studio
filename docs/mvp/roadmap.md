下面按你当前状态来定：**已完成 Phase 0：SideX fork 能构建、能展示**。接下来不要先做大规模裁剪，而是先打通 **SQL Studio 最小闭环**。

我基于当前 `sql-studio-next` 看了一下：仓库默认分支是 `mvp`；README、`package.json`、`tauri.conf.json`、Rust package 仍然基本是 SideX 品牌；Rust command registry 已经很完整，但还没有 SQL 专用模块。README 仍描述为 SideX / VSCode workbench without Electron，且说明 Rust 后端通过 `src-tauri/src/commands/` 承接文件、终端、Git、搜索、SQLite 等能力。

# 剩余任务总目标

最小目标不要扩大，先定成：

```txt
SQL Studio Next MVP =
  SideX Workbench 壳
  + 品牌替换
  + SQLite 查询闭环
  + SQL Editor
  + Connection Tree
  + Result Panel
  + macOS / Windows 可构建
```

也就是先完成：

```txt
启动应用
  -> 打开 SQL Studio 工作台
  -> 新建 SQLite 连接
  -> 展示 schema / tables
  -> 打开 SQL 编辑器
  -> 执行 SELECT
  -> 在 Panel 展示结果
```

---

# Phase 1：产品化收口 / 去 SideX 品牌

**目标：把它从 SideX fork 变成 SQL Studio Next。**

当前 `package.json` 还是：

```json
"name": "sidex",
"version": "0.1.3"
```

并且 scripts 仍是 SideX 原始开发构建流。

`tauri.conf.json` 也还是：

```json
"productName": "SideX",
"identifier": "com.siden.sidex",
"title": "SideX"
```

并且 updater endpoint 仍指向 `cdn.siden.ai`。

## 任务

```txt
P0-1.1 改 package.json
- name: sql-studio-next 或 nyala
- version: 0.1.0
- description 改为 SQL Workbench / SQL Studio

P0-1.2 改 tauri.conf.json
- productName: SQL Studio Next / Nyala
- identifier: com.baicie.sqlstudio
- window.title: SQL Studio
- shortDescription / longDescription 改掉
- copyright 改掉
- updater 暂时关闭或替换为你自己的 endpoint

P0-1.3 改 macOS 菜单
- SideX menu -> SQL Studio
- About SideX -> About SQL Studio
- File 菜单保留 Save / Open，但新增 New SQL Query
- Run 菜单先隐藏 Debug 相关项
```

当前 macOS menu 里仍有完整 VS Code/SideX 菜单，例如 File、View、Run、Terminal、Help，以及 `About SideX`。

## 验收标准

```txt
pnpm tauri dev 启动后：
- 应用名不再显示 SideX
- About 不再显示 SideX
- app data 数据库不再叫 sidex_storage.db / sidex_state.db
- updater 不再访问 siden.ai
- README 首屏变成 SQL Studio Next
```

这一阶段不要碰大结构，最多改配置和菜单。

---

# Phase 2：接入 SQL 后端最小桥

**目标：Rust 侧先跑通 SQLite 查询。**

当前 Rust 后端的命令入口在 `src-tauri/src/lib.rs`，所有 Tauri commands 通过 `generate_handler!` 统一注册。

`commands/mod.rs` 当前只有 SideX 原生模块，例如 `fs`、`git`、`search`、`terminal`、`storage`、`extensions` 等，还没有 `sql` / `database` 模块。

## 新增目录

```txt
src-tauri/src/commands/sql/
├─ mod.rs
├─ types.rs
├─ state.rs
├─ connection.rs
├─ metadata.rs
└─ query.rs
```

## 新增 command

第一批只做 SQLite：

```rust
sql_test_connection
sql_open_connection
sql_close_connection
sql_list_connections
sql_list_tables
sql_list_columns
sql_execute_query
sql_cancel_query
```

先不要直接做 MySQL/Postgres。SQLite 足够验证闭环。

## 数据结构

```ts
type SqlConnectionKind = 'sqlite';

interface SqlConnectionInput {
	id?: string;
	name: string;
	kind: SqlConnectionKind;
	databasePath: string;
	readonly?: boolean;
}

interface SqlQueryRequest {
	connectionId: string;
	sql: string;
	limit?: number;
}

interface SqlQueryResult {
	columns: SqlColumn[];
	rows: SqlCellValue[][];
	affectedRows?: number;
	elapsedMs: number;
	error?: SqlError;
}
```

## Rust 侧状态

```txt
SqlConnectionStore
  HashMap<ConnectionId, SqliteConnectionPool>

SqlQueryStore
  HashMap<QueryId, CancellationToken>
```

如果要快，第一版甚至可以不做连接池：

```txt
打开连接 -> 存路径
执行查询 -> 每次用 rusqlite 打开 -> 查询 -> 关闭
```

等闭环打通后再引入 pool。

## 注册点

需要在：

```txt
src-tauri/src/commands/mod.rs
src-tauri/src/lib.rs
```

新增：

```rust
pub mod sql;
pub use sql::*;
```

然后把 command 加入 `tauri::generate_handler![]`。

## 验收标准

```txt
从前端 invoke：
- sql_test_connection 能返回 ok
- sql_list_tables 能读取 SQLite 表
- sql_execute_query("select 1 as value") 返回 columns + rows
- 错误 SQL 返回结构化 error，而不是 Rust panic
```

---

# Phase 3：前端 SQL Service Bridge

**目标：先不做 UI，先做 Workbench 前端服务。**

SideX 保留了 VS Code 的分层：`base / platform / editor / workbench`，Workbench 内部有 `services` 和 `contrib`。

当前 `workbench.common.main.ts` 已经集中注册大量平台服务、Workbench 服务和 contributions。

所以 SQL 不要写成散落的 `invoke()`，要先做服务层。

## 新增目录

```txt
src/vs/workbench/services/sql/common/
├─ sqlConnection.ts
├─ sqlMetadata.ts
├─ sqlQuery.ts
└─ sqlTypes.ts

src/vs/workbench/services/sql/browser/
├─ sqlConnectionService.ts
├─ sqlMetadataService.ts
└─ sqlQueryService.ts
```

## 服务接口

```ts
export const ISqlConnectionService = createDecorator<ISqlConnectionService>('sqlConnectionService');

export interface ISqlConnectionService {
	readonly _serviceBrand: undefined;

	testConnection(input: SqlConnectionInput): Promise<SqlConnectionTestResult>;
	openConnection(input: SqlConnectionInput): Promise<SqlConnection>;
	closeConnection(connectionId: string): Promise<void>;
	listConnections(): Promise<SqlConnection[]>;
}
```

```ts
export const ISqlQueryService = createDecorator<ISqlQueryService>('sqlQueryService');

export interface ISqlQueryService {
	readonly _serviceBrand: undefined;

	executeQuery(request: SqlQueryRequest): Promise<SqlQueryResult>;
	cancelQuery(queryId: string): Promise<void>;
}
```

## 注册点

可以新增：

```txt
src/vs/workbench/services/sql/browser/sqlService.contribution.ts
```

然后在：

```txt
src/vs/workbench/workbench.common.main.ts
```

加入：

```ts
import './services/sql/browser/sqlService.contribution.js';
```

或者直接在 `workbench.common.main.ts` 注册 singleton。

## 验收标准

```txt
不做 UI 的情况下，在 devtools console 或临时 command 中：
- ISqlConnectionService 能 open SQLite
- ISqlQueryService 能执行 select 1
- 错误能进入 notification / output log
```

---

# Phase 4：SQL Activity + Connection Tree

**目标：左侧出现 SQL Studio 的数据库入口。**

当前 Workbench contribution 主要还是 Explorer、Search、SCM、Debug、Extensions、Output、Terminal 等 VS Code 原始能力。

这一阶段新增 SQL 专属 contribution，不要先删旧功能。

## 新增目录

```txt
src/vs/workbench/contrib/sqlConnections/
├─ browser/
│  ├─ sqlConnections.contribution.ts
│  ├─ sqlConnectionsView.ts
│  ├─ sqlConnectionTree.ts
│  ├─ sqlConnectionActions.ts
│  └─ media/
│     └─ sqlConnections.css
└─ common/
   └─ sqlConnectionConstants.ts
```

## View 结构

```txt
Activity Bar:
  SQL Connections

Side Bar:
  Connections
    Local SQLite
      main
        tables
          users
          orders
        views
```

## 第一版功能

```txt
- 注册 SQL Connections View Container
- 注册 SQL Connections Tree View
- 支持 Add SQLite Connection
- 支持 Refresh
- 支持 Expand Tables
- 支持右键 Open New Query
- 支持右键 Browse Table，后面再做
```

## 验收标准

```txt
打开应用后：
- Activity Bar 有 SQL 图标
- 点击后出现 Connection Tree
- 可以添加 SQLite 文件路径
- 展开后能看到 tables
- 右键表名能生成 SELECT * FROM table LIMIT 100
```

---

# Phase 5：SQL EditorInput / SQL EditorPane

**目标：编辑区能打开 SQL 查询页。**

不要用 React Router 页面思路，要按 VS Code Workbench 的模型走：

```txt
EditorInput
EditorPane
EditorSerializer
EditorResolver
```

## 新增目录

```txt
src/vs/workbench/contrib/sqlEditor/
├─ browser/
│  ├─ sqlEditor.contribution.ts
│  ├─ sqlEditorInput.ts
│  ├─ sqlEditorPane.ts
│  ├─ sqlEditorCommands.ts
│  ├─ sqlEditorActions.ts
│  └─ media/sqlEditor.css
└─ common/
   └─ sqlEditorModel.ts
```

## 第一版能力

```txt
- New SQL Query 命令
- 打开一个 SQL Editor tab
- 使用 Monaco CodeEditorWidget
- languageId: sql
- Ctrl/Cmd + Enter 执行当前 SQL
- Shift + Enter 执行选中 SQL
- Editor title 显示连接名
```

## 命令

```txt
sql.newQuery
sql.executeQuery
sql.executeSelection
sql.changeConnection
sql.formatQuery
```

第一版 `formatQuery` 可以先空实现，后面接 formatter。

## 验收标准

```txt
- Command Palette 里能搜到 New SQL Query
- 打开 SQL tab
- 输入 select 1 as value
- Cmd/Ctrl + Enter 可以调用 ISqlQueryService
- 查询结果先输出到 Output Channel 或临时 notification
```

---

# Phase 6：Query Result Panel

**目标：真正闭环，把结果展示出来。**

这是最小目标的核心验收点。

## 新增目录

```txt
src/vs/workbench/contrib/sqlResult/
├─ browser/
│  ├─ sqlResult.contribution.ts
│  ├─ sqlResultPanel.ts
│  ├─ sqlResultGrid.ts
│  ├─ sqlResultActions.ts
│  └─ media/sqlResult.css
└─ common/
   └─ sqlResultModel.ts
```

## 第一版不要追求 AG Grid 级别

先用原生 table 或 VS Code list/table 组件做：

```txt
- columns 横向滚动
- rows 纵向滚动
- NULL / boolean / number / text 基础展示
- 查询耗时
- row count
- error message
```

后面再引入虚拟滚动。

## Panel 结构

```txt
Panel: Query Results
├─ Toolbar
│  ├─ Run
│  ├─ Stop
│  ├─ Export CSV
│  └─ Copy
├─ Tabs
│  ├─ Result 1
│  └─ Messages
└─ Grid
```

## 验收标准

```txt
select 1 as value;
能展示：

| value |
| ----- |
| 1     |

并且能显示：
- elapsedMs
- row count
- error detail
```

到这里，最小目标正式完成。

---

# Phase 7：从旧 `sql-studio/mvp` 迁移领域资产

**目标：不搬旧 React 壳，只搬 SQL 领域资产。**

这个阶段再考虑从旧项目迁移：

```txt
crates/sqlgui-db
crates/sqlgui-common
packages/sqlgui-api 的类型设计
SQL formatter demo
Result grid 交互设计
Connection form 字段设计
```

迁移顺序建议：

```txt
1. sqlgui-common 类型
2. sqlgui-db SQLite
3. sqlgui-db Postgres
4. sqlgui-db MySQL
5. sqlgui-api manifest / permission
6. extension demo
```

不要一开始就做插件系统。当前 SideX 自己的 Extension Host 仍然是进行中状态，README 也说明 extension host 和 debugger 还在进展中。

---

# Phase 8：裁剪 VS Code 原始入口

**目标：从“代码编辑器 fork”变成“数据库工作台”。**

这一步放在 SQL 闭环之后做，不要提前做。

## 可以隐藏

```txt
- Debug Activity
- SCM Activity
- Extensions Activity
- Remote Activity
- File Explorer 默认入口
- Run 菜单
- Debug 菜单项
```

当前 `workbench.common.main.ts` 里仍导入了 SCM、Remote、Debug、Extensions、Terminal、Tasks 等 contribution。

建议策略不是删除，而是先加产品开关：

```ts
const productMode = 'sql-studio';

if (!isSqlStudioMode) {
	import('./contrib/debug/browser/debug.contribution.js');
}
```

但静态 import 不方便条件化，所以可以先：

```txt
P1：CSS / layout 层隐藏入口
P2：注释 import
P3：删除代码
```

## 验收标准

```txt
默认首屏是 SQL Connections
不是 Explorer
不是 Git
不是 Debug
```

---

# Phase 9：测试与 CI 收口

当前 `package.json` 已经有：

```txt
lint
format
rust:check
rust:clippy
rust:fmt
build
```

这些脚本可以直接用作最小 CI 基础。

## CI 任务

```txt
ci:
- pnpm install
- pnpm lint
- pnpm build
- pnpm rust:fmt
- pnpm rust:check
- pnpm rust:clippy

sql:
- Rust unit test: sql_execute_query select 1
- Rust unit test: invalid SQL returns error
- Rust unit test: list_tables
```

## E2E 暂时不要重

第一版可以只做 smoke：

```txt
- tauri build 能过
- 启动后主窗口加载 index.html
- sql_execute_query command 可调用
```

---

# 建议执行顺序

最短路线如下：

```txt
第 1 步：品牌替换
第 2 步：新增 Rust sql commands
第 3 步：新增前端 SqlService
第 4 步：新增 SQL Connections Activity
第 5 步：新增 SQL Editor
第 6 步：新增 Result Panel
第 7 步：迁移旧 sqlgui-db
第 8 步：隐藏 VS Code 原始入口
第 9 步：补测试和 CI
```

---

# 里程碑拆分

## Milestone 1：SQL backend bridge

```txt
目标：
Rust command 能执行 SQLite 查询。

任务：
- 新增 commands/sql
- 新增 SqlConnectionStore
- 新增 sql_test_connection
- 新增 sql_execute_query
- 注册到 lib.rs
- Rust 单测

验收：
invoke("sql_execute_query", { sql: "select 1" }) 返回 rows。
```

## Milestone 2：SQL service layer

```txt
目标：
Workbench 前端通过服务调用 SQL command。

任务：
- ISqlConnectionService
- ISqlMetadataService
- ISqlQueryService
- Tauri invoke adapter
- 错误模型统一

验收：
临时 command 能通过 service 执行 select 1。
```

## Milestone 3：SQL Connections view

```txt
目标：
Activity Bar 出现数据库连接入口。

任务：
- sqlConnections.contribution.ts
- Connection Tree
- Add SQLite Connection
- Refresh Metadata
- Open New Query

验收：
可以展开 SQLite 表结构。
```

## Milestone 4：SQL Editor + Execute

```txt
目标：
编辑区能写 SQL 并执行。

任务：
- SqlEditorInput
- SqlEditorPane
- sql.newQuery
- sql.executeQuery
- 快捷键 Cmd/Ctrl + Enter

验收：
SQL 编辑器中执行 select 1，能拿到结果。
```

## Milestone 5：Result Panel

```txt
目标：
查询结果可视化。

任务：
- sqlResult.contribution.ts
- Result Panel
- Grid View
- Error View
- Messages View

验收：
执行 select 1 后 Panel 展示表格。
```

---

# 当前最应该避免的事

```txt
1. 不要现在就迁移完整旧 React UI
2. 不要现在就做 MySQL/Postgres
3. 不要现在就做插件市场
4. 不要现在就深度删除 SideX 原始功能
5. 不要现在就做 AI Agent
6. 不要现在就优化 Result Grid 性能
```

你的最小目标应该死盯：

```txt
SQLite + SQL Editor + Result Panel
```

只要这个闭环跑通，这条 SideX fork 路线就成立。

---

# 最终路线图一句话

> **现在已经完成“能构建展示”，下一步先做产品化改名，然后以 SQLite 为唯一数据库打通 Rust command → Workbench SqlService → SQL Connections View → SQL Editor → Result Panel。等这个闭环完成后，再迁移旧 `sql-studio/mvp` 的 `sqlgui-db`、多数据库能力、插件 API 和 AI Agent。**
