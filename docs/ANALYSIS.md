# Nyala Studio — 项目核心思路分析

> 范围：`sql-studio-next`（Nyala Studio）的总体设计定位、架构骨架、MVP 阶段路线、关键设计机制、测试与发布门禁。
> 参考来源：`README.md`、`package.json`、`docs/sql-mvp-phases/README.md`、`docs/sql-mvp-phases/phase-00..phase-08.md`、`docs/sql-mvp-phases/phase-do-d-verification.md`、`AGENTS.md`。
> 本文件不重复列每条 phase 的逐文件清单（`docs/sql-mvp-phases/*.md` 已写明），只梳理"为什么这样做"。

---

## 1. 一句话定位

> **Nyala Studio = SideX / VS Code 风格 Workbench 壳 + Tauri Rust 后端 + 一个本地优先（local-first）的 SQL 客户端，再叠加一条为 SQL 工作台设计的扩展 / AI 注入点。**

它不是"另一种数据库工具"，也不是"另一种 IDE"。

- 它**借壳**于 SideX（VS Code 式 Workbench），换来"Activity Bar / Side Bar / Editor Area / Panel / Status Bar / Commands / Services / Contributions"这一整套已被工业验证的产品骨架；
- 它**内置** SQL 客户端：连接管理、Schema Explorer、SQL Editor、Query Result Panel、History、Formatter / Snippets / Explain、AI Helper；
- 它为后续 SQL 扩展系统、AI Agent、MCP 之类的接入预留了 13 类 Contribution Point 与统一 Capability。

与 DataGrip / DBeaver / TablePlus 等通用 SQL 工具的差异：

| 维度 | 通用 SQL 工具 | Nyala Studio |
| --- | --- | --- |
| 形态 | 客户端 GUI / 桌面 app | 复用了 Code - OSS / VS Code Workbench（活动栏、Panel、Keybinding、Palette） |
| 定位 | 数据库工具 | "SQL-first 的 Workbench"——壳本身是 SQL-first，Workbench 模型只用作宿主 |
| 扩展 | 自家 plugin 或没有 | Phase 07 已经在壳里塞入 13 类 contribution point（commands / sqlActions / views / panels / menus / keybindings / settings / snippets / formatters / resultViewers / exportProviders / aiProviders / dialects） |
| AI | 通常外置 | Phase 06 起把 AI 当一等公民：基于统一 Capability Guard，不允许自动执行 |
| 安全 | 通常混淆 | Secret 永不落盘，三层防御（持久化剥字段、redacted 展示、widget `clearSecret` finally） |

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
│  CapabilityGuard / Plugin Registry / Bootstrappers            │
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

| 层 | 路径 | 角色 |
| --- | --- | --- |
| 类型 | `commands/sql/types.rs` | `ConnectionProfile / ConnectionSecret / DriverIdDto / SqlCommandError / SqlQueryResult` 等共享 DTO |
| 持久化 | `commands/sql/persistence_v2.rs` | **剥字段持久化**：`password / secret / credentials` 在 load 时就被剔除；该模块只依赖 `ConnectionProfile`，不接收 `ConnectionSecret` |
| 运行时 | `commands/sql/connection_manager.rs` + `commands/sql/state.rs` | V2 `ConnectionManager` 管理持久 profile、运行时 driver 与内存 secret；`state.rs` 保留 V1 compatibility store |
| Driver Registry | `commands/sql/driver_registry.rs` + `commands/sql/mysql_runtime.rs` | SQLite / MySQL driver 实现与 PostgreSQL planned guard；driver trait 负责连接、测试及 metadata 能力 |
| Query 执行 | `commands/sql/query.rs` + driver runtime | V1 command 与 V2 driver 路径最终都返回结构化 query result / error |
| Metadata | `commands/sql/metadata.rs` + `metadata_v2.rs` | schemas / tables / columns 的命令实现 |
| Dialect | `commands/sql/dialect.rs` | 读 `DriverId` 得 `SqlDialect`；`check_read_only` 拦截 `DROP / DDL / MUTATION` |
| Product | `commands/sql/product.rs` + `demo_seed.rs` + `mysql_validation.rs` | bootstrap demo + opt-in MySQL Preview validation |
| Runtime Status | `runtime_status/` | 单一 source-of-truth：声明 `SQLite=stable, MySQL=preview, Postgres=planned`；被所有上层 phase 消费 |

### 2.4 TS 前端内层结构

| 路径 | 角色 |
| --- | --- |
| `services/sql/common/*.ts` | service 接口（`ISqlConnectionService`、`ISqlMetadataService`、`ISqlQueryService`、`ISqlAiService`、`ISqlDriverCatalogService`、`ISqlCapabilityGuard`）和共享类型 |
| `services/sql/browser/*.ts` | service 实现 + `SqlCommandExecutor` IPC 封装 |
| `contrib/sqlConnections/*` | Connections View：tree、form、template、MySQL validation 视图 |
| `contrib/sqlEditor/*` | SQL Editor tab + Statement Splitter + Execution Controller |
| `contrib/sqlResult/*` | Result Panel + Result Model + Grid View + Copy helper |
| `contrib/sqlHistory/*` | Query History |
| `contrib/sqlAdvanced/*` | Snippets / Formatter / Explain / Plugins / AI Service / Settings |
| `contrib/sqlProduct/*` | Welcome / Bootstrap Model / Profile / Preferences / Splash |

持有 listener / timer / model 等资源的 service 或 contribution 必须统一注册并释放；无状态 service 不需要为了形式而继承 `Disposable`。

---

## 3. MVP 闭环与阶段路线

`docs/sql-mvp-phases/README.md` 把 9 个 phase 串成一条**严格有序**的实现链。最终目标是"启动 Nyala → 60 秒内跑通 SELECT"：

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

`AGENTS.md §Definition of Done` 列出 10 条核心门禁：验证针对代码基线 `c03f1a4b` 执行，报告随后由 commit `60ab89c0` 记录在 `docs/sql-mvp-phases/phase-do-d-verification.md`：

| # | DoD | 证明 |
| --- | --- | --- |
| 1 | Launches as Nyala | `tauri.conf.json`：`productName=Nyala Studio, identifier=com.baicie.sqlstudio, title=Nyala` |
| 2 | SQLite 连接可加 | `connection_v2::tests::open_connection_v2_returns_profile_id` + `state::save_connection_persists_and_lists_saved_connections` + 前端 V2 service 单测 |
| 3 | Tables 可列出 | `metadata_v2::tests::list_tables_for_empty_sqlite_returns_empty` + `state::list_tables_and_columns_returns_sqlite_metadata` |
| 4 | SQL editor 可打开 | `sqlEditor.test.ts` + `sqlEditorModel.test.ts` (59/59) |
| 5 | SELECT 可执行 | `state::execute_query_returns_columns_and_rows` + `enforces_row_limit` + `reports_affected_rows_for_mutations` |
| 6 | Result 出现在 panel | `sqlResultModel.test.ts` (57/57) |
| 7 | Invalid SQL 结构化错误 | `execute_query_returns_error_for_invalid_sql` + `read_only_connection_rejects_mutating_sql` |
| 8 | `pnpm run build` | exit 0；产物 `dist/assets/{core,workbench.common.main,workbench.web.main,main}-*.js` |
| 9 | `pnpm run rust:check` | exit 0；额外 rust:clippy 也 exit 0 |
| 10 | `pnpm run test` | branding + runtime-status + cargo test --lib (≥145) + 8 个 frontend suite 全绿 |

**意义**：这条核心闭环证明"SQL-first Workbench"的产品定位已经能被工业验证；后续 Phase 09 – 13（PostgreSQL、ORM、MCP、License、Team、Marketplace）都是在这个闭环之上加横切能力，而不是重写。

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

### 4.5 Capability 一统（plugin / AI / future MCP 共用）

`CapabilityGuard` 不是 "AI 专属"：plugin、agent、AI、未来的 MCP tool 共享同一份 schema。Phase 06 起逐步固化：

```text
plugin / agent / ai / mcp tool
        │
        ▼
┌──────────────────────────┐
│   CapabilityGuard        │   ← 插件声明 caps；运行时校验 caps；
│   (readMetadata,         │      缺 cap 的调用直接拒、不抛 exception。
│    readSqlText, …)       │
└──────────────────────────┘
```

- `accessSecrets` 在 MVP 拒绝给插件（Phase 07 §2.1 `validate(manifest)`）；
- AI Provider 通过 `guard.wrap(provider, capabilities)` 注册到 `ISqlAiRegistry`（Phase 07 §2.3）；
- Phase 10 MCP tool permission 与 Capability **一一映射**。

### 4.6 AI "never auto-execute"

Nyala 的 AI 不是聊天框，是 SQL draft 生成器。Phase 06 的硬约束：

- Provider **只**生成 draft text；
- UI **必须**由用户确认插入到 editor；
- 插入后再走 `SqlEditorExecutionController.run(...)`，走 Phase 03 的 read-only / dialect 校验；
- AI 的"dialect context builder"只读 `ISqlMetadataService.listColumns / SqlEditorInput.state.draft / ResultOutcome`，不写。

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
                       ┌──────────────────────────────┐
                       │ pnpm run test (CI gate)       │
                       └──────────────────────────────┘
                                       │
   ┌─────────────────────┬─────────────┴─────────────┬─────────────────────────┐
   │                     │                           │                         │
┌──┴─────────────┐ ┌─────┴──────────┐ ┌─────────────┴────────────┐ ┌─────────────┴────────────┐
│ Rust           │ │ Frontend       │ │ Cross-cutting            │ │ Scripts                   │
│ cargo test --lib│ │ *sql-* suites │ │ branding / runtime-status│ │ seed-demo-db              │
│ ≥157 tests     │ │ 8 suites / 460+│ │ 2 scripts                │ │ verify-* node 脚本        │
└────────────────┘ └────────────────┘ └──────────────────────────┘ └───────────────────────────┘
```

| 类别 | 命令 | 现行状态 |
| --- | --- | --- |
| 全量 | `pnpm run test` | branding + runtime-status + Rust + 8 frontend suites |
| Branding | `pnpm run test:branding` | Nyala 命名一致性 |
| Runtime status | `pnpm run test:sql-runtime-status` | 16/16 |
| Services（纯逻辑层） | `pnpm run test:sql-services` | 62/62 |
| Domain（dialect / drivers） | `pnpm run test:sql-domain` | 全绿 |
| Connections | `pnpm run test:sql-connections` | 93/93 |
| Editor | `pnpm run test:sql-editor` | 59/59 |
| Result | `pnpm run test:sql-result` | 57/57 |
| History | `pnpm run test:sql-history` | 27/27 |
| Product | `pnpm run test:sql-product` | 42/42 |
| Advanced | `pnpm run test:sql-advanced` | 63/63 |
| MySQL integration（opt-in） | `pnpm run test:mysql-integration` | 默认 ignore；带 `NYALA_TEST_MYSQL_*` env 才跑 |

### 5.2 发布门禁（CI 与本地同源）

```bash
pnpm run lint            # eslint src/**/*.ts
pnpm run build           # vite build
pnpm run rust:fmt        # --check
pnpm run rust:check      # cargo check
pnpm run rust:clippy     # -D warnings
pnpm run test            # 上述全部 + rust cargo test --lib
```

`AGENTS.md` 写："CI runs `pnpm run rust:fmt` and `pnpm run rust:clippy` with `-D warnings`.`**Therefore: `clippy::needless_pass_by_value` 之类的 warning 在 IPC 命令签名上是已知且必需的**（tauri 端 owned-by-value 是 IPC surface 约束），会在源头 `#![allow(...)]` 显式豁免，**禁止进一步扩散**。

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
- **安全姿势**：Secret 三层防御（类型 / 持久化剥字段 / widget clearSecret finally）；Read-only 三段防御；Capability 一统；AI never auto-execute。
- **测试**：Rust 与 frontend 分层测试、静态验证脚本及 opt-in MySQL integration；`pnpm run test` 是默认统一门禁，准确数量以最新验证输出为准。
- **纪律**：所有 phase 之间是严格 `00 → 01 → … → 08` 顺序；任何上游清理都在保留扩展点（contribution / service / 命令）的前提下做，不删 SideX 架构本身。

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
   ├─ phase-06-ai-helper-foundation.md    (CapabilityGuard + deterministic)
   ├─ phase-07-plugin-api-mvp.md          (13 类 CP + local-only loader)
   ├─ phase-08-mvp-packaging.md           (demo flow + MySQL Preview validation)
   └─ phase-do-d-verification.md          (10 条 DoD 实证)
```
