# MVP vNext 路线 - SQL Workspace Agent + Zeus Data Grid

> 状态：Active roadmap
>
> 规划日期：2026-08-11
>
> Core baseline：`mvp@1dca498f`，Phase 00-08 已具备 P0 验收覆盖。
>
> 本文是 Core MVP 之后的权威实施顺序。Agent 的领域规格继续以
> [`sql-workspace-agent-design.md`](../sql-workspace-agent-design.md) 为准；Zeus 的准入证据继续以
> [`2026-08-10-zeus-ui-adoption-evaluation.md`](../reviews/2026-08-10-zeus-ui-adoption-evaluation.md)
> 为准。

## 1. 重规划结论

Core MVP Phase 00-08 保持为已完成的历史基线，不重新编号，也不把新增范围伪装成
原 Phase 08 的补项。MVP vNext 增加两条产品轨道：

1. **Agent 主线**：完成 SQL Workspace Agent A0-A4，交付 SQLite 上可验证、可取消、
   后端强制授权的只读 Agent 闭环。
2. **Zeus UI 轨**：完成 Data Grid 的可复现 spike，并在通过准入门后交付只替换
   SQL success grid 的可回退 Preview。

两条轨道共享同一个 release gate。Agent 是产品能力主线；Zeus 是有量化门槛的 UI
能力接入。Zeus spike 可以与 Agent foundation/runtime 并行，但 Zeus 生产试点必须等
Agent A4 的 Result action contract 稳定后再开始，避免两个分支同时改写 Result surface。

本文继续使用 `A0-A4` 和 `Z0-Z2`，不占用长期路线中 PostgreSQL 等能力使用的 Phase
编号。

## 2. vNext Definition of Done

只有以下项目全部有直接证据时，MVP vNext 才能标记为 met：

- [ ] Agent A0-A4 的 stage、任务和 checkpoint 全部完成；
- [x] Demo SQLite 上的 Schema-aware Generate 只使用真实 schema，并返回 SQL diff；新引入的
      JOIN 必须具有匹配的 `declared_foreign_key` evidence；
- [x] `Fix with Agent` 使用结构化错误和真实 columns，editor version 变化时不覆盖用户内容；
- [x] 用户显式启用 Read Only mode 后，Agent 能完成单条 SQLite SELECT 的
      analyze -> explain/execute -> inspect -> evidence answer 闭环；
- [x] Tool Runtime 在 Rust 端拒绝 write、DDL、multi-statement、Unknown risk、越权 tool 和
      超预算请求；
- [x] Agent run 可取消，tool、evidence、partial、failed、cancelled、completed 状态在
      Workbench Panel 中可见且 listener 可释放；
- [ ] Zeus Z1 spike 满足依赖、包体、性能和双 WebView 的准入门；
- [ ] Zeus Z2 以产品 preference 提供 Preview，只渲染 success grid，native renderer
      保持默认和即时回退；
- [ ] NULL/BLOB/布尔/日期展示、截断提示、选择、单格/行/列/CSV/TSV copy、历史、错误、
      空态、取消、主题、缩放、高对比和键盘导航没有回归；
- [ ] macOS WebKit 与 Windows WebView2 均完成 Agent + Zeus 原生走查；
- [ ] SQLite Stable / MySQL Preview / PostgreSQL Planned 未被改变，secret 和 query rows
      未新增落盘、日志或遥测路径；
- [ ] §8 的自动化、构建、Rust 和 release checks 全部满足。

如果 Z1 得出 No-Go，不能把“评估完成”算成 Zeus 接入完成，也不能绕过门槛强行增加
生产依赖。此时 vNext 保持未完成，必须由产品负责人明确修改 Zeus 目标或批准新的方案。

## 3. 架构决策与不变量

1. **Agent runtime 在本地 Rust**：loop、tool dispatch、policy、budget、audit 和
   cancellation 不放进 view 或模型 provider。
2. **只复用一个 SQL Core**：Agent 通过 `SqlCoreAdapter` 组合现有 V1/V2 能力，不新增
   driver、连接池或第三套 connection manager。
3. **Capability + Policy 双门**：A2 前统一 schema；每个 tool call 在 Rust 端重新授权。
4. **权限渐进开放**：A0-A2 保持 Suggest Only 且零 query call；A3 通过后，只有用户显式
   启用的 Read Only mode 可以执行单条只读查询。write/DDL 不属于 vNext。
5. **证据和模型文本分离**：schema、analysis、plan、error 和 result shape 使用 typed
   evidence；模型文本不能伪装成数据库事实。
6. **Zeus 是叶子依赖**：只允许从 `src/vs/workbench/contrib/sqlResult/` 内的 adapter
   动态加载，不进入 `src/vs/base`、`src/vs/platform`、Workbench shell 或 extHost。
7. **Native renderer 永久可回退**：Zeus Preview 不改变 SQL result wire format、
   persistence、copy service 或 running/error/empty/mutated state ownership。
8. **依赖必须先审批**：parser、model/network 和 Zeus production dependency 都要精确
   锁版，并在对应 spike/ADR 通过后才修改 Cargo 或 pnpm lockfile。

## 4. 依赖图

```text
Core MVP 00-08 (met)
        |
        +--> Agent A0/A1 foundation --> A2 Suggest Only --> A3 Read Only --> A4 Workbench --+
        |                                                                               |
        +--> Zeus Z0 evaluation (done) --> Z1 reproducible spike ------------------------+
                                                                                        |
                                                                                        v
                                                                          Z2 Result Grid Preview
                                                                                        |
                                                                                        v
                                                                               R0 vNext release
```

允许并行的唯一主路径是：Z1 可以与 A0.2/A1.2、A2 或 A3 并行，因为 Z1 不修改生产
Result surface。A2 -> A3 -> A4、Z1 -> Z2、A4 -> Z2 和 Z2 -> R0 必须顺序执行。

## 5. Stage 索引

| Stage | 交付                  | 依赖                         | 当前状态（2026-08-17）                                                                                   | 完成证据                                                                                                                        |
| ----- | --------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| B0    | Core MVP 00-08        | 无                           | 已完成                                                                                                   | Phase 08 自动化、Demo、live MySQL 和原生 Validate 记录                                                                          |
| A0    | SQL Intelligence      | B0                           | 已完成（A0.2 parser No-Go）                                                                              | dialect corpus、Unknown fail-closed、parser ADR                                                                                 |
| A1    | Schema Context        | A0 typed refs                | A1.1-A1.3 已完成                                                                                         | adapter、bounded schema/FK graph search/cache、invalidation tests                                                               |
| A2    | Suggest-only Runtime  | A0/A1 + canonical capability | A2.1-A2.4 完成                                                                                           | state/budget/policy/scripted model/bridge，零 query call                                                                        |
| A3    | Read-only Agent       | A2                           | A3.1/A3.2 与 Checkpoint R 已完成                                                                         | SQLite 真闭环，write/multi/Unknown deny，cancel/budget，result policy                                                           |
| A4    | Workbench Integration | A3 service contract          | A4.1/A4.2 与结构化 native evidence gate 已实现；Checkpoint W 待完成                                      | Editor/Error/Schema/Result/Panel tests 与双平台/人工 QA                                                                         |
| Z0    | Zeus 采用评估         | B0                           | 评估完成，生产未接入                                                                                     | 选择性采用评估与边界记录                                                                                                        |
| Z1    | Data Grid Spike       | Z0                           | Z1.1/Z1.2 已完成；Z1.3 为 No-Go（v6 下 10k 只改善 1.0%，且缺 revision-bound 双 WebView/bundle evidence） | measurement contract v6 balanced raw records；platform evidence schema v2；截图/hash、provenance、bundle audit 与 Go/No-Go 记录 |
| Z2    | Result Grid Preview   | Z1 Go + A4                   | 禁止开始（Z1 No-Go）                                                                                     | feature flag、native fallback、行为契约和原生 QA                                                                                |
| R0    | vNext Release Gate    | A4 + Z2                      | prework 已实现；release gate 保持 No-Go                                                                  | §2 DoD 与 §8 verification matrix 全绿                                                                                           |

## 6. 实施顺序与 Checkpoint

### Slice 1：完成 Agent Foundation

Checkpoint F 先执行 Agent 规格中的 A0.2 和 A1.2。A0.1 与 A1.1 的已完成记录保持不变，
不重复实现。A1.2 先交付稳定排序、object/byte budget、TTL/invalidation；A1.3 随后在同一
SQL Core adapter boundary 内补齐 bounded declared-FK graph。

**Checkpoint F：已完成（2026-08-12）。** 证据记录见
[`phase-a0-a1-foundation-verification.md`](./phase-a0-a1-foundation-verification.md)
和 [`ADR 0003`](../adr/0003-sql-agent-parser-boundary.md)。

**A1.2 bounded snapshot contract hardening（2026-08-14）：** SQLite driver 在读取时执行固定
object、全局 column 与 serialized-byte 上限并显式报告截断；`LocalSqlCoreAdapter` 在映射和缓存前
再次校验所有上限及顶层/对象级截断一致性。越界或自相矛盾的 driver snapshot 返回 structured
internal error 且不进入 cache，后续有效重载可以恢复。

**A1.3 SQLite Schema Graph + `relation.search`（2026-08-16）：** SQLite Stable 通过现有 V2
`SqlConnection` metadata boundary 返回有界、稳定排序的 declared foreign keys。复合外键按 column
ordinal 原子保留；table/FK/column/serialized-byte 任一 hard cap 无法容纳完整关系时整条丢弃，并显式
报告 `truncated`。`LocalSqlCoreAdapter` 以 opaque connection id、schema 和 metadata revision 缓存
固定 hard-cap graph，并在 close/reopen、refresh 与成功 metadata-changing statement 后与 schema cache
一起失效。

`relation.search` 返回一到两跳、受 path/edge/byte budget 限制的 typed
`declared_foreign_key` path evidence。遍历可双向，edge 始终保留数据库声明方向；
supported-empty、unsupported 与 truncated 保持可区分。Schema-aware Generate 可在
`schema.search` 内部使用 graph 扩展相关对象，外部工具顺序仍严格为
`schema.search -> sql.parse -> final`，且 `queryCallCount = 0`。只有匹配的
`declared_foreign_key` evidence 可以支持新 JOIN；没有 FK evidence 时降级为单表 SQL，禁止根据
`user_id`/`id` 等列名猜测关系。MySQL Preview 与 PostgreSQL Planned 不增加该 runtime surface，
driver maturity 不变。完整证据见
[`phase-a0-a1-foundation-verification.md`](./phase-a0-a1-foundation-verification.md)。

**Checkpoint F：** focused Rust tests、`pnpm run test:rust`、`pnpm run rust:check`、
`pnpm run rust:clippy` 和 `pnpm run rust:fmt` 全绿；parser 选择有 ADR，Agent caller 看不到
V1/V2 store identity 或 secret。

### Slice 2：A2 Suggest-only Runtime

严格按 A2.1 domain/state/budget/evidence -> A2.2 capability/policy -> A2.3 deterministic
gateway/loop -> A2.4 `ISqlAgentService`/Tauri bridge 实施。先迁移 Phase 06 的四类 action，
不增加 query tool。

**A2.1：已完成（2026-08-12）。** 领域对象、Rust 单点状态机、可取消 token、模型/tool/schema/result
预算和带 TTL/容量上限的脱敏 evidence store 已落地。验证记录见
[`phase-a2-1-runtime-domain-verification.md`](./phase-a2-1-runtime-domain-verification.md)。

**A2.2：已完成（2026-08-12）。** 前端 plugin declaration 与 Rust policy 共用 canonical capability
wire strings；Rust 端拒绝未知 capability、未知 tool、缺少 required capability、超大参数，以及 A2
阶段尚未开放的 explain/execute/result/history tools。验证记录见
[`phase-a2-2-capability-policy-verification.md`](./phase-a2-2-capability-policy-verification.md)。

**A2.2 backend grant hardening（2026-08-14）：** IPC `capabilities` 只作为 opt-down hint；Rust
按内建 task/mode profile 计算固定 grant，再保存 `requested ∩ grant`。Suggest-only、connected
Generate、Read-only Assistant 与 Read-only Explain/Optimize 各自拥有独立最小集合；Read-only
Assistant 的固定上限是 `agent.tool`、metadata、execute-read 与 result-shape 四项。write、filesystem、
network、history 与未经可信批准的 result sample 不会被任何 profile 授予。

**A2.3：已完成（2026-08-12）。** 严格 JSON model gateway、deterministic provider 和 Suggest-only
loop 已落地；坏 JSON、未知 tool、缺少 capability、超预算和取消均返回 structured error，且 loop
没有 query adapter，所有路径报告 `queryCallCount = 0`。验证记录见
[`phase-a2-3-suggest-only-loop-verification.md`](./phase-a2-3-suggest-only-loop-verification.md)。

**A2.4：已完成（2026-08-12）。** `ISqlAgentService`、Tauri command/event bridge、可 dispose
的 run listener 和全局 `AgentRuntimeState` 已实现；A2 验收时 bridge 只运行 Suggest-only loop，
保持零 query call。验证记录见
[`phase-a2-4-service-bridge-verification.md`](./phase-a2-4-service-bridge-verification.md)。

**A2.4 lifecycle hardening（2026-08-14）：** start/run 已拆成可信 request 分配与仅凭 run id
执行，run revision 单调递增，前端拒绝迟到 event/response；terminal precedence、worker failure、
run/request 容量、cancel evidence cleanup 和工具取消后的原子 usage/evidence 提交均有测试证据。
run store 淘汰最旧终态 run 时会同步释放其 ephemeral evidence，避免 orphan evidence 在 TTL 内
占满全局 entry/byte budget。

**Schema-aware Generate backend loop（2026-08-14）：** connected Generate 前端只提交 opaque
`connectionId`，不再提交可伪造的 schema payload。Rust 通过 `LocalSqlCoreAdapter` 在该连接内执行
有界 `schema.search`，再对 draft 执行 `sql.parse`；只有严格满足
`schema.search -> sql.parse -> final`、单条 `ReadOnly` 且 final SQL 与已解析 draft 完全一致时才返回
proposal。缺少 `database.readMetadata`、跨连接 metadata、真实检索后超 run budget、Read Only mode
路由和任何额外/乱序 tool 均 fail closed；全路径 `queryCallCount = 0`。

**Goal-grounded Read-only Explore bridge（2026-08-15）：** `Assistant + ReadOnly` 前端只请求
`agent.tool`、`database.readMetadata`、`database.executeRead` 和 `database.readResultShape`，且不提交
schema/result handle。Rust 使用同样的 backend-owned grant，组合现有 metadata/static-analysis 与
SQLite read-only/result executor；其他 task/mode 不进入该路由。完整证据见
[`phase-agent-checkpoint-r-explore-verification.md`](./phase-agent-checkpoint-r-explore-verification.md)。

A2 overall 已完成；A2 Suggest-only profile 继续保持零 query call。真实执行只存在于 A3 的显式
Read Only SQLite 路径。

**Checkpoint S：已完成（2026-08-12）。** scripted model 覆盖坏 JSON、未知 tool、超预算、cancel
和非法状态转换；四类 action 行为等价；所有路径的 query call count 为 0。A2.4 bridge/service
验证记录补充于上述 phase record。

### Slice 3：A3 Read-only Agent

先增加 `sql.explain`/`sql.execute_readonly`，再增加 result shape/aggregate/sample policy。
SQLite 是 release 主线；MySQL 只做 opt-in compatibility，不能升级 maturity。

**A3.1：已完成（2026-08-12）。** Rust read-only adapter 只接受已打开且显式
`read_only` 的 SQLite 连接；`sql.explain` 返回 SQLite query plan，`sql.execute_readonly`
返回受限查询结果。policy 与 adapter 都拒绝 write、DDL、multi-statement、Unknown、非 SQLite
和可写连接。Workbench 通过 `ISqlAgentService` 接入两个命令。验证记录见
[`phase-a3-1-read-only-tools-verification.md`](./phase-a3-1-read-only-tools-verification.md)。

**A3.1 physical cancellation hardening（2026-08-14）：** SQLite Agent query 使用
`{runId, callId}` owner、progress handler 与 `InterruptHandle`；cancel 只中断匹配 run，等待锁取消、
owner mismatch、普通未登记查询隔离和中断后连接复用均有真实 recursive CTE 测试。Read-only tool
executor 还绑定 run context 的 opaque connection id，跨已打开 reader 的 execute/explain 在 query 前拒绝。

**A3.2：已完成（2026-08-12）。** Result policy 将查询结果拆成不含 rows 的 shape 与本地
aggregate envelope；rows 只在 `result.sample` 显式批准后按 row/byte cap 输出，并对敏感列、BLOB
和疑似 token/private-key 文本执行二次 redaction。`ReadOnlyAgentLoop` 已接入 bridge，结果句柄
保存在有界内存 store 中，不进入持久化、日志或默认 model context。验证记录见
[`phase-a3-2-result-policy-verification.md`](./phase-a3-2-result-policy-verification.md)。

2026-08-15 已增加 goal-grounded Demo SQLite Explore 自动化纵切：中文 goal
“按天汇总最近 7 天订单”按 `schema.search -> sql.parse -> sql.execute_readonly -> result.inspect`
生成真实 `orders.amount/created_at` 聚合、执行一次 query，并只把 Schema、Analysis、ResultShape 与
Aggregate evidence 交给 final answer。goal/connection/parsed SQL/resultRef 均由 Rust runtime 绑定，
evidence batch 与 usage/context/state 原子提交；验证记录见
[`phase-agent-checkpoint-r-explore-verification.md`](./phase-agent-checkpoint-r-explore-verification.md)。

内置 Phase 08 Demo bootstrap 现先 seed，再以稳定 `demo-sqlite` ID 将 V1/V2 saved/open runtime 注册为
显式只读；每个 Workbench 进程都会静默恢复 runtime，但不重放 onboarding。历史可写 runtime 会被替换，
已匹配的 V1 runtime 与 Agent cancel handle 保持不变；已实例化 Data Sources 和已恢复 SQL Editor 会同步
连接缓存而不抢焦点。V1/V2 任一持久化失败会关闭两条 Demo query runtime，V2 内存 profile 回滚后等待
下次启动重试。V1 lifecycle mutation 统一串行化；被替换的 SQLite handle 会在 bootstrap 返回前 retire 并
drain active、queued 与 pre-VM 查询，失败保存也不能与并发 close/replace 交错后复活旧 runtime。
Explore 自动化直接使用该产品 bootstrap，普通 V1 mutation deny 与真实单 query Agent 闭环均有测试。

**Checkpoint R：已完成（2026-08-15）。** 自动化 Generate/Fix/Explore 用户故事与
deny/cancel/budget/result-policy 证据已具备；connected Fix 只提交 opaque connection、失败 SQL、
structured error 与 editor identity/version，由 Rust 执行真实 `schema.search -> sql.parse -> final`，
缺失或空白 connection 在 run allocation 前 fail closed 且不回落 generic gateway；同时拒绝 forged
renderer schema、write/multi/Unknown、额外/重排 tool 与替换 final SQL，并保持零 query call。
macOS 原生 Nyala 已完成 Demo SQLite Generate/Fix/Explore 三故事：Generate/Fix 均检索真实 backend
schema、通过 parse 且不执行 query；Explore 严格执行一次只读 SQLite query，再 inspect 3 行未截断
结果。证据、binary/artifact SHA-256 与边界记录见
[`phase-agent-checkpoint-r-explore-verification.md`](./phase-agent-checkpoint-r-explore-verification.md)。
write、DDL、multi-statement、Unknown、未经 capability/policy 授权和超预算请求继续在 Rust 端拒绝；
默认不把 rows 放入模型上下文。

### Slice 4：A4 Workbench Integration

依次交付 Editor/Error diff artifact、Agent Panel、Schema action、Result action。Panel 只是
Rust run projection，不能成为授权边界；关闭 Panel 释放 UI resource，但不隐式取消 run。

**A4.1：已实现（2026-08-12）。** SQL Agent artifact model 记录 run/editor/version/base SQL，
现有 Generate/Optimize 草稿动作在用户选择后才应用；版本、editor identity 或基线文本变化时
拒绝覆盖并报告 stale。验证记录见 [`phase-a4-workbench-verification.md`](./phase-a4-workbench-verification.md)。

**A4.2：actions/Panel 已实现（2026-08-15）。** SQL Agent Panel 已注册到 Workbench Panel，消费
typed run event 并展示 state、usage、answer、evidence refs，Start/Cancel listener 均由 ViewPane
生命周期管理。Schema action 只发送 opaque connection reference；真实、有界表/列 metadata 由 Rust
adapter 绑定连接后检索并形成 typed evidence。Result action 只投影 result shape，不把 rows 放进 Agent
context。Fix action 同样不再提交 frontend schema；它携带失败执行的 editor identity/version，并复用
backend metadata adapter 与严格 Suggest-only draft verification；缺失/空白 connection 会在 Rust
allocation 前拒绝。Chromium desktop/narrow 与 ARIA/Tab
检查以及 macOS embedded Workbench surface/viewport 已通过；macOS 真实键盘、Windows WebView2 和
真实 screen-reader walkthrough 仍待完成。

**Checkpoint W：未完成。** Chromium desktop/narrow、ARIA contract、stale editor、dispose/cancel、
九种 Rust/Workbench run state 对齐、失败后的 Cancel ownership 与 macOS 原生 viewport/DPR 已通过；
macOS 真实键盘、Windows WebView2 与真实 VoiceOver/Narrator 走查仍缺证据。2026-08-16 已交付 native
evidence manifest v2、逐 gate attestation v2、先 capture 后 review/attest 的双 workflow、独立 PNG/
snapshot/calibration 重算、GitHub run/artifact API identity 与 fail-closed gate schema v2；attestation
workflow 仅允许 protected default branch，使用 `sql-agent-checkpoint-w` environment，并且不再执行
capture revision 自带的 verifier。capture revision/ref 必须与受保护 attestation revision/ref 一致；
attestation run 必须在 capture 完成后创建，artifact 必须未过期、带 GitHub SHA-256 digest 且时序有效。
R0 现在消费结构化 `phase-a4-checkpoint-w.json`，不再扫描验证文档关键词。当前 report 保持 `NO-GO`，
这项基础设施不等于 Checkpoint W 签收。

### Post-vNext 增强：A5 SQLite Query Optimization

**A5：已实现（2026-08-17；不属于 vNext release 依赖链）。** 独立实施与验证记录见
[`sql-workspace-agent-a5-implementation-plan.md`](../sql-workspace-agent-a5-implementation-plan.md)。
Stable SQLite Optimize 固定执行 original parse、bounded `index.list`、original explain、rewrite parse、
rewritten explain 和 typed comparison；terminal evidence 明确保持 `performanceVerified=false` 与
`semanticsVerified=false`。Workbench 只提交 opaque connection/editor identity/version/full SQL；
runtime 返回时已 stale 的 target 只显示 Open draft，选择后的再次校验也会阻止后续变化覆盖编辑器。
该实现不完成 Checkpoint W，不改变 Z1.3/R0 `NO-GO`，也不准入 Z2。

### Parallel Spike：Z1 Zeus Data Grid

Z1 可从 Slice 1 开始并行，但只允许 benchmark harness、临时 adapter 和决策记录，不修改
默认 renderer。必须比较 native `<table>`、`WorkbenchTable` 与 Zeus，而不是只跑上游 demo。

**Z1.1：已完成（2026-08-12）。** 精确 beta 版本、license、integrity、依赖闭包和前序
bundle smoke 记录见 [`phase-z1-spike-verification.md`](./phase-z1-spike-verification.md)。
该任务没有修改生产依赖。

**Z1.2：已完成（2026-08-12；measurement contract v6 于 2026-08-17 重测）。** 三 renderer
benchmark 已覆盖 1k×20、10k×50、宽列和窄面板，运行 3 次并保存原始结果；脚本和指标边界见
[`phase-z1-spike-verification.md`](./phase-z1-spike-verification.md#z12-三-renderer-benchmark)。
该结果仍是 Chromium-compatible headless characterization，不构成双 WebView 通过。

**Z1.3：gate verifier 已实现，当前 No-Go（2026-08-12；platform evidence schema v2 与
measurement contract v6 于 2026-08-17 加固）。** [`phase-z1-gate.json`](./phase-z1-gate.json)
固化了 1k×20/10k×50 主指标、gzip budget 和双 WebView 的 fail-closed 准入。Chromium
characterization 必须提供 measurement contract v6 的
`4 workloads × 3 renderers × 3 runs = 36` 条唯一 raw record；macOS embedded WKWebView 与
Windows embedded WebView2 各自必须提供 platform evidence schema v2 artifact，每个平台的
`4 workloads × 3 renderers × 5 runs = 60` 条唯一 raw record 都必须符合 measurement contract
v6。每份 report 与 record 还必须声明 `renderer-balanced-rotation-v1`，record 的 1-based
`executionOrdinal` 必须逐项匹配由 workload、iteration 与 renderer 重算的确定性计划。gate 从 raw
record 重新计算 summary，不信任报告内的聚合值；每个平台还必须提供 12 张首轮截图
的 manifest，每张图都绑定唯一 run token/viewport，且实际文件的 realpath、bytes、SHA-256、CSS
viewport × DPR 物理尺寸和像素多样性都要通过验证。

Measurement contract v3/v4/v5 已被取代：v3 可能把缺失可见行的 `visibleRowIndex: -1` 误判为提交；
v4 又允许预渲染 native table 在没有 presentation opportunity 的同一 task 内完成，而 virtual renderer
必须等待一帧，形成不对称 baseline。v5 要求 20 个真实位移样本都在 post-presentation opportunity
之后校验 scroller 内第一列的 row identity/content，timeout 直接失败，并记录与 attempt 一致的
`presentationOpportunities`。v6 保留这些 completion 语义，同时消除固定按 renderer 分组执行造成的
JIT/cache/GC/thermal 顺序偏差：每个 workload 按 iteration 轮转 renderer，并把 execution order 与
ordinal 纳入 stale-result identity 和 gate 重算。

所有 Chromium/native/bundle audit 产物必须绑定同一个 repository、source revision/ref、workflow
run id/attempt；每个平台还要记录 native binary SHA-256，dependency audit、Chromium、WKWebView 与
WebView2 必须记录一致的 Zeus bundle SHA-256。fresh structured bundle audit 会复核精确版本、license、
integrity、production dependency closure，以及实际 bundle 的 raw/gzip bytes 和 SHA-256。51 个 Z1
verifier contract tests 覆盖 raw/summary 伪造、真实 scroll displacement/target/row/timing、重复
iteration/run token、平衡 execution plan/ordinal、viewport calibration、截图物理尺寸/run identity、路径逃逸、缺失 trusted expected
workflow provenance、schema version、跨平台 provenance、bundle
digest/audit 与 legacy driver evidence 的拒绝路径。该证据链只验证 spike，没有增加生产 Zeus 依赖或
renderer integration。

受保护的 `SQL Result Grid Z1 Gate Attestation` workflow 只允许 protected default branch，并使用
`sql-result-grid-z1-gate` environment。它精确验证同一 platform run 的四个未过期、带 SHA-256 digest
的 artifacts，按 GitHub API URL 下载并校验 aggregate ZIP，再由 trusted checkout 重算 gate。
attestation manifest 绑定 gate、benchmark、platform evidence、Zeus audit、Zeus bundle 与 platform-run
六份 SHA-256。9 个 Z1 attestation contract tests 覆盖 exact artifact identity、digest/retention/timestamp
与 protected workflow contract；这些测试不改变当前性能 `NO-GO`。

当前 No-Go 有独立的性能与证据阻塞：本地 v6 balanced characterization 的 1k×20 scroll interaction
相对最佳非 Zeus baseline 回归 `1.7%`，已满足“不回归超过 10%”；10k×50 scroll p95 只改善
`1.0%`，仍低于预注册的 `20%` 门槛。该本地记录还
明确标记 `sourceTreeClean: false`，同时缺少绑定当前 revision 的完整 macOS/Windows 双 WebView
evidence 和 fresh bundle audit/Zeus bundle digest evidence。因此不能开始 Z2，也不能把 Z1 评估写成 Go。

2026-08-17 的有界 feasibility profile 进一步把性能分支收敛为
`PRESENTATION_FLOOR_LIMITED`：6 次平衡重复中 WorkbenchTable/Zeus 为 `20.1/20.0ms`，共同
post-presentation floor 为 `18.5ms`，而 20% 门槛要求 Zeus `<=16.08ms`；即使假设 renderer 工作
为零，最大可观测改善也只有 `8.0%`。该非门禁 profile 保留 12 条 records、240 个 scroll 与 240 个
floor raw samples，不改变 v6、阈值或正式 gate evidence。继续调优临时 adapter 已到停止条件；除非
产品负责人显式重新预注册主指标/门槛，否则 Z1.3 维持 No-Go。

**Checkpoint Z-Go：** §7 的 Z1.1-Z1.3 全部通过并记录 Go。任何一项失败均为 No-Go，
禁止开始 Z2。

### Slice 5：Z2 Result Grid Preview

A4 与 Z-Go 都完成后，提取最窄 renderer seam，加入 SQL-local Zeus adapter 和产品
preference。Preview 只接 success 数据态；native 保持默认，故障时无需迁移数据即可回退。

**Checkpoint Z-Preview：** 行为契约、bundle budget、macOS/Windows 原生 QA 与回退演练
通过；Zeus import 没有离开 SQL Result contribution。

### Slice 6：R0 Release

将 `test:sql-agent`、Zeus result contract 和必要的 deterministic benchmark smoke 纳入
默认或 release gate，更新状态表和验证记录，完成一次 Demo SQLite Agent + Zeus Preview
原生 walkthrough。

**R0 prework：已完成（2026-08-12）。** 默认 `pnpm run test` 已纳入
`test:github-workflows`、`test:sql-agent`、`test:sql-result-grid-benchmark`、`test:sql-result-grid-zeus-audit`、
`test:sql-result-grid-gate`、`test:sql-result-grid-attestation` 与 `test:sql-mvp-vnext-release`；Zeus result
contract、Z1 Go、双平台原生走查和 Demo SQLite + Zeus Preview walkthrough 仍待 Z2 准入，不代表 R0
完成。受保护的 `SQL MVP vNext Release Evidence` workflow 只允许 protected default branch，并使用
`sql-mvp-vnext-release` environment；它精确认证 A4/Z1 attestation run/artifact API metadata，经 GitHub
artifact API URL 下载、校验 ZIP SHA-256 和安全路径后，只把认证后的 raw evidence 交给 schema v3 R0。
R0 重算 Checkpoint W 四份与 Z1 六份 raw input digest，并拒绝 forged/expired/时序错误 artifact、完整
手写 Z1 `GO`、revision/ref 不一致以及不完整 gate contract。R0 verifier 的 30 个 contract tests 已进入
默认测试链；当前
[`phase-vnext-release-gate.json`](./phase-vnext-release-gate.json) 保持 `NO-GO`。

2026-08-17 GitHub API 审计确认默认分支 `mvp` 已启用 strict branch protection，但仓库 environment
列表为空，本地新增的 Checkpoint W/Z1/R0 attestation workflow 也尚未发布到远端。管理员仍需创建
`sql-agent-checkpoint-w`、`sql-result-grid-z1-gate`、`sql-mvp-vnext-release` 三个 environment 并启用
required reviewers，在 workflow 发布后把 `actionlint` check 纳入保护规则。workflow 文件不能创建这些
策略；完成发布、配置和真实原生证据前，Checkpoint W、Z1.3、R0 均保持 `NO-GO`，Z2 禁止开始。

## 7. 原子任务

Agent 任务 A0.2-A4.2（含 A1.3）的 acceptance、verification 和预计文件边界以
[`sql-workspace-agent-design.md §16`](../sql-workspace-agent-design.md#16-实施任务切片) 为准。
每个实现分支仍需把任务控制在约 5 个文件；不得把一个 Stage 合并成单个大 PR。

Zeus 轨新增以下可独立验收任务：

| Task | 说明                                    | Acceptance                                                                                                                                                                                      | Verification                                                                                                                                                                        | Dependencies | Files likely touched                                          | Scope |
| ---- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------- | ----- |
| Z1.1 | 固定包与依赖审计协议                    | 精确版本、license、integrity、production closure 和 gzip 增量可复核；无生产改动                                                                                                                 | 临时安装、`pnpm why`、esbuild/gzip 记录                                                                                                                                             | Z0           | Zeus evaluation、spike record                                 | S     |
| Z1.2 | 建立三 renderer benchmark               | 覆盖 1k×20、10k×50、宽列、窄面板；分离 render/scroll/heap/IPC/format 指标                                                                                                                       | `benchmark:sql-result-grid` 重复运行并保存原始结果                                                                                                                                  | Z1.1         | benchmark script、fixture、package script                     | M     |
| Z1.3 | 双 WebView Go/No-Go                     | 1k×20 关键交互无超过 10% 回归；10k×50 的预注册主指标相对最佳非 Zeus baseline 至少改善 20%；gzip ≤30 KB；repository/ref/revision/run provenance 一致，native binary 与 Zeus bundle digest 可复核 | measurement contract v6 balanced raw records/summary recompute；platform evidence schema v2 的 macOS WKWebView + Windows WebView2 各 5 次；截图文件/hash/pixels；fresh bundle audit | Z1.2         | benchmark、platform evidence/截图、bundle audit、gate record  | M     |
| Z2.1 | 提取 renderer seam                      | native 行为 characterization 全绿；接口只拥有 success grid rendering                                                                                                                            | `pnpm run test:sql-result`                                                                                                                                                          | Z1 Go + A4   | result view、renderer contract、native renderer、tests        | M     |
| Z2.2 | 接入 Zeus adapter 与 Preview preference | 动态加载、精确锁版、所有 listener/observer 可释放、加载失败自动回退                                                                                                                             | adapter tests、`pnpm run build`、bundle inspection                                                                                                                                  | Z2.1         | adapter、preference、tests、package.json、pnpm-lock.yaml      | M     |
| Z2.3 | 对齐 SQL 语义和 copy                    | NULL/BLOB/布尔/日期、row/column identity、truncated scope 与所有 copy format 等价                                                                                                               | golden fixtures + `pnpm run test:sql-result`                                                                                                                                        | Z2.2         | adapter mapper、copy bridge、fixtures、tests                  | M     |
| Z2.4 | 对齐主题、焦点和无障碍                  | light/dark/high contrast、zoom、narrow panel、Tab/arrows、ARIA 和 focus loop 通过                                                                                                               | contribution tests + browser screenshots/keyboard QA                                                                                                                                | Z2.2         | adapter CSS、lifecycle helper、accessibility tests、QA record | M     |
| Z2.5 | 原生验证与回退演练                      | macOS/Windows 均能切换 Preview/native；关闭 flag 后无 schema/persistence migration                                                                                                              | Tauri walkthrough + rollback record                                                                                                                                                 | Z2.3 + Z2.4  | QA record、roadmap status                                     | S     |

## 8. Verification Matrix

| Requirement                  | Automated proof                                                                                                                                                                                                   | Native/manual proof                                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A0/A1 intelligence + context | focused `sql_analysis`/`core_adapter`/`relation_context`/driver FK tests；`test:sql-agent`；`test:rust`                                                                                                           | 无 secret/store identity/query rows 的序列化检查                                                                                                                                |
| A2 runtime + policy          | `cargo test --lib agent`；新增 `pnpm run test:sql-agent`                                                                                                                                                          | scripted run timeline inspection                                                                                                                                                |
| A3 read-only loop            | SQLite integration；deny table；cancel/budget tests                                                                                                                                                               | Demo SQLite Generate/Fix/Explore walkthrough（2026-08-15 已完成）                                                                                                               |
| A4 Workbench UX              | `test:sql-services`、`test:sql-editor`、`test:sql-result`、`test:sql-advanced`、44 项 Checkpoint W contract                                                                                                       | desktop/narrow、keyboard、accessibility、stale editor QA                                                                                                                        |
| Z1 admission                 | structured dependency/bundle audit；measurement contract v6 的 36 条 balanced Chromium raw records；summary/plan recompute；51 个 gate tests + 9 个 attestation tests；revision/run/bundle provenance consistency | platform evidence schema v2 + measurement contract v6：macOS WKWebView + Windows WebView2 各 60 条 balanced raw records、12 张截图及文件/hash/pixel 验证；binary/bundle SHA-256 |
| Z2 behavior                  | `test:sql-result` golden/contract tests；build chunk inspection                                                                                                                                                   | two-platform theme/focus/copy/fallback walkthrough                                                                                                                              |
| Driver/security invariants   | runtime status、connection、Rust policy/no-secret tests                                                                                                                                                           | MySQL 仍显示 Preview，PostgreSQL 仍显示 Planned                                                                                                                                 |

R0 prework 的自动化还包括 30 个 release verifier contract tests；只有经受保护 workflow 认证的完整
Z1 gate report schema v2（含 platform evidence schema v2 与 measurement contract v6/order）、Checkpoint W、
Z2 production dependency/renderer seam 和 roadmap completion 同时满足，release gate 才能变为 Go。

R0 必须报告以下命令的精确 exit status：

```bash
pnpm run test
pnpm run lint
pnpm run build
pnpm run rust:check
pnpm run rust:clippy
pnpm run rust:fmt
pnpm run test:mysql-integration  # opt-in，MySQL Preview compatibility
```

在仓库既有 `format:check` vendor baseline 未清理前，每个任务还必须对本次修改的
TypeScript/JavaScript/JSON/Markdown 文件执行 targeted Prettier check，并保证没有新增
格式化失败。

## 9. 风险与退出方式

| Risk                              | Signal                                 | Mitigation / exit                                  |
| --------------------------------- | -------------------------------------- | -------------------------------------------------- |
| Agent 复制数据库栈                | 新 driver/pool 或 view 猜测 V1/V2 id   | 只允许 `SqlCoreAdapter`；adapter tests fail closed |
| Capability 只有前端声明           | model/manifest 能绕过 tool guard       | A2.2 阻塞 A2/A3；每 call Rust policy table tests   |
| Result/sample 泄露                | rows 默认进入 prompt、log 或持久化     | shape-only 默认；sample cap + 单次批准 + redaction |
| Agent 与 Zeus 同改 Result surface | 并行分支修改相同 view/action contract  | Z1 可并行，Z2 必须等 A4 完成                       |
| Zeus beta 或依赖膨胀              | tag 漂移、构建工具进入 prod closure    | exact pin；Z1 No-Go；native fallback               |
| Zeus 只改善 DOM 数                | 端到端交互/heap/IPC 无收益             | 以预注册用户指标做 Z-Go，不以 DOM/FPS 宣传放行     |
| WebView/焦点回归                  | WebKit/WebView2 行为不同               | 双平台 gate；Preview 默认可回退                    |
| MVP 再次无限膨胀                  | A5+、write Agent、全局 Zeus 被顺手加入 | 严格执行 §10 非目标和独立规格门                    |

## 10. vNext 非目标

- Agent A5 Query Optimization 已按独立规格实现，但仍不是 vNext DoD、Checkpoint W、Z-Go、Z2 或 R0 的完成条件；A6 Write、A7 Skills、A8 Advanced 明确不在范围；
- cloud model、API key storage、MCP、multi-agent、long-term memory 和 vector database；
- MySQL Agent 自动执行、PostgreSQL runtime 或任何 driver maturity 提升；
- Zeus 全局设计系统、Workbench shell/Tree/Dialog/Menu/Editor 替换；
- Zeus 成为默认 renderer；默认切换需要 Z2 观察期后的独立 production decision；
- server-side sort/filter、cell editing、无限滚动、流式大结果、IPC 背压和十万级结果项目。

## 11. 状态更新规则

1. `docs/sql-mvp-phases/README.md` 是总状态入口，本文是 vNext 顺序和验收合同。
2. Stage 只能在 acceptance 与 verification 都有直接记录后标记完成。
3. 测试数量、commit、原生 QA 日期和 Go/No-Go 结论必须写入对应规格或验证记录。
4. 依赖 spike、实现完成和产品默认启用是三个不同状态，不能互相替代。
5. Core MVP 00-08 的历史完成状态不因 vNext 未完成而回退。
