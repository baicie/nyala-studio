# A3.1 Read-only Tools Verification

日期：2026-08-12  
范围：SQLite-only Agent `sql.explain` 与 `sql.execute_readonly`。

## 交付

- `LocalSqlAgentQueryAdapter` 复用现有 `SqlConnectionStore`，不复制 driver/pool 或 SQL result wire shape。
- `sql_agent_explain` 执行 `EXPLAIN QUERY PLAN` 并返回原始 query plan；输入本身若为
  `EXPLAIN QUERY PLAN` 则不重复包裹。
- `sql_agent_execute_readonly` 执行单条 SQLite read-only statement，结果沿用现有 bounded row limit。
- `AgentPolicy::authorize_read_only` 在 model/tool 边界要求 `ReadOnly` mode、对应 canonical
  capability、SQLite dialect、单条 read-only SQL；adapter 再验证实际连接为显式 `read_only`。
- SQLite `:memory:` read-only connection 现在同样启用 `PRAGMA query_only`，避免仅依赖静态分类。
- Workbench `ISqlAgentService` 通过 `ISqlCommandExecutor` 暴露 `explain`/`executeReadonly`，view
  不直接 invoke。

### 2026-08-14 physical cancellation hardening

- Agent query 使用结构化 `{runId, callId}` owner；只有取得 connection mutex 后才登记 owner，
  随后再次检查 cancellation token，再安装 SQLite progress handler 并执行 SQL。
- `sql_agent_cancel` 先终结 run、清理该 run evidence，再扫描 active owner；只对匹配 run 的
  `InterruptHandle` 调用 `interrupt()`，并在 interrupt 时保持 owner mutex，避免连接复用时的
  TOCTOU 误中断。
- cancel 路径不获取 connection mutex，因此执行侧 `connection -> owner` 不存在反向锁死。
  等待普通查询释放连接锁的 Agent 会在取得锁后、SQL 执行前观察 token 并退出。
- owner 与 progress handler 都由 guard 清除；被中断连接随后可继续执行 `SELECT 1`。
- rusqlite 仅在既有 `0.31` 依赖上增加 `hooks` feature，用于 progress handler；未增加 crate，
  lockfile 版本不变。

### 2026-08-14 run connection scope hardening

- `LocalReadOnlyAgentToolExecutor` 构造时必须绑定已 claim run context 中的 opaque
  `connectionId`；空 connection scope 直接返回 structured invalid-input error。
- model 的 `sql.execute_readonly` 与 `sql.explain` arguments 在进入 SQL adapter 前必须与该 run
  connection 严格匹配。另一个已打开且同样 read-only 的 SQLite connection 也不能被切换访问。
- 双 reader 真实 SQLite 负例覆盖 execute 与 explain；两条路径均返回 validation，未发生 query dispatch。
- 该 scope 属于 Agent model/tool loop。独立 `sql_agent_execute_readonly`/`sql_agent_explain` Tauri
  commands 仍是 main renderer 下的显式产品 API，并继续依赖自身的 SQL/driver/read-only validation。

### 2026-08-15 Goal-grounded Explore integration

- `LocalReadOnlyExploreAgentToolExecutor` 只组合既有 schema/parse 与 SQLite execute/inspect
  implementations；runtime 仍在每个 tool call 前执行 capability、mode、dialect、SQL risk 和 connection
  scope 检查。
- `Assistant + ReadOnly` 必须先用真实 metadata 形成 draft，再执行经过 `sql.parse` 证明的同一条
  ReadOnly SQL；bridge success path 精确报告一次 query call。
- seeded Demo SQLite 测试以“按天汇总最近 7 天订单”生成真实 `orders.amount/created_at` 聚合，
  而不是 placeholder `SELECT 1`。完整记录见
  [`phase-agent-checkpoint-r-explore-verification.md`](./phase-agent-checkpoint-r-explore-verification.md)。

## Deny matrix

| 输入/状态                             | 结果                                         |
| ------------------------------------- | -------------------------------------------- |
| SQLite + read-only + `SELECT`         | 允许执行                                     |
| SQLite + read-only + `SELECT` explain | 允许并返回 plan                              |
| `INSERT`/`UPDATE`/`DELETE`/DDL        | Rust validation deny                         |
| 多 statement                          | Rust validation deny                         |
| Unknown、PRAGMA、危险/维护语句        | Rust validation deny                         |
| 可写 SQLite connection                | Rust validation deny                         |
| tool `connectionId` 与 run 不一致     | Rust validation deny，query 前拒绝           |
| MySQL/PostgreSQL                      | Rust validation deny，不升级 driver maturity |

## 验证

| 命令                                                                                  | 结果                                                    |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `pnpm run test:sql-agent`                                                             | 82 Rust Agent tests + 2 canonical capability tests 通过 |
| `node --test --import tsx src/vs/workbench/services/sql/test/sqlAgentService.test.ts` | 7/7 通过                                                |
| `pnpm run test:sql-services`                                                          | 96 tests 通过                                           |
| `pnpm run test:sql-domain`                                                            | 20 tests 通过                                           |
| `pnpm run rust:check`                                                                 | exit 0                                                  |
| `cd src-tauri && cargo clippy -p sql-studio-next --lib -- -D warnings`                | exit 0                                                  |
| `pnpm run rust:fmt`                                                                   | exit 0                                                  |
| `pnpm run lint`                                                                       | exit 0                                                  |
| `git diff --check`                                                                    | exit 0                                                  |

2026-08-14 追加验证：

- 长 recursive CTE 进入 SQLite VM 后可被正确 run 物理中断；owner mismatch 返回 0；
- Agent 等待 connection mutex 时取消，不登记 owner、不误伤当前持锁查询；pre-cancelled query
  在 SQLite 执行前退出；中断后同连接 `SELECT 1` 成功；
- `commands::sql::state::tests::agent_cancel_does_not_interrupt_unowned_query` 单测通过，证明
  Agent cancel 返回 0 且普通未登记递归查询继续运行；
- scoped executor 的 7 个定向测试通过；跨连接 execute/explain 与空 run connection 均 fail closed；
- `cargo clippy -p sql-studio-next --lib --tests -- -D warnings`、
  `cargo fmt --all -- --check` 与 `git diff --check`：exit 0。

2026-08-15 Explore 追加验证：

- 9 个 `read_only_explore_` focused tests 通过，覆盖真实 Demo success、exact sequence、SQL 与
  connection binding、result handle、stage evidence 和 gateway cancellation；
- `pnpm run test:sql-agent`：159 Rust Agent tests + 2 canonical capability tests 通过；
- `pnpm run test:rust`：386 passed，2 ignored；`pnpm run test`：exit 0；
- `pnpm run rust:clippy` 与 `pnpm run rust:fmt:fix`：exit 0。

## 状态

A3.1 已完成，并具备 goal-grounded 自动化 Explore、run-owned SQLite 物理取消、run connection scope
与普通查询隔离证据。通用 Result `cancel_query` 仍是既有 connection-level interrupt；后续若统一
取消语义，应引入 query-id/owner contract，本轮不扩张其 API。Checkpoint R 原生走查已完成；A4
Checkpoint W、Zeus Z1/Z2 和 R0 仍受路线门禁约束。
