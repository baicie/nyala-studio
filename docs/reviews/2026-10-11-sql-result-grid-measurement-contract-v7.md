# SQL Result Grid 测量契约 v7 设计

日期：2026-10-11

关联：[2026-10-09-zeus-performance-root-cause.md](./2026-10-09-zeus-performance-root-cause.md)、
[2026-10-11-zeus-performance-external-blocker.md](./2026-10-11-zeus-performance-external-blocker.md)

## 动机

v6 的 `scrollP95Ms` 把 renderer 工作和宿主 WebView 呈现等待混在一个数里。正式三平台证据已经证明该指标在轻量基线上不可辨识：

- 空循环 `presentationFloor` p95 为 `18.7ms`，而 Windows `10k x 50` 要求 Zeus ≤ `13.1ms`
- 该负载下任何 renderer 达到过的最好成绩是 `16.4ms`
- macOS `1k x 20` 的「27% 回归」在本地真实 WKWebView 上为 `0%`，两者同为 `33.0ms`，差异纯属 input/settle 记账位移

因此 v6 无法对当前实现给出有效判决。v7 的目标是让门禁**能够区分 renderer 工作与呈现等待**，并且在基线低于可辨识下限时诚实地标为不可评估，而不是产生必然失败的假信号。

## 保留与冻结

v6 历史证据一律保留、不重写。`MEASUREMENT_CONTRACT_VERSION` 升为 `7`，
`phase-z1-gate.json`、`docs/sql-mvp-phases/phase-z1-benchmark.json` 等既有产物继续按 v6 校验。

阈值本身**不因 v7 而放宽**：

```text
1k x 20   非劣：回归 ≤ 10%
10k x 50  优效：改善 ≥ 20%
```

v7 只改变「用什么量来判定」以及「基线不可辨识时如何表达」。

## v7 记录内容

每条平台 record 新增：

| 字段                | 含义                                                                  |
| ------------------- | --------------------------------------------------------------------- |
| `presentationFloor` | 空循环呈现机会 p95/median，20 个样本，与 v6 diagnostic profile 同口径 |
| `rendererInterval`  | renderer 自有 CPU 区间并集（handler + range + commit + layout read）  |
| `oneFrameCorrect`   | 全部正式样本是否在第一次呈现机会内完成可见行校验                      |

`presentationFloor` 是 v7 判定的关键：它给出该平台该负载下的**不可约成本**。

## 判定规则

### 可评估性优先于判决

对每个平台、每个负载，先判定可评估性，再谈通过与否：

```text
requiredZeus = baselineP95 x (1 - improvementTarget)

若 requiredZeus + tolerance < sharedPresentationFloorP95
  => NOT-EVALUABLE，理由：该平台该负载的呈现地板高于门禁要求的绝对值
否则
  => 正常判定（非劣 / 优效）
```

`sharedPresentationFloorP95` 取该平台该负载下**全部 renderer** 的 floor 中位数，
因为该成本由宿主 WebView 决定，与 renderer 无关。

这个判据复用了仓库已有的 `createSqlResultGridFloorHeadroomProfile` 中的
`floorExceedsRequiredTargetWithinTolerance`，不引入新的数学。

### 地板之上的余量才是真实信号

地板以下的部分对所有 renderer 相同，因此在地板之上比较才可辨识：

```text
headroom(renderer) = max(0, rendererP95 - sharedPresentationFloorP95)
```

判定使用 `headroom`，而非原始 p95。这不改变阈值语义：20% 改善要求依然成立，
只是扣掉了所有实现都要付的公共成本。

## 对现有 Z1 结论的影响

按现有 CI 证据重算：

| 平台             | 负载       | 结论                                             |
| ---------------- | ---------- | ------------------------------------------------ |
| Windows WebView2 | `10k x 50` | `NOT-EVALUABLE`：要求 `13.1ms` 低于地板 `16.4ms` |
| macOS WebKit     | `1k x 20`  | 可评估，正常非劣判定（本地实测 0% 回归）         |

Z1 仍然**不会自动翻为 GO**：macOS 1k 必须用新的 v7 采集重新证明，
而 10k 从「必然失败」变为「诚实不可评估」，需由 v7 采集给出结论。

## 实施面

```text
scripts/sql-result-grid-benchmark-contract.mjs        版本常量、floor 校验器
scripts/benchmark-sql-result-grid.mjs                 每条 record 采集 presentationFloor
scripts/benchmark-sql-result-grid-webdriver.mjs       平台 record 采集 presentationFloor
scripts/verify-sql-result-grid-gate.mjs               v7 可评估性优先判定
scripts/merge-sql-result-grid-platform-evidence.mjs   汇总层携带 floor
```

## 风险

- **诊断开销**：在正式采集中测 floor 会引入空循环等待，但该开销发生在滚动采样之外，
  不进入 `scrollP95Ms`。需要用 v6/v7 对照确认正式样本数值未被扰动。
- **契约升级范围**：`MEASUREMENT_CONTRACT_VERSION` 被 12 个文件引用，
  所有 fixture 必须同步到 v7，且 v6 历史产物必须继续可校验。
- **不得借此放宽门禁**：`NOT-EVALUABLE` 是把假信号变成诚实结论，
  不是把失败变成通过。v7 采集若显示真实回归，门禁仍须失败。
