# Phase 00 – 08 设计总索引

> Last verified green: `68bdf99d` (`pnpm run test` exit 0).
> Reference: `AGENTS.md §Current Status`.

| Phase | 文档 | P 等级 | 状态（仓库当前） | 验证记录 | 完成标志 |
| ----- | --- | ------ | ---------------- | -------- | -------- |
| 00 | [phase-00-runtime-status.md](./phase-00-runtime-status.md) | P0 | 已具备雏形 | `test:sql-runtime-status` 16/16 绿 | `pnpm run test:sql-runtime-status` 通过 |
| 01 | [phase-01-connection-mvp.md](./phase-01-connection-mvp.md) | P0 | 已具备 P0 测试覆盖 | `test:sql-services` 62/62 + `test:sql-connections` 87/87 绿 | saved profile 不落 secret；Postgres UI 被禁 |
| 02 | [phase-02-metadata-explorer.md](./phase-02-metadata-explorer.md) | P0 | 已具备 P0 测试覆盖 | `test:sql-connections` 87/87 绿 | 三级 tree + per-node error / refresh |
| 03 | [phase-03-editor-execution.md](./phase-03-editor-execution.md) | P0 | 已具备 P0 测试覆盖 | `test:sql-editor` 59/59 绿 | all / selected / current 三种执行 + Ctrl+Enter |
| 04 | [phase-04-result-panel.md](./phase-04-result-panel.md) | P0 | 已具备 P0 测试覆盖 | `test:sql-result` 57/57 绿 | columns/rows/affected/elapsed/error 四态 |
| 05 | [phase-05-history-formatter-snippets-explain.md](./phase-05-history-formatter-snippets-explain.md) | P0 | 已具备 P0 测试覆盖 | `test:sql-history` 27/27 + `test:sql-advanced` 63/63 绿 | History/Snippets/Formatter/Explain 可用 |
| 06 | [phase-06-ai-helper-foundation.md](./phase-06-ai-helper-foundation.md) | P0 | 已具备 P0 测试覆盖 | `test:sql-advanced` 63/63 绿 | Deterministic provider + Capability Guard |
| 07 | [phase-07-plugin-api-mvp.md](./phase-07-plugin-api-mvp.md) | P0 | 已具备 P0 测试覆盖 | `test:sql-product` 37/37 + `test:sql-advanced` 63/63 绿 | 13 类 contribution points + local-only loader |
| 08 | [phase-08-mvp-packaging.md](./phase-08-mvp-packaging.md) | P0 | 部分落地 | `demo_seed.rs` 4/4 + `product.rs` 3/3 + `seed:demo` manual 绿 | demo.db ✅；MySQL preview validation + Welcome view + README Release Readiness ⏳ |

> **如何读这张表**：`状态（仓库当前）` 列写的是**仓库当前代码里有没有该 phase 的 P0 deliverable**；`验证记录` 列写的是**最近一次 green test run 的哪几个 suite 覆盖了它**；`完成标志` 列写的是 phase doc §验收 里列的 acceptance checklist。两列同时是绿的，行才算"met"。
>
> `已具备雏形` 是 00 单独的标签——它代表 runtime status 表是稳定的 source-of-truth，所有上层 phase 都消费它，不是 0/1 完成的简单标志。

## 不变量

1. **SQLite stable / MySQL preview / Postgres planned** —— 任何贡献都不能"提前升级"。
2. **Secret 永不落盘** —— saved profile 不含 password；MySQL Preview validation 后关闭连接。
3. **Driver ≠ Dialect** —— 后续 Phase 09 PG 增加 `drivers/postgres`, `dialects/postgres`。
4. **Capability 一统** —— plugin / agent / AI 用同一份 capability schema。
5. **AI never auto-execute** —— draft 必须经用户插入 editor 再走 execution。

## 引用顺序（实现期）

```text
00 → 01 → 02 → 03 → 04 → 05 → 06 → 07 → 08
```

后续 Phase 09–13 见 dev-vault 总路线：
`projects/sql-studio-next/roadmaps/2026-07-04-sql-studio-next-long-term-roadmap.md`
