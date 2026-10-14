# 插桩基线取证导致平台 benchmark 挂起

日期：2026-10-14
运行：`sql-result-grid-platform.yml` run 38546947004（`instrument_baseline=true`, `repeat=3`, ref `mvp`, commit `41ecaef6`）

## 现象

`Prepare temporary Zeus audit bundle` 成功后，Windows WebView2 与 macOS WKWebView 两个
benchmark job 同时进入 `Run embedded ... benchmark` 步骤，随后运行整体
`updatedAt` 停在 `2026-10-14T10:06:15Z`，此后再无任何进展。两个 job 停在同一
步骤超过两小时，取消请求也未使其退出。

对照：run 38512191285 使用默认参数（`floorOnly`）时，同一步骤在约 8 分钟内产出
结果或明确失败（WebDriver 30s 超时后重试三次）。

## 结论

关闭 `floorOnly` 从而给基线渲染器装上观测器，会让平台 benchmark 不再收敛。
这不是采集器「缺失」，而是插桩本身改变了被测系统的行为。

需要注意的证据缺口：GitHub 只在 job 结束后提供日志，而 job 因挂起未结束，
因此**没有拿到具体报错或栈**。当前只能确认「插桩后挂起」这一因果相关，
未能定位到具体是哪一行代码。

## 对 frame-aware 判据的影响

`scripts/sql-result-grid-frame-aware-verdict.mjs` 依赖基线的
`commitIntervals`。在两轮已完成的准入取证（38508002618、38510371921）中，
workbench-table 的 `rendererWork` 样本数在全部 16 个 platform/workload 组合上
均为 0，判据一律返回 `UNAVAILABLE`。本轮尝试补齐该数据失败。

因此 frame-aware 判据目前**没有可用的真实数据支撑**，不得接入 v7 准入。
`scripts/sql-result-grid-frame-aware-profile.mjs` 已在其 limitations 中声明
WorkbenchTable 的采集器与 Zeus 不同源、比值只是形状指标；该声明与
`sql-result-grid-frame-aware-verdict.mjs` 把它当准入指标的做法相互矛盾，
后者不应合入。

## 下一步可选路径

1. 先定位挂起根因再重试：把插桩范围收窄到单个 workload/renderer
   （`--workload 10k-x-50 --renderer workbench-table --repeat 1`），
   并给导航加显式超时，让失败可观测。
2. 放弃 frame-aware 迁移：Windows 复采轮基线 p95 已低于呈现下限，
   属判据不可辨识而非 Zeus 慢，应把该语义做成 NOT-EVALUABLE 且不计失败。

