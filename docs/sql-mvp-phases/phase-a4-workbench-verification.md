# A4 Workbench Verification

日期：2026-08-16
范围：A4.1 editor/error draft artifacts 与 A4.2 Agent Panel、Schema/Result/Fix actions。

## 已交付

- `SqlAgentArtifact` 是 transient proposal，绑定 `runId`、`editorId`、base document version
  和 exact base SQL；应用前通过三项一致性检查，stale editor 不会被覆盖。
- 既有 Generate/Optimize 草稿动作要求用户选择 Apply/Open/Cancel；Apply 失败时保留用户当前
  内容并显示 stale warning，未改变原有 SQL execution 或 provider contract。
- `SqlAgentView` 注册到 Workbench Panel，通过 `ISqlAgentService` 启动/取消 Agent run，展示
  state、usage、answer、error 和 evidence refs；面板关闭只释放 listener，不隐式取消 run。
- `SQL AI: Generate from Schema` 只提交 opaque `connectionId` 与用户目标；Rust backend 绑定该连接后
  通过现有 SQL Core adapter 检索有界真实 metadata，依次形成 Schema/Analysis evidence，并且只在
  final SQL 与单条 ReadOnly `sql.parse` draft 完全一致时返回 diff。frontend schema 不再是信任边界。
  `SQL AI: Explain Result` 只发送列 shape、行数、耗时和截断标志，不发送 rows。
- `SqlAgentService` 保存最后一个 typed run event，动作打开 Panel 后仍能恢复 projection；Panel
  listener 和 DOM listeners 均由 ViewPane 生命周期释放。
- Workbench 的九种 `SqlAgentRunState` 与 Rust `AgentRunState` 保持可执行的一一对应，并投影为可读
  状态标签；terminal state 释放 run ownership，非 terminal state 保留 Cancel。若 run 已分配但
  `sql_agent_run` transport 失败，Panel 不再进入“Start 可见但 active run 残留”的假空闲状态。
- Panel projection 保留结构化 `toolCalls` 的 `callId/tool/contextRefs` 安全摘要、warnings、
  partial 和 query-call count；后端 tool arguments 不进入前端 contract，Panel 以独立的
  Activity/Warnings 列表展示这些状态。
- 标准 Tauri v2 没有 `withGlobalTauri` 时，service 通过官方 event API 订阅；全局 bridge 在
  WebView 关闭阶段失效时会回退到官方 API，并在 service dispose 后释放 late listener。
- Panel 没有直接 Tauri invoke、没有持久化 rows/secret，也没有成为 Rust authorization boundary。
- Agent Panel controls 在窄视口允许换行；420px 以下 task/mode 选择器独占一行，Start/Cancel
  保持可见并各占半行，避免操作区横向溢出。
- Result error surface 的 `Fix with Agent` 只发送 opaque connection id、失败 SQL、结构化错误和
  editor identity/version，不再从 renderer 读取或提交 schema。Rust 对 connected `FixError` 只授予
  `agent.tool`、`workspace.readSql` 与 `database.readMetadata`，renderer capability 仍只能 opt down。
  backend 使用现有 SQL Core adapter 执行严格的 `schema.search -> sql.parse -> final`；draft 必须是
  单条 ReadOnly，final SQL 必须与 parsed draft 完全一致，全程保持零 query call。缺失或空白
  connection id 会在 run allocation 前 fail closed，不会回落 generic gateway 消费 renderer schema。
- editor execution 的 `editorVersionId`、execution source 和 statement count 会穿过 Result live state
  与历史 snapshots。只有同 editor、同 connection、同 version、单语句 `Run All` 且 SQL 基线未变时
  才显示 Apply；selection/current statement/multi-statement/stale context 只能 Open in new query。
- 所有草稿 target 都在 prompt/provider await 前捕获，quick pick 返回后再次校验 active editor；
  historical snapshot 不会误用隐藏的 live result。Rust Model Gateway 边界会移除结构化错误的 legacy
  duplicate 和可选 detail，并脱敏 URL、host、credential、Bearer token 与 private key 文本。
- deterministic fix 只接受唯一 table/column 映射，复用 SQL lexer 排除字符串和注释中的表名；identifier
  replacement 同样跳过字符串、quoted identifier 和注释，无法安全判断时返回原 SQL。
- embedded capture 在每个 viewport 先检查 Agent Panel 的真实可见性；`sql.agent.openPanel` 是 toggle，
  因此 Panel 已显示时不会再次执行命令并在第二个 viewport 意外关闭它。
- Agent Panel 的 `Assistant + Read Only` request 只请求 metadata/execute-read/result-shape 与
  `agent.tool` 四项能力，并且不提交 schema、result shape 或 result handle；其他 Read Only task
  保持 explain-only。Rust backend 仍是 grant 与 tool authorization 边界。

## 自动化验证

| 命令                                               | 结果                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run test`                                    | exit 0；含 534 Rust passed / 2 ignored、265 Agent focused Rust tests 与全部 SQL/视觉脚本 suites                                                                                                                                                                                                                                                                           |
| `pnpm run test:sql-agent`                          | 265 Rust Agent tests + 2 canonical capability tests 通过；含真实 Demo Schema Fix、严格工具顺序、grant、预算、missing-connection 与 forged-schema deny                                                                                                                                                                                                                     |
| `pnpm run test:sql-services`                       | 111 tests 通过（含 editor identity/version normalization、request-time artifact target、stale async response 与 late listener dispose）                                                                                                                                                                                                                                   |
| `pnpm run test:sql-editor`                         | 77 tests 通过                                                                                                                                                                                                                                                                                                                                                             |
| `pnpm run test:sql-result`                         | 84 tests 通过（含 error context、execution provenance、batch/history snapshot 与 visible snapshot contract）                                                                                                                                                                                                                                                              |
| `pnpm run test:sql-advanced`                       | 97 tests 通过（含 visible Result snapshot、九种 Rust/Workbench run state、失败后 Cancel ownership、Agent Panel ARIA、窄布局与 Tauri event contract）                                                                                                                                                                                                                      |
| `pnpm run test:sql-agent-workbench-visual`         | 38/38 tests 通过（含 asset-protocol exact URL、bootstrap outcome/WebDriver envelope、manifest v2 surface/manual 分层、Panel toggle、manual-review TTY、viewport convergence、statusbar/notification overlay/Agent root containment、command rejection 与 PNG/DPR checks）                                                                                                 |
| `pnpm run test:github-workflows`                   | 1/1 test 通过；默认测试链要求 Formatting CI 使用 fixed-version actionlint 扫描全部 GitHub Actions workflow                                                                                                                                                                                                                                                                |
| `pnpm run test:sql-agent-checkpoint-w`             | 63/63 tests 通过（含 bootstrap success/failure contract、asset-protocol source/summary、legacy/forged URL 拒绝、完整 viewport transcript、statusbar/notification overlay/Agent root/control containment、PNG/DPR/pixel、GitHub run/artifact metadata 与 archive download URL 篡改拒绝、attestation v2、唯一逐 gate refs、workflow output 与 protected workflow contract） |
| `pnpm run test:sql-result-grid-attestation`        | 9/9 tests 通过（含 exact four-artifact identity、digest/retention/timestamp 与 protected Z1 workflow contract）；不改变 Z1.3 `NO-GO`                                                                                                                                                                                                                                      |
| `pnpm run test:sql-mvp-vnext-release`              | 35/35 tests 通过；schema v3 R0 从受认证 A4/Z1 artifacts 重算 A4 四份与 Z1 六份 raw input SHA-256，并要求 measurement contract v6 completion boundary、平衡 execution order/ordinal checks；仍为 `NO-GO`                                                                                                                                                                   |
| `pnpm run test:sql-result-grid-gate`               | 61/61 tests 通过（含 measurement contract v6 raw-record/summary、post-presentation boundary、平衡 execution plan/ordinal、`presentationOpportunities`、真实 scroll、viewport/DPR 截图绑定、唯一 run screenshot、路径 containment、trusted workflow provenance 与 bundle audit）；不改变 Z1.3 `NO-GO`                                                                      |
| `pnpm run lint` / `pnpm run build`                 | exit 0 / exit 0                                                                                                                                                                                                                                                                                                                                                           |
| `pnpm run rust:check` / `rust:clippy` / `rust:fmt` | exit 0 / exit 0 / exit 0                                                                                                                                                                                                                                                                                                                                                  |
| changed-files Prettier / `git diff --check`        | exit 0 / exit 0                                                                                                                                                                                                                                                                                                                                                           |
| `verify-sql-mvp-vnext-release.mjs`                 | 预期 exit 1；临时 schema v3 report 为 `NO-GO`，A4/Z1 evidence、Z1 10k×50 threshold 与 Z2 准入均未满足                                                                                                                                                                                                                                                                     |
| 隔离 Chromium 1.62.1 browser QA                    | desktop 1440x900、narrow 390x844、Panel ARIA/Tab checks 通过                                                                                                                                                                                                                                                                                                              |
| 真实 Workbench Chromium capture                    | desktop 1440x900、narrow 390x844；执行 `sql.agent.openPanel`，真实 `.sql-agent-view`、ARIA、idle state、Tab 顺序和 PNG pixel/hash checks 通过                                                                                                                                                                                                                             |

2026-09-17 计数复核：在 `882ba222` + 当前未提交 vNext 工作树上重跑 `pnpm run test`（exit 0），
Rust lib 534 passed / 2 ignored，`test:sql-agent` 265 Rust Agent tests + 2 canonical capability tests，
八个前端 SQL suite 合计 669 tests（services 111、domain 20、connections 171、editor 77、result 84、
history 29、product 80、advanced 97）；本表与下文 Panel contract 计数已按本次运行更新
（534、35/35、61/61、18/18 等）。
计数增长不改变 A4 判定，Checkpoint W 人工证据、Windows WebView2 与 VoiceOver/Narrator 门仍为 `NO-GO`。

2026-09-18 全链路复验：在 A4 archive-digest / case-guard 加固落地之后，于 `882ba222` + 当前未提交
vNext 工作树（65 条变更路径）上重跑完整链，逐项 exit 0。`pnpm run build` exit 0，bundle 总计
`13.09 MB`（JS `12.37 MB`、CSS `607.20 kB`、字体 `122.88 kB`）；`pnpm run rust:fmt` / `rust:check` /
`rust:clippy` 依次 exit 0；`pnpm run test` exit 0，Rust lib `534 passed / 2 ignored`、`test:sql-agent`
`265` Rust Agent tests + `2` canonical capability tests，其余 24 个 node/TS 套件合计 `973` tests、失败
`0`（release 8、github-workflows 1、seed-demo 7、grid benchmark 51、grid webdriver 13、zeus audit 3、
platform evidence 1、grid gate 61、grid attestation 9、grid visual 7、agent workbench visual 38、
checkpoint-w 63、vNext release 35、search 2、preferences 3、services 111、domain 20、connections 171、
editor 77、result 84、history 29、product 80、advanced 97）。本轮复验的对象是新增加固本身：attestation
workflow 的下载路径改为 archive URL + `sha256sum --check --strict` + 解压前 `unzip -Z1` zip-slip guard，
case guard 收紧为本仓库
`https://api.github.com/repos/"$GITHUB_REPOSITORY"/actions/artifacts/*/zip`（工作树 blob `f3dede0c`、
`64a62ce4`、`4a682cc9`），verifier 精确校验 `archive_download_url` 且 gate 层独立复核，
`test:sql-agent-checkpoint-w` 的 63/63 含对应的正反断言。该次全绿只证明回归面完好：Checkpoint W、
Z1.3 与 R0 判定均不变，仍为 `NO-GO`，Z2 继续禁止开始。

同日随后的格式化归一化：把工作树 65 条变更路径中所有 Prettier 可判定文件对齐到仓库基线
（`pnpm exec prettier --check --ignore-unknown <changed files>` exit 0；`.rs` 由 `pnpm run rust:fmt`
覆盖，同样 exit 0），改动集中在 4 个文件
（`docs/sql-mvp-phases/README.md`、`docs/sql-mvp-phases/phase-z1-ci-rerun-checklist.md`、
`scripts/benchmark-sql-result-grid.test.mjs`、`scripts/sql-result-grid-floor-headroom.mjs`），全部是
换行/括号与表格 padding 归一化，没有语义变更。归一化之后重跑 `pnpm run test` 仍是 exit 0 且计数不变
（24 个 node/TS 套件合计 973 tests、失败 0；Rust lib 534 passed / 2 ignored；Agent 265 passed），
`pnpm run lint` 也 exit 0。

全仓 `pnpm run format:check` 仍因 143 个既有未改动文件不符合当前 Prettier 基线而 exit 1；
本轮 asset-protocol 相关 9 个 JS 与 Markdown 文件的定向 Prettier check 均为 exit 0。

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
artifact。session 创建时允许短暂 `about:blank`，但 producer 不再 `POST /url` 到外置 frontend；它只在
实际页面到达 macOS `tauri://localhost` 或 Windows `https://tauri.localhost/`、Workbench ready 且
title 包含 `Nyala Studio` 后继续。该证据现在覆盖 binary 内嵌 frontend、原生 asset protocol 与启动
bootstrap IPC 路径；它仍不替代 Checkpoint R 的 Agent native Generate/Fix/Explore execution evidence。

本机 macOS 加固后试跑已识别到 `driverProvider: embedded`、`nativeWebView: true`、
`engine: wkwebview-embedded`、`browser: webkit`（`605.1.15`）。runner 为每次运行分配独立
loopback WebDriver，并用 256-bit nonce 在 asset document 稳定后验证 session 属于本次 binary；每个
viewport 开始前还会重验相同 exact URL，防止 capture 中途 redirect。manifest 记录实际观察到的
`frontendSource: { kind: "tauri-asset-protocol", url }`；`provenance.binarySha256` 绑定包含该 frontend
的 binary。workflow 明确保持 `pnpm run build -> tauri build --no-bundle -> capture` 顺序；这里的
`--no-bundle` 只跳过 installer packaging，不会跳过 `frontendDist` 嵌入。2026-08-15 的
`local-dist-server` artifact 现是 legacy characterization evidence，会被新版 verifier 拒绝。

Retina viewport/DPR blocker 已解决。desktop CSS viewport 精确收敛到 `1440x900`，PNG 为
`2880x1800`；narrow 精确收敛到 `390x844`，PNG 为 `780x1688`；两个 viewport 都通过
requested-viewport、PNG size/pixel diversity、Workbench/Panel bounds、ARIA 与 idle-state checks。
runner 还会等待 Workbench command Promise、拒绝异步 command error，并将 WebDriver app data
定向到每次运行的隔离目录。`sidex-extensions` 通过只在 debug WebDriver build 启用的 feature 复用
同一 override，默认 build 继续使用 `~/.sidex`；两条 resolver path 均有 focused tests。artifact 仍按
v2 约定记录 `automatedSurfaceStatus: ready` 与 `checkpointDecision: BLOCKED`，每个 viewport 仍把
`keyboard-tab-order` 与 `native-keyboard-evidence` 标记为 manual failure：`tauri-plugin-wdio-webdriver` 的 W3C `/actions`
Tab 只派发 synthetic DOM `KeyboardEvent`，不会触发系统默认 focus traversal，不能据此宣称真实
键盘或 screen-reader 通过。

2026-08-18 的 clean detached-HEAD 复跑还发现并修复了一个原生窄视口合同缺口。首次复跑绑定
`8c75600a727c7d6268e11a0fbb92e40f7c03a24d`，runner exit 0，但人工检查
`/tmp/nyala-agent-native-macos-20260818.q7vp27/screenshots/sql-agent-macos-narrow.png` 发现
`Start Agent`/`Cancel` 下缘被 Workbench statusbar 遮挡；旧合同只检查 `window.innerHeight`，因此误报
`ready`。该 artifact 现由加固后的 verifier 拒绝，因为缺少 `statusbar-bounds` 与 statusbar snapshot，
不能再作为正向 evidence。

修复后，空的 answer/evidence/activity/warnings projection 不再占用 Panel flex gap，390px 布局将 task
与 access mode 保持为两列，并把 statusbar rect 纳入 snapshot。producer 现在要求
`statusbar-bounds`，statusbar 与 Agent root 必须位于 viewport 内，Agent root 和每个 control 都不得与
statusbar 相交；trusted verifier 会独立重算同一关系并拒绝缺失几何。dirty-tree 本地回归产物位于
`/tmp/nyala-agent-native-macos-fixed-20260818.YZRu8C/`：binary SHA-256 为
`ac06d31063c5c8fa358d74a6dd74caa33a7fe5e9ff6a90cb75170b0377634d6c`，manifest 为
`4c46bdedede6d0409ccd383515be76f6c4ec59b483a457ff26649357e522d335`，desktop/narrow PNG 分别为
`5483146835e1f7c8296a2d4adc64091db39d1c24df03750ae5a1b63a02270f2c` 与
`26d4dacadbe8166f600912188173348863d5754ec0336366abfb360f792bb8f3`。desktop Agent root bottom
`847 < 878` statusbar top；narrow root bottom `817 < 822`，Start/Cancel bottom 为 `787`。独立 verifier
确认 `macos-automated-surface: passed`；该复跑刻意不写 source revision/ref/workflow provenance，故
`macos-native-identity` 仍失败，不能替代受保护 workflow artifact。

同日后续 bundle preflight 发现两条启动 warning toast 会覆盖 Agent controls，而旧 snapshot 完全不记录
notification overlay。共享 producer 现在从 Workbench 原生 toast 与 Notification Center 采集
`kind/severity/visible/rect`，刻意不采集可能包含本地路径、连接信息或错误细节的 message；
`notification-overlay-bounds` 要求字段与 viewport geometry 完整。所有 warning/error overlay 都参与
Agent root 与五个必需 controls 的相交检查；`no-visible-error-notifications` 还会在可见 error 未相交时
fail closed。trusted verifier 不信任 producer check，而是从 raw snapshot 独立验证枚举、可见性、矩形、
viewport、相交关系与 error severity。缺少 `notificationOverlays` 的旧 v2 artifact 现会被拒绝。

本地 macOS bundle 负向复跑写入
`/tmp/nyala-agent-toast-gate.HTatac/workbench-evidence.json` 并按预期 exit 1。desktop/narrow 均捕获
2 个 warning toast；desktop 有 5 个、narrow 有 6 个 automated surface checks 因遮挡失败，manifest
记录 `automatedSurfaceStatus: blocked` 与 `checkpointDecision: BLOCKED`。runner 没有等待通知自然消失，
也没有自动 dismiss 真实启动错误。该 artifact 没有受保护 workflow provenance，只证明新合同会拒绝
被 notification 遮挡的 surface，不完成 Checkpoint W。

差分复现随后用完全隔离的 app-data 分别启动同一 binary：asset protocol 与当前 loopback `dist` 都能
正常完成 Demo bootstrap，说明“loopback origin 必然破坏 IPC”是假设不成立。负向 artifact 的 binary
SHA-256 与当前重放相同，但它生成于 08:06，`dist/index.html` 在 08:09 重建；重建后同一 loopback
runner 变为 `ready`。由于失败时的旧 `dist` bytes 没有被 hash 保留，不能恢复更细的字节级根因，但已
足以确认外置 frontend 与 binary 是未绑定的双产物风险。native producer 因此改用 binary asset protocol，
不再依赖或接受 `--frontend-dist`，trusted verifier 独立校验 kind 与平台 exact URL，并在 aggregate
summary 保留 `frontendSource`；旧 loopback v2 artifact 会 fail closed。

按 CI 构建顺序重建后的本地证据位于 `/tmp/nyala-agent-asset-protocol-rebuilt/`。webdriver binary
SHA-256 为 `16a628f2b2f18a7c4519bbdd2260af3d729228d5f23bc36ca189be22b2f6a207`，manifest 为
`c4de1e145d06fd1f925a1baf7dcd19528601029971e4bc3d41ca51dd1d450475`，desktop/narrow PNG 分别为
`cfe3c886653e88e089dac022e3e2ac6273cefe7a96242ce9f0151e542c6340e9` 与
`be749f8d2caa8b276efeefad6139c4edb939657009f58b08a88965754177ce10`。capture exit 0，两个 viewport
均为 `automatedSurfaceStatus: ready`、零 failed check、零 notification overlay；独立 verifier 确认
`macos-automated-surface: passed`。总 gate 仍按预期 exit 1/`NO-GO`：本地 artifact 刻意没有伪造
repository/revision/workflow provenance，且 Windows、真实键盘和 screen-reader evidence 仍缺失。

同日 bootstrap readiness 加固将 Workbench 启动序列收敛为版本化 outcome：隐藏命令
`sqlStudio.product.awaitBootstrap` 等待 Demo bootstrap、Connections/Results/Welcome 布局与新查询命令
全部 settle；producer 与 trusted verifier 只接受合法的 `version/status/mode/completedCommands` 组合，
failed/disposed outcome 不携带原始错误文本。native 复现最初误报 await timeout，根因不是 Tauri IPC 或
startup contribution，而是 capture helper 用 `{ status: 'fulfilled', value }` 保存页面状态时与 WebDriver
响应的 `value` envelope 冲突，Node 端丢失了外层 `fulfilled`。内部载荷字段改为 `result`，并新增真实
WebDriver envelope 形状的回归测试。修复后的 `/tmp/nyala-agent-bootstrap-fixed/` capture exit 0；binary
SHA-256 为 `c861019520ec02153067ec4ab90af9f51bdf2483f61ab362410e93ecea1160b4`，manifest 为
`027da1ba9aa785637a5a12bbbd51f8441d3ab99c1ca89b7533731843a8ca969d`。outcome 为
`succeeded/onboarding`，完整记录 `bootstrapDemo -> focusConnections -> openResults -> focusWelcome -> newQuery`；
desktop/narrow 仍为 `ready`、零 notification overlay，独立 verifier 再次确认
`macos-automated-surface: passed`。该本地重放没有受保护 workflow provenance，也不提供 Windows 或
人工签收，因此不改变 Checkpoint W/R0 `NO-GO`。

同日又以当前 dirty worktree 重建 WebDriver `.app`，binary SHA-256 为
`2a6fce40a9f15e1de6fab555299fe53cd853e40a895fc4a919e9408bb5f80a67`，通过 macOS accessibility API
读取真实 WKWebView tree 并派发系统级 Tab/Return 做非准入诊断。Agent surface 暴露 prompt、task、
access mode、Start/Cancel 与 live run status；焦点顺序实测为
`Agent prompt -> Agent task -> Agent access mode -> Start Agent run`，下一次 Tab 能离开 Panel，未发现
focus trap。Return 可以从 Start 启动 Suggest-only 与 Read-only Explore，完成态分别暴露
`Completed`、model/tool/result-row counters 和四项 typed activity。由于 deterministic run 在观察窗口内
已经结束，本次没有验证 active-run Cancel；系统级输入也不等于物理键盘或 VoiceOver 人工走查。
诊断结束前已恢复 Demo SQL 与 Suggest-only mode。该记录不带 protected revision/workflow provenance，
不能进入 Checkpoint W attestation，也不改变 `NO-GO`。

Windows WebView2 原生运行尚未在本机完成；真实 VoiceOver/Narrator walkthrough 仍必须由人在
对应系统执行，自动化 ARIA/Tab 检查不能替代 screen-reader 证据。

## Checkpoint W native evidence v2 / attestation v2 / gate v2

2026-08-16 新增版本化、fail-closed 的 Checkpoint W 证据链：

- embedded runner 的 manifest 升级到 v2，分别记录 `automatedSurfaceStatus` 与始终为
  `BLOCKED` 的 `checkpointDecision`。synthetic Tab characterization 不再把已经通过的 WebView、
  viewport、ARIA 和截图 surface 误报为采集失败，但也不能被计作原生键盘证据。
- manifest 绑定 repository、Git SHA、ref、workflow run/attempt、binary SHA-256、WebDriver nonce、
  engine identity、exact asset-protocol frontend source、statusbar geometry 与截图 SHA-256。statusbar、
  Agent root、controls 的 viewport containment 与相交关系均须通过；macOS/Windows、desktop/narrow
  或任一非人工检查缺失都会拒绝。
- [`verify-sql-agent-checkpoint-w.mjs`](../../scripts/verify-sql-agent-checkpoint-w.mjs) 只允许
  `keyboard-tab-order` 与 `native-keyboard-evidence` 两项转由人工签收；其他 failed/unknown/manual
  check 均为 `NO-GO`。verifier 不信任 producer 的截图与 control check 布尔值：它会重新读取 PNG，
  复核 SHA-256、viewport × DPR、pixel diversity，从 calibration attempts 重算 window rect 收敛链，
  再把 final observation、snapshot viewport/DPR 与 PNG 绑定，并从 snapshot 重算 Start enabled、
  Cancel disabled、Agent root/control containment 与 statusbar 不相交；它还独立拒绝 loopback、跨平台、
  非根路径、query/hash 与 canonicalized asset URL 变体，不能只信任 producer 的 `kind`。
- [`create-sql-agent-checkpoint-w-attestation.mjs`](../../scripts/create-sql-agent-checkpoint-w-attestation.mjs)
  将 workflow dispatch 的四项显式确认映射为 macOS keyboard、VoiceOver、Windows keyboard 与
  Narrator attestation v2。每项必须绑定独立、安全的 credential-free `https://` 或 `qa://` evidence
  ref；规范化后重复的 ref、query/fragment、URL credential 或缺失字段都会拒绝。capture provenance
  与后续 attestation workflow run/attempt/URL 分别记录，且后者 run ID 必须更晚，不能预先签收尚未
  生成的 artifact。
- [`verify-sql-agent-capture-run.mjs`](../../scripts/verify-sql-agent-capture-run.mjs) 消费 GitHub Actions
  run/artifact API 响应，只接受 `.github/workflows/sql-agent-native.yml` 的成功
  `workflow_dispatch`、匹配的 repository/head SHA/run attempt，以及恰好两个未过期、带 SHA-256
  digest 的 macOS/Windows artifacts。Checkpoint W gate v2 将该 metadata、双平台 manifest 和人工
  attestation 的输入 SHA-256 一并写入结构化 report。
- [`sql-agent-native.yml`](../../.github/workflows/sql-agent-native.yml) 只负责在同一 capture run 生成并
  上传 macOS/Windows artifact；[`sql-agent-checkpoint-w-attest.yml`](../../.github/workflows/sql-agent-checkpoint-w-attest.yml)
  只允许 protected default branch，并使用 `sql-agent-checkpoint-w` environment。它先用当前 attestation
  workflow checkout 中的 trusted verifier 查询 GitHub API，取得每个 artifact 的 API archive URL 与
  GitHub SHA-256 digest；随后不再走 `actions/download-artifact`，而是用 `curl` 按该 URL 下载 archive、
  以 `sha256sum --check --strict` 核对 digest，并在解压前用 `unzip -Z1` 加 zip-slip guard（拒绝绝对路径、
  盘符、反斜杠与 `..`）检查全部条目，最后要求解压结果中的 `workbench-evidence.json` 存在且不是 symlink。
  verifier 同时独立复核 archive URL 必须精确等于
  `https://api.github.com/repos/<repo>/actions/artifacts/<id>/zip`，因此被改写或指向其他 artifact 的下载
  地址会在 gate 层直接失败。它不会 checkout 或执行 capture artifact 自报 revision 中的 verifier。capture revision/ref 必须等于
  受保护 attestation revision/ref，attestation run `created_at` 必须晚于 capture completion；artifact
  必须未过期、带 GitHub SHA-256 digest 且时序有效。随后 metadata 与 manifest 交叉绑定，再生成
  attestation、执行结构化 gate，并在 `NO-GO` 时上传 aggregate artifact 与 job summary 后失败。R0
  verifier 消费
  [`phase-a4-checkpoint-w.json`](./phase-a4-checkpoint-w.json)，不再通过修改本文件措辞绕过门禁。

历史 Agent runs `31706678471` / `31607138267` 与 Z1 platform runs `31706679626` /
`31607139340` 都在 workflow 配置解析阶段失败，实际为 0 jobs、0 artifacts；`actionlint` 对对应
revision 精确报告 4 处 job-level `env` 非法使用 `${{ runner.temp }}`。Agent 与 Zeus 双平台 workflow
已改为在 step 中从 `RUNNER_TEMP` 初始化并写入 `GITHUB_ENV`。Formatting CI 现新增 pinned
`actions/setup-go@v7.0.0` / Go `1.25.3` / actionlint `v1.7.12` job，默认 `pnpm run test` 也纳入
`test:github-workflows` 配置合同；当前工作树全部 workflow 经 actionlint exit 0。
这只修复 workflow 可启动性并防止同类回归，不提供缺失的原生证据，也不改变 Zeus Z1 性能
`NO-GO`。

Checkpoint W 的真实签收步骤保持如下（逐步命令、失败模式与 R0 输入见
[Checkpoint W 原生证据与签收操作手册](./phase-a4-checkpoint-w-runbook.md)）：

1. 对目标 revision 触发 `SQL Agent Native Workbench Capture`，取得同一 run 的 macOS WKWebView 与
   Windows WebView2 v2 artifacts。
2. 用物理/系统键盘确认 `Agent prompt -> Agent task -> Agent access mode -> Start Agent run`、
   Start/Cancel 可达且无 focus trap。
3. 分别使用 VoiceOver 与 Narrator 确认 labels、run state changes 和 focus loop，并保留 evidence refs。
4. 完成检查后触发 `SQL Agent Checkpoint W Attestation`，填写 capture run ID、四项确认和四个逐项
   evidence refs；只有 capture/review provenance、双平台 surface 与全部人工签收同时匹配时 gate
   才能输出 `GO`。

当前 checked-in report 仍为 `NO-GO`：远端 v2 双平台 artifact 与四项真实人工签收尚未取得。

R0 的结构化 verifier prework 已实现。受保护的 `SQL MVP vNext Release Evidence` workflow 使用
`sql-mvp-vnext-release` environment，精确验证 A4/Z1 attestation run/artifact API metadata，通过 GitHub
artifact API URL 下载并核对 ZIP SHA-256 与安全路径，只把认证后的 raw evidence 交给 schema v3 R0。
R0 会重算 Checkpoint W 四份输入与 Z1 六份输入 digest，校验唯一人工 refs、provenance、measurement
contract v6、平衡 execution order/ordinal、revision/ref 绑定与 Zeus import boundary，并拒绝完整手写的
`GO` evidence。当前
[`phase-vnext-release-gate.json`](./phase-vnext-release-gate.json) 仍为 `NO-GO`，不代表 vNext 已发布。

2026-08-17 GitHub API 审计确认默认分支 `mvp` 已启用 strict branch protection，required checks 为
`Lint, build, and test`、`Prettier`、`rustfmt` 与 `taplo`。2026-09-17 复核：Checkpoint W/Z1/R0 三个
attestation workflow 已发布到远端 `mvp` 且 active（runs 均为 0），与本地 HEAD `882ba222` 的 blob SHA
一致（`sql-agent-checkpoint-w-attest.yml` 为 `edcd32b5`）。但工作树里的 A4 加固仍未合入 `mvp`：
`scripts/verify-sql-agent-checkpoint-w.mjs`（`mvp` `2c7248b2` → 工作树 `4a682cc9`）、
`scripts/verify-sql-agent-capture-run.mjs`（`mvp` `00ef9a31` → 工作树 `64a62ce4`）与
`.github/workflows/sql-agent-checkpoint-w-attest.yml`（`mvp` `edcd32b5` → 工作树 `455d8e8e`，
archive URL + digest 校验下载路径；2026-09-18 又把 case guard 从仓库通配收紧为
`https://api.github.com/repos/"$GITHUB_REPOSITORY"/actions/artifacts/*/zip`，当前工作树 blob 为
`f3dede0c`）。受保护分支上的捕获/验证脚本与下载路径因此落后于本地；本地加固
不生成缺失证据、不改变 `NO-GO`，把这些修复合入 `mvp` 仍是准入前置。

**2026-09-18 更正**：仓库 environment 列表为空不构成阻塞——GitHub 文档写明 _"Running a workflow that
references an environment that does not exist will create an environment with the referenced name …
Otherwise, the newly created environment will not have any protection rules or secrets configured."_
（[Managing environments for
deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)，
2026-09-18 取得），而 `sql-agent-checkpoint-w` 只使用 `secrets.GITHUB_TOKEN`；人工预建它只是可选的
required-reviewers 纵深保护。在本地修复合入 `mvp`、真实原生证据（含人工键盘与 VoiceOver/Narrator
走查）齐备前，Checkpoint W、Z1.3、R0 仍为 `NO-GO`，Z2 禁止开始。

2026-08-15 的 backend-grounded Fix 纵切在真实 Demo SQLite 上将
`SELECT amunt FROM orders` 修复为 `SELECT amount FROM orders`，只产生 Schema 与 Analysis evidence，
工具序列严格为 `schema.search -> sql.parse` 且 `queryCallCount = 0`。自动化同时覆盖 renderer forged
schema 清除、capability opt-down、metadata budget 原子失败、write/multi-statement、提前/替换 final
和额外/重排工具的 fail-closed 行为。旧的 frontend schema loader 及其孤立测试已删除；共享
`AgentModelContext.schema` 仍由 backend tool result 填充，不改变 wire compatibility。

Agent Panel contract suite 当前为 18/18 通过，并覆盖九种 Rust/Workbench state 对齐、可读状态投影、
terminal/non-terminal ownership、background execution rejection 后 Cancel 可达、Read-only Assistant
精确 capability 集合、非 Assistant explain-only 分支，以及 frontend 不提供 Explore schema/result handle。该证据与
真实 Demo SQLite bridge test 一起证明自动化 Explore 请求可以从 Workbench contract 到 Rust loop，
原生 Nyala 的 Generate/Fix/Explore 三故事也已完成并记录于
[`Checkpoint R Verification`](./phase-agent-checkpoint-r-explore-verification.md)，因此 Checkpoint R 已签收。

## 未完成门禁

A4.2 的 Schema/Result/Fix action contract（含 backend-grounded Fix）、静态 screen-reader semantics contract 与 Chromium
desktop/narrow/ARIA 检查已完成；embedded native runner 已解决静态资源加载并验证 macOS
WKWebView 的 Workbench/Agent Panel surface，viewport/DPR 已通过，真实键盘证据仍为 `blocked`。
Windows WebView2、真实 macOS/Windows keyboard、VoiceOver/Narrator walkthrough 和 Checkpoint W
尚未完成；结构化 gate 只记录并强制这些缺口。Zeus Z1.3 同样为 `NO-GO`：v6 平衡调度下
`1k-x-20` 回归 `1.7%`，已通过“不超过 10%”门槛；`10k-x-50` 只改善 `1.0%`，未达到至少
`20%` 的门槛，并且尚缺当前 revision 绑定的 macOS WKWebView、Windows WebView2 原始
benchmark/截图证据与 fresh Zeus dependency/bundle audit。现状仍只是
non-production spike，没有 Zeus production dependency 或 renderer integration。A4 Checkpoint W 与
Z1 都记录 `GO` 之前，Z2 禁止开始；因此 R0 release gate 也必须保持 `NO-GO`。
