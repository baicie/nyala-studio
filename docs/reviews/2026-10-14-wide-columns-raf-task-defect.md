# wide-columns 上 Zeus 独有的 rafToTask 异常

## 现象

用 run38552402643 的官方真实平台证据按 workload 拆开看，Zeus 在 `wide-columns` 上
明显异常，而在 `1k-x-20` / `10k-x-50` 上正常。

各 workload 的 rafToTask 中位数（ms）：

| workload | macOS zeus | macOS native | macOS WBT | Windows zeus | Windows native | Windows WBT |
|---|---:|---:|---:|---:|---:|---:|
| 1k-x-20 | 14.0 | 10.0 | 7.0 | 5.7 | 9.1 | 1.9 |
| 10k-x-50 | 16.0 | 18.0 | 8.0 | 5.8 | 23.3 | 2.3 |
| **wide-columns** | **25.0** | **6.0** | **8.0** | **9.4** | **4.3** | **2.3** |
| narrow-panel | 4.0 | 3.0 | 2.0 | 2.5 | 6.8 | 1.1 |

`wide-columns` 是唯一一个 Zeus 明显高于另外两个 renderer 的 workload：macOS 上
25ms 对 6–8ms，Windows 上 9.4ms 对 2.3–4.3ms。

按门禁口径（scrollP95 中位数对比，阈值 20% 改善）：

| workload | macOS 改善 | Windows 改善 |
|---|---:|---:|
| 1k-x-20 | −4.9% | −16.1% |
| 10k-x-50 | +14.0% | +30.8% |
| **wide-columns** | **−95.8%** | **−36.0%** |

也就是说 Z1 门在 `wide-columns` 上是**回退**，而且幅度很大。这与 10k 路径的结论
完全不同：那里 Zeus 贴在 vsync 地板上、无可优化空间；这里 Zeus 本身是异常项。

## 本机复现

在本机 WKWebView（embedded，同一套 WebDriver 路径）复现，方向一致：

| renderer | workload | rafToTask | scrollP95 | floorP95 |
|---|---|---:|---:|---:|
| zeus | wide-columns | **19.0** | 35 | 35 |
| native | wide-columns | 5.0 | 35 | 34 |
| workbench-table | wide-columns | 8.0 | 34 | 34 |

同一台机器、同一个 workload、同一份 fixture，zeus 的 rafToTask 是 native 的 3.8 倍。

分解 wide-columns 的 segment（中位数 ms）：

| 阶段 | macOS zeus | Windows zeus |
|---|---:|---:|
| dispatchLag | 16.0 | 15.9 |
| commit | 1–2 | 2.9 |
| commit → firstVisible | 0 | 0 |
| firstVisible | 1–2 | 3.1 |
| **rafToTask** | **21–26** | **8.9–9.4** |

成本完全落在 rafToTask 上，commit 本身没问题。

## 已排除的解释

- **不是绘制面积**：在 Chrome 裸页上把绘制单元格从 1150 降到 1，rafToTask 中位数
  不变（16.6ms）。所以这不是「画得太多」。
- **不是行宽强制撑满**：在 Chrome 裸页上比较行 `width: 26000px` 与 `width: 100%`，
  rafToTask 差 1.3ms（1.2 → 2.5ms），远小于观测到的 17ms 差距。Chrome 上该因素
  存在但很小；WebKit 上的放大倍数尚未测量。
- **不是 dispatchLag 或 commit**：wide-columns 的 dispatchLag（16ms）与 10k 完全相同。

## 尚未确定的部分

WebKit 上把「行宽撑满 + 绝对定位 grid」放大成 17ms 的具体机制，我还没有定位到。
已排除绘制面积。行宽假设也已在 WKWebView 中直接验证并排除，见下节。

因此本文档记录的是**已确认存在的缺陷与其边界**，不是已确认的根因。

## 行宽假设：已排除

data-grid 给每一行都写了 `width: ${columnVirtualizer.getTotalSize()}px` 和完整的
`gridTemplateColumns`。wide-columns 下总宽度远大于视口，因此怀疑 WebKit 对「每帧
重新布局一个远宽于视口的 grid」代价更高。

用真实 WKWebView（embedded WebDriver 路径）做 bundle 级 A/B，两个 bundle 来自同一
source revision、仅替换 bundle：

- baseline：保留每行 `width: <totalSize>px`
- candidate：移除该 width

先各跑 2 次，candidate 的 scrollP95 中位 38ms 对 baseline 58ms，看似改善 20ms。
但 rafToTask 并未变化（17ms 对 18ms），且扩大样本后该差异消失：

| | scrollP95 三次 | scrollP95 中位 | rafToTask 中位 | rafToTask p95 | committed |
|---|---|---:|---:|---:|---|
| baseline | 35.0, 35.0, 36.0 | 35.0ms | 15.00ms | 19.00ms | 60/60 |
| candidate | 35.0, 35.0, 37.0 | 35.0ms | 14.00ms | 16.00ms | 60/60 |

初始的 58ms 是单次离群值，不是行宽造成的。两侧 DOM 规模、最大滚动行程、
committed 样本数完全一致，差异只在噪声范围内。

结论：移除每行强制宽度**无收益**，已撤销，不发布。

## 影响

这是本次调查中第一个**落在 Zeus 可修改范围内**的真实性能缺陷。此前对 10k 路径的
结论（dispatchLag 与 rafToTask 均与框架无关）不适用于 wide-columns：同一个
rafToTask 指标，在 wide-columns 上 Zeus 显著高于同平台另外两个 renderer，说明该处
存在 renderer 侧成本。

后续优化应当以 wide-columns 为目标，而不是 10k-x-50。

复跑数据：`.artifacts/local-wide/`（zeus wide-columns）、`.artifacts/local-wide-cmp/`
（native 与 workbench-table 对照）。
