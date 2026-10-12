# Zeus 10k 滚动分段 Trace

## 结论

10k x 50 的主要耗时不在 Zeus 的 `updateRange`、range 计算或 DOM snapshot 提交，而在滚动输入到调度回调开始之间的等待。

本次 trace 使用现有 Chromium `--segment-trace` 诊断路径，Zeus beta.26 bundle，3 次运行、每次 20 个滚动 commit，共 120 个 Zeus scroll commits。

| 阶段 | 中位 | p95 | 最大 |
| --- | ---: | ---: | ---: |
| `inputTime -> handlerStartTime` | 12.30 ms | 14.00 ms | 17.40 ms |
| `rangeStartTime -> rangeCalculatedTime` | 0.10 ms | 0.20 ms | 0.20 ms |
| `commitStartTime -> commitEndTime` | 1.50 ms | 2.20 ms | 3.50 ms |
| `commitEndTime -> diagnosticsEndTime` | 0.00 ms | 0.00 ms | 0.10 ms |

## 解释

`updateRange` 从 `handlerStartTime` 到 `commitEndTime` 的总成本通常约 1.6-2.4ms。此前端到端滚动 p95 中观察到的约 11.5ms 尾延迟，和 `inputTime -> handlerStartTime` 的 12.3ms 中位等待相符。

这条证据不支持继续从 row model、range 计算或 snapshot 更新中寻找 11.5ms。代码核对显示原生 `scroll` 路径会调用 `scheduler.flush()` 后同步执行 `updateRange`，不会等待 rAF。因此强相关路径是输入时间戳到浏览器/WebView 调用 scroll handler 之间的事件派发、滚动事件合并和呈现调度。

## 下一步

1. 在相同 workload 上记录 `event.timeStamp -> scroll handler entry -> commitEnd -> next presentation opportunity` 四段时间；当前第一段已经是主要成本，后两段需要在原生 WebView 中分别采集。
2. 对比 `scroll` 事件合并策略（连续 programmatic scroll、原生 wheel/touch 输入、事件频率）对第一段的影响；不要把 rAF A/B 当成默认 scroll 路径优化。
3. 诊断只用于定位，不改变 Z1 阈值、不替代 macOS WKWebView 或 Windows WebView2 证据。

