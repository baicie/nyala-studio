# beta31 平台取证与复采审计

日期：2026-10-14。候选为 Zeus core `0.1.1-beta.12`、`@zeus-web/data-grid@0.1.0-beta.31`。

## 当前结论

前四轮已完成的正式 Z1 gate 均为 **NO-GO**。Windows 10k 首轮及第四轮通过、第二轮
`NOT-EVALUABLE`、第三轮平台采集 blocked，不能宣称 Windows 已稳定达标。macOS 10k
前三轮点估计均低于 20% 门槛，第四轮方向反转且正式 NOT-EVALUABLE。
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

前四轮均使用 contract 7、`post-presentation-opportunity`、`renderer-balanced-rotation-v1`。
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

## 下一步与边界

[第四轮 38523458804](https://github.com/baicie/nyala-studio/actions/runs/38523458804) 使用同一
已提交 revision 和完整 balanced plan 重采，已产出两个平台完整记录，正式 gate 仍 NO-GO。
[修复验证 38525197105](https://github.com/baicie/nyala-studio/actions/runs/38525197105) 正在对
本轮取证修复进行完整双平台验证；不以最好的一轮覆盖失败记录。

进一步归因应沿用 admission 的 `commitScroll` 算法，在独立诊断运行中为同一次操作采集
提交区间和等待 / 验证区间，关闭 node churn；先区分 CPU 长尾与呈现调度，再实验具体生产
优化。正式运行仍使用原模式，诊断数据不能改写历史 gate。

本次没有修改性能阈值、门禁比例、采样数量、平衡顺序或历史证据；未引入 Nyala 生产 Zeus
依赖，Z1 未转为 GO，Z2 不启动。测量契约设计讨论须明确区分指标与产品目标，不能把改判据
描述成对已证明宿主问题的唯一修复。
