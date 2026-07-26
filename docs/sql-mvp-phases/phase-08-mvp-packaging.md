# Phase 08 — MVP Packaging & Demo Flow

## 0. 摘要

把 Phase 00–07 拼起来，形成：

1. 一条 **SQLite demo flow**：本地 demo.db / demo seeds，用户启动 Nyala 后 60 秒内能跑通完整闭环。
2. 一条 **MySQL Preview opt-in validation flow**：用户在连接表单选 MySQL 并填写 host/port/database/username（账户需要时再填 password）后，可执行 Test / Validate / Connect；Validate 通过专用瞬时命令连接、跑 `SELECT 1`、跑 `CREATE / INSERT / SELECT / DROP` 临时表。`NYALA_TEST_MYSQL_*` 只用于 opt-in 集成测试，不控制 UI 是否显示。
3. **全量 check**：每次 release 前 `pnpm run test` 一把过；CI 强制要求。
4. **SQL-first 默认体验**：SQL Connections 是初始 Activity Bar；Welcome view 默认落地到 "Connect → Run"。

不在范围：

- 不接 PostgreSQL（仍是 planned）；
- 不写用户手册（仅 README 增量）；
- 不签发证书 / 自动更新（→ Phase 11）。

## 1. 范围

- 提供一个示例 `demo.db`，内置 `users / orders` 两个表，含 5 行 users 与对应 orders；
- 提供 onboarding flow（首次启动自动 Demo + Welcome ViewPane）；
- 启动时自动 register 一个 example snippet 集合；
- README 新增 "Release readiness" 一节；
- CI 增加 release gate：`pnpm run test` + `pnpm run lint` + `pnpm run build` + `pnpm run rust:check` + `pnpm run rust:clippy` + 自定义 mysql-integration opt-in。

### 当前状态（2026-07-26）

- Demo seed、V1/V2 兼容注册、Welcome ViewPane、Connect 表单优化、瞬时 MySQL validation 与 release gate 均已实现并有自动化覆盖。
- Phase 08 仍为**部分完成**：Windows/Tauri 实机 Demo → query panel walkthrough 已记录通过，仅 live MySQL validation 尚未验收，详见 §4。

## 2. 设计

### 2.1 Demo DB Seed

运行时 seeder 位于 `src-tauri/src/commands/sql/demo_seed.rs`：

- 在 `NYALA_DATA_DIR/demo.db` 或平台数据目录的 `nyala-studio/demo.db` 创建 `users` / `orders`；
- 使用 `CREATE TABLE IF NOT EXISTS` 与 `INSERT OR IGNORE`，重复启动不会重复数据；
- 应用内 bootstrap 不删除已存在的 demo 文件，避免覆盖用户在示例库中的修改；
- `scripts/seed-demo-db.mjs` 是 Node 22+ 的开发 / CI helper，并保留 30 天刷新策略，不参与 Tauri 启动路径。

### 2.2 Tauri Demo Bootstrap

`sql_bootstrap_demo` 同时接收 V2 `SharedConnectionManager` 与 V1 `SqlConnectionStore`，使用同一个稳定 profile id `demo-sqlite`：

1. seed 或复用 demo.db；
2. 在 V2 manager 中 upsert 并打开 profile；
3. 在 V1 store 中保存并打开同一 profile，设置 `auto_connect=true`；
4. 返回路径、是否复用、连接状态与 profile id。

当前 metadata tree 与 query 主链仍消费 V1，较新的连接生命周期消费 V2，因此双注册是明确的兼容桥，不代表要长期保留两套连接栈。两边都只保存 SQLite 公共字段，不写 secret。

### 2.3 MySQL Preview Opt-in Validation

`sql_validate_mysql_preview(input, secret)` 是专用瞬时命令：

- `input` 只含 host / port / database / username / sslMode；可选 password 独立放在 `ConnectionSecret`，兼容无密码账户；
- command 不调用 V1/V2 的 open/save，也不创建持久化 profile；
- 后端校验 host / port / database / username 与端口范围后创建短生命周期 MySQL pool；
- 依次执行 `SELECT 1`、唯一临时表的 `CREATE / INSERT / SELECT / DROP`；
- 表名包含 pid 与进程内递增序号；失败路径执行 best-effort `DROP TABLE IF EXISTS`；
- 连接错误、DDL、insert、select、drop 错误保留结构化 code 到前端。

成功报告要求 `selectOk && ddlOk && droppedTable` 全部为 true，并明确提示 Preview 暂不支持 query cancellation。

### 2.4 Frontend Demo Bootstrap

首次启动计划由 `createSqlProductStartupPlan` 生成，`SqlProductBootstrapContribution` 依序执行：

1. `sqlStudio.product.bootstrapDemo`；
2. 聚焦 Connections 与 Results；
3. 聚焦 Welcome ViewPane；
4. 打开默认 SQL query。

Demo action 通过 `ISqlProductService.bootstrapDemo()` 访问 Tauri command；任何步骤失败都会抛出并阻止写入 `SQL_PRODUCT_BOOTSTRAPPED_STORAGE_KEY`。默认偏好已开启 first-launch Welcome，用户仍可关闭。

### 2.5 Connect 与 MySQL Validation UI

`MysqlPreviewValidationController` 只依赖 `ISqlProductService`，把表单的公开字段与瞬时 secret 分开转发。Connect 页面提供：

- SQLite File / In-memory 模式；
- SQLite、MySQL、disabled PostgreSQL 的 connector 选择；
- Test / Validate / Connect 三个明确动作；
- host / port / database / username 实时必填与端口校验（password 可选）、busy guard、窄侧栏响应式布局；
- 所有操作结束后清空 password；
- 保存 MySQL 时复用已打开连接的 id，保存失败会 best-effort 关闭刚打开的连接。

### 2.6 Welcome Flow

Welcome 已实现为注册在 SQL Results container 的 `SqlProductWelcomePane`，四个 action 分别路由到 Demo、展开 New connection 表单、History 与 Command Palette。首次启动默认打开；`Add a connection` 会聚焦并展开 Connect 表单，而不是只聚焦容器。

### 2.7 README 与 Release Gate

Root `README.md` 记录 SQLite Demo Flow、完整本地 release commands 与 opt-in MySQL integration。CI 通过 `.github/workflows/sql-mvp-gate.yml` 在 `main` / `mvp` 的 push 与 PR 上执行同一套 pnpm/Rust gate；`release.yml` 在跨平台打包前调用该 reusable workflow。MySQL live flow 仅在手动 opt-in 时启动隔离 MySQL service。

### 2.8 主要实现文件

```txt
scripts/seed-demo-db.mjs
src-tauri/src/commands/sql/demo_seed.rs
src-tauri/src/commands/sql/product.rs
src-tauri/src/commands/sql/mysql_validation.rs
src/vs/workbench/services/sql/common/sqlProduct.ts
src/vs/workbench/services/sql/browser/sqlProductService.ts
src/vs/workbench/contrib/sqlConnections/browser/sqlConnectionsView.ts
src/vs/workbench/contrib/sqlConnections/browser/mysqlValidationView.ts
src/vs/workbench/contrib/sqlConnections/common/sqlConnectionSubmission.ts
src/vs/workbench/contrib/sqlProduct/browser/sqlProductBootstrap.ts
src/vs/workbench/contrib/sqlProduct/browser/sqlProductWelcomePane.ts
.github/workflows/sql-mvp-gate.yml
```

## 3. 自动化验证

2026-07-26 当前工作树的定向结果：

| 检查                                | 结果                 | 覆盖重点                                                                                                 |
| ----------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| `pnpm run test:seed-demo`           | 7/7                  | 平台数据目录解析，以及重复 seed 保留与 seed 同值的用户订单                                               |
| `cargo test --lib demo_seed`        | 6/6                  | seed、幂等复用、用户订单保留、V2 open、V1 查询                                                           |
| `cargo test --lib mysql_validation` | 9 passed / 1 ignored | 输入、端口、TLS、共享网络超时、唯一表名、错误 code、清理失败告警；live contract 默认忽略                  |
| `pnpm run test:search`              | 2/2                  | Tauri search cancellation race                                                                           |
| `pnpm run test:sql-services`        | 69/69                | Product service、错误映射、driver catalog、V2 连接刷新事件                                               |
| `pnpm run test:sql-connections`     | 112/112              | Connect form、strict refresh、保存同 id、失败清理、validation                                            |
| `pnpm run test:sql-result`          | 58/58                | 结果模型、复制、状态与稀疏数值列可见性                                                                   |
| `pnpm run test:sql-history`         | 28/28                | History 模型、服务、ViewPane 生命周期                                                                    |
| `pnpm run test:sql-product`         | 65/65                | first-launch plan、Welcome、startup splash、zoom                                                         |
| `pnpm run test`                     | exit 0               | 默认完整回归：branding、runtime status、Rust 176 passed / 1 ignored、Search 2/2 与全部 SQL 前端 suites   |

本轮还完成了 `pnpm run lint`、`pnpm run build`、`pnpm run rust:fmt`、`pnpm run rust:check` 与 `pnpm run rust:clippy`，均 exit 0。live MySQL 仍为 opt-in，不计入默认单元测试通过数。

Windows/Tauri 原生走查（2026-07-26）exit 0：

- Connect 表单显示 SQLite Stable、MySQL Preview 与 disabled PostgreSQL Planned；MySQL 的 password 可选，必填字段完整后 Test / Validate / Connect 可用；
- 连续两次 `sql_bootstrap_demo` 都连接同一个 `demo-sqlite`，树中出现 `users / orders`；
- `SELECT COUNT(*) FROM users` 返回 5；JOIN 返回 Alice 100/250、Bob 80、Carol 40/110；
- COUNT 与 JOIN 数值列均保持 160px，可在当前 viewport 直接看到；
- `console_errors=[]`、`page_errors=[]`，History toolbar 生命周期错误未复现。

## 4. 验收

- [x] `pnpm run test:seed-demo` 7/7 通过；
- [x] `cargo test --lib demo_seed` 6/6 通过；
- [x] `cargo test --lib mysql_validation` 9 passed / 1 ignored；
- [x] `pnpm run test:sql-product` 65/65 通过；
- [x] `pnpm run test:sql-connections` 112/112 通过；
- [x] `pnpm run test:sql-result` 58/58 通过；
- [x] Rust bootstrap 测试验证 Demo 同时进入 V1/V2，且 V1 查询 `users` 返回 5；
- [x] CI/release workflow 强制执行 pnpm + Rust gate，并提供 live MySQL opt-in；
- [x] 启动 Nyala Studio，自动出现 `Demo (SQLite)` 连接与 `users / orders`；
- [x] 跑 `SELECT COUNT(*) FROM users` 返回 5；
- [x] 跑 `SELECT u.name, o.amount FROM users u JOIN orders o ON u.id=o.user_id` 在 panel 出现 5 行；
- [ ] 选择 MySQL Preview 并填 host/port/database/username（账户需要时填写 password），点 Validate，live MySQL 返回成功报告与 cancellation warning。

## 5. 风险

| 风险                        | 缓解                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Demo db 被意外覆盖          | Tauri bootstrap 只做幂等 seed，不删除已有文件；30 天刷新仅存在于显式运行的 Node helper。                       |
| V1/V2 profile 漂移          | 两边使用稳定 id `demo-sqlite`，bootstrap 幂等测试同时检查两个 store。                                          |
| MySQL validation 留下临时表 | 表名使用 pid + sequence；成功必须完成 DROP，失败路径执行 best-effort `DROP TABLE IF EXISTS` 并保留结构化错误。 |
| Welcome 抢编辑器焦点        | 仅首次启动默认出现，可通过 product preference 关闭；bootstrap 全部成功后才写完成标记。                         |
| MySQL Preview 取消不支持    | UI 持续展示 cancellation warning，默认 release gate 不把 live MySQL 当作普通单测。                             |

## 6. 与下游接口

- Phase 09（PG）会复用 `bootstrap` 模板，新增 PG 部分。
- Phase 11（Pro）会引入 license key 与 demo 试用有效期；demo 路径不变。
- Phase 12（Team）会改 `connections.list()` 数据源，但 demo 行为不被替代。

## 7. DoD

- [x] 真有 demo db 自动 seed；
- [x] 真有 Welcome ViewPane 与默认 first-launch onboarding；
- [x] 真有瞬时 MySQL Preview validation 短链；
- [x] 真有 README release checklist 与 CI release gate；
- [x] 真有 Phase 00–07 自动化回归覆盖；
- [x] 真有 Tauri 实机 Demo → query panel walkthrough 记录；
- [ ] 真有 live MySQL Preview validation 记录。
