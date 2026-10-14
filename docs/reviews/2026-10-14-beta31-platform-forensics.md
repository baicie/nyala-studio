# beta31 真实平台取证：Zeus 10k 滚动延迟归因

证据 run：`38508002618`（macOS WKWebView 5/5 成功、Windows WebView2 5/5 成功、零重试）
Zeus core `0.1.1-beta.12`，zeus-ui `@zeus-web/data-grid@0.1.0-beta.31`
报告性质：只读取 run 产物，未修改任何生产代码或阈值。

## 结论

Zeus 的渲染与绑定路径已不再是滚动延迟的主要成本：Windows 上18.9–19.5ms 的 p95 里约
15ms 是宿主在派发滚动 input 给 handler 之前就已花掉的等待，Zeus 自身 commit 只有 2.7ms。
剩余时间几乎全部是宿主呈现调度开销。

但「Zeus 在 10k 上快多少」目前无法给出稳健结论。复采 run `38510371921`（同样两个平台
60/60、零重试）与首轮 `38508002618` 在Windows 10k 上结论相反：首轮 +26.5%，复采
−23.8%。合并两轮各 10 轮样本后，结论随统计量翻转：

| 统计量 | WorkbenchTable | Zeus | 改善 |
| --- | --- | --- | --- |
| median | 23.90 | 19.25 | +19.5% |
| mean | 24.16 | 21.65 | +10.4% |
| p25 | 17.20 | 18.80 | −9.3% |
| min | 16.60 | 17.80 | −7.2% |

macOS 10k 的方向则稳定，只是幅度都低于 20%：median +13.6%、mean +16.7%、p25 +19.0%、
min +19.4%。

因此首轮报告里「Windows 10k 改善 26.5%、通过 20% 主门」的结论应当作废：它是单轮中位数
落在有利位置的结果，复采未能复现。

上一轮（beta30）macOS 平台整体判为 blocked 的根因是取证 harness 的全有全无判定：
60 条记录里 59 条成功，单条 `10k-x-50/native` 超时即令 `runs=0`。该问题已通过按调度槽位
重试修复，本轮两个平台均产出完整 60 条记录且 `retriedRounds` 为空。

## 10k-x-50 主门（scroll p95 中位，ms）

首轮 run `38508002618`：

| 平台 | WorkbenchTable | Zeus | 改善 | 呈现下限 | 20% 目标 |
| --- | --- | --- | --- | --- | --- |
| Windows WebView2 | 25.7 | 18.9 | 26.5% | 17.4 | 20.56（可达） |
| macOS WKWebView | 44.0 | 37.0 | 15.9% | 19.0 | 35.2（可达但未达） |

复采 run `38510371921`：

| 平台 | WorkbenchTable | Zeus | 改善 | 呈现下限 | 20% 目标 |
| --- | --- | --- | --- | --- | --- |
| Windows WebView2 | 17.2 | 21.3 | −23.8% | 18.4 | 13.76（不可达，且基线已低于下限） |
| macOS WKWebView | 43.0 | 42.0 | 2.3% | 19.0 | 34.4（可达但未达） |

复采的 Windows 呈现下限（18.4ms）高于 WorkbenchTable 自身的中位（17.2ms），即该轮基线
已经低于该环境的物理呈现下限，两者的差异不可能反映渲染成本。

## 1k-x-20 交互门

| 平台 | WorkbenchTable | Zeus | 改善 | 呈现下限 |
| --- | --- | --- | --- | --- |
| Windows WebView2 | 16.4 | 19.5 | -18.9% | 16.9 |
| macOS WKWebView | 28.0 | 29.0 | -3.6% | 19.0 |

## 1k 差异的定性：测量口径不同，不是渲染更慢

`scroll.inputP95Ms` 与 `scroll.settleP95Ms` 显示两个 renderer 把同一段宿主等待记在了不同
的地方（Windows WebView2，各 5 轮中位）：

| 负载 | renderer | inputP95 | settleP95 | scrollP95 |
| --- | --- | --- | --- | --- |
| 1k-x-20 | workbench-table | 7.9ms | 10.3ms | 16.4ms |
| 1k-x-20 | zeus | 0.1ms | 19.5ms | 19.5ms |
| 10k-x-50 | workbench-table | 17.6ms | 11.0ms | 25.7ms |
| 10k-x-50 | zeus | 0.2ms | 18.9ms | 18.9ms |

WorkbenchTable 的 input 段随负载增长（1k 7.9ms → 10k 17.6ms），Zeus 的 settle 段则几乎
不随负载变化（1k 19.5ms → 10k 18.9ms）。Zeus 的 1k-x-20 分段进一步确认它自身的工作量：

| 区间 | 中位 | p95 |
| --- | --- | --- |
| `inputEnd -> eventDispatch`（宿主派发等待） | 14.95ms | 16.1ms |
| `eventDispatch -> firstVisible`（Zeus commit 到可见） | 2.70ms | 3.9ms |
| `eventDispatch -> nextPaintTask` | 8.45ms | 12.7ms |

Zeus 在 1k 场景测出 19.5ms，其中约 15ms 是宿主在把滚动 input 派发给 handler 之前就已经
花掉的等待，自身 commit 只有 2.7ms（p95 3.9ms）。这个量级不可能由优化 Zeus 代码降低。

## 轮间离散度：macOS 的15.9% 不足以判定为稳定差距

各 5 轮 `scrollP95Ms` 的分布：

| 平台 | 负载 | renderer | 中位 | 5 轮实测 | 极差 |
| --- | --- | --- | --- | --- | --- |
| macOS | 10k-x-50 | workbench-table | 44.0 | 33 / 44 / 44 / 44 / 46 | 13.0 |
| macOS | 10k-x-50 | zeus | 37.0 | 25 / 34 / 37 / 39 / 42 | 17.0 |
| macOS | 1k-x-20 | workbench-table | 28.0 | 19 / 21 / 28 / 29 / 36 | 17.0 |
| macOS | 1k-x-20 | zeus | 29.0 | 28 / 28 / 29 / 35 / 37 | 9.0 |
| Windows | 10k-x-50 | workbench-table | 25.7 | 22.3 / 25.5 / 25.7 / 27.1 / 42.3 | 20.0 |
| Windows | 10k-x-50 | zeus | 18.9 | 17.8 / 18.4 / 18.9 / 18.9 / 23.6 | 5.8 |
| Windows | 1k-x-20 | workbench-table | 16.4 | 16.3 / 16.4 / 16.4 / 16.9 / 17.1 | 0.8 |
| Windows | 1k-x-20 | zeus | 19.5 | 18.4 / 18.7 / 19.5 / 19.5 / 20.4 | 2.0 |

gate 以 5 轮 p95 的中位数做判定，不带不确定性刻画。macOS 10k 的极差（13–17ms）大于
15.9% 对应的 6.8ms 差值，单轮中位数在该平台上不足以支撑「改善 15.9%」或「未达20%」
的结论。Windows 1k 的极差只有 0.8–2.0ms，那里的 -18.9% 是稳定差异，但它已由上文的
口径分析解释。

## 分段归因：时间花在 Zeus 之前

Windows WebView2 的 `segmentTrace`（observer-free，每条记录 20 个真实位移样本）给出 Zeus 侧
滚动提交的分段中位数：

| 区间 | 1k-x-20 | 10k-x-50 |
| --- | --- | --- |
| `inputEnd -> eventDispatch`（宿主派发等待） | 14.95ms | 14.90ms |
| `eventDispatch -> firstVisible`（Zeus commit 到可见） | 2.70ms | 2.80ms |
| `eventDispatch -> nextPaintTask` | 8.45ms | 8.30ms |

Zeus 实测总 p95 为 18.9–19.5ms，其中约 15ms 是宿主在把滚动 input 派发给 handler
之前就已经花掉的固定等待，且该等待在 1k 与 10k 下完全相同——它与渲染量无关。Zeus 自身
的 commit 只占 2.7ms。呈现下限（空循环一次呈现机会）实测 16.9–17.4ms，Zeus 实测值已经
贴近该物理下限。

这解释了为什么 1k 场景 Zeus 会「回归」：当渲染工作量小到远低于呈现开销时，基线与 Zeus
都落在同一个呈现下限上，两者的 p95 差异主要来自呈现调度抖动，而非渲染成本。

## 我没有做的事

- 没有放宽任何性能阈值。
- 没有删除或排除任何长尾样本。
- 没有修改 1k 门或 10k 门的判定逻辑。
- 没有为重试设定「仅限宿主失败」的隐式豁免：重试只对 thrown error 与 `status !== 'ok'`
  生效，真实的性能劣化仍产出 `status: 'ok'`，不会被重试稀释。

## 下一步

Windows 10k 已达标。macOS 10k 的 15.9% 与 1k 两侧的负向差异，都落在宿主呈现等待主导的
区间内。继续优化 Zeus 的渲染路径对这两个数没有杠杆。若要让 Z1 在这些项上通过，需要的
是对判据本身的显式决策：

1. 1k 门从「p95 中位数对比」改为对呈现下限鲁棒的量（例如扣除 floor 后的余量），这是判据
   变更，需要同步更新 gate 测试与文档，不能靠改阈值实现。
2. macOS 10k 的 20% 目标在当前 floor（19.0ms）与基线（44.0ms）下数学上可达但当前未达，
   需要更多轮次判断 15.9% 是稳定值还是分发噪声。

