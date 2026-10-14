# beta.32 平台对比：修复已生效，但收益无法归因

日期：2026-10-15。候选为 `@zeus-web/data-grid@0.1.0-beta.32`（内含
`@zeus-js/runtime-dom@0.1.1-beta.13`）。对照为同一 workflow、同一 instrument 设置下
`0.1.0-beta.31` 的一次独立复采。

| run       | 分支                             | bundle SHA256                        | 判定  |
| --------- | -------------------------------- | ------------------------------------ | ----- |
| 38605063491 | `mvp`                            | `9ef85faaa4b9…`（beta.31）            | NO-GO |
| 38604544592 | `codex/collector-comparability-audit` | `f363cf4391f9…`（beta.32）        | NO-GO |

两个 run 均为 `measurementContractVersion: 7`、同一 `scrollCommitBoundary` 与
`executionOrder`、`admissionGrade: true`、每 workload/renderer 5 轮、无
`limitations`。此前用于对照的 38552402643 打开了 `instrument_baseline`，其 baseline
renderer 数字带 observer 开销，已被替换为本次配对复采。

## 修复确实进入了被测 bundle

直接比对两个 run 的 `data-grid-bundle.js`：beta.31 为
`Cr(e,t,n){Dn(t,n,r=>{e.data=Jo(r)})}`，beta.32 为
`Cr(e,t,n){Dn(t,n,r=>{Qa(e,Jo(r))})}` 加 `Qa(e,t){e.data!==t&&(e.data=t)}`。
这正是 runtime-dom 的冗余文本写入跳过逻辑，beta.32 侧确实在测量中被执行。

## 跨 run 数字不可归因

macOS WebKit，scroll p95 中位数：

| workload          | renderer        | beta.31 | beta.32 | 变化    |
| ----------------- | --------------- | ------- | ------- | ------- |
| 10k-x-50          | zeus            | 49      | 19      | −61.2%  |
| 10k-x-50          | native          | 49      | 25      | −49.0%  |
| 10k-x-50          | workbench-table | 46      | 23      | −50.0%  |
| wide-columns      | zeus            | 48      | 35      | −27.1%  |
| wide-columns      | workbench-table | 33      | 18      | −45.5%  |

native 与 workbench-table 不加载 Zeus bundle。10k 上两个对照 renderer 与 Zeus 同步
下移 49–50%，wide-columns 上 workbench-table 的降幅（−45.5%）大于 Zeus（−27.1%）。
这是 run 之间的宿主／runner 漂移，不是 bundle 变更的效果，因此 Zeus 侧 −61.2% 无法
归因给这次文本写入跳过。

presentation floor 也不支持 49% 的降幅：10k/native 的 floor 中位数为 19→18ms、
10k/zeus 为 18→18ms，都停在 60Hz 一帧（≈16.7ms）附近，说明该环境能呈现的最小滚动
成本并未变。floor 的 p95 本身噪声较大（10k/native 35→24、10k/zeus 40→21），而
wide-columns 三个 renderer 的 floor 中位数反而整体上移（18→21、27→24、18→21ms）。
这与「Zeus bundle 变更导致 49% 改善」不相容。

Windows WebView2 方向相反：10k zeus scroll p95 19.7→22（+11.7%），commit 中位数
3.0→3.8ms，wide-columns commit 2.95→4.2ms。Windows 上未见收益。

`scripts/compare-sql-result-grid-platform-evidence.mjs` 现在把这条判据固化：任一 workload
的对照 renderer scroll p95 变化达到 ±10% 即输出 caveat，声明该 run 对的 Zeus delta 只能
作为上界，不能作为收益。

## 门判定

两个 run 都判定 NO-GO，但失败理由不同，且都不是「Zeus 10k 未改善」：

- 38605063491：macOS 10k improvement −6.5%；Chromium 10k 因 shared floor 20.60ms 高于
  达标所需 18.08ms 而 NOT-EVALUABLE；macOS 1k 回归 25.0% 超限。
- 38604544592：macOS 10k improvement 17.4%，低于 20% 门槛；Chromium 10k 同样
  NOT-EVALUABLE（floor 20.40ms > 17.28ms）；Windows 1k 回归 23.7% 超限。

1k 门在两次 run 之间从 8.7% 回归变为 12.6% 回归、又从 25.0% 变为 10.0%，同样随 run
摆动，进一步说明这两个 runner 之间的绝对差值不足以支撑 10% 量级的判据。

## 结论

runtime-dom 的冗余文本写入跳过已进入 beta.32 并在被测 bundle 中生效，但它在官方
60Hz runner 上带来的可归因收益目前**无法证明**：macOS 的改善被同 run 的对照 renderer
同步漂移淹没，Windows 上未见改善。要得到可归因结论，需要在同一 runner 上对 beta.31 与
beta.32 做交错采集（interleaved），使宿主漂移同时作用于两者，而不是两次相隔数小时的
独立 run。当前证据不足以宣称性能修复成功。
