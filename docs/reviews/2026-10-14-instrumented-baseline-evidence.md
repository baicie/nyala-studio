# 插桩基线取证：结果与Windows 阻塞

日期：2026-10-14
运行：`sql-result-grid-platform.yml` run 38546947004（`instrument_baseline=true`, `repeat=3`, ref `mvp`, commit `41ecaef6`）

## 运行结果

macOS WKWebView 成功（10:06:15 → 10:17:01，约 11 分钟），Windows WebView2 失败。
整轮约 13 分钟，并非挂起。

初次观察时GitHub API 的 `updatedAt` 停在 `10:06:15Z`，被误读为两个 job 挂起两小时。
实际上两个 job 都在 10:17 前结束，`updatedAt` 在 job 结束后本就不再更新。
后续判断以 `jobs[].startedAt/completedAt` 为准。

## 防误用标记已生效

插桩证据自带 `admissionGrade: false` 与两条 limitation，aggregate 的 Z1 gate步骤
在 `instrument_baseline=true` 时被跳过，诊断证据不会被当作 v7 准入。

## 关键结果：renderer-work 口径下 Zeus 显著优于基线

macOS 上 workbench-table 首次拿到 segmentTrace（12/12 记录），三个渲染器全部齐全。
`createFrameAwareSuperiorityVerdict` 首次在真实数据上给出有效判定：

| workload | Zeus renderer work | 基线 renderer work | 改善 |
| --- | --- | --- | --- |
| 1k-x-20 | 2.0ms | 13.5ms | 85.2% |
| 10k-x-50 | 2.0ms | 25.0ms | 92.0% |
| wide-columns | 2.0ms | 16.5ms | 87.9% |
| narrow-panel | 1.0ms | 10.5ms | 90.5% |

四个 workload 全部通过 20% 阈值。这与 scroll p95 口径下的表观数字
（2.3%–15.9%，多数不达标）方向一致但量级完全不同。

原因在同一份证据里可以直接读出：10k-x-50 下 scroll p95 分别为
zeus 41ms / workbench-table 50ms / native 98ms，而呈现下限为 18–27ms。
三个渲染器的 scroll p95 差异主要来自宿主帧调度与呈现等待，
renderer work 才是渲染器代码能改变的部分。

因此先前「Windows 复采轮基线低于呈现下限导致判据不可辨识」的观察对
scroll p95 口径成立，但不适用于 renderer-work 口径：后者不受呈现下限影响。

## Windows 仍被 WebView2 导航超时阻塞

`10k-x-50/workbench-table` 连续三次 `POST /session/{id}/url` 30s 超时后 blocked，
与 run 38512191285 的失败点完全相同。这是当前 Windows 取证的真实阻塞点，
与插桩开关无关（38512191285 使用默认 `floorOnly` 参数同样失败）。

## frame-aware 判据的评估

`scripts/sql-result-grid-frame-aware-verdict.mjs` 现在有真实数据支撑，
在 macOS 上四战全过。但仍有两个未解决的疑点，不能直接接入 v7 准入：

1. 只有 macOS 一份插桩证据，Windows 因导航超时始终没有这份数据。
   准入需要两个平台都成立。
2. `sql-result-grid-frame-aware-profile.mjs` 的 limitations 明确声明
   WorkbenchTable 采集器与 Zeus 不同源、其比值只是形状指标而非准入指标。
   这条声明尚未被推翻，85–92% 这个量级需要独立复核后才能作为合同依据。

## 下一步

1. 解决 Windows WebView2 的 `10k-x-50/workbench-table` 导航超时，
   否则 Windows 永远拿不到插桩证据。
2. 复核 WorkbenchTable `commitIntervals` 与 Zeus `commitStartTime/commitEndTime`
   的可比性：确认前者是渲染器同步提交耗时、后者是否包含 Zeus 自身的调度开销。
3. 两点落实后，才讨论把 renderer-work 接入准入判据。

