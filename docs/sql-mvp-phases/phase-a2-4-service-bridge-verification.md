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

## 安全边界

- `AgentMode::AllowWritesWithApproval` 在 A2 loop 直接拒绝。
- `sql.explain`、`sql.execute_readonly`、result/history tools 继续由 Rust policy 拒绝，等待 A3。
- request、model tool arguments 与 evidence payload 沿用递归脱敏和结构化错误，不写入 credential。
- cancel 只改变已登记 run 的生命周期状态，不隐式触发 query 或写操作。

## 验证

| 命令 | 结果 |
| --- | --- |
| `pnpm run test:sql-agent` | 64 Rust Agent tests + 2 canonical capability tests 通过 |
| `pnpm run test:sql-services` | 90 tests 通过 |
| `pnpm run rust:check` | exit 0 |
| `pnpm run rust:fmt` | exit 0 |
| `pnpm run lint` | exit 0 |
| `git diff --check` | exit 0 |

## 状态

A2.1-A2.4 已完成。A3.1 仍待实现；在 A3 read-only 验收前，Agent 不获得真实 SQL explain 或
query execution 能力。Zeus 仍只有 Z0 adoption evaluation，未进入生产依赖或 renderer integration。
