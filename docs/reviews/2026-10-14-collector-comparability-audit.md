# Zeus / WorkbenchTable 计时可比性复核

日期：2026-10-14。范围：延续跨仓库性能分析，复核两个采集器及其真实平台证据。

## 结论

两侧计时均覆盖各自的同步 DOM 更新，Zeus 自身的响应式调度没有被排除。但区间边界不对称，
不能把 commit 比值解释为纯 JavaScript / CPU 性能比，也不能把它直接写进准入合同。

新轮复现的 **53.0%–91.3%** 是 Zeus 对已插桩 WorkbenchTable 的 **commit 墙钟中位数**改善。
WorkbenchTable 的累计 commit 耗时中 **76.6%–87.6%** 落在逐行测宽函数内，该函数包含
JavaScript、样式写入和可能触发的同步样式/布局；这不是已经独立测得的纯布局占比。

此前“两个采集器都排除了布局成本”“剩余差距全部属于宿主”“没有 Zeus / zeus-ui 可修复
瓶颈”的结论均超出证据，应撤回。当前证据也不能证明 Zeus 存在某个特定生产代码瓶颈。
Z1 仍为 NO-GO，ADR 0005 仍为 Proposed，本次没有改动生产渲染器或准入规则。

## 证据身份与样本

使用 run `38552402643` 的 macOS WKWebView / Windows WebView2 证据，两个平台均
`status=ready`、`runs=3`、36 条 records、零重试、`admissionGrade=false`。

- sourceRevision：`0d3cc02305ff283813a9fb345099cf71f5a89648`
- Zeus bundle SHA256：`9ef85faaa4b99248846e7e771bfb84b093a9607fef504cdefd81703450c01c8c`
- WorkbenchTable bundle SHA256：`919adb7830e3f1c585fb04676d1b98395c4daf84f10b438b514ed8204b52c1af`
- macOS evidence SHA256：`2f0e98c9b158e6914bcb15a95f5fde6807ed8087e1e6b37a46653c910c98973c`
- Windows evidence SHA256：`6bf4468d1709f58df5c9aea53566f22a79ecd95ec2833d4e15073e61b9fbb8cf`

原始文件保存在 `.artifacts/run38552402643/sql-result-grid-{macos-webkit,windows-webview2}/platform-evidence.json`。
每个 workload、每个 renderer 取 3 轮 × 20 个 trace sample，共 60 个；只使用
`phase=sample` 认领的 `commitTransactionIds`。每个平台两侧各 240 个样本（跨平台每侧
480 个）全部恰好关联一个
`source=scroll` commit，无缺失 ID、挂载混入或 source 错配。

以下采用合并 60 样本的 median；p95 使用 nearest-rank，第 57 个值。没有替换成“每轮
median 的 median”：例如 macOS wide-columns 换口径会将改善从 84.6% 变成 92.6%。
macOS 原始时间戳落在 1ms 网格，Windows 落在 0.1ms 网格；median 的平均值和浮点尾数
不代表更细的采集精度。

## 计时边界

| 内容                     | Zeus                                                             | WorkbenchTable                                            |
| ------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------- |
| 范围计算                 | 在 commitStartTime 之前                                          | render 内的新范围计算包含在 commitIntervals 中            |
| 同步响应式调度、DOM 更新 | batch 返回前已执行；包含在 commit span 中                        | 包含在 render span 中                                     |
| 几何读取                 | viewport/offset 读取主要在 range 阶段；scroll 复用 viewport 尺寸 | render 插入每行后调用 measureItemWidth，包含在 commit 中  |
| commit 结束              | finalize 打点，普通 scroll 同步；pending/defer 情况可进入微任务  | render wrapper 的 finally 打点                            |
| 后续浏览器工作           | commit 没有覆盖全部后续样式、布局、绘制                          | commit 没有覆盖全部后续工作，但已包含其读取触发的同步工作 |

WorkbenchTable 的 `ListView.render` 在 `listView.ts:1005` 计算新范围，插入行后在
`:1110–1133` 写 `width='fit-content'`，再调用 `getContentWidth` / `getComputedStyle`。
`dom.ts:1010–1013` 的 `getContentWidth` 读取 `offsetWidth`。因此“同步 JS 调用墙钟”
并不意味着排除了浏览器样式/布局工作；测宽函数会要求浏览器提供更新后的几何信息。

Zeus 的 `zeus-ui/packages/advanced/data-grid/src/components/data-grid.tsx:1454–1485`
先读取 viewport/计算快照，再打 commitStartTime 并执行 batch。Zeus core 的
`packages/core/signal/src/effect.ts:633–639` 在 batch 的 finally 同步 endBatch/flush；
`runtime-dom/src/list.ts:402–410` 的 For scheduler 同步 runner/drain，绑定 effect
直接 apply。因此默认 scroll 路径的 signalPublish span 包含响应式传播和该链上的 DOM 工作。
不能据另一处 queueMicrotask 推断这些 DOM 更新被漏算。

`signalPublishEndTime → commitEndTime` 还包含事件 emit、诊断 sample 构造及 finalize。
普通 scroll 传入 defer=false，pending/defer 才使用诊断微任务。精度范围内的 0ms 只能
说明未分辨出差值，不能证明额外工作或微任务间隔绝对为零。

## 测宽区间分解

单位 ms，所有 median 均为 60 样本。测宽占比是 `sum(测宽 union) / sum(commit union)`。

| 平台    | workload     | Zeus commit | WBT commit | WBT 测宽 | WBT 排除测宽的残差 | 测宽占比 | commit 改善 |
| ------- | ------------ | ----------: | ---------: | -------: | -----------------: | -------: | ----------: |
| macOS   | 1k-x-20      |        2.00 |      11.00 |    10.00 |               1.00 |    84.4% |       81.8% |
| macOS   | 10k-x-50     |        2.00 |      23.00 |    21.00 |               3.00 |    87.6% |       91.3% |
| macOS   | wide-columns |        2.00 |      13.00 |    12.00 |               2.00 |    86.7% |       84.6% |
| macOS   | narrow-panel |        1.00 |       8.00 |     7.00 |               1.00 |    87.1% |       87.5% |
| Windows | 1k-x-20      |        2.70 |       5.75 |     4.45 |               1.30 |    76.6% |       53.0% |
| Windows | 10k-x-50     |        2.70 |      10.75 |     8.45 |               2.30 |    78.5% |       74.9% |
| Windows | wide-columns |        2.85 |       8.15 |     6.70 |               1.40 |    82.6% |       65.0% |
| Windows | narrow-panel |        1.40 |       5.60 |     4.40 |               1.30 |    77.7% |       75.0% |

每个 WBT sample 的 13–15 个测宽区间都在 commit 区间内，不能把两者相加。
残差是先逐样本扣除测宽 union，再求 median；不是两个 median 相减。它既不等于纯 JS，
也不能用来宣布 Zeus 更慢，因为测宽 wrapper 也包含 JS 和样式写入。

Zeus 扩展到 `rangeStartTime → commitEndTime` 后，中位数在 macOS 依次为
2.00/2.00/2.00/1.00ms，Windows 为 2.70/2.80/2.95/1.50ms。补入范围阶段没有改变
“主要差异落在 WBT 测宽函数中”的观察，也没有建立完整浏览器工作量的可比性。

native 没有被此 profile 采集 commit interval；53–91% 只能描述此处的 WorkbenchTable
对照，不能扩展到 bestNonZeus 或总体滚动延迟。

工作量也不相同：`tableWidget.ts:68–94` 对全部列创建/填充 cell；Zeus 在
`data-grid.tsx:1124–1150` 使用 column virtualizer，body For 只遍历当前渲染列。
列虚拟化可以是组件设计的收益，但不能把该差异单独归因于 Zeus core signal/compiler。

## 独立导航与 rAF 探针

`benchmark-sql-result-grid-webdriver.mjs:468–479` 在 primary 测量完成后才附加 trace；
`:825–842` 创建新 traceRunToken 并重新导航。相同 sampleIndex 只表示相同目标位置，
不表示同一次滚动。primary 的 totalMs 与 trace 的 commit、rAF、task 时间戳不能按样本
相减或分组作因果归因。当前 hostExcess 只是两次导航分布的统计差。

`sql-result-grid-segment-trace.mjs:46–47` 在 rafTime 后调用可见行探针；该探针在
`benchmark-sql-result-grid.mjs:1062–1066` 读取 getBoundingClientRect / elementFromPoint。
因此 rAF→task 区间还包括探针、可能尚待处理的样式/布局/绘制、timer 调度。
它不是独立于 renderer 的纯宿主 floor，扣掉它不能提取 renderer 唯一可优化的剩余时间。
trace 的 firstVisible 也是探针首次观察到正确行的时刻，不是实际屏幕呈现时刻。

下一轮归因应固定两端可见列和 cell 数，在同一次导航、同一次输入中覆盖范围计算、DOM
完成及共同布局结束点，分别观测 JS 与浏览器样式/布局工作，并校准插桩开销。
使用准入指标前仍需单独预注册和满足全部 Z1 条件。

## 本次修复与验证

frame-aware profile 原来对一个样本的多个 transaction 取最长 commit，漏算其他提交。
现在对该 sample 认领的所有绝对时间区间求并集：重叠只计一次，分离区间全部计入，
中间等待不计入。诊断 profile 升为 v2，保留现有准入契约版本与门槛。

先写回归测试，旧实现给出 4ms 而预期 9ms、10ms 而预期 15ms；修复后均通过。
新轮每个 sample 只有一个 commit；首轮 `38546947004` macOS 的两个额外 commit 为 0ms，因此此次修复没有
改变上述真实证据的数值。新增 limitations，并删除“v8 已预注册”“commit 是 renderer
唯一可优化成本”等不成立的代码注释。

复算现有诊断输出（不会触发采样或准入）：

```bash
node scripts/verify-sql-result-grid-frame-aware.mjs \
  --evidence .artifacts/run38552402643/sql-result-grid-macos-webkit/platform-evidence.json \
  --evidence .artifacts/run38552402643/sql-result-grid-windows-webview2/platform-evidence.json
```

输出另存为 `.artifacts/run38552402643/collector-comparability-profile.json`。

| 验证                                        | 结果                                         | 退出码 |
| ------------------------------------------- | -------------------------------------------- | -----: |
| `pnpm run test:sql-result-grid-frame-aware` | 12/12，含两个先红后绿的回归用例              |      0 |
| `pnpm run test:sql-result-grid-gate`        | 64/64，正式契约保护测试通过                  |      0 |
| `pnpm run test:sql-result-grid-benchmark`   | 111/111，采集器及 trace 相关测试通过         |      0 |
| 上述双平台证据 replay                       | profile v2，两个平台各四个 workload 数值复现 |      0 |

变更仅限 Nyala 的三个诊断/测试脚本、此报告及三份历史文档更正。Zeus / zeus-ui
生产代码没有修改；本轮未做新的平台采样，也没有宣布性能准入通过。
