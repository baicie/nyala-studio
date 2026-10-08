# Nyala Studio — 项目核心思路分析

> 范围：`sql-studio-next`（Nyala Studio）的总体设计定位、架构骨架、MVP 阶段路线、关键设计机制、测试与发布门禁。
> 更新时间：2026-09-17（对齐 Core MVP 之后的 MVP vNext 状态）。
> 参考来源：`README.md`、`package.json`、`AGENTS.md`、`docs/sql-mvp-phases/README.md`、`docs/sql-mvp-phases/phase-00..phase-08.md`、`docs/sql-mvp-phases/phase-do-d-verification.md`、`docs/sql-mvp-phases/mvp-vnext-agent-zeus-roadmap.md`、`docs/sql-mvp-phases/phase-z1-spike-verification.md`、`docs/sql-workspace-agent-design.md`、`docs/sql-workspace-agent-a5-implementation-plan.md`、`docs/adr/0003..0004`。
> 本文件不重复列每条 phase 的逐文件清单（`docs/sql-mvp-phases/*.md` 已写明），只梳理"为什么这样做"。

---

## 1. 一句话定位

> **Nyala Studio = SideX / VS Code 风格 Workbench 壳 + Tauri Rust 后端 + 一个本地优先（local-first）的 SQL 客户端，再叠加一条为 SQL 工作台设计的扩展 / AI 注入点。**

它不是"另一种数据库工具"，也不是"另一种 IDE"。

- 它**借壳**于 SideX（VS Code 式 Workbench），换来"Activity Bar / Side Bar / Editor Area / Panel / Status Bar / Commands / Services / Contributions"这一整套已被工业验证的产品骨架；
- 它**内置** SQL 客户端：连接管理、Schema Explorer、SQL Editor、Query Result Panel、History、Formatter / Snippets / Explain、AI Helper；
- 它为后续 SQL 扩展系统、AI Agent、MCP 之类的接入预留了 13 类 Contribution Point 与统一 Capability。

> 状态（2026-09-17）：Core MVP Phase 00–08 已 met；MVP vNext 的 Agent A0–A4 与
> post-vNext A5 已实现（A4 Checkpoint W 仍缺原生键盘 / Windows WebView2 / VoiceOver 证据）；
> Zeus Z1.3 为 `NO-GO`，Z2 禁止开始，R0 保持 `NO-GO`。

与 DataGrip / DBeaver / TablePlus 等通用 SQL 工具的差异：

| 维度 | 通用 SQL 工具         | Nyala Studio                                                                                                                                                                                                           |
| ---- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 形态 | 客户端 GUI / 桌面 app | 复用了 Code - OSS / VS Code Workbench（活动栏、Panel、Keybinding、Palette）                                                                                                                                            |
| 定位 | 数据库工具            | "SQL-first 的 Workbench"——壳本身是 SQL-first，Workbench 模型只用作宿主                                                                                                                                                 |
| 扩展 | 自家 plugin 或没有    | Phase 07 已经在壳里塞入 13 类 contribution point（commands / sqlActions / views / panels / menus / keybindings / settings / snippets / formatters / resultViewers / exportProviders / aiProviders / dialects）         |
| AI   | 通常外置              | Phase 06 起把 AI 当一等公民：deterministic provider + capability declaration；A2 已把 canonical capability enforcement 落到 Rust Tool Runtime，模型输出默认 Suggest Only，只有显式 Read Only mode 才会执行单条只读查询 |
| 安全 | 通常混淆              | Secret 永不落盘，三层防御（持久化剥字段、redacted 展示、widget `clearSecret` finally）                                                                                                                                 |

---

## 2. 顶层架构

### 2.1 关注点分层

```text
┌───────────────────────────────────────────────────────────────┐
│ Tauri shell：Webview + 原生窗口 + IPC (`#[tauri::command]`)   │
└───────────────────────────────────────────────────────────────┘
                ▲                            ▲
                │ invoke(...)                │ Events / Secrets
                │                            │
┌──────────────────────────────┐   ┌──────────────────────────────┐
│ src/vs/workbench/contrib/sql*│   │ src-tauri/src/commands/sql/* │
│  SQL 视图、面板、tree、button│   │  Rust Tauri 命令 + driver    │
└──────────────────────────────┘   └──────────────────────────────┘
                ▲                            ▲
                │ 通过 IService 注入          │ 通过 Driver trait + RuntimeStatus
                │                            │
┌──────────────────────────────────────────────────────────────┐
│         src/vs/workbench/services/sql/  (services)            │
│  ISqlConnectionService / ISqlMetadataService / ISqlQuery-     │
│  Service / ISqlAiService / ISqlDriverCatalogService /         │
│  Capability declarations / Plugin Registry / Bootstrappers    │
└──────────────────────────────────────────────────────────────┘
                ▲
                │
┌──────────────────────────────────────────────────────────────┐
│  src/vs/base  /  src/vs/platform  /  src/vs/editor / workbench│
│           SideX / VS Code 基础设施（不修改，做宿主）         │
└──────────────────────────────────────────────────────────────┘
```

**`AGENTS.md` 中的硬约束**：SQL 产品代码**只能**放 `src/vs/workbench/contrib/sql*` 或 `src/vs/workbench/services/sql*` 或 `src-tauri/src/commands/sql/*`。这避免把 SQL 概念泄漏到 generic 层。

### 2.2 进程边界

```text
Webview (TS)                       Rust (Tauri)
─────────────                      ─────────────
SQL Editor   ──┐                       ┌── Connection Manager (in-mem only)
Query Panel  ──┤                       │     · profiles (持久化)
Metadata Tree──┤ ISqlXxxService ──────►│     · drivers   (运行时)
History      ──┤   (DI)               │     · last_secret_by_id (易失)
AI Panel     ──┤                       │
Driver Card  ──┘                       │
                                       ├── Driver Registry → Sqlite / Mysql / (Postgres 守卫)
                                       └── runtime_status   → stable / preview / planned
```

- 前端**永远不**直接 `import { invoke } from '@tauri-apps/api/core'`；统一走 `SqlCommandExecutor` + `ISqlXxxService`（注入）。这是 AGENTS 强制条款，目的是让单元测试不依赖 Tauri runtime。
- 后端**返回**结构化 `SqlCommandError / SqlQueryResult / SqlQueryOutcomeDto`，不 panic、不抛裸异常。错误分四态：`success / mutated / empty / error`。

### 2.3 Rust 内层结构

| 层              | 路径                                                                                                            | 角色                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类型            | `commands/sql/types.rs`                                                                                         | `ConnectionProfile / ConnectionSecret / DriverIdDto / SqlCommandError / SqlQueryResult` 等共享 DTO                                                        |
| 持久化          | `commands/sql/persistence_v2.rs`                                                                                | **剥字段持久化**：`password / secret / credentials` 在 load 时就被剔除；该模块只依赖 `ConnectionProfile`，不接收 `ConnectionSecret`                       |
| 运行时          | `commands/sql/connection_manager.rs` + `commands/sql/state.rs`                                                  | V2 `ConnectionManager` 管理持久 profile、运行时 driver 与内存 secret；`state.rs` 保留 V1 compatibility store                                              |
| Driver Registry | `commands/sql/driver_registry.rs` + `commands/sql/mysql_runtime.rs`                                             | SQLite / MySQL driver 实现与 PostgreSQL planned guard；driver trait 负责连接、测试及 metadata 能力                                                        |
| Query 执行      | `commands/sql/query.rs` + driver runtime                                                                        | V1 command 与 V2 driver 路径最终都返回结构化 query result / error                                                                                         |
| Metadata        | `commands/sql/metadata.rs` + `metadata_v2.rs`                                                                   | schemas / tables / columns 的命令实现                                                                                                                     |
| Dialect         | `commands/sql/dialect.rs`                                                                                       | 读 `DriverId` 得 `SqlDialect`；`check_read_only` 拦截 `DROP / DDL / MUTATION`                                                                             |
| Core Adapter    | `commands/sql/agent/core_adapter.rs`                                                                            | A1.2 起的统一组合入口：复用现有 V1/V2 connection/metadata 能力，为 Agent 提供 opaque connection identity 与有界 schema/index 视图；不新增 driver 或连接池 |
| Agent Runtime   | `commands/sql/agent/{domain,plan,runtime,policy,evidence,bridge}.rs`                                            | A2-A4 的 runtime domain、Rust capability/policy、budget、run state、typed evidence 与 Tauri bridge；每个 tool call 在 Rust 端重新授权                     |
| Agent Tools     | `commands/sql/agent/{suggest_only,read_only,explore,schema_context,relation_context,index_context,optimize}.rs` | Suggest Only 保持零 query call；Read Only 只执行单条只读 SQLite 语句；A5 optimize 走 bounded `index.list` + 两次 typed `EXPLAIN QUERY PLAN`               |
| SQL Analyzer    | `commands/sql/sql_analysis.rs` + `sql_lexer.rs`                                                                 | 本地 fail-closed 语句分析器；A0.2 的 No-Go 结论保留它作为唯一信任边界（[ADR 0003](../adr/0003-sql-agent-parser-boundary.md)）                             |
| Product         | `commands/sql/product.rs` + `demo_seed.rs` + `mysql_validation.rs`                                              | bootstrap demo + opt-in MySQL Preview validation                                                                                                          |
| Runtime Status  | `runtime_status/`                                                                                               | 单一 source-of-truth：声明 `SQLite=stable, MySQL=preview, Postgres=planned`；被所有上层 phase 消费                                                        |

### 2.4 TS 前端内层结构

| 路径                                                                  | 角色                                                                                                                                                                                                                          |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/sql/common/*.ts`                                            | service 接口（`ISqlConnectionService`、`ISqlMetadataService`、`ISqlQueryService`、`ISqlAiService`、`ISqlDriverCatalogService`、`ISqlAgentService`）和共享类型；A2 后 canonical capability token 与 Rust policy 使用同一组词表 |
| `services/sql/common/{sqlAgent,sqlAgentArtifacts,sqlCapabilities}.ts` | Agent 请求/事件/artifact contract、stale-safe draft 绑定（runId / editorId / version / base SQL）与 capability 声明                                                                                                           |
| `services/sql/browser/sqlAgentService.ts`                             | `ISqlAgentService` 的 Tauri 实现：run 生命周期、取消、typed event 订阅与释放                                                                                                                                                  |
| `services/sql/browser/*.ts`                                           | service 实现 + `SqlCommandExecutor` IPC 封装                                                                                                                                                                                  |
| `contrib/sqlConnections/*`                                            | Connections View：tree、form、template、MySQL validation 视图                                                                                                                                                                 |
| `contrib/sqlEditor/*`                                                 | SQL Editor tab + Statement Splitter + Execution Controller                                                                                                                                                                    |
| `contrib/sqlResult/*`                                                 | Result Panel + Result Model + Grid View + Copy helper                                                                                                                                                                         |
| `contrib/sqlHistory/*`                                                | Query History                                                                                                                                                                                                                 |
| `contrib/sqlAdvanced/*`                                               | Snippets / Formatter / Explain / Plugins / AI Service / Settings                                                                                                                                                              |
| `contrib/sqlProduct/*`                                                | Welcome / Bootstrap Model / Profile / Preferences / Splash                                                                                                                                                                    |
| `contrib/sqlAgent/*`                                                  | SQL Agent Panel：run state、usage、answer、error、tool activity 与 evidence refs；Apply/Open/Cancel 只在 artifact 校验通过后可用                                                                                              |

持有 listener / timer / model 等资源的 service 或 contribution 必须统一注册并释放；无状态 service 不需要为了形式而继承 `Disposable`。

---

## 3. MVP 闭环与阶段路线

`docs/sql-mvp-phases/README.md` 把 9 个 phase 串成一条**严格有序**的实现链，末尾再接上
MVP vNext 的 Agent / Zeus 两条轨（见 §3.3）。最终目标是"启动 Nyala → 60 秒内跑通 SELECT"：

```text
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│ 00 状态  │→ │ 01 连接  │→ │ 02 元数据│→ │ 03 编辑器│→ │ 04 结果 │
│ runtime  │  │ SQLite   │  │ 三级 tree│  │ all/sel  │  │ panel    │
│ status   │  │ Stable + │  │ +per-node│  │ /current │  │ +四态    │
│ 表       │  │ MySQL    │  │ error    │  │ +Ctrl+   │  │ outcome  │
│          │  │ Preview  │  │ /refresh │  │ Enter    │  │          │
└──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘
                                                        │
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│ 08 发布  │← │ 07 插件  │← │ 06 AI    │← │ 05 辅助  │←──┘
│ Demo flow│  │ 13 类 CP │  │ determi- │  │ history/ │
│ +MySQL   │  │ +Capability│ │ nistic  │  │ format/  │
│ Preview  │  │ local-   │  │ provider │  │ snippets │
│ validati-│  │ only     │  │ +Guard   │  │ /explain │
│ on       │  │ loader   │  │          │  │          │
└──────────┘  └──────────┘  └──────────┘  └──────────┘
```

### 3.1 用户视角的 MVP 闭环

Core MVP（Phase 00–08，已 met）：

```text
Launch Nyala Studio
  → 自动 seed <DATA>/nyala-studio/demo.db（users 5 行 + orders 5 行）
  → Welcome 视图落地「Open demo database / Add a connection / …」四个 action
  → 点 "Open demo database"
      → sql_bootstrap_demo Tauri command 跑
      → 自动 register 一个 "Demo (SQLite)" profile 并打开
  → 用户在左侧 SQL Connections 看到该 datasource
  → 用户新建 SQL Editor tab → 绑到该 connection → Ctrl+Enter
  → SELECT COUNT(*) FROM users; → Panel 展示 1 行 1 列 "5", elapsed=2ms
  → 选 INSERT 语句 → Shift+Enter → Panel 展示 "affected 1"
  → 写错 → Panel 展示红色 error，code 来源于 Rust `SqlCommandError::code`
  → 关闭程序 → secrets 全部清零；下次启动，profile 还在但 driver 重新建立
```

### 3.2 定义完成度（Core MVP DoD）

`AGENTS.md §Definition of Done` 列出 10 条核心门禁：验证针对当时的代码基线 `c03f1a4b` 执行，报告随后由 commit `60ab89c0` 记录在 `docs/sql-mvp-phases/phase-do-d-verification.md`。表中计数是记录时的数量，2026-09-17 的当前实测见 §5.1：

| #   | DoD                    | 证明                                                                                                                                                         |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Launches as Nyala      | `tauri.conf.json`：`productName=Nyala Studio, identifier=com.baicie.sqlstudio, title=Nyala`                                                                  |
| 2   | SQLite 连接可加        | `connection_v2::tests::open_connection_v2_returns_profile_id` + `state::save_connection_persists_and_lists_saved_connections` + 前端 V2 service 单测         |
| 3   | Tables 可列出          | `metadata_v2::tests::list_tables_for_empty_sqlite_returns_empty` + `state::list_tables_and_columns_returns_sqlite_metadata`                                  |
| 4   | SQL editor 可打开      | `test:sql-editor`（当前 77/77）                                                                                                                              |
| 5   | SELECT 可执行          | `state::execute_query_returns_columns_and_rows` + `enforces_row_limit` + `reports_affected_rows_for_mutations`                                               |
| 6   | Result 出现在 panel    | `test:sql-result`（当前 84/84）                                                                                                                              |
| 7   | Invalid SQL 结构化错误 | `execute_query_returns_error_for_invalid_sql` + `read_only_connection_rejects_mutating_sql`                                                                  |
| 8   | `pnpm run build`       | exit 0；产物 `dist/assets/{core,workbench.common.main,workbench.web.main,main}-*.js`                                                                         |
| 9   | `pnpm run rust:check`  | exit 0；额外 rust:clippy 也 exit 0                                                                                                                           |
| 10  | `pnpm run test`        | branding + runtime-status + cargo test --lib（当前 534 passed / 0 failed / 2 ignored）+ 9 个 SQL frontend suite（671 cases）全绿；vNext gate harness 见 §5.1 |

**意义**：这条核心闭环证明"SQL-first Workbench"的产品定位已经能被工业验证；MVP vNext 与 Phase 09 – 13（PostgreSQL、ORM、MCP、License、Team、Marketplace）都是在这个闭环之上加横切能力，而不是重写。

### 3.3 MVP vNext 轨道（当前活跃）

Core MVP 完成后，新增范围由
[`mvp-vnext-agent-zeus-roadmap.md`](./sql-mvp-phases/mvp-vnext-agent-zeus-roadmap.md)
统一管理，不重开 Phase 08：

```text
Core MVP 00-08 (met)
        │
        ├─ A0/A1 → A2 → A3 → A4 ─┐        Agent 主线（本地 Rust runtime）
        │                         │
        └─ Z0 → Z1 ───────────────┴→ Z2 → R0
                                   （Zeus 准入轨，Z1 No-Go 时 Z2 禁止开始）
```

| Track | 范围                      | 状态（2026-09-17）                                                                 | 完成门                                                           |
| ----- | ------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| A0    | SQL Intelligence          | A0.1 完成；A0.2 parser No-Go（ADR 0003）                                           | corpus + parser ADR                                              |
| A1    | Schema Context            | A1.1-A1.3 完成（bounded schema search、SQLite FK graph、cache/invalidation）       | adapter + bounded schema/relation search/cache                   |
| A2    | Suggest-only Runtime      | A2.1-A2.4 完成；零 query call                                                      | policy/budget/evidence/bridge                                    |
| A3    | Read-only Agent           | A3.1/A3.2 与 Checkpoint R 完成                                                     | SQLite 真闭环 + write/multi/Unknown deny + result policy         |
| A4    | Workbench Integration     | A4.1/A4.2 完成；Checkpoint W 缺原生键盘、Windows WebView2、VoiceOver/Narrator 证据 | Editor/Error/Schema/Result/Panel + 双平台/人工 QA                |
| A5    | SQLite Query Optimization | post-vNext 已实现，不属于 release 依赖链                                           | index metadata + typed explain 对比，`performanceVerified=false` |
| Z0    | Zeus 采用评估             | 评估完成，生产未接入                                                               | Data Grid-only boundary                                          |
| Z1    | Data Grid Spike           | Z1.1/Z1.2 完成；beta.4 证据齐全但 5 个 v6 性能门失败，Z1.3 `NO-GO`                 | dependency/bundle/performance/双 WebView Go                      |
| Z2    | Result Grid Preview       | 禁止开始（依赖 Z1 Go + A4 Checkpoint W）                                           | feature flag + native fallback + behavior parity                 |
| R0    | vNext Release Gate        | prework 已实现；release gate `NO-GO`                                               | §2 DoD + §8 verification matrix 全绿                             |

两条轨道的共同结论：Agent 主线已具备可验证的 Suggest-only 与显式 Read-only 能力，
但 release 门尚未满足；Zeus 仍停留在非生产 spike，没有生产依赖或 renderer 接入。

---

## 4. 关键设计机制（"为什么这样做"）

### 4.1 Secret 永不落盘（三层防御）

数据库密码是 desktop SQL 客户端最敏感的字段。AGENTS 给的是**纵深防御**，而不是单点检查：

1. **类型层**：`ConnectionSecret` 与 `ConnectionProfile` 是两个不同的 struct。Profile 进入持久化、Secret 仅留在 `ConnectionManager.last_secret_by_id` 的 HashMap 里（runtime memory）。
2. **持久化层**：`persistence_v2::load_from` 解析 JSON 后**立即**对每条 profile 调用 `obj.remove("password" / "secret" / "credentials")`。这是显式剥字段，无论调用方是否传入都会清掉。
3. **UI 层**：`SqlConnectionFormController.submit()` 在 `finally` 里强制 `widget.clearSecret()`；Form Widget 不允许保存秘密；Backend 的 `sql_test_connection` 做完即关，不残留 secret。

加上 Logging Policy：Rust 端 `ConnectionSecret::redacted_string()` 返回 `redacted:N fields`；前端日志门禁在 CI 层 grep `console.log(secret)`。

**效果**：

- 用户输错密码 → error toast 出现 → saved profile 文件中无 `password` 字段（CI 验证）；
- 程序退出 → 内存中的 `last_secret_by_id` 丢失 → 下次仍要重新输。

### 4.2 Driver ≠ Dialect（multi-database 解耦）

```text
DriverId     → 负责 "开连接 / metadata / 执行"
                ├── Sqlite     (rusqlite)
                ├── MySql      (mysql crate 或 opt-in validation)
                └── Postgres   (open() 永远 early-return planned)

SqlDialect   → 负责 "语法层（注释 / 引用符 / safety guard）"
                ├── Sqlite
                ├── Mysql
                └── Postgres
```

Phase 09（PG）会同时加：

- `drivers/postgres.rs`（开 PG 连接）
- `dialects/postgres.rs`（`"` 引用符、`*` 占位符等）

但**只用一个** `CapabilityGuard` 与一组 service。这是 Phase 01/02 设计约束的回报：**没有把 driver-specific 逻辑写进 contrib 层**。

### 4.3 Runtime Status 单一源

`runtime_status/` 是被所有上层 phase 消费的 surface。AGENTS 写："Phase 00 单独的标签 `已具备雏形`：代表 runtime status 表是稳定的 source-of-truth"。

- `DriverId → RuntimeStatus` 映射在 `assert_driver_status_at_least(id, minimum)` 单点硬编码；
- 前端 `ISqlDriverCatalogService` 镜像同一份；
- UI 拿不到 ≥ minimum 就**双重防御**（Form Controller + backend guard）拒绝提交；
- Phase 08 §2.7 README 中的 "SQLite MVP stable / MySQL Preview / Postgres Planned" 文本必须与该表**字面一致**——`test:branding` 与 `test:sql-runtime-status` 是这条不变量的回归门禁。

### 4.4 Read-only 三段防御

```text
UI form       ─►  read_only checkbox       (默认 false)
Frontend      ─►  readOnly 字段一起          (server 不依赖)
Rust           ─►  dialect.check_read_only   (DDL/Mutation 拒)
Driver         ─►  PRAGMA query_only /      (DB 层兜底)
                  read-only transaction
```

Phase 03 §2.3 详细列出 11 类被拦截的语句（`DROP / CREATE / ALTER / TRUNCATE / VACUUM / ATTACH / DETACH / INSERT / UPDATE / DELETE / WITH` 视为 SELECT 允许）。Read-only 不拦截 `PRAGMA / SELECT / BEGIN / COMMIT` 这些安全语句。

### 4.5 Capability 一统（plugin / AI / future Agent 共用）

`SqlCapability`（plugin API 以 `SqlStudioPluginCapability` re-export）声明
`database.readMetadata / executeRead / executeWrite / explain / readResultShape /
readResultSample / workspace.readSql`、filesystem、network 与 `agent.tool`，Agent 侧复用同一组
wire 字符串，Rust policy 再把它们映射到同一张 capability 表。Phase 06 的 AI service 另有
request validation。边界因此是：

```text
plugin / agent / ai / mcp tool
        │
        ▼
┌──────────────────────────┐
│ canonical capability     │   ← plugin / AI / Agent 共用声明；
│ + Rust Policy Engine     │      每次 tool call 在 backend 重新授权。
│   `agent/policy.rs`      │
└──────────────────────────┘
```

- 现有 capability declaration 不授予 `ConnectionSecret`；Agent 只使用 opaque connection id；
- capability 词表在前端单点收敛于 `services/sql/common/sqlCapabilities.ts`，plugin API 与 Agent
  bridge 只 re-export 或映射；
- **A2 已把 enforcement 落到 Rust**：`AgentPolicy::authorize` 在模型/工具边界重新判定
  mode 与 capability——manifest、prompt 或模型输出都无法自行发明一个 capability，也无法在
  Suggest-only 下提前调用尚未启用的查询工具；
- **A3 用独立入口隔离提权路径**：`AgentPolicy::authorize_read_only` 只放行 `index.list`、
  `sql.explain`、`sql.executeReadonly`、`result.inspect`、`result.sample`，并要求
  `AgentMode::ReadOnly`；A2 那条普通 `authorize` 路径只服务 Suggest-only 的 metadata /
  schema 工具，仍然零 query call。

仍存的偏差：capability 字面量目前在 TS（declaration）与 Rust（`agent/policy.rs`）各有一份，
靠 conformance 测试对齐，而不是由 schema 代码生成。收敛方式留给后续阶段，不在 A2/A3
范围内。

### 4.6 AI "never auto-execute"

Nyala 的 AI 不是聊天框，是 SQL draft 生成器。Phase 06 的硬约束：

- Provider **只**生成 draft text；
- UI **必须**由用户确认插入到 editor；
- 插入后再走 `SqlEditorExecutionController.run(...)`，走 Phase 03 的 read-only / dialect 校验；
- AI 的"dialect context builder"只读 `ISqlMetadataService.listColumns / SqlEditorInput.state.draft / ResultOutcome`，不写。

A3 的 Read-only Agent 是这条约束的**受控例外**，而不是它的松动。用户显式切到 Read Only
mode 后，Agent 才被允许对**显式标记为 read-only 的 SQLite 连接**执行**单条**只读语句：

```text
AgentMode::ReadOnly
  → AgentPolicy::authorize_read_only   (mode + capability + 参数 schema)
  → analyze_sql                        (statement_count == 1 且 risk ∈ {ReadOnly, ExplainReadOnly})
  → connection.kind == Sqlite && connection.read_only   (连接必须是显式只读)
  → PRAGMA query_only / read-only transaction           (DB 层兜底)
```

写语句、多语句、非只读连接、非 SQLite driver 一律 deny。**默认 evidence 不含结果行**：只读执行
返回的是 result shape / aggregate / plan（`Workspace` 敏感度）加上一个 `resultRef`；真实行数据
只在用户显式授予 `database.readResultSample` 后才产出，且标记为 `Sensitive` 并受行数/字节上限
截断。Write / AllowWritesWithApproval 这两条模式在 A2/A3 中**没有**开放工具集。

### 4.7 Plugin API MVP（13 类 contribution points）

`phase-07-plugin-api-mvp.md §1` 列出的 13 类 CP：

```text
commands / sqlActions / views / panels /
menus / keybindings / settings /
snippets / formatters /
resultViewers / exportProviders /
aiProviders / dialects  (Phase 11 预留)
```

两条不能动的铁律：

1. **local-only** —— 只允许 `import('./relative/path')`，禁止 http fetch；
2. **capability 强制** —— 不声明 `accessSecrets` / `readMetadata` 等 caps 就**根本**调不动。

### 4.8 SQLite demo flow 的商业考量

Phase 08 §2.2 的 `sql_bootstrap_demo` 体现一个产品决策：**第一次启动之前用户就能跑 SELECT**。

- 自动在 `<DATA>/nyala-studio/demo.db` seed `users / orders`；
- 自动 register `Demo (SQLite)` connection（`id=demo-sqlite`）；
- Welcome 视图把"Open demo database" 设为 primary action；
- Tauri bootstrap 幂等复用现有文件且不主动覆盖；30 天刷新只属于显式运行的 Node helper。

这套流程替代了 onboarding wizard（"选 driver → 填 host → 输密码"），把"价值时刻"提前到第二屏。

---

## 5. 测试与发布门禁

### 5.1 测试金字塔

```text
                    ┌────────────────────────────────┐
                    │pnpm run test  (CI / local gate)│
                    └────────────────────────────────┘
                                  │
                 ┌────────────────┴────────────────────┐
                 │                │                    │
┌──────────────┐ ┌──────────────┐ ┌──────────────────┐ ┌──────────────┐
│     Rust     │ │   Frontend   │ │  Cross-cutting   │ │  vNext gate  │
│  cargo test  │ │  SQL suites  │ │branding / runtime│ │attestation / │
│    --lib     │ │   9 suites   │ │    / icons /     │ │ benchmark /  │
│ 534 +2 ign.  │ │  671 cases   │ │    seed-demo     │ │  webdriver   │
└──────────────┘ └──────────────┘ └──────────────────┘ └──────────────┘
```

| 类别                        | 命令                                   | 2026-09-17 实测                                                                                                            |
| --------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 全量                        | `pnpm run test`                        | 28 个 step：release/workflows/branding/icons/runtime-status/seed-demo + Rust + Agent + Z1/A4 证据脚本 + 9 个前端 SQL suite |
| Branding                    | `pnpm run test:branding`               | Nyala 命名一致性                                                                                                           |
| Runtime status              | `pnpm run test:sql-runtime-status`     | 26/26                                                                                                                      |
| Services（纯逻辑层）        | `pnpm run test:sql-services`           | 111/111                                                                                                                    |
| Domain（dialect / drivers） | `pnpm run test:sql-domain`             | 20/20                                                                                                                      |
| Connections                 | `pnpm run test:sql-connections`        | 171/171                                                                                                                    |
| Editor                      | `pnpm run test:sql-editor`             | 77/77                                                                                                                      |
| Result                      | `pnpm run test:sql-result`             | 84/84                                                                                                                      |
| History                     | `pnpm run test:sql-history`            | 29/29                                                                                                                      |
| Product                     | `pnpm run test:sql-product`            | 80/80                                                                                                                      |
| Advanced                    | `pnpm run test:sql-advanced`           | 97/97                                                                                                                      |
| Agent 输出契约              | `pnpm run test:sql-agent`              | Rust `commands::sql::agent` 子集 265/265 + TS `sqlCapabilities` 2/2                                                        |
| Z1 gate verifier            | `pnpm run test:sql-result-grid-gate`   | 61/61                                                                                                                      |
| A4 Checkpoint W verifier    | `pnpm run test:sql-agent-checkpoint-w` | 60/60                                                                                                                      |
| R0 release verifier         | `pnpm run test:sql-mvp-vnext-release`  | 35/35                                                                                                                      |
| MySQL integration（opt-in） | `pnpm run test:mysql-integration`      | 默认 ignore；带 `NYALA_TEST_MYSQL_*` env 才跑                                                                              |

> 计数于 2026-09-17 在 `882ba222` + 未提交 vNext 工作树上重测：`cargo test --lib`
> 534 passed / 0 failed / 2 ignored；9 个前端 SQL suite 合计 671 cases；runtime-status 26/26；
> Z1 / W / R0 三个 gate verifier 分别 61 / 60 / 35 全绿。

### 5.2 发布门禁（CI 与本地同源）

```bash
pnpm run lint            # eslint src/**/*.ts
pnpm run build           # vite build
pnpm run rust:fmt        # --check
pnpm run rust:check      # cargo check
pnpm run rust:clippy     # -D warnings
pnpm run test            # 全量：见 §5.1 的 28 个 step
```

`AGENTS.md` 要求 CI 以 `-D warnings` 跑 `rust:fmt` 与 `rust:clippy`。**因此
`clippy::needless_pass_by_value` 之类的 warning 在 IPC 命令签名上是已知且必需的**
（tauri 端 owned-by-value 是 IPC surface 约束），会在源头 `#![allow(...)]` 显式豁免，
**禁止进一步扩散**。

自 MVP vNext 起，`pnpm run test` 不再只是"branding + runtime-status + Rust + 8 个前端
suite"：它同时驱动 release/workflow 校验、SQL Agent 输出契约、Z1 的 benchmark /
WebDriver / attestation / visual harness，以及三个 fail-closed verifier。三者共同构成
**产物绑定的准入证据链**——verifier 只接受与 revision 绑定、由受保护 GitHub Environment
产出的 attestation，手写的 `GO` 文档会被判为 `NO-GO`：

```text
verify:sql-result-grid-gate    → phase-z1-gate.json           (需要 sql-result-grid-z1-gate)
verify:sql-agent-checkpoint-w  → phase-a4-checkpoint-w.json   (需要 sql-agent-checkpoint-w)
verify:sql-mvp-vnext-release   → phase-vnext-release-gate.json(需要 sql-mvp-vnext-release)
```

### 5.3 "Definition of Verification"（AGENTS 强制条款）

> Before claiming a task complete, run the relevant subset and report exact commands + exit status. If a check cannot run, say so explicitly. Never assert "build passes" without showing the command and its exit code.

所以 agent 在本仓库"答完"一个任务时，必须附**实际跑过的命令 + exit code**——不能只断言"应该通过"。这是文档里反复出现的条款（AGENTS、phase-04 §8.5、phase-08 §4）。

---

## 6. 进阶：phase doc 中"设计 vs 实装的偏差"

AGENTS 要求"读 `phase-XX` 文件时同时看 §8 实现状态说明"。两条典型偏差值得提：

### 6.1 v1 + v2 双栈并存（phase-01 §8.1）

`docs/sql-mvp-phases/phase-01-connection-mvp.md` §8.1 明确：phase 01 的 V2 体系**已完成**，但 phase 00 的 V1 体系**未删**（因为 phase 02/03/04 还在消费 V1 的 `SqlConnection`）。

- Rust：`SqlConnectionStore`（V1）+ `ConnectionManager`（V2）都活着；
- Tauri commands：`sql_test_connection / sql_open_connection / sql_list_connections`（V1）+ `sql_*_v2`（V2）共存；
- Frontend：`ISqlConnectionService`（V1）+ `ISqlConnectionServiceV2`（V2）共存；
- lib.rs `invoke_handler` 同时注册两套。

迁移策略：phase 后续把上层 consumer 全部切到 V2 之后才能删 V1——**禁止一次性删**。

### 6.2 backend wire format 未重写（phase-04 §8.1）

phase-04 §2 设计 `SqlColumnDto / SqlCellDto / SqlQueryResponseDto / SqlQueryOutcomeDto / DriverRowSet` 这一套"统一 DTO"未实现。实装沿用 phase-03 的 V1：

> 推迟理由：V1 已经 `cargo test sql` 119/119 绿，重写 DTO 等于删已绿代码；且 V2 service 与 V1 service 在 caller 视角下都满足前端需要。**建议在多 driver（PostgreSQL / MySQL）接入时统一重构 driver trait。**

这条**记录在 phase 文档里而非悄悄实施**——是 AGENTS "不要做未计划重写"原则的体现。

---

## 7. 路线图与未决事项

- **SQL Workspace Agent（vNext 活跃轨道）**：本地 Rust Agent Runtime、Schema Context、
  Tool/Policy/Evidence 边界及 `Agent Stage A0-A8` 的可验收演进见
  [`sql-workspace-agent-design.md`](./sql-workspace-agent-design.md)。这些 Stage 不是
  SQL MVP Phase 续号，也不改变 Phase 08 或 driver runtime status。当前 A0–A4 已实现，
  A5（SQLite 查询优化建议）作为 post-vNext 范围落地但**不在 release 依赖链**上
  （`performanceVerified=false` / `semanticsVerified=false`）；仍未闭环的是 A4
  Checkpoint W 的原生键盘、Windows WebView2 与真实 VoiceOver / Narrator 走查。

- **vNext 发布门禁的 CI 前置条件**：三个 fail-closed verifier 都要求受保护的默认分支，并引用
  `sql-agent-checkpoint-w`、`sql-result-grid-z1-gate`、`sql-mvp-vnext-release` 三个 GitHub
  Environment。2026-09-17 复核时仓库 environments 为 `total_count = 0`、三个 attestation workflow
  的 runs 也都是 0；但这些 workflow 只使用 `secrets.GITHUB_TOKEN`，而 GitHub 文档（2026-09-18 取得）
  写明引用不存在的 environment 会在运行时自动创建且不附加 protection rules/secrets——所以「environment
  未创建」**不是**阻塞，人工预建只换来 required reviewers 这层纵深保护。真正阻塞的是待在受保护分支
  `mvp` 落地的本地 driver/verifier 修复、Z1 性能门与 Checkpoint W 人工证据：因此
  `docs/sql-mvp-phases/phase-z1-gate.json` 与 `phase-vnext-release-gate.json` 都停在 `NO-GO`，与本地
  脚本全绿并不矛盾。

- **Zeus Data Grid（非生产 spike）**：Z1.1/Z1.2 的审计与 benchmark 已完成，Z1.3 因
  5 个预登记 v6 性能门失败而判 `NO-GO`。v6 的 required 目标恒为 `0.8 × baseline`，
  而 p95 不低于同一 post-presentation floor，因此隐含要求 `baseline ≥ 1.25 × floor`；
  现存 evidence 的 `baseline / floor` 为 `1.011–1.237`（六组；追加 real WorkbenchTable r5 后为七组、
  `0.989–1.237`），全部不满足（最优一组假设
  renderer 零成本也只有 `19.62%`，低于 20% 门），
  ADR 0004 的 v7 floor-aware metrics 仅为 `Proposed`，不构成准入证据。当前**没有**
  生产 Zeus 依赖或 renderer 接入，**Z2 禁止开始**。

- **Phase 09 – 13**（dev-vault 长程）：

  ```text
  09 PostgreSQL runtime (driver + dialect + cancel + type metadata)
  10 MCP tool permission（一对一映射 Capability）
  11 Pro 插件市场（manifest V2）+ license key + sandbox iframe/VM
  12 Team / 共享 connection
  13 Marketplace 上架
  ```

  上述都不是"重写"，而是"在 Phase 08 闭环上**加横切**"。这是项目稳定期的常态。

- **MySQL Preview → MySQL Stable 的路径**：Phase 08 §2.3 显式 `validation_table_prefix_is_unique_per_pid` 与 `drop_failed` 错误码，未来要把"MySQL Preview validation 通过"作为升级到 MySQL Stable 的前置检查。

- **AGENTS.md `Phase 9` – `Phase 13` 编号**仍有效作为代码路径图，但**不要**再把它们当作新的 phase doc；后续编号 doc 走 dev-vault 长程（`projects/sql-studio-next/roadmaps/...`）。

---

## 8. TL;DR

- **Nyala Studio** = SideX 风格的 Workbench + Tauri Rust + 一个本地优先 SQL 客户端。
- **分层**：壳不动、产品 SQL 全集中在 `contrib/sql*` 与 `services/sql*`、`src-tauri/src/commands/sql/`。
- **MVP 闭环**：Phase 00–08 串成 9 步链；DoD 10 条针对代码基线 `c03f1a4b` 验证，并由 `60ab89c0` 提交报告。
- **vNext 轨道**：Phase 08 之后由 `mvp-vnext-agent-zeus-roadmap.md` 接管，Agent A0–A5 已实现；
  Zeus Z1.3 因 5 个 v6 性能门失败判 `NO-GO`，Z2 禁止开始，R0 保持 `NO-GO`
  （另缺 3 个受保护 GitHub Environment）。
- **安全姿势**：Secret 三层防御（类型 / 持久化剥字段 / widget clearSecret finally）；Read-only
  三段防御；capability 词表 plugin / AI / Agent 共用，并在 Rust policy 边界重新授权
  （A2 已落地，Suggest-only 是强制 mode 而非产品承诺）；AI 默认 never auto-execute，只有显式
  Read Only mode + 显式只读 SQLite 连接才执行单条只读语句。
- **测试**：Rust 与 frontend 分层测试、静态验证脚本及 opt-in MySQL integration；`pnpm run test` 是默认统一门禁，准确数量以最新验证输出为准。
- **纪律**：phase 之间是严格 `00 → 01 → … → 08` 顺序，vNext 之后按依赖图推进
  （`A0/A1 → A2 → A3 → A4` 与 `Z0 → Z1 → Z2 → R0`，Z2 必须先拿到 Z1 Go + A4
  Checkpoint W）；任何上游清理都在保留扩展点（contribution / service / 命令）的前提下做，
  不删 SideX 架构本身。

参考阅读顺序（最短路径）：

```text
AGENTS.md
└─ docs/sql-mvp-phases/README.md
   ├─ phase-00-runtime-status.md          (status surface)
   ├─ phase-01-connection-mvp.md          (secret 三层防御 + 持久化剥字段)
   ├─ phase-02-metadata-explorer.md       (driver trait + tree model)
   ├─ phase-03-editor-execution.md        (dialect + execution controller)
   ├─ phase-04-result-panel.md            (四态 outcome + copy)
   ├─ phase-05-history-formatter-snippets-explain.md
   ├─ phase-06-ai-helper-foundation.md    (deterministic + capability boundary)
   ├─ phase-07-plugin-api-mvp.md          (13 类 CP + local-only loader)
   ├─ phase-08-mvp-packaging.md           (demo flow + MySQL Preview validation)
   └─ phase-do-d-verification.md          (10 条 DoD 实证)
├─ docs/sql-mvp-phases/mvp-vnext-agent-zeus-roadmap.md  (当前活跃范围与门禁)
│  ├─ phase-z1-spike-verification.md     (Z1.3 NO-GO 的完整证据)
│  └─ phase-a4-workbench-verification.md (Checkpoint W 缺口)
├─ docs/adr/0003-sql-agent-parser-boundary.md           (A0.2 parser No-Go 决策)
├─ docs/adr/0004-zeus-data-grid-v7-floor-aware-metrics.md (Proposed，未生效)
├─ docs/sql-workspace-agent-design.md     (Agent Stage A0-A8 演进规格)
└─ docs/sql-workspace-agent-a5-implementation-plan.md   (post-vNext A5 计划)
```
