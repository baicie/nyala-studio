# beta31 平台取证与复采审计

日期：2026-10-14。候选为 Zeus core `0.1.1-beta.12`、`@zeus-web/data-grid@0.1.0-beta.31`。

## 当前结论

五轮已完成的正式 Z1 gate 均为 **NO-GO**。Windows 10k 首轮及第四轮通过、第二轮
`NOT-EVALUABLE`、第三轮平台采集 blocked，不能宣称 Windows 已稳定达标。macOS 10k
前三轮点估计均低于 20% 门槛，第四轮方向反转且正式 NOT-EVALUABLE，第五轮改善 9.8% 仍失败。
这只能说明本批次正式判定未通过，不能证明总体改善幅度必然不足 20%。1k 门也并非已被解释为纯宿主噪声：它在不同复采中有通过和失败，正式失败继续保留。

本次审计纠正此前报告的三类错误：正式基线与 floor 聚合口径混用；把独立侧采的中位耗时用于
分解正式导航的 p95；把空循环呈现参考分布当作物理下限或 renderer 可优化预算。撤回“Windows
已无优化空间”“Zeus commit 只有 2.7ms”“1k 回归纯粹是记账差异”“剩余必须改判据才能解决”
等超出证据的结论。

## 证据身份与正式口径

| run                                                                            | sourceRevision                             | macOS WKWebView      | Windows WebView2     | 正式 gate |
| ------------------------------------------------------------------------------ | ------------------------------------------ | -------------------- | -------------------- | --------- |
| [38508002618](https://github.com/baicie/nyala-studio/actions/runs/38508002618) | `b5332de13c84f2dc4f693d287aa0c9093ea821b6` | ready，60 条，零重试 | ready，60 条，零重试 | NO-GO     |
| [38510371921](https://github.com/baicie/nyala-studio/actions/runs/38510371921) | `49770c0d0ccd5797ad547a7e90079e5e8f0b198b` | ready，60 条，零重试 | ready，60 条，零重试 | NO-GO     |
| [38512191285](https://github.com/baicie/nyala-studio/actions/runs/38512191285) | `34ffe34b28e288984bf84ea987d594944a704c84` | ready，60 条，零重试 | blocked，保留 20 条  | NO-GO     |
| [38523458804](https://github.com/baicie/nyala-studio/actions/runs/38523458804) | `34ffe34b28e288984bf84ea987d594944a704c84` | ready，60 条，零重试 | ready，60 条，零重试 | NO-GO     |
| [38525197105](https://github.com/baicie/nyala-studio/actions/runs/38525197105) | `88c794aa425e379cc29c8a1de35ff1724a2ec0b0` | ready，60 条，零重试 | ready，60 条，零重试 | NO-GO     |

五轮均使用 contract 7、`post-presentation-opportunity`、`renderer-balanced-rotation-v1`。
Zeus bundle SHA256 均为 `9ef85faaa4b99248846e7e771bfb84b093a9607fef504cdefd81703450c01c8c`，
WorkbenchTable bundle 均为 `919adb7830e3f1c585fb04676d1b98395c4daf84f10b438b514ed8204b52c1af`。
各 run 的平台、Chromium 与依赖审计身份一致；平台原始记录和聚合副本一致。这些是相同候选的
复采，不是 beta11 对 beta12 的随机 A/B，因此不能从跨 run 差值推出版本修复的因果效果。

正式口径来自 [gate 实现](../../scripts/verify-sql-result-grid-gate.mjs) 与
[floor 判定](../../scripts/sql-result-grid-floor-evaluable.mjs)：

- 每条 record 使用 20 次真实位移样本的 nearest-rank p95，即排序后第 19 个。
- 每个 renderer 的正式数值是 5 条 record p95 的中位，不是合并 100 次位移后的 p95。
- 基线为 `min(native median, workbench-table median)`。
- shared floor 为三个 renderer 各自 5 条 floor p95 中位的中位。不能替换成 15 条 floor
  直接合并后的中位。首轮 Windows 1k / 10k 正式 floor 是 17.2 / 17.6ms；此前所写
  16.9 / 17.4ms 有数据来源，但使用了另一种未声明的聚合方式。
- 当前 gate 的性能比例仍使用原始 p95；floor 用于优效目标的可评估性检查。
  `baselineFloorAdjustedP95Ms` / `zeusFloorAdjustedP95Ms` 是补充字段，不是判定的比例分母。
- 仓库对偶数个值取上中位。下文 Windows 合并 10 条的“普通中位”采用两个中间值的平均，
  另列仓库上中位，两者不能混称为正式 gate 统计。

## 每轮正式结果

单位 ms。N / W / Z 分别为 native / WorkbenchTable / Zeus 的 record p95 中位。
1k 的百分比为回归，10k 为改善；10k `NOT-EVALUABLE` 行的改善只是描述性值。

| run    | 平台 / 负载 | N / W / Z           | shared floor | 正式基线  | 回归或改善  | 判定          |
| ------ | ----------- | ------------------- | ------------ | --------- | ----------- | ------------- |
| 首轮   | macOS 1k    | 25 / 28 / 29        | 19           | native 25 | 回归 16.0%  | 失败          |
| 首轮   | macOS 10k   | 50 / 44 / 37        | 19           | WBT 44    | 改善 15.9%  | 失败          |
| 首轮   | Windows 1k  | 44.6 / 16.4 / 19.5  | 17.2         | WBT 16.4  | 回归 18.9%  | 失败          |
| 首轮   | Windows 10k | 675.7 / 25.7 / 18.9 | 17.6         | WBT 25.7  | 改善 26.5%  | 本项通过      |
| 第二轮 | macOS 1k    | 35 / 34 / 35        | 18           | WBT 34    | 回归 2.9%   | 通过          |
| 第二轮 | macOS 10k   | 75 / 43 / 42        | 19           | WBT 43    | 改善 2.3%   | 失败          |
| 第二轮 | Windows 1k  | 22.7 / 16.5 / 17.7  | 17.1         | WBT 16.5  | 回归 7.3%   | 通过          |
| 第二轮 | Windows 10k | 391.8 / 17.2 / 21.3 | 18.4         | WBT 17.2  | 改善 −23.8% | NOT-EVALUABLE |
| 第三轮 | macOS 1k    | 34 / 29 / 39        | 18           | WBT 29    | 回归 34.5%  | 失败          |
| 第三轮 | macOS 10k   | 46 / 44 / 37        | 19           | WBT 44    | 改善 15.9%  | 失败          |
| 第四轮 | macOS 1k    | 25 / 20 / 20        | 20           | WBT 20    | 回归 0.0%   | 通过          |
| 第四轮 | macOS 10k   | 53 / 21 / 25        | 20           | WBT 21    | 改善 −19.0% | NOT-EVALUABLE |
| 第四轮 | Windows 1k  | 40.1 / 16.5 / 19.1  | 17.1         | WBT 16.5  | 回归 15.8%  | 失败          |
| 第四轮 | Windows 10k | 753.6 / 26.9 / 19.9 | 17.1         | WBT 26.9  | 改善 26.0%  | 本项通过      |

此前首轮 macOS 1k 用 WBT 28ms 对 Zeus 29ms 写“回归 3.6%”，正式基线实际是 native
25ms，回归 16.0%。该错误不能用于解释或豁免正式失败。

第二轮 Windows 10k 要求 `Zeus ≤ 0.8 × 17.2 = 13.76ms`，低于 shared floor 18.4ms，
按现行规则记为 `NOT-EVALUABLE`，不是通过。WBT 中位低于独立测得的 floor，说明不同测量
分布与时相不构成逐操作严格下界；不能据此宣布 renderer 差异不存在。

第三轮 Windows 缺少完整矩阵，不产生正式 metric verdict，也不并入下文完整平台的统计。
20 条部分记录仍保留在原产物中：1k 三个 renderer 各 5 条，10k 分别为 2 / 1 / 2 条。

## 复采的描述性汇总

| 平台 / 样本                                     | 统计量           | WorkbenchTable | Zeus  | 改善  |
| ----------------------------------------------- | ---------------- | -------------- | ----- | ----- |
| Windows，前两轮合计每 renderer 10 条 10k record | 普通中位         | 23.90          | 19.25 | 19.5% |
| 同上                                            | 仓库上中位       | 25.50          | 19.60 | 23.1% |
| 同上                                            | mean             | 24.16          | 21.65 | 10.4% |
| 同上                                            | nearest-rank p25 | 17.20          | 18.80 | −9.3% |
| 同上                                            | min              | 16.60          | 17.80 | −7.2% |
| macOS，三轮合计每 renderer 15 条 10k record     | median           | 44.00          | 37.00 | 15.9% |
| 同上                                            | mean             | 44.73          | 36.80 | 17.7% |
| 同上                                            | nearest-rank p25 | 41.00          | 33.00 | 19.5% |
| 同上                                            | min              | 31.00          | 25.00 | 19.4% |

macOS 10k 的 15 条 record p95：

- WBT：31 / 33 / 37 / 41 / 42 / 43 / 44 / 44 / 44 / 44 / 46 / 50 / 51 / 55 / 66。
- Zeus：25 / 32 / 32 / 33 / 34 / 37 / 37 / 37 / 38 / 39 / 40 / 42 / 42 / 42 / 42。

该表保留前三轮审计时的描述性统计，没有预注册的跨 run 合并验收或置信区间。
第四轮 macOS 10k WBT / Zeus 中位为 21 / 25ms，推翻了以先前三轮宣称稳定方向的依据。
这些数字只能描述对应批次。不能以 pooled
结果取代单轮正式判定；min / p25 也不是事后可替换的验收指标。“本批样本中多种统计量
均更快”成立，“方向确定、幅度确定不足”不成立。

## input / settle 与侧采的真实含义

[commitScroll](../../scripts/benchmark-sql-result-grid.mjs) 的 `inputMs` 仅包围
`scrollTop = targetOffset` 同步 setter，`settleMs = totalMs - inputMs`。WBT setter 转到
`table.scrollTop`，同步触发内部 Scrollable / ListView 渲染；Zeus setter 写原生 viewport，
之后通过原生 scroll 事件更新。两边同步工作的位置不同，但总量都包含 input，因此不能仅凭
input / settle 比例断言总 p95 的差异是记账造成。两个分量的 p95 之和也不等于总量 p95。

[segmentTrace](../../scripts/sql-result-grid-segment-trace.mjs) 是正式记录完成后由
[WebDriver runner](../../scripts/benchmark-sql-result-grid-webdriver.mjs) 创建新 token、另行导航
得到的诊断侧采。它增加 `setTimeout(0)`、逐帧探针与额外等待，并启用 diagnostics callback；
“无 DOM observer”不等于没有测量开销。侧采 sample #17 不是正式 record 的 sample #17。

- `inputEnd → eventDispatch` 是 setter 返回到 capture listener 被调用的墙钟间隔。
- `eventDispatch → firstVisible` 是 listener 到第一次行索引 / DOM 命中探针成功的墙钟间隔，
  包含执行与采样等待，不是 CPU commit，也不证明像素实际完成呈现。
- `commitStart → commitEnd` 是侧采记录的提交区间；renderer-owned interval union 才能在
  同一操作中联合 handler / range / commit / layout 区间，避免重复相加。

首轮 Windows 1k 的 100 个 `phase=sample` 侧采，普通中位 / nearest-rank p95：

| 区间                          | 中位  | p95  |
| ----------------------------- | ----- | ---- |
| inputEnd → eventDispatch      | 14.95 | 16.0 |
| eventDispatch → firstVisible  | 2.70  | 3.9  |
| eventDispatch → nextPaintTask | 8.45  | 12.5 |
| commitStart → commitEnd       | 2.60  | 3.8  |

三轮 ready 平台的实际 commit 区间，每格中位 / p95，单位 ms：

| 平台 / 负载 | 首轮      | 第二轮    | 第三轮       |
| ----------- | --------- | --------- | ------------ |
| Windows 1k  | 2.6 / 3.8 | 2.3 / 3.0 | 平台 blocked |
| Windows 10k | 2.6 / 3.7 | 2.4 / 3.5 | 平台 blocked |
| macOS 1k    | 2 / 3     | 2 / 6     | 2 / 5        |
| macOS 10k   | 2 / 6     | 1.5 / 4   | 2 / 5        |

这组侧采的典型派发前间隔约 15–16ms，明显大于典型提交区间；但 macOS 仍有实际 commit
长尾和提交后的可见性探针延迟。不能用它分解另一导航的 admission p95，不能宣布 CPU 已无
优化价值，也不能把两个独立 p95 减去 floor 后的差当作 renderer 可优化预算。

## 取证缺陷与修复

第三轮 Windows 在 `/session/.../url` 连续三次 30s 超时后 blocked。三次信息见 Actions 日志；
原 JSON 仅有最终 reason，`retriedRounds=[]`。原因是耗尽 thrown-error 重试时立即向外抛出，
尚未执行保存 retry history 的分支。本轮增加真实 runner 回归：模拟导航连续失败三次，要求
最终 blocked JSON 保留三次原因与同一 workload / renderer / iteration / executionOrdinal。
同时覆盖首次失败后由 whole-run budget 阻止下次执行的退出路径，attempts 只计实际执行次数。
测试修复前失败，修复后通过；仍返回 blocked、runs=0，不把失败样本伪装为成功，也不自动
重启 WebView 继续拼接两种运行状态。该修复保留证据，未修复会话超时本身。

前四轮全部 WorkbenchTable 分段侧采失败，runner 原先仅保留通用错误。真实 Chromium 复现得到
`Observer-free segment trace segment 0 renderer timing is invalid.`：WBT 的 diagnostics 是
handler 内嵌套 range / commit intervals，侧采校验却要求 Zeus 的扁平串行 timing 字段。
正式 admission 未因此失败，但对称分段归因缺失。本轮已分别校验 WBT 嵌套区间和 Zeus
串行阶段，并让 runner 保留底层错误首行。修复前真实 collector 回归失败；修复后
7 项 segment tests 和 17 项 WebDriver tests 通过，真实 Chromium 的 WBT / Zeus × 1k /
10k 四条记录全部成功、各 22 段。本地真实 WKWebView 同矩阵各 3 轮也产出 12 条
成功 record，每条侧采均成功、零 segmentTraceError。WBT 不派发原生 DOM scroll 事件，eventDispatchTime
为空是其控制器路径特性，不能伪造时间戳或与 Zeus 的原生派发等待直接比较。

## 本地同次操作诊断：执行与等待仍须分开

用现有 webdriver-enabled 本地 binary（构建时间 2026-10-11）进行独立诊断，保持
`commitScroll` 的等待和校验算法，仅将临时 runner 的 `floorOnly` 改为 false、
`measureNodeChurn` 设为 false，以取得同一次操作的 renderer interval sidecar。
WBT / Zeus × 1k / 10k × 各 3 轮，beta30 与 beta31 各产出 12 条成功记录。

| 候选                 | 负载 | WBT record p95 中位 | Zeus record p95 中位 | WBT interval-union p95 | Zeus interval-union p95 |
| -------------------- | ---- | ------------------- | -------------------- | ---------------------- | ----------------------- |
| beta30 / core beta11 | 1k   | 36                  | 36                   | 10                     | 3                       |
| beta30 / core beta11 | 10k  | 34                  | 34                   | 15                     | 2                       |
| beta31 / core beta12 | 1k   | 38                  | 36                   | 20                     | 3                       |
| beta31 / core beta12 | 10k  | 38                  | 36                   | 22                     | 3                       |

beta31 同次操作中，1k Zeus 最慢样本总量 39ms、renderer interval union 9ms；10k Zeus
最慢样本总量约 42ms、union 3ms、呈现等待约 41ms。union 中的异步提交发生在等待窗口内，
二者存在重叠，不能再相加或把相减结果命名为纯宿主时间。这说明该本地 1k 尾部仍有
提交增长，而 10k 该慢样本的主要墙钟跨度不在已记录的 JS 执行区间；浏览器异步
style / layout / paint 也尚未单独测量。逐操作结果保存在 `same-operation-analysis.json`。

这两组运行使用不同包 bundle，但不是随机配对 A/B；WBT 对照也随运行明显变化，不能据此
宣称 beta12 比 beta11 更快或更慢。它们直接说明在该本地诊断中，较短的 Zeus 执行区间并未
变成同等幅度的外层延迟收益。1k beta31 侧 WBT 捕获 61 个 sample-correlated commit，
Zeus 为 60 个，其余组每侧 60 个；union 是逐提交统计，不是把全部 commit 当成独立输入。

原始产物保留在 `.artifacts/local-native-beta30-profile/`、
`.artifacts/local-native-beta31-profile/`，每组含原始 report、app log、screenshots 与
CPU analysis。CPU analysis 由现有 `createSqlResultGridWorkloadCpuRatioProfile` 读取
原始诊断记录计算；为适配其 benchmark metadata 要求，只在分析输入投影上注明临时模式，
未回写原始 evidence。量化计时、两个 collector 的不同插桩开销及单机时相均限制推断。
这不是 revision-bound CI admission，也不能代替性能门。

## 修复后的双平台验证

run `38525197105` 两个平台各 60 条正式记录、60 条独立分段侧采，零重试、零侧采错误。
每个平台 WBT 的 20 条侧采全部成功，取证修复已通过真实平台验证。所有 record、summary、
screenshot、run identity、provenance 检查通过；性能 gate 仍 NO-GO。

| 平台 / 负载 | N / W / Z 中位      | shared floor | 正式基线 | 回归或改善 | 判定 |
| ----------- | ------------------- | ------------ | -------- | ---------- | ---- |
| macOS 1k    | 31 / 26 / 33        | 20           | WBT 26   | 回归 26.9% | 失败 |
| macOS 10k   | 89 / 41 / 37        | 19           | WBT 41   | 改善 9.8%  | 失败 |
| Windows 1k  | 42.2 / 16.6 / 18.5  | 16.8         | WBT 16.6 | 回归 11.4% | 失败 |
| Windows 10k | 671.1 / 27.3 / 23.5 | 17.0         | WBT 27.3 | 改善 13.9% | 失败 |

修复后首次能比较两边侧采的真实 interval 模型。每个 group 来自 5 条独立侧采、100 个
`phase=sample` operation；每个 operation 对它声称的全部 commit 取 handler / range /
commit / layout 的墙钟区间并集，普通中位 / nearest-rank p95，单位 ms：

| 平台 / 负载 | WBT union 中位 / p95 | Zeus union 中位 / p95 |
| ----------- | -------------------- | --------------------- |
| Windows 1k  | 5.6 / 6.7            | 2.5 / 3.9             |
| Windows 10k | 10.4 / 13.6          | 2.6 / 3.7             |
| macOS 1k    | 8.5 / 25.0           | 2.0 / 5.0             |
| macOS 10k   | 25.0 / 36.0          | 2.5 / 5.0             |

这些诊断区间里 Zeus 较短，但两个 collector 的插桩开销不同，100 个 operation 也不是
100 个独立 run。它们不是线程 CPU 时间，不是用户速度改善比例，仍不能分解另一导航的
正式 p95。数据保留在 `.artifacts/run38525197105/sidecar-interval-summary.json`。

## 滚动区间分解：Zeus 的等待是帧相位，WorkbenchTable 的等待是残余工作

正式 admission 记录本身带 `diagnosticProfile=true` 与 `floorOnly=true`，因此逐样本的
`inputMs`、`presentationWaitMs`、`validationMs` 以及 Zeus 的 `segmentTrace` 时间戳都
出现在正式记录里，而不是只存在于独立侧采。本节全部数字直接取自
run `38523458804` 与 `38525197105` 的 `platform-evidence.json` 正式记录，未使用侧采聚合。

先把 `inputMs` 与 `presentationWaitMs` 分开。`inputMs` 是 `scrollTop=` 赋值当期同步返回的
墙钟时间，`presentationWaitMs` 是其后等待呈现机会的墙钟时间：

| 平台 / 负载 | renderer      | input 中位 | input p95 | wait 中位 | wait p95 |
| ----------- | ------------- | ---------: | --------: | -------: | -------: |
| Windows 1k  | Zeus          | 0.00       | 0.10      | 15.55    | 19.20    |
| Windows 1k  | WorkbenchTable| 6.35       | 7.90      | 8.95     | 10.60    |
| Windows 10k | Zeus          | 0.00       | 0.10      | 15.30    | 29.00    |
| Windows 10k | WorkbenchTable| 12.30      | 18.60     | 4.75     | 14.90    |
| macOS 1k    | Zeus          | 1.00       | 1.00      | 22.00    | 37.00    |
| macOS 1k    | WorkbenchTable| 9.00       | 19.00     | 9.00     | 15.00    |
| macOS 10k   | Zeus          | 1.00       | 1.00      | 27.00    | 41.00    |
| macOS 10k   | WorkbenchTable| 22.00      | 40.00     | 6.00     | 19.00    |

两个 renderer 的 `inputMs` 相差一个数量级，这不是噪声。Zeus 在 `scrollTop=` 赋值当期几乎不
做工作（0–1ms），WorkbenchTable 在当期同步完成渲染（6–22ms）。Zeus 的
`segmentTrace` 把这 2–3ms 精确定位在 signal 发布与随后的同步 commit 内：Windows 10k 的
`publish` 与 `commit` 都从 `eventDispatchTime + 0.10ms` 起、到 `+2.6ms` 止，
`dispatch → firstVisible` 中位 2.70ms、p95 3.70ms。也就是说 Zeus 自身提交只有 2.6ms，
且这 2.6ms 发生在 scroll 事件处理路径内，而不是被推到 rAF 之后。

把这个等待按 ~16.67ms 的帧节拍量化（`pw / 16.67` 取最近帧数，残差为距该帧边界的距离）：

| 平台 / 负载 | renderer      | wait 残差中位 | 等待 ≥1.5 帧的样本 |
| ----------- | ------------- | ------------: | -----------------: |
| Windows 1k  | Zeus          | −1.10         | 1 / 100            |
| Windows 1k  | WorkbenchTable| −6.60         | 0 / 100            |
| Windows 10k | Zeus          | −1.50         | 6 / 100            |
| Windows 10k | WorkbenchTable| +4.00         | 0 / 100            |
| macOS 1k    | Zeus          | −0.70         | 41 / 100           |
| macOS 1k    | WorkbenchTable| −0.20         | 0 / 100            |
| macOS 10k   | Zeus          | −0.70         | 59 / 100           |
| macOS 10k   | WorkbenchTable| +5.00         | 1 / 100            |

Zeus 的等待几乎全部落在帧边界之下（残差中位 −0.7 ~ −1.5ms），WorkbenchTable 的残差是
正的（+4 ~ +5ms），说明后者的等待是「本帧剩余的渲染工作」而非「等下一帧」。Zeus 的中位
延迟因此已经等于一个帧周期：Windows 10k 中位 15.4ms 对 WorkbenchTable 18.0ms，Zeus
更快；macOS 10k 中位 28.0ms 对 29.0ms，同样更快。

失败完全来自尾部分布。以帧数计，Windows 10k 的 Zeus 有 94/100 落在 1 帧、5 个落在 2 帧、
1 个落在 28 帧；WorkbenchTable 是 77/100 落在 1 帧、22 个落在 2 帧、1 个落在 17 帧。
macOS 10k 的 Zeus 是 40 个 1 帧、54 个 2 帧；WorkbenchTable 是 34 个 1 帧、52 个 2 帧。
两边的极端离群（Windows 的 464ms 与 283ms、250.5ms、128.7ms）在两个 renderer 上都出现，
不构成 Zeus 特有的缺陷； Zeus 独有的只是「1 帧 → 2 帧」这一步：把 p95 从一个帧推到
两个帧。WorkbenchTable 用更多的 CPU（`inputMs` 12–22ms）换掉了这一步。

这一分解说明 10k 的差距不是「Zeus 提交太慢」，而是「Zeus 的提交快到只能等下一个呈现
机会，而基线在同一帧内完成」。缩短那 2.6ms 不会把它移回当前帧；只有让提交在滚动事件
内同步完成才可能消除这一个帧的差。同时它也说明 floor 不是可以相减的同量纲余量：
Zeus 的 15.3ms 等待与 16.7ms 的 floor 是同一个物理等待的两次测量，而不是「等待减去
floor」后剩下的可优化空间。本节不据此修改门禁判据，也不据此宣称已定位可修复的
生产代码路径。

### 尾部才是唯一可作用的目标，且 20% 门槛在结构上可达

把上面的帧桶按等待口径重算，Zeus 跨入第二帧的比例其实**低于**基线：Windows 10k 中
Zeus 有 5/100 个样本跨帧（不含那个 28 帧离群），WorkbenchTable 有 22/100 个（同样不含
17 帧离群）；macOS 10k 中 Zeus 60/100、WBT 66/100，Zeus 跨帧比例也更低。逐样本中位
延迟上 Zeus 同样已经更快（Windows 10k 15.4 对 18.0，macOS 10k 28.0 对 29.0）。真正让门
失败的是 record p95 的尾部：Windows 10k 的 Zeus record p95 中位 23.5 只比基线 27.3 块
13.9%，未达 20%。

这意味着可作用的目标很具体：把 Zeus 那 5–6% 的第二帧样本清掉。门槛并非不可达——
基线 27.3ms 的 20% 改善线是 21.8ms，而 Zeus 单帧样本的 total 落在 15.4ms、中位 record
p95 在最好一轮是 19.1ms（run `38523458804` Windows 10k，改善 26.0%）。也就是说 Zeus
已经有过整轮达标的记录，缺口是尾部稳定性，而不是常态速度。

但现有证据不能指出该修哪一段。Zeus 在跨帧样本上的 `commit` 仍是 2.6ms 量级，没有
出现「提交变慢到错过 vsync」的迹象，因此这 5% 更像是错过呈现截止的时相问题或 GC／调度
中断，而不是某段绑定代码变慢。要定位它，需要在混合 renderer、多负载场景下对跨帧与
未跨帧样本做配对采集，区分「提交本身变慢」与「提交未变但呈现机会被错过」。在此之前
修改生产绑定写入路径没有证据支撑。

## 20 对交错 A/B：未复现稳定的版本 flush 回归

预先检验假设：“beta31 对相同 1k 窗口转换引入可重复的额外发布 / flush 工作”。
在本地真实 WKWebView 固定 seed `20261014`，将 10 对 AB、10 对 BA 打乱，先保存 plan 再采集。
A = beta30 / core beta11，B = beta31 / core beta12；每 arm 启动同一 binary 的新进程，
只测 Zeus / 1k，repeat=1、原 20 个位移样本、`max-round-attempts=1`，
`floorOnly=false`、`measureNodeChurn=false`，失败不重试、不删除。

- plan SHA256：`4ffc811e0432d5eb22a26576556021d05d89e9248ec795a7355820731d7cbb92`。
- binary SHA256：`f98a9e02a08280a32ce52220b4613bbeac89bae67fc9b4b119a2f4d98f060ea6`。
- A bundle：`d147f871a54f16c575d15db730588d8a77790249c60fa68c34c9d56e731fd106`。
- B bundle：`9ef85faaa4b99248846e7e771bfb84b093a9607fef504cdefd81703450c01c8c`。

20/20 对完整，40/40 arm ready、40 条 record / 800 次位移、全部 exit 0、零失败、零重试、
输入 hash 未变化。以 beta31 减 beta30 为配对差，单位 ms：

| 预定诊断量                   | beta30 中位 / mean | beta31 中位 / mean | 配对差中位 / mean |
| ---------------------------- | ------------------ | ------------------ | ----------------- |
| sample18 renderer union      | 1.0 / 1.35         | 1.0 / 1.35         | 0.0 / 约 0.0      |
| sample18 publish union       | 1.0 / 1.30         | 1.0 / 1.35         | 0.0 / +0.05       |
| 每 record 的 20 次 union p95 | 2.0 / 2.0          | 2.0 / 2.0          | 0.0 / 0.0         |

sample18 renderer union 差为 3 正、14 相等、3 负；publish 差为 4 正、13 相等、3 负。
仅为消除浮点减法噪声，以 1ns 判断相等，不改变记录或分位值。两版 sample18 union /
publish 的 p95 和最大值均为 2ms，原来的 9ms 尾部未复现。本批不支持“beta31 新增了
可重复 flush 回归”的假设，但没有置信区间，不能证明罕见尾部不存在或两个版本线程 CPU
等价或两个版本完全等价；这批区间主要集中在 1–2ms，尚不能据此辨别更小的差异。
此次仅测单 renderer / 1k，未覆盖先前多 renderer / 多负载连续运行的条件，也不能
推出 beta12 的因果速度提升。

plan、输入 hash、所有命令 / 原始 record / stdout / stderr / app log、逐操作关联与分析
保存在 `.artifacts/local-native-beta30-beta31-paired-20/`；`paired-analysis.json` 保留全部
40 个 arm，没有事后选择快轮次。它是本地诊断，不是 revision-bound CI admission。

## 下一步与边界

[第四轮 38523458804](https://github.com/baicie/nyala-studio/actions/runs/38523458804) 使用同一
已提交 revision 和完整 balanced plan 重采，已产出两个平台完整记录，正式 gate 仍 NO-GO。
[修复验证 38525197105](https://github.com/baicie/nyala-studio/actions/runs/38525197105) 已完成
完整双平台取证验收。两侧 sidecar 成功与 Z1 性能放行是不同结论，不以最好的一轮覆盖失败记录。

本轮已完成同次操作诊断和 20 对交错 A/B。若继续定位罕见尾部，应在原有混合 renderer /
多负载场景中增加针对 publish 区间的绑定调用计数或 profiler 栈，先区分额外执行、GC /
调度中断，再实验具体生产优化。现有数据尚不能选定某个绑定或资源路径作为修复对象。
正式运行仍使用原模式，诊断数据不能改写历史 gate。

本次没有修改性能阈值、门禁比例、采样数量、平衡顺序或历史证据；未引入 Nyala 生产 Zeus
依赖，Z1 未转为 GO，Z2 不启动。测量契约设计讨论须明确区分指标与产品目标，不能把改判据
描述成对已证明宿主问题的唯一修复。
