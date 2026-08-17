# Phase 08 — MVP Packaging & Demo Flow

## 0. 摘要

把 Phase 00–07 拼起来，形成：

1. 一条 **SQLite demo flow**：本地 demo.db / demo seeds，用户启动 Nyala 后 60 秒内能跑通完整闭环。
2. 一条 **MySQL Preview opt-in validation flow**：用户在连接表单选 MySQL 并填写 host/port/database/username（账户需要时再填 password）后，可执行 Test / Validate / Connect；Validate 通过专用瞬时命令连接、跑 `SELECT 1`、跑 `CREATE / INSERT / SELECT / DROP` 临时表。`NYALA_TEST_MYSQL_*` 只用于 opt-in 集成测试，不控制 UI 是否显示。
3. **全量 check**：每次 release 前 `pnpm run test` 一把过；CI 强制要求。
4. **SQL-first 默认体验**：Data Sources 是初始 Activity Bar；Connectors 是独立 Activity Bar，Welcome view 默认落地到 "Connect → Run"。

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

### 当前状态（2026-08-11）

- Demo seed、V1/V2 兼容注册、Welcome ViewPane、Data Sources / Connectors 分离、Connect 表单优化、瞬时 MySQL validation 与 release gate 均已实现并有自动化覆盖。
- Windows/Tauri 实机 Demo → query panel walkthrough、隔离 MySQL 8 上的 live command validation，以及 macOS/Tauri 原生连接页 live MySQL Preview Validate 均已记录通过；Phase 08 已具备 **P0 验收覆盖**，详见 §3 与 §4。

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
2. 在 V2 manager 中 upsert 显式只读 profile；已打开 runtime 与目标 profile 不一致时先关闭旧 runtime，再打开只读 runtime；匹配时保留 runtime revision；
3. 在 V1 store 中确保同一只读 runtime 与 `auto_connect=true` saved profile；runtime 已匹配时只刷新持久化信息，偏离或未打开时才通过 `save_and_open_connection` 替换；成功替换会先发布旧 handle 已退休，重复中断并排空旧 SQLite runtime，再向 bootstrap caller 返回；
4. 任一 store 的持久化或打开失败时关闭两条 Demo query runtime；V2 upsert 会恢复失败前的内存 profile，下一次启动可重试迁移；
5. 返回路径、是否复用、连接状态与 profile id。

当前 metadata tree 与 query 主链仍消费 V1，较新的连接生命周期消费 V2，因此双注册是明确的兼容桥，不代表要长期保留两套连接栈。两边都只保存 SQLite 公共字段，不写 secret。
Demo schema/seed 始终先通过独立可写连接完成，产品 runtime 随后才以只读方式打开；因此 Query Editor
仍可执行原有 SELECT/JOIN 流程，但 mutation 会被 V1 safety guard 和 SQLite read-only handle 拒绝。

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
2. 聚焦 Data Sources 与 Results；
3. 聚焦 Welcome ViewPane；
4. 打开默认 SQL query。

Demo action 通过 `ISqlProductService.bootstrapDemo()` 访问 Tauri command；任何步骤失败都会抛出并阻止写入 `SQL_PRODUCT_BOOTSTRAPPED_STORAGE_KEY`。默认偏好已开启 first-launch Welcome，用户仍可关闭。

`SQL_PRODUCT_BOOTSTRAPPED_STORAGE_KEY` 只控制首次 onboarding，不控制 native runtime 生命周期。每个
Workbench 进程都会执行 Demo bootstrap；首次启动继续运行完整 Welcome/layout/New Query 计划，后续启动
只静默恢复 V1/V2 runtime。静默路径不会打开、聚焦或 reveal Data Sources，也不显示成功通知，但会刷新
已实例化的 Data Sources 视图并广播连接缓存失效，让已恢复 SQL Editor 重新读取只读连接状态。历史可写
profile/runtime 会被替换；已经匹配的 V1 runtime 保持原 handle，避免破坏运行中 Agent query 的物理取消。
V1 open/replace/close/save/restore 与 persistence 初始化共享独立 lifecycle mutex，查询和取消不经过该锁；
因此失败回滚不会与并发 close/replace 交错并复活旧 runtime。替换或关闭在返回前会排空已进入 SQLite VM、
正在等待连接锁，以及已通过 active check 但尚未进入 VM 的旧查询。

### 2.5 Connect 与 MySQL Validation UI

`MysqlPreviewValidationController` 只依赖 `ISqlProductService`，把表单的公开字段与瞬时 secret 分开转发。Connect 页面提供：

- 独立的 `Connectors` Activity Bar，仅负责选择 connector 并创建或补填一个数据源；
- 独立的 `Data Sources` Activity Bar，仅负责已保存数据源、已打开连接与 metadata tree；
- 已保存的 MySQL 数据源需要 password 时，Data Sources 会跳转到 Connectors；连接成功后自动刷新并聚焦 Data Sources；
- 旧 V2 `SQL Explorer` 暂不注册到主导航，直到 V1 query bridge 与 V2 profile store 完成统一；
- SQLite File / In-memory 模式；
- SQLite、MySQL、disabled PostgreSQL 的 connector 选择；
- Test / Validate / Connect 三个明确动作；
- MySQL Connector/J 与 PostgreSQL JDBC 包显示 signed manifest 版本、缓存状态并支持显式下载；下载只缓存包，不改变 runtime status，也不会提前启用 PostgreSQL；
- host / port / database / username 实时必填与端口校验（password 可选）、busy guard、窄侧栏响应式布局；
- 所有操作结束后清空 password；
- 保存 MySQL 时复用已打开连接的 id，保存失败会 best-effort 关闭刚打开的连接。

### 2.6 Driver Package Boundary

驱动包清单内置在 Tauri 二进制资源中，使用固定 Ed25519 公钥验证；每个包还必须满足固定 HTTPS host、路径组件、大小与 SHA-256 校验。下载先写入 `.part` 文件，校验通过后再安装到：

```txt
<app_data_dir>/sql-drivers/<package>/<version>/<file>
```

`sql_list_driver_packages` 只把大小与 SHA-256 均匹配的缓存标记为 `installed`。这个状态与 `sql_list_driver_runtime_status` 独立：当前 MySQL 使用 Rust native runtime，PostgreSQL runtime 仍为 Planned，JDBC 缓存不会绕过连接页的 runtime guard。

### 2.7 Welcome Flow

Welcome 已实现为注册在 SQL Results container 的 `SqlProductWelcomePane`，四个 action 分别路由到 Demo、打开 Connectors 中的 New data source 表单、History 与 Command Palette。首次启动默认打开；`Add a connection` 会聚焦并展开 Connectors 表单，而不是只聚焦容器。

### 2.8 README 与 Release Gate

Root `README.md` 记录 SQLite Demo Flow、完整本地 release commands 与 opt-in MySQL integration。CI 通过 `.github/workflows/sql-mvp-gate.yml` 在 `mvp` 的 push 与以 `mvp` 为目标的 PR 上执行同一套 pnpm/Rust gate；`release.yml` 在跨平台打包前调用该 reusable workflow。MySQL live flow 仅在手动 opt-in 时启动隔离 MySQL service。

### 2.9 主要实现文件

```txt
scripts/seed-demo-db.mjs
src-tauri/src/commands/sql/demo_seed.rs
src-tauri/src/commands/sql/product.rs
src-tauri/src/commands/sql/mysql_validation.rs
src/vs/workbench/services/sql/common/sqlProduct.ts
src/vs/workbench/services/sql/browser/sqlProductService.ts
src/vs/workbench/services/sql/common/sqlConnection.ts
src/vs/workbench/services/sql/browser/sqlConnectionChangeService.ts
src/vs/workbench/contrib/sqlConnections/browser/sqlConnections.contribution.ts
src/vs/workbench/contrib/sqlConnections/browser/sqlConnectionsView.ts
src/vs/workbench/contrib/sqlConnections/browser/sqlConnectionEditorPane.ts
src/vs/workbench/contrib/sqlConnections/browser/driverPackageBadge.ts
src/vs/workbench/contrib/sqlConnections/common/sqlConnections.ts
src/vs/workbench/services/sql/common/sqlDriverPackages.ts
src/vs/workbench/services/sql/browser/sqlDriverPackageService.ts
src-tauri/src/commands/sql/driver_packages.rs
src-tauri/src/commands/sql/sql-driver-manifest.json
src/vs/workbench/contrib/sqlConnections/browser/mysqlValidationView.ts
src/vs/workbench/contrib/sqlConnections/common/sqlConnectionSubmission.ts
src/vs/workbench/contrib/sqlProduct/browser/sqlProductBootstrap.ts
src/vs/workbench/contrib/sqlProduct/browser/sqlProductActions.ts
src/vs/workbench/contrib/sqlProduct/common/sqlProductBootstrapModel.ts
src/vs/workbench/contrib/sqlProduct/browser/sqlProductWelcomePane.ts
src/vs/workbench/contrib/sqlEditor/browser/sqlEditorPane.ts
.github/workflows/sql-mvp-gate.yml
```

## 3. 自动化验证

2026-08-15 当前工作树的定向结果：

| 检查                                                  | 结果                 | 覆盖重点                                                                                                                                              |
| ----------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run test:seed-demo`                             | 7/7                  | 平台数据目录解析，以及重复 seed 保留与 seed 同值的用户订单                                                                                            |
| `cargo test --lib demo_seed`                          | 6/6                  | seed、幂等复用、用户订单保留、V2 open、V1 查询                                                                                                        |
| `cargo test -p sql-studio-next --lib bootstrap_demo_` | 11/11                | V1/V2 saved/open profile 只读、旧可写 runtime 替换并排空 active query、进程重启恢复、匹配 runtime/cancel handle 保留、双 store 持久化失败关闭 runtime |
| `cargo test --lib mysql_validation`                   | 9 passed / 2 ignored | 输入、端口、TLS、共享网络超时、唯一表名、错误 code、清理失败告警；live contract 默认忽略                                                              |
| `pnpm run test:search`                                | 2/2                  | Tauri search cancellation race                                                                                                                        |
| `pnpm run test:sql-services`                          | 103/103              | Product service、连接缓存失效事件、错误映射、driver catalog/package service、V2 连接刷新事件、connector runtime guard                                 |
| `pnpm run test:sql-connections`                       | 165/165              | Connect form、structured errors、existing-view-only refresh、保存同 id、失败清理、validation、Data Sources / Connectors navigation                    |
| `pnpm run test:sql-editor`                            | 77/77                | all / selection / current、多语句执行、取消与 MySQL/SQLite 语句边界                                                                                   |
| `pnpm run test:sql-result`                            | 84/84                | 结果模型、单元格/行/列/全表复制、状态与稀疏数值列可见性                                                                                               |
| `pnpm run test:sql-history`                           | 29/29                | History 模型、服务、ViewPane 生命周期                                                                                                                 |
| `pnpm run test:sql-product`                           | 68/68                | first-launch plan、每进程静默 runtime 恢复、连接缓存同步、Welcome、startup splash、zoom                                                               |
| `pnpm run test`                                       | exit 0               | 默认完整回归：branding、icons、runtime status、Rust 423 passed / 2 ignored、Search 与全部 SQL/benchmark/WebDriver/visual suites                       |

本轮还完成了 `pnpm run lint`、`pnpm run build`、`pnpm run rust:check`、`pnpm run rust:clippy` 与 `pnpm run rust:fmt`，均 exit 0。全仓 `pnpm run format:check` 仍因 154 个既有 vendor/upstream 基线文件返回 exit 1；本次变更的 TypeScript/JavaScript/JSON 文件已单独通过 Prettier check。live MySQL 仍为 opt-in，不计入默认单元测试通过数。

隔离 MySQL 8 live validation（2026-07-27）exit 0：

- 容器使用固定的 `mysql@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b` 镜像，仅映射到 `127.0.0.1:33306`，不挂载任何卷；测试账户密码随机生成，只作为容器和测试进程的临时环境变量，未写入仓库或配置文件。
- `pnpm run test:mysql-integration` 通过，`mysql_preview_validation_live_contract` 为 1 passed；它调用连接页 Validate 使用的 `sql_validate_mysql_preview` 命令，确认 `selectOk`、`ddlOk`、`droppedTable` 均为 true，并返回 query cancellation warning。
- `MysqlPreviewValidationController` 的连接页测试已覆盖表单公开字段与瞬时 password 的分离转发、三阶段成功条件和结构化错误映射；额外查询确认 `nyala_validation_*` 遗留表数为 0，临时容器在测试结束后删除。
- `Require` 仍严格校验证书链与主机名。自签名容器会以 `UnknownIssuer` 失败，因此不能用本地 smoke test 替代受信任证书环境的 Require 验证。

Windows/Tauri 原生走查（2026-07-26）exit 0：

- Connect 表单显示 SQLite Stable、MySQL Preview 与 disabled PostgreSQL Planned；MySQL 的 password 可选，必填字段完整后 Test / Validate / Connect 可用；
- 连续两次 `sql_bootstrap_demo` 都连接同一个 `demo-sqlite`，树中出现 `users / orders`；
- `SELECT COUNT(*) FROM users` 返回 5；JOIN 返回 Alice 100/250、Bob 80、Carol 40/110；
- COUNT 与 JOIN 数值列均保持 160px，可在当前 viewport 直接看到；
- `console_errors=[]`、`page_errors=[]`，History toolbar 生命周期错误未复现。

macOS/Tauri 原生 MySQL Preview Validate 走查（2026-08-11）exit 0：

- 启动原生 Tauri WebView，在 Connectors 中选择 MySQL Preview，使用隔离 MySQL 8.4.11、无 password 账户与 `Prefer` SSL mode 填写公开连接字段；`Save data source` 保持关闭；
- 点击 Validate 后，界面显示 `MySQL Preview validation passed. MySQL Preview: query cancellation is not supported yet.`，成功报告确认 `selectOk`、`ddlOk`、`droppedTable`；
- 同一 live command 集成测试为 1 passed；走查后查询 `information_schema.tables`，确认 `nyala_validation_%` 遗留表数为 0；Validate 未保存 profile 或 secret。

## 4. 验收

- [x] `pnpm run test:seed-demo` 7/7 通过；
- [x] `cargo test --lib demo_seed` 6/6 通过；
- [x] `cargo test --lib mysql_validation` 9 passed / 2 ignored；
- [x] `pnpm run test:sql-product` 68/68 通过；
- [x] `pnpm run test:sql-connections` 165/165 通过；
- [x] `pnpm run test:sql-editor` 77/77 通过；
- [x] `pnpm run test:sql-result` 84/84 通过；
- [x] Rust bootstrap 测试验证 Demo 同时进入 V1/V2，且 V1 查询 `users` 返回 5；
- [x] V1/V2 保存与实际打开的 Demo profile 均为显式只读；旧可写 runtime 会被替换并在 bootstrap 返回前排空，V1 mutation 被拒绝；
- [x] V1 lifecycle mutation 串行化；持久化失败与并发 close/replace 不会复活旧 runtime，active/queued/pre-VM SQLite 查询均有 retirement 回归覆盖；
- [x] 每个 Workbench 进程静默恢复 Demo runtime，不重放 Welcome/layout；已匹配的 V1 runtime 与 cancel handle 不被替换；
- [x] 静默恢复只刷新已实例化 Data Sources，并使已恢复 SQL Editor 的连接缓存失效，不打开或聚焦视图；
- [x] CI/release workflow 强制执行 pnpm + Rust gate，并提供 live MySQL opt-in；
- [x] 启动 Nyala Studio，自动出现 `Demo (SQLite)` 连接与 `users / orders`；
- [x] 跑 `SELECT COUNT(*) FROM users` 返回 5；
- [x] 跑 `SELECT u.name, o.amount FROM users u JOIN orders o ON u.id=o.user_id` 在 panel 出现 5 行；
- [x] 连接页 `MysqlPreviewValidationController` 覆盖 MySQL Preview Validate 的字段与瞬时 secret 转发；隔离 MySQL 8 上的同一 Tauri command 返回成功报告与 cancellation warning（2026-07-27）。
- [x] 连接器管理页与连接表单展示 signed driver package 状态，并可通过服务调用受信任包下载；下载结果不会提升 PostgreSQL runtime maturity。
- [x] 原生 Tauri WebView 中选择 MySQL Preview 并填写 live MySQL 公开字段，点击 Validate 后返回成功报告与 cancellation warning；验证后 `nyala_validation_%` 遗留表数为 0（2026-08-11）。

## 5. 风险

| 风险                         | 缓解                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Demo db 被意外覆盖           | Tauri bootstrap 只做幂等 seed，不删除已有文件；30 天刷新仅存在于显式运行的 Node helper。                                                                |
| V1/V2 profile 漂移           | 两边使用稳定 id `demo-sqlite`；故障注入验证任一持久化失败时关闭两条 runtime，后续启动重试。                                                             |
| 历史 Demo runtime 仍可写     | 每进程静默重跑 bootstrap；V1/V2 仅在 open profile 偏离时替换，匹配 runtime 保留 revision/cancel handle；替换在返回前 retire 并 drain 旧 SQLite handle。 |
| V1 runtime 回滚复活旧连接    | lifecycle mutation 全局串行化；确定性并发测试覆盖失败保存与 close/replace 的提交顺序。                                                                  |
| Demo 不再接受编辑器 mutation | seed 在 runtime 打开前完成；Demo 面向查询/Agent 教程，用户写入练习应创建自己的可写 SQLite 数据源。                                                      |
| MySQL validation 留下临时表  | 表名使用 pid + sequence；成功必须完成 DROP，失败路径执行 best-effort `DROP TABLE IF EXISTS` 并保留结构化错误。                                          |
| Require TLS 的本地证书信任   | `Require` 保持 Rustls 证书链与主机名校验；使用自签名 MySQL 时需提供受信任 CA 的环境验证，不以降低校验替代。                                             |
| Welcome 抢编辑器焦点         | 仅首次启动默认出现，可通过 product preference 关闭；bootstrap 全部成功后才写完成标记。                                                                  |
| MySQL Preview 取消不支持     | UI 持续展示 cancellation warning，默认 release gate 不把 live MySQL 当作普通单测。                                                                      |

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
- [x] 真有 live MySQL Preview command validation 记录。
- [x] 真有原生连接页 live MySQL Preview Validate 记录。
