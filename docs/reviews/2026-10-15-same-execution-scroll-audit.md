# 同次滚动执行诊断：恢复尚未完成的性能归因

日期：2026-10-15。Z1 仍为 `NO-GO`，ADR 0005 仍为 `Proposed`。

## 结论与范围修正

现有证据没有证明 Zeus/zeus-ui 已无可优化空间，也没有证明修改性能门是唯一后续路径。
此前把 `commit` 中位数约 2–3ms 解释为“框架只影响总延迟的 5%”，再把剩余部分全部
归为宿主的说法超出了证据。DOM 写入引起的后续样式、布局和绘制仍可能受 renderer
实现影响；WorkbenchTable 与 Zeus 的同步布局读取位置也不相同。

代码审计还确认：平台 workflow 启动真实 Nyala debug WebView，然后整页导航到独立
benchmark HTML。该文档加载审计 Zeus bundle，以及仓库真实 WorkbenchTable 类和
benchmark 服务桩；它没有启动完整 Workbench 外壳。因此不能将这批数据直接归因为
Nyala SQL contribution、编辑器或完整 Workbench 的滚动管线。

输入也有明确范围：primary 从 JavaScript 设置 scroll controller 的 `scrollTop` 开始，
不是系统滚轮/触控输入延迟。WorkbenchTable setter 同步驱动逻辑滚动模型，Zeus
setter 写原生 DOM 滚动位置。这个差异存在，但尚不能据此判定某一方的生产实现有缺陷。

对应入口：

- [`benchmark-sql-result-grid-webdriver.mjs`](../../scripts/benchmark-sql-result-grid-webdriver.mjs)：生成页面、整页导航、viewport 校准和延后启动。
- [`benchmark-sql-result-grid.mjs`](../../scripts/benchmark-sql-result-grid.mjs)：`createBenchmarkPage`、`commitScroll`、`renderZeus`。
- [`sql-result-grid-workbench-table-entry.ts`](../../scripts/sql-result-grid-workbench-table-entry.ts)：服务桩及逻辑滚动 adapter。
- [`采集器可比性审计`](./2026-10-14-collector-comparability-audit.md)：两侧 commit 边界与布局读取的不对称。

## 为什么新增同次执行诊断

旧 segment trace 在另一轮导航中重新渲染；它在 setter 后先等待 `setTimeout(0)`，
然后在 rAF 回调内执行几何读取和 hit test。primary 则直接进入原 presentation wait，
在后续 task 返回后才验证可见行。两者相同的 sampleIndex 代表相同输入计划，不能用于
逐样本相减，也不能用 trace 的 rAF→task 数值拆分 primary。

新的 `--same-execution-profile true` 只为诊断记录同一次 `commitScroll` 的时间线：

- 复用原 input 开始/结束与总耗时时间点。
- 通过原 `waitForPresentationOpportunity` 已有的 API 注入点，记录现有 rAF 与
  after-frame timer 入场，不增加帧、timer、await 或 DOM 读取。
- 对原有 `offsetHeight` 与可见行校验记录边界，不在 rAF 内额外读取布局。
- 保留同次 `beginOperation/endOperation`，把实际 renderer transaction IDs 关联到
  这一次输入，并保留原可见行校验结果。

此诊断必须启用 renderer callbacks，禁止 node-churn observer，不与另导航 trace 混用。
报告及 raw records 明确标为诊断、`admissionGrade=false`；gate/compare 还独立拒绝任何
带同次执行诊断标识或 sample 字段的产物，不能只靠顶层字段声明阻止误计分。

这些时间戳仍是墙钟边界。rAF→task 包含浏览器工作及调度，不是独立测得的宿主成本；
validation 的同步读取也不是全部布局耗时。renderer intervals 可能与 setter、wait
区间嵌套，不能重复相加。观察到正确行不等于测到了物理屏幕呈现时刻。

## 本机原型与局限

在接入正式诊断开关之前，临时原型以 beta.32 JS 和 product CSS 加 benchmark 几何
覆盖，交错运行原页、仅加时间戳、时间戳加 callbacks 三组。它用于验证插桩路径，不能
代表默认 inline CSS 的完整正式门禁，也不作为性能收益证据。

本机 headless Chromium 三个 workload、两侧 renderer、三组、三轮，共 54 条记录
全部成功。`scrollP95Ms` 的三轮中位数如下，单位 ms：

| workload     | renderer       | 原页 | 时间戳 | 时间戳 + callbacks + 浏览器 trace |
| ------------ | -------------- | ---: | -----: | --------------------------------: |
| 1k-x-20      | Zeus           | 17.7 |   17.4 |                              17.7 |
| 1k-x-20      | WorkbenchTable | 17.1 |   17.1 |                              17.5 |
| 10k-x-50     | Zeus           | 17.6 |   18.3 |                              18.2 |
| 10k-x-50     | WorkbenchTable | 17.5 |   17.5 |                              17.6 |
| wide-columns | Zeus           | 17.6 |   19.4 |                              18.9 |
| wide-columns | WorkbenchTable | 17.7 |   17.5 |                              17.5 |

同次 browser trace 的 10k pooled sample 中位数为：Zeus Layout 约 1.49ms、style
约 0.11ms，WorkbenchTable 约 2.69ms、0.43ms。它只说明两侧确实在同步调用之外/之内
执行浏览器工作，不能将这些数值外推为原生 WebView 的占比或可消除的延迟预算。

仅加时间戳与原页的尾部也有差异，尤其是 wide；callbacks 组还同时启用了 Chromium
trace，没有单独隔离 trace 开销。因此这不是“零扰动已校准”的证明。原型还使用页面
轮询等待结果，增加了任务；后续原生复核改用 HTTP 结果通道，避免测量期间轮询 WebView。

本机 WKWebView 第一轮原型仅完成 21 条记录，临时脚本在收到下一条结果前结束等待，
不能作为完整对照。保留该不完整记录后，改用 HTTP 结果通道与显式等待预算，单独复测
10k，共 18 条记录全部成功；原页/时间戳/callbacks 的 p95 中位数为 Zeus
39/35/35ms、WorkbenchTable 45/36/35ms。此处空循环参考中位数约 33ms，且 control
侧单轮 p95 有 62/78ms 离群；不能把组间下降当作插桩带来的收益，也不能据此排除生产优化。

临时文件保留于 `/tmp/z1-same-execution*.mjs`、`/tmp/z1-same-execution-results.json`、
`/tmp/z1-same-native-attempt1.json`、`/tmp/z1-same-native-results.json`。它们不加入 admission
artifact；原型与正式开关的计时字段不同，不混算。

## 集成后的真实本机 WKWebView 验证

直接使用仓库新开关、默认 inline CSS、beta.32 bundle，在真实 embedded WKWebView
运行三个 workload、两个 renderer 各一轮：6/6 records 成功，120/120 个滚动 sample
具有完整有序时间线、正确可见行、同次 renderer operation 以及窗口内的 commit。
报告明确 `admissionGrade=false`，未附加另一次导航的 segmentTrace。

这次 10k/Zeus 的 27ms 最长样本可以直接由同一时间线定位：input 开始到 handler
约 9ms、handler 到 commit 结束约 2ms、rAF 到 after-frame task 约 16ms，最后校验
小于时钟分辨率。另一个 25ms 样本则约为 18/1/6ms。两种长样本的增长发生在不同
区间，不能再用“tail 与 body 的 commit 一样”去排除整个 renderer 路径。

wide/Zeus 的 28ms 样本约为 1ms 到 handler、1ms 到 commit 结束、25ms rAF→task
加约 1ms 校验。新路径没有 rAF 内布局探针，但该 25ms 仍可能包含 renderer 写入
引起的浏览器工作和 timer 调度，尚未分离；这是可继续验证的区间，不是纯宿主归因。

此一轮的 p95 为 10k Zeus/WorkbenchTable 25/18ms、wide 28/17ms。它们都是带
callbacks 和新标量时间戳的诊断数值，不能拿来替代未插桩准入结果。原始文件位于
`/tmp/z1-integrated-same-execution/platform-evidence.json`。

## 下一步与验收边界

使用默认 inline CSS、同一 beta.32 bundle，在真实 macOS WKWebView 与 Windows
WebView2 上采集新开关的数据。每条 sample 的时间线、原可见行结果和 renderer operation
必须来自同次输入；完整性校验通过以后，再选择生产代码假设。

下一次生产修复必须能说明它减少了哪项工作，并在原端到端指标上重现收益，同时覆盖
1k 回归条件。在找到和验证这样的改动之前，Zeus/zeus-ui 版本保持 beta.13/beta.32，
不发布无证据候选，不把诊断开关、门禁改名或状态变更当作目标完成。
