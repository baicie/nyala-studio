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

## 状态

A3.2 已完成。A3 Checkpoint R 的 Demo SQLite 原生 Generate/Fix/Explore 走查仍等待 A4
Workbench actions、Panel projection 和浏览器 QA；Zeus 仍停留在 Z0 evaluation，未进入生产依赖。
