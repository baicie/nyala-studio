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

## 让门禁真正加载产品 CSS

上面的结论是「CSS 候选无法用现有装置验证」。装置已修：`--zeus-css <path>` 让
benchmark 页面把真实样式表作为独立 `<style>` 块加载，默认仍是不带产品 CSS 的
历史页面，旧证据可复现；evidence 记录 CSS 模式（inline / product）、解析后的路径
与内容 SHA-256，因此两种证据从文件本身即可区分。workflow 新增可选输入
`zeus_css_package_version`，从被测版本安装 `@zeus-web/themes` 并把
`dist/components.css` 送进两个平台 job。产品 CSS 的 run 与其它诊断 run 一样不进
Z1 门。

`@zeus-web/data-grid@0.1.0-beta.32` 的发布包里 CSS 文件数为 **0**：样式完全在
`@zeus-web/themes` 里，此前从未进入被测页面。

### 第一次产品 CSS run 失败，暴露了一个真实装置 bug

run 38630294128 的 macOS 与 Windows job 全数失败，全部 renderer（含不加载 Zeus
bundle 的 native）都报 `renderer did not expose contained document geometry`。

根因不在产品 CSS 的规则内容，而在注入方式：产品 CSS 被写进页面自身的 `<style>`
**内部**，形成嵌套 `<style>`。浏览器会丢弃内层 `<style>` 元素**及其之后的全部规则**，
于是 benchmark 的几何脚手架（`html/body/#root` 高度、viewport、row 定位）整段消失。
用 1 字节的平凡 CSS（`a { color: red; }`）即可复现同一失败，而空文件不会——这把
根因从「某条产品规则冲突」缩小到「注入位置」。

修复（`ef60d7fe`）：产品样式表作为页面 `<style>` 之前的独立同级块注入，并给
grid viewport 显式设置 `--zw-data-grid-height: 100%`，否则产品 CSS 的
`var(--zw-data-grid-height, 28rem)` 兜底会把 viewport 固定成 28rem。本机对已发布的
beta.32 样式表复测：native / workbench-table / zeus 三个 renderer 均跑完，zeus
dom=406，几何有效。并补了回归测试，要求产品块位于几何规则之前且不包含它们。

这也是本记录里唯一一次「宿主侧装置 bug 伪装成产品性能问题」的真实案例：先看
「所有 renderer 同时失败」这一信号，才能排除被测代码。

### 修复后第二次产品 CSS run：注入 bug 已消除，但原生 runner 上滚动不再提交

run 38636251441 的证据文件确认产品 CSS 确实带 SHA 进入了页面（`0ac6d781…`，
`mode: product`），几何错误消失。但两个平台的记录全部变成
`Scroll sample 3 did not commit: expected row 881, observed -1`——滚动到位后虚拟行
没有渲染出来。本机 Chromium 下同一份 CSS 三个 renderer 都能跑完并给出正常的
scroll p95，因此这不是 CSS 内容本身的问题，而是原生 WKWebView / WebView2 与合成
页面几何之间的差异。

结论要分开说：

- **已解决**：产品 CSS 注入装置本身可用、可复现、有 provenance、有回归测试。
- **未解决**：合成 benchmark 页面在原生 runner 上无法忠实承载真实产品布局，因此
  「真实 CSS + 原生 WebView」这组证据目前还不能作为归因依据。CSS 层面的候选目前
  只能在本机 Chromium 上筛查，不能进官方门禁。

这一步没有产生任何可计分的性能结论，Z1 门仍为 NO-GO。

### 滚动不提交的根因：产品 CSS 的行高与 benchmark 的虚拟行高不一致

run 38636251441 的错误是 `Scroll sample 3 did not commit: expected row 881,
observed -1`，即滚动到位后没有虚拟行出现。这不是原生 runner 的问题，而是布局口径
冲突：`components.css` 给 `data-grid-row` 与 `data-grid-header-cell` 声明
`min-height: 2.5rem`（40px），而 benchmark 按 `ROW_HEIGHT = 28` 排布虚拟行、按
header 28px 计算偏移。行实际比假设高 43%，滚动换算落在两行之间，于是取不到行。

之前一直没暴露，是因为产品 CSS 从未真正加载过——被测 bundle 里 CSS 文件数为 0。
本机 Chromium 在加载产品 CSS 后同样能跑通但行高被改写，只是 Chromium 的滚动采样恰好
落在行内，而原生 runner 更严格。

修复（`b88b7bc2`）：几何块把 row / header-cell 的 `min-height` 钉回 benchmark 口径，
header 钉回 28px，并补上 viewport 的 `--zw-data-grid-height`。本机以已发布的 beta.32
样式表复测 10k-x-50 与 wide-columns，zeus 与 workbench-table 全部跑完且 p95 正常。

这条再次印证本记录的主线：**每一次「性能异常」都要先问测量装置是否还成立**。
CSS 装置从「不存在」到「存在但嵌套」到「存在但行高冲突」，两次失败都发生在装置层，
都与 Zeus 的性能无关。

## 复核更新：run 38640001235

macOS 完整 80/80 条 `ok`；Windows 已完成的 38 条全部 `ok`，随后 WebDriver
POST navigation 30s 超时，证据不完整，已重跑失败 job。不能把 workflow 总失败等同于
布局验证失败。

macOS 同宿主 beta.31 → pinned beta.32（各 5 轮，中位数）：

| workload | scroll p95 | rafToTask | commit | textWrites |
| --- | --- | --- | --- | --- |
| 10k-x-50 | 36 → 40ms | 14 → 14ms | 2 → 2ms | 6762 → 6383 |
| wide-columns | 41 → 44ms | 22.5 → 21.5ms | 2 → 2ms | 6762 → 6382 |

10k 未显示改善；wide 的 1ms rafToTask 差异不能凭这 5 轮认定为稳定收益。

修正前文的归因强度：行高冲突是有代码依据且修正后原生 macOS 全部通过的解释，但
未单独隔离每条 CSS 的影响，不能声称已证明每个平台内部失败机制。此前“Chromium
采样恰好落在行内、原生更严格”的叙述没有观测证据，应撤回。

本模式仍是“加载产品 CSS、保留 benchmark 几何和部分视觉覆盖”的混合页面。它覆盖
了 cell padding、nowrap、ellipsis 等属性；因此 CSS 文件 SHA 只能证明字节被加载，
不能证明每条产品声明成为 computed style，也不能用于验证被覆盖属性的 CSS 候选。
完整产品布局与逐变体 computed-style provenance 仍待建立。Z1 改善目标尚未达成。

### commit 与 rAF 的顺序复核

对 run 38640001235 的完整 macOS artifact，逐样本检查 phase=sample 且具有完整
commit/rAF/task 时间戳的 Zeus 记录：四个 workload、两个变体，各 100 个样本。
**800/800 个样本的 commitEndTime <= nextPaintRafTime**；没有 commit 完整落在
rAF→task 区间内。10k 与 wide 的 commitStartTime − nextPaintRafTime 中位数均为
−2ms。因此这里的 rafToTask 不是“还在等待 Zeus 同步 commit”——commit 已在区间之前
完成。但区间仍混有可见性探针、布局/命中测试、后续呈现工作及计时器调度；没有进一步
分段之前，不可全部命名为 paint 成本。诊断 run 38665852661 用新字段分离探针结束
时间，证据尚在采集中。

## 原生平台探针分段结果（38665852661）

run 成功完成；macOS、Windows 各 48 条记录均为 ok。每 workload/变体 3 轮，下面为
phase=sample 的 60 个样本的中位数，单位 ms（不同分量中位数不可直接相加）：

| 平台/workload | Zeus beta.31 probe / after-probe | Zeus beta.32 probe / after-probe | WorkbenchTable probe / after-probe |
| --- | --- | --- | --- |
| Windows 10k | 5.0 / 2.1 | 4.8 / 2.0 | 0.1 / 2.1 |
| Windows wide | 6.5 / 2.15 | 6.5 / 2.1 | 0.1 / 2.0 |
| macOS 10k | 4 / 11 | 4 / 12 | 0 / 4 |
| macOS wide | 9 / 12 | 8 / 10 | 0 / 8 |

probe = nextPaintRafProbeEndTime − nextPaintRafTime；after-probe =
nextPaintTaskTime − nextPaintRafProbeEndTime。macOS 的 0 受时钟精度限制。

Zeus 存在明显的同步可见性读取成本，但不能全部称为纯测量开销。该读取包含
getBoundingClientRect 与 elementFromPoint，可能执行 DOM 写入后尚未完成的布局和
命中测试。WorkbenchTable 自身 render 路径已有同步测量，故 commit 区间与 probe
区间之间可能只是工作迁移。不能把低 commit 数字理解成全部浏览器渲染成本低。
下一步分离 rect 与 hit-test 耗时，避免未经证实就把整个差额命名为布局。
三轮诊断结果不计分，不构成 beta.32 性能达标证据。

## rect / hit-test 分离（38667024446）

两个原生平台各 48/48 条 ok，每 workload/变体 60 个 sample。中位数 ms：

| 平台/workload | Zeus beta.31 rect / hit | Zeus beta.32 rect / hit | WorkbenchTable rect / hit |
| --- | --- | --- | --- |
| macOS 10k | 3 / 0 | 3 / 0 | 0 / 0 |
| macOS wide | 8 / 0 | 9 / 0 | 0 / 0 |
| Windows 10k | 3.4 / 0.8 | 3.3 / 0.7 | 0 / 0.1 |
| Windows wide | 4.5 / 1.2 | 4.4 / 1.1 | 0 / 0 |

rect 是 viewport.getBoundingClientRect 的墙钟耗时；hit 是 elementFromPoint 加 closest。
macOS 的 0 受计时精度限制。Zeus 的差异主要在 rect 读取阶段，支持 pending style/layout
被同步读取触发的解释，不能再全部归为 paint 或纯探针开销。此测量未进一步划分 style
recalc 与 layout，也没有证明哪个具体生产节点造成代价。下一步应对重排范围、grid
track 计算与长文本测量做机制明确的单变量实验，不能因 rect 有成本就直接添加同步读取
把时间搬进 commit，或据此宣称性能改善。beta.31/32 在 10k rect 上无明显改善。

## 本机浏览器 trace：去掉探针后的布局仍存在

临时 CDP harness 在初始 benchmark 完成后开启 devtools.timeline，仅交替滚动 20 次，
每次等待两次 rAF 与后续 task，不调用可见性探针。此实验使用 Chromium headless、
产品 CSS 加 benchmark 覆盖，不是原生平台性能证据。普通与长文本均发生 20 次 Layout；
第一次采集累计分别约 24ms 与 38ms，RasterTask 累计约 92ms 与 155ms（跨线程累计，
不可与主线程时间直接相加）。这证明即使没有探针，布局/栅格工作仍然发生。

Layout beginData 显示典型 dirtyObjects=940、totalObjects=1036。分别对行与单元格
设置 contain:layout style 后，dirtyObjects 仍为 940；没有观察到缩小失效范围，
长文本 Layout 累计还从基线约 37ms 变为行隔离约 62ms、单元格隔离约 50ms。单次
顺序采集不能用于效益估计，但足以否定“此 containment 在该场景减少 dirty 对象数”
这一预测。不据此修改生产代码，也不把普通文本局部下降解释为收益。
临时 trace 保存在 /tmp/z1-layout-*.json，未混入提交或 admission evidence。

## 固有宽度隔离与 flex 布局对象的临时实验

Chromium 同一临时 harness 做 baseline / inline-size / baseline / inline-size 顺序采集。
contain:inline-size 下普通文本 20 次 Layout 累计约 48/43ms，基线约 37/36ms；长文本
方向不一致（候选约 46/53ms，基线约 43/62ms）。不支持此候选，未改产品代码。

单元格源码直接包含文本，没有可删除的 DOM wrapper；产品样式令其 display:flex。
临时对实际 DOM 的 cell.style.display='block' 后，Layout 记录中 dirtyObjects 从
940 降到 635，totalObjects 从 1036 降到 714，普通/长文本都一致。这里改变的是浏览器
生成的布局对象，DOM 节点数不变。两轮顺序采集的普通 Layout 总耗时为基线 29/43ms、
block 22/40ms；wide 为基线 35/45ms、block 37/43ms，尚无稳定时长收益。直接 block
也会改变文本垂直对齐，因此不能当作可发布修复。后续若探索此方向，必须保持对齐语义、
核实 computed style 与像素结果，并使用真正不同的样式变体做官方配对验证。
本实验写的是实际 DOM inline style，明确进入被测页面，区别于此前未加载的源 CSS A/B。
