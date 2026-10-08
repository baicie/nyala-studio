# SQL MVP 设计总索引

> Core Phase 00-08 P0 evidence is recorded through `mvp@1dca498f` on 2026-08-11.
> MVP vNext rows track current implementation plus remaining gates; matching verification records are the evidence. Reference: `AGENTS.md §Current Status`.

| Phase | 文档                                                                                               | P 等级 | 状态（仓库当前）   | 验证记录                                                                                         | 完成标志                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------- | ------ | ------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 00    | [phase-00-runtime-status.md](./phase-00-runtime-status.md)                                         | P0     | 已具备雏形         | `test:sql-runtime-status` 26 项断言绿                                                            | `pnpm run test:sql-runtime-status` 通过                                                  |
| 01    | [phase-01-connection-mvp.md](./phase-01-connection-mvp.md)                                         | P0     | 已具备 P0 测试覆盖 | `test:sql-services` 111/111 + `test:sql-connections` 171/171 绿                                  | saved profile 不落 secret；Postgres UI 被禁                                              |
| 02    | [phase-02-metadata-explorer.md](./phase-02-metadata-explorer.md)                                   | P0     | 已具备 P0 测试覆盖 | `test:sql-connections` 171/171 绿                                                                | 三级 tree + per-node error / refresh                                                     |
| 03    | [phase-03-editor-execution.md](./phase-03-editor-execution.md)                                     | P0     | 已具备 P0 测试覆盖 | `test:sql-editor` 77/77 绿                                                                       | all / selected / current 三种执行 + Ctrl+Enter                                           |
| 04    | [phase-04-result-panel.md](./phase-04-result-panel.md)                                             | P0     | 已具备 P0 测试覆盖 | `test:sql-result` 84/84 绿 + 窄面板/键盘浏览器 QA 绿                                             | columns/rows/affected/elapsed/error 四态                                                 |
| 05    | [phase-05-history-formatter-snippets-explain.md](./phase-05-history-formatter-snippets-explain.md) | P0     | 已具备 P0 测试覆盖 | `test:sql-history` 29/29 + `test:sql-advanced` 97/97 绿                                          | History/Snippets/Formatter/Explain 可用                                                  |
| 06    | [phase-06-ai-helper-foundation.md](./phase-06-ai-helper-foundation.md)                             | P0     | 已具备 P0 测试覆盖 | `test:sql-services` + `test:sql-advanced` 绿                                                     | Deterministic provider + request validation / capability declaration boundary            |
| 07    | [phase-07-plugin-api-mvp.md](./phase-07-plugin-api-mvp.md)                                         | P0     | 已具备 P0 测试覆盖 | `test:sql-product` 80/80 + `test:sql-advanced` 97/97 绿                                          | 13 类 contribution points + local-only loader                                            |
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

| Track    | 范围                   | 状态（2026-09-17）                                                                                                   | 完成门                                                   |
| -------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Agent A0 | SQL Intelligence       | A0.1/A0.2 已完成（parser No-Go ADR）                                                                                 | corpus + parser ADR                                      |
| Agent A1 | Schema Context         | A1.1-A1.3 已完成（SQLite FK graph + `relation.search`）                                                              | adapter + bounded schema/relation search/cache           |
| Agent A2 | Suggest-only Runtime   | A2.1-A2.4 已完成                                                                                                     | policy/budget/evidence/bridge，零 query call             |
| Agent A3 | Read-only Agent        | A3.1/A3.2 与 Checkpoint R 已完成                                                                                     | SQLite 真闭环 + write/multi/Unknown deny + result policy |
| Agent A4 | Workbench Integration  | A4.1/A4.2、Fix 与结构化 native gate 已实现，原生 QA 待完成                                                           | Editor/Error/Schema/Result/Panel + browser/native QA     |
| Zeus Z0  | 选择性采用评估         | 已完成评估，生产未接入                                                                                               | Data Grid-only boundary                                  |
| Zeus Z1  | 可复现 Data Grid spike | beta.4 发布、bundle audit 与双 WebView evidence 完成；v6 仍有 5 个性能门失败，诊断结论为 floor-limited，Z1.3 `NO-GO` | dependency/bundle/performance/two-WebView Go             |
| Zeus Z2  | Result Grid Preview    | 禁止开始（A4 Checkpoint W 未完成且 Z1 `NO-GO`）                                                                      | feature flag + native fallback + behavior parity         |
| R0       | vNext release          | prework 已实现；结构化 release gate `NO-GO`                                                                          | Agent A4 + Zeus Z2 + full release gate                   |

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

`phase-z1-gate.json` 与 `phase-vnext-release-gate.json` 都是 revision-pinned 快照（当前 JSON 的
`generatedAt` 为 2026-08-16，`sourceRevision` 为 `63698263fa13cd9f114341bc04d360ed967d8c9b`），其中
`platform evidence path is not configured` / `provenance is
missing` 类原因描述的是录制当时的状态，不代表 beta.4 run `32706467306` 缺证据；当前阻塞原因以
roadmap §6 与 `phase-z1-spike-verification.md` 为准。R0 verifier 现在还会先把不可读的 Z1/A4 gate
artifact 记为结构化 `z1-gate-artifact` / `a4-checkpoint-w-artifact` NO-GO check，而不是抛 ENOENT。

2026-09-17 GitHub API 复核：默认分支 `mvp` 仍启用 strict branch protection，required checks 为
`Lint, build, and test`、`Prettier`、`rustfmt` 与 `taplo`（仓库没有 `actionlint` workflow，它也不在
required checks 内）。Checkpoint W/Z1/R0 三个 attestation workflow 现已发布到远端 `mvp` 且状态为
active、blob SHA 与本地 HEAD 一致，但三个 workflow 的 runs 数均为 0（从未 dispatch 过）；工作树里
A4 verifier 的加固（`scripts/verify-sql-agent-checkpoint-w.mjs`，`mvp` 为 `2c7248b2`、工作树为
`e9bf4dc2`）尚未合入 `mvp`。

2026-09-18 更正：此前把「仓库 `environments` 为空（`total_count = 0`）」记成阻塞项是错的。GitHub 文档
写明 _"Running a workflow that references an environment that does not exist will create an
environment with the referenced name … Otherwise, the newly created environment will not have any
protection rules or secrets configured."_（[Managing environments for
deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)，
2026-09-18 取得）。三个 attestation workflow 只使用 `secrets.GITHUB_TOKEN`，不用 environment secret，
因此 environment 会在首次运行时自动创建，**不是**功能阻塞；人工预建它们的价值只是附加 required
reviewers 这一层纵深保护。当前真正的阻塞是 Checkpoint W 的原生人工证据、Z1 的五个 v6 性能门，以及待在
受保护分支 `mvp` 上落地的本地 driver/verifier 修复。在这些完成前，Checkpoint W、Z1.3、R0 保持
`NO-GO`，Z2 禁止开始。

2026-08-18 的本地 Z1 复跑从 exact-pinned package 生成 73,494-byte、gzip -9 24,311-byte 的
Zeus bundle；package/license/integrity/size checks 通过，但结构化 audit 因未伪造五项 protected workflow
provenance 而按预期 `blocked`。macOS embedded WKWebView 的 1k×20 三 renderer smoke 在修复 benchmark
外层 scrollbar 导致的 screenshot marker 偏移后通过；producer 现在还校验 document containment 与 marker
DOM anchor。四 workload 单次 characterization 为 11/12，`10k-x-50/native` 在独立复跑中仍稳定触发
5 秒 presentation timeout，因此没有 60 条 macOS gate evidence；Windows 与受保护 provenance 同样仍缺。
这些本地结果不改变 20% 指标低于共同 floor 的既有停止结论，也不准入 Z2。

同日 benchmark harness 新增真实 `WorkbenchTable` 隔离组件模式。它通过 exact prototype、Monaco DOM
signature 和 bundle digest 证明 renderer 身份；1k×20、10k×50、宽列、窄面板的本地单次 smoke 均为
`ok`，每次只保留 14 个 DOM rows，且无外层 document overflow。checked-in
`phase-z1-benchmark.json` 仍是缺少这些证明的 legacy fixed-row characterization，因此新 gate 按预期
拒绝它；本地 dirty-tree smoke 不替换正式 benchmark，不改变 20% 门槛或 Z1.3/R0 `NO-GO`。

在 smoke 之后，本地又完成 real-mode 的 36 条 balanced Chromium records。真实 WorkbenchTable/Zeus
的 1k×20 scroll p95 中位为 `18.5/19.5ms`，Zeus 回归 `5.4%`，通过 10% 门；10k×50 为
`18.1/23.3ms`，改善 `-28.7%`，明确未通过 +20% 门。该 report 通过 Chromium real identity、record
与 summary integrity checks，但仍是 dirty tree 且缺 protected provenance、双 WebView 和 fresh audit，
所以只加固 `NO-GO`，不替换 checked-in admission evidence。

随后 real-component 6-repeat profile 复用格式化 row arrays 并删除重复 viewport refresh，把 Zeus 10k
render median 降至 `21.6ms`；但 WorkbenchTable/Zeus scroll p95 仍为 `17.7/18.1ms`，共同 floor 为
`17.5ms`，20% 门要求 Zeus `<=14.16ms`。checked-in profile 带真实 Workbench proof/digest 和全部 raw
samples，但明确为 dirty-tree Chromium diagnostic；它确认 adapter 优化不能跨过主指标 floor，仍不准入
Z2。

2026-08-20 的 exact-pinned 候选复验确认 Zeus core `0.1.1-beta.1` release 11/11 jobs 通过，zeus-ui
PR #35 与 main CI 各 10/10；36/36 zeus-ui packages 已发布为 `0.1.0-beta.3` 且 `beta` dist-tag 正确。
但 zeus-ui publish workflow 最终因过时的 zeus-compat `state/effect` consumer smoke 失败，`latest` 仍为
beta.0，也没有 GitHub Release 对象。beta.3 Data Grid bundle 为 91,000 raw / 29,647 gzip bytes，只比
30 KB 护栏低 353 bytes。

两轮各 6 次的 beta.2/beta.3 10k profile 合并后，Zeus render upper median 从 `17.1ms` 降到
`14.9ms`，但 scroll p95 upper median 从 `18.7ms` 变为 `19.2ms`，且 beta.3 出现 `241ms` scroll max
long tail。beta.3 全 workload run 的 10k WorkbenchTable/Zeus scroll 为 `18.0/20.2ms`，相对 baseline
仍回归 `12.2%`，没有通过旧 +20% 门。该 Chromium-only 复验不替换 beta.2/v6 evidence；macOS
WKWebView、Windows WebView2、fresh audit 与 protected attestation 仍缺，Z1.3/R0 保持 `NO-GO`，Z2
禁止开始。详细版本映射与 A-F 审计见
[`Zeus Data Grid 性能整改与重新验收报告`](../reviews/2026-08-18-zeus-data-grid-performance-remediation.md)。

2026-08-24 的 beta.4 revision-bound run 已补齐 fresh audit、Chromium 36/36、macOS WKWebView 与 Windows
WebView2 各 60/60 records + 12/12 screenshots；aggregate 只因 5 个未修改的 v6 性能门失败而 `NO-GO`。
随后 exact bundle 的 6-repeat 10k diagnostic profile 将 120/120 Zeus samples 关联到内部 commit：scroll
期间无 model rebuild，range/layout p95 均为 `0.1ms`；instrumented commit interval p95 upper bound 为
`2.1ms`，每次远跳分配 19-24 个 bounded wrappers，并在 pool 边缘观测到 node churn。由于 beta.4 在
`commitEndTime` 前遍历 Node tree，duration/churn 相关性包含机械性诊断开销；zeus-ui 应先分离 timing 或做
churn-disabled A/B，再决定 pool/wrapper 优化，没有证据先改 Zeus scheduler/`SizeCache`。v6 的 required
目标（`0.8 × baseline`）在所有现存 evidence 上都低于同组 shared presentation floor（floor p95
`16.7–18.6ms`；隐含要求 `baseline ≥ 1.25 × floor`，实测 `baseline / floor` 为 `1.011–1.237`，含
real WorkbenchTable r5 的七组为 `0.989–1.237`），
所以还须预注册 v7 floor-aware gate。该 dirty-tree
Chromium 诊断不替换正式 v6 evidence，不准入 Z2。
zeus-ui 工作树已把 renderer commit 与 diagnostics 遍历分开，但未发版；Nyala 仍消费 beta.4，并把
`1.3/2.1/2.2ms` 标成 instrumented upper bound。同一工作树现可把 `measureNodeChurn` 设为 false 做诊断 A/B，默认仍计量 churn。v7 指标草稿见
[ADR 0004](../adr/0004-zeus-data-grid-v7-floor-aware-metrics.md)（`Proposed`），批准前不得采正式 v7 证据。
2026-09-18 Nyala 侧 prerequisite 6 已落地（对称 WorkbenchTable CPU 区间 sidecar +
`rendererCpuRatio`）：`10k x 50` ratio 为 `0.500`，`1k x 20` 的单轮点估计为 `0.806` / `0.968`；但
`required` 仍低于 shared presentation floor，20% 门不可辨识，`Z1.3` / `R0` 保持 `NO-GO`，Z2 不开始。

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
WebView2、VoiceOver/Narrator evidence 尚未提供，因此结构化 gate 仍为 `NO-GO`。2026-08-18 的本地
macOS asset-protocol 重放还验证了版本化 product bootstrap outcome：Demo 与四个布局/新查询命令均在
截图前完成；capture helper 的 WebDriver `value` envelope 冲突已由 `result` 载荷和回归测试修复。

后续 Phase 09–13 见 dev-vault 总路线：
`projects/sql-studio-next/roadmaps/2026-07-04-sql-studio-next-long-term-roadmap.md`
