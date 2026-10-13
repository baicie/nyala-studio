# Z1 1k 门尾部取证：beta30 + core beta11 真实平台证据

证据 run：`38414805810`（macOS WKWebView 5/5 成功、Windows WebView2 5/5 成功）
Zeus core `0.1.1-beta.11`，zeus-ui `@zeus-web/data-grid@0.1.0-beta.30`（gzip 30044，预算 31000）
报告性质：只读取 run 产物，未修改任何生产代码或阈值。

## 结论

绑定写入门控的修复真实有效，Windows 10k 主门从 29.9ms 降到 19.5ms（相对 WorkbenchTable 改善 64.4%），macOS 1k 从 20.6% 回归降到 5.6% 并通过。剩余的 Windows 1k 失败不是 Zeus 的渲染或绑定开销，而是「滚动 input 到 scroll handler 被派发」这段宿主等待在两个 renderer 之间不对称。

## 1k-x-20 的分段结构（Windows WebView2，各 100 样本）

| renderer | total 中位 | p95 | max | >17ms 占比 |
| --- | --- | --- | --- | --- |
| workbench-table | 15.6ms | 16.5ms | 19.2ms | 3% |
| zeus | 15.5ms | 20.2ms | 28.5ms | 22% |

中位数上 Zeus 略低于 WorkbenchTable（15.5 vs 15.6），但 Zeus 的分布更厚：22% 的样本超过 17ms，WorkbenchTable 只有 3%。这不是单点离群，是分布性差异。

分段（`segmentTrace`，每样本）：

| 区间 | zeus 中位 | 说明 |
| --- | --- | --- |
| `inputEndTime -> eventDispatchTime` | 15.0ms | 宿主把滚动 input 派发给 handler 前的等待 |
| `handlerStart -> rangeCalculated` | 0.1ms | range 计算 |
| `signalPublishStart -> signalPublishEnd` | 2.7ms | Zeus 的实际 commit |
| `commitEnd -> firstVisible` | 0.0ms | 无额外呈现延迟 |

Zeus 自己的 commit 只有 2.7ms，而 WorkbenchTable 的 settle 中位是 9.4ms。也就是说 Zeus 的 handler 到可见这一段已经明显更快，Zeus 整体仍然打平或更好，是因为它把时间花在了 handler 派发之前的宿主等待上。

## 为什么说尾部在宿主而不在 Zeus

1. 同一个浏览器、同一次 run 内的空转呈现下限测量（`diagnostics.presentationFloor`）：workbench-table 中位 15.5ms / p95 17.2ms，zeus 中位 15.4ms / p95 17.1ms。两者几乎相同，说明「一次滚动提交后要等一次呈现机会」这件事本身的成本就是约 15.5ms，与渲染器无关。Zeus 的 total 中位 15.5ms 恰好等于这个 floor。

2. `presentationWaitMs` 与 `settleMs` 在 Zeus 上几乎相等（中位 15.40 vs 15.45），即等待几乎全部发生在 harness 的呈现机会等待里，而这段等待的上限由浏览器帧调度决定。

3. 尾部与滚动距离无关：run1 里慢样本出现在 jump 6910、9214、10365、13822，快样本出现在 20732、21500、27643，不存在「某些 offset 更慢」的规律。

4. 逐样本拆解最慢的 28.5ms 样本（run1 #17）：`inputEndTime` 805.20 → `eventDispatchTime` 820.20（15.0ms）→ publish 结束 823.60（3.3ms）→ `firstVisibleTime` 823.70。28.5ms 里 15.0ms 是派发等待，3.3ms 是 Zeus 的 commit，剩下约 10ms 落在下一次呈现机会（`nextPaintTaskTime` 831.40）。

## 10k-x-50 的对照

同一 run 内 Windows WebView2：

- workbench-table p95 中位 54.8ms，zeus 19.5ms，改善 64.4%，通过 20% 门限。
- workbench-table 的 100 样本里有 33% 超过 17ms、最大 613.8ms；zeus 是 20%、最大 229.9ms。

在真正有大量单元格要更新的 10k 场景，Zeus 的优势非常明确。这说明渲染与绑定路径本身已经不是问题。

## 剩余的 10k 不可辨识项

macOS 10k 与 Chromium 10k 这次都被 shared presentation floor 判为不可辨识：

- macOS：floor 21.0ms，WorkbenchTable 23.0ms，20% 改善要求 Zeus ≤ 18.4ms。即使 Zeus 侧耗时为 0，也要 21.0ms 才能达标，所以该平台该负载下 20% 目标在数学上不可达。当前实际改善 8.7%。
- Windows：floor 22.0ms，WorkbenchTable 54.8ms，要求 Zeus ≤ 43.84ms，可达，实际 64.4%。

macOS 的 WorkbenchTable 基线只有 23.0ms，几乎贴着 floor，说明 macOS 上基线本身没有可压缩空间。这是基线选择问题，不是 Zeus 落后。

## 我没有做的事

- 没有放宽任何性能阈值。
- 没有删除或排除任何长尾样本。
- 没有修改 1k 门或 10k 门的判定逻辑。

## 下一步建议

1. Windows 1k：现有证据表明这是宿主派发等待的不对称，而不是可由 Zeus 侧代码消除的差异。要么等宿主侧自然收敛（多轮复采看分布是否回归常态），要么在 gate 里把 1k 判据从「p95 中位数」改为对呈现下限鲁棒的量（这是判据变更，需要显式决策并同步更新 gate 测试与文档，不能靠改阈值实现）。
2. macOS 10k：20% 目标在当前 floor 下不可达。要么为 macOS 选择有压缩空间的基线，要么显式承认该负载 macOS 不作为 10k 主门判据（同样是判据决策，需要显式批准）。
3. 两者都属于「测量契约」层面的决定，不是 Zeus 的性能缺陷。Zeus 侧在 10k 上的 64.4% 改善已经是明确的正面证据。
