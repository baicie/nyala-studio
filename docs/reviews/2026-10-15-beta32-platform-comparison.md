# beta.32 平台对比：修复已生效，但收益无法归因

日期：2026-10-15。候选为 `@zeus-web/data-grid@0.1.0-beta.32`（内含
`@zeus-js/runtime-dom@0.1.1-beta.13`）。对照为同一 workflow、同一 instrument 设置下
`0.1.0-beta.31` 的一次独立复采。

| run | 分支 | bundle SHA256 | 用途 | 判定 |
| --- | --- | --- | --- | --- |
| 38605063491 | `mvp` | `9ef85faaa4b9…`（beta.31） | 跨 run 对照，但采集器较旧 | NO-GO |
| 38609171367 | `codex/collector-comparability-audit` | `9ef85faaa4b9…`（beta.31） | 同采集器机制对照 | 未跑门（版本覆盖） |
| 38604544592 | `codex/collector-comparability-audit` | `f363cf4391f9…`（beta.32） | 候选 | NO-GO |

三个 run 均为 `measurementContractVersion: 7`、同一 `scrollCommitBoundary` 与
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

## 同一采集器下的 host 无关机制证据

run 38609171367 用**同一份采集器代码**（本分支）测量 beta.31，与 38604544592 的 beta.32
配对，因此 `textChurn` 计数不受宿主性能影响。`textChurn` 记录测量滚动期间的
characterData mutation 数：

| workload     | renderer | beta.31 | beta.32 | 变化     |
| ------------ | -------- | ------- | ------- | -------- |
| 1k-x-20      | zeus     | 6762    | 6422    | −5.0%    |
| 10k-x-50     | zeus     | 6762    | 6401    | −5.3%    |
| wide-columns | zeus     | 6762    | 6422    | −5.0%    |
| narrow-panel | zeus     | 2415    | 2075    | −14.1%   |

macOS 与 Windows 两侧数字完全一致，说明这是确定性的写入次数变化，而非计时噪声。
`addedNodes` 与 `removedNodes` 在两侧均为 0，确认成本来自复用单元格重绑定既有文本节点，
而非子树重建——这与 bundle diff 观察到的 `e.data!==t&&(e.data=t)` 一致。

同时这也给收益设上了界：修复只取消了约 5%（窄面板 14%）的冗余文本写入，
其余 95% 的写入是数据确实变化时必须执行的。所以先前基于本机 A/B 的「−8.6%」
高估了可归因幅度；真实可归因的机制收益约为 5% 的写入削减。

## 同宿主交错采集：修复生效，但延迟未变

run 38618032049 在**同一台 macOS runner、同一个 WebView 会话**内交替测量 pinned
（beta.32，`f363cf43…`）与 beta-31（`9ef85faa…`）。每个 iteration 的序列是
`zeus(变体 A) → native → workbench-table → zeus(变体 B)`，相邻 iteration 交换 A/B
顺序，各 5 轮，共 80 条 record，全部 `status: ok`。这是本次调查里第一次宿主状态对
两个 bundle 相同。

| workload | 指标 | beta-31 | beta.32 | 变化 |
| --- | --- | ---: | ---: | ---: |
| 10k-x-50 | 文本写入 | 6762 | 6401 | −5.3% |
| 10k-x-50 | rafToTask 中位 | 16.0ms | 16.0ms | 0% |
| 10k-x-50 | commit 中位 | 2ms | 2ms | 0% |
| wide-columns | 文本写入 | 6762 | 6422 | −5.0% |
| wide-columns | rafToTask 中位 | 26.0ms | 27.0ms | +3.8% |
| 1k-x-20 | 文本写入 | 6762 | 6422 | −5.0% |
| 1k-x-20 | rafToTask 中位 | 13.0ms | 14.0ms | +7.7% |
| narrow-panel | 文本写入 | 2415 | 2075 | −14.1% |
| narrow-panel | rafToTask 中位 | 6.0ms | 6.0ms | 0% |

scroll p95 的中位数在两个变体间同向无差异（10k 37→47、wide-columns 56→49、1k 36→37、
narrow 21→21），差异方向不一致且量级与 5% 的写入削减不相称。

结论是明确的：**冗余文本写入确实被消除了，但 10k 滚动延迟没有可测量的改善。**
被取消的 5% 写入不是延迟的瓶颈——这些写入要么本身极廉价，要么其成本被同一段
宿主渲染管线里的其他工作淹没。这与本文开头记录的历史结论一致：Zeus 的 commit 只占
总延迟约 5%，主要成本在输入帧对齐与宿主渲染管线，而后者不在 Zeus 仓库内。

因此这次修复的正确定位是**正确性与开销的微优化**，不是 10k 滚动延迟的修复。它不应
以「性能修复」的名义宣称收益。

run 38620933262 在修复 PowerShell 参数传递后重跑，macOS 与 Windows 两侧都拿到 80 条
`status: ok` 的 record。两平台的交错结论完全一致：

| workload | 平台 | rafToTask 中位 | commit 中位 | 文本写入 |
| --- | --- | --- | --- | --- |
| 10k-x-50 | macOS | 14 → 14（0%） | 2 → 2（0%） | 6762 → 6401（−5.3%） |
| 10k-x-50 | Windows | 5.4 → 5.4（0%） | 3.1 → 3.1（0%） | 6762 → 6401（−5.3%） |
| wide-columns | macOS | 26 → 26（0%） | 2 → 2（0%） | 6762 → 6422（−5.0%） |
| wide-columns | Windows | 8.5 → 8.6（+1.2%） | 3.3 → 3.6（+9.1%） | 6762 → 6422（−5.0%） |
| 1k-x-20 | macOS | 15 → 14（−6.7%） | 2 → 2（0%） | 6762 → 6422（−5.0%） |
| 1k-x-20 | Windows | 5.5 → 5.5（0%） | 3.1 → 3.2（+3.2%） | 6762 → 6422（−5.0%） |
| narrow-panel | macOS | 6 → 5（−16.7%） | 1 → 1（0%） | 2415 → 2075（−14.1%） |
| narrow-panel | Windows | 2.3 → 2.4（+4.3%） | 1.4 → 1.4（0%） | 2415 → 2075（−14.1%） |

Windows 上唯一的正向信号是 narrow-panel 的 rafToTask −16.7%（macOS 同项 −16.7%），
但该项写入削减也是最大的 14.1%，且窄面板不是 Z1 门的主指标。10k 上两个平台的
rafToTask 与 commit 都完全没有移动。

## 仍然存在的 Zeus 侧差距：wide-columns

同 run 内对照三个 renderer 的 rafToTask 中位（macOS / Windows，ms）：

| workload | zeus | workbench-table | native | zeus DOM 节点 | WBT DOM 节点 |
| --- | --- | --- | --- | ---: | ---: |
| 1k-x-20 | 13.6 / 5.6 | 8.4 / 1.8 | 10.6 / 9.7 | 405 | 404 |
| 10k-x-50 | 15.0 / 5.5 | 4.6 / 2.8 | 16.2 / 20.4 | 405 | 914 |
| wide-columns | **26.0 / 8.7** | 8.0 / 2.0 | 6.6 / 3.8 | 405 | 404 |
| narrow-panel | 5.0 / 2.4 | 2.0 / 0.9 | 4.2 / 6.7 | 171 | 404 |

wide-columns 上 Zeus 与 workbench-table 的 DOM 规模几乎相同（405 vs 404 节点），
rafToTask 却相差 3.2 倍（macOS 26.0 vs 8.0）。这是本次证据中**唯一仍然可归因于
Zeus 自身**的滚动延迟差距，也是下一轮应当针对的目标。

两个可检验的差异点，均尚未用同宿主交错采集验证：

1. **渲染行数**。同一 viewport（Zeus 385px / WBT 372px）下 Zeus 固定渲染 23 行，
   WBT 渲染 14 行。Zeus 多渲染 64% 的行与单元格，而两者 DOM 节点总数相近，说明 WBT
   在同等节点预算下复用了更多。`grid-virtualizer.ts:100-115` 的 fixed 容量为
   `ceil(viewport/rowHeight) + overscan*2 + 1`，overscan 默认 4。
2. **文本整形成本被 Zeus 放大**。同为 80 字符 cell、60 字符表头，wide 相对 10k-x-50
   的 rafToTask 增量在 Zeus 上是 +11ms（15.0 → 26.0），在 WBT 上只有 +3.4ms
   （4.6 → 8.0）。native 反而是 wide 更快（6.6 vs 16.2），因为它只渲染 1000 行而
   10k-x-50 渲染 10000 行。因此同一段长文本在 Zeus 路径上的代价是 WBT 的约三倍。

   曾怀疑每行携带完整列模板（`data-grid.tsx:2741` 的
   `gridTemplateColumns: getGridTemplateColumns()`），但该字符串来自
   `columnSnapshotCache`（`data-grid.tsx:1173-1179`），只拼接 `snapshot.items` 的尺寸，
   即当前渲染范围（实测 `lastColumnIndex: 12`，13 个条目），并非全部 50 条轨道。
   该假设不成立，已排除。

   两侧 cell 的 CSS 差异是候选点：Zeus cell 为 `display: flex` 加
   `text-overflow: ellipsis`，WBT cell 为普通块级 `white-space: nowrap` +
   `overflow: hidden` 且无 ellipsis。ellipsis 需要完整整形后测量再截断，理论上更贵。
   本机曾测过 `text-overflow: clip`，但本机 rafToTask 漂移 6–19ms，该结论不成立，
   需要在交错采集下重测。

### 该候选的验证结果：测量装置不成立

用交错采集在本机重测「移除 `text-overflow: ellipsis`」时，得到一个稳定 5/5 的
−1.8ms（wide-columns 18.2 → 16.4ms，−10%）。**该结果是噪声，不是收益。**

原因：`scripts/benchmark-sql-result-grid.mjs:857` 的 benchmark 页面**自带内联 CSS**，
其中已经为 `data-grid-cell` 声明了 `white-space: nowrap; overflow: hidden;
text-overflow: ellipsis`。它从不加载 `@zeus-web/themes` 的 `components.css`；实测
被测 bundle（`f363cf43…`）中 `text-overflow`、`white-space`、`overflow: hidden`
的出现次数均为 0，bundle 不含任何 CSS。

因此改 `packages/themes/src/components.css` 对被测页面毫无影响。我构建出的「候选」
bundle 与 pinned bundle 的差异只是未压缩的标识符名（`e0e48d4d…` vs `f363cf43…`，
90806 vs 90767 字节），像素比对显示除底部 run marker 条带外**完全一致**——即两个
变体渲染相同。这直接证明了 −10% 来自 run 内噪声，与之前记录的「本机 rafToTask
漂移 6–19ms」一致。

这条候选无法用现有装置验证。若要继续追查 wide-columns 的文本整形成本，必须先让
benchmark 加载真实的产品样式，或改为在页面内注入变体样式；否则任何 CSS 层面的
候选都无法被这套门禁测到。

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

补充 run 38609171367 把这一点说得更清楚：即使同一采集器、同一 workflow、同样 5 轮，
两次相隔约一小时的 run 之间 10k/native 仍然移动了 −52.8%。这些 GitHub-hosted runner
之间存在数十个百分点的宿主级漂移，而门禁阈值为 10%（1k）与 20%（10k）。在这种漂移
下，任何跨 run 的单次对比都无法支撑门禁量级的结论。交错采集，或在 runner 内固定同一
宿主并交替测量两个 bundle，是继续推进该门禁的前提。

交错采集已经在 run 38618032049 上落地并给出了答案：修复生效，但延迟没有改善。
下一步不应再试图用更多跨 run 采样来「证明」收益，而应转向 Zeus 仓库之外的成本：
10k 滚动中 Zeus commit 只占约 2ms，而 rafToTask 为 16ms，其余时间在宿主渲染管线。
要在 Z1 门上取得 20% 的 10k 改善，需要的是能改变那 14ms 的手段，而不是继续在
2ms 的 commit 里做微优化。

run 38620933262 在 macOS 与 Windows 上重复了同一结论（见上表），因此这一条已经
跨两个平台、跨宿主漂移幅度验证完毕。
