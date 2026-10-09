# Z1 证据工作流重跑清单

- Status: 操作手册（不构成 gate 结论，也不改变 `Z1.3 = NO-GO`、`Z2 = 禁止开始`、`R0 = NO-GO`）
- Date: 2026-09-17
- Related: [Z1 spike 验证记录](./phase-z1-spike-verification.md)、[ADR 0004 v7 floor-aware metrics](../adr/0004-zeus-data-grid-v7-floor-aware-metrics.md)、[性能整改报告](../reviews/2026-08-18-zeus-data-grid-performance-remediation.md)、[`sql-result-grid-platform.yml`](../../.github/workflows/sql-result-grid-platform.yml)、[`sql-result-grid-gate-attest.yml`](../../.github/workflows/sql-result-grid-gate-attest.yml)

本文只回答一个问题：**要把 Z1 的跨平台证据重新变成可下载、可复算、可绑定的证据，需要按什么顺序做什么。**

2026-10-09 更新：Zeus core `0.1.1-beta.3` 与 zeus-ui `0.1.0-beta.5` 已发布并完成 registry 核验。Nyala 已将 platform workflow 和审计契约更新到 data-grid beta.5；beta.5 的实际 peer/dependency 闭包仍是 Zeus core beta.2，因此本次发布不会被记录为 core beta.3 已接入。新的双 WebView 证据尚未采集，Z1.3 仍为 `NO-GO`。
它不是新的验收报告，也不能把任何失败门改写成通过。

## 0. 需要授权的三项（当前只阻塞在这里）

本地可自动完成的分析、工具与复验都已做完（floor 分解、未发布工作树审计、脚本 suites 全绿）；
Z1.3 不会因为再跑一次本地诊断而改变结论。要往前推进，需要以下三项被授权：

| #   | 决策                                                             | 授权后能做什么                                                                             | 不授权的后果                                                        |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 1   | ADR 0004 由 `Proposed` 改为 `Accepted`                           | 允许构建 v7 schema/verifier 并按预注册采样，Z1 才有合法翻 `GO` 的通道（路径 B）            | v6 的 20% 门在地板上不可辨识，Z1.3 永远停在 `NO-GO`，Z2/R0 不可开始 |
| 2   | zeus-ui beta.5 发布（已完成）；后续 core beta.3 闭包仍待上游发布 | beta.5 已包含 split timing / `measureNodeChurn`；其实际 peer/dependency 仍指向 core beta.2 | 在 core beta.3 闭包发布前，不能声称 Nyala 已消费 core beta.3        |
| 3   | 把本地修复经 PR 合入受保护 `mvp`（commit/push）                  | A4 捕获与 Z1/A4/R0 attestation 才跑在修复后的 driver/verifier 上                           | 受保护分支仍是旧脚本，attestation 结构上跑不出 `GO`                 |

注：第 2 项要求先提交 zeus-ui 那 4 个文件并合入 `main`（`release.yml` 只允许从 `main` dispatch）；
第 3 项需要人工授权后执行（本会话约束为不 commit/push），`mvp` 的 required checks 为
`Lint, build, and test` / `Prettier` / `rustfmt` / `taplo`、`strict = true`、required approvals `0`。
A4 Checkpoint W 还额外需要原生键盘、Windows WebView2、真实 VoiceOver/Narrator 四份人工 walkthrough，
属人工环境工作。

### 0.1 已撤销的第四项：预建 GitHub environment

旧版清单把「创建 3 个 GitHub environment」列为阻塞项，**这是错的**。GitHub 文档原文：
_"Running a workflow that references an environment that does not exist will create an environment
with the referenced name … Otherwise, the newly created environment will not have any protection
rules or secrets configured."_（[Managing environments for
deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)，
2026-09-18 取得）。三个 attestation workflow 只使用 `secrets.GITHUB_TOKEN`，不使用 environment
secret，因此首次 dispatch 会自动创建同名 environment 并正常执行。人工在 Settings → Environments
预建它们的唯一价值是附加 **required reviewers / branch 限制** 这一层纵深保护（自动创建的环境不带任何
protection rule）——属于可选加固，不阻塞任何路径。

## 1. 当前事实（2026-09-17 核查）

| 事实                                                                                                                                                                                                                        | 证据来源                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 默认分支是 `mvp`（不是 `main`），且被保护；required checks 为 `Lint, build, and test` / `Prettier` / `rustfmt` / `taplo`，`strict = true`，required approvals `0`，禁止 force push                                          | `gh api repos/baicie/nyala-studio/branches/mvp`、`.../branches/mvp/protection`、`.../rules/branches/mvp`                           |
| `origin/mvp`（`3c97f73a`）已包含 `sql-result-grid-platform.yml`，且与本地（修复后）文件逐字节相同；但**缺少**最后三个提交 `737de61c` / `b900750c` / `9d68c91d`，即 native webdriver 启动、viewport 校准与 evidence 对齐修复 | `git diff origin/mvp -- .github/workflows/` 为空；`git log --oneline origin/mvp..9d68c91d`                                         |
| 最后一次平台 run `32706467306`：`head_branch = codex/feat-sql-agent-schema-adapter`、`head_sha = 9d68c91d`、attempt `1`、2026-08-24；prepare / macOS / Windows 三个 job 成功，aggregate 按设计在 Z1 verifier 处 exit 1      | `gh run view 32706467306 --json ...`、job `97372057070` 日志末行 `NO-GO: .../phase-z1-gate.json`                                   |
| 该 run 的 4 个 artifacts 全部 `expired: true`（audit 7 天、其余 14 天）→ **当前没有任何可下载复核的 revision-bound 证据**                                                                                                   | `gh api repos/baicie/nyala-studio/actions/runs/32706467306/artifacts`                                                              |
| GitHub environments `total_count = 0`；按 §0.1 这**不阻塞**，首次 dispatch 会自动创建同名 environment                                                                                                                       | `gh api repos/baicie/nyala-studio/environments`、`gh api .../actions/workflows/<id>/runs`（runs 均为 0）                           |
| Nyala 已 pin `@zeus-web/data-grid@0.1.0-beta.5`；其 npm `beta` 已指向 beta.5，但发布包仍 exact 依赖/peer Zeus core beta.2；新平台证据尚未产生                                                                               | `pnpm view @zeus-web/data-grid@0.1.0-beta.5 ...`、workflow 第 70-71 行、`docs/reviews/2026-10-09-zeus-beta-release-integration.md` |
| zeus-ui `v0.1.0-beta.5` 已发布，tag/main 为 `52baa1e18ca11671de48bd24c7b1983b7413a516`；npm provenance/signatures 与 36 包发布校验通过                                                                                      | zeus-ui CI/Release/Publish runs、npm tarball/integrity 核验                                                                        |

结论：Z1 的问题不是「缺一个 workflow」，而是两件事叠加——**证据过期**，以及**预先注册的 v6 阈值在 1/60s 地板上不可辨识**。两者分别对应下面的路径 A 与路径 B。

## 2. 选路径

| 路径 | 前置                             | 目的                                                                    | 预期结果                                                            |
| ---- | -------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| A    | 无（只 dispatch，不改仓库）      | 让 v6 的 5 个失败门重新拥有未过期、可下载、绑定 revision 的证据         | 仍 `NO-GO`；失败原因与 2026-08-24 同类，具体条目以新 gate JSON 为准 |
| B    | ADR 0004 被产品接受为 `Accepted` | 用 v7 floor-aware 合同重新采样，使指标能区分 renderer 工作与 vsync 地板 | 有可能走到 `GO`；随后才能触发 protected attestation 与 R0           |

路径 A 可以随时执行且可重复；路径 B 在 ADR 未批准前**不得**采样，也不得把 v7 数字当作准入证据。

## 3. 路径 A：v6 证据刷新

### A1 选择 dispatch ref

- 只做证据刷新：可沿用功能分支（例如 `codex/feat-sql-agent-schema-adapter`）dispatch；gate 会按该 run 的 `github.sha` / `github.ref` 绑定，记录时必须写明实际 `head_branch`。
- 想接着走 attestation：**必须** `--ref mvp`，且该 revision 必须等于当时 `mvp` HEAD。attestation verifier 要求平台 run 的 `head_branch` 推导出的 ref 等于 `refs/heads/mvp`，否则输出 `platform run source ref does not match`。
- 从 `mvp` 触发前先确认脚本版本：`origin/mvp` 目前缺少 `737de61c` / `b900750c` / `9d68c91d`，其 `scripts/verify-sql-result-grid-gate.mjs` 仍要求 `documentViewport.clientWidth === workload.width`，而新 driver 会把请求的 `390x420` 合法收敛为 `391x420`。用旧脚本 dispatch 会撞上已修复的 viewport 契约冲突。因此走 attestation 路径前，先把这三个提交（以及本轮 verifier 加固）经 PR 合入 `mvp`。

### A2 触发

```bash
cd "$(git rev-parse --show-toplevel)"
# <dispatch ref>：纯证据刷新用功能分支；要接 attestation 用 mvp（且 mvp 已包含三个 native 修复提交）
gh workflow run sql-result-grid-platform.yml \
  --repo baicie/nyala-studio \
  --ref <dispatch ref> \
  -f repeat=5 \
  -f macos_runner=macos-14 \
  -f windows_runner=windows-2022
```

`repeat` 必须保持 `5`：平台证据契约要求每个平台 `4 × 3 × 5 = 60` 条 unique records 与 12 张截图，改成 3 会直接导致 gate 拒绝。

### A3 监控

```bash
gh run list --repo baicie/nyala-studio --workflow sql-result-grid-platform.yml --limit 3
gh run view <RUN_ID> --repo baicie/nyala-studio --json jobs \
  --jq '.jobs[] | [.name,.status,.conclusion,.databaseId] | @tsv'
```

四个 job 的 expect：`Prepare temporary Zeus audit bundle`、`macOS WKWebView benchmark and screenshots`、`Windows WebView2 benchmark and screenshots`、`Aggregate platform evidence and run Z1 gate`。aggregate 失败是 fail-closed 设计的正常表现，只要 artifacts 已上传。

### A4 下载 artifacts

```bash
mkdir -p /tmp/nyala-platform-<RUN_ID>
gh run download <RUN_ID> --repo baicie/nyala-studio -D /tmp/nyala-platform-<RUN_ID>
ls -R /tmp/nyala-platform-<RUN_ID> | head -40
```

应得到 `sql-result-grid-zeus-audit`（audit + benchmark + bundle）、`sql-result-grid-macos-webkit`、`sql-result-grid-windows-webview2`、`sql-result-grid-platform-gate`（含 `phase-z1-gate.json` 与 `platform-evidence.json`）。

### A5 本地复算

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/nyala-replay-<RUN_ID>
NYALA_EXPECTED_REPOSITORY=baicie/nyala-studio \
NYALA_EXPECTED_SOURCE_REVISION=<run head sha> \
NYALA_EXPECTED_SOURCE_REF=refs/heads/mvp \
NYALA_EXPECTED_WORKFLOW_RUN_ID=<RUN_ID> \
NYALA_EXPECTED_WORKFLOW_RUN_ATTEMPT=1 \
NYALA_ZEUS_AUDIT_EVIDENCE=/tmp/nyala-platform-<RUN_ID>/sql-result-grid-zeus-audit/zeus-audit.json \
node scripts/verify-sql-result-grid-gate.mjs \
  /tmp/nyala-platform-<RUN_ID>/sql-result-grid-zeus-audit/phase-z1-benchmark.json \
  /tmp/nyala-replay-<RUN_ID>/phase-z1-gate.json \
  /tmp/nyala-platform-<RUN_ID>/platform-evidence.json
```

exit `1` + `NO-GO` 是预期结果；关键是打开 `/tmp/nyala-replay-<RUN_ID>/phase-z1-gate.json`，把 `reasons` 与各项 `metricChecks` 逐条抄录。

### A6 记录

把这一段写进 [`phase-z1-spike-verification.md`](./phase-z1-spike-verification.md) 的对应日期小节：

- run id / attempt、`head_branch`、`head_sha`、触发时间；
- 每个 job 的结论与 artifact id；
- gate `decision`、通过/失败条目计数、失败门明细；
- 复算命令与 exit code。

**不要**改写 [`phase-z1-gate.json`](./phase-z1-gate.json)：它是冻结的 v2 `NO-GO` 快照，只有一次成功的 protected attestation 才允许用 attested gate 覆盖它（见 B5/B6）。

### A7 成本与并发

- 单次约 30–45 分钟：prepare 约 5 分钟，macOS / Windows 各约 10–15 分钟，aggregate 约 1 分钟。
- workflow 的 `concurrency.group` 是 `sql-result-grid-platform-${{ github.ref }}` 且 `cancel-in-progress: true`：**同一个 ref 连续两次 dispatch 会取消前一次**。需要重跑时先确认没有在跑，或换 ref。

## 4. 路径 B：v7 floor-aware 重跑

### B0 前置授权

1. ADR 0004 由 `Proposed` 改为 `Accepted`——产品决定，未批准前不采样。
2. ADR 中的定量依据已落地（2026-09-17）：六组 evidence 的 `baseline / floor` 为 `1.011–1.237`，全部低于 v6
   隐含要求的 `1.25`，最优一组假设 renderer 零成本也只有 `19.62%`；分解由
   [`scripts/analyze-sql-result-grid-floor-headroom.mjs`](../../scripts/analyze-sql-result-grid-floor-headroom.mjs)
   从通过 validator 的 report 复算。注意 `14.8ms` 来自已删除的 attribution report，不再引用；ADR 只保留可复算口径。
   仍需产品侧确认的是 `Accepted` 决定本身。

### B1 发布 zeus-ui `0.1.0-beta.5`（已完成）

1. zeus-ui `v0.1.0-beta.5` 已由 GitHub Actions 发布，tag/main 为 `52baa1e18ca11671de48bd24c7b1983b7413a516`。
2. `@zeus-web/data-grid`、`@zeus-web/virtual`、`@zeus-web/zeus-compat` 的 beta.5 tarball、integrity、provenance/signatures 与 36 包发布校验已通过。
3. 发布包仍 exact 依赖/peer `@zeus-js/zeus@0.1.1-beta.2`；若要使用 core beta.3，zeus-ui 需要后续 beta 发布修正依赖闭包，Nyala 再单独更新合同。

本地 pack/publish 不可用于登记证据；beta.4 的记录明确要求由 GitHub Actions 发布。

### B2 Nyala 侧引脚与合同同步（必须在同一个 PR 内完成）

见第 5 节触点清单。任何一处漏改都会让 gate 或 R0 直接拒绝。

### B3 v7 采样改造

v7 需要真实 wheel / trackpad 输入、先测 idle rAF `T_vsync`、再计算 `jankRate` 与 `rendererCpu`。实现方式应是**新增 v7 通道**（例如 `--measurement-contract v7`），保留 v6 路径与已冻结的 v6 报告不变。

### B4 重跑平台 workflow

同 A2–A6，但从 `mvp` dispatch，且 revision 就是即将登记的 `mvp` HEAD。前置是 A1 里那条：先把 `737de61c` / `b900750c` / `9d68c91d` 与本轮 verifier 加固合入 `mvp`（PR 合并，required checks 为 `Lint, build, and test` / `Prettier` / `rustfmt` / `taplo`），否则平台 run 会跑在旧 native 脚本上。

### B5 protected Z1 attestation

1. environment 无需预建：`sql-result-grid-z1-gate` 会在首次 dispatch 时自动创建（见 §0.1）；若需要人工审批门，再在 Settings → Environments 里补 required reviewers / branch 限制。
2. 触发：

```bash
gh workflow run sql-result-grid-gate-attest.yml \
  --repo baicie/nyala-studio \
  --ref mvp \
  -f platform_run_id=<RUN_ID>
```

3. 校验点：`github.ref_protected == true` 且 ref 为 `refs/heads/mvp`；平台 run 的 `head_branch` 同样是 `mvp` 且 revision 相同；四个平台 artifacts 均未过期并带 SHA-256 digest；attestation run id 必须大于平台 run id。
4. 产物：`sql-result-grid-gate-attestation`（14 天），包含 attested `phase-z1-gate.json`、`z1-gate-attestation.json`、`platform-run.json`、`source/` 下四份原始输入。

### B6 登记与 R0 复算

1. 只有 attestation 为 `GO` 时，才用 attested gate **逐字节覆盖** [`phase-z1-gate.json`](./phase-z1-gate.json)（R0 会比对 `inputDigests.gate`，内容不同即拒绝）。
2. R0 需要的输入（`NYALA_Z1_*`）：gate、attestation manifest、benchmark、platform evidence、zeus audit、zeus bundle、platform run metadata、attestation run/artifact API metadata。
3. 复算：

```bash
cd "$(git rev-parse --show-toplevel)"
NYALA_Z1_GATE=/tmp/nyala-attest/phase-z1-gate.json \
NYALA_Z1_ATTESTATION=/tmp/nyala-attest/z1-gate-attestation.json \
NYALA_Z1_BENCHMARK=/tmp/nyala-attest/source/sql-result-grid-zeus-audit/phase-z1-benchmark.json \
NYALA_Z1_PLATFORM_EVIDENCE=/tmp/nyala-attest/source/platform-evidence.json \
NYALA_Z1_ZEUS_AUDIT=/tmp/nyala-attest/source/sql-result-grid-zeus-audit/zeus-audit.json \
NYALA_Z1_ZEUS_BUNDLE=/tmp/nyala-attest/source/sql-result-grid-zeus-audit/data-grid-bundle.js \
NYALA_Z1_PLATFORM_RUN=/tmp/nyala-attest/platform-run.json \
NYALA_Z1_ATTESTATION_RUN_METADATA=/tmp/nyala-api/attestation-run.json \
NYALA_Z1_ATTESTATION_ARTIFACT_METADATA=/tmp/nyala-api/attestation-artifacts.json \
NYALA_EXPECTED_REPOSITORY=baicie/nyala-studio \
NYALA_EXPECTED_SOURCE_REVISION=<mvp head sha> \
NYALA_EXPECTED_SOURCE_REF=refs/heads/mvp \
pnpm run verify:sql-mvp-vnext-release
```

R0 还要求 A4 Checkpoint W 的对应输入（`NYALA_A4_CHECKPOINT_W_*`，含原生键盘、VoiceOver / Narrator 走查；attestation workflow 使用 `sql-agent-checkpoint-w` environment，同样首次运行自动创建）。A4 那一侧未闭环时，R0 仍会 `NO-GO`，这属于预期。

## 5. 变更触点清单

换 Zeus 版本或换 measurement contract 版本时，以下位置必须同步（缺一处即 fail closed）：

| 文件                                             | 位置        | 内容                                                                                                                           |
| ------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `.github/workflows/sql-result-grid-platform.yml` | 第 70-71 行 | `pnpm add` / `pnpm view` 的 exact pin                                                                                          |
| `scripts/create-sql-result-grid-zeus-audit.mjs`  | 第 10 行    | `expectedPackage`（version / integrity / unpackedSize，必须取 registry 实测值）                                                |
| `scripts/verify-sql-result-grid-gate.mjs`        | 第 48 行    | `expectedZeusPackage`（另含 6 个 dependencies 与 peer pin）                                                                    |
| `scripts/verify-sql-mvp-vnext-release.mjs`       | 第 411 行   | R0 的 dependency summary（version / integrity / unpackedSize）                                                                 |
| `scripts/*.test.mjs`                             | 5 处字面量  | 上述期望值的测试 fixture（`verify-sql-result-grid-gate`、`verify-sql-mvp-vnext-release`、`create-sql-result-grid-zeus-audit`） |
| `scripts/sql-result-grid-benchmark-contract.mjs` | 第 1 行     | `MEASUREMENT_CONTRACT_VERSION`（v7 需新增独立常量，v6 冻结）                                                                   |
| `docs/sql-mvp-phases/phase-z1-gate.json`         | 整份        | 只能由 attested gate 覆盖                                                                                                      |

以下阈值在 verifier 内硬编码，改动即等于改变预先注册的验收标准，必须由 ADR/产品显式决定：
`1kInteractionRegressionMax = 0.1`、`tenKPrimaryImprovementMin = 0.2`、`primaryMetric = scrollP95Ms`、`gzipBudgetBytes = 30_000`、Chromium `repeat = 3` 与 `recordCount = 36`、每平台 60 records + 12 screenshots、跨环境 156 个唯一 run token。

## 6. 失败模式速查

| 现象                                                                | 原因                                                                                  | 处理                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| workflow 0 jobs，配置解析阶段失败                                   | job-level `env` 里用了 `${{ runner.temp }}`（历史 run `31706679626` / `31607139340`） | 目录初始化必须留在 step runtime；`actionlint` 定期扫描              |
| aggregate `NO-GO`，但 `phase-z1-gate.json` 为预置 reasons           | 构建、下载、合并或 gate 任一步异常，fail closed 生效                                  | 下载 `sql-result-grid-platform-gate`，看预置 reason 与上游 job 日志 |
| `platform run source ref does not match`                            | 平台 run 不是从 `mvp` 触发                                                            | 从 `mvp` 重新 dispatch                                              |
| `attestation run does not target the expected protected source ref` | attestation 不是从 protected `mvp` 触发                                               | 从 `mvp` 重新 dispatch，且 revision 与平台 run 相同                 |
| `is expired` / artifact 缺失                                        | 14 天保留期（audit 7 天）已过                                                         | 重跑平台 workflow，再跑 attestation                                 |
| R0 `Z1 gate artifact` / `input digest` 不匹配                       | 登记的 gate 与 attested gate 不是同一份                                               | 用 attested `phase-z1-gate.json` 逐字节覆盖并重跑 R0                |
| native job 报 viewport / `documentViewport` 契约不匹配              | 从落后的 `mvp` 触发，跑的是旧 gate verifier 与旧 driver                               | 先把 `737de61c` / `b900750c` / `9d68c91d` 合入 `mvp` 再 dispatch    |

## 7. 禁止事项

- 不用历史 checked-in benchmark 代替 fresh 平台证据；workflow 的存在意义就是「不复用历史 artifacts」。
- 不手工改写任何 gate JSON、不手写 `GO`、不用 v7 数字回填 v6 报告。
- 不在 ADR 0004 未 `Accepted` 前采样 v7 并当作准入证据。
- 不因为「证据已过期」就宣称双平台证据不成立：`9d68c91d` / run `32706467306` 的双平台与 audit 结论仍记录在册，只是不可再下载复核；重跑前引用时必须同时说明过期状态。
- 不在 Z1.3 未 `GO` 的前提下启动 Z2 或把 R0 判为通过。
