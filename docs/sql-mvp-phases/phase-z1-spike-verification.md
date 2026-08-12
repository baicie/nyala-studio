# Z1 Zeus Data Grid Spike Verification

日期：2026-08-12  
范围：Z1.1 dependency/bundle audit、Z1.2 reproducible renderer benchmark；Z1.3 双 WebView
Go/No-Go 尚未完成，仍未放行生产接入。

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
- 前序隔离 bundle smoke 的结果为 73,483 bytes、gzip -9 约 24,260 bytes；该结果满足
  30 KB 建议预算，但不是 Nyala 最终 Vite chunk 的替代值。

## 自动化证据

| 命令                                                                                                 | 结果                               |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `pnpm add --dir <temp> @zeus-web/data-grid@0.1.0-beta.2`                                             | exit 0                             |
| `pnpm view @zeus-web/data-grid@0.1.0-beta.2 dist.integrity dist.unpackedSize license version --json` | exit 0                             |
| `pnpm why @zeus-web/data-grid`（临时目录）                                                           | exit 0，只有临时 root project 引用 |

## Z1.2 三 renderer benchmark

脚本 [`scripts/benchmark-sql-result-grid.mjs`](../../scripts/benchmark-sql-result-grid.mjs) 在
临时 `file://` 页面中生成确定性的 SQL-like fixture，比较 native `<table>`、WorkbenchTable
固定行高 virtual-list characterization 和审计 bundle 中的 `zw-data-grid`。每个组合运行 3 次；
完整原始记录（含 user agent、fixture bytes、parse/format、render、scroll、DOM 和 heap 字段）见
[`phase-z1-benchmark.json`](./phase-z1-benchmark.json)。

中位数摘要如下，时间单位为 ms：

| workload / renderer           | render | scroll p95 | DOM nodes |  heap delta | parse | format |
| ----------------------------- | -----: | ---------: | --------: | ----------: | ----: | -----: |
| 1k-x-20 / native              |    7.5 |       19.5 |    21,035 |     763,932 |   3.0 |    0.3 |
| 1k-x-20 / WorkbenchTable      |    5.5 |        6.6 |       622 |     161,917 |   3.1 |    0.3 |
| 1k-x-20 / Zeus                |   16.8 |        4.0 |       202 |   1,997,231 |   2.9 |    0.3 |
| 10k-x-50 / native             |  201.5 |      325.9 |   510,065 | unavailable |  51.4 |    5.2 |
| 10k-x-50 / WorkbenchTable     |    5.8 |        5.1 |     1,492 |     816,146 |  51.6 |    5.2 |
| 10k-x-50 / Zeus               |   77.2 |        4.0 |       202 |   1,400,297 |  51.8 |    5.2 |
| wide-columns / native         |    7.5 |       20.1 |    21,035 | unavailable |  12.8 |    0.4 |
| wide-columns / WorkbenchTable |    5.1 |        8.1 |       622 |     160,325 |  12.9 |    0.3 |
| wide-columns / Zeus           |   16.8 |        4.1 |       202 | unavailable |  12.7 |    0.4 |
| narrow-panel / native         |    7.5 |       18.2 |    21,035 |   1,274,131 |   3.0 |    0.4 |
| narrow-panel / WorkbenchTable |    5.2 |        6.8 |       622 |     161,737 |   2.9 |    0.3 |
| narrow-panel / Zeus           |   16.5 |        4.1 |       202 |   2,048,191 |   3.0 |    0.3 |

The heap field is `unavailable` when Chromium does not expose a non-zero
`performance.memory` delta; zero is not treated as a memory win. The benchmark is a browser
characterization only: it does not claim to instantiate the full Workbench, and its JSON/format
timings do not invoke Tauri or a database.

## Gate 状态

Z1.1 和 Z1.2 已完成（Z1.2 的 36 条原始记录和 3 次重复摘要已保存）。Z1.3 仍需 macOS
WebKit 与 Windows WebView2 各 5 次运行，验证 1k×20 关键交互回归不超过 10%、10k×50
相对最佳非 Zeus baseline 的主指标改善至少 20%、以及 gzip 增量不超过 30 KB。

Z1.3 gate verifier [`scripts/verify-sql-result-grid-gate.mjs`](../../scripts/verify-sql-result-grid-gate.mjs)
已将这些阈值、bundle budget 和平台探测固化；本次报告见
[`phase-z1-gate.json`](./phase-z1-gate.json)。当前结论为 `NO-GO`，命令因为门禁未满足返回
exit 1：macOS WebKit session 需要用户在 Safari Developer 设置开启 Allow remote automation，
Windows 环境没有 `msedgedriver`，两边均为 `0/5` runs。指标计算不会把 Chromium-only 结果冒充
WebKit/WebView2 证据。

## CI 证据工作流

跨平台证据入口为
[`sql-result-grid-platform.yml`](../../.github/workflows/sql-result-grid-platform.yml)，通过
`workflow_dispatch` 在 macOS 与 Windows runner 上各运行 5 次，首轮每个 workload/renderer
保存 PNG 截图，并上传结构化 evidence artifact。临时 Zeus bundle 只在 Ubuntu job 的临时目录中
安装和打包，不修改生产 `package.json` 或 lockfile。WebDriver runner 为
[`benchmark-sql-result-grid-webdriver.mjs`](../../scripts/benchmark-sql-result-grid-webdriver.mjs)。

工作流默认允许 Windows 使用 EdgeDriver 做诊断，但这不会被当成原生 WebView2 证据；只有真实
WebView2 host 的 runner 才能把 `nativeWebView2` 设为 `true`。gate 同时要求 macOS evidence
明确 `engine: "safari-webdriver"`，避免截图或 Chromium 结果绕过平台身份校验。截图、driver log、
合并后的 `platform-evidence.json` 和 `phase-z1-gate.json` 都会作为 workflow artifacts 保留。
设置 `native_webview2: true` 时，workflow 不会启动普通 EdgeDriver，而是使用
`windows_driver_url` 指向 runner 上已经启动的原生 WebView2 WebDriver。

原生平台走查可以在对应机器上把每个平台的 5 次结果写入一个证据 JSON，再通过第三个参数或
`NYALA_PLATFORM_EVIDENCE` 注入 verifier；verifier 只接受 `status: "ready"`、`runs >= 5`
以及与 Chromium benchmark 相同形状的 `summary`（至少含 1k×20 与 10k×50 的三 renderer
scroll median/p95 数据）的两项记录。例如，`summary` 应直接来自该平台的 benchmark 输出：

```json
{
	"macosWebKit": {
		"status": "ready",
		"runs": 5,
		"engine": "safari-webdriver",
		"reason": "recorded on macOS WebKit",
		"summary": {
			"1k-x-20/native": {},
			"1k-x-20/workbench-table": {},
			"1k-x-20/zeus": {},
			"10k-x-50/native": {},
			"10k-x-50/workbench-table": {},
			"10k-x-50/zeus": {}
		}
	},
	"windowsWebView2": {
		"status": "ready",
		"runs": 5,
		"engine": "msedgedriver",
		"nativeWebView2": true,
		"reason": "recorded on Windows WebView2",
		"summary": {
			"1k-x-20/native": {},
			"1k-x-20/workbench-table": {},
			"1k-x-20/zeus": {},
			"10k-x-50/native": {},
			"10k-x-50/workbench-table": {},
			"10k-x-50/zeus": {}
		}
	}
}
```

```bash
NYALA_PLATFORM_EVIDENCE=/path/to/platform-evidence.json pnpm run verify:sql-result-grid-gate
```

在 Z1.3 通过并记录 Go 之前，Zeus 不加入生产依赖、不注册 custom element，也不改变
`SqlResultView` 的默认 native 行为；Z2 与 R0 保持未完成。当前结果只是可复核的依赖准入证据，
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

## Z2.1 native contract prework（不推进 Z2）

为减少后续生产试点的改动面，已先提取 native success-grid adapter，并增加 fail-closed
renderer selection contract：`native` 始终可用，`zeus-preview` 在 adapter 不可用时回退到
`native`。产品 preference 的默认值为 `native`，当前没有 Zeus import、生产依赖或 Preview
入口；这组代码只固定输入/输出与 listener disposal 边界，不构成 Z2 开始或 Z1 Go 证据。

对应实现为 `src/vs/workbench/contrib/sqlResult/browser/sqlResultNativeRenderer.ts`、
`src/vs/workbench/contrib/sqlResult/common/sqlResultRenderer.ts`，并由
`test:sql-result` 的 renderer contract tests 覆盖。
