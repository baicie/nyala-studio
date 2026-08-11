# Phase 00 – 08 设计总索引

> Functional, build, and Rust checks verified on `refine-windows-icon-connectors` on 2026-08-08; `format:check` still reports the repository's pre-existing vendor-tree baseline.
> Reference: `AGENTS.md §Current Status`.

| Phase | 文档                                                                                               | P 等级 | 状态（仓库当前）   | 验证记录                                                                                         | 完成标志                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------- | ------ | ------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 00    | [phase-00-runtime-status.md](./phase-00-runtime-status.md)                                         | P0     | 已具备雏形         | `test:sql-runtime-status` 16/16 绿                                                               | `pnpm run test:sql-runtime-status` 通过                                                  |
| 01    | [phase-01-connection-mvp.md](./phase-01-connection-mvp.md)                                         | P0     | 已具备 P0 测试覆盖 | `test:sql-services` 86/86 + `test:sql-connections` 155/155 绿                                    | saved profile 不落 secret；Postgres UI 被禁                                              |
| 02    | [phase-02-metadata-explorer.md](./phase-02-metadata-explorer.md)                                   | P0     | 已具备 P0 测试覆盖 | `test:sql-connections` 155/155 绿                                                                | 三级 tree + per-node error / refresh                                                     |
| 03    | [phase-03-editor-execution.md](./phase-03-editor-execution.md)                                     | P0     | 已具备 P0 测试覆盖 | `test:sql-editor` 73/73 绿                                                                       | all / selected / current 三种执行 + Ctrl+Enter                                           |
| 04    | [phase-04-result-panel.md](./phase-04-result-panel.md)                                             | P0     | 已具备 P0 测试覆盖 | `test:sql-result` 77/77 绿 + 窄面板/键盘浏览器 QA 绿                                             | columns/rows/affected/elapsed/error 四态                                                 |
| 05    | [phase-05-history-formatter-snippets-explain.md](./phase-05-history-formatter-snippets-explain.md) | P0     | 已具备 P0 测试覆盖 | `test:sql-history` 29/29 + `test:sql-advanced` 63/63 绿                                          | History/Snippets/Formatter/Explain 可用                                                  |
| 06    | [phase-06-ai-helper-foundation.md](./phase-06-ai-helper-foundation.md)                             | P0     | 已具备 P0 测试覆盖 | `test:sql-services` + `test:sql-advanced` 绿                                                     | Deterministic provider + request validation / capability declaration boundary            |
| 07    | [phase-07-plugin-api-mvp.md](./phase-07-plugin-api-mvp.md)                                         | P0     | 已具备 P0 测试覆盖 | `test:sql-product` 65/65 + `test:sql-advanced` 63/63 绿                                          | 13 类 contribution points + local-only loader                                            |
| 08    | [phase-08-mvp-packaging.md](./phase-08-mvp-packaging.md)                                           | P0     | 已具备 P0 验收覆盖 | `pnpm run test` 绿；`pnpm run test:mysql-integration` 1/1 绿；原生 Demo 与 MySQL Validate 走查绿 | demo.db、Welcome、validation、release gate、原生 Demo、live command 与原生 Validate 已验 |

> **如何读这张表**：`状态（仓库当前）` 列写的是**仓库当前代码里有没有该 phase 的 P0 deliverable**；`验证记录` 列写的是**最近一次 green test run 的哪几个 suite 覆盖了它**；`完成标志` 列写的是 phase doc §验收 里列的 acceptance checklist。两列同时是绿的，行才算"met"。
>
> `已具备雏形` 是 00 单独的标签——它代表 runtime status 表是稳定的 source-of-truth，所有上层 phase 都消费它，不是 0/1 完成的简单标志。
>
> Phase 08 已具备 P0 验收覆盖。自动化覆盖 demo seed、`sql_bootstrap_demo`（以同一 `demo-sqlite` ID 同时注册 V1/V2）、瞬时 `sql_validate_mysql_preview(input, secret)` 命令、`MysqlPreviewValidationController`、已注册的 Welcome ViewPane、连接器表单、signed driver package 缓存下载和 root README/CI release gate。下载 package 不会提升 runtime maturity；Windows/Tauri 实机 Demo → query panel walkthrough 于 2026-07-26 验收；隔离 MySQL 8 上调用同一 Tauri command 的 live Preview validation 于 2026-07-27 验收；macOS/Tauri 原生连接页针对隔离 live MySQL 的 Validate 点击于 2026-08-11 验收，成功报告确认 `selectOk`、`ddlOk`、`droppedTable`，显示 query cancellation warning，且验证后 `nyala_validation_%` 遗留表数为 0。
>
> Phase 06 的 P0 实装是 deterministic provider、AI request validation、context builder
> 与 plugin capability declaration。当前 capability declaration 尚不是 Rust Tool Runtime
> 的统一强制授权；该 enforcement 是后续 SQL Workspace Agent A2 的进入条件。

## 不变量

1. **SQLite stable / MySQL preview / Postgres planned** —— 任何贡献都不能"提前升级"。
2. **Secret 永不落盘** —— saved profile 不含 password；MySQL Preview validation 将公开 input 与瞬时 `ConnectionSecret` 直接传给 `sql_validate_mysql_preview`，不创建 V1/V2 持久化 profile。
3. **Driver ≠ Dialect** —— 后续 Phase 09 PG 增加 `drivers/postgres`, `dialects/postgres`。
4. **Capability 一统（演进约束）** —— plugin / agent / AI 最终只用一份 capability schema；当前 declaration 在开放 Agent tool 前必须补齐 backend enforcement。
5. **AI never auto-execute** —— draft 必须经用户插入 editor 再走 execution。

## 引用顺序（实现期）

```text
00 → 01 → 02 → 03 → 04 → 05 → 06 → 07 → 08
```

## 后续 Agent 设计

[`SQL Workspace Agent 设计规格`](../sql-workspace-agent-design.md) 记录 Phase 06
deterministic AI Helper 向本地 Rust Agent Runtime 的拟议演进。该文档使用
`Agent Stage A0-A8`，不是本目录 Phase 00-08 的续号，也不改变 Phase 08 已具备
P0 验收覆盖的状态或 SQLite Stable / MySQL Preview / PostgreSQL Planned 的运行时事实。

在 A2 Suggest-only Runtime 之前，现有 `AI never auto-execute` 继续生效；在 A3
Read-only Agent 通过独立验收前，Agent 不获得 Explain/query 执行能力。

后续 Phase 09–13 见 dev-vault 总路线：
`projects/sql-studio-next/roadmaps/2026-07-04-sql-studio-next-long-term-roadmap.md`
