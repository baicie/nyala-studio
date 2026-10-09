# Zeus 性能准入根因报告

日期：2026-10-09

范围：Nyala `mvp` 上的 Zeus Data Grid beta.5 集成、Chromium 基准、macOS WKWebView 和 Windows WebView2 真实平台采集，以及 zeus-ui beta.5 源码路径。本文回答性能门为什么仍为 `NO-GO`，并给出可以验证的修复顺序。

## 结论

当前结论不是“Zeus 在所有场景都比 WorkbenchTable 慢”。真实采集显示：

1. **Z1.3 仍为 `NO-GO`，原因是两个具体门失败。** Chromium `10k x 50` 的 Zeus p95 为 `26.3ms`，WorkbenchTable 为 `20.7ms`，相对改善 `-27.1%`；macOS `1k x 20` 的 Zeus p95 为 `38ms`，WorkbenchTable 为 `32ms`，回归 `18.8%`，超过 `10%` 上限。
2. **10k 的失败不是跨平台、稳定的 Zeus 算法性退化。** macOS `10k x 50` 为 `37ms vs 51ms`，Windows 为 `20ms vs 27.3ms`，两者都达到超过 `20%` 的改善门。Windows `1k x 20` 也只有 `6.0%` 回归并通过。
3. **已证实的共同瓶颈在外层滚动完成时间的测量链路。** v6 指标包含输入分派、调度、浏览器呈现机会、布局读取和可见行校验，不是 Zeus renderer CPU 时间。轻量基线接近一帧呈现下限时，20% superiority 目标会被共同的 scheduling/presentation floor 和 p95 长尾淹没。
4. **macOS 1k 回归是真实平台风险，主要表现为 WKWebView 的呈现/调度尾部。** Zeus 和 WorkbenchTable 的 DOM 数量几乎相同，Windows 同负载差距很小；现有证据不支持把它归因于全量 DOM、10k 行模型重建或通用 Zeus signals 慢。
5. **zeus-ui 中存在可验证的高相关路径，但尚未证明是唯一根因。** scroll event 经 `requestAnimationFrame` 合并后执行 `updateRange`；该函数随后读取滚动和 viewport 状态、计算行列 snapshot，并同时提交两个 signal。这个路径应做 A/B 和分段 trace，再决定是否改动 scheduler 或 snapshot 提交。

因此，当前应保持 `Z1.3 = NO-GO`、不启动 Z2。修复目标应先让测量能够区分 renderer 工作与 WebView 呈现等待，再针对 macOS 的真实尾延迟优化。

根因分级如下：

- **已证实：** v6 completion boundary 由 scroll setter、宿主 WebView 调度、`rAF + setTimeout(0)` 呈现机会和校验共同决定；正式样本都在第一次呈现机会完成。macOS 1k 的 Zeus 长尾主要落在 settle 阶段，而 Windows 同场景的差距很小，说明平台时序是主要已证实因素。
- **强相关但待验证：** zeus-ui 的 rAF scheduler、每次 scroll 的双轴 snapshot 更新和 pooled slot reactive/style 更新可能放大 WKWebView 尾延迟。需要 DOM-observer-free 分段 trace 和单变量 A/B 才能定责。
- **已排除或低优先：** 10k 全量 DOM churn、滚动时全量行模型重建、固定行高下的 SizeCache 慢路径、诊断 MutationObserver 成本，以及“Zeus 稳定多等一整帧”。

## 证据边界

正式平台证据来自 [GitHub Actions run 37937953442](https://github.com/baicie/nyala-studio/actions/runs/37937953442)，revision 为 `bf0040a4c2f694cb093d22c31588eb82b382db4a`，来源为 `mvp`，`repeat=5`。macOS WKWebView、Windows WebView2 及 aggregate jobs 均完成，四个 artifact 均可复核。aggregate gate 的关键数值如下：

| 场景                | WorkbenchTable p95 | Zeus p95 | 结果                |
| ------------------- | -----------------: | -------: | ------------------- |
| Chromium `1k x 20`  |           `17.4ms` | `18.3ms` | 回归 `5.2%`，通过   |
| Chromium `10k x 50` |           `20.7ms` | `26.3ms` | 改善 `-27.1%`，失败 |
| macOS `1k x 20`     |             `32ms` |   `38ms` | 回归 `18.8%`，失败  |
| macOS `10k x 50`    |             `51ms` |   `37ms` | 改善 `27.5%`，通过  |
| Windows `1k x 20`   |           `16.6ms` | `17.6ms` | 回归 `6.0%`，通过   |
| Windows `10k x 50`  |           `27.3ms` |   `20ms` | 改善 `26.7%`，通过  |

本地 diagnostic profile 只用于归因，不是 admission evidence。它观察到 10k 场景 Zeus renderer interval union p95 约 `2.0ms`、WorkbenchTable 约 `4.5ms`，Zeus 的 range 计算约 `0.2ms`，并且没有持续的 node churn。这说明外层 p95 不能直接当作 renderer CPU；这些数字不能替代双 WebView gate。

正式平台每个平台、每个 renderer 的 20 个滚动样本均为 `attempts=1`、`presentationOpportunities=1`。这排除了“Zeus 在正式采样中稳定多等一次呈现机会”的说法。原始时间还显示平台方向会反转：macOS 1k 的 Zeus input 约 `1ms`、settle 约 `37–47ms`，WorkbenchTable input 约 `20ms`、settle 约 `14–21ms`；Windows 则 Zeus input 约 `0.1ms`、settle 约 `17ms`，WorkbenchTable input 约 `7–16ms`、settle 约 `7–15ms`。Windows 10k 中 WorkbenchTable 的长尾甚至主要来自 setter/input（`127–133ms`），而 Zeus input 约 `0.1ms`。这组反转是“scroll setter → WebView 调度 → presentation boundary”主导 v6 p95 的直接证据。

另一个发布事实也必须保持准确：`@zeus-web/data-grid@0.1.0-beta.5` 的实际依赖闭包仍声明 Zeus core `0.1.1-beta.2`。Zeus core `0.1.1-beta.3` 已发布，但 beta.5 并未因此消费 core beta.3。该问题属于发布闭包一致性，不是本次性能失败的证明。

## 根因链

### 1. v6 指标把呈现等待和 renderer 工作合在一起

Nyala 的 `commitScroll` 在设置滚动位置后，等待 `requestAnimationFrame` 加 `setTimeout(0)`，再读取 layout、检查实际 offset 和可见行。实现位于 [`scripts/benchmark-sql-result-grid.mjs`](../../scripts/benchmark-sql-result-grid.mjs:1058)。因此 `scrollP95Ms` 包含：

```text
scroll setter
→ 浏览器事件/布局调度
→ renderer 更新
→ 一次或多次呈现机会
→ layout read + visible-row validation
```

在 diagnostic profile 中，共同 presentation floor 已接近轻量 WorkbenchTable 基线。Chromium `10k x 50` 的一次长尾就足以把 p95 从 `20.7ms` 推到 `26.3ms`；而 macOS/Windows 的 10k 真实平台结果却显示 Zeus 更快。这是当前 20% 门对轻量基线可辨识性不足的直接证据，不是可以通过删样本或事后降低阈值解决的问题。

### 2. macOS 1k 的主要风险是 WKWebView scheduling/presentation tail

macOS `1k x 20` 的失败值来自五次真实 run；同场景 Windows 的 Zeus 与 WorkbenchTable 只差 `1.0ms`。macOS 两个 renderer 的 DOM 规模分别约为 Zeus `405`、WorkbenchTable `404`，而 10k 也没有出现 Zeus 持续扩大 DOM 的现象。现有数据更符合 WebKit 对输入时相、rAF、布局和呈现完成的组合尾延迟，而不是“Zeus 创建了 10k 行 DOM”。

这一判断仍需用分段 trace 完成闭环：必须同时记录 input、handler、range、commit、first visible row 和下一次 paint/呈现机会；仅凭最终 p95 不能把每一毫秒归给某个函数。

### 3. zeus-ui scroll path 是强相关的可优化点

beta.5 的 Data Grid 在 [`data-grid.tsx`](../../../zeus-ui/packages/advanced/data-grid/src/components/data-grid.tsx:543) 创建 `createRafScheduler()`。scroll listener 在 [`data-grid.tsx`](../../../zeus-ui/packages/advanced/data-grid/src/components/data-grid.tsx:1498) 到 [`data-grid.tsx`](../../../zeus-ui/packages/advanced/data-grid/src/components/data-grid.tsx:1571) 将事件合并到下一次 rAF，再执行 `updateRange`。

`updateRange` 在 [`data-grid.tsx`](../../../zeus-ui/packages/advanced/data-grid/src/components/data-grid.tsx:1417) 到 [`data-grid.tsx`](../../../zeus-ui/packages/advanced/data-grid/src/components/data-grid.tsx:1437) 中会读取 scroll offset、client height、client width，计算行和列 snapshot，并在一个 batch 中同时发出两个 snapshot 更新。这个设计有利于合并高频 scroll，但在低负载且接近一帧下限的场景，rAF 时相和双轴更新都可能把浏览器呈现尾部放大。

当前只能说它是**强相关机制**，不能说它已经被证明是 macOS `+18.8%` 的唯一根因。验证方法是单变量 A/B：保留事件合并，分别测试 DOM-observer-free immediate flush、现有 rAF、以及只更新垂直 row snapshot 的路径，并记录分段时间和 one-frame correctness。

### 4. 大规模 DOM、全量模型构建和 SizeCache 不是当前首要根因

beta.5 已经使用固定容量 row pool：[`grid-virtualizer.ts`](../../../zeus-ui/packages/advanced/data-grid/src/core/grid-virtualizer.ts:102) 到 [`grid-virtualizer.ts`](../../../zeus-ui/packages/advanced/data-grid/src/core/grid-virtualizer.ts:113) 固定窗口槽位；row wrapper 也有有限缓存：[`row-model.ts`](../../../zeus-ui/packages/advanced/data-grid/src/core/row-model.ts:60) 到 [`row-model.ts`](../../../zeus-ui/packages/advanced/data-grid/src/core/row-model.ts:88)。真实采集的 DOM 数量和 diagnostic 的 `created/removed nodes` 没有显示 10k 全量渲染。

固定容量和 key 都保持时，runtime-dom 的 keyed list 只更新已有槽位，路径在 [`list.ts`](../../../zeus/packages/core/runtime-dom/src/list.ts:220) 到 [`list.ts`](../../../zeus/packages/core/runtime-dom/src/list.ts:241)。窗口长度或 key 发生变化时，才会进入建 Map、创建/销毁 scope、`moveBefore` 的 fallback，见 [`list.ts`](../../../zeus/packages/core/runtime-dom/src/list.ts:244) 到 [`list.ts`](../../../zeus/packages/core/runtime-dom/src/list.ts:330)。这是值得单独做边界 A/B 的候选，但没有当前 run 的分段证据证明它主导失败。

同理，固定行高下 `SizeCache` 使用乘法/除法快路径；现有采集没有落到“测量尺寸导致全量 offset 扫描”的证据。暂不应先改 Zeus core signals、通用 scheduler 或 SizeCache。

## 修复建议

### P0：先修测量可辨识性，再做性能改动

1. 新增 v7 floor-aware diagnostic 通道，保留并冻结 v6 历史结果。v7 记录真实输入确认、idle rAF floor、jank rate、renderer CPU interval、one-frame correctness，并将 baseline 低于可辨识下限的场景标为 `NOT-EVALUABLE`。
2. 在 DOM-observer-free 状态下做双平台分段 trace；trace 为了取得 handler/range/commit 边界仍启用 `onCommit` 回调，因此不能把它当作零诊断开销数据，也不能替代性能门。
3. 继续使用成对、平衡的 renderer 顺序；每次记录 source revision、bundle digest、WebView 身份和原始 samples。不得删掉长尾样本来让 p95 通过。

### P1：验证并收窄 Zeus scroll path

1. 给 scheduler 增加实验开关：现有 rAF、单事件 immediate flush、以及 frame-coalesced 但不重复读取 viewport 的模式。只改变一个变量，先在 Chromium 本地建立高重复率反馈环，再用 macOS WKWebView 重测。
2. 缓存 `clientWidth/clientHeight`，仅在 ResizeObserver/resize 路径更新；垂直 scroll 未改变横向 offset 时，不重新提交 column snapshot。
3. 对窗口边界单独做固定容量与 wrapper reuse A/B，观察 keyed fallback、GC、commit interval 和可见性正确性。保留焦点、ARIA identity、变量行高、排序和行替换语义。
4. 每次生成包重新核对 gzip 预算。beta.5 当前约 `29,978 / 30,000` bytes，只剩 `22` bytes 余量；任何池化或诊断代码都可能直接越过门槛。

### P1：修正发布闭包后再采集

如果产品目标是评估 Zeus core `0.1.1-beta.3`，应由 zeus-ui 发布声明 beta.3 闭包的新 beta 包，再由 Nyala 独立核对 npm metadata、tarball integrity、依赖闭包和 bundle digest。当前 beta.5 只能作为 core beta.2 闭包记录，不能把 core beta.3 的发布时间当作已集成证据。

## 验收门槛

在以下条件全部满足前，性能结论不翻为 `GO`：

- macOS `1k x 20` 回归不超过 `10%`，并有足量 raw samples；
- 选定的 10k 主场景在可辨识的 v7 合同下达到预注册改善目标；
- 分段 trace 能区分 scheduler、renderer commit 和 WebView presentation tail；
- one-frame visible-row correctness、横纵向真实位移和焦点/ARIA 行为保持通过；
- 两个原生 WebView 的 artifact、revision、bundle digest 和 workflow provenance 完整；
- Zeus 依赖闭包与要评估的 core 版本一致。

在这些条件满足前，Z2 不启动，R0 保持 `NO-GO`。

## 已执行验证

- GitHub Actions `37937953442`：macOS WKWebView 与 Windows WebView2 jobs 成功，aggregate gate 按上述两个性能门返回 `NO-GO`。
- beta.5 audit：依赖闭包、integrity、bundle 与 gzip budget 校验通过；实际 gzip 为 `29,978` bytes。
- 本地 diagnostic profile：确认 Zeus 不是 10k 全量 DOM 或显式 node churn 主导；诊断结论仅作归因，不作 admission evidence。
- zeus-ui 源码审计：确认 scroll event → rAF scheduler → `updateRange` → row/column snapshot 提交链；未发现足以单独解释所有失败门的通用 signals 或 SizeCache 瓶颈。

本报告只新增分析文档，没有修改生产代码、门禁阈值或 Z1 gate 快照。

## 2026-10-10 诊断进展

为下一轮真实 WebKit/WebView 采集增加了两层诊断入口。`traceProfile` 默认关闭且不安装 Zeus diagnostics，只记录每个滚动样本的 `inputMs`、presentation wait、可见行校验和 `totalMs`。`segmentTrace` 是单独导航的更细分 trace，显式关闭 node-churn MutationObserver，但保留 `onCommit` 时间回调以取得 handler/range/commit 边界，记录 setter、首个可见行和 rAF/task 呈现代理。Chromium 与 embedded WebDriver 入口均可通过 `--trace-profile true` 透传；正式 gate 没有启用这些参数，v6 admission 结果不变。

源码审计和既有测试进一步确认：beta.5 的 scroll 路径已经复用缓存的 `clientWidth/clientHeight`，scroll 时每个 row/column snapshot 各计算一次；`data-grid-snapshot-cache` E2E 与 scheduler 单元测试通过。因此“重复 viewport 读取”不能作为新的生产修复结论。scheduler A/B 仍应使用 test/benchmark-only 注入：A 为现有 rAF，B 为只针对单事件 scroll 的 immediate flush，C 作为当前实现的控制组。尚未在 macOS WKWebView 上运行新 trace，也没有足够证据改变 `Z1.3 = NO-GO` 或解除 `Z2/R0` 阻塞。

本轮诊断验证：Nyala benchmark 相关测试 `103/103` 通过，gate 测试通过，`git diff --check` 通过；本地 Chromium segment trace smoke 产出 22 段并保持可见行校验通过。尚未在 macOS WKWebView 上执行真实 trace；rAF/task 是呈现代理，不是真实 GPU paint event。当时尚未修改 Zeus core、zeus-ui 生产代码、性能阈值或 gate 快照；后续生产修复记录见下节。

## 2026-10-10 生产修复与 beta.6 候选

根据上述高相关路径，zeus-ui 已在候选提交 `7dbc18e` 实现最小生产修复：当原生滚动只改变垂直偏移时，Data Grid 复用已提交的 column snapshot，跳过 `getColumnSnapshot` 和无效的模型路径；仍读取一次 `scrollLeft`，因此横向或双轴滚动会重新计算列窗口。`getColumnSnapshot` 接收已读取的偏移，横向路径不会重复读取 DOM 属性。mount、resize、data、API 和缓存失效路径继续完整刷新。

zeus-ui 候选版本已准备为 `0.1.0-beta.6`，所有 `@zeus-js/*` 依赖和 peer 已对齐 `0.1.1-beta.3`，从而实际消费已发布的 Zeus core beta.3。Nyala 的平台 workflow、审计构造器及 gate/release 校验已同步到 beta.6/beta.3。候选包尚未完成远端合入和 npm 发布，因此当前没有新的真实 WebKit/WebView admission evidence。

候选验证已通过：zeus-ui snapshot-cache E2E `17/17`、Data Grid E2E `109/109`、benchmark `12/12`、完整 release dry-run；Nyala benchmark 相关测试 `103/103`、Zeus audit `3/3`、release verifier `35/35`、gate 测试均通过。这些结果证明修复和发布闭包可构建，但不能替代 macOS WKWebView 与 Windows WebView2 的正式采集。

因此当前结论仍为 `Z1.3 = NO-GO`、`Z2/R0` 阻塞。beta.6 发布并完成真实双 WebView 采集后，只有在 macOS `1k x 20` 回归不超过 `10%` 且预注册 10k 门满足时，才更新准入结论；不修改阈值、gate 快照或失败样本。
