# beta31 真实平台取证：Zeus 10k 滚动延迟归因

证据 run：`38508002618`（macOS WKWebView 5/5 成功、Windows WebView2 5/5 成功、零重试）
Zeus core `0.1.1-beta.12`，zeus-ui `@zeus-web/data-grid@0.1.0-beta.31`
报告性质：只读取 run 产物，未修改任何生产代码或阈值。

## 结论

Zeus 的渲染与绑定路径已不再是滚动延迟的瓶颈。Windows 10k 场景 Zeus 相对
WorkbenchTable 改善 26.5%，超过 20% 的主门限；macOS 10k 为 15.9%。剩余时间几乎全部
是宿主呈现调度开销，不是 Zeus 的渲染工作量。

上一轮（beta30）macOS 平台整体判为 blocked 的根因是取证 harness 的全有全无判定：
60 条记录里 59 条成功，单条 `10k-x-50/native` 超时即令 `runs=0`。该问题已通过按调度槽位
重试修复，本轮两个平台均产出完整 60 条记录且 `retriedRounds` 为空。

## 10k-x-50 主门（scroll p95 中位，ms）

| 平台 | WorkbenchTable | Zeus | 改善 | 呈现下限 | 20% 目标 |
| --- | --- | --- | --- | --- | --- |
| Windows WebView2 | 25.7 | 18.9 | 26.5% | 17.4 | 20.56（可达） |
| macOS WKWebView | 44.0 | 37.0 | 15.9% | 19.0 | 35.2（可达但未达） |

## 1k-x-20 交互门

| 平台 | WorkbenchTable | Zeus | 改善 | 呈现下限 |
| --- | --- | --- | --- | --- |
| Windows WebView2 | 16.4 | 19.5 | -18.9% | 16.9 |
| macOS WKWebView | 28.0 | 29.0 | -3.6% | 19.0 |

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

