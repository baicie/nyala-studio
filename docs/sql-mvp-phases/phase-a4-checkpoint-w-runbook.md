# A4 Checkpoint W 原生证据与签收操作手册

- Status: 操作手册（不构成 gate 结论，不改变 `A4 Checkpoint W = NO-GO`、`Z1.3 = NO-GO`、`Z2 = 禁止开始`、`R0 = NO-GO`）
- Date: 2026-09-18
- Related: [A4 Workbench 验证记录](./phase-a4-workbench-verification.md)、[Z1 证据工作流重跑清单](./phase-z1-ci-rerun-checklist.md)、[`sql-agent-native.yml`](../../.github/workflows/sql-agent-native.yml)、[`sql-agent-checkpoint-w-attest.yml`](../../.github/workflows/sql-agent-checkpoint-w-attest.yml)、[`phase-a4-checkpoint-w.json`](./phase-a4-checkpoint-w.json)

本文只回答一个问题：**要把 Checkpoint W 从 `NO-GO` 翻到 `GO`，需要按什么顺序做什么、由谁来做。**
它不是验收报告；任何本地诊断、预览或 synthetic Tab 结果都不能替代本文第 4 节的四项人工签收。

## 0. 三类工作的归属

| 工作                                                                             | 现状                            | 归属                                  |
| -------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------- |
| capture driver / verifier / archive digest 校验加固（含 63/63、35/35、1/1 回归） | 已完成，位于工作树，未提交      | 需要授权 #3（合入受保护 `mvp` 的 PR） |
| `737de61c` / `b900750c` / `9d68c91d` 三个 native 修复提交                        | 已在功能分支，`origin/mvp` 缺失 | 同上，同一 PR                         |
| 触发 capture → 下载复核 → 触发 attestation                                       | 未做（受保护分支脚本落后）      | 授权后可由本会话执行                  |
| macOS 物理键盘 + VoiceOver、Windows WebView2 实机 + Narrator 走查                | **从未产出过成功记录**          | 只能由人在原生环境完成                |
| W3.1 本地预检（diagnostic-only，只读 + `/tmp`）                                  | 已实现，位于工作树              | 无需授权，随时可跑；不产生准入证据    |

GitHub environment 不是阻塞项：`sql-agent-checkpoint-w` 会在首次 dispatch 时自动创建（见
[Z1 清单 §0.1](./phase-z1-ci-rerun-checklist.md)）；只有需要 required reviewers 纵深保护时才预建。

## 1. 当前事实（2026-09-18 核查）

| 事实                                                                                                                                                                                                                                                          | 证据来源                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 默认分支 `mvp` 受保护；`sql-agent-native.yml` 与 `sql-agent-checkpoint-w-attest.yml` 均已发布且 active，runs 均为 0                                                                                                                                           | `gh api repos/baicie/nyala-studio/actions/workflows`                               |
| `origin/mvp` 缺少 `737de61c` / `b900750c` / `9d68c91d`；工作树 verifier 与 workflow blob 均领先（`verify-sql-agent-checkpoint-w.mjs` `2c7248b2 → 4a682cc9`、`verify-sql-agent-capture-run.mjs` `00ef9a31 → 64a62ce4`、attest workflow `edcd32b5 → f3dede0c`） | `git diff origin/mvp -- .github/workflows/ scripts/`                               |
| 历史 native runs `31706678471` / `31607138267` 因 job-level `env` 使用 `${{ runner.temp }}` 在配置解析阶段失败：0 jobs、0 artifacts、无日志可查                                                                                                               | `gh run view <id> --json jobs`                                                     |
| capture artifacts `sql-agent-native-macos` / `sql-agent-native-windows` retention 为 14 天                                                                                                                                                                    | workflow 第 86 / 147 行                                                            |
| attestation 只允许 `github.ref_protected == true` 且 ref 等于默认分支；capture 与 attestation 必须绑定**同一 revision**                                                                                                                                       | workflow `if:` 条件与 "Verify protected default-branch source" 步骤                |
| gate 独立复核 archive URL 路径与 digest：`curl` 下载 → `sha256sum --check --strict` → zip-slip guard → 解压后要求 `workbench-evidence.json` 存在且非 symlink                                                                                                  | `sql-agent-checkpoint-w-attest.yml` "Download and verify native evidence archives" |

## 2. 端到端步骤

### W1 先把修复合入 `mvp`（授权 #3）

同一 PR 至少包含：

1. 三个 native 修复提交 `737de61c`、`b900750c`、`9d68c91d`；
2. A4 加固：`scripts/verify-sql-agent-capture-run.mjs`、`scripts/verify-sql-agent-checkpoint-w.mjs`、
   `.github/workflows/sql-agent-checkpoint-w-attest.yml`（archive URL + digest + zip-slip 下载路径）及对应测试；
   建议同一 PR 带上 W3.1 的 `scripts/sql-agent-checkpoint-w-preflight.mjs` 与其 9/9 单测（诊断-only，不改变 gate 语义）；
3. 本地已绿的定向回归：`pnpm run test:sql-agent-checkpoint-w`（63/63）、`pnpm run test:sql-mvp-vnext-release`（35/35）、
   `pnpm run test:github-workflows`、`pnpm run test:release`。

`mvp` required checks 为 `Lint, build, and test` / `Prettier` / `rustfmt` / `taplo`，`strict = true`、
required approvals `0`、禁止 force push。**走 attestation 前必须先合入**：受保护分支上的旧 verifier 与
旧下载路径结构上跑不出 `GO`。

### W2 触发 capture 并取得双平台 artifact

```bash
cd "$(git rev-parse --show-toplevel)"
gh workflow run sql-agent-native.yml \
  --repo baicie/nyala-studio \
  --ref mvp \
  -f macos_runner=macos-14 \
  -f windows_runner=windows-2022
```

- 必须 `--ref mvp`：attestation 要求 capture 的 `head_branch` 推导出的 ref 等于 `refs/heads/mvp`。
- 触发前确认 `mvp` HEAD 就是要登记的 revision；**capture 与 attestation 之间不要向 `mvp` 推任何提交**，
  否则 capture revision ≠ attestation revision，gate 直接拒绝。
- 两个 job 都必须成功：`macOS WKWebView SQL Agent evidence`、`Windows WebView2 SQL Agent evidence`；
  每个平台各自上传一个 14 天保留的 artifact。

```bash
gh run list --repo baicie/nyala-studio --workflow sql-agent-native.yml --limit 3
gh run view <RUN_ID> --repo baicie/nyala-studio --json headSha,headBranch,status,conclusion,jobs \
  --jq '{headSha,headBranch,status,conclusion,jobs:[.jobs[]|{name,conclusion}]}'
```

### W3 本地预检 capture metadata（fail-closed，先于人工走查）

```bash
mkdir -p /tmp/nyala-a4-<RUN_ID>
gh api repos/baicie/nyala-studio/actions/runs/<RUN_ID> \
  > /tmp/nyala-a4-<RUN_ID>/run.json
gh api repos/baicie/nyala-studio/actions/runs/<RUN_ID>/artifacts \
  > /tmp/nyala-a4-<RUN_ID>/artifacts.json
node scripts/verify-sql-agent-capture-run.mjs \
  --run-metadata /tmp/nyala-a4-<RUN_ID>/run.json \
  --artifact-metadata /tmp/nyala-a4-<RUN_ID>/artifacts.json \
  --output /tmp/nyala-a4-<RUN_ID>/capture-run.json \
  --expected-repository baicie/nyala-studio \
  --expected-run-id <RUN_ID>
```

只有输出 `verified` 才继续。它要求：run 为成功的 `workflow_dispatch`、恰好两个未过期且带 64 位
SHA-256 digest 的 artifact、`archive_download_url` 精确等于
`https://api.github.com/repos/<repo>/actions/artifacts/<id>/zip`、run/head SHA/branch 全部匹配。

注意：`verify-sql-agent-checkpoint-w.mjs` 在不带 `--expected-repository` / `--expected-revision` /
`--expected-ref` 时，provenance 完全由四份输入自洽推导——这种本地 `GO` **不是准入证据**，只能当诊断。
workflow 与 R0 都会传入 trusted expectation，任何本地自洽但未被绑定的产物会在发布链上被拒绝。

要看机器面全貌，必须把两个 artifact **完整解压**（gate 会读取 manifest 旁边的截图文件并逐张核对
字节数、SHA-256、PNG 尺寸与像素多样性，只拿 manifest 一定过不了 `automated-surface`），再配一份
全部四项为 `false` 的临时 manual attestation 跑一次 gate：预期仍是 `NO-GO`（manual 四项必失败），但
`capture-run-metadata`、双平台 `native-identity` / `automated-surface` / `provenance-match` 各项应
全通过；任何一项失败都不要进入 W4。手工步骤见下，W3.1 的预检脚本已把整套流程串起来。

#### W3.1 可选：一键本地预检（diagnostic-only）

[`scripts/sql-agent-checkpoint-w-preflight.mjs`](../../scripts/sql-agent-checkpoint-w-preflight.mjs)
把上面的手工步骤串成只读诊断：取 API 元数据 → capture-run 校验 → 下载双平台 artifact →
生成一份**全部四项为 `false`** 的临时 manual attestation → 用 trusted expectation 跑一次
fail-closed gate，再按 check id 分类结论。

```bash
cd "$(git rev-parse --show-toplevel)"
node scripts/sql-agent-checkpoint-w-preflight.mjs --run-id <RUN_ID>

# 复用已解压 artifact / 已保存的 API JSON（不重复下载）：
node scripts/sql-agent-checkpoint-w-preflight.mjs --run-id <RUN_ID> \
  --artifacts-dir /tmp/nyala-a4-<RUN_ID>/artifacts \
  --run-json /tmp/nyala-a4-<RUN_ID>/run.json \
  --artifacts-json /tmp/nyala-a4-<RUN_ID>/artifacts.json
```

- 全部产物只写 `--dir`（默认 `/tmp/nyala-a4-preflight-<RUN_ID>`）；脚本拒绝任何位于仓库内的
  `--dir` / `--artifacts-dir` / `--run-json` / `--artifacts-json`，防止本地诊断 JSON 落到仓库里被误登记。
- revision 绑定：W5 只接受**受保护默认分支当前 tip** 上的 capture，所以预检会把 capture revision 与
  `--ref`（默认 `mvp`）的当前 tip 核对。默认用 `gh api` 查 `repos/<repo>` 的 `.default_branch` 与
  `repos/<repo>/commits/<ref>` 的 `.sha`；离线 / 复用模式必须成对声明
  `--default-branch <name> --tip-revision <40-hex>`（SHA 大小写均可）。`--ref` 不是默认分支 → 直接拒绝（exit 2）；
  capture revision ≠ 当前 tip → `stale-revision`（exit 1）；两者都未知（`gh` 查询失败）→ `unverified`，
  打印警告但仍按 `expected-diagnostic` 处理，进 W4 前必须自行确认 tip。
- 预期结论 `expected-diagnostic`：machine 面（`capture-run-metadata`、双平台 `native-identity` /
  `automated-surface`、`provenance-match`）全通过，失败项恰为 `manual-attestation`（`status: pending`
  且没有真实 attestation run provenance）与四个人工门。
- 退出码：`0` 符合预期、可以进入 W4；`1` 结果异常（机器面失败 / 意外 `GO` / 人工门意外通过 /
  `stale-revision`）；`2` 用法、网络或 capture 元数据错误，先修 capture 再谈 W4。
- 脚本回归：`node --test scripts/sql-agent-checkpoint-w-preflight.test.mjs`（9/9；未接入
  `pnpm run test` 链，避免改动 package.json）。

2026-09-18 本地验证（全部在仓库外 `/tmp` 合成输入上，脚本已含 revision binding）：单测 9/9 exit 0
（含 revision 绑定与 `gh` 降级两条用例）；声明 `--default-branch mvp --tip-revision <capture-sha>`
的 dry-run exit 0（`revision binding: match (declared)`；gate 11 项中 machine 面 6 项全过、5 项人工预期失败）；
同一份合成 capture 改为不声明 tip、让 `gh api` 实测 `mvp` tip 时 exit 1（`stale-revision`，落后捕获会被拦在
W4 之前）；把 Windows desktop 截图篡改 1 字节后 exit 1（`machine-side-blocked`，唯一 UNEXPECTED 为
`windows-automated-surface`）；`--dir` 指向仓库内 exit 2，`--default-branch main` 与 `--ref mvp` 冲突 exit 2，
`--artifacts-dir` / `--run-json` / `--artifacts-json` 指向仓库内同样被拒绝（仓库内路径拒绝用例）。
这些数字证明的是脚本行为，不是 Checkpoint W 证据。

**本地预检的 `GO` 与 `NO-GO` 都不是准入证据**：临时 attestation 的 evidence ref 固定为
`qa://local-preflight-not-admission-evidence/*`，reviewer 为 `local-preflight-diagnostic-not-a-signoff`，
gate 报告文件名也带 `.preflight`。只有 W5 在受保护默认分支上产出的
[`phase-a4-checkpoint-w.json`](./phase-a4-checkpoint-w.json) 才允许登记。

### W4 人工走查（两台原生实机，四项独立签收）

| 平台    | 门                        | 人工必须逐项确认的断言（gate 不复算焦点/播报，只记录 boolean 与 ref）                                                |
| ------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| macOS   | `macos-native-keyboard`   | 真实焦点顺序恰为 `Agent prompt → Agent task → Agent access mode → Start Agent run`；Start/Cancel 可达；无 focus trap |
| macOS   | `macos-voiceover`         | VoiceOver 播报 labels；run state 变化被播报；无 focus trap                                                           |
| Windows | `windows-native-keyboard` | 同 macOS 键盘四项                                                                                                    |
| Windows | `windows-narrator`        | Narrator 播报 labels 与 state 变化；无 focus trap                                                                    |

这些断言全部由人工确认：`create-sql-agent-checkpoint-w-attestation.mjs` 收到 boolean 后直接写入
`status: passed` / `startCancelReachable` / `noFocusTrap` / `labelsAnnounced` / `stateChangesAnnounced`，
`focusOrder` 是脚本内置常量而非实测结果，gate 也不会抓取 evidence ref 的内容。证据内容真实性、可追溯性由签收人负责。

走查必须在**触发 capture 的那个 revision 的构建**上进行：用 `git rev-parse mvp` 记录 SHA，并把该 SHA、本机
二进制 / `.app` 的 SHA-256、OS 版本、AT 与版本、逐项结果与时间写进 ref 指向的证据。manual attestation schema
没有二进制字段，这是把人工走查与 revision 绑定的唯一方式。W4 期间不要向 `mvp` 推提交：capture 与 attestation
必须绑定同一 revision（W2 第 2 条）。

每个门的 evidence ref 必须：credential-free、`https://` 或 `qa://`、无 userinfo/query/fragment、长度 ≤ 2048，
且四个 ref **互不相同**。把 walkthrough 记录（截图、录屏、issue 或内部 QA 条目）放在该 URL 指向的位置。
实现还会额外拒绝：反斜杠、任何空白或控制字符、首尾空白、URL 编码的控制/空格序列（`%00`–`%1f`、`%20`、`%7f`
——含空格编码的 Confluence / Notion 链接会被直接拒绝），以及 hostname 为空的 `qa:///…`；唯一性按 URL
规范化结果比较，`https://host:443/x` 与 `https://host/x` 视为同一个 ref。

### W5 触发 protected attestation

```bash
gh workflow run sql-agent-checkpoint-w-attest.yml \
  --repo baicie/nyala-studio \
  --ref mvp \
  -f capture_run_id=<RUN_ID> \
  -f attest_macos_keyboard=true \
  -f macos_keyboard_evidence_ref=<ref-1> \
  -f attest_voiceover=true \
  -f voiceover_evidence_ref=<ref-2> \
  -f attest_windows_keyboard=true \
  -f windows_keyboard_evidence_ref=<ref-3> \
  -f attest_narrator=true \
  -f narrator_evidence_ref=<ref-4>
```

四个 boolean 是对"我已完成该 walkthrough"的显式确认，必须为 `true`；workflow 会在下列任一条不满足时
失败并保持 `NO-GO`：ref 非受保护默认分支、checkout 后默认分支已移动、capture run 不是成功
`workflow_dispatch`、artifact 过期/缺 digest/URL 被改写、provenance 不匹配、attestation run id 不
晚于 capture run id、人工 ref 重复或不合规。

`reviewer` 记录的是 dispatch 者（`GITHUB_ACTOR`），不是走查者；两者不同时请在证据内容里写明实际走查人。
失败的 attestation 不允许伪造成功：直接重新 dispatch（concurrency 以 `capture_run_id` 为键、
`cancel-in-progress: false`，重跑不会取消前一次），R0 只认最终成功那次 run 的 API metadata。

### W6 验收、登记与 R0 输入

1. 下载聚合 artifact（14 天）与两份 API metadata，打开 `phase-a4-checkpoint-w.json` 与 workflow summary：

```bash
ATTEST_RUN_ID=<attestation run id>
gh run download "$ATTEST_RUN_ID" --repo baicie/nyala-studio -n sql-agent-checkpoint-w -D /tmp/nyala-a4-attest
mkdir -p /tmp/nyala-api
gh api repos/baicie/nyala-studio/actions/runs/"$ATTEST_RUN_ID" > /tmp/nyala-api/attestation-run.json
gh api repos/baicie/nyala-studio/actions/runs/"$ATTEST_RUN_ID"/artifacts > /tmp/nyala-api/attestation-artifacts.json
```

单 artifact 下载会把内容平铺进 `-D` 目录：平台 manifest 位于
`/tmp/nyala-a4-attest/sql-agent-native-{macos,windows}/workbench-evidence.json`——**没有** `source/` 层级
（`source/` 只存在于 Z1 的 attestation artifact）。

2. **只有 `decision == "GO"`** 才允许用该 attested 文件覆盖
   [`phase-a4-checkpoint-w.json`](./phase-a4-checkpoint-w.json)；`NO-GO` 时保留原因并回到 W1/W2/W4。
3. 在 [A4 Workbench 验证记录](./phase-a4-workbench-verification.md) 追加当日小节：capture/attestation 的
   run id、attempt、head SHA、artifact id、四个 evidence ref、gate 每项 check 结论。
4. R0 复算需要下列输入（`scripts/verify-sql-mvp-vnext-release.mjs`）；`NYALA_EXPECTED_*` 三件套必填，
   `CAPTURE_REVISION` 用 W2 那个 captured revision（本地 checkout 不在该 revision 时不要依赖默认值）：

```bash
cd "$(git rev-parse --show-toplevel)"
CAPTURE_REVISION=<captured revision>
NYALA_A4_CHECKPOINT_W_GATE=/tmp/nyala-a4-attest/phase-a4-checkpoint-w.json \
NYALA_A4_CHECKPOINT_W_MACOS_EVIDENCE=/tmp/nyala-a4-attest/sql-agent-native-macos/workbench-evidence.json \
NYALA_A4_CHECKPOINT_W_WINDOWS_EVIDENCE=/tmp/nyala-a4-attest/sql-agent-native-windows/workbench-evidence.json \
NYALA_A4_CHECKPOINT_W_MANUAL_ATTESTATION=/tmp/nyala-a4-attest/manual-attestation.json \
NYALA_A4_CHECKPOINT_W_CAPTURE_RUN=/tmp/nyala-a4-attest/capture-run.json \
NYALA_A4_CHECKPOINT_W_ATTESTATION_RUN_METADATA=/tmp/nyala-api/attestation-run.json \
NYALA_A4_CHECKPOINT_W_ATTESTATION_ARTIFACT_METADATA=/tmp/nyala-api/attestation-artifacts.json \
NYALA_EXPECTED_REPOSITORY=baicie/nyala-studio \
NYALA_EXPECTED_SOURCE_REVISION=$CAPTURE_REVISION \
NYALA_EXPECTED_SOURCE_REF=refs/heads/mvp \
pnpm run verify:sql-mvp-vnext-release
```

省略 `NYALA_EXPECTED_*` 会让 R0 直接记录 `trusted expected repository is missing or invalid` /
`trusted expected source ref is missing or invalid` 并保持 `NO-GO`，与证据真伪无关。

Checkpoint W 翻绿也只是 R0 的一半：Z1.3 仍因 v6 五个性能门保持 `NO-GO`，Z2 不会因为 A4 通过而解禁。

## 3. 失败模式速查

| 症状（gate/verifier 输出）                                                                                | 原因                                                                                               | 处理                                                                     |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `capture run must expose exactly 2 artifacts`                                                             | capture 未跑完、artifact 被清理或 run 选错                                                         | 确认 run id、job 结论与 14 天保留期                                      |
| `artifact N is expired` / `SHA-256 digest is invalid or missing`                                          | artifact 过期或不是 GitHub 原生 digest                                                             | 重新触发 capture，不要用旧 run                                           |
| `artifact N archive URL is invalid`                                                                       | API 响应被改写、query/hash 变体或跨 artifact 重定向                                                | 重新取 API 响应；不要手工修补 JSON                                       |
| `capture run head branch is invalid` 或 `Capture source ref does not match the protected default branch.` | capture 不是从 `mvp` 触发                                                                          | `--ref mvp` 重新触发（见 W2）                                            |
| `Capture source revision does not match the protected attestation revision`                               | capture 后 `mvp` 又前进了                                                                          | 冻结分支，重新 capture                                                   |
| `Default branch moved after the attestation run was dispatched; rerun ...`                                | dispatch 与 checkout 之间默认分支被推进                                                            | 对当前 HEAD 重新 dispatch                                                |
| `manual evidence references must be unique across all four gates`                                         | 四个 evidence ref 有重复或共享                                                                     | 每项走查单独留证据，不要共用一个链接                                     |
| `attestation workflow must run after the native capture workflow`                                         | capture/attestation run id 顺序颠倒                                                                | 先 capture 再 attestation，不要预签                                      |
| `Attestation requires a branch protected by GitHub rules`                                                 | 从功能分支 dispatch                                                                                | 只能从受保护 `mvp` 触发                                                  |
| `trusted expected repository is missing or invalid`（R0）                                                 | 未设 `NYALA_EXPECTED_REPOSITORY` / `NYALA_EXPECTED_SOURCE_REF`，或 revision 不是 captured revision | 按 W6 设三件套，revision 用 captured revision                            |
| `macOS native evidence could not be loaded`（R0）                                                         | R0 路径多了 `source/` 层级，A4 artifact 是平铺的                                                   | 用 `/tmp/nyala-a4-attest/sql-agent-native-macos/workbench-evidence.json` |
| `preflight verdict: machine-side-blocked`（W3.1）                                                         | 机器面证据被改写、缺截图或 provenance 漂移                                                         | 按 UNEXPECTED failure 的 reason 修复后重新 capture                       |
| `preflight verdict: unexpected-go`（W3.1）                                                                | 输入被替换成已签收 attestation，或 gate 被改动                                                     | 立即人工复核，禁止登记，回 W1 排查                                       |
| `preflight verdict: stale-revision`（W3.1）                                                               | capture 之后默认分支 tip 又前进，或 `--default-branch` / `--tip-revision` 声明了旧 tip             | 冻结分支并重新 capture（W2），不要开始 W4 人工走查                       |

## 4. 禁止事项

- 不要手写、拼接或复制其他 revision 的 `phase-a4-checkpoint-w.json`；gate 从 raw evidence 逐项重算并在
  raw input digest 不匹配时拒绝。
- 不要把 W3.1 本地预检的 `GO` 当作 W5 的替代品：预检的临时 attestation 永远是 `pending`，报告文件名带
  `.preflight`，只用于诊断机器面是否具备进入 W4 的条件。
- 不要把 synthetic Tab、WebDriver `/actions`、ARIA 静态检查或本机 accessibility API 诊断当作四项人工
  签收的任何一项。
- 不要在 `mvp` 合入前从功能分支 dispatch attestation；也不要在受保护分支上直接改 gate JSON 绕门。
- 不要在没有新证据的情况下改动 [`phase-a4-checkpoint-w.json`](./phase-a4-checkpoint-w.json)、
  [`phase-z1-gate.json`](./phase-z1-gate.json) 或 [`phase-vnext-release-gate.json`](./phase-vnext-release-gate.json)。
