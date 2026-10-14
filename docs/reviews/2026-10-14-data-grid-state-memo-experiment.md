# Data Grid 状态 memo 候选：没有验证到滚动延迟收益

日期：2026-10-14。目标仍为找到真实根因、修复生产、发布并以真实平台验证；此实验没有完成目标。

## 同次浏览器工作测量

真实 beta31 bundle SHA256 `9ef85faaa4b99248846e7e771bfb84b093a9607fef504cdefd81703450c01c8c`，
10k × 50、1440 × 420。Chromium 中同一次 primary scroll 的 UserTiming 标记与 CDP
trace 校准后，Zeus 的累计 style/layout 有 99.0% 落在 commit span 之外，WBT 为 3.4%。
commit median 为 1.50/7.25ms，而 commit ∪ style/layout/prepaint/paint median 为
3.636/8.539ms；总滚动 median 16.55/16.60ms。后者仍不覆盖完整 raster/GPU/呈现链。
这确认 commit 比值漏算 Zeus 延后发生的浏览器工作，没有直接证明某个生产修复方案。

原始同次导航测量和脚本：`/tmp/nyala-same-scroll-profile.yLmnUg/`。

## 生产候选及验证

固定槽位重新分配行数据时，即使 selected/active 保持 false，cell 的 ARIA/tabindex 等
绑定仍重新执行。用真实组件回归测试复现后，试验私有 BodyRow/BodyCell component，
分别创建 rowSelected/active memo，截断等值状态传播。没有新增 DOM wrapper 或公共 API。
相关 114 项 runtime/键盘/选择/诊断/池复用测试通过，类型检查和包构建均退出 0。

候选 bundle SHA256 `cec077de814bce27beb603d505f12f6e561f38c02bae3ac1e4c17f9da7b8c53b`，
Zeus core 均为 beta.12。候选源文件与测试保存在
`.artifacts/local-state-memo/candidate-source/`，未提交或发布。

## Chromium 六对交错 A/B

每版 120 个同次 primary sample，全数 committed；DOM 均为 23 行、322 cells、405 elements。
保留冷启动与析构事件，采样不按结果筛除 outlier。

| 指标                             |  beta31 | memo 候选 |
| -------------------------------- | ------: | --------: |
| commit median                    |  1.50ms |    1.30ms |
| 排除浏览器/GC 事件的脚本 median  | 1.786ms |   1.666ms |
| commit ∪ 浏览器主线程工作 median | 3.575ms |   3.523ms |
| total median                     |  16.5ms |    16.5ms |
| total p95                        |  18.3ms |    18.5ms |
| 显式析构 median                  |  2.90ms |    3.35ms |

脚本耗时的六个配对方向均降低，但完整浏览器工作只下降 1.5%，第三对还反向增加；
端到端 p95 未改善。证据与脚本：`/tmp/nyala-state-memo-ab.SSMd93/`。

## 真实 macOS WKWebView 五对交错 A/B

本机 Nyala WebDriver-feature binary，每 run 新建 embedded app，AB/BA 交错；
两版各 100 个 primary sample。此为本地诊断，admissionGrade=false，不是平台 Go。

| 指标          |           beta31 |        memo 候选 |
| ------------- | ---------------: | ---------------: |
| commit median |            1.0ms |            1.0ms |
| commit mean   |           1.37ms |           1.34ms |
| total median  |           33.0ms |           33.0ms |
| total mean    |          33.20ms |          33.24ms |
| 每轮 p95      | 34/34/34/35/34ms | 35/34/34/35/34ms |

1ms 时间量化下的 0.03ms 均值差不足以支持稳定收益。文件和复现脚本位于
`.artifacts/local-state-memo/paired-wk/` 与 `.artifacts/local-state-memo/wk-ab.mjs`。
初筛误取 `.artifacts/verify` 的 d3b763… 历史 bundle，未用于此 A/B 或上述结论；
正式配对重新使用已校验的 beta31 9ef85f… bundle。

## 处理

撤回该候选生产修改，保留实验源码及证据；不为此发布 beta/dev，不改变 Z1 门槛或状态。
减少 DOM 核对次数是真实的，但没有验证到目标滚动延迟收益。下一候选减少逐行几何定位
写入，仍需以同次浏览器事件和真实 WebView A/B 决定是否进入生产。
