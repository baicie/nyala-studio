# Zeus / Zeus UI / Nyala：性能准入根因分析与修复建议

日期：2026-09-22。范围：三个本地仓库的当前源码、Nyala Z1 性能记录、重新构建的 Data Grid 候选包和本机 Chromium 实验。本文交付诊断与建议；没有修改产品源码、发布包、修改准入阈值或启动 Z2。

**结论：不能把当前 NO-GO 归结为“Zeus 框架整体慢”。已确认 Nyala 测量合同的可辨识性问题，并新发现连续滚动采样接错 WorkbenchTable 横向状态的缺陷；zeus-ui 存在可继续优化的窗口边界分配，但尚未证明它是五个正式失败项的共同根因。**

## 1. 结论与置信度

| 发现                                              | 证据与影响                                                                                           | 判断                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| v6 单次远跳延迟受共同呈现时间下限支配             | 新诊断中 baseline 19.20ms，20% 目标 15.36ms，共同 floor 17.40ms；200/200 个 10k 样本只需一次呈现机会 | 已复现；说明该本机 profile 无法有效识别 20% 优势 |
| 连续滚动横向位移采错对象                          | WorkbenchTable 实际左移 800px，采样值仍为 0；两次独立页面复现                                        | 已确认的 Nyala harness 缺陷，阻塞当前 jank 诊断  |
| “CPU 更少”与“单次远跳更快”被混用                  | 10k renderer 区间 p95 为 Zeus 3.00ms / Workbench 10.80ms，但外层 scroll p95 仍为 19.30 / 19.20ms     | 已观测；两种指标不能互相代替                     |
| 行池在窗口长度变化时发生创建/销毁                 | 每组 100 次 scroll commit 中 35 次有 Node churn；源码按当前可见窗口长度维护槽位                      | 已确认机制；收益量仍需单变量 A/B                 |
| beta.4 诊断遍历混入 commit 计时                   | 旧版在计时终点前消费 MutationObserver；当前工作树已分离终点                                          | 历史归因缺陷；不是关闭诊断的正式性能失败的解释   |
| Zeus core scheduler / 固定行高 SizeCache 是主瓶颈 | 当前链路同步 effect/batch/For；无全量行模型重建，range p95 0.20ms                                    | 现有证据不支持优先改写                           |

正式 beta.4 的五个性能失败依然有效。本文的本地候选、Chromium 测量和临时实验都不能替换双原生 WebView 的正式证据。尤其不能把“10k 的 20% 指标受 floor 限制”扩写为“1k 回归不是真问题”。

## 2. 审计对象与复现边界

| 仓库    | HEAD / 分支                                                                        | 开始审计时工作树 |
| ------- | ---------------------------------------------------------------------------------- | ---------------- |
| Nyala   | `882ba2225630bc2cfb0f007669ed4da73d41bf10` / `codex/feat-sql-agent-schema-adapter` | 72 条未提交路径  |
| zeus-ui | `678d95bd04f5e30a613e62db5706cb5994f18c54` / `codex/release-0.1.0-beta.5`          | 4 个已有修改文件 |
| zeus    | `a099abbf03acaf1ad2a78963e5ead72da2758a18` / `main`                                | 干净             |

环境：macOS 15.7.7、arm64、Node 26.9.0、本机 Chrome headless。运行时版本及参与分析的源码 SHA-256 随证据保存。未重新查询 npm/GitHub 发行状态，不能从本地 `beta.5` 清单推断已经发布。

从 zeus-ui 当前源码执行 Data Grid build，再用 esbuild 打包 `dist/wc/auto.js`，得到：

- SHA-256：`3f66cf7e58e8e4ac523bfc4644f1a735fe0fe5f4db5a8469e365f69523ad2c58`。
- 原始大小 90,370 bytes；gzip level 9 为 29,778 bytes，距 30,000-byte 门槛仅余 222 bytes。
- 字节与此前诊断记录中的候选 bundle 相同；这是本地工作树构建，不是新的正式准入包。

实验一关闭诊断，两个 workload × 两个 renderer × 5 次平衡轮转，共 20 records。实验二开启双方 CPU 区间与 Zeus churn 诊断，重复相同矩阵，共 20 records。两次实验顺序运行；每次内部 renderer 顺序平衡，但两次实验之间不是随机化 A/B，不能把跨次差值全部归因于诊断开销。

## 3. 本次测量

### 3.1 关闭诊断的真实组件 benchmark

表中 scroll p95 是“每次运行 20 个样本的 p95，再对 5 次取中位数”。mount 为当前 harness 的 render interval 中位数，包含其就绪等待；没有用它冒充 renderer CPU。

| workload | WBT scroll p95 | Zeus scroll p95 | Zeus 相对 WBT        | WBT / Zeus mount | WBT / Zeus DOM elements |
| -------- | -------------: | --------------: | -------------------- | ---------------- | ----------------------- |
| 1k × 20  |        17.50ms |         18.70ms | 回归 6.86%           | 11.90 / 8.90ms   | 404 / 330               |
| 10k × 50 |        19.80ms |         18.50ms | 改善 6.57%，未达 20% | 15.90 / 9.70ms   | 914 / 330               |

20/20 records 成功；400/400 样本在一次呈现机会内达到当前内容/行标识校验。这个本地 1k 点估计低于 10% 回归线，不能撤销历史双平台失败，也不能代替足量统计验收。heap 差值受 GC 和负增量记为 null 的现有采样方式影响，本报告不据此判定内存泄漏。

### 3.2 CPU 与呈现等待分解

| 指标                                       |       1k × 20 |       10k × 50 |
| ------------------------------------------ | ------------: | -------------: |
| Zeus / WBT renderer 区间 union p95         | 2.80 / 3.50ms | 3.00 / 10.80ms |
| 区间 p95 比值                              |         0.800 |          0.278 |
| Zeus `inputTime → handlerStartTime` p95    |       13.60ms |        14.00ms |
| Zeus `handlerEndTime → rangeStartTime` p95 |        0.10ms |         0.10ms |
| Zeus range 计算 p95                        |        0.20ms |         0.20ms |
| Zeus commit interval p95                   |        2.70ms |         2.80ms |
| commit 后 diagnostics tail p95             |        0.10ms |         0.10ms |
| 行包装对象平均分配 / scroll commit         |          21.3 |           21.3 |
| 有 Node churn 的 scroll commit             |        35/100 |         35/100 |

CPU ratio 是带不同插桩开销的 elapsed-interval 诊断值，没有 paired-bootstrap CPU 置信区间，也不包括所有浏览器异步 style/layout/paint。不能把 `0.278` 宣称为用户速度提高 72.2%。历史同一候选的 10k ratio 曾为 `0.500`，也说明单轮点估计不宜用作承诺。

每条 Zeus record 都只记录一次 model build，eager row wrapper 为 0；未见滚动时全量重建。原始 `inputTime` 使用浏览器 event timestamp，上表仅为同源时钟下的观察差值，不能把全部差值精确命名为某一个 scheduler 的耗时。

## 4. 根因链条

### 4.1 v6 测量合同：等待占主导，阈值对当前轻量基线不敏感

[commitScroll](../../scripts/benchmark-sql-result-grid.mjs) 设置滚动位置后，统一经过 [waitForPresentationOpportunity](../../scripts/sql-result-grid-benchmark-contract.mjs) 的 `requestAnimationFrame → setTimeout(0)`，然后读取 layout 并校验行内容。它测量的是含输入、调度等待与验证的外层延迟，不是纯 DOM patch 时间。

诊断得到 `F = 17.40ms`、`B = 19.20ms`，合同要求 `Z ≤ 0.8B = 15.36ms`。在以实测 floor 作为同组下限的模型中，目标低于 floor；要在该模型下辨识 20% 改善，至少需要 `B ≥ 1.25F`。

这里的 floor 是本机空操作参考分布，并非跨设备、跨输入时相的物理常数。不能逐样本直接相减，不能套用到没有对应 floor 测量的 Windows/macOS 历史失败，也不能删除慢样本来“修正”指标。

[HTML rendering 模型](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering) 将呈现机会与刷新率、可见性等因素关联。这里的 rAF 后任务与 DOM 命中验证仍是呈现机会代理，不是 GPU 扫描输出时间戳。

### 4.2 两种输入更新路径不同；未发现 Zeus core 额外延迟一整帧的证据

- WBT 的 [benchmark adapter](../../scripts/sql-result-grid-workbench-table-entry.ts) 把 setter 转到 `table.scrollTop`；[ListView](../../src/vs/base/browser/ui/list/listView.ts) 通过内部 Scrollable 通知同步 render。
- Zeus Data Grid 监听原生 viewport scroll，再经 [createRafScheduler](../../../zeus-ui/packages/advanced/virtual/src/core/scheduler.ts) 合并 `updateRange`。
- Zeus [createEffect](../../../zeus/packages/core/signal/src/primitives.ts)、[effect/batch](../../../zeus/packages/core/signal/src/effect.ts)、[keyed For](../../../zeus/packages/core/runtime-dom/src/list.ts) 的这条更新链并非“所有绑定统一再等一次 rAF”。通用 `queueJob` 文件存在不代表它支配 Data Grid 的这条路径。

新样本中 handler 到 range p95 仅 0.10ms，所有普通 scroll 样本都一次呈现机会内完成。因此“Zeus core 总会额外等一帧”被当前样本否定。原生 scroll 事件分派、rAF 时相、DOM 更新和浏览器布局的组合仍可能解释部分外层差距；五个正式失败项各自的毫秒级归因尚未完成。

### 4.3 新确认：连续滚动读错了 WBT 横向状态

原命令开启 `--jank-trace true` 后，在第一条 WBT 1k record 报错：

```text
Jank trace horizontal scroll span 0px is below the pre-registered 500px.
```

原因链：

1. `sql-result-grid-workbench-table-entry.ts` 返回的 `scroll` 仅暴露纵向属性，没有 `scrollLeft`。
2. `benchmark-sql-result-grid.mjs::createTraceScrollOffsets` 因此回退到 `rendered.viewport.scrollLeft`。
3. WBT 用内部滚动状态驱动 rows 的 CSS `left`；该 viewport 的原生 `scrollLeft` 可一直为 0。
4. 两次独立浏览器 probe 中，真实 wheel 输入使首个 cell 的 x 从 0 变为 -800、rows style 从 `left: 0px` 变为 `left: -800px`，采样值却始终为 0。

建议在 benchmark-only adapter 中暴露真实 getter：

```ts
get scrollLeft() {
	return table.scrollLeft;
}
```

采样器应使用 renderer 提供的显式双轴 controller；避免依据“DOM 对象上恰好存在某个数值属性”猜测控制面。回归必须实例化真实 WBT、发 wheel 输入，同时核对 controller 位移、cell 可见位置和 500px 位移 guard。只测普通 `{scrollLeft: 640}` 对象覆盖不到这个缺陷。

临时构建只补这个 getter，随后两个 workload × 两 renderer × 3 次的完整 jank 实验 **12/12 成功、exit 0**。WBT 实测横向跨度分别为 810px / 3,150px，原来的 0px 错误消失。没有删除位移校验或降低阈值。本次修改只在 `/tmp` 构建转换中实施，没有落入仓库源码。

成功采样不等于性能通过：修正采样后的 10k WBT jank 约 0.094%，低于草案要求的 1% 可评估下限，结果仍是 `NOT-EVALUABLE`；1k 的 jank 差值置信上界约 +1.092 个百分点，超过草案 +1 个百分点界线。只有 3 对本地 runs，不是正式样本量，也没有原生平台身份。

另一个实验约束是相同 wheel delta 并不产生相同距离：本轮 WBT / Zeus 的纵向跨度约 3,150 / 7,560px，10k 横向跨度约 3,150 / 756px；WBT 自定义 wheel 归一化与原生滚动语义不同。正式方案需预先明确比较“相同设备输入”还是“相同行程/速度”，记录每段实际位移和输入确认时间。当前 offset 摘要仅保留 first/last/min/max，不能单独证明每段都发生反向滚动；不能把它称为完整的双轴轨迹证据。CDP 确认背压还可能拉长名义 5 秒窗口，正式采样应明确允许范围。

### 4.4 zeus-ui：窗口大小变化导致有界分配，尚不是已证明的主要瓶颈

[getBodyRowReconciliationKey](../../../zeus-ui/packages/advanced/data-grid/src/components/data-grid.tsx) 使用 viewport slot key，已能复用相同长度窗口；[grid-virtualizer](../../../zeus-ui/packages/advanced/data-grid/src/core/grid-virtualizer.ts) 也复用重叠区域的 row data。但 `For` 的项数仍来自当前带 overscan 的窗口，首尾边界裁切会改变长度，多出的槽位被 core 正常销毁，下次扩张再创建。

[row-model::getRow](../../../zeus-ui/packages/advanced/data-grid/src/core/row-model.ts) 每次非重叠命中返回一个新包装对象；远跳平均 21.3 次分配是窗口级，不是 10k 行级。Node churn 计数包含 Node tree entries，不能直接与上一表只计 Element 的 DOM 数比较。

本轮 10k 有 churn 的 commit 平均 1.87ms，无 churn 平均 1.36ms。这只是分组相关性，混有边界位置、窗口长度、更新量等差异；不能据此承诺固定池能节省 0.51ms，更不能保证通过 v6。

可实验固定容量 row/cell pool，再实验 bounded wrapper reuse；每次只改一个因素。必须保留聚焦行禁用重绑定、变量行高、排序、行替换、事件 payload、ARIA identity 和 disposal 语义。不要原地改写可能已被消费者持有的 row wrapper。

固定行高 [SizeCache](../../../zeus-ui/packages/advanced/virtual/src/core/size-cache.ts) 已有乘法/除法快路径；测量覆盖或函数型尺寸路径仍会扫描，但本次固定行高场景没有证据落到该慢路径。

### 4.5 诊断与验收之间有测试缺口

旧 beta.4 把 `takeRecords()` 与 Node 递归计数计入 `commitEndTime`。zeus-ui 当前工作树已先记录 commit end，再写独立 `diagnosticsEndTime`，并支持关闭 churn；本次重建 bundle 已包含这些更改。新 tail p95 0.10ms，不支持把数毫秒正式回归归咎于这段遍历；正式 v6 普通采样也没有开启它。

zeus-ui 的 [Vitest 配置](../../../zeus-ui/vitest.config.ts) 将 `e2e` 和 `data-grid-benchmark` 都配置成 jsdom。它们证明了接口、复用、清理和诊断语义，无法证明浏览器 paint/jank。Nyala 当前 63 个 benchmark tests 全绿，真实横向采样仍失败，说明缺的是“编译后的真实组件 + 输入 + 采样桥”的集成回归。

## 5. 修复建议与顺序

| 优先级   | 责任仓库         | 建议                                                                                | 验收依据                                                                       |
| -------- | ---------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| P0       | Nyala            | 修复 WBT 横向 getter/显式 controller，增加真实浏览器双轴回归                        | 原失败场景转成功，位移 guard 保留；状态、内容与实际位移一致                    |
| P0       | Nyala / 产品决策 | 明确 v7 的可辨识性与退出路线，再锁定指标                                            | baseline jank <1% 时仍为 NOT-EVALUABLE；不能为通过而事后降低阈值               |
| P1       | zeus-ui          | 收口已有 split timing/churn 诊断更改，补版本与实际 artifact 归因                    | unit/runtime/build/types 检查；关闭诊断保持无 observer；重新核对 30KB budget   |
| P1       | Nyala            | 双原生 WebView observer-free wheel trace；独立收集对称 CPU 和 one-frame correctness | 足量 paired runs、原始输入、置信区间、同 revision/digest；CPU 数字不能单独放行 |
| P2       | zeus-ui          | 固定容量池与 wrapper reuse 分开 A/B                                                 | 同包、同工作负载、平衡顺序；延迟/CPU/GC 与焦点、ARIA、变量高度同时验证         |
| 暂不优先 | zeus             | 不先改通用 scheduler、keyed For 或 signals 架构                                     | 只有 trace 指向具体重复 effect/DOM move 才扩大修改面                           |

v7 草案还有两点需要在正式采样前明确：

- [ADR 0004](../adr/0004-zeus-data-grid-v7-floor-aware-metrics.md) 的 jank superiority 只在 WBT baseline ≥1% 时可判定；流畅基线可能继续让结果 NOT-EVALUABLE。预先选择更具代表性的压力场景，或明确没有可证明收益就停止引入 Zeus，不能把它自动转换为 Go。
- 草案 secondary DOM ratio ≤0.50 未在表格中限定 workload。本次 1k ratio 为 `330/404 = 0.817`，10k 为 `330/914 = 0.361`；如果该门适用于 1k，当前候选仍会失败。必须先澄清范围与产品理由，不能观察结果后悄悄排除 1k。

30KB gzip 只余 222 bytes；在 renderer 中加入缓存、诊断或池管理都会消耗预算，应每步重算。A4 Checkpoint W 是独立的原生键盘/读屏门，本报告不解除它。

## 6. 本次验证与证据

完整命令、退出码、源文件指纹和临时实验说明见 [证据摘要](./2026-09-22-zeus-root-cause/summary.json)。原始 benchmark 以 gzip 保存，可解压为 JSON 复算；其中全部数据均为合成 benchmark fixture。

| 命令 / 验证                                                                                                                                                                                                         | 结果                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| zeus-ui：`pnpm --filter @zeus-web/data-grid build`                                                                                                                                                                  | exit 0                                                   |
| zeus-ui：`pnpm exec esbuild packages/advanced/data-grid/dist/wc/auto.js --bundle --format=iife --platform=browser --minify --legal-comments=none --outfile=/tmp/nyala-zeus-root-cause-20260922/data-grid-bundle.js` | exit 0                                                   |
| Nyala：两个 workload / 两 renderer / repeat 5，关闭诊断                                                                                                                                                             | exit 0，20/20 records                                    |
| Nyala：相同矩阵，开启 diagnostic profile                                                                                                                                                                            | exit 0，20/20 records；floor 和 CPU 分析均 exit 0        |
| Nyala：原始 `--diagnostic-profile true --jank-trace true`                                                                                                                                                           | exit 1；横向位移错误已复现                               |
| 两次真实 wheel / 可见 cell 位移 probe                                                                                                                                                                               | exit 0；均左移 800px，但采样为 0                         |
| 临时 getter-only build：repeat 3 / 双 workload / 双 renderer / jank trace                                                                                                                                           | exit 0，12/12 records；修复采样，未通过性能准入          |
| Nyala：`pnpm run test:sql-result-grid-benchmark`                                                                                                                                                                    | exit 0，63/63                                            |
| Nyala：`node --test scripts/sql-result-grid-jank-trace.test.mjs`                                                                                                                                                    | exit 0，35/35；该独立套件未在当前 package 默认 test 链中 |
| zeus-ui：`pnpm --filter @zeus-web/data-grid test:e2e --run`                                                                                                                                                         | exit 0，5 files / 104 tests，jsdom                       |
| zeus：`pnpm test-unit packages/core/signal/__tests__/diagnostics.spec.ts packages/core/runtime-dom/__tests__/controlFlow.spec.ts`                                                                                   | exit 0，2 files / 56 tests                               |

本轮没有执行 Nyala 全量 build/test、Rust 检查或双原生 WebView 重测；没有把局部成功写为正式 Go。新缺陷的修复建议已在隔离构建中验证，生产代码修复与长期回归仍是后续工作。
