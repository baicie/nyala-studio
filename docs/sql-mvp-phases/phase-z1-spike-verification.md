# Z1 Zeus Data Grid Spike Verification

日期：2026-08-17

范围：Z1.1 dependency/bundle audit、Z1.2 reproducible renderer benchmark、Z1.3
revision-bound 双原生 WebView Go/No-Go。

当前结论：`Z1.3 = NO-GO`、`Z2 = 禁止开始`、`R0 = NO-GO`。Zeus 仍未加入生产依赖，
也没有 production renderer integration。

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

## 自动化证据

| 命令                                                                                                 | 结果                                         |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `pnpm add --dir <temp> @zeus-web/data-grid@0.1.0-beta.2`                                             | exit 0，仅临时目录                           |
| `pnpm view @zeus-web/data-grid@0.1.0-beta.2 dist.integrity dist.unpackedSize license version --json` | exit 0                                       |
| `pnpm why @zeus-web/data-grid`（临时目录）                                                           | exit 0，只有临时 root project 引用           |
| `pnpm run test:sql-result-grid-benchmark`                                                            | exit 0，32/32 tests 通过                     |
| `pnpm run test:sql-result-grid-webdriver`                                                            | exit 0，7/7 tests 通过                       |
| `pnpm run test:sql-result-grid-zeus-audit`                                                           | exit 0，2/2 tests 通过                       |
| `pnpm run test:sql-result-grid-platform-evidence`                                                    | exit 0，1/1 test 通过                        |
| `pnpm run test:sql-result-grid-gate`                                                                 | exit 0，51/51 tests 通过                     |
| `pnpm run test:sql-result-grid-attestation`                                                          | exit 0，9/9 tests 通过                       |
| `pnpm run test:sql-mvp-vnext-release`                                                                | exit 0，30/30 tests 通过                     |
| `pnpm run verify:sql-result-grid-gate`                                                               | 当前 evidence 按预期 exit 1，`NO-GO`         |
| `pnpm run verify:sql-mvp-vnext-release`                                                              | 当前 release evidence 按预期 exit 1，`NO-GO` |

## Z1.2 三 renderer benchmark

脚本 [`scripts/benchmark-sql-result-grid.mjs`](../../scripts/benchmark-sql-result-grid.mjs) 在
临时 `file://` 页面中生成确定性的 SQL-like fixture，比较 native `<table>`、WorkbenchTable
固定行高 virtual-list characterization 和审计 bundle 中的 `zw-data-grid`。每个组合运行 3 次；
完整原始记录（含 user agent、fixture bytes、parse/format、render、scroll、DOM 和 heap 字段）见
[`phase-z1-benchmark.json`](./phase-z1-benchmark.json)。

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

| workload / renderer           | render | scroll p95 | DOM nodes |  heap delta | parse | format |
| ----------------------------- | -----: | ---------: | --------: | ----------: | ----: | -----: |
| 1k-x-20 / native              |    7.2 |       20.7 |    21,035 |     780,645 |   2.1 |    0.3 |
| 1k-x-20 / WorkbenchTable      |    1.0 |       18.1 |       664 |     711,990 |   2.0 |    0.4 |
| 1k-x-20 / Zeus                |   18.0 |       18.4 |       328 |   4,491,021 |   2.2 |    0.3 |
| 10k-x-50 / native             |  211.1 |      408.1 |   510,065 | unavailable |  85.2 |    7.9 |
| 10k-x-50 / WorkbenchTable     |    3.5 |       19.8 |     1,594 |   1,446,945 | 104.1 |    6.2 |
| 10k-x-50 / Zeus               |   81.2 |       19.6 |       328 | unavailable | 111.7 |    6.6 |
| wide-columns / native         |    8.2 |       19.4 |    21,035 |     794,820 |  10.5 |    0.5 |
| wide-columns / WorkbenchTable |    1.0 |      125.1 |       664 |     705,339 |  12.0 |    0.4 |
| wide-columns / Zeus           |   21.2 |       27.3 |       328 |  12,380,067 |  12.9 |    0.4 |
| narrow-panel / native         |    7.5 |       21.5 |    21,035 |     788,400 |   2.0 |    0.4 |
| narrow-panel / WorkbenchTable |    1.0 |       17.8 |       664 |     706,299 |   2.1 |    0.3 |
| narrow-panel / Zeus           |   12.0 |       18.9 |       139 |  15,455,211 |   2.0 |    0.2 |

v6 的 36 条 records 各含 20 个 raw scroll samples，共 720 个样本。checked report 中没有
`visibleRowIndex < 0` 或 `committed !== true` 的样本；每次 probe 前都实际跨过 presentation
opportunity，且全部样本在第一次 post-presentation probe 提交：

| renderer       | raw samples | attempts | presentation opportunities | invalid visible row | uncommitted |
| -------------- | ----------: | -------: | -------------------------: | ------------------: | ----------: |
| native         |         240 |        1 |                          1 |                   0 |           0 |
| WorkbenchTable |         240 |        1 |                          1 |                   0 |           0 |
| Zeus           |         240 |        1 |                          1 |                   0 |           0 |

这说明三个 renderer 现在共享同一 completion floor，不再让 full-DOM native table 绕过 frame/presentation
成本。v6 的 ordinal `1..36` 连续且每条 tuple 与平衡计划一致。它还暴露了同一进程中 10k native
之后的 renderer 长尾，证明旧固定分组会掩盖 GC/JIT 状态差异；这类长尾保留在 raw records 和跨运行
p95 中，不会被从证据中删除。修复 measurement harness 不等于 Zeus 已通过：v6 没有放宽原阈值，
10k 收益仍不足。

The heap field is `unavailable` when Chromium does not expose a non-zero
`performance.memory` delta; zero is not treated as a memory win. The benchmark is a browser
characterization only: it does not claim to instantiate the full Workbench, and its JSON/format
timings do not invoke Tauri or a database.

## Gate 状态

Z1.3 gate verifier [`scripts/verify-sql-result-grid-gate.mjs`](../../scripts/verify-sql-result-grid-gate.mjs)
固化了三个预注册阈值：1k×20 关键交互回归不超过 10%、10k×50 相对最佳非 Zeus
baseline 的主指标改善至少 20%、fresh bundle 的 gzip 增量不超过 30,000 bytes。平台要求是
macOS WKWebView 与 Windows WebView2 各精确运行 5 次，不是普通浏览器等价物。

当前报告 [`phase-z1-gate.json`](./phase-z1-gate.json) 为 gate report schema version 2、
`NO-GO`，门禁返回
exit 1。结论至少有以下三类彼此独立的阻塞：

- **10k 性能收益不足。** `1k-x-20` 以最佳非 Zeus baseline（WorkbenchTable `18.1ms`）比较
  Zeus `18.4ms`，回归为 `1.7%`，已满足“不超过 10%”的要求；`10k-x-50` 以
  WorkbenchTable `19.8ms` 为最佳 baseline，Zeus 为 `19.6ms`，改善仅 `1.0%`，低于至少
  `20%` 的要求。旧 v5 固定分组记录中的 `9.0%` 已被 v6 平衡调度取代；公开
  `refreshViewport()` 同步刷新探针也会造成重复刷新，未保留。
- **revision-bound 双平台原生证据缺失。** 当前没有同一 repository/ref/revision/workflow
  run 下、符合 platform evidence schema v2 且采用 measurement contract v6/order 的 macOS embedded
  WKWebView 与 Windows embedded WebView2 evidence；两边
  均没有可验证的 60 条 raw records、12 个实际 PNG 文件及 native binary provenance。
- **当前 revision 的结构化 Zeus audit 缺失。** gate 没有可读取并复算的 package/closure/
  bundle artifact，无法证明当前运行使用的 bundle、gzip bytes 和 SHA-256；历史 `24,260`
  bytes 不会被当作本次通过值。

此外，checked-in Chromium benchmark 本身记录 `sourceTreeClean: false`，并缺少当前 platform
evidence schema v2 / measurement contract v6 证据链要求的 workflow provenance。
因此即使之后只补齐双原生 WebView，当前 10k `1.0%` 改善仍使 Z1.3 保持
`NO-GO`。Chromium-only 结果、旧 summary 或最小化伪造的 `GO` JSON 都不能绕过校验。

### Z1.3 presentation-floor feasibility profile

为了区分 renderer 工作量与 v6 共同 completion boundary，本轮新增默认关闭的非门禁 profiler。
`pnpm run profile:sql-result-grid-feasibility` 只跑 `10k-x-50` 的 WorkbenchTable/Zeus，各 6 次并
继续使用 `renderer-balanced-rotation-v1`。每条 record 在完成原有 20 个真实位移样本后，再记录
20 个无 renderer 工作的 `requestAnimationFrame -> post-frame task` floor 样本；profile 从 raw
samples 重算 median/p95/max，拒绝旧合同、错误 execution plan/ordinal、缺失样本、非有限值和被篡改
的汇总。默认 `benchmark:sql-result-grid` 不启用该模式，Z1 gate 也不消费 profile 结果，因此没有改变
measurement contract v6、预注册阈值或正式 evidence schema。

本机结构化记录见
[`phase-z1-feasibility-profile.json`](./phase-z1-feasibility-profile.json)：12/12 records 为 `ok`，
240 个 scroll samples 和 240 个 floor samples 完整，scroll samples 均首次提交且 ordinal 为 `1..12`。
WorkbenchTable scroll p95 中位为 `20.1ms`，Zeus 为 `20.0ms`，实际改善约 `0.5%`；20% 门槛要求
Zeus 不高于 `16.08ms`，而共享 presentation floor p95 为 `18.5ms`。即使把 Zeus renderer 工作假设
为零，观测 floor 约束下的最大改善也只有 `8.0%`。profile 因此给出
`PRESENTATION_FLOOR_LIMITED`，并保留全部 raw samples，没有删样或修改 baseline。

该 profile 是 Chromium-only、dirty-worktree 的诊断 artifact，不是 Z1 Go 证据。它把性能分支收敛为
有界停止结论：继续调整 Zeus overscan、公开 `refreshViewport()` 或 row adapter 不能跨过当前主指标
的共同 floor。任何改用 sub-frame CPU/handler 指标或修改 20% 门槛的方案都必须由产品负责人显式
重新预注册；在此之前保留 Z1.3 `NO-GO`，不启动 Z2。

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
workflow contract tests 为 7/7。修复尚未发布到远端，因此必须在目标 revision 发布后重新触发
`workflow_dispatch`；这项可启动性修复不改变 10k 指标只改善 `1.0%` 的性能 `NO-GO`。

Z1 gate 通过后，还必须从 protected default branch 触发
[`sql-result-grid-gate-attest.yml`](../../.github/workflows/sql-result-grid-gate-attest.yml)。该 workflow 使用
`sql-result-grid-z1-gate` environment，API verifier 精确接受 platform run 的四个未过期、带 SHA-256
digest 且时序有效的 artifacts；它按 API URL 下载 aggregate ZIP、校验 GitHub digest 与安全路径，再由
trusted checkout 重算 gate。最终 manifest 将 gate、benchmark、platform evidence、Zeus audit、Zeus
bundle 与 platform-run 六份输入 SHA-256 绑定到同一 revision/ref/run。9 个 attestation contract tests
覆盖该链路；当前性能与双 WebView 证据仍失败，因此没有可供 R0 使用的成功 Z1 attestation run。

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
  workload shape、timing/DOM/heap/fixture metrics 和 visible-content probe 都要有效。
- `summary` 必须包含 12 个 workload/renderer group，由 gate 从 60 条 raw records 重新计算并
  exact-match；空 summary、缺组、重复 iteration 或手写更优数字都会失败。
- `screenshots` 必须有 12 个 manifest entries，逐一对应各组 iteration 1 的 raw record。gate
  要求每个 entry 的唯一文件、`runToken` 和 viewport exact-match 对应 record，并读取 artifact 中的
  实际 PNG，复核 realpath containment、文件 bytes、SHA-256、probe dimensions、CSS viewport × DPR
  物理尺寸和 pixel diversity；复用图片、目录 symlink 逃逸、空白/纯色图都不能通过。
- provenance chain 的共同字段是 `repository`、`sourceRevision`、`sourceRef`、
  `workflowRunId`、`workflowRunAttempt`。平台 evidence 还必须有 native `binarySha256` 和
  `zeusBundleSha256`；Chromium benchmark、Zeus audit 和双平台 evidence 必须指向同一 revision/
  workflow，所有 renderer evidence 必须绑定 audit 中同一个 bundle SHA-256。
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
		"zeusBundleSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
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
artifact 做 synthetic characterization 审查；workflow summary 明确标注不是 production Workbench，且
不上传 query rows 或其他运行时数据。

该 workflow 只捕获 standalone native 与 WorkbenchTable benchmark，并只在 benchmark/harness/workflow
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
`test:sql-mvp-vnext-release` 的 30/30 tests 已覆盖这些 fail-closed 路径。

GitHub API 已确认默认分支 `mvp` 的 strict branch protection 存在，但仓库尚无 environment，且本地
Z1 attestation/R0 workflow 尚未发布。管理员仍需创建 `sql-agent-checkpoint-w`、
`sql-result-grid-z1-gate`、`sql-mvp-vnext-release` 三个 environment 并启用 required reviewers；完成
workflow 发布、配置及真实双平台证据前，Z1.3、Checkpoint W、R0 均保持 `NO-GO`，Z2 禁止开始。

当前 [`phase-vnext-release-gate.json`](./phase-vnext-release-gate.json) 仍为 `NO-GO`，因此
`R0 = NO-GO`。这不等于 R0 已发布，也不授权绕过 Z1/A4 gate 或开始 Z2。
