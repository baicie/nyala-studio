# SQL MVP 设计总索引

> Core Phase 00-08 P0 evidence is recorded through `mvp@1dca498f` on 2026-08-11.
> MVP vNext rows track current implementation plus remaining gates; matching verification records are the evidence. Reference: `AGENTS.md §Current Status`.

| Phase | 文档                                                                                               | P 等级 | 状态（仓库当前）   | 验证记录                                                                                         | 完成标志                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------- | ------ | ------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 00    | [phase-00-runtime-status.md](./phase-00-runtime-status.md)                                         | P0     | 已具备雏形         | `test:sql-runtime-status` 16/16 绿                                                               | `pnpm run test:sql-runtime-status` 通过                                                  |
| 01    | [phase-01-connection-mvp.md](./phase-01-connection-mvp.md)                                         | P0     | 已具备 P0 测试覆盖 | `test:sql-services` 103/103 + `test:sql-connections` 165/165 绿                                  | saved profile 不落 secret；Postgres UI 被禁                                              |
| 02    | [phase-02-metadata-explorer.md](./phase-02-metadata-explorer.md)                                   | P0     | 已具备 P0 测试覆盖 | `test:sql-connections` 165/165 绿                                                                | 三级 tree + per-node error / refresh                                                     |
| 03    | [phase-03-editor-execution.md](./phase-03-editor-execution.md)                                     | P0     | 已具备 P0 测试覆盖 | `test:sql-editor` 77/77 绿                                                                       | all / selected / current 三种执行 + Ctrl+Enter                                           |
| 04    | [phase-04-result-panel.md](./phase-04-result-panel.md)                                             | P0     | 已具备 P0 测试覆盖 | `test:sql-result` 84/84 绿 + 窄面板/键盘浏览器 QA 绿                                             | columns/rows/affected/elapsed/error 四态                                                 |
| 05    | [phase-05-history-formatter-snippets-explain.md](./phase-05-history-formatter-snippets-explain.md) | P0     | 已具备 P0 测试覆盖 | `test:sql-history` 29/29 + `test:sql-advanced` 92/92 绿                                          | History/Snippets/Formatter/Explain 可用                                                  |
| 06    | [phase-06-ai-helper-foundation.md](./phase-06-ai-helper-foundation.md)                             | P0     | 已具备 P0 测试覆盖 | `test:sql-services` + `test:sql-advanced` 绿                                                     | Deterministic provider + request validation / capability declaration boundary            |
| 07    | [phase-07-plugin-api-mvp.md](./phase-07-plugin-api-mvp.md)                                         | P0     | 已具备 P0 测试覆盖 | `test:sql-product` 68/68 + `test:sql-advanced` 92/92 绿                                          | 13 类 contribution points + local-only loader                                            |
| 08    | [phase-08-mvp-packaging.md](./phase-08-mvp-packaging.md)                                           | P0     | 已具备 P0 验收覆盖 | `pnpm run test` 绿；`pnpm run test:mysql-integration` 1/1 绿；原生 Demo 与 MySQL Validate 走查绿 | demo.db、Welcome、validation、release gate、原生 Demo、live command 与原生 Validate 已验 |

> **如何读这张表**：`状态（仓库当前）` 列写的是**仓库当前代码里有没有该 phase 的 P0 deliverable**；`验证记录` 列写的是**最近一次 green test run 的哪几个 suite 覆盖了它**；`完成标志` 列写的是 phase doc §验收 里列的 acceptance checklist。两列同时是绿的，行才算"met"。
>
> `已具备雏形` 是 00 单独的标签——它代表 runtime status 表是稳定的 source-of-truth，所有上层 phase 都消费它，不是 0/1 完成的简单标志。
>
> Phase 08 已具备 P0 验收覆盖。自动化覆盖 demo seed、`sql_bootstrap_demo`（以同一 `demo-sqlite` ID 同时注册显式只读 V1/V2 runtime，每个 Workbench 进程静默恢复 runtime，并只在 profile 偏离时替换）、瞬时 `sql_validate_mysql_preview(input, secret)` 命令、`MysqlPreviewValidationController`、已注册的 Welcome ViewPane、连接器表单、signed driver package 缓存下载和 root README/CI release gate。下载 package 不会提升 runtime maturity；Windows/Tauri 实机 Demo → query panel walkthrough 于 2026-07-26 验收；隔离 MySQL 8 上调用同一 Tauri command 的 live Preview validation 于 2026-07-27 验收；macOS/Tauri 原生连接页针对隔离 live MySQL 的 Validate 点击于 2026-08-11 验收，成功报告确认 `selectOk`、`ddlOk`、`droppedTable`，显示 query cancellation warning，且验证后 `nyala_validation_%` 遗留表数为 0。
>
> Phase 06 的 P0 实装是 deterministic provider、AI request validation、context builder
> 与 plugin capability declaration。MVP vNext A2 已补齐 Rust Tool Runtime 的 canonical
> capability enforcement 与 backend-owned task/mode grant；Phase 06 本身的历史范围不变。

## MVP vNext：Agent + Zeus UI

Core MVP 00-08 已完成后，新的 MVP 目标由
[`mvp-vnext-agent-zeus-roadmap.md`](./mvp-vnext-agent-zeus-roadmap.md) 统一管理。
它不重开 Phase 08，而是增加 Agent 主线与 Zeus Data Grid 准入轨：

| Track    | 范围                   | 状态（2026-08-17）                                                                                                                                       | 完成门                                                   |
| -------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Agent A0 | SQL Intelligence       | A0.1/A0.2 已完成（parser No-Go ADR）                                                                                                                     | corpus + parser ADR                                      |
| Agent A1 | Schema Context         | A1.1-A1.3 已完成（SQLite FK graph + `relation.search`）                                                                                                  | adapter + bounded schema/relation search/cache           |
| Agent A2 | Suggest-only Runtime   | A2.1-A2.4 已完成                                                                                                                                         | policy/budget/evidence/bridge，零 query call             |
| Agent A3 | Read-only Agent        | A3.1/A3.2 与 Checkpoint R 已完成                                                                                                                         | SQLite 真闭环 + write/multi/Unknown deny + result policy |
| Agent A4 | Workbench Integration  | A4.1/A4.2、Fix 与结构化 native gate 已实现，原生 QA 待完成                                                                                               | Editor/Error/Schema/Result/Panel + browser/native QA     |
| Zeus Z0  | 选择性采用评估         | 已完成评估，生产未接入                                                                                                                                   | Data Grid-only boundary                                  |
| Zeus Z1  | 可复现 Data Grid spike | Z1.1/Z1.2 已完成；v6 下 10k 只改善 1.0%，feasibility profile 又确认 20% 目标低于共同 presentation floor；双 WebView/新 bundle audit 亦缺失，Z1.3 `NO-GO` | dependency/bundle/performance/two-WebView Go             |
| Zeus Z2  | Result Grid Preview    | 禁止开始（A4 Checkpoint W 未完成且 Z1 `NO-GO`）                                                                                                          | feature flag + native fallback + behavior parity         |
| R0       | vNext release          | prework 已实现；结构化 release gate `NO-GO`                                                                                                              | Agent A4 + Zeus Z2 + full release gate                   |

关键依赖：`A0/A1 → A2 → A3 → A4`；`Z0 → Z1` 可以并行进行；生产试点必须
`A4 + Z1 Go → Z2 → R0`。Z1 No-Go 不等于 Zeus 接入完成，必须回到产品决策。

A1.3 是 Agent foundation 的增量硬化；它不完成 Checkpoint W，不改变 Z1 NO-GO，
不准入 Z2，也不满足 R0。

A5 的实现与证据见
[`sql-workspace-agent-a5-implementation-plan.md`](../sql-workspace-agent-a5-implementation-plan.md)。
它只支持显式只读 SQLite，以有界 index metadata、两份 typed `EXPLAIN QUERY PLAN` 和
stale-safe draft 提供结构性建议；它不验证查询语义或实际性能，也不属于 vNext release 依赖链。
它不完成 Checkpoint W，不改变 Z1.3/R0 `NO-GO`，也不准入 Z2。

`pnpm run verify:sql-mvp-vnext-release` 是 release-only fail-closed guard。A4 与 Z1 gate report
仍分别使用 schema v2；R0 输出
[`phase-vnext-release-gate.json`](./phase-vnext-release-gate.json) 使用 release report schema v3。
受保护的 `SQL MVP vNext Release Evidence` workflow 精确验证 A4/Z1 attestation run 与 artifact API
metadata，通过 GitHub artifact API URL 下载 ZIP、核对未过期 artifact 的 SHA-256 digest 与安全路径，
再只把认证后的 raw evidence 交给 R0。R0 重算 Checkpoint W 四份输入与 Z1 六份输入的 SHA-256，
绑定同一 protected default-branch revision/ref，要求 measurement contract v6、平衡 renderer 执行顺序，
并拒绝完整手写的
`GO` evidence；当前结论仍为
`NO-GO`。

2026-08-17 GitHub API 审计确认默认分支 `mvp` 已启用 strict branch protection，但仓库尚无
environment，本地新增的 Checkpoint W/Z1/R0 attestation workflow 也尚未发布到远端。管理员仍需创建
`sql-agent-checkpoint-w`、`sql-result-grid-z1-gate`、`sql-mvp-vnext-release` 三个 environment 并启用
required reviewers，在 workflow 发布后把新增的 `actionlint` check 纳入保护规则。配置、发布和真实
原生证据完成前，Checkpoint W、Z1.3、R0 保持 `NO-GO`，Z2 禁止开始。

## 不变量

1. **SQLite stable / MySQL preview / Postgres planned** —— 任何贡献都不能"提前升级"。
2. **Secret 永不落盘** —— saved profile 不含 password；MySQL Preview validation 将公开 input 与瞬时 `ConnectionSecret` 直接传给 `sql_validate_mysql_preview`，不创建 V1/V2 持久化 profile。
3. **Driver ≠ Dialect** —— PostgreSQL runtime 仍在 vNext 之外；Agent/Zeus 不改变 driver maturity。
4. **Capability 一统** —— frontend canonical wire vocabulary 与 Rust policy 使用同一组 token；backend 按内建 task/mode profile 计算 grant，renderer request 只能 opt down。
5. **权限渐进开放** —— A0-A2 的 draft 不执行；A3 验收后也只有用户显式启用的 Read Only mode 可以执行单条只读查询，write/DDL 不属于 vNext。
6. **Zeus 可回退** —— 只允许 SQL Result success grid Preview；Workbench 与 native renderer 保持不变。

## 引用顺序（实现期）

```text
00 → 01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 (met)
                                                ├─ A0/A1 → A2 → A3 → A4 ─┐
                                                └─ Z0 → Z1 ──────────────┤
                                                                          └→ Z2 → R0

post-vNext (non-blocking): A3/A4 contracts → A5 SQLite Query Optimize
```

## 设计来源

[`SQL Workspace Agent 设计规格`](../sql-workspace-agent-design.md) 记录 Phase 06
deterministic AI Helper 向本地 Rust Agent Runtime 的演进；
[`Zeus UI 选择性采用评估`](../reviews/2026-08-10-zeus-ui-adoption-evaluation.md)
定义 Data Grid 的准入、退出和回退边界。两者由 vNext 路线统一排序。

Checkpoint R 的自动化与原生三故事证据见
[`phase-agent-checkpoint-r-explore-verification.md`](./phase-agent-checkpoint-r-explore-verification.md)。
它只在用户显式选择 Read Only、连接为显式只读 SQLite 且 task 为 Assistant 时执行一条 query；
Schema-aware Generate 与 Fix 也已有真实 Demo metadata 的零 query 自动化证据，其中 Fix 不再信任
frontend schema，并强制 `schema.search -> sql.parse -> final`。2026-08-15 的 macOS 原生 Nyala
走查已签收 Generate/Fix/Explore；Checkpoint R 完成。Checkpoint W 的 manifest v2、逐 gate attestation
v2、gate schema v2 与双阶段 GitHub workflow 已落地。attestation workflow 只允许 protected default
branch，并使用 `sql-agent-checkpoint-w` environment；它先用自身 checkout 中的 trusted verifier 校验
GitHub run/artifact metadata，再按 exact artifact ID 下载证据，不执行 capture revision 自带的 gate。
capture revision/ref 必须等于受保护 attestation revision/ref，attestation run `created_at` 必须晚于
capture completion；artifact 必须未过期、带 GitHub SHA-256 digest 且时序有效。独立 verifier 会重算
viewport calibration，并把 manifest、snapshot、PNG/DPR 与四份输入 SHA-256 绑定。真实键盘、Windows
WebView2、VoiceOver/Narrator evidence 尚未提供，因此结构化 gate 仍为 `NO-GO`。

后续 Phase 09–13 见 dev-vault 总路线：
`projects/sql-studio-next/roadmaps/2026-07-04-sql-studio-next-long-term-roadmap.md`
