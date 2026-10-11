# Zeus 性能门不可满足的外部阻塞

日期：2026-10-11

关联报告：[2026-10-09-zeus-performance-root-cause.md](./2026-10-09-zeus-performance-root-cause.md)

正式证据：[workflow run 38127420887](https://github.com/baicie/nyala-studio/actions/runs/38127420887)，revision `d2a6a5a87d095f91b3d7db4e24168f8f05e1320a`，来源 `mvp`，`repeat=5`，依赖闭包为 `@zeus-web/data-grid@0.1.0-beta.22` + `@zeus-js/*@0.1.1-beta.7`。

## 结论

Z1 仍为 `NO-GO`，但**三项失败均不可通过修改 Zeus 或 zeus-ui 的实现来消除**。逐项定性如下：

| 门 | 结果 | 定性 |
| --- | --- | --- |
| Windows WebView2 `10k x 50` 改善 ≥20% | `-3.0%` | **算术不可满足**：要求值低于任何 renderer 达到过的最好成绩 |
| macOS WebKit `1k x 20` 回归 ≤10% | `26.9%` | **本地不可复现**：真实 WKWebView 上两者完全相等 |
| Zeus 依赖 gzip ≤30000 B | `30072 B` | **无可诚实削减项**：超 72 字节，候选削减点均语义承重 |

因此本轮保持 `Z1.3 = NO-GO`，不启动 Z2/R0，并且**不修改阈值、不删除失败样本、不弱化真实平台 gate**。

## 1. Zeus 提交本身没有性能问题

本地 Chromium diagnostic profile（当前源码自建 bundle，`10k x 50`，`repeat 3`，真实 `--diagnostic-profile`）：

```text
commit 耗时中位数   1.4 ms    p95 1.7 ms
每次滚动的 DOM churn   0       （max 0）
```

Zeus 在已发布的 fixed keyed `<For>` 快路径下，每次滚动提交的 JS 成本约 1.4ms，且没有节点增删。这与「Zeus 全量渲染慢」或「行模型重建慢」的假设不符。

## 2. 共同瓶颈是测量边界，不是 renderer

`10k x 50` 场景下 Zeus 的 settle 恒定在 ~15.3ms，并且**跨 1k/10k/wide/narrow 所有负载完全不变**——这是帧下限特征，不是工作量特征。

仓库自带的 `presentationFloor` 探针跑一个**空循环**：只等待测量边界（`rAF` + `setTimeout(0)`），不做任何 renderer 工作。实测：

```text
空循环 floor p95        18.7 ms
baseline (workbench-table) p95  19.1 ms
门要求 zeus p95 <=      15.28 ms   （= 19.1 x 0.8）
```

**要求的数值比一个什么都不做的测量循环还低 3.4ms。** 仓库自带的可行性分析器独立给出同样结论：

```text
conclusion:                       PRESENTATION_FLOOR_LIMITED
maximumFloorBoundedImprovement:   2.1%
```

正式平台证据一致。Windows `10k x 50` 要求 ≤13.1ms，而该负载下任何 renderer 达到过的最好成绩是 16.4ms：

```text
windows-webview2 10k-x-50  gateMetric={native:340, workbench-table:16.4, zeus:16.9}
baseline=16.4  requiredZeus<=13.1  bestAchievableByAnyRenderer=16.4
=> REQUIRED IS BELOW THE MEASUREMENT FLOOR: unsatisfiable
```

## 3. macOS `1k x 20` 回归在本地真实 WKWebView 上不可复现

本机为 macOS，已构建 webdriver 版 Nyala debug 二进制并用与 CI 相同的
`scripts/benchmark-sql-result-grid-webdriver.mjs` 跑真实 WKWebView，`1k x 20`、`repeat 5`、balanced rotation：

```text
 # 2 workbench-table  p95=34.0  input= 7.0  settle=26.0
 # 3 zeus             p95=34.0  input= 0.0  settle=33.0
 # 4 workbench-table  p95=34.0  input= 7.0  settle=26.0
 # 5 zeus             p95=34.0  input= 0.0  settle=33.0
...
 #14 zeus             p95=35.0  input= 0.0  settle=33.0
```

本地 Zeus 与 WorkbenchTable 的**总耗时完全相等（33.0ms vs 33.0ms）**。所谓 7ms「回归」恰好等于 input/settle 分界线的平移量：

```text
workbench-table  input= 7.0 + settle=26.0 = total=33.0
zeus             input= 0.0 + settle=33.0 = total=33.0
```

CI 上 macOS 1k 的 26.9% 回归与本地这组 0% 差异矛盾。结合统计检验（对数尺度 Welch t，n=5/平台）：

| 场景 | delta | p 值 | 判定 |
| --- | --- | --- | --- |
| macOS 1k 回归 26.9% | +26.9% | 0.004 | 可区分于噪声 |
| macOS 10k 改善 22.7% | -22.7% | 0.093 | 噪声 |
| Windows 1k 回归 6.7% | +6.7% | 0.000 | 可区分 |
| Windows 10k 改善 -3.0% | -3.0% | 0.433 | 噪声 |

即便取可区分的 macOS 1k，其幅度也与本机实测的 0% 不符，不能归因于 Zeus 实现。

单次长尾足以翻转结论：

```text
macos-webkit 10k-x-50 native   ordinals=[44, 238, 87, 44, 43]  spread=453%
windows-webview2 10k-x-50 zeus ordinals=[16.9, 16.9, 56.3, 18.1, 16.9] spread=233%
```

在 5 个样本上做 p95 判决，噪声大于信号。

## 4. gzip 超预算没有可诚实削减的项

本地精确复现（esbuild 0.28.1，`--bundle --format=iife --platform=browser --minify --legal-comments=none`，入口 `dist/wc/auto.js`）：`90615 B` / gzip `30028 B`，预算 `30000 B`，超 28–72 字节。

体积构成（`bytesInOutput`）：

```text
data-grid 自身 chunk      41029
@zeus-js/runtime-dom       23395
@zeus-js/signal/internal   16348
@zeus-js/web-c-runtime      6250
其余                        3365
```

已确认无死重：prod bundle 中零 `__DEV__`、零 `Zeus warn`；`watch` / `traverse` / `queueJob` / `createRuntimeDiagnosticsSession` 已完全 tree-shake；200 字符块哈希扫描零重复；导出面已收敛。

唯一诱人的削减点是 `packages/core/runtime-dom/src/defineElement.ts` 中 `state<unknown>()` 的静态导入，它把整个 Proxy 响应式层（`base` + collection handlers + array instrumentations，约 6.1KB raw / 2.4KB gzip）拖进 bundle。但这是语义承重的：`reactivity: 'deep'` 的深层响应实际发生在 `RefImpl` setter 的 `toReactive(newValue)`（`packages/core/signal/src/ref.ts`），slot 创建时为空、之后填充。改用 `shallowState` 会静默破坏深层 props 响应性。

拆分 diagnostics（bundle 内 165 处符号、21 个 `MutationObserver` 引用）风险高，且全部在用（`beginDiagnosticsNodeChurn` 有两处调用点），收益远小于 72 字节。

为省 72 字节去改响应式语义或大改诊断架构，是拿正确性换分数，不做。

## 解除阻塞所需的唯一路径

三项失败都指向同一个根因：**v6 measurement contract 无法区分 renderer 工作与宿主 WebView 呈现等待**。仓库 2026-10-09 报告第 86 行已提出同一方向。

建议演进到 v7：

1. 保留并冻结 v6 历史结果，不改写既有证据。
2. v7 记录真实输入确认、idle rAF floor、jank rate、renderer CPU interval、one-frame correctness。
3. 当 baseline 低于可辨识下限时，把该场景标为 `NOT-EVALUABLE`，而不是让它产生必然失败的判决。

这样 macOS `1k x 20` 的真实回归仍会被 v7 捕获，而 10k 那个物理上无法满足的门不再产生假信号。

在此之前，Z1 保持 `NO-GO`，Z2/R0 保持阻塞。
