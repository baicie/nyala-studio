# Z1 10k 滚动延迟根因（基于 run38552402643 真实平台证据）

## 结论

Zeus 10k 滚动延迟中，框架自身只占 2–3ms。其余全部是宿主与浏览器调度：

1. **dispatchLag 15–19ms（所有 renderer 一致）**：`scrollTop` 赋值完成到 scroll 事件 handler 真正开始执行之间的等待。这是「输入被对齐到下一帧」的固有开销，与渲染器无关——native 渲染器在同一份证据上是 16–19ms，完全相同。
2. **rafToTask（WKWebView 16–18ms，WebView2 5.6–5.8ms）**：rAF 回调到下一个绘制任务之间的宿主渲染管线时间。WKWebView 比 WebView2 多约 10ms。
3. **Zeus commit 2–3ms**：signal 发布 + DOM 写入。

## 分解（segmentTrace，10k-x-50/zeus，中位数 ms）

| 阶段 | 官方 macOS | 官方 Windows | 本机 macOS |
|---|---:|---:|---:|
| input（scrollTop 赋值） | 0–1 | 0 | 0 |
| **dispatchLag（等下一帧）** | **15.5–16** | **14.8–15.7** | **33** |
| handler（Zeus 同步工作） | 0 | 0 | 0 |
| range 计算 | 0 | 0.1 | 0 |
| commit（Zeus） | 2–2.5 | 2.55–2.70 | 3 |
| firstVisible | 2–2.5 | 2.7–2.95 | 3 |
| rafToTask（宿主渲染） | 16–18 | 5.5–5.8 | 13 |
| 合计 | 34.5–37.5 | 23.8–24.2 | 49 |

## 关键否证

- dispatchLag **不是** Zeus 的问题：native 渲染器在同一证据上同样是 16–19ms。
- 本机 macOS 的 dispatchLag 是 33ms、floor 是 33ms，即整台机器当时处于约 30Hz 状态，而非官方机器的 60Hz（floor 15–17ms）。这解释了「官方 mac 有 18–24ms 余量、本机却显示零余量」的矛盾：那不是 renderer 差异，是显示刷新率差异。
- Chrome 下 Zeus 10k 滚动中位 16.40ms，同一网格 presentationFloor 中位 16.80ms，滚动减去地板的中位差为 **−0.17ms**（最大 +0.30ms）。即 Zeus 已经贴在 vsync 地板上，没有可压缩的用户可感知余量。

## 由此推出的工作规则

任何以「降低 scrollP95Ms」为目标、却不区分 dispatchLag / rafToTask / commit 的优化，都无法在真实平台上产生可信收益。已验证无效并撤销的候选：

- 状态绑定 memo（BodyRow/BodyCell）：commit 降 0.2ms，完整主线程工作仅降约 1.5%，总滚动不变。
- body 整体位移 + row 相对 transform：样式失效从 23 个元素收敛到 1 个确实成立（styleMs 6/6 对更快），但收益被 layout 吃掉（layoutMs 仅 1/6 对更快），总滚动配对中位 +0.075ms。

两者都没有降低 dispatchLag 或 rafToTask，而那才是 90% 以上的成本。

## dispatchLag 对照实验：确认它是宿主的固定成本

为了排除「dispatchLag 是 Zeus 造成的」这一可能，在**完全不含任何框架的裸页**
（一个 `overflow:auto` 的 div 加一个 400000px 高的内容块）上用 Chrome 复现四种时序：

| 场景 | dispatchLag 中位 | 到绘制中位 | 说明 |
|---|---:|---:|---|
| 裸页，基准同款时序 | 15.9ms | 33.3ms | 无任何框架 |
| 裸页，帧内早期写 scrollTop | 17.0ms | 32.8ms | 无任何框架 |
| 裸页，帧内晚期写 scrollTop | 5.5ms | 21.6ms | 无任何框架 |
| 裸页，真实可信 wheel 事件 | 11.1ms | 11.2ms | 无任何框架，真实用户输入 |
| **Zeus 10k-x-50（官方 macOS）** | **15.5–16ms** | **34.5–37.5ms** | 完整框架 |
| native renderer（官方 macOS） | 16–19ms | — | 无 data-grid 框架 |

裸页在基准同款时序下的 dispatchLag 是 15.9ms，与 Zeus 的 15.5–16ms 实质相同。
这证明 dispatchLag 是「程序化写 scrollTop 后等待滚动事件被派发」这一动作的固有成本，
与被测框架无关。Zeus 在这项上的 2–3ms 差距落在噪声内。

两个次要观察：

- 帧内时机确实影响 dispatchLag（早期 17ms vs 晚期 5.5ms），但基准时序是固定的，
  这个差值对所有 renderer 一视同仁，不构成 renderer 之间的差异来源。
- 真实 wheel 输入的 dispatchLag 中位是 11.1ms，低于程序化写入。这说明程序的
  程序化滚动测量比真实用户手势略悲观，但该偏差同样对所有 renderer 一致。

复跑：`/tmp/dispatch-probe/`（`node run.mjs && node verdict.mjs`）。

## 复跑方式

分解脚本见 `/tmp/nyala-transform-ab/run2/officialbreak.py` 与 `dispatchall.py`；Chrome 侧证据见 `/tmp/nyala-transform-ab/run2/`（6 对交错 A/B，每版 120 samples，全部 committed，无过滤）。本机 WKWebView segmentTrace 采集产物见 `.artifacts/local-macos-rootcause/`。
