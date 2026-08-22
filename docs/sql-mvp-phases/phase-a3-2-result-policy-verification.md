# A3.2 Result Policy Verification

日期：2026-08-12  
范围：Read Only Agent 的 result shape、aggregate、inspect、sample policy 与 loop bridge。

## 交付

- `AgentResultShape` 只包含列 shape、row count、affected rows、elapsed、truncated 和序列化
  大小；`AgentResultAggregate` 只包含本地计算的 null/numeric/min/max summary，两者都不含
  row body。
- `AgentResultStore` 为每个 run 提供有界的 ephemeral `resultRef`，最多 64 个结果、总计
  256 KiB；结果句柄不写入数据库、日志或持久化 profile。
- `result.inspect` 只读取 `resultRef` 并重新生成 shape/aggregate evidence；模型不能通过 tool
  arguments 传入 rows。
- `result.sample` 需要显式 `approved: true`，row cap 默认 20、最大 100，byte cap 默认
  16 KiB、最大 64 KiB；按完整 row 截断，不产生半行结果。
- sample 对敏感列名（password、token、authorization、private key 等）、BLOB，以及 bearer/
  private-key 文本执行 redaction，并返回 redacted cell 计数。
- `ReadOnlyAgentLoop` 已接入 `sql_agent_start` 的 Read Only 分支；Suggest Only 分支保持
  零 query call，Read Only 的 query、row、byte usage 在 Rust budget 中累计并原子拒绝超限。
- 2026-08-14 cancellation hardening 保证工具执行期间收到 cancel 后不提交本次 usage、result
  handle 或 evidence；cancel 和拒绝迟到 finish 都会删除该 run 的 ephemeral evidence。
- 2026-08-15 Explore contract 把 execute 产生的 opaque `resultRef` 绑定到后续 inspect；两阶段都必须
  产生 ResultShape + Aggregate evidence，且 Read-only Assistant 不获得 sample capability。
- evidence store 支持原子 batch append：整批先完成 redaction、单项/全局 byte、entry capacity 和 ID
  空间检查，再一次性分配连续 ID；拒绝不会留下部分 evidence 或消费 ID。

## Policy 边界

| 输入/状态                               | 结果                                  |
| --------------------------------------- | ------------------------------------- |
| shape/aggregate evidence                | 默认允许，payload 不含 rows           |
| 缺少或伪造 `resultRef`                  | Rust `invalid_input` deny             |
| `result.sample` 未批准                  | Rust `validation` deny                |
| sample 超出 row/byte cap                | Rust `invalid_input` deny             |
| tool arguments 携带 `rows`              | Rust `validation` deny                |
| 结果包含敏感列、BLOB 或疑似 secret 文本 | sample 输出 `[REDACTED]`              |
| 结果预算超限                            | Rust run failed，usage 不提交部分结果 |

## 自动化验证

| 命令                                                                   | 结果                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `pnpm run test:sql-agent`                                              | 82 Rust Agent tests + 2 canonical capability tests 通过 |
| `pnpm run rust:check`                                                  | exit 0                                                  |
| `cd src-tauri && cargo clippy -p sql-studio-next --lib -- -D warnings` | exit 0                                                  |
| `pnpm run rust:fmt`                                                    | exit 0                                                  |
| `git diff --check`                                                     | exit 0                                                  |

关键 scripted tests：

- execute → shape/aggregate evidence → inspect → approved sample → final answer；
- result row budget 超限时 run failed 且 usage 保持原值；
- shape/aggregate JSON snapshot 不出现 `rows`；
- sample approval、row/byte cap、敏感列 redaction 和稳定 envelope 字段。
- cancel during tool execution 后 usage/evidence 保持 0，且迟到 completion 不能覆盖
  `Cancelled` 终态。
- Explore execute/inspect evidence 不含 `rows` 或 ResultSample；伪造或错配 `resultRef` fail closed。
- atomic batch 的 redaction/budget/capacity/ID tests 证明拒绝后 store 与 ID sequence 不变。

2026-08-15 追加验证：`pnpm run test:sql-agent` 通过 177 个 Rust Agent tests 与 2 个 canonical
capability tests；9 个 Explore focused tests 和 13 个 Agent Panel contract tests 通过；
`pnpm run test:rust` 为 423 passed / 2 ignored，完整 `pnpm run test` exit 0。

## 状态

A3.2 已完成，自动化 Demo SQLite Explore 已验证 shape/aggregate-only evidence，Checkpoint R 的原生
Generate/Fix/Explore 走查也已完成。A4 Checkpoint W 仍缺真实键盘、Windows WebView2 与读屏证据。
Zeus Z1.3 保持 No-Go，未进入生产依赖。
