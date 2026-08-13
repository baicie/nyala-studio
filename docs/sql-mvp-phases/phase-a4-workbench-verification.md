# A4 Workbench Verification

日期：2026-08-13
范围：A4.1 editor/error draft artifacts 与 A4.2 Agent Panel、Schema/Result/Fix actions。

## 已交付

- `SqlAgentArtifact` 是 transient proposal，绑定 `runId`、`editorId`、base document version
  和 exact base SQL；应用前通过三项一致性检查，stale editor 不会被覆盖。
- 既有 Generate/Optimize 草稿动作要求用户选择 Apply/Open/Cancel；Apply 失败时保留用户当前
  内容并显示 stale warning，未改变原有 SQL execution 或 provider contract。
- `SqlAgentView` 注册到 Workbench Panel，通过 `ISqlAgentService` 启动/取消 Agent run，展示
  state、usage、answer、error 和 evidence refs；面板关闭只释放 listener，不隐式取消 run。
- `SQL AI: Generate from Schema` 通过 `ISqlMetadataService` 读取有界的真实表/列 metadata，再以
  Suggest-only 请求生成 SQL diff；`SQL AI: Explain Result` 只发送列 shape、行数、耗时和截断标志，
  不发送 rows。
- `SqlAgentService` 保存最后一个 typed run event，动作打开 Panel 后仍能恢复 projection；Panel
  listener 和 DOM listeners 均由 ViewPane 生命周期释放。
- Panel projection 保留结构化 `toolCalls` 的 `callId/tool/contextRefs` 安全摘要、warnings、
  partial 和 query-call count；后端 tool arguments 不进入前端 contract，Panel 以独立的
  Activity/Warnings 列表展示这些状态。
- 标准 Tauri v2 没有 `withGlobalTauri` 时，service 通过官方 event API 订阅；全局 bridge 在
  WebView 关闭阶段失效时会回退到官方 API，并在 service dispose 后释放 late listener。
- Panel 没有直接 Tauri invoke、没有持久化 rows/secret，也没有成为 Rust authorization boundary。
- Agent Panel controls 在窄视口允许换行；420px 以下 task/mode 选择器独占一行，Start/Cancel
  保持可见并各占半行，避免操作区横向溢出。
- Result error surface 的 `Fix with Agent` 使用当前可见 snapshot 的 SQL、connection 和结构化错误，
  真实 schema context 按稳定顺序限制为 24 张表、每表 64 列。Rust 在分配 run 前强制
  `FixError` 为 Suggest-only，deterministic fix 保持零 query call。
- editor execution 的 `editorVersionId`、execution source 和 statement count 会穿过 Result live state
  与历史 snapshots。只有同 editor、同 connection、同 version、单语句 `Run All` 且 SQL 基线未变时
  才显示 Apply；selection/current statement/multi-statement/stale context 只能 Open in new query。
- 所有草稿 target 都在 prompt/metadata/provider await 前捕获，quick pick 返回后再次校验 active editor；
  historical snapshot 不会误用隐藏的 live result。Rust Model Gateway 边界会移除结构化错误的 legacy
  duplicate 和可选 detail，并脱敏 URL、host、credential、Bearer token 与 private key 文本。
- deterministic fix 只接受唯一 table/column 映射，复用 SQL lexer 排除字符串和注释中的表名；identifier
  replacement 同样跳过字符串、quoted identifier 和注释，无法安全判断时返回原 SQL。

## 自动化验证

| 命令                                               | 结果                                                                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run test`                                    | exit 0；含 319 Rust passed / 2 ignored、100 Agent focused Rust tests 与全部 SQL/视觉脚本 suites                                               |
| `pnpm run test:sql-services`                       | 98 tests 通过（含 request-time artifact target、stale async response 与 late listener dispose）                                               |
| `pnpm run test:sql-editor`                         | 73 tests 通过                                                                                                                                 |
| `pnpm run test:sql-result`                         | 84 tests 通过（含 error context、execution provenance、batch/history snapshot 与 visible snapshot contract）                                  |
| `pnpm run test:sql-advanced`                       | 84 tests 通过（含 Fix apply guard、schema bounds、Agent Panel、ARIA、narrow controls 与 Tauri event contract）                                |
| `pnpm run test:sql-agent-workbench-visual`         | 12 tests 通过                                                                                                                                 |
| `pnpm run test:sql-result-grid-gate`               | 5 verifier tests 通过；只证明 fail-closed verifier，不改变 Z1.3 `NO-GO`                                                                       |
| `pnpm run lint` / `pnpm run build`                 | exit 0 / exit 0                                                                                                                               |
| `pnpm run rust:check` / `rust:clippy` / `rust:fmt` | exit 0 / exit 0 / exit 0                                                                                                                      |
| changed-files Prettier / `git diff --check`        | exit 0 / exit 0                                                                                                                               |
| 隔离 Chromium 1.62.1 browser QA                    | desktop 1440x900、narrow 390x844、Panel ARIA/Tab checks 通过                                                                                  |
| 真实 Workbench Chromium capture                    | desktop 1440x900、narrow 390x844；执行 `sql.agent.openPanel`，真实 `.sql-agent-view`、ARIA、idle state、Tab 顺序和 PNG pixel/hash checks 通过 |

全仓 `pnpm run format:check` 仍因 145 个既有 upstream/vendor 文件不符合当前 Prettier 基线而 exit 1；
本轮所有 modified/untracked TS、JS、JSON、Markdown 与 YAML 文件的定向 Prettier check 均为 exit 0。

Browser QA 使用 `pnpm run dev:vite`，等待 Workbench boot 后打开 `SQL Agent` tab；纯浏览器运行时
会记录预期的 Tauri IPC unavailable warnings，但 Workbench、Panel DOM 和 keyboard focus 都可验证。
截图证据：`/tmp/nyala-sql-agent-desktop.png`、`/tmp/nyala-sql-agent-narrow.png`、
`/tmp/nyala-sql-agent-panel.png`、`/tmp/nyala-sql-agent-evidence-desktop.png`、
`/tmp/nyala-sql-agent-evidence-narrow.png`。本轮新增截图确认 Agent activity/warnings 列表在
空态仍保留稳定 ARIA surface；纯浏览器预览的 Tauri IPC unavailable 日志仍属预期。macOS WebKit、
Windows WebView2 与真实 screen-reader walkthrough 仍需原生环境完成。

Result grid 的 Chromium synthetic characterization 现在也可通过
`pnpm run capture:sql-result-grid-visual` 或
`.github/workflows/sql-result-grid-visual.yml` 复现；它只生成 standalone grid PNG/manifest，不能
测试生产 `SqlResultView`，也不能替代 A4 的 native Checkpoint W。

真实 Workbench Agent capture 同样由
`pnpm run capture:sql-agent-workbench -- --url http://localhost:1420/ --output-dir <dir>` 复现，
并由同一 GitHub workflow 的 `workbench-agent` job 上传。它通过 Workbench web command facade 打开
`sql.agent.openPanel`，验证八个 ARIA surface、Start/Cancel idle state、desktop/narrow viewport、
Tab 顺序、root bounds、PNG pixel diversity 和 SHA-256。窄屏会先执行现有
`workbench.action.closeSidebar`，确保 390px 聚焦布局内所有 Agent controls 可见；这项动作不改变
Workbench shell 或 SQL Agent 产品代码。

本地证据：`/tmp/nyala-sql-agent-workbench-narrow-fix/workbench-evidence.json`、
`/tmp/nyala-sql-agent-workbench-narrow-fix/sql-agent-workbench-desktop.png`、
`/tmp/nyala-sql-agent-workbench-narrow-fix/sql-agent-workbench-narrow.png`。

## Embedded native runner 状态

原生证据 runner 已实现于
[`capture-sql-agent-workbench-webdriver.mjs`](../../scripts/capture-sql-agent-workbench-webdriver.mjs)，
底层使用 debug-only `tauri-plugin-wdio-webdriver` 启动真实 Nyala Tauri binary，并在创建 embedded
session 后校验 WebView identity。runner 会执行 desktop/narrow viewport、W3C `/actions` Tab 键盘
操作、Workbench/Agent Panel ARIA 与布局断言，并保存 PNG 像素检查、SHA-256 和 fail-closed evidence；
[`sql-agent-native.yml`](../../.github/workflows/sql-agent-native.yml) 在 macOS 与 Windows 上上传这些
artifact。它验证的是嵌入式 Workbench DOM、布局、键盘和视觉 surface，不声称 Tauri IPC 或 Agent
native execution 已由 localhost 页面证明。

本机 macOS 试跑已识别到 `driverProvider: embedded`、`nativeWebView: true`、
`engine: wkwebview-embedded`、`browser: webkit`（`605.1.15`）。runner 现在会启动 loopback-only
静态 `dist` server，并在 embedded session 创建后显式导航到该地址；因此此前 no-bundle binary
缺少 `tauri://localhost/index.html` 的 asset blocker 已解决。最新证据
`/tmp/nyala-agent-native-fixed.EVQdhI/workbench-evidence-3.json` 已加载真实 Workbench 和
`SQL Agent` Panel，并生成
`/tmp/nyala-agent-native-fixed.EVQdhI/screenshots-3/sql-agent-macos-desktop.png`。该证据的
`frontendSource.kind` 是 `local-dist-server`，所以它证明的是嵌入式 WebView 中的 Workbench DOM
和视觉 surface，不等同于 Tauri asset protocol、IPC 或 Agent native execution 证据。

当前 artifact 仍为 `blocked`，原因是两个独立的可重复限制：macOS Retina 环境的
`devicePixelRatio: 2` 使 requested CSS viewport `1440x900` 对应 physical window rect
`2880x1800`，而当前 WebKit report 的 CSS `innerWidth/innerHeight` 为 `720x450`，所以
`requested-viewport` check 未通过；此外 `tauri-plugin-wdio-webdriver` 的 W3C `/actions` Tab
只派发 synthetic DOM `KeyboardEvent`，不会触发系统默认 focus traversal，记录的 tab order 重复为
`Agent prompt`，不能据此宣称真实键盘或 screen-reader 通过。runner 已把这两项写入
`devicePixelRatio`、`requestedCssViewport`、`requestedPhysicalRect`、`keyboardMode` 和
fail-closed checks，后续需要修正窗口/CSS viewport 证据并取得原生键盘输入证据。

Windows WebView2 原生运行尚未在本机完成；真实 VoiceOver/Narrator walkthrough 仍必须由人在
对应系统执行，自动化 ARIA/Tab 检查不能替代 screen-reader 证据。

## 未完成门禁

A4.2 的 Schema/Result/Fix action contract、静态 screen-reader semantics contract 与 Chromium
desktop/narrow/ARIA 检查已完成；embedded native runner 已解决静态资源加载并验证 macOS
WKWebView 的 Workbench/Agent Panel surface，但 viewport/DPR 和真实键盘证据仍为 `blocked`。
Windows WebView2、真实 VoiceOver/Narrator walkthrough 和 Checkpoint W 尚未完成。Zeus Z1 仍只能
并行做 non-production spike；Z2 必须等待 A4 Checkpoint W 与 Z1 Go decision。
