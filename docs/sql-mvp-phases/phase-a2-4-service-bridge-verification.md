# A2.4 Service Bridge Verification

日期：2026-08-12  
范围：SQL Workspace Agent Suggest-only Runtime 的 Workbench service 与 Tauri bridge。

## 交付

- Rust 增加全局 `AgentRuntimeState`，集中持有 run store、evidence store 和 opaque run id 分配器。
- Tauri 提供 `sql_agent_start`、`sql_agent_cancel`、`sql_agent_get_run` 三个结构化命令。
- 每次 start/cancel 都发布 `sql-agent/run` event；Workbench service 通过可 dispose 的 listener 转发状态。
- `ISqlAgentService` 只通过 `ISqlCommandExecutor` 调用 backend，view 不直接 invoke。
- A2 bridge 仍使用 deterministic Suggest-only loop，没有 query adapter；成功与错误路径的
  `queryCallCount` 保持为 0。

### 2026-08-14 lifecycle hardening

- `sql_agent_start` 只分配 run 并保存有界、可信 request；`sql_agent_run` 仅凭 opaque `runId`
  claim request 后在后台执行，避免 WebView 重放或替换 start payload。
- run event 增加单调 `revision`；Workbench 同时对 event 与 command response 去重并拒绝迟到
  revision，`Cancelled` 等终态不会被迟到 completion 覆盖。
- runtime 业务失败统一收口为 typed `Failed` event；worker `JoinError` 同样终结 active run，
  不留下永久 running 状态。
- run store 容量固定为 256，只淘汰最老终态 run；淘汰结果返回 runtime 并同步清理该 run 的
  ephemeral evidence。start request 上限为 512 KiB，cancel 会立即释放 pending context。
- cancel 与拒绝迟到 finish 都按 run 清理 ephemeral evidence；工具执行期间取消时，不提交该次
  usage、result handle 或 evidence。

### 2026-08-14 Schema-aware Generate

- connected Generate 的 Workbench request 不再携带 frontend schema，只携带 opaque `connectionId`；
  backend 使用现有 V2 metadata manager 和 `LocalSqlCoreAdapter` 检索真实、有界 schema。
- deterministic gateway 固定请求 `schema.search` 和 `sql.parse`。runtime 强制精确工具顺序、metadata
  capability、connection identity、schema run budget、单条 ReadOnly analysis，以及 final SQL 与已解析
  draft 的逐字一致性。
- `GenerateQuery` 当前只允许 Suggest Only mode；Read Only mode 会在 worker routing 前拒绝，避免绕过
  schema/parse gate。该闭环不调用 query/explain，`queryCallCount` 保持为 0。

### 2026-08-15 Goal-grounded Read-only Explore bridge

- `Assistant + ReadOnly` 是唯一进入 Explore 的路由；Workbench 与 backend-owned grant 均使用
  `agent.tool`、`database.readMetadata`、`database.executeRead`、`database.readResultShape` 四项能力。
- bridge 从 claimed pending run 读取可信 goal、opaque connection 和 effective capabilities，组合
  `LocalReadOnlyExploreAgentToolExecutor`，frontend schema、result shape 与 result handle 均不参与信任边界。
- 真实 Demo SQLite worker 以空 editor 和中文 goal 运行 metadata -> parse -> execute -> inspect，
  `queryCallCount = 1`；其他 Suggest-only 路径继续保持 0。
- 该纵切的 runtime、evidence 与边界证据见
  [`phase-agent-checkpoint-r-explore-verification.md`](./phase-agent-checkpoint-r-explore-verification.md)。

## 安全边界

- `AgentMode::AllowWritesWithApproval` 在 A2 loop 直接拒绝。
- A2 Suggest-only profile 继续拒绝 `sql.explain`、`sql.execute_readonly`、result/history tools；A3 只在
  显式 Read Only profile 内按 task 的 backend grant 开放 explain 或 Explore 所需工具。
- request、model tool arguments 与 evidence payload 沿用递归脱敏和结构化错误，不写入 credential。
- renderer/plugin capability declarations 只作为 opt-down hints；Rust 先按内建 task/mode profile
  计算固定 grant，再保存 `requested ∩ grant`。伪造 write/network/sample/metadata token 不能扩大权限。
- `schema.search` 必须同时通过 `database.readMetadata` 和 request `connectionId` 一致性检查；model 不能
  访问另一个打开连接，也不能用 frontend schema 替换 backend evidence。
- cancel 只终结匹配 run；A3 read-only 工具启用后，bridge 还会按 `{runId, callId}` owner 精确
  中断该 run 的 SQLite 查询，不隐式触发写操作，也不碰未登记 owner 的普通查询。

## 验证

| 命令                         | 结果                                                    |
| ---------------------------- | ------------------------------------------------------- |
| `pnpm run test:sql-agent`    | 64 Rust Agent tests + 2 canonical capability tests 通过 |
| `pnpm run test:sql-services` | 90 tests 通过                                           |
| `pnpm run rust:check`        | exit 0                                                  |
| `pnpm run rust:fmt`          | exit 0                                                  |
| `pnpm run lint`              | exit 0                                                  |
| `git diff --check`           | exit 0                                                  |

2026-08-14 lifecycle hardening 的附加证据：

- `pnpm run test:sql-agent`：116 Rust Agent tests + 2 canonical capability tests 通过；
- `pnpm run test:sql-services`：100 tests 通过；
- `pnpm run test:sql-advanced`：84 tests 通过；
- `pnpm run test:rust`：339 passed，2 ignored；
- `pnpm run build`、`cargo check -p sql-studio-next --lib`、
  `cargo clippy -p sql-studio-next --lib --tests -- -D warnings`、
  `cargo fmt --all -- --check` 与 `git diff --check`：exit 0。

2026-08-14 Schema-aware Generate 的验证证据：

- 真实 Demo SQLite worker 使用 `orders/users` metadata 生成 join，忽略 forged frontend schema，
  evidence 同时包含 Schema 与 Analysis，`queryCallCount = 0`；
- 8 个 connected Generate runtime 负例覆盖 capability、工具缺失/乱序、额外 tool、write parse、
  schema budget、final SQL 替换；跨连接 metadata、Read Only mode 路由和真实 Demo budget 各有独立测试；
- run/evidence capacity eviction 的 domain + bridge 测试证明只删除被淘汰 run 的 evidence；
- `pnpm run test:sql-agent`：149 Rust Agent tests + 2 canonical capability tests 通过；
- `pnpm run test:sql-services`：100 tests 通过；`pnpm run test:sql-advanced`：86 tests 通过；
- `pnpm run test:rust`：376 passed，2 ignored；
- `pnpm run lint`、`pnpm run build`、`pnpm run rust:check`、`pnpm run rust:clippy`、
  `pnpm run rust:fmt`、targeted Prettier 与 `git diff --check`：exit 0。

2026-08-15 Read-only Explore bridge 的追加证据：

- `cargo test -p sql-studio-next --lib read_only_explore_`：9/9 通过；
- `pnpm run test:sql-agent`：159 Rust Agent tests + 2 canonical capability tests 通过；
- `node --test --import tsx src/vs/workbench/contrib/sqlAgent/test/sqlAgentPanelModel.test.ts`：11/11 通过；
- `pnpm run test:rust`：386 passed，2 ignored；`pnpm run test`：exit 0；
- `pnpm run rust:clippy` 与 `pnpm run rust:fmt:fix`：exit 0。

## 状态

A2.1-A2.4 已完成，且异步 bridge lifecycle 已在 2026-08-14 加固。A3.1/A3.2、自动化 Explore
纵切与 Checkpoint R 原生三故事走查已完成；A4 Checkpoint W 的真实键盘、Windows WebView2 与
读屏证据仍待补齐。Zeus Z1 仍为 No-Go，未进入生产依赖或 renderer integration。
