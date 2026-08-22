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

| 命令                                               | 结果                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run test`                                    | exit 0；含 453 Rust passed / 2 ignored、199 Agent focused Rust tests 与全部 SQL/视觉脚本 suites                                                                                                                                                                                                      |
| `pnpm run test:sql-agent`                          | 199 Rust Agent tests + 2 canonical capability tests 通过；含真实 Demo Schema Fix、严格工具顺序、grant、预算、missing-connection 与 forged-schema deny                                                                                                                                                |
| `pnpm run test:sql-services`                       | 103 tests 通过（含 editor identity/version normalization、request-time artifact target、stale async response 与 late listener dispose）                                                                                                                                                              |
| `pnpm run test:sql-editor`                         | 77 tests 通过                                                                                                                                                                                                                                                                                        |
| `pnpm run test:sql-result`                         | 84 tests 通过（含 error context、execution provenance、batch/history snapshot 与 visible snapshot contract）                                                                                                                                                                                         |
| `pnpm run test:sql-advanced`                       | 92 tests 通过（含 visible Result snapshot、九种 Rust/Workbench run state、失败后 Cancel ownership、Agent Panel ARIA 与 Tauri event contract）                                                                                                                                                        |
| `pnpm run test:sql-agent-workbench-visual`         | 19 tests 通过（含 manifest v2 surface/manual 分层、Panel toggle、ownership、viewport convergence、command rejection 与 PNG/DPR checks）                                                                                                                                                              |
| `pnpm run test:github-workflows`                   | 1/1 test 通过；默认测试链要求 Formatting CI 使用 fixed-version actionlint 扫描全部 GitHub Actions workflow                                                                                                                                                                                           |
| `pnpm run test:sql-agent-checkpoint-w`             | 44/44 tests 通过（含完整 viewport transcript、PNG/DPR/pixel、GitHub run/artifact metadata、attestation v2、唯一逐 gate refs 与 protected workflow contract）                                                                                                                                         |
| `pnpm run test:sql-result-grid-attestation`        | 9/9 tests 通过（含 exact four-artifact identity、digest/retention/timestamp 与 protected Z1 workflow contract）；不改变 Z1.3 `NO-GO`                                                                                                                                                                 |
| `pnpm run test:sql-mvp-vnext-release`              | 30/30 tests 通过；schema v3 R0 从受认证 A4/Z1 artifacts 重算 A4 四份与 Z1 六份 raw input SHA-256，并要求 measurement contract v6 completion boundary、平衡 execution order/ordinal checks；仍为 `NO-GO`                                                                                              |
| `pnpm run test:sql-result-grid-gate`               | 51/51 tests 通过（含 measurement contract v6 raw-record/summary、post-presentation boundary、平衡 execution plan/ordinal、`presentationOpportunities`、真实 scroll、viewport/DPR 截图绑定、唯一 run screenshot、路径 containment、trusted workflow provenance 与 bundle audit）；不改变 Z1.3 `NO-GO` |
| `pnpm run lint` / `pnpm run build`                 | exit 0 / exit 0                                                                                                                                                                                                                                                                                      |
| `pnpm run rust:check` / `rust:clippy` / `rust:fmt` | exit 0 / exit 0 / exit 0                                                                                                                                                                                                                                                                             |
| changed-files Prettier / `git diff --check`        | exit 0 / exit 0                                                                                                                                                                                                                                                                                      |
| 隔离 Chromium 1.62.1 browser QA                    | desktop 1440x900、narrow 390x844、Panel ARIA/Tab checks 通过                                                                                                                                                                                                                                         |
| 真实 Workbench Chromium capture                    | desktop 1440x900、narrow 390x844；执行 `sql.agent.openPanel`，真实 `.sql-agent-view`、ARIA、idle state、Tab 顺序和 PNG pixel/hash checks 通过                                                                                                                                                        |

全仓 `pnpm run format:check` 仍因 144 个既有未改动文件不符合当前 Prettier 基线而 exit 1；
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

本机 macOS 加固后试跑已识别到 `driverProvider: embedded`、`nativeWebView: true`、
`engine: wkwebview-embedded`、`browser: webkit`（`605.1.15`）。runner 为每次运行分配独立
loopback WebDriver 与静态 `dist` 端口，并用 256-bit nonce 在 page load 后验证 session 属于本次
binary；重建后的最新证据
`/tmp/nyala-agent-native-isolated-20260815/workbench-evidence.json` 记录动态 driver
`127.0.0.1:58763`、`portSource: os-assigned`、`runNonceVerified: true`。该证据的
`frontendSource.kind` 是 `local-dist-server`，所以它证明的是嵌入式 WebView 中的 Workbench DOM
和视觉 surface，不等同于 Tauri asset protocol、IPC 或 Agent native execution 证据。

Retina viewport/DPR blocker 已解决。desktop CSS viewport 精确收敛到 `1440x900`，PNG 为
`2880x1800`；narrow 精确收敛到 `390x844`，PNG 为 `780x1688`；两个 viewport 都通过
requested-viewport、PNG size/pixel diversity、Workbench/Panel bounds、ARIA 与 idle-state checks。
runner 还会等待 Workbench command Promise、拒绝异步 command error，并将 WebDriver app data
定向到每次运行的隔离目录。`sidex-extensions` 通过只在 debug WebDriver build 启用的 feature 复用
同一 override，默认 build 继续使用 `~/.sidex`；两条 resolver path 均有 focused tests。artifact 仍按
预期为 `blocked`，唯一失败项是每个 viewport 的
`keyboard-tab-order` 与 `native-keyboard-evidence`：`tauri-plugin-wdio-webdriver` 的 W3C `/actions`
Tab 只派发 synthetic DOM `KeyboardEvent`，不会触发系统默认 focus traversal，不能据此宣称真实
键盘或 screen-reader 通过。

Windows WebView2 原生运行尚未在本机完成；真实 VoiceOver/Narrator walkthrough 仍必须由人在
对应系统执行，自动化 ARIA/Tab 检查不能替代 screen-reader 证据。

## Checkpoint W native evidence v2 / attestation v2 / gate v2

2026-08-16 新增版本化、fail-closed 的 Checkpoint W 证据链：

- embedded runner 的 manifest 升级到 v2，分别记录 `automatedSurfaceStatus` 与始终为
  `BLOCKED` 的 `checkpointDecision`。synthetic Tab characterization 不再把已经通过的 WebView、
  viewport、ARIA 和截图 surface 误报为采集失败，但也不能被计作原生键盘证据。
- manifest 绑定 repository、Git SHA、ref、workflow run/attempt、binary SHA-256、WebDriver nonce、
  engine identity 与截图 SHA-256。macOS/Windows、desktop/narrow 或任一非人工检查缺失都会拒绝。
- [`verify-sql-agent-checkpoint-w.mjs`](../../scripts/verify-sql-agent-checkpoint-w.mjs) 只允许
  `keyboard-tab-order` 与 `native-keyboard-evidence` 两项转由人工签收；其他 failed/unknown/manual
  check 均为 `NO-GO`。verifier 不信任 producer 的截图与 control check 布尔值：它会重新读取 PNG，
  复核 SHA-256、viewport × DPR、pixel diversity，从 calibration attempts 重算 window rect 收敛链，
  再把 final observation、snapshot viewport/DPR 与 PNG 绑定，并从 snapshot 重算 Start enabled 与
  Cancel disabled。
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
  workflow checkout 中的 trusted verifier 查询 GitHub API，再按 exact artifact IDs 下载两份 evidence；
  它不会 checkout 或执行 capture artifact 自报 revision 中的 verifier。capture revision/ref 必须等于
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

Checkpoint W 的真实签收步骤保持如下：

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
`Lint, build, and test`、`Prettier`、`rustfmt` 与 `taplo`；但仓库 environment 列表仍为空，本地新增的
Checkpoint W/Z1/R0 attestation workflow 也尚未出现在远端 workflow 列表。管理员仍需创建
`sql-agent-checkpoint-w`、`sql-result-grid-z1-gate`、`sql-mvp-vnext-release` 三个 environment 并启用
required reviewers，在发布 workflow 后把 `actionlint` 纳入 required checks。workflow 代码不能创建
这些策略；完成发布、配置和真实原生证据前，Checkpoint W、Z1.3、R0 仍为 `NO-GO`，Z2 禁止开始。

2026-08-15 的 backend-grounded Fix 纵切在真实 Demo SQLite 上将
`SELECT amunt FROM orders` 修复为 `SELECT amount FROM orders`，只产生 Schema 与 Analysis evidence，
工具序列严格为 `schema.search -> sql.parse` 且 `queryCallCount = 0`。自动化同时覆盖 renderer forged
schema 清除、capability opt-down、metadata budget 原子失败、write/multi-statement、提前/替换 final
和额外/重排工具的 fail-closed 行为。旧的 frontend schema loader 及其孤立测试已删除；共享
`AgentModelContext.schema` 仍由 backend tool result 填充，不改变 wire compatibility。

Agent Panel contract suite 当前为 16/16 通过，并覆盖九种 Rust/Workbench state 对齐、可读状态投影、
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
