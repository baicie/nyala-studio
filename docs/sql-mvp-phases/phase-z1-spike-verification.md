# Z1 Zeus Data Grid Spike Verification

日期：2026-08-24

范围：Z1.1 dependency/bundle audit、Z1.2 reproducible renderer benchmark、Z1.3
revision-bound 双原生 WebView Go/No-Go。

当前结论：`Z1.3 = NO-GO`、`Z2 = 禁止开始`、`R0 = NO-GO`。Zeus 仍未加入生产依赖，
也没有 production renderer integration。beta.4 的 revision-bound macOS WKWebView 与 Windows WebView2
证据已经完整形成，但 5 个预注册性能检查失败；该结果不覆盖 beta.2/beta.3 历史证据，也不是 Go。

## 版本与测量合同

本记录中的版本字段有不同职责，不能互换：

- Chromium benchmark report 的顶层 `version: 1` 是 benchmark report schema；平台
  `platform-evidence.json` 的顶层 `version: 2` 是 platform evidence schema。后者描述
  embedded WKWebView/WebView2 的身份、截图、provenance 和平台汇总结构。
- `measurementContractVersion: 6` 是 Chromium 与两个原生 WebView 共享的测量合同，必须同时
  出现在 benchmark/platform report 及每条 raw record 上。它约束真实滚动位移样本、viewport/
  maximum-offset 推导、run token/stale-result identity、post-presentation completion boundary、
  有效 visible-row/content identity、attempt/presentation/timing 一致性、平衡 renderer execution
  order/ordinal，以及由 raw records 重算 summary 与执行计划的规则。
- admission benchmark 还必须声明 `workbenchTableImplementation: "real"`。每条
  `workbench-table` record 都必须携带真实 `WorkbenchTable` 的 exact prototype、Monaco table DOM
  signature 与 benchmark-only bundle SHA-256；Chromium、WKWebView 与 WebView2 的 digest 必须一致。
  `characterization` renderer 只用于诊断，不能满足该身份合同。
- `phase-z1-gate.json` 的顶层 `version: 2` 是 gate report schema，不是 platform evidence
  schema；它只描述门禁检查结果。只有顶层 `version: 2`、却不能证明 measurement contract v6
  的 artifact 不能作为当前 Z1.3 证据。

因此，下文使用“platform evidence schema v2”指平台 artifact 结构，使用“measurement contract
v6”指 raw measurement 及其跨 renderer/WebView 的一致性；“v2 raw records”不是有效术语。

Measurement contract v3/v4/v5 已被取代。诊断发现 v3 有两个测量缺陷：缺失可见行时返回的
`visibleRowIndex: -1` 在首行目标附近可能因 row tolerance 被误判为已提交；等待 renderer 的
`requestAnimationFrame` 时，probe 回调顺序也可能额外计入完整一帧。v4 要求 visible row 必须是
`0 <= index < rowCount` 的整数，但仍允许 full-DOM native table 在设置 `scrollTop` 后立即通过，
而 virtual renderer 必须等待 presentation opportunity，造成 `0.1ms` 对约 `19ms` 的不对称 baseline。
v5 在所有 renderer 的首次 probe 前强制跨过同一个 `requestAnimationFrame -> post-frame task`；
timeout 只能失败，不能冒充 presentation。probe 还必须位于目标 scroller 内，第一列内容必须匹配
row identity；每个 sample 记录与 `attempts` 一致的 `presentationOpportunities`。v6 保留 v5 的
completion boundary，并修复固定 `native -> WorkbenchTable -> Zeus` 分组执行造成的 JIT/cache/GC/
thermal order bias。每个 workload 按 iteration 轮转 renderer；report 与 record 声明
`renderer-balanced-rotation-v1`，每条 record 的 1-based `executionOrdinal` 由 gate 重新推导。gate
同时拒绝 report-level、record-level、boundary、execution plan 或 sample-level 的旧/缺失合同字段。

## Z1.1 审计结果

- 临时目录精确安装 `@zeus-web/data-grid@0.1.0-beta.2`，未修改 Nyala 的
  `package.json` 或 `pnpm-lock.yaml`。
- package license 为 MIT，registry `dist.integrity` 为
  `sha512-Tmw5sldixp52arDoGJC8HbeUJvSw6Yr9mRgMBT08zvZiFhLa0n2Ifnf7IrU1IgoAT/uZqfPsyeo8cdFS5cNGNw==`，
  unpacked size 为 279,075 bytes。
- direct dependency closure 包含 `@zeus-js/output-react-wrapper@0.1.0-beta.8`、
  `@zeus-js/output-vue-wrapper@0.1.0-beta.8`、`@zeus-js/runtime-dom@0.1.0-beta.8`、
  `@zeus-js/web-c-runtime@0.1.0-beta.8`、`@zeus-web/virtual@0.1.0-beta.2` 和
  `@zeus-web/zeus-compat@0.1.0-beta.2`；`@zeus-js/zeus@0.1.0-beta.8`、React 与 Vue 为 peer
  dependencies，不能未经审计直接进入 production closure。
- 结构化 producer
  [`scripts/create-sql-result-grid-zeus-audit.mjs`](../../scripts/create-sql-result-grid-zeus-audit.mjs)
  从实际安装包的 `package.json`、registry metadata 和实际构建 bundle 生成 evidence；输出包含
  package name/version/license/integrity/unpacked size、direct/peer dependency closure、原始 bytes、
  gzip -9 bytes、bundle SHA-256、producer checks/reasons 和 workflow provenance。
- gate 不信任手填的 bundle 大小或摘要。它重新读取 artifact 中的 bundle，复算原始 bytes、
  gzip bytes 和 SHA-256，并与 audit manifest、Chromium benchmark、macOS WKWebView、Windows
  WebView2 中的 `zeusBundleSha256` 交叉绑定。
- 前序隔离 smoke 曾记录 73,483 raw bytes、gzip -9 约 24,260 bytes；这只是历史测量，
  不再是 gate 的硬编码信任点，也不能替代当前 revision 的 fresh structured audit。当前
  [`phase-z1-gate.json`](./phase-z1-gate.json) 没有该 audit，因此 dependency check 为失败。
- 2026-08-18 在新临时目录重新精确安装并从 `dist/wc/auto.js` 打包，得到 73,494 raw bytes、
  gzip -9 24,311 bytes，SHA-256 为
  `0dddde8f65195667d1bdd0f574f2ac3a4ffa1c5b019c8f1a13db5bd2fc0a6794`。结构化 audit 的五项 package
  checks 全部通过；repository/revision/ref/run id/attempt 未在本地伪造，因此五项 provenance checks
  按预期失败、report 为 `blocked`。该临时 artifact 不是 fresh protected workflow audit，也没有修改
  production `package.json` 或 lockfile。

## 自动化证据

| 命令                                                                                                 | 结果                                         |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `pnpm add --dir <temp> @zeus-web/data-grid@0.1.0-beta.2`                                             | exit 0，仅临时目录                           |
| `pnpm view @zeus-web/data-grid@0.1.0-beta.2 dist.integrity dist.unpackedSize license version --json` | exit 0                                       |
| `pnpm why @zeus-web/data-grid`（临时目录）                                                           | exit 0，只有临时 root project 引用           |
| `esbuild <temp>/dist/wc/auto.js --bundle --minify`                                                   | exit 0，73,494 bytes                         |
| `node scripts/create-sql-result-grid-zeus-audit.mjs ...`                                             | exit 1，仅五项本地 provenance 缺失           |
| `pnpm run test:sql-result-grid-benchmark`                                                            | exit 0，51/51 tests 通过                     |
| `pnpm run test:sql-result-grid-webdriver`                                                            | exit 0，13/13 tests 通过                     |
| `pnpm run test:sql-result-grid-visual`                                                               | exit 0，7/7 tests 通过                       |
| `pnpm run test:sql-result-grid-zeus-audit`                                                           | exit 0，3/3 tests 通过                       |
| `pnpm run test:sql-result-grid-platform-evidence`                                                    | exit 0，1/1 test 通过                        |
| `pnpm run test:sql-result-grid-gate`                                                                 | exit 0，61/61 tests 通过                     |
| `pnpm run test:sql-result-grid-attestation`                                                          | exit 0，9/9 tests 通过                       |
| `pnpm run test:sql-mvp-vnext-release`                                                                | exit 0，35/35 tests 通过                     |
| real-mode 三 renderer × 四 workload × 三次本地 benchmark                                             | exit 0，36/36 records 为 `ok`                |
| 对上述 `/tmp` real report 运行 Z1 gate                                                               | exit 1，1k 通过；10k 改善 `-28.7%`，`NO-GO`  |
| `pnpm run verify:sql-result-grid-gate`                                                               | 当前 evidence 按预期 exit 1，`NO-GO`         |
| `pnpm run verify:sql-mvp-vnext-release`                                                              | 当前 release evidence 按预期 exit 1，`NO-GO` |

2026-09-17 计数复核：在 `882ba222` + 当前未提交 vNext 工作树上重跑相关脚本 suites，得到
`test:sql-result-grid-benchmark` 51/51、`test:sql-result-grid-webdriver` 13/13、
`test:sql-result-grid-visual` 7/7、`test:sql-result-grid-zeus-audit` 3/3、
`test:sql-result-grid-platform-evidence` 1/1、`test:sql-result-grid-gate` 61/61、
`test:sql-result-grid-attestation` 9/9、`test:sql-mvp-vnext-release` 35/35，且整套 `pnpm run test`
exit 0；上表旧的 8/8、2/2、59/59、32/32 已按本次运行更新。计数刷新只更新 suite 规模记忆，
不改变 `Z1.3 = NO-GO`、`Z2 = 禁止开始` 与 `R0 = NO-GO` 结论，也不构成新的 gate evidence。

## Z1.2 三 renderer benchmark

脚本 [`scripts/benchmark-sql-result-grid.mjs`](../../scripts/benchmark-sql-result-grid.mjs) 在
临时页面中生成确定性的 SQL-like fixture，比较 native `<table>`、`workbench-table` 和审计 bundle
中的 `zw-data-grid`。正式入口使用 `--workbench-table-implementation real`：Vite 构建 benchmark-only
JS/CSS，通过真实 `ContextKeyService`、`ListService` 与 `InstantiationService` 创建仓库源码中的
`WorkbenchTable`；configuration/keybinding 只使用满足构造合同的最小 stub。每个组合运行 3 次；
完整原始记录（含 user agent、fixture bytes、parse/format、render、scroll、DOM 和 heap 字段）见
[`phase-z1-benchmark.json`](./phase-z1-benchmark.json)。

脚本仍保留显式 `characterization` 模式供非准入诊断。checked-in `phase-z1-benchmark.json` 就是该旧
手写 fixed-row virtual-list artifact：它没有 `workbenchTableImplementation`、
`workbenchTableBundleSha256` 或 per-record `rendererImplementation`，因此新 gate 必须拒绝。下文表格
只能称为 fixed-row characterization 的历史数值，不能表述为真实 Workbench component benchmark。
真实模式同样是隔离组件 benchmark，不启动完整 Workbench，也不进入生产 bundle；其约 882 KB JS/
20.6 KB CSS raw 闭包与 Zeus 的 production `gzip <= 30,000` gate 无关。

任何包含 Zeus 的 benchmark 现在都必须通过 `--zeus-bundle <path>` 或 `NYALA_ZEUS_BUNDLE` 显式绑定
本轮临时 audit 生成的 bundle；runner 会在生成页面或启动浏览器前校验文件存在，不再回退到固定日期的
`/tmp` 路径。`pnpm run benchmark:sql-result-grid` 同时显式选择 `renderer all`、real WorkbenchTable 和
`--require-zeus true`，因此缺失、陈旧路径或无法运行的 Zeus 都会 fail closed，而不会生成看似完整的
admission report。

Measurement contract v6 要求 `4 workloads × 3 renderers × 3 repeats = 36` 条唯一 raw
records，并使用 `renderer-balanced-rotation-v1` 让每个 renderer 在 3 次重复中各占一次执行位置；
四个 workload 的起始 renderer 也确定性轮转。gate 从这 36 条记录重新计算全部 12 组 summary 和
1-based execution plan，并拒绝重复 iteration、ordinal、缺失指标或手工伪造的 summary。fresh workflow
benchmark 还必须绑定 `repository`、`sourceRevision`、
`sourceRef`、`workflowRunId`、`workflowRunAttempt` 和 `zeusBundleSha256`；checked-in
benchmark 是用临时目录 exact-pinned `@zeus-web/data-grid@0.1.0-beta.2` bundle 生成的本地
Chromium characterization；它有 36 条 v6 记录、base source revision 与 bundle digest，但
`sourceTreeClean: false` 明确记录 v6 实现尚未提交，且没有 GitHub workflow identity。该
`sourceRevision` 只能标识工作区的 base HEAD，不能复现 dirty worktree，也不能单独成为 Go 证据。

以下为 2026-08-17 checked-in measurement contract v6 benchmark 的中位数摘要，时间单位为 ms。
`scroll p95` 列表示每次
运行先收集 scroll samples 后计算的 per-run p95，再对 3 次运行取 median；跨运行的 p95
长尾仍保存在 JSON 的 `scrollP95Ms.p95` 中。v4 的 native `0.1/1.8ms` 值没有跨过共同
presentation boundary，已被 v5 取代，不应用于门禁判断；v5 的固定 renderer 分组结果又被 v6
平衡调度结果取代。

| workload / renderer                       | render | scroll p95 | DOM nodes |  heap delta | parse | format |
| ----------------------------------------- | -----: | ---------: | --------: | ----------: | ----: | -----: |
| 1k-x-20 / native                          |    7.2 |       20.7 |    21,035 |     780,645 |   2.1 |    0.3 |
| 1k-x-20 / fixed-row characterization      |    1.0 |       18.1 |       664 |     711,990 |   2.0 |    0.4 |
| 1k-x-20 / Zeus                            |   18.0 |       18.4 |       328 |   4,491,021 |   2.2 |    0.3 |
| 10k-x-50 / native                         |  211.1 |      408.1 |   510,065 | unavailable |  85.2 |    7.9 |
| 10k-x-50 / fixed-row characterization     |    3.5 |       19.8 |     1,594 |   1,446,945 | 104.1 |    6.2 |
| 10k-x-50 / Zeus                           |   81.2 |       19.6 |       328 | unavailable | 111.7 |    6.6 |
| wide-columns / native                     |    8.2 |       19.4 |    21,035 |     794,820 |  10.5 |    0.5 |
| wide-columns / fixed-row characterization |    1.0 |      125.1 |       664 |     705,339 |  12.0 |    0.4 |
| wide-columns / Zeus                       |   21.2 |       27.3 |       328 |  12,380,067 |  12.9 |    0.4 |
| narrow-panel / native                     |    7.5 |       21.5 |    21,035 |     788,400 |   2.0 |    0.4 |
| narrow-panel / fixed-row characterization |    1.0 |       17.8 |       664 |     706,299 |   2.1 |    0.3 |
| narrow-panel / Zeus                       |   12.0 |       18.9 |       139 |  15,455,211 |   2.0 |    0.2 |

v6 的 36 条 records 各含 20 个 raw scroll samples，共 720 个样本。checked report 中没有
`visibleRowIndex < 0` 或 `committed !== true` 的样本；每次 probe 前都实际跨过 presentation
opportunity，且全部样本在第一次 post-presentation probe 提交：

| renderer                   | raw samples | attempts | presentation opportunities | invalid visible row | uncommitted |
| -------------------------- | ----------: | -------: | -------------------------: | ------------------: | ----------: |
| native                     |         240 |        1 |                          1 |                   0 |           0 |
| fixed-row characterization |         240 |        1 |                          1 |                   0 |           0 |
| Zeus                       |         240 |        1 |                          1 |                   0 |           0 |

这说明三个 renderer 现在共享同一 completion floor，不再让 full-DOM native table 绕过 frame/presentation
成本。v6 的 ordinal `1..36` 连续且每条 tuple 与平衡计划一致。它还暴露了同一进程中 10k native
之后的 renderer 长尾，证明旧固定分组会掩盖 GC/JIT 状态差异；这类长尾保留在 raw records 和跨运行
p95 中，不会被从证据中删除。修复 measurement harness 不等于 Zeus 已通过：v6 没有放宽原阈值，
10k 收益仍不足。

The heap field is `unavailable` when Chromium does not expose a non-zero
`performance.memory` delta; zero is not treated as a memory win. The checked-in report is a legacy
browser characterization only; its JSON/format timings do not invoke Tauri or a database.

### 2026-08-18 真实 WorkbenchTable Chromium baseline smoke

真实模式通过 `Object.getPrototypeOf(table) === WorkbenchTable.prototype` 与 `.monaco-table`、
`.monaco-table-th`、`.monaco-table-td`、`.monaco-list-row[data-row-index]` 共同证明组件身份。record 中
写入 `id: vs.platform.list.browser.WorkbenchTable`、
`runtimeProof: exact-prototype-and-monaco-dom-v1`、`exactPrototype/domVerified: true`，以及按
`JavaScript + NUL + CSS` 计算的 bundle SHA-256
`f58986b454aeecbe8500c0357f76839140f26f22149294f14a5e8435a4128a35`。

Workbench-only 的 1k×20、10k×50、wide-columns、narrow-panel 单次 Chromium smoke 均为 `ok`：每组
`renderedRows=14`，10k×50 为 913 个 DOM nodes，其余为 403；每组 20/20 scroll samples 都在一次
presentation opportunity 后提交，最大 row delta 为 1。document client/scroll geometry 完全一致，
`outerDocumentOverflowFree`、`runMarkerAnchored`、`virtualRowsBounded` 与
`firstCellInViewport` 均为 true。单独的 synthetic visual smoke 还生成了 52,648-byte PNG，并通过
viewport、像素多样性、header/cell sentinel 与 renderer identity 检查。

在 smoke 通过后，又用 exact-pinned Zeus bundle 运行完整 `4 workloads × 3 renderers × 3 repeats = 36`
条 real-mode balanced records，全部为 `ok`。gate 对该 `/tmp` report 重算后，8 个 Chromium benchmark
checks 中只有 dirty/missing workflow provenance 失败；real implementation、36 条唯一 records 与 summary
integrity 均通过。1k×20 WorkbenchTable/Zeus scroll p95 中位为 `18.5/19.5ms`，Zeus 回归 `5.4%`，通过
10% 门；10k×50 为 `18.1/23.3ms`，Zeus 改善 `-28.7%`，低于 +20% 门。10k render median 也为
WorkbenchTable `29.6ms`、Zeus `157.0ms`，Zeus 有一次 `1,976.3ms` long tail。

这些 real-mode 结果仍记录 `sourceTreeClean: false`，没有双 WebView、protected workflow provenance
或可供 gate 复算的 fresh structured audit。因此它们不能替换 checked-in benchmark 或成为 admission
evidence；但性能阻塞已经由真实组件对比独立复现，Z1.3 继续 `NO-GO`。

## Gate 状态

Z1.3 gate verifier [`scripts/verify-sql-result-grid-gate.mjs`](../../scripts/verify-sql-result-grid-gate.mjs)
固化了三个预注册阈值：1k×20 关键交互回归不超过 10%、10k×50 相对最佳非 Zeus
baseline 的主指标改善至少 20%、fresh bundle 的 gzip 增量不超过 30,000 bytes。平台要求是
macOS WKWebView 与 Windows WebView2 各精确运行 5 次，不是普通浏览器等价物。

checked-in 历史 [`phase-z1-gate.json`](./phase-z1-gate.json) 为 gate report schema version 2、
`NO-GO`，门禁返回
exit 1。结论至少有以下三类彼此独立的阻塞：

- **正式 real baseline 缺失，且本地真实性能明确失败。** checked-in Chromium report 没有 real-mode identity、runtime
  proof、Workbench bundle digest 和新 visual geometry，因此 gate 先拒绝 raw records，1k/10k metric
  checks 记为 missing。若只作历史诊断，legacy fixed-row 数据的 1k×20 回归为 `1.7%`，10k×50 改善仅
  `1.0%`。新的 dirty-tree real-mode report 通过 Chromium identity/record/summary checks，但 1k 回归
  `5.4%`、10k 改善 `-28.7%`；后者仍明确低于 `20%`。两者都不能冒充 protected admission evidence。
- **revision-bound 双平台原生证据缺失。** 当前没有同一 repository/ref/revision/workflow
  run 下、符合 platform evidence schema v2 且采用 measurement contract v6/order 的 macOS embedded
  WKWebView 与 Windows embedded WebView2 evidence；两边
  均没有可验证的 60 条 raw records、12 个实际 PNG 文件及 native binary provenance。
- **当前 revision 的结构化 Zeus audit 缺失。** gate 没有可读取并复算的 package/closure/
  bundle artifact，无法证明当前运行使用的 bundle、gzip bytes 和 SHA-256；历史 `24,260`
  bytes 不会被当作本次通过值。

此外，checked-in Chromium benchmark 本身记录 `sourceTreeClean: false`，并缺少当前 platform
evidence schema v2 / measurement contract v6 证据链要求的 workflow provenance。
因此即使之后只补齐双原生 WebView，也仍需在 clean protected revision 上重新生成真实三 renderer
baseline，并满足未改变的 20% 门槛。Chromium-only 结果、旧 summary 或最小化伪造的 `GO` JSON 都
不能绕过校验。

本地诊断不得覆盖 revision-pinned gate 快照。后续复跑请始终显式传入临时输出路径，例如
`node scripts/verify-sql-result-grid-gate.mjs docs/sql-mvp-phases/phase-z1-benchmark.json /tmp/z1-gate.json`。

### 2026-08-18 macOS native readiness characterization

本地 webdriver-enabled debug binary 的 SHA-256 为
`c861019520ec02153067ec4ab90af9f51bdf2483f61ab362410e93ecea1160b4`，运行器识别为 embedded
`wkwebview-embedded` / `webkit` / `macos`，并绑定上述 Zeus bundle SHA-256。首次 1k×20 三 renderer
smoke 的页面内容、viewport 尺寸和 pixel diversity 均有效，但三张 PNG 的 marker 校验同时失败。
像素诊断证明 marker 自身的 20-byte codeword、CRC 和各自 run token 均正确；它们统一从预期
`y=802` 上移到 `y=772`，差值 30 physical px / 15 CSS px。根因是占满 `100vh` 的 root 后面仍有
参与布局的长 JSON `<pre>`，WKWebView 生成非 overlay 外层水平 scrollbar，fixed-position containing
block 高度因此从记录的 420 CSS px 降到 405 CSS px。

benchmark 页面现在强制 `html/body` 无外层滚动并隐藏只供 automation 读取的 result 节点。visual probe
同时记录 `documentElement` client/scroll geometry 与 marker DOM bounds，producer 要求无外层 overflow
且 marker 锚在 `(left=4, bottom=1)`；Safari error formatting 还会在 stack 不含 message 时显式保留
message。修复后的 1k×20 三 renderer smoke 为 3/3 `ok`、三张 screenshot 均通过：document
client/scroll 都是 `1440×420`，marker bounds 都是 `(4,401)-(130,419)`。

四 workload × 三 renderer × 单次的后续 characterization 为 11/12。Zeus 在 10k、wide-columns 与
narrow-panel 均成功；唯一失败是 `10k-x-50/native`，其 510,000+ DOM full table 在 5 秒内没有获得
post-presentation opportunity。独立 fresh-process 复跑稳定得到同一错误
`Timed out waiting for a presentation opportunity`。按 v6 “timeout 只能失败”的合同，没有放宽该预算，
也没有删除失败 record。由于 macOS 未形成 60 条成功 records/12 PNG，Windows 尚未运行，所有本地产物
又都缺 protected workflow provenance，这轮只能作为 fail-closed characterization，不能替代 Z1.3 gate
evidence 或启动 Z2。

### Z1.3 presentation-floor feasibility profile

为了区分 renderer 工作量与 v6 共同 completion boundary，本轮新增默认关闭的非门禁 profiler。
checked-in `phase-z1-feasibility-profile.json` 现在使用 real WorkbenchTable，只跑 `10k-x-50` 的
WorkbenchTable/Zeus，各 6 次并
继续使用 `renderer-balanced-rotation-v1`。每条 record 在完成原有 20 个真实位移样本后，再记录
20 个无 renderer 工作的 `requestAnimationFrame -> post-frame task` floor 样本；profile 从 raw
samples 重算 median/p95/max，拒绝旧合同、错误 execution plan/ordinal、缺失样本、非有限值和被篡改
的汇总。默认 `benchmark:sql-result-grid` 不启用该模式，Z1 gate 也不消费 profile 结果，因此没有改变
measurement contract v6、预注册阈值或正式 evidence schema。

Zeus benchmark adapter 复用已经格式化的二维 row arrays，以 column ordinal string 作为 field，并移除
`componentOnReady()` 后重复的 `refreshViewport()`；row overscan 仍保持 4。profile 把这些选择记录为
`rowShape: array-index`、`explicitRefreshViewport: false` 和 `overscan: 4`。该优化把此前 real-mode
36-record run 中 Zeus 10k render median 的 `157.0ms` 降到本次 6-repeat profile 的 `21.6ms`，证明
adapter 端重复映射已消除，但没有修改显示数据、虚拟化配置或测量边界。

固化前使用同一个 exact-pinned Zeus bundle、real WorkbenchTable 和 6 次平衡重复逐项改变一个变量。
下表均为 dirty-tree Chromium 诊断，`scroll p95` 是 6 次 per-run p95 的中位数；每组 12/12 records
为 `ok`，所有 scroll sample 首次提交，header、首格、bounded rows 与 document geometry checks 均通过：

| Zeus adapter variant                              | Workbench scroll p95 | Zeus render | Zeus scroll p95 | DOM nodes |
| ------------------------------------------------- | -------------------: | ----------: | --------------: | --------: |
| records + refresh + overscan 4（control）         |                 17.8 |        55.5 |            18.6 |       330 |
| records + no refresh + overscan 4（A）            |                 17.5 |        50.4 |            18.2 |       330 |
| records + no refresh + overscan 4（A repeat）     |                 17.3 |        50.7 |            17.8 |       330 |
| records + no refresh + overscan 0                 |                 17.3 |        60.5 |            18.8 |       270 |
| array-index + no refresh + overscan 4（B）        |                 17.9 |        20.3 |            18.7 |       330 |
| array-index + no refresh + overscan 4（B repeat） |                 17.7 |        20.3 |            18.5 |       330 |

删除显式 refresh 在两次复跑中把 Zeus render 降低约 `8.6%-9.2%`；二维数组直传再降低约 `59.7%-60.0%`。
overscan 0 虽少 60 个 DOM nodes，却同时恶化 render 与 scroll，因此被拒绝。实验 CLI/分支随后全部删除，
正式 harness 只保留 `array-index + no refresh + overscan 4`，避免非准入配置进入 admission report。

本机结构化记录见
[`phase-z1-feasibility-profile.json`](./phase-z1-feasibility-profile.json)：12/12 records 为 `ok`，
240 个 scroll samples 和 240 个 floor samples 完整，scroll samples 均首次提交且 ordinal 为 `1..12`。
WorkbenchTable scroll p95 中位为 `17.7ms`，Zeus 为 `18.1ms`，实际改善为 `-2.3%`；20% 门槛要求
Zeus 不高于 `14.16ms`，而共享 presentation floor p95 为 `17.5ms`。即使把 Zeus renderer 工作假设
为零，观测 floor 约束下的最大改善也只有 `1.1%`。profile 因此给出
`PRESENTATION_FLOOR_LIMITED`，并保留全部 raw samples，没有删样或修改 baseline。

该 profile 带 real WorkbenchTable exact prototype/DOM proof 和两份 bundle digest，但仍明确记录
`sourceTreeClean: false`，且没有 protected workflow 或双 WebView provenance，所以只是 Chromium-only
诊断 artifact，不是 Z1 Go 证据。任何改用 sub-frame CPU/handler 指标或修改 20% 门槛的方案都必须由
产品负责人显式重新预注册；在此之前保留 Z1.3 `NO-GO`，不启动 Z2。

### 2026-08-20 beta.3 候选复验

Zeus core `0.1.1-beta.1` 的 release workflow
[`32260211154`](https://github.com/baicie/zeus/actions/runs/32260211154) 在 tag
`v0.1.1-beta.1`、SHA `6deffa28d6f58bd4039765c73504f00a825249e9` 上 11/11 jobs 通过；25 个
core packages 的 beta dist-tag、integrity 与 SLSA provenance 均已核验。zeus-ui
[`PR #35`](https://github.com/baicie/zeus-ui/pull/35) 合并 SHA
`ad5ac10030b9e12a33fd161610c48b06881bbe49`，PR head 与合并后 main CI 各 10/10 jobs 通过；tag
`v0.1.0-beta.3` 指向同一 SHA。官方 npm registry 独立扫描确认 36/36 publishable packages 均存在
`0.1.0-beta.3`，`beta` dist-tag 指向 beta.3；Data Grid 与 Virtual 对 Zeus runtime/wrapper 和 peer
Zeus 均使用 exact `0.1.1-beta.1`，没有 `^`/`~` 漂移。

发布身份仍有一个必须保留的缺口：zeus-ui
[`Publish to NPM` run 32323597967](https://github.com/baicie/zeus-ui/actions/runs/32323597967)
最终结论为 `failure`。36 包发布、registry metadata/provenance、fresh install 与 TS/Vite build 已成功；
最后的 consumer runtime smoke 仍断言 zeus-compat 导出 `state`/`effect`，实际 beta.3 导出为
`createSignal`/`createEffect`。因此“36 包已发布且 beta tag 正确”成立，但“发布后验证全绿”不成立。
`latest` 仍指向 beta.0，且 tag 没有对应 GitHub Release 对象。Data Grid 不依赖旧 compat 别名，但维护者
仍应修复 smoke 并补一次成功的 release workflow evidence。

使用与 Z1 audit 相同的 esbuild `0.28.1` 参数及 Node zlib level 9，对 exact-pinned 发布包重新打包：

| 版本                     | raw bytes | gzip -9 bytes | SHA-256                                                            |
| ------------------------ | --------: | ------------: | ------------------------------------------------------------------ |
| Data Grid `0.1.0-beta.2` |    73,494 |        24,311 | `0dddde8f65195667d1bdd0f574f2ac3a4ffa1c5b019c8f1a13db5bd2fc0a6794` |
| Data Grid `0.1.0-beta.3` |    91,000 |        29,647 | `a3cda8cbbedd0107a5afdc7cff712858ad5869a1fadc69848b4840469a2baca6` |

beta.3 仍低于 `30,000` gzip 门，但只余 353 bytes，且 gzip 相对 beta.2 增长约 `21.9%`。该本地 bundle
复核没有 protected workflow provenance，不能替代 Z1.1 fresh structured audit。

同一 macOS host 上分别对 beta.2/beta.3 各运行两轮 `10k-x-50`、每轮 6 次 balanced real
WorkbenchTable/Zeus profile。合并后每版有 12/12 Zeus records、240/240 scroll samples 与 240/240
presentation-floor samples；所有 scroll sample 都在第一次 opportunity 正确提交：

| Zeus 指标                           | beta.2 |  beta.3 |
| ----------------------------------- | -----: | ------: |
| render upper median                 | 17.1ms |  14.9ms |
| render cross-run p95（n=12 sizing） | 43.0ms |  27.4ms |
| scroll p95 upper median             | 18.7ms |  19.2ms |
| scroll max cross-run p95            | 46.3ms | 241.0ms |
| input p95 upper median              |  0.1ms |   0.1ms |
| presentation floor p95 upper median | 17.6ms |  17.7ms |
| DOM nodes upper median              |    330 |     330 |

beta.3 render upper median 相对 beta.2 改善约 `12.9%`，但 scroll 中位没有改善并出现 `241ms` 长尾。
每版另跑的 36 条全 workload real-mode records 均为 `ok`；其中 beta.3 10k×50 WorkbenchTable/Zeus
scroll p95 中位为 `18.0/20.2ms`，Zeus 相对 baseline 回归约 `12.2%`，仍未通过旧 `+20%` 门。该轮
beta.3 的 10k Zeus render median 为 `14.0ms`，但还出现 per-run scroll p95 `139.8ms` 与 scroll max
`850ms`。这些顺序执行的 dirty-tree Chromium measurements 只证明首屏改善方向，不证明 steady scroll
long tail 已关闭，也不构成准入证据。

发布源码与 sourcemap 审计显示 beta.3 已包含 A 单次建模、B shallow props、D keyed `For` 修复、F
viewport/snapshot cache 和 E 固定行高 DOM pooling；C static binding 与 P0 diagnostics 只部分完成，
scheduler 未改。剩余优先项是 zeus-ui Data Grid 的 O(N) rows wrapper/duplicate-key `Set` 与导航
`findIndex`，以及 Zeus core/Data Grid 之间的强类型 diagnostics、真实 input timestamp、effect/proxy/
allocation counters 和受证据约束的 `@once` 扩面。完整逐项审计与新指标建议见
[`Zeus Data Grid 性能整改与重新验收报告`](../reviews/2026-08-18-zeus-data-grid-performance-remediation.md)。

综上，beta.3 不改变 `Z1.3 = NO-GO`：旧 v6 指标仍失败，beta.3 bundle 余量过小，publish workflow
尚未全绿，且当前 revision 的 macOS WKWebView、Windows WebView2、fresh structured audit 与 protected
attestation 均缺失。`phase-z1-gate.json` 与 beta.2 checked-in profile 保持不变，Z2 继续禁止开始。

### 2026-08-24 beta.4 revision-bound 复验

上游既定整改与发布已经完成：Zeus core `0.1.1-beta.2` tag/SHA 为
`v0.1.1-beta.2` / `a099abbf03acaf1ad2a78963e5ead72da2758a18`，
[`release run 32468671269`](https://github.com/baicie/zeus/actions/runs/32468671269) 全绿。auth gate
明确输出 `baicie2, 25 packages with read-write access`，25 包的 beta dist-tag 与 signed provenance
通过；`beta=0.1.1-beta.2`、`latest=0.1.0`。npm token 没有失效，早先 attestation endpoint 的临时
`404` 不是账号或 token 错误。

zeus-ui `0.1.0-beta.4` tag/SHA 为
`v0.1.0-beta.4` / `548baa14e88daa9cd3e90b2f60ea4c6043a79bf2`；
[`release run 32480800326`](https://github.com/baicie/zeus-ui/actions/runs/32480800326) 与
[`publish run 32481311654`](https://github.com/baicie/zeus-ui/actions/runs/32481311654) 全绿，36 个包的
published-package 验证通过。`beta=0.1.0-beta.4`、`latest=0.1.0-beta.0`，Data Grid 对 core runtime、
wrappers 与 peer Zeus exact pin `0.1.1-beta.2`。两个版本都由 GitHub Actions 发布，没有本机
pack/publish，也没有修改 `latest`。

beta.4 包含 zeus-ui [PR #37](https://github.com/baicie/zeus-ui/pull/37) 的 indexed row model、
O(1) row-key/column-id lookup、真实 input timestamp 与 wrapper allocation diagnostics；100k update
benchmark 为 0 eager wrappers / 16 viewport wrappers。core
[PR #88](https://github.com/baicie/zeus/pull/88) 增加 opt-in effect/proxy/scope/ref/memo/allocation
create/dispose counters，inactive instances 保持 prototype fast path，scheduler 未改。两 PR 的 required
CI 全绿；GitHub reviews 为空，独立只读审查没有 P0/P1。beta.4 发布的 WC、JSX、React 与 Vue `.d.ts`
均完整保留 `DataGridDiagnostics`，包括 `rowIndexEntryCount`、`eagerRowWrapperAllocationCount`、
`inputTime` 与 `rowWrapperAllocationCount`。

完成审计在同一 host 对已发布 beta.1/beta.2 做三次 ABBA inactive-path 差分微基准；每 case 30 paired
rounds。最差稳定 paired median 是 scope create/stop `+2.94%`，memo 最多 `+0.60%`，effect/proxy/ref
没有中位回归。该结果与 inactive instance 不创建 own `run/stop` wrapper 的发布测试共同支持低默认开销；
p95 仍受 GC 噪声影响，因此只作诊断，不登记为 CI regression threshold。

Nyala [native run 32706467306](https://github.com/baicie/nyala-studio/actions/runs/32706467306)
绑定 clean SHA `9d68c91d22ae09d2da57c2748250411c815f6e67`。prepare、macOS 与 Windows jobs 均成功；
aggregate 的 evidence download/merge/upload 也成功，只在 fail-closed Z1 verifier 按预期 exit 1：

| 证据              | 结果                                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh Zeus audit  | `@zeus-web/data-grid@0.1.0-beta.4` package/provenance 全过；90,528 raw / 29,841 gzip / SHA-256 `2f7630473db32c03e934d0167736e9ec107fbc55bd401797c208a51d3f22f636`；30 KB 余量 159 bytes |
| Chromium          | 36/36 real WorkbenchTable/Zeus records；schema、contract、summary 与 provenance 8/8 通过                                                                                                |
| macOS WKWebView   | embedded identity；60/60 records、12/12 screenshots；platform evidence 7/7 通过                                                                                                         |
| Windows WebView2  | embedded identity；60/60 records、12/12 screenshots；platform evidence 7/7 通过                                                                                                         |
| Cross-environment | 156 个 run tokens 全局唯一；Zeus/Workbench bundle digests 与 revision/run provenance 一致                                                                                               |

embedded eval 启动表达式已改为合法逗号表达式；viewport 流程按 apply -> settle -> observe 校准，
visual contract 比较实际 browser viewport 与 document geometry。Windows narrow-panel 的 15/15 records
均请求 `390x420`、实际合法收敛到 `391x420`；browser/document client/scroll geometry 均为
`391x420`，无外层 overflow。这关闭了旧的互相冲突 viewport evidence 契约。

最终 gate 共 50 项通过、5 项失败，dependency audit 通过。失败全部是未修改的性能阈值：

| 环境 / workload             | WorkbenchTable |   Zeus | 结论                  |
| --------------------------- | -------------: | -----: | --------------------- |
| Chromium 1k x 20 scroll p95 |         17.2ms | 20.5ms | 回归 19.2%，超过 10%  |
| macOS 1k x 20 scroll p95    |         18.0ms | 21.0ms | 回归 16.7%，超过 10%  |
| macOS 10k x 50 scroll p95   |         19.0ms | 22.0ms | 改善 -15.8%，低于 20% |
| Windows 1k x 20 scroll p95  |         16.5ms | 20.9ms | 回归 26.7%，超过 10%  |
| Windows 10k x 50 scroll p95 |         26.0ms | 22.0ms | 改善 15.4%，低于 20%  |

Chromium 10k baseline 本轮有 `107.2ms` 长尾，Zeus `20.6ms`，改善 80.8% 并通过该单项；不能用这个
偶发 baseline 覆盖其余 5 个失败。完整实施与后续指标建议见
[`Zeus Data Grid 性能整改与重新验收报告`](../reviews/2026-08-18-zeus-data-grid-performance-remediation.md)。
因此既定整改、beta 发布、native CI 修复和证据生成闭环已经完成，但 Z1 admission 保持 `NO-GO`；
不触发 protected Go attestation，Z2 与 R0 继续禁止开始。

### 2026-08-24 beta.4 内部 commit 诊断关联

benchmark 的 diagnostic-only 路径现直接接入 beta.4 `grid.diagnostics`，在 Data Grid 连接 DOM 前注册
`onModelBuild/onCommit`，以 callback cursor 将每个外层 scroll sample 关联到内部 transaction。sidecar
validator 要求 20 个正式 sample 全部关联、严格 transaction 顺序、所有 raw scroll commit 恰好认领一次、
外部 sample 连续编号、primary range 覆盖 visible/expected row，且 timing/layout/count 字段可重算；
v6 raw sample、summary、阈值、gate verifier 和 admission command 均保持不变。`onCommit` 会启用
`MutationObserver`，所以该路径只作非对称内部诊断，不进入 v6 admission。

exact beta.4 bundle 的 6-repeat、10k x 50、real WorkbenchTable/Zeus balanced profile 产生 12/12 `ok`
records 与 120/120 Zeus sample correlations。source revision 为
`882ba2225630bc2cfb0f007669ed4da73d41bf10` 且 `sourceTreeClean=false`；bundle SHA-256 与正式 audit
一致，为 `2f7630473db32c03e934d0167736e9ec107fbc55bd401797c208a51d3f22f636`。关键结果：

| 指标                                           | 结果                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| WorkbenchTable / Zeus render median            | `15.2 / 9.7ms`                                                                    |
| WorkbenchTable / Zeus scroll p95 median        | `18.5 / 19.1ms`                                                                   |
| shared floor / v6 required Zeus p95            | `18.6 / 14.8ms`，`PRESENTATION_FLOOR_LIMITED`（源 report 已删除，见下节复算口径） |
| model builds                                   | 每 record 1 次；10k indexes；0 eager wrappers；scroll 无 rebuild                  |
| range / layout p95                             | `0.1 / 0.1ms`                                                                     |
| instrumented commit interval median / p95      | `1.3 / 2.1ms`，只作 upper bound                                                   |
| handler start -> instrumented end median / p95 | `1.4 / 2.2ms`，只作 upper bound                                                   |
| lazy row wrappers median / p95                 | `23 / 24` per scroll                                                              |
| fixed-height pool churn                        | 84/120 为 0；其余为 30 或 120 个 created/removed Node tree entries                |

结构数据未见 scroll-time model rebuild，已观测的 range/layout 区间也很小，因此当前没有证据优先修改
`SizeCache` 或 Zeus core scheduler；但诊断尚未把生产 commit 成本与自身开销分离。beta.4 在写入
`commitEndTime` 前执行 `MutationObserver.takeRecords()` 和 Node tree 递归计数，所以
`1.3/2.1/2.2ms` 是 instrumented upper bound，node churn 与 duration 的相关性也部分由测量过程机械
产生。下一上游实验应先在 zeus-ui 把 renderer commit end 与 diagnostics-end 分开，或做
churn-disabled/enabled A/B；只有分离后的 timing 仍指向 pool/wrapper，才实验 fixed-capacity pool 与
bounded/ring wrapper reuse。
zeus-ui 工作树已落地该分离，但未发版；Nyala 继续把 `1.3/2.1/2.2ms` 当作 instrumented upper bound。
同一工作树现可把 `measureNodeChurn` 设为 false 做诊断 A/B，默认仍计量 churn。
v7 指标预注册见 [ADR 0004](../adr/0004-zeus-data-grid-v7-floor-aware-metrics.md)（`Proposed`）。

2026-09-17 本地 10k x 50、5-repeat、同一未发布 bundle 的 churn A/B（Chrome/CDP、diagnostic profile）
结果：traversal 差在 enabled 侧只有 `0.02ms` mean / `0.1ms` p95，disabled 侧为 0；两侧 scroll p95 分布
重叠（`18.1-18.3ms` 对 `18.2-18.8ms`）；commit boundary 差约 `0.2ms` mean / `0.8ms` p99
（定义：按 execution ordinal 与 sample 顺序配对的逐样本 commit-boundary 差，n = 100），落在双臂
噪声内；DOM churn 仅 enabled 臂为 1,650 created nodes / 100 scroll commits（disabled 臂按构造为 0），
wrapper 分配（两侧均 21.3 个/commit）不变。该 A/B 不指向诊断 observer 成本，只把 pool/wrapper 保留为
待验证候选；它是本地诊断，不是
revision-bound 证据，也不改变 `Z1.3 = NO-GO`。两臂原始 report
（`/tmp/nyala-zeus-ab/ab-enabled-r5.json` / `ab-disabled-r5.json`）在事后用当前 validator 重校验，
enabled/disabled 各 5/5 records、20/20 correlations 全部通过。

该诊断不能量化可获得的生产收益；独立于此，v6 的 20% ratio 在所有现存 evidence 上都落在地板之下，
仍不可辨识（分解见下节）。因此还必须由产品负责人预注册 v7 continuous-scroll jank、对称 renderer
CPU 与 one-frame correctness gate。完整 raw 指标、runtime diagnostics 异步边界和 A/B 约束见整改报告；
本轮不改变 `Z1.3 = NO-GO`，也不准入 Z2/R0。

### 2026-09-17 未发布工作树（beta.5 候选）独立审计

split timing 与 churn A/B 的实现位于 zeus-ui `codex/release-0.1.0-beta.5` 分支 HEAD
`678d95bd04f5e30a613e62db5706cb5994f18c54`（`release: prepare 0.1.0-beta.5`，领先 `origin/main`
`2bfb8cd` 一个 commit），工作树含 4 个未提交文件（`200` 插入 / `7` 删除）：

| 文件                                                           | 变更                                                                                                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/advanced/data-grid/src/types.ts`                     | `DataGridCommitTiming` 新增 `diagnosticsEndTime`；`DataGridDiagnostics` 新增可选 `measureNodeChurn`                                                 |
| `packages/advanced/data-grid/src/components/data-grid.tsx`     | commit 创建时固化 `measureChurn`；`finalizeDiagnosticsCommit` 先写 `commitEndTime` 再遍历并写 `diagnosticsEndTime`；关闭 churn 时两者相等且计数为 0 |
| `e2e/advanced/data-grid/data-grid-diagnostics-runtime.spec.ts` | 4 个新用例：commit/diagnostics 分离、跳过 churn 遍历、关闭时 disconnect observer、切换后丢弃 in-flight sample                                       |
| `docs/internal/packages.md`                                    | 语义说明与「诊断开关不是生产模式」约束                                                                                                              |

**字节级归因。** 用当前工作树源码重新 `pnpm --filter @zeus-web/data-grid build`（exit 0），再按 A/B
使用的同一参数经 esbuild `0.28.1 --bundle --format=iife --platform=browser --minify
--legal-comments=none` 打包，得到 SHA-256
`3f66cf7e58e8e4ac523bfc4644f1a735fe0fe5f4db5a8469e365f69523ad2c58`（`90,370` bytes），与 churn A/B
使用的 `/tmp/nyala-zeus-ab/data-grid-bundle.js` 逐字节一致。因此上文 A/B 结果可归因到当前工作树字节，
而不是来源不明的构建产物。

**ADR 0004 diagnostic prerequisite 逐条对照。**

| ADR 前置条件                                     | 未发布工作树状态                                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 1 commit 边界先于 `takeRecords()` / Node 遍历    | `finalizeDiagnosticsCommit` 先写 `commitEndTime`，之后才 consume churn 并写 `diagnosticsEndTime`            |
| 2 遍历终点独立为 `diagnosticsEndTime`            | 新增字段；churn 关闭时恒等于 `commitEndTime`                                                                |
| 3 生产主指标不含 diagnostics 遍历                | Nyala 主指标与 v6 gate verifier 未改动；sidecar 仅把它作为 optional 字段透传                                |
| 4 旧 sidecar 上 optional，beta.4 sample 有效     | `scripts/sql-result-grid-zeus-diagnostics.mjs` 仅在 `Number.isFinite(...)` 时写入，beta.4 report 重校验通过 |
| 5 `measureNodeChurn: false` 可 A/B               | 不建 MutationObserver、不遍历 Node tree，`created/removed` 计数为 0                                         |
| 6 Nyala harness 为 WorkbenchTable 发出同定义区间 | 2026-09-18 落地：`ListView.prototype` wrapper 输出 handler/range/commit/layoutRead 区间，详见下文专节       |

**独立复验（2026-09-17，当前工作树）。**

| 命令                                                       | 退出码 | 结果                     |
| ---------------------------------------------------------- | -----: | ------------------------ |
| `pnpm --filter @zeus-web/data-grid test:unit`              |      0 | 16 files / 138 tests     |
| `pnpm --filter @zeus-web/data-grid test:e2e`               |      0 | 5 files / 104 tests      |
| `pnpm data-grid:bench`                                     |      0 | 3 files / 12 tests       |
| `pnpm --filter @zeus-web/data-grid check`（两个 tsconfig） |      0 | -                        |
| `tsx scripts/checks/release/check-release-readiness.ts`    |      0 | 36 publishable packages  |
| build → esbuild 重建 bundle SHA                            |      0 | 与 A/B bundle 逐字节一致 |

e2e 基线从既有记录的历史 `100/100` 增至 `104/104`（本工作树新增 4 个用例），历史数字不是回归。

**真实时钟抽检（临时脚本，已删除）。** 以 10k x 12、真实 `performance.now`（非 mock）的临时 jsdom
e2e 复核语义：churn 关闭臂每条 sample 均满足 `diagnosticsEndTime === commitEndTime` 且计数为 0；
churn 开启臂的遍历窗口 p50 约 `0.009-0.027ms`、p95 约 `2.05ms`，始终落在 commit 窗口之后。
该抽检只证明时序语义；jsdom 的 commit 窗口（`6.4-9.1ms`）与遍历尾部都比生产 Chromium 运行大得多，
因此这些数字既不能与上文 A/B 开启臂的 `diagnosticsTail`（p95 `0.1ms`、max `0.2ms`）比较量级，
也不是生产数据。

**发布流程事实。** `release.yml` 要求 `GITHUB_REF = refs/heads/main`，该分支无法直接 dispatch；
`0.1.0-beta.5` 只写在 37 个 `package.json`（root + 36 publishable）与文档中，没有 `v0.1.0-beta.5` tag、
没有 PR（误建的 PR #41 已关闭），npm 上 `beta=0.1.0-beta.4`、`latest=0.1.0-beta.0` 未变。

非阻塞观察（供发布评审）：`diagnosticsEndTime` 在未发布源码里是 `DataGridCommitTiming` 的必填字段，
发布后会收紧该公开类型的构造面（Nyala sidecar 只按 optional 消费，beta.4 样本不受影响）；
`measureNodeChurn` 目前只有文档注释，没有编译期约束阻止生产 bench 依赖它；`mergeDiagnosticsCommits`
合并 in-flight commit 时沿用先创建者的 `measureChurn`，而切换 `diagnostics` 对象会整体丢弃 pending，
因此未见可复现错误，但语义靠「丢弃」而不是「合并规则」保证。

本审计不 commit、不发布、不改 `phase-z1-gate.json`；`Z1.3` 仍为 `NO-GO`，ADR 0004 仍为 `Proposed`，
上述内容不是 admission evidence。

### v6 20% 门的地板受限分解（2026-09-17）

[`scripts/sql-result-grid-floor-headroom.mjs`](../../scripts/sql-result-grid-floor-headroom.mjs) 把已通过
validator 的 report 拆成 record floor、shared floor 与 renderer interval union（区间先取并集再求和，
不 naive 相加），CLI
[`scripts/analyze-sql-result-grid-floor-headroom.mjs`](../../scripts/analyze-sql-result-grid-floor-headroom.mjs)
可对任意 report 复算：

```bash
node scripts/analyze-sql-result-grid-floor-headroom.mjs \
  --report <report.json> [--report <report.json>] [--output <headroom.json>]
```

v6 的 required 目标恒为 `0.8 × baseline`，而任何 renderer 的 p95 都不低于同一 post-presentation
floor，因此 `zeus <= 0.8 × baseline` 隐含要求 `baseline >= 1.25 × floor`。现存七组 evidence 的
`baseline / floor` 落在 `0.989–1.237`，没有一组达到 `1.25`：

| evidence set                                         | baseline p95 | shared floor p95 | required Zeus p95 | floor − required | baseline / floor | 最优 floor 下最大可行改善        |
| ---------------------------------------------------- | -----------: | ---------------: | ----------------: | ---------------: | ---------------: | -------------------------------- |
| `phase-z1-feasibility-profile.json`（HEAD 63698263） |      20.10ms |          18.50ms |           16.08ms |          +2.42ms |            1.086 | 13.43%（单 record 最优 17.40ms） |
| `phase-z1-feasibility-profile.json`（当前工作树）    |      17.70ms |          17.50ms |           14.16ms |          +3.34ms |            1.011 | 3.39%（单 record 最优 17.10ms）  |
| churn A/B r3 enabled（`882ba222`，本地诊断）         |      20.90ms |          16.90ms |           16.72ms |          +0.18ms |            1.237 | 19.62%（单 record 最优 16.80ms） |
| churn A/B r3 disabled（本地诊断）                    |      20.80ms |          17.40ms |           16.64ms |          +0.76ms |            1.195 | 17.31%（单 record 最优 17.20ms） |
| churn A/B r5 enabled（本地诊断）                     |      20.50ms |          16.80ms |           16.40ms |          +0.40ms |            1.220 | 18.54%（单 record 最优 16.70ms） |
| churn A/B r5 disabled（本地诊断）                    |      20.50ms |          16.90ms |           16.40ms |          +0.50ms |            1.213 | 18.05%（单 record 最优 16.80ms） |
| real WorkbenchTable r5（本地诊断，2026-09-18）       |      17.60ms |          17.80ms |           14.08ms |          +3.72ms |            0.989 | 2.84%（单 record 最优 17.10ms）  |

- 即使把 renderer 成本假设为 0，最优的一组（r3 enabled）也只能到 `19.62%`，仍低于 `20%` 门
  `0.38` 个百分点；r5 两臂为 `18.54% / 18.05%`。
- 新增一组是首次出现 `baseline / floor < 1`：`--workbench-table-implementation real` 的基线
  `17.60/17.70ms` 本身就在地板上（`17.80/17.50ms`），`required = 14.08–14.16ms` 比地板低
  `2.8–3.7ms`。v6 的入库 Chromium 证据用的是 `19.80–20.10ms` 的 fixed-row characterization
  baseline，比 Z2 真正要发布的 renderer 慢。
- 聚合方式决定符号：冻结的 `phase-z1-benchmark.json`（3 run × 20 sample）按 v6 口径
  （median of per-run p95）为 WorkbenchTable `19.80ms` / Zeus `19.60ms`（`0.990`，Zeus 名义领先）；
  同一 60 条 sample 池化后为 `20.10ms` / `37.90ms`（`1.886`）。差异由单次 `142.4ms` Zeus run 的
  尾部驱动，record 本身两种读法完全相同。
- 所有已记录 Chromium sample 都在第一个 post-input presentation opportunity 内呈现正确内容：
  legacy v6 `720/720`、worktree profile `240/240`、real WorkbenchTable r5 `200/200`、A/B 两臂
  `400/400`。`10%/20%` 阈值在 `~18ms` 基线上只有 `1.8–4.0ms`（约 `0.1–0.25` 个 60Hz frame），
  该 harness 里唯一大的 renderer-owned 差异在同步 input 路径：input p95 `4.40–7.30ms`
  （real WorkbenchTable）对 `0.10–0.20ms`（Zeus），settle p95 `13.90–14.10ms` 对
  `19.10–20.40ms`；两者 total 都被 floor 主导。
- 原生证据方向一致但无法分解：macOS 10k×50 为 `19.0 / 22.0ms`（`-15.8%`）、Windows 为
  `26.0 / 22.0ms`（`+15.4%`），都低于 `20%` 门；native records 不带 floor 诊断，因为该探针只在
  Chromium `--diagnostic-profile` 下运行。
- floor 是运行相关量：Zeus 侧 28 条 10k record 的 floor p95 跨度为 `16.7–18.6ms`（约一个 60Hz
  frame）；全部 66 条 record（含 4 条 >18.6ms 的 workbench-table 离群值，其中 3 条 >20ms）为
  `16.7–31.7ms`。shared floor
  取 per-report 中位数，不被离群值驱动。跨运行漂移的是数值，不漂移的是符号——每组 evidence 的
  `required` 都低于同组 floor。
- Zeus renderer 区间 union 的 p50/p95 为 `1.60/2.50ms`（enabled）与 `1.30/2.20ms`（disabled），
  `commitPatch` p95 为 `2.50 / 2.10ms`，与上文 instrumented upper bound 一致；滚动延迟约 92%
  来自 frame wait（`presentationWait` p95 `18.20 / 18.50ms`）。
- 上表 `18.6 / 14.8ms` 中，`18.6` 是当轮 attribution report 的 Zeus 侧 floor，`14.8ms` 是那轮
  baseline（18.5ms）的 80%；该 report（bundle 摘要 `2f763047`）已删除，无法在现存 artifact 上复算。
  本节给出的是可复算的替代口径：`required = 0.8 × baseline` 恒等式加七组 `baseline / floor`。
- 这七组全部是本地诊断（Chromium/CDP，部分为非 revision-bound），不是 admission evidence，
  也不写入 `phase-z1-gate.json`；v6 gate verifier 本身不计算 floor，floor 只存在于
  `--diagnostic-profile` 运行，因此 v7 若要引用 floor，必须在同一 evidence set 内配对采样。

原始报告摘要（2026-09-18 复算，CLI exit 0，前六行数值逐字复现）：入库 profile 以 git blob
`f1d4dade10eb537ec0e3c31c703a49160af6eaf0`（`HEAD:docs/sql-mvp-phases/phase-z1-feasibility-profile.json`）
标识；工作树重生成版 sha256
`c4ab123db9b1aaea59353b49f90436a7e0a911522f7b0b0be3f247e437587949`；churn A/B r3
`ab-enabled.json` / `ab-disabled.json` sha256
`a76482cfa734db0a7f51b05ac5f82a5bf46db0cd0f91efc14e556b1d3592a922` /
`f11b8735a11d4bf5d66f2b59fd26e1672c5638f8f1ef1ff335d96804461ac09d`；r5 两臂 sha256
`07590708c95fd2c94896022cac44fa0e3acec2f6a94f1b5e2307a98539e4fb75` /
`ced53e663f2fe8d1769ad231bcb0270cc27f6e3d22a8558fbe661a3e98d071aa`。四份 A/B 报告位于
`/tmp/nyala-zeus-ab/`（非持久：复核前先自行备份）；即使这四份丢失，仅凭入库 profile 一行也可得出
`13.43% < 20%` 的结论。复算命令见
[ADR 0004](../adr/0004-zeus-data-grid-v7-floor-aware-metrics.md)。
第七行来自 2026-09-18 新跑的 `real WorkbenchTable r5` 报告（revision `882ba222`、
`sourceTreeClean=false`、real-WorkbenchTable bundle
`f58986b454aeecbe8500c0357f76839140f26f22149294f14a5e8435a4128a35`），位于
`/tmp/nyala-real-wbt-r5.json`（同样非持久，sha256
`f4e08b7d8968e71c67632c6e3e8503547c28df68cb99a7f8038b9db74e5894be`），可由 ADR 0004
“Identifiability check”一节记录的命令重生成。

本地诊断实现复验：

| 检查                                                                     | 结果                                                                                                                       |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run test:sql-result-grid-benchmark`                                | exit 0，63/63 tests 通过（2026-09-18 增补 WBT 区间契约与 workload CPU ratio 用例后复测）                                   |
| floor headroom 分解（4 条新测试）                                        | floor 与 renderer work 分离、嵌套区间取并集、缺失诊断拒绝、无 Zeus 诊断仍保留 floor 数学                                   |
| workload CPU ratio 分解（6 条新测试）                                    | 1k/10k workload 选择、缺失 workload/sidecar fail-closed、非 ok record 拒绝、CLI `--workload` 输出、preposition commit 排除 |
| `node scripts/analyze-sql-result-grid-floor-headroom.mjs`（3 份 report） | exit 0，输出与逐字段手算一致                                                                                               |
| churn-disabled 臂 sidecar 回归                                           | 零计数 + `diagnosticsEndTime = commitEndTime` 通过 validator；负计数被拒                                                   |
| churn A/B 两臂真实 report 重校验                                         | enabled/disabled 各 5/5 records、20/20 correlations                                                                        |
| exact beta.4 6-repeat diagnostic profile                                 | exit 0，12/12 records；120/120 correlations                                                                                |
| 对 exact report 调用 `validateZeusDataGridDiagnosticSnapshot(...)`       | exit 0，`validated 6 records and 120 correlations`                                                                         |
| `pnpm run test:sql-result-grid-gate`                                     | exit 0，61/61 tests 通过                                                                                                   |
| targeted `pnpm exec prettier --check`                                    | exit 0                                                                                                                     |
| `git diff --check`                                                       | exit 0                                                                                                                     |

### WorkbenchTable CPU 区间 sidecar（2026-09-18，本地诊断）

ADR 0004 prerequisite 6 的 Nyala 侧实现已落地，使 `Q95(cpu_Z) / Q95(cpu_W)` 第一次可以在对称定义上
计算。新增
[`scripts/sql-result-grid-workbench-table-diagnostics.mjs`](../../scripts/sql-result-grid-workbench-table-diagnostics.mjs)
在构造真实 WorkbenchTable 之前包装 `ListView.prototype` 的 `onScroll` / `getRenderRange` / `render` /
`measureItemWidth`（`ListView` 在构造时捕获 scroll handler，晚装会漏掉 listener），并只在一个显式打开的
diagnostic operation window 内记录每个 scroll commit：

| 区间                       | 来源                          | 语义                                     |
| -------------------------- | ----------------------------- | ---------------------------------------- |
| `handlerStartTime/EndTime` | `ListView.onScroll` 入口/出口 | 该次 scroll 的同步 handler window        |
| `rangeIntervals`           | 每次 `getRenderRange`         | window/range 计算                        |
| `commitIntervals`          | 每次 `render`                 | DOM patch 与内部重算                     |
| `layoutReadIntervals`      | 每次 `measureItemWidth`       | 同步 layout read（固定行高路径可能为空） |

区间按 record 取并集（nested 不求和），与 Zeus sidecar 的 handler/range/commit/layoutRead 定义一一对应；
`scripts/sql-result-grid-floor-headroom.mjs` 现额外输出 `workbenchTableRendererIntervals` 与
`rendererCpuRatio`，任一侧缺失时 fail-closed 返回 `available: false` 而不是猜测。

instrumentation 会改变 benchmark bundle，因此 bundle 身份按状态分别记录：committed 的
pre-instrumentation entry 构建为
`f58986b454aeecbe8500c0357f76839140f26f22149294f14a5e8435a4128a35`，uncommitted 的 instrumented
entry 构建为
`a5f54dff362f5533f85cf0b5c4f37e736b25a921b2056456bc2df30d53abb382`（886,181 JavaScript bytes +
20,650 CSS bytes，hash 覆盖 `JavaScript + NUL + CSS`；本机复算两次结果一致）。下文的诊断运行记录的是
后者。

真实 A/B（`10k x 50`、`--repeat 3`、real WorkbenchTable 对同一 Zeus bundle、Chrome/CDP
diagnostic profile，2026-09-18）：

```bash
node scripts/benchmark-sql-result-grid.mjs \
  --renderer workbench-table,zeus --workload 10k-x-50 --repeat 3 \
  --workbench-table-implementation real --require-zeus true \
  --zeus-bundle /tmp/nyala-zeus-ab/data-grid-bundle.js \
  --diagnostic-profile true --output /tmp/nyala-wbt-diagnostic-r3.json
node scripts/analyze-sql-result-grid-floor-headroom.mjs \
  --report /tmp/nyala-wbt-diagnostic-r3.json
```

| 量                                    | 值                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| baseline p95 / shared floor p95       | `17.00ms` / `17.20ms`（`baseline / floor = 0.988`）                                  |
| required Zeus p95（`0.8 × baseline`） | `13.60ms`，低于 floor，最优 floor 下改善上限 `1.18%`                                 |
| Zeus interval union p95               | `2.30ms`                                                                             |
| WorkbenchTable interval union p95     | `4.60ms`                                                                             |
| `Q95(cpu_Z) / Q95(cpu_W)`             | `0.500`（远低于提案的 `0.80`）                                                       |
| sidecar 完整性                        | 每侧 60 个 sample 关联 scroll commits、22 operations，validator 通过                 |
| 报告 sha256                           | `fe476fb2ddd1614004ac7e7ed1fabab8bb9aaa344f120f90a1b94d18443c9434`（`/tmp`，非持久） |

结论与限制：

- v6 无法计算的对称 CPU ratio 现在可以计算，且本轮诊断值 `0.500` 明显低于提案阈值；但同一轮
  `baseline / floor = 0.988`，`required` 仍在地板以下，20% 门依旧不可辨识。ratio 达标不等于
  `Z1.3 = Go`。
- 两侧只汇总 sidecar 中 `phase: 'sample'` 操作声明的 scroll commit：collector 还会记录一个
  preposition scroll commit（Zeus 侧该 scroll operation 不带 commit link，另有一条独立 `resize`
  提交），若只在一侧计入就会比较不同事件集。
  修正后同一份 10k 报告由 `5.00ms / 0.460` 重算为 `4.60ms / 0.500`，两侧 commit 数均为 60。
- `measureItemWidth` 只在需要量宽时被调用，固定行高路径下 `layoutReadIntervals` 允许为空；此时 union
  仍被 handler window 覆盖，不会低估成 0。
- WorkbenchTable 在构造后另注册的 scroll observer（只读缓存值 `scrollTop/scrollHeight/renderHeight`，
  不强制 layout）落在 instrumentation window 之外，本轮不计入；这是已知口径限制，正式 v7 采数前必须
  在 ADR 内固化。
- 该 instrumentation 只在 `--diagnostic-profile true` 下启用，只增加 observer 开销、不替代 admission
  timing；不写 `phase-z1-gate.json`，`Z1.3` 仍为 `NO-GO`，ADR 0004 仍为 `Proposed`。

`1k x 20` 采样（同日追加）：harness 只在选择包含 `10k-x-50` 时装配 diagnostic report，因此这条命令把
两个 primary workload 都带上，1k 记录随 10k 一起采集，再用新增的 workload 级入口提取：

```bash
node scripts/benchmark-sql-result-grid.mjs \
  --renderer workbench-table,zeus --workload 1k-x-20,10k-x-50 --repeat 3 \
  --workbench-table-implementation real --require-zeus true \
  --zeus-bundle /tmp/nyala-zeus-ab/data-grid-bundle.js \
  --diagnostic-profile true --output /tmp/nyala-wbt-diagnostic-1k-r3.json
node scripts/analyze-sql-result-grid-floor-headroom.mjs \
  --report /tmp/nyala-wbt-diagnostic-1k-r3.json --workload 1k-x-20
```

| 量                                | 1k x 20                                                          | 同一报告 10k x 50 |
| --------------------------------- | ---------------------------------------------------------------- | ----------------- |
| Zeus interval union p95           | `2.50ms`                                                         | `2.50ms`          |
| WorkbenchTable interval union p95 | `3.10ms`                                                         | `5.10ms`          |
| `Q95(cpu_Z) / Q95(cpu_W)`         | `0.806`（低于提案 non-inferiority 上界 `1.10`）                  | `0.490`           |
| 记录 / 样本完整性                 | 6 records（Zeus/WBT 各 3）、每侧 60 commits、one-frame `120/120` | 6 records         |

- 该值是单轮 Chromium/CDP point estimate，不是提案阈值所定义的 paired-bootstrap 置信上界，也不是
  admission evidence；`1k x 20` 的 `0.806` 高于 `10k x 50` 的 superiority 阈值 `0.80`，正好落在
  non-inferiority 与 superiority 两档之间，与 ADR 按 workload 分档的注册方式一致。
- 报告 sha256 `50c766c88ca485a72e2bec23cf9c3bf3bca2681297059c03a81a5b2c2e7db7e4`（非持久）；
  provenance 为 revision `882ba222`、`sourceTreeClean=false`、Zeus bundle `3f66cf7e…`、real-WBT
  bundle `a5f54dff…`。
- 不写 `phase-z1-gate.json`，`Z1.3` 仍为 `NO-GO`，ADR 0004 仍为 `Proposed`。

`5-repeat 双 workload` 复核（同日追加，最新一轮）：把 `--repeat` 提到 5 并在同一份报告里同时采集两个
primary workload，得到目前最完整的一轮诊断：

```bash
node scripts/benchmark-sql-result-grid.mjs \
  --renderer workbench-table,zeus --workload 1k-x-20,10k-x-50 --repeat 5 \
  --workbench-table-implementation real --require-zeus true \
  --zeus-bundle /tmp/nyala-zeus-ab/data-grid-bundle.js \
  --diagnostic-profile true --output /tmp/nyala-real-wbt-cpu-both-r5.json
node scripts/analyze-sql-result-grid-floor-headroom.mjs \
  --report /tmp/nyala-real-wbt-cpu-both-r5.json
node scripts/analyze-sql-result-grid-floor-headroom.mjs \
  --report /tmp/nyala-real-wbt-cpu-both-r5.json --workload 1k-x-20
```

| 量                                    | `10k x 50`                                                  | `1k x 20` |
| ------------------------------------- | ----------------------------------------------------------- | --------- |
| baseline p95 / shared floor p95       | `17.50ms` / `17.40ms`（`1.006`）                            | —         |
| required Zeus p95（`0.8 × baseline`） | `14.00ms`，低于 floor `3.40ms`                              | —         |
| Zeus interval union p95               | `3.00ms`                                                    | `3.00ms`  |
| WorkbenchTable interval union p95     | `6.00ms`                                                    | `3.10ms`  |
| `Q95(cpu_Z) / Q95(cpu_W)`             | `0.500`                                                     | `0.968`   |
| 记录 / 完整性                         | 10 records（每侧 5）、每侧 100 commits、one-frame `200/200` | 同报告    |

- floor-bounded 改善上限为 `0.57%`（最优 floor 下 `4.57%`），`floorBoundedSuperiorityReachable` 为
  `false`：20% 门在 5-repeat 口径下同样不可辨识，`Z1.3 = NO-GO` 不变。
- `1k x 20` 的两次点估计 `0.806`（`--repeat 3`）与 `0.968`（`--repeat 5`）跨过提案的 `0.80`
  superiority 上界：同一台机器上的 run-to-run spread 说明单轮 point estimate 不能当作阈值判定，正式 v7
  必须按注册口径计算 paired-bootstrap 置信界。
- 报告 sha256 `d2d260db9f15f7b44533c7ab96e0e957e150c34c31f7f0a9dde07449f63c42f3`（非持久）；
  provenance 为 revision `882ba222`、`sourceTreeClean=false`、Zeus bundle `3f66cf7e…`、real-WBT
  bundle `a5f54dff…`。
- 不写 `phase-z1-gate.json`，`Z1.3` 仍为 `NO-GO`，ADR 0004 仍为 `Proposed`；本机 benchmark 套件
  `pnpm run test:sql-result-grid-benchmark` 为 exit 0（63/63）。

### 2026-09-18 上游发行状态复核

用已认证的 `gh`（`baicie`）与 npm registry 只读复核上游 Zeus 状态，未触发任何 workflow、未发布任何
版本：

| 对象    | 复核结果                                                                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| zeus    | 最新 release 仍是 `v0.1.1-beta.2`（`2026-08-21T09:47:28Z`，SHA `a099abbf`）；tag 列表中另有 `vite-plugin@0.0.3` / `vite-plugin@0.0.4` 两个与 Data Grid 无关的 tag     |
| zeus-ui | tag 仍停在 `v0.1.0-beta.4`（`548baa14`）；仓库没有任何 GitHub Release 对象；PR #41（`release: prepare 0.1.0-beta.5`）已于 2026-08-24 关闭，两个仓库当前都没有 open PR |
| npm     | `@zeus-web/data-grid` 共 5 个版本（beta.0–beta.4），`beta = 0.1.0-beta.4`、`latest = 0.1.0-beta.0`，registry 最后修改时间 `2026-08-21T12:22:28Z`                      |

即 core `0.1.1-beta.2` 与 zeus-ui `0.1.0-beta.4` 就是上游目前的全部整改与发行，没有等待审计的新版本；
Z1.3 保持 `NO-GO` 的原因仍是 v6 五门在地板上不可辨识，而不是漏审某个已发布版本。

## CI 证据工作流

跨平台证据入口为
[`sql-result-grid-platform.yml`](../../.github/workflows/sql-result-grid-platform.yml)，通过
`workflow_dispatch` 生成 fresh artifacts，不复用 checked-in 历史 benchmark：

1. Ubuntu `prepare-zeus` job 在临时目录精确安装和打包 Zeus，生成结构化 audit，并用同一个
   bundle 生成 `4 × 3 × 3 = 36` 条 fresh Chromium records；不修改生产 `package.json` 或
   lockfile。
2. macOS 与 Windows job 下载该 bundle、构建当前 revision 的 webdriver-enabled Nyala native
   binary，并由
   [`benchmark-sql-result-grid-webdriver.mjs`](../../scripts/benchmark-sql-result-grid-webdriver.mjs)
   驱动 embedded WKWebView/WebView2。默认每个 workload/renderer 运行 5 次；iteration 1 保存
   PNG，因此每个平台有 `4 × 3 × 5 = 60` 条 unique records 和 12 张截图。
3. aggregate job 下载 fresh audit、benchmark 和两端 platform artifacts，合并
   `platform-evidence.json` 后运行 revision-bound gate。legacy SafariDriver/EdgeDriver identity
   被 verifier 明确拒绝，不是当前 CI 证据路径。

远端 runs `31706679626` 与 `31607139340` 在 workflow 配置解析阶段即失败，均为 0 jobs、
0 artifacts；固定版本 actionlint 对对应 revision 精确报告 macOS/Windows job-level `env` 中的
`${{ runner.temp }}` context 不被 GitHub 允许。当前工作树已将目录初始化移到 step runtime，并由
Formatting CI 的 actionlint `v1.7.12` job 扫描全部 workflow；本地 actionlint exit 0，WebDriver
workflow contract tests 当时为 8/8（2026-09-17 复测 13/13）。正式 workflow 现在显式要求 real mode。后续 run `32706467306`
已在目标 revision 远端执行：Chromium 36/36、macOS/Windows 各 60/60 records
与 12/12 screenshots 均完整，证明 workflow 与 native evidence contract 已修复；aggregate 仍因本文
记录的 5 个性能门失败而按设计 `NO-GO`。

Z1 gate 通过后，还必须从 protected default branch 触发
[`sql-result-grid-gate-attest.yml`](../../.github/workflows/sql-result-grid-gate-attest.yml)。该 workflow 使用
`sql-result-grid-z1-gate` environment，API verifier 精确接受 platform run 的四个未过期、带 SHA-256
digest 且时序有效的 artifacts；它按 API URL 下载 aggregate ZIP、校验 GitHub digest 与安全路径，再由
trusted checkout 重算 gate。最终 manifest 将 gate、benchmark、platform evidence、Zeus audit、Zeus
bundle 与 platform-run 六份输入 SHA-256 绑定到同一 revision/ref/run。9 个 attestation contract tests
覆盖该链路；当前双 WebView 证据完整但性能 gate 失败，因此没有可供 R0 使用的成功 Z1 attestation run。

每个 job 在 checkout/构建前先写入 blocked manifest；失败不会留下可误判为 ready 的空白。
关键 artifacts 均使用 `if: always()` 上传，并设置 `if-no-files-found: error` 与
`overwrite: true`。聚合 job 也预置 `NO-GO` version 2 gate report，因此构建、下载、合并或 gate
任一步失败都会 fail closed，同时保留 evidence、screenshots、native app log 和 aggregate gate。

### Platform evidence schema v2（measurement contract v6）

每个平台必须满足以下完整契约：

- `version: 2`、`status: "ready"`、`runs: 5`，并具有精确的 embedded identity。macOS 是
  `wkwebview-embedded` / `webkit` / `macos`，Windows 是 `webview2-embedded` / `msedge` /
  `windows`；两者都要求 `nativeWebView: true`，只有 Windows 要求 `nativeWebView2: true`。
- `measurementContractVersion: 6`、`scrollCommitBoundary: "post-presentation-opportunity"` 和
  `executionOrder: "renderer-balanced-rotation-v1"` 必须存在于平台 report，并且每条 record 也必须
  声明相同值；platform schema v2 不会升级或替代 measurement contract v6。每条 record 的
  `executionOrdinal` 必须从 1 连续到 60，并匹配 canonical balanced plan。
- `records` 必须是 `4 workloads × 3 renderers × 5 iterations = 60` 条唯一成功记录；每条
  workload shape、timing/DOM/heap/fixture metrics 和 visible-content probe 都要有效。每条
  Workbench record 必须含 exact runtime proof，并与 report 的 Workbench bundle digest 一致。
- 对 virtual renderer，gate 根据 viewport、28px row height 和最多 16 行 overscan 重算
  `renderedRows` 上限，不信任 producer 的 `virtualRowsBounded` 布尔值。visual probe 还必须证明
  document client/scroll geometry 等于 workload、无外层 overflow，且 screenshot run marker 锚定。
- `summary` 必须包含 12 个 workload/renderer group，由 gate 从 60 条 raw records 重新计算并
  exact-match；空 summary、缺组、重复 iteration 或手写更优数字都会失败。
- `screenshots` 必须有 12 个 manifest entries，逐一对应各组 iteration 1 的 raw record。gate
  要求每个 entry 的唯一文件、`runToken` 和 viewport exact-match 对应 record，并读取 artifact 中的
  实际 PNG，复核 realpath containment、文件 bytes、SHA-256、probe dimensions、CSS viewport × DPR
  物理尺寸和 pixel diversity；复用图片、目录 symlink 逃逸、空白/纯色图都不能通过。
- provenance chain 的共同字段是 `repository`、`sourceRevision`、`sourceRef`、
  `workflowRunId`、`workflowRunAttempt`。平台 evidence 还必须有 native `binarySha256` 和
  `zeusBundleSha256` 与 `workbenchTableBundleSha256`；Chromium benchmark、Zeus audit 和双平台
  evidence 必须指向同一 revision/workflow，Zeus 与 Workbench bundle digest 分别跨三平台一致。
- gate 只有在调用方显式提供 trusted expected repository/revision/ref/workflow run/attempt 时才可能
  输出 `GO`；本地格式正确但没有 GitHub workflow identity 的 JSON 只能作为 characterization。

下面只是一个合规 platform evidence schema v2 artifact 的字段**节选**；真实 artifact 必须展开
全部 12 个 summary groups、60 条 measurement contract v6 balanced records 和 12 个 screenshot entries，
不能把节选直接作为 gate 输入：

```json
{
	"version": 2,
	"measurementContractVersion": 6,
	"scrollCommitBoundary": "post-presentation-opportunity",
	"executionOrder": "renderer-balanced-rotation-v1",
	"status": "ready",
	"runs": 5,
	"driverProvider": "embedded",
	"nativeWebView": true,
	"nativeWebView2": false,
	"engine": "wkwebview-embedded",
	"browser": "webkit",
	"platformName": "macos",
	"provenance": {
		"repository": "owner/nyala-studio",
		"sourceRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"sourceRef": "refs/heads/mvp",
		"workflowRunId": "123456789",
		"workflowRunAttempt": 1,
		"binarySha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"zeusBundleSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		"workbenchTableBundleSha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	},
	"summary": {
		"1k-x-20/native": {
			"count": 5,
			"renderMs": { "available": true, "median": 5.3, "p95": 5.5, "min": 5.1, "max": 5.5 },
			"scrollP95Ms": { "available": true, "median": 10, "p95": 10.02, "min": 9.98, "max": 10.02 },
			"scrollMaxMs": { "available": true, "median": 10.25, "p95": 10.27, "min": 10.23, "max": 10.27 },
			"domNodes": { "available": true, "median": 20035, "p95": 20035, "min": 20035, "max": 20035 },
			"heapBytes": { "available": true, "median": 1000003, "p95": 1000005, "min": 1000001, "max": 1000005 },
			"formatMs": { "available": true, "median": 1.03, "p95": 1.05, "min": 1.01, "max": 1.05 },
			"parseMs": { "available": true, "median": 2.03, "p95": 2.05, "min": 2.01, "max": 2.05 },
			"fixtureBytes": 240000
		}
	},
	"records": [
		{
			"runToken": "11111111-1111-4111-8111-111111111111",
			"measurementContractVersion": 6,
			"scrollCommitBoundary": "post-presentation-opportunity",
			"executionOrder": "renderer-balanced-rotation-v1",
			"executionOrdinal": 1,
			"status": "ok",
			"workloadId": "1k-x-20",
			"renderer": "native",
			"iteration": 1,
			"workload": {
				"rows": 1000,
				"columns": 20,
				"wide": false,
				"viewportWidth": 1440,
				"viewportHeight": 420
			},
			"userAgent": "Nyala macOS native WebKit",
			"formatMs": 1.01,
			"parseMs": 2.01,
			"renderMs": 5.1,
			"scroll": { "medianMs": 9.48, "p95Ms": 9.98, "maxMs": 10.23 },
			"domNodes": 20035,
			"fixtureBytes": 240000,
			"heapBytes": 1000001,
			"renderedRows": 1000,
			"visualProbe": {
				"rootWidth": 1440,
				"rootHeight": 420,
				"headerText": "column_0",
				"firstVisibleCellText": "0",
				"firstCellInViewport": true,
				"virtualRowsBounded": true,
				"documentViewport": {
					"clientWidth": 1440,
					"clientHeight": 420,
					"scrollWidth": 1440,
					"scrollHeight": 420
				},
				"outerDocumentOverflowFree": true,
				"runMarkerAnchored": true,
				"visibleTextLength": 100
			},
			"screenshot": "macos-1k-x-20-native-11111111-1111-4111-8111-111111111111.png",
			"screenshotProbe": {
				"passed": true,
				"reason": "screenshot pixels are visible and nonblank",
				"bytes": 12345,
				"sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
				"runToken": "11111111-1111-4111-8111-111111111111",
				"viewport": { "width": 1440, "height": 420, "devicePixelRatio": 1 },
				"width": 1440,
				"height": 420,
				"bitDepth": 8,
				"colorType": 2,
				"compression": 0,
				"filter": 0,
				"interlace": 0,
				"sampledPixels": 100800,
				"visiblePixels": 100800,
				"visiblePixelRatio": 1,
				"distinctColorBuckets": 4,
				"lumaRange": 100
			}
		}
	],
	"screenshots": [
		{
			"file": "macos-1k-x-20-native-11111111-1111-4111-8111-111111111111.png",
			"workloadId": "1k-x-20",
			"renderer": "native",
			"iteration": 1,
			"runToken": "11111111-1111-4111-8111-111111111111",
			"viewport": { "width": 1440, "height": 420, "devicePixelRatio": 1 },
			"bytes": 12345,
			"sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
		}
	]
}
```

```bash
NYALA_PLATFORM_EVIDENCE=/path/to/platform-evidence.json pnpm run verify:sql-result-grid-gate
```

在 Z1.3 通过并记录 Go 之前，Zeus 不加入生产依赖、不注册 custom element，也不改变
`SqlResultView` 的默认 native 行为；`Z2` **禁止开始**。当前结果只是可复核的准入门禁实现，
不是 Zeus 接入完成证明。

### Chromium synthetic visual review workflow

另有 [`sql-result-grid-visual.yml`](../../.github/workflows/sql-result-grid-visual.yml) 作为轻量的
GitHub Actions PR/`workflow_dispatch` 入口。其 `capture` job 在固定的 Ubuntu Chromium 环境中运行
[`capture-sql-result-grid-visual.mjs`](../../scripts/capture-sql-result-grid-visual.mjs)，为每个 workload/
renderer 保存 PNG 和 JSON manifest。manifest 会记录 benchmark 状态、renderer identity、root bounds、
header/cell sentinel、visible text、PNG magic/header、viewport 尺寸、文件大小和 SHA-256，方便下载
artifact 做 synthetic visual 审查；`workbench-table` 现在来自真实隔离组件 bundle，workflow summary
明确标注不是完整 production Workbench，且
不上传 query rows 或其他运行时数据。

该 workflow 只捕获 standalone native 与 isolated real WorkbenchTable benchmark，并只在 benchmark/harness/workflow
自身变化时自动触发，不声称测试生产 `SqlResultView`。Zeus screenshot 仍由双平台 evidence workflow
负责。Chromium PNG 不替代生产 Workbench 视觉回归、Z1.3 的 macOS WebKit、Windows WebView2 或
原生走查，也不会改变 Z1 gate 的当前 `NO-GO` 结论。

同一 workflow 的 `workbench-agent` job 启动 Vite 并运行真实
[`capture-sql-agent-workbench.mjs`](../../scripts/capture-sql-agent-workbench.mjs)，所以 SQL Agent
贡献的 desktop/narrow 截图与 synthetic result-grid characterization 分开存放、分开判定。该 job
不会把 Chromium 结果写入 `phase-z1-gate.json`，也不把它当作双 WebView Go 证据。

## Z2 native contract prework（Z2 禁止开始）

为减少后续生产试点的改动面，已先提取 native success-grid adapter，并增加 fail-closed
renderer selection contract：`native` 始终可用，`zeus-preview` 在 adapter 不可用时回退到
`native`。产品 preference 的默认值为 `native`，当前没有 Zeus import、生产依赖或 Preview
入口；这组代码只固定输入/输出与 listener disposal 边界，不构成 Z2 开始或 Z1 Go 证据。

对应实现为 `src/vs/workbench/contrib/sqlResult/browser/sqlResultNativeRenderer.ts`、
`src/vs/workbench/contrib/sqlResult/common/sqlResultRenderer.ts`，并由
`test:sql-result` 的 renderer contract tests 覆盖。

## R0 release gate

R0 prework 已实现。受保护的
[`sql-mvp-vnext-release-evidence.yml`](../../.github/workflows/sql-mvp-vnext-release-evidence.yml) 只允许
protected default branch，并使用 `sql-mvp-vnext-release` environment。它精确验证 A4/Z1 attestation
run/artifact API metadata，经 GitHub artifact API URL 下载、核对 ZIP SHA-256 与安全路径后，只把认证后
的 raw evidence 交给
[`scripts/verify-sql-mvp-vnext-release.mjs`](../../scripts/verify-sql-mvp-vnext-release.mjs)。R0 输出
release report schema v3，并重算 Checkpoint W 四份与 Z1 六份 raw input SHA-256；同时校验完整 metric、
measurement contract v6/order、screenshot、dependency audit、provenance、Z2 roadmap/production dependency/
renderer boundary，拒绝最小或完整手写的 `GO` evidence、过期/伪造 artifact 与错误时序。
`test:sql-mvp-vnext-release` 的 35/35 tests 已覆盖这些 fail-closed 路径，包括 real WorkbenchTable
identity check、跨平台 bundle digest binding 与 R0 summary 重校验。

GitHub API 已确认默认分支 `mvp` 的 strict branch protection 存在；2026-09-17 复核时三个 attestation
workflow 已发布到 `mvp`（blob SHA 与本地 HEAD 一致，runs 均为 0），仓库 environment 列表仍为空。
**2026-09-18 更正**：environment 为空不构成阻塞——GitHub 文档写明 _"Running a workflow that references
an environment that does not exist will create an environment with the referenced name … Otherwise, the
newly created environment will not have any protection rules or secrets configured."_（[Managing
environments for
deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)，
2026-09-18 取得），三个 workflow 也只使用 `secrets.GITHUB_TOKEN`；人工预建 environment 只是可选的
required-reviewers 纵深保护。即使 feature-branch 双平台 evidence 已完整，在性能 gate、受保护
attestation、待合入 `mvp` 的本地修复与 Checkpoint W 人工证据全部通过前，Z1.3、Checkpoint W、R0 均保持
`NO-GO`，Z2 禁止开始。

当前 [`phase-vnext-release-gate.json`](./phase-vnext-release-gate.json) 仍为 `NO-GO`，因此
`R0 = NO-GO`。这不等于 R0 已发布，也不授权绕过 Z1/A4 gate 或开始 Z2。
