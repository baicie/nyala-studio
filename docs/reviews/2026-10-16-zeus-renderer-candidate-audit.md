# Zeus renderer 候选复核（2026-10-16）

本次复核针对 10k 滚动延迟是否还能通过 Zeus renderer 自身优化降低。测试使用同一台 macOS Chromium、同一 DataGrid 构建参数，baseline 与候选交错 5 轮，覆盖 `10k-x-50` 与 `wide-columns`。

## 候选

候选把 DataGrid 行的动态 `transform` 从四字段 `bindStyle` 对象中拆出，改为行作用域 effect 直接写 `style.transform`。目标是避免垂直滚动时对静态布局字段重复执行 CSSOM 快照检查。

候选首先暴露了编译器 For accessor 的边界：在 `ref` 回调入口直接捕获 `rowItem` 会得到已解包的普通对象，无法跟随 fixed-slot 更新。改为通过 slot index 和 `renderVersion()` 读取当前 snapshot 后，滚动语义恢复正常。

## 结果

普通 scroll 采样的 5 轮中位数：

| workload       | baseline scroll p95 | candidate scroll p95 | baseline scroll median | candidate scroll median |
| -------------- | ------------------: | -------------------: | ---------------------: | ----------------------: |
| `10k-x-50`     |            18.90 ms |             18.60 ms |               16.40 ms |                16.70 ms |
| `wide-columns` |            18.70 ms |             18.40 ms |               16.70 ms |                16.70 ms |

这两个差异都处在宿主调度噪声范围内，不能作为收益证据。sidecar 的 5 轮 `source=scroll` commit p95 中位数为：

| workload       | baseline commit p95 | candidate commit p95 |
| -------------- | ------------------: | -------------------: |
| `10k-x-50`     |             2.60 ms |              2.50 ms |
| `wide-columns` |             2.50 ms |              2.20 ms |

commit 中位数在两个 workload 上方向不一致（`10k-x-50` 候选 1.90 ms 对 baseline 2.10 ms，`wide-columns` 候选 1.90 ms 对 baseline 1.70 ms）。因此 sidecar 也不能证明 renderer-owned CPU 有稳定下降。

## 决定

- 候选已撤销，不进入 zeus-ui beta33/dev。
- Zeus `setListRecordItem()` direct-setter 改动继续保持未提交；它只减少 updater 闭包分配，之前的交错 A/B 没有稳定收益。
- fixed-capacity、降低 overscan、改变 slot key 继续排除，它们会破坏 pooling、焦点或可访问性契约。
- 当前 Zeus `0.1.1-beta.13` 与 zeus-ui `0.1.0-beta.32` 保持不变。Z1 仍为 `NO-GO`。

现阶段最可信的根因仍是宿主滚动事件派发和 presentation 等待，而不是 Zeus renderer commit。后续只有出现新的、可在同一宿主交错复现的 renderer-owned CPU 降幅，才重新进入发布和双平台采集流程。

## 双平台同执行复核

随后在当前采集分支 `15ed13ee4430912e0087ee8e58391ce7cec4656f` 触发了完整的 run
[`38823345602`](https://github.com/baicie/nyala-studio/actions/runs/38823345602)。macOS WKWebView
和 Windows WebView2 均完成 4 个 workload、3 个 renderer、每组 5 轮，共 60 条 `ok` 记录；两边
使用相同的 Zeus bundle SHA-256
`f363cf4391f93868b35f4ec3077f498d1d5908f9754f015a260ebb57fc5a2921`，WorkbenchTable bundle
也相同，全部 `runToken` 唯一。

Windows 在 `10k-x-50/native` 第 5 轮出现 `/wdio/eval` 超时并随后出现 30 秒导航超时。当前
collector 重启整个嵌入式应用后继续完成采集：`appRestarts` 记录了旧/新 session、进程号、
`driverReady`、`stopConfirmed` 和 `endpointReleased`，最终 60 条记录全部成功。由于一次采集跨越
两个 app generation，Windows 报告保持 `admissionGrade: false`，门禁不会把恢复后的数据当作无条件
的 v7 admission 证据。这说明恢复路径可用，但不能把这次 run 当成没有宿主故障的纯门禁样本。

frame-aware 诊断在两平台都指向相同方向。10k 的 renderer-work 中位数：

| platform         |    Zeus | WorkbenchTable | Zeus 相对改善 |
| ---------------- | ------: | -------------: | ------------: |
| macOS WKWebView  | 1.00 ms |       12.00 ms |         91.7% |
| Windows WebView2 | 3.25 ms |       11.20 ms |         71.0% |

这个指标仍受两个 collector 边界差异、宿主调度和独立 trace navigation 影响，只能作为归因诊断，
不能直接替换现有 `scrollP95Ms` 门禁。现有门禁的 NO-GO 原因是测量契约和目标不可判别：Windows
10k 总延迟改善为 17.6%（低于 20%），1k 出现 26.8% 回归；macOS 10k 的共享 presentation
floor 高于 20% 目标所需的上限。

## 当前决定

- session recycle 与 whole-app restart 留在 collector 中，作为宿主故障恢复能力，不作为 Zeus 生产优化。
- 没有新的、稳定的 Zeus/zeus-ui renderer-owned CPU 回归或收益证据；不发布 `beta33`/dev，也不提交未证明的性能改动。
- 若要继续推进，应先由 ADR 0005 明确是否接受 frame-aware v8 诊断契约，再单独定义可比的 commit 边界和 admission 阈值；在此之前保留 v7 fail-closed 行为。
