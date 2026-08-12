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

## Deny matrix

| 输入/状态 | 结果 |
| --- | --- |
| SQLite + read-only + `SELECT` | 允许执行 |
| SQLite + read-only + `SELECT` explain | 允许并返回 plan |
| `INSERT`/`UPDATE`/`DELETE`/DDL | Rust validation deny |
| 多 statement | Rust validation deny |
| Unknown、PRAGMA、危险/维护语句 | Rust validation deny |
| 可写 SQLite connection | Rust validation deny |
| MySQL/PostgreSQL | Rust validation deny，不升级 driver maturity |

## 验证

| 命令 | 结果 |
| --- | --- |
| `pnpm run test:sql-agent` | 82 Rust Agent tests + 2 canonical capability tests 通过 |
| `node --test --import tsx src/vs/workbench/services/sql/test/sqlAgentService.test.ts` | 7/7 通过 |
| `pnpm run test:sql-services` | 96 tests 通过 |
| `pnpm run test:sql-domain` | 20 tests 通过 |
| `pnpm run rust:check` | exit 0 |
| `cd src-tauri && cargo clippy -p sql-studio-next --lib -- -D warnings` | exit 0 |
| `pnpm run rust:fmt` | exit 0 |
| `pnpm run lint` | exit 0 |
| `git diff --check` | exit 0 |

## 状态

A3.1 已完成。A3.2 仍负责 result shape/aggregate/sample policy，默认不把 rows 放入 model
context；A4 Workbench UX、Zeus Z1/Z2 和 R0 仍受路线门禁约束。
