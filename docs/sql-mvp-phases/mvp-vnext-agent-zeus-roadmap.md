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
- [ ] Demo SQLite 上的 Schema-aware Generate 只使用真实 schema，并返回 SQL diff；
- [ ] `Fix with Agent` 使用结构化错误和真实 columns，editor version 变化时不覆盖用户内容；
- [ ] 用户显式启用 Read Only mode 后，Agent 能完成单条 SQLite SELECT 的
      analyze -> explain/execute -> inspect -> evidence answer 闭环；
- [ ] Tool Runtime 在 Rust 端拒绝 write、DDL、multi-statement、Unknown risk、越权 tool 和
      超预算请求；
- [ ] Agent run 可取消，tool、evidence、partial、failed、cancelled、completed 状态在
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

| Stage | 交付                  | 依赖                         | 当前状态（2026-08-12）                                 | 完成证据                                                              |
| ----- | --------------------- | ---------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| B0    | Core MVP 00-08        | 无                           | 已完成                                                 | Phase 08 自动化、Demo、live MySQL 和原生 Validate 记录                |
| A0    | SQL Intelligence      | B0                           | 已完成（A0.2 parser No-Go）                            | dialect corpus、Unknown fail-closed、parser ADR                       |
| A1    | Schema Context        | A0 typed refs                | 已完成（FK graph 后续）                                | adapter、bounded search/cache、invalidation tests                     |
| A2    | Suggest-only Runtime  | A0/A1 + canonical capability | A2.1-A2.4 完成                                         | state/budget/policy/scripted model/bridge，零 query call              |
| A3    | Read-only Agent       | A2                           | A3.1/A3.2 已实现；Checkpoint R 待原生走查              | SQLite 真闭环，write/multi/Unknown deny，cancel/budget，result policy |
| A4    | Workbench Integration | A3 service contract          | A4.1 与 A4.2 actions/Panel 已实现；Checkpoint W 待完成 | Editor/Error/Schema/Result/Panel tests 与浏览器 QA                    |
| Z0    | Zeus 采用评估         | B0                           | 评估完成，生产未接入                                   | 选择性采用评估与边界记录                                              |
| Z1    | Data Grid Spike       | Z0                           | Z1.1/Z1.2 已完成；Z1.3 双 WebView Go/No-Go 待完成      | 可复现依赖/包体/性能/双 WebView Go/No-Go 记录                         |
| Z2    | Result Grid Preview   | Z1 Go + A4                   | 待开始                                                 | feature flag、native fallback、行为契约和原生 QA                      |
| R0    | vNext Release Gate    | A4 + Z2                      | 待开始                                                 | §2 DoD 与 §8 verification matrix 全绿                                 |

## 6. 实施顺序与 Checkpoint

### Slice 1：完成 Agent Foundation

执行现有 Agent 规格中的 A0.2 和 A1.2。A0.1 与 A1.1 的已完成记录保持不变，不重复
实现。A1.2 先交付稳定排序、object/byte budget、TTL/invalidation，再讨论 FK graph。

**Checkpoint F：已完成（2026-08-12）。** 证据记录见
[`phase-a0-a1-foundation-verification.md`](./phase-a0-a1-foundation-verification.md)
和 [`ADR 0003`](../adr/0003-sql-agent-parser-boundary.md)。

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

**A2.3：已完成（2026-08-12）。** 严格 JSON model gateway、deterministic provider 和 Suggest-only
loop 已落地；坏 JSON、未知 tool、缺少 capability、超预算和取消均返回 structured error，且 loop
没有 query adapter，所有路径报告 `queryCallCount = 0`。验证记录见
[`phase-a2-3-suggest-only-loop-verification.md`](./phase-a2-3-suggest-only-loop-verification.md)。

**A2.4：已完成（2026-08-12）。** `ISqlAgentService`、Tauri command/event bridge、可 dispose
的 run listener 和全局 `AgentRuntimeState` 已实现；bridge 只运行 Suggest-only loop，保持零
query call。验证记录见
[`phase-a2-4-service-bridge-verification.md`](./phase-a2-4-service-bridge-verification.md)。

A2 overall 已完成，下一步进入 A3.1；A3 之前不开放任何真实 query execution。

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

**A3.2：已完成（2026-08-12）。** Result policy 将查询结果拆成不含 rows 的 shape 与本地
aggregate envelope；rows 只在 `result.sample` 显式批准后按 row/byte cap 输出，并对敏感列、BLOB
和疑似 token/private-key 文本执行二次 redaction。`ReadOnlyAgentLoop` 已接入 bridge，结果句柄
保存在有界内存 store 中，不进入持久化、日志或默认 model context。验证记录见
[`phase-a3-2-result-policy-verification.md`](./phase-a3-2-result-policy-verification.md)。

Checkpoint R 的原生 Demo Generate/Fix/Explore 走查仍待 A4 Workbench integration 完成；A3
自动化 deny、cancel、budget 和 result-policy 证据已具备。

**Checkpoint R：** Demo SQLite 三个用户故事通过；write、DDL、multi-statement、Unknown、
未经 capability/policy 授权和超预算请求全部在 Rust 端拒绝；默认不把 rows 放入模型上下文。

### Slice 4：A4 Workbench Integration

依次交付 Editor/Error diff artifact、Agent Panel、Schema action、Result action。Panel 只是
Rust run projection，不能成为授权边界；关闭 Panel 释放 UI resource，但不隐式取消 run。

**A4.1：已实现（2026-08-12）。** SQL Agent artifact model 记录 run/editor/version/base SQL，
现有 Generate/Optimize 草稿动作在用户选择后才应用；版本、editor identity 或基线文本变化时
拒绝覆盖并报告 stale。验证记录见 [`phase-a4-workbench-verification.md`](./phase-a4-workbench-verification.md)。

**A4.2：actions/Panel 已实现（2026-08-12）。** SQL Agent Panel 已注册到 Workbench Panel，消费
typed run event 并展示 state、usage、answer、evidence refs，Start/Cancel listener 均由 ViewPane
生命周期管理。Schema action 使用真实、有界表/列 metadata；Result action 只投影 result shape，
不把 rows 放进 Agent context。Chromium desktop/narrow 与 ARIA/Tab 检查已通过；macOS WebKit、
Windows WebView2 和真实 screen-reader walkthrough 仍待完成。

**Checkpoint W：未完成。** Chromium desktop/narrow、ARIA contract、stale editor、dispose/cancel 和
所有 run state 自动化已通过；macOS 原生 viewport/键盘、Windows WebView2 与真实
VoiceOver/Narrator 走查仍缺证据。

### Parallel Spike：Z1 Zeus Data Grid

Z1 可从 Slice 1 开始并行，但只允许 benchmark harness、临时 adapter 和决策记录，不修改
默认 renderer。必须比较 native `<table>`、`WorkbenchTable` 与 Zeus，而不是只跑上游 demo。

**Z1.1：已完成（2026-08-12）。** 精确 beta 版本、license、integrity、依赖闭包和前序
bundle smoke 记录见 [`phase-z1-spike-verification.md`](./phase-z1-spike-verification.md)。
该任务没有修改生产依赖。

**Z1.2：已完成（2026-08-12）。** 三 renderer benchmark 已覆盖 1k×20、10k×50、宽列和
窄面板，运行 3 次并保存原始结果；脚本和指标边界见
[`phase-z1-spike-verification.md`](./phase-z1-spike-verification.md#z12-三-renderer-benchmark)。
该结果仍是 Chromium-compatible headless characterization，不构成双 WebView 通过。

**Z1.3：gate verifier 已实现，当前 No-Go（2026-08-12）。**
[`phase-z1-gate.json`](./phase-z1-gate.json) 固化了 1k×20/10k×50 主指标、gzip budget 和双
WebView 的 runs + renderer summary 检查；本机缺少 Safari remote automation 授权与 Windows
WebView2 driver，因此不能开始 Z2，也不能把 Z1 评估写成 Go。

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
`test:sql-agent` 与 `test:sql-result-grid-benchmark`；Zeus result contract、Z1 Go、双平台原生
走查和 Demo SQLite + Zeus Preview walkthrough 仍待 Z2 准入，不代表 R0 完成。新增
`verify:sql-mvp-vnext-release` 作为 fail-closed release-only guard；当前报告保持 `NO-GO`。

## 7. 原子任务

Agent 任务 A0.2-A4.2 的 acceptance、verification 和预计文件边界以
[`sql-workspace-agent-design.md §16`](../sql-workspace-agent-design.md#16-实施任务切片) 为准。
每个实现分支仍需把任务控制在约 5 个文件；不得把一个 Stage 合并成单个大 PR。

Zeus 轨新增以下可独立验收任务：

| Task | 说明                                    | Acceptance                                                                                             | Verification                                              | Dependencies | Files likely touched                                          | Scope |
| ---- | --------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ------------ | ------------------------------------------------------------- | ----- |
| Z1.1 | 固定包与依赖审计协议                    | 精确版本、license、integrity、production closure 和 gzip 增量可复核；无生产改动                        | 临时安装、`pnpm why`、esbuild/gzip 记录                   | Z0           | Zeus evaluation、spike record                                 | S     |
| Z1.2 | 建立三 renderer benchmark               | 覆盖 1k×20、10k×50、宽列、窄面板；分离 render/scroll/heap/IPC/format 指标                              | `benchmark:sql-result-grid` 重复运行并保存原始结果        | Z1.1         | benchmark script、fixture、package script                     | M     |
| Z1.3 | 双 WebView Go/No-Go                     | 1k×20 关键交互无超过 10% 回归；10k×50 的预注册主指标相对最佳非 Zeus baseline 至少改善 20%；gzip ≤30 KB | macOS WebKit + Windows WebView2 各 5 次，记录中位数和长尾 | Z1.2         | benchmark record、QA record                                   | M     |
| Z2.1 | 提取 renderer seam                      | native 行为 characterization 全绿；接口只拥有 success grid rendering                                   | `pnpm run test:sql-result`                                | Z1 Go + A4   | result view、renderer contract、native renderer、tests        | M     |
| Z2.2 | 接入 Zeus adapter 与 Preview preference | 动态加载、精确锁版、所有 listener/observer 可释放、加载失败自动回退                                    | adapter tests、`pnpm run build`、bundle inspection        | Z2.1         | adapter、preference、tests、package.json、pnpm-lock.yaml      | M     |
| Z2.3 | 对齐 SQL 语义和 copy                    | NULL/BLOB/布尔/日期、row/column identity、truncated scope 与所有 copy format 等价                      | golden fixtures + `pnpm run test:sql-result`              | Z2.2         | adapter mapper、copy bridge、fixtures、tests                  | M     |
| Z2.4 | 对齐主题、焦点和无障碍                  | light/dark/high contrast、zoom、narrow panel、Tab/arrows、ARIA 和 focus loop 通过                      | contribution tests + browser screenshots/keyboard QA      | Z2.2         | adapter CSS、lifecycle helper、accessibility tests、QA record | M     |
| Z2.5 | 原生验证与回退演练                      | macOS/Windows 均能切换 Preview/native；关闭 flag 后无 schema/persistence migration                     | Tauri walkthrough + rollback record                       | Z2.3 + Z2.4  | QA record、roadmap status                                     | S     |

## 8. Verification Matrix

| Requirement                  | Automated proof                                                                                          | Native/manual proof                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| A0/A1 intelligence + context | focused `sql_analysis`/`core_adapter` tests；`pnpm run test:rust`                                        | 无 secret/store identity 的序列化检查                    |
| A2 runtime + policy          | `cargo test --lib agent`；新增 `pnpm run test:sql-agent`                                                 | scripted run timeline inspection                         |
| A3 read-only loop            | SQLite integration；deny table；cancel/budget tests                                                      | Demo SQLite Generate/Fix/Explore walkthrough             |
| A4 Workbench UX              | `test:sql-services`、`test:sql-editor`、`test:sql-result`、`test:sql-advanced`、Agent contribution suite | desktop/narrow、keyboard、accessibility、stale editor QA |
| Z1 admission                 | dependency/bundle audit；deterministic benchmark output                                                  | macOS WebKit + Windows WebView2 benchmark record         |
| Z2 behavior                  | `test:sql-result` golden/contract tests；build chunk inspection                                          | two-platform theme/focus/copy/fallback walkthrough       |
| Driver/security invariants   | runtime status、connection、Rust policy/no-secret tests                                                  | MySQL 仍显示 Preview，PostgreSQL 仍显示 Planned          |

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

- Agent A5 Query Optimization 不阻塞 vNext；A6 Write、A7 Skills、A8 Advanced 明确不在范围；
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
