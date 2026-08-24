# Zeus Data Grid 性能整改与重新验收报告

> 日期：2026-08-18；2026-08-24 完成 beta.4 与双原生 WebView 复验
>
> 面向：Zeus、zeus-ui 与 Nyala Studio 维护者
>
> 范围：`@zeus-web/data-grid`、`@zeus-web/virtual`、Zeus core runtime，以及 Nyala Z1 性能指标
>
> 状态：既定整改与发布已完成；revision-bound v6 证据完整但性能门仍为 `NO-GO`

## 结论先行

当前问题包含两个相互独立的部分，不能用同一种改动解决：

1. **既定上游整改已经进入正式 beta。** zeus-ui `0.1.0-beta.4` 消除了大型 rows 的 eager O(N)
   wrapper，改用 row-key/column-id 索引，并补齐真实 input timestamp 与 allocation diagnostics；Zeus core
   `0.1.1-beta.2` 提供 opt-in effect/proxy/scope/ref/memo/allocation counters。单次首挂、shallow props、
   keyed `For`、有限 `@once`、snapshot cache 和固定行高 pooling 仍在发布闭包内，scheduler 未重写。
2. **CI 可执行性问题已经关闭，性能问题没有被掩盖。** run `32706467306` 的 macOS WKWebView 与
   Windows WebView2 job 均成功，各有 60/60 `ok` records 与 12/12 有效截图；aggregate 只因 5 个
   预注册性能检查失败而按设计返回 `NO-GO`。Windows narrow-panel 的实际 `391x420` viewport 现在按
   workload `390x420` 的 +/-1px 合同被正确接受，document geometry 精确匹配实际 viewport。

因此，建议同时推进两条轨道：

- 性能实现先继续落在 **zeus-ui Data Grid/Virtual**；Zeus core 只做强类型 diagnostics、effect/proxy/
  allocation 计数和有证据支持的 `@once` 扩面，暂不做全局 runtime 或 scheduler 重写。
- Nyala 冻结现有 v6 与历史 `NO-GO`，另行预注册一个新的性能实验合约。新合约正式采数前必须先固定
  指标、阈值和统计方法；不能用新指标回写旧 v6 为 `GO`。

这不是“Zeus 没有性能价值”的结论。现有适配优化已经把 Zeus 10k 首屏 render median 从
`157.0ms` 降到 beta.2 profile 的 `21.6ms`；beta.3 两轮合并 profile 又降到 `14.9ms`，DOM 节点相对
WorkbenchTable 减少 `63.9%`。beta.4 的正式 audit bundle 为 90,528 raw / 29,841 gzip，仍过 30 KB
门但只余 159 bytes。当前阻塞点已经由完整双平台 evidence 收敛为 steady-scroll 性能阈值，而不是发布、
npm 鉴权、证据缺失或 CI harness 错误。

## 决策边界

- 现有 `Z1.3 = NO-GO`，`Z2 = 禁止开始`，`R0 = NO-GO`。
- Zeus 仍不是 Nyala 的 production dependency，也没有 production renderer integration。
- 本报告不修改 v6、20% 阈值、checked-in gate report 或历史 benchmark。
- Chromium 结果只用于诊断。当前 revision 已有 macOS embedded WKWebView、Windows embedded
  WebView2、fresh bundle audit 与截图；由于 v6 性能门失败，仍没有可供 R0 使用的 protected Go
  attestation。

## 原始 beta.2 证据身份

| 项目                          | 本轮身份                                                             |
| ----------------------------- | -------------------------------------------------------------------- |
| Data Grid                     | `@zeus-web/data-grid@0.1.0-beta.2`                                   |
| Virtualizer                   | `@zeus-web/virtual@0.1.0-beta.2`                                     |
| Zeus core runtime             | `0.1.0-beta.8` dependency closure                                    |
| Zeus bundle SHA-256           | `0dddde8f65195667d1bdd0f574f2ac3a4ffa1c5b019c8f1a13db5bd2fc0a6794`   |
| Zeus bundle size              | `73,494` raw bytes；gzip -9 `24,311` bytes                           |
| WorkbenchTable bundle SHA-256 | `f58986b454aeecbe8500c0357f76839140f26f22149294f14a5e8435a4128a35`   |
| Nyala source revision         | `8c75600a727c7d6268e11a0fbb92e40f7c03a24d`，`sourceTreeClean: false` |
| 浏览器                        | Headless Chrome 151，macOS host                                      |
| 证据性质                      | dirty-tree Chromium diagnosis，不是 admission evidence               |

主要 Nyala 证据：

- [`phase-z1-feasibility-profile.json`](../sql-mvp-phases/phase-z1-feasibility-profile.json)：12 条 real
  WorkbenchTable/Zeus records、240 个 scroll samples、240 个 presentation-floor samples。
- [`phase-z1-spike-verification.md`](../sql-mvp-phases/phase-z1-spike-verification.md)：单变量适配实验、
  bundle audit、measurement contract 和 Z1 状态。
- [`benchmark-sql-result-grid.mjs`](../../scripts/benchmark-sql-result-grid.mjs)：fixture、renderer adapter、
  scroll measurement 与 summary producer。
- [`sql-result-grid-benchmark-contract.mjs`](../../scripts/sql-result-grid-benchmark-contract.mjs)：v6
  presentation boundary、balanced plan 与 correctness contract。
- [`verify-sql-result-grid-gate.mjs`](../../scripts/verify-sql-result-grid-gate.mjs)：20% 主门槛的独立重算。

上游发布 sourcemap 中审计的核心路径：

```text
@zeus-web/virtual
  virtual/src/core/scheduler.ts
  virtual/src/core/size-cache.ts
  virtual/src/core/virtualizer.ts

@zeus-web/data-grid
  data-grid/src/core/grid-virtualizer.ts
  data-grid/src/core/row-model.ts
  data-grid/src/core/sort-model.ts
  data-grid/src/components/data-grid.tsx

Zeus core
  packages/core/runtime-dom/src/defineElement.ts
  packages/core/runtime-dom/src/bindings.ts
  packages/core/runtime-dom/src/list.ts
  packages/core/signal/src/state.ts
```

## 复现方法

### 精确复现 npm 发布包

以下命令在临时目录安装并打包 exact-pinned 发布包，不修改 Nyala 的 `package.json` 或 lockfile：

```bash
ZEUS_AUDIT_DIR="$(mktemp -d)"
printf '{"name":"nyala-zeus-audit","private":true}\n' > "$ZEUS_AUDIT_DIR/package.json"
pnpm add --dir "$ZEUS_AUDIT_DIR" --save-exact \
  @zeus-web/data-grid@0.1.0-beta.2 esbuild@0.28.1

"$ZEUS_AUDIT_DIR/node_modules/.bin/esbuild" \
  "$ZEUS_AUDIT_DIR/node_modules/@zeus-web/data-grid/dist/wc/auto.js" \
  --bundle --format=iife --platform=browser --minify --legal-comments=none \
  --outfile="$ZEUS_AUDIT_DIR/data-grid-bundle.js"
```

随后在 Nyala 仓库运行不覆盖 checked-in evidence 的诊断 profile：

```bash
ZEUS_PROFILE_DIR="$(mktemp -d)"
node scripts/benchmark-sql-result-grid.mjs \
  --diagnostic-profile true \
  --repeat 6 \
  --workload 10k-x-50 \
  --renderer workbench-table,zeus \
  --workbench-table-implementation real \
  --require-zeus true \
  --zeus-bundle "$ZEUS_AUDIT_DIR/data-grid-bundle.js" \
  --output "$ZEUS_PROFILE_DIR/profile.json"
```

测试本地 Zeus/zeus-ui 修改时，先用上游仓库自己的 build 生成 `dist/wc/auto.js`，再用同一 esbuild
参数生成 bundle，并把 `--zeus-bundle` 指向该文件。每个单变量版本都应记录 bundle SHA-256，不能混用
不同构建产物的结果。

### 当前诊断合同

| 项目                | 值                                                                              |
| ------------------- | ------------------------------------------------------------------------------- |
| workload            | 10,000 rows x 50 columns                                                        |
| viewport            | 1440 x 420 CSS px                                                               |
| row height          | 28 px                                                                           |
| renderers           | real WorkbenchTable、exact-pinned Zeus                                          |
| repeats             | 每个 renderer 6 次，balanced rotation                                           |
| scroll samples      | 每个 record 20 次真实大位移                                                     |
| completion boundary | `scrollTop -> requestAnimationFrame -> setTimeout(0) -> row/content validation` |
| correctness         | offset、visible row index/content、row tolerance、bounded DOM 全部校验          |
| Zeus adapter        | `array-index` rows、无显式 refresh、row overscan 4、column overscan 1           |

## 当前结果

`scroll p95 median` 的正式聚合方式是先对每个 run 的 20 个样本计算 p95，再对 6 个 run 取 upper
median。`input p95` 与 `settle p95` 是同形态的诊断分项，不是 v6 admission metric。`render p95` 与
`scroll max p95` 则直接对 6 个 record-level 单值计算 cross-run p95；在 `n=6` 时它们实际等于样本最大值，
只能作为本轮 sizing 信号，不能解释为稳定的总体 p95。

| 指标                      | WorkbenchTable |   Zeus | 解释                                                |
| ------------------------- | -------------: | -----: | --------------------------------------------------- |
| render median             |         19.9ms | 21.6ms | Zeus 回归 8.5%                                      |
| render p95                |         30.1ms | 30.9ms | Zeus 回归 2.7%                                      |
| scroll p95 median         |         17.7ms | 18.1ms | Zeus 改善 -2.26%                                    |
| per-run input p95 median  |          7.2ms |  0.1ms | Zeus 同步 setter 已很便宜                           |
| per-run settle p95 median |         13.6ms | 18.1ms | 时间主要转移到 presentation wait                    |
| scroll max median         |         20.8ms | 23.8ms | Zeus long tail 较高                                 |
| scroll max p95            |         33.1ms | 56.3ms | 需要 GC/allocation trace                            |
| DOM nodes median          |            914 |    330 | Zeus 减少 63.9%                                     |
| available heap delta      |         4.53MB | 3.69MB | 仅 2/6 与 1/6 records 非 null，不可作 renderer 比较 |

120 个样本/renderer 的诊断均值也显示相同的成本转移：

| renderer       | setter/input | presentation wait | validation |    total |
| -------------- | -----------: | ----------------: | ---------: | -------: |
| WorkbenchTable |      4.667ms |          11.578ms |    0.090ms | 16.343ms |
| Zeus           |      0.448ms |          15.900ms |    0.077ms | 16.429ms |

所有 240 个 scroll samples 都在第一个 presentation opportunity 正确提交。Zeus 没有在这组离散跳转中
稳定多等一帧；它只是更快返回 setter，然后等待同一个 presentation boundary。因此不能把
`inputMs = 0.1ms` 单独解释成用户体验胜利，也不能把 `settleMs` 单独解释成 Zeus CPU 时间。

### 为什么旧 20% 门槛不可达

设：

```text
B = WorkbenchTable scroll p95 = 17.7ms
Z = Zeus scroll p95           = 18.1ms
F = shared presentation floor = 17.5ms
```

旧门槛要求：

```text
Z_required = B * (1 - 0.20) = 14.16ms
observed improvement = (B - Z) / B = -2.26%
floor-bounded maximum = max(0, (B - F) / B) = 1.13%
```

`14.16ms < 17.5ms`，所以仅修改 Zeus 代码不能在当前 v6 boundary 下得到 +20%。这只能证明主指标
`PRESENTATION_FLOOR_LIMITED`，不能证明 Zeus 没有 CPU、GC、DOM 或连续滚动优化空间。

不要用 `p95(total) - p95(floor)` 估算 renderer CPU。分位数不可直接相减，且当前 floor 是在整组
scroll samples 之后采集，不是逐样本相邻配对。若后续保留 floor-normalized diagnosis，必须把 no-op
floor 随机交错到每个 block 前后，再计算：

```text
excess_i = max(0, total_i - adjacent_floor_i)
```

即使如此，`excess_i` 也只是诊断值，不能替代真实连续滚动与正确呈现指标。

## beta.2 基线的已验证与待验证假设

下表冻结 2026-08-18 形成整改清单时的状态；beta.3 的实际落地状态见下一节，不能把本表中的“待验证”
继续解释成当前发布状态。

| 假设                                            | 状态                                    | 证据                                                                        | 后续动作                             |
| ----------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------ |
| Adapter 的重复 `refreshViewport()` 增加首屏成本 | 已确认                                  | 删除后两次复跑 render 改善约 8.6%-9.2%                                      | 保持删除，不恢复                     |
| Adapter 预先构造 record object 是主要首屏成本   | 已确认                                  | 直接复用二维 row arrays 再改善约 59.7%-60.0%                                | 保持 `array-index` rows              |
| `overscan = 0` 会更快                           | 已否定                                  | DOM 少 60 个，但 render 和 scroll 都恶化                                    | 保持 row overscan 4                  |
| v6 主指标受共同 presentation floor 限制         | 已确认                                  | floor 17.5ms，高于目标 14.16ms                                              | 新指标必须另行预注册                 |
| 首次挂载重复构建整个 row/column model           | 源码高置信，待浏览器 A/B                | setup 已建模，但 `builtModelVersion = -1` 导致首次 `getSnapshot()` 再建一次 | 优先实现 A                           |
| 深度 Proxy 大型 rows 造成额外包装与 tracking    | 源码和 Node 微基准高置信，待浏览器 A/B  | 10k raw map 约 0.18-0.33ms，deep-proxy map 约 1.06-5.37ms                   | 优先实现 B                           |
| 静态 binding effect 与整窗重建造成 GC long tail | 源码高置信，尚无浏览器 allocation trace | 远距离跳转会重建约 250-310 cells 及约 2,500-3,300 effects                   | 实现 C，记录 effect/node churn       |
| rAF scheduler 导致稳定额外丢一帧                | 当前未确认                              | 所有样本均在第一次 opportunity 提交                                         | 先加 timing，再做 scheduler A/B      |
| Zeus 56.3ms scroll max p95 由 GC/分配导致       | 合理但未确认                            | 当前没有 GC/Performance trace                                               | 用 trace 和 allocation counters 验证 |
| `SizeCache` 是固定行高当前主瓶颈                | 未确认                                  | 固定行高通常走 O(1) 路径                                                    | 只加复杂度/回归测试，不先重写        |

## 2026-08-20 beta.3 复验

### 发布身份与发布缺口

| 项目                     | 核验结果                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zeus core                | `0.1.1-beta.1`；tag SHA `6deffa28d6f58bd4039765c73504f00a825249e9`；release workflow 11/11 jobs 通过；25/25 包的 beta tag、integrity 与 provenance 通过 |
| zeus-ui                  | PR #35 已合并；tag/merge SHA `ad5ac10030b9e12a33fd161610c48b06881bbe49`；PR 与 main CI 各 10/10 jobs 通过                                               |
| npm                      | 36/36 publishable zeus-ui 包存在 `0.1.0-beta.3`；`beta` 指向 beta.3；Data Grid/Virtual 对 Zeus core 使用 exact `0.1.1-beta.1`                           |
| Data Grid tarball        | MIT；integrity `sha512-w3MoGTCM82P5o//C2uS7qmWRdb3zlclbwTQWrtUEHVla7WM/9whQ7aRV8X/WLpj2G/BA6y02HgMyaa4/pVNpVw==`；unpacked 326,787 bytes                |
| zeus-ui publish workflow | 包发布和 36 包 registry metadata/provenance 校验成功，但 workflow `32323597967` 最终为 `failure`                                                        |
| dist-tags / Release      | `beta=0.1.0-beta.3`，`latest=0.1.0-beta.0`；tag 存在，但没有对应 GitHub Release 对象                                                                    |

publish workflow 的失败不是包缺失：consumer runtime smoke 仍断言 zeus-compat 导出
`state`/`effect`，beta.3 实际导出为 `createSignal`/`createEffect`。维护者应先修复该 smoke 并重跑发布后验证，
再把这次发布称为“全绿 release”。Nyala 必须继续 exact pin 或显式使用 `beta`；无版本安装仍会得到 beta.0。

核验入口：Zeus core [release run 32260211154](https://github.com/baicie/zeus/actions/runs/32260211154)、
zeus-ui [PR #35](https://github.com/baicie/zeus-ui/pull/35) 与
[publish run 32323597967](https://github.com/baicie/zeus-ui/actions/runs/32323597967)。

### Bundle 差分

两版均从 exact-pinned `dist/wc/auto.js` 使用 esbuild `0.28.1`、相同 browser/IIFE/minify 参数构建；gzip
值使用 Nyala audit 相同的 Node zlib level 9 计算：

| 版本                     | raw bytes | gzip -9 bytes | SHA-256                                                            |
| ------------------------ | --------: | ------------: | ------------------------------------------------------------------ |
| Data Grid `0.1.0-beta.2` |    73,494 |        24,311 | `0dddde8f65195667d1bdd0f574f2ac3a4ffa1c5b019c8f1a13db5bd2fc0a6794` |
| Data Grid `0.1.0-beta.3` |    91,000 |        29,647 | `a3cda8cbbedd0107a5afdc7cff712858ad5869a1fadc69848b4840469a2baca6` |
| beta.3 相对 beta.2       |    +23.8% |        +21.9% | -                                                                  |

beta.3 仍通过 `gzip <= 30,000` 护栏，但只剩 353 bytes 余量。该结果是本地 fresh bundle 复核，不替代
带 protected provenance 的结构化 audit；下一版必须把 bundle budget 当成发布前门禁，不能继续无界增长。

### Chromium 性能差分

两版各运行两轮 `10k-x-50`、每轮 6 次 balanced real WorkbenchTable/Zeus profile，再合并每版 12 条 Zeus
records。每版 12/12 records、240/240 scroll samples 和 240/240 floor samples 有效，所有 scroll sample
均在第一次 presentation opportunity 正确提交。以下 upper median 使用排序后上中位数；cross-run p95 在
`n=12` 时是 sizing 信号，不是稳定总体分位数：

| Zeus 指标                           |  beta.2 |  beta.3 | beta.3 解释                                        |
| ----------------------------------- | ------: | ------: | -------------------------------------------------- |
| render upper median                 |  17.1ms |  14.9ms | 改善 12.9%                                         |
| render cross-run p95                |  43.0ms |  27.4ms | 改善 36.3%                                         |
| per-run scroll p95 upper median     |  18.7ms |  19.2ms | 没有改善，仍贴近一帧 floor                         |
| per-run scroll p95 cross-run p95    |  20.1ms |  24.3ms | beta.3 长尾更高                                    |
| per-run scroll max cross-run p95    |  46.3ms | 241.0ms | 出现显著偶发长尾，不能声称 scroll long tail 已解决 |
| input p95 upper median              |   0.1ms |   0.1ms | 同步 setter 不是主阻塞                             |
| presentation-floor p95 upper median |  17.6ms |  17.7ms | 两版环境 floor 基本相同                            |
| DOM nodes upper median              |     330 |     330 | pooling 降低 churn，不再降低 steady DOM 总量       |
| first-opportunity correct commit    | 240/240 | 240/240 | 未观察到稳定多等一帧                               |

另有每版各 36 条 `4 workloads x 3 renderers x 3 repeats` real-mode records，均为 `ok`：

| workload     | beta.2 Workbench/Zeus scroll p95 | beta.3 Workbench/Zeus scroll p95 | beta.3 Zeus render median |
| ------------ | -------------------------------: | -------------------------------: | ------------------------: |
| 1k x 20      |                    17.4 / 18.2ms |                    17.6 / 18.6ms |                    10.7ms |
| 10k x 50     |                    18.2 / 25.1ms |                    18.0 / 20.2ms |                    14.0ms |
| wide-columns |                    17.5 / 18.2ms |                    17.5 / 18.6ms |                     8.2ms |
| narrow-panel |                    17.3 / 18.0ms |                    17.8 / 17.7ms |                     9.8ms |

beta.3 的 10k render 与该轮 scroll 中位都明显改善，但 Zeus scroll 仍比同轮 WorkbenchTable 慢约
`12.2%`，旧 v6 要求的是至少快 `20%`，所以仍失败。该 36-record run 还出现 10k Zeus per-run scroll
p95 `139.8ms`、scroll max `850ms`，wide-columns scroll max `198.6ms`；与 12-record profile 的
`241ms` 长尾一起说明当前只能认定“首屏改善方向一致”，不能认定 steady scroll 或 GC/分配问题已经关闭。
所有结果均为同一 macOS host 上的 dirty-tree Chromium diagnosis，不是双 WebView admission evidence。

### A-F 落地审计

| 项目                | beta.3 状态 | 发布代码与剩余边界                                                                                                                                                                                                           |
| ------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 diagnostics      | 部分        | 已有 model build、handler/range/commit/layout interval、range identity、created/removed node；缺 disposed effect、allocation/proxy/effect counters，`inputTime` 不是原始 input timestamp，发布 d.ts 未强类型公开 diagnostics |
| A 单次建模          | 完成        | beta.3 tag 包含前置 PR #34 的 `builtModelVersion=modelVersion` 和无排序 rows reference 复用；首挂 E2E 证明 model build 为 1                                                                                                  |
| B shallow props     | 完成        | Zeus core 提供 opt-in shallow prop，Data Grid 对 `rows`、`columns`、`selectedKeys` 启用；replace-on-write 合同已记录                                                                                                         |
| C static binding    | 部分        | core 已提供 `@once`，但 Data Grid 发布 JS 的 41 个 binding call 只有 1 个使用 once；没有 effect churn counter，尚未证明预期收益                                                                                              |
| F snapshot cache    | 基本完成    | viewport 与双轴 snapshot 按 revision 缓存，滚动不再读 client size；scroll offset 仍有重复读取，但每轴 snapshot calculation 已为 1 次                                                                                         |
| D keyed `For`       | 完成        | item/index 使用 signal，同 key replacement 可更新，已相邻 range 跳过 DOM move；duplicate key/focus/dispose 有测试                                                                                                            |
| E fixed-height pool | 完成        | 固定行高路径复用 row/header/cell viewport slot；long jump、payload/text/ARIA/sort/replace/focus 有 E2E；measured row 或当前 focus 时会保守退出 pooling                                                                       |
| Scheduler           | 未实施      | 仍使用 rAF scheduler；现有 240/240 first-opportunity commit 不支持先做全局 scheduler 重写                                                                                                                                    |

由此得到新的实施顺序：先修 zeus-ui 发布 smoke；然后在 Data Grid 关闭 O(N) rows wrapper/duplicate-key
`Set`、`findIndex` 导航和 typed diagnostics 缺口；Zeus core 只补齐 P0/C 所需的计数与有限 `@once` 支持。
variable-height `SizeCache` 退化不在 Nyala 固定 28px 行高的当前主路径，scheduler 也必须等 timing 证据后再
A/B。上游 benchmark 目前只校验 timing 非负、DOM budget 和 correctness，没有性能回归阈值，不能替代
Nyala 的 v7 指标与双 WebView 重新验收。

## 2026-08-24 beta.4 与双原生 WebView 复验

### 发布与实现闭包

| 项目              | 核验结果                                                                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zeus core         | `0.1.1-beta.2`；tag/SHA `v0.1.1-beta.2` / `a099abbf03acaf1ad2a78963e5ead72da2758a18`；[release run 32468671269](https://github.com/baicie/zeus/actions/runs/32468671269) 全绿                                                                         |
| Zeus npm          | release auth 明确输出 `baicie2, 25 packages with read-write access`；25 包的 `beta -> 0.1.1-beta.2` 与 signed provenance 通过；`latest=0.1.0` 未修改                                                                                                  |
| zeus-ui           | [PR #37](https://github.com/baicie/zeus-ui/pull/37) 完成 indexed rows/diagnostics，[PR #39](https://github.com/baicie/zeus-ui/pull/39) exact pin core beta.2；tag/SHA `v0.1.0-beta.4` / `548baa14e88daa9cd3e90b2f60ea4c6043a79bf2`                    |
| zeus-ui npm       | [release run 32480800326](https://github.com/baicie/zeus-ui/actions/runs/32480800326) 与 [publish run 32481311654](https://github.com/baicie/zeus-ui/actions/runs/32481311654) 全绿；36 包验证通过；`beta=0.1.0-beta.4`，`latest=0.1.0-beta.0` 未修改 |
| Data Grid tarball | MIT；integrity `sha512-hiaTjf29UY8E/hrMkDm81nVORNWSrqTcInJXQcxZ7azfCfVkN82M8UMe/GDlbQBWksJetq8lT3GbapJEbqZbHA==`；unpacked 341,232 bytes；runtime/wrapper 与 peer Zeus 均 exact `0.1.1-beta.2`                                                        |

npm token 没有失效，发布账号就是 `baicie2`。早先一次失败是 npm attestation endpoint 的临时 `404`，
不是账号、权限或 token 问题；正式成功发布全程由 GitHub Actions 完成，没有在本机 pack/publish。

beta.4 相对 beta.3 的上游收口如下：

- Data Grid 用 source-index row model 取代 eager wrappers；100k update benchmark 证明 0 个 eager wrappers、
  16 个 viewport wrappers。row-key 与 column-id 导航改为 O(1) lookup，sort order 保持 source indexes。
- diagnostics 使用事件原始 `timeStamp`，公开 row index/wrapper allocation 字段，并可动态接入和清除
  observer；默认关闭时不读取 diagnostics clock，也不启动 churn observer。
- core 新增独立 `@zeus-js/signal/diagnostics` opt-in 入口，计数 effect/scope/ref/memo/proxy 及聚合
  allocation create/dispose；inactive effect/scope 保持原 prototype fast path，scheduler 完全未改。
- PR #37 与 Zeus PR #88 的 GitHub review 列表为空，但两边 required CI 全绿；独立五轴只读审查未发现
  P0/P1。残余非阻塞边界是 generated wrapper `.d.ts` 仍把 `diagnostics` 扩为
  `Record<string, unknown>`。

完成审计另在同一 host 临时安装已发布的 `@zeus-js/signal@0.1.1-beta.1` 与 beta.2，用 ABBA 顺序、
每 case 30 paired rounds、三个独立进程比较 diagnostics inactive path。三次 paired median overhead 中，
唯一稳定正值是 scope create/stop `+1.99% / +2.84% / +2.94%`；memo create/read 为
`+0.60% / -2.57% / +0.06%`，effect、proxy 与 ref 均无中位回归。该分配微基准的 p95 受 GC 噪声影响，
只作为定量诊断，不注册成永久 gate；结合 published tests 对 inactive instance 无 own `run/stop` wrapper
的断言，可以支持“默认关闭时低开销”，不能扩展解释为 diagnostics 开启时零成本。

### Revision-bound audit 与原生证据

[Nyala native run 32706467306](https://github.com/baicie/nyala-studio/actions/runs/32706467306)
绑定 clean SHA `9d68c91d22ae09d2da57c2748250411c815f6e67`、同一 Zeus bundle digest 与 real
WorkbenchTable digest。四个 artifacts 均成功上传；prepare、macOS 与 Windows jobs 全绿，aggregate
仅因 verifier 的预注册性能检查 exit 1。

| 证据             | 结果                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh audit      | package/provenance 全过；bundle 90,528 raw / 29,841 gzip / SHA-256 `2f7630473db32c03e934d0167736e9ec107fbc55bd401797c208a51d3f22f636`，30 KB 余量 159 bytes |
| Chromium         | 36/36 unique real-mode records；contract、summary 与 provenance 全过                                                                                        |
| macOS WKWebView  | embedded identity；60/60 records、12/12 screenshots；schema、summary、pixels 与 provenance 全过                                                             |
| Windows WebView2 | embedded identity；60/60 records、12/12 screenshots；schema、summary、pixels 与 provenance 全过                                                             |
| Global identity  | Chromium + 双平台 156 个 run tokens 全局唯一；Zeus/Workbench bundle digests 跨三环境一致                                                                    |

本轮同时关闭了 native CI 的两个 harness 错误：embedded `/wdio/eval` 现在使用合法逗号表达式启动
benchmark；viewport calibration 在 apply 后 settle 再 observe，visual contract 比较 actual
`browserViewport` 与 document geometry。Windows narrow-panel 的 15/15 records 均为 `ok`：请求
`390x420`、实际 `391x420`，处于既有 +/-1px workload 容差内；document client/scroll geometry 均为
`391x420`，`outerDocumentOverflowFree=true`。这证明之前的失败是互相冲突的 evidence contract，
不是应用 overflow。尚可补一个 P2 隔离负例：保持 overflow flag 为 true，只篡改 document/browser
viewport mismatch 并断言 verifier 拒绝；实现本身已经拒绝该输入。

### v6 gate 结论

| 环境 / workload              | WorkbenchTable |   Zeus | 结果                                                  |
| ---------------------------- | -------------: | -----: | ----------------------------------------------------- |
| Chromium 1k x 20 scroll p95  |         17.2ms | 20.5ms | 回归 19.2%，失败 10% non-inferiority                  |
| Chromium 10k x 50 scroll p95 |        107.2ms | 20.6ms | 改善 80.8%，通过 20% superiority；baseline 本轮有长尾 |
| macOS 1k x 20 scroll p95     |         18.0ms | 21.0ms | 回归 16.7%，失败                                      |
| macOS 10k x 50 scroll p95    |         19.0ms | 22.0ms | 改善 -15.8%，失败                                     |
| Windows 1k x 20 scroll p95   |         16.5ms | 20.9ms | 回归 26.7%，失败                                      |
| Windows 10k x 50 scroll p95  |         26.0ms | 22.0ms | 改善 15.4%，低于 20%，失败                            |

aggregate 共 50 个检查通过、5 个性能检查失败，dependency audit 通过，最终 `decision=NO-GO`。因此
**既定实现、发版和 CI 修复已经完成，但 Z1 admission 没有通过**；Z2 与 R0 继续禁止开始，也不生成
protected Go attestation。后续要么按本文 v7 提案先预注册可归因指标，要么继续用现有 counters 在
zeus-ui 定位 steady-scroll CPU/long tail；没有证据支持先重写 scheduler 或 `SizeCache`。

## Zeus/zeus-ui 整改方案

原始建议顺序为 **A -> B -> C -> F -> D -> E**。beta.3 已完成 A/B/D/E/F，C 与 P0 只部分完成；
beta.4 随后关闭 eager rows/index 与 core runtime counters，实际终态见上一节。下文保留 beta.2 问题定义、
beta.3 状态标签和验收信号，供核对实现边界，不应把历史“待完成”重新解释为 beta.4 发布缺口。Scheduler
优化仍必须在 timing 到位后单独实验，不与其他改动混跑。

### P0：先加入可归因 instrumentation（beta.3 部分完成）

beta.2/beta.3 时 Nyala 只能看到 setter、presentation wait 和最终 correctness，无法区分 Zeus 内部的 scroll event、
range calculation、reactive flush、DOM patch、layout 与 GC。建议在开发/benchmark 模式提供零默认开销的
诊断 hook：

```ts
export interface VirtualCommitTiming {
	transactionId: number;
	source: 'scroll' | 'resize' | 'data' | 'api';
	inputTime: number;
	handlerStartTime: number;
	handlerEndTime: number;
	rangeStartTime: number;
	rangeCalculatedTime: number;
	commitStartTime: number;
	commitEndTime: number;
	layoutReadIntervals: ReadonlyArray<readonly [startTime: number, endTime: number]>;
	firstRowIndex: number;
	lastRowIndex: number;
	firstColumnIndex: number;
	lastColumnIndex: number;
	createdNodeCount: number;
	disposedEffectCount: number;
}

export interface VirtualizerDiagnostics {
	onCommit?(sample: Readonly<VirtualCommitTiming>): void;
}
```

具体名称可以调整，但至少需要 `input -> handler -> range -> patch -> committed` 的完整区间、range identity、
node/effect churn。正式 build 默认不注册 observer；不要默认 dispatch 高频 bubbling DOM event。Nyala 的
benchmark-only WorkbenchTable bundle 必须产生边界相同的 trace；如果无法对称采集，renderer CPU 只能作为
各自诊断，不能计算 Zeus/Workbench ratio。

### A. 消除首次挂载的重复模型构建（beta.3 已完成）

位置：`packages/advanced/data-grid/src/components/data-grid.tsx`、
`packages/advanced/data-grid/src/core/sort-model.ts`。

beta.2 setup 已完成 column normalization、`createDataGridRows()`、sort 和两个 virtualizer 构造，但随后把
`builtModelVersion` 初始化为 `-1`。首次 render 的 `getSnapshot() -> rebuildModels()` 又重复整个过程。
无 sort 时，`sortDataGridRows()` 还会执行 `[...rows]`。

原始建议二选一：

1. setup 完成 eager build 后，将 `builtModelVersion` 对齐当前 `modelVersion`。
2. 删除 setup 的 eager build，统一在首次 snapshot 做一次 lazy build。

同时在无 active sort 时直接复用 rows reference；若 `sortDataGridRows()` 的公开合同要求返回副本，则在
Data Grid call site 短路，不要静默改变其他调用者。

beta.3 采用第一种方案，并在无 active sort 时直接复用 rows reference；首挂 diagnostics E2E 证明
model build 精确为 1。该改动来自 beta.3 tag 包含的前置 PR #34，而不是 PR #35 本身。

验收信号：

- 首次 mount 的 model-build counter 精确为 1。
- 10k row wrapper allocation 精确发生一次。
- controlled props 在首次 render 前变化时仍取最新值。
- column width、active cell、focus restoration、sort 与 visual snapshot 不回归。

### B. 为大型外部属性增加 shallow/opaque reactivity（beta.3 已完成）

位置：Zeus core `packages/core/runtime-dom/src/defineElement.ts`、
`packages/core/signal/src/state.ts`，以及 Data Grid prop metadata。

beta.2 的 `createPropStore` 对每个 prop 使用 `state()`，Array/Object 会被递归代理。`rows` 因此成为 deep Proxy，
`createDataGridRows()` 遍历 10k 行时继续代理每个 child row，visible cell 读取也建立 index tracking。

原始建议是增加向后兼容、默认仍为 deep 的 opt-in：

```ts
export type PropReactivity = 'deep' | 'shallow';

export interface PropMetadata {
	reactivity?: PropReactivity;
}
```

Data Grid 的 `rows`、`columns` 和大集合型 `selectedKeys` 使用 shallow semantics：替换顶层 reference 会
触发更新，嵌套 mutation 不保证响应。同步提供明确的 replace-on-write 文档或 `setRows()` API。

验收信号：

- `grid.rows = nextRows` 正常刷新。
- 同一 reference 的 `rows[i][j] = value` 行为有明确合同和测试，不能偶然工作。
- row/cell referential identity 可复核，不发生隐式 deep Proxy。
- 10k/100k 数据下记录 proxy count、effect count、mount、heap plateau。

这是 Zeus core 的跨组件改动，应先 opt-in；不要把全局默认从 deep 改成 shallow。

beta.3 已按该边界落地：Zeus core 默认仍为 deep，Data Grid 仅对 `rows`、`columns` 与 `selectedKeys`
opt in shallow semantics，并记录 replace-on-write 合同。

### C. 为不变量增加编译期/static once binding（beta.3 部分完成）

位置：Zeus core `packages/core/runtime-dom/src/bindings.ts` 与 compiler，Data Grid cell/row template。

beta.2 的 `bindAttr`、`bindText`、`bindStyle` 总是创建 effect。发布 bundle 对 key、row/column id、ARIA index、
alignment 和 cell text 等同一 keyed record 生命周期内不变的值也创建 effect。10k viewport 约有
250-310 cells，一次远距离跳转可能销毁并重建约 2,500-3,300 effects。

建议由 compiler 显式生成 `once/static` binding；不要在 runtime 看到“首次没有 dependency”后自动停止
effect，因为条件表达式可能在后续分支才读取 signal。

保持 reactive 的内容包括 active/selected/tabindex、column layout、同 key replacement 后需要更新的
cell data。row/column source replacement 可继续通过独立 render version 触发重建。

验收信号：effect create/dispose counter、same-key data replacement、sort、selection、active cell、ARIA、
随机远跳与 heap plateau。

beta.3 core 已提供 compiler/runtime `@once`，但 Data Grid 发布 JS 的 41 个 binding call 只有 header
`aria-rowindex` 一处使用 once，且仍没有 effect create/dispose counter；因此不能把 C 记为完成。

### F. 缓存 viewport size 与当前 virtual snapshot（beta.3 基本完成）

位置：`data-grid/src/components/data-grid.tsx`、`data-grid/src/core/grid-virtualizer.ts`。

beta.2 的 `updateRange()` 读取 `clientHeight/clientWidth` 并计算 row/column snapshot；`renderVersion` 更新后，
render path 的 `getBodyRowsForRender() -> getBodyRows() -> getSnapshot()` 再次计算 snapshot 并再次读取
viewport。组件已经有 `ResizeObserver`，可以缓存 width/height。

建议：

- ResizeObserver 只在尺寸变化时更新 cached viewport。
- scroll path 生成 shallow `currentRowSnapshot/currentColumnSnapshot`。
- render 直接消费 current snapshot items，不再重复计算。
- detached、zero-size、reconnect 和 scrollbar 改变 client width 时保留一次 fallback recompute。

验收信号：每次 scroll 的 range calculation 次数从 2 降为 1；forced-layout trace 减少；resize、narrow、
horizontal scroll 与 reconnect 行为不变。

beta.3 已缓存 viewport 和双轴 snapshot，并通过 axis isolation、resize/reconnect/zero-size E2E；每轴每次
scroll 的 snapshot calculation 为 1，scroll 不再读取 client size。残余重复 scroll offset 读取可在 trace
证明其占比后再处理。

### D. 修复 keyed `For` 的 item 更新与无条件 DOM move（beta.3 已完成）

位置：Zeus core `packages/core/runtime-dom/src/list.ts` 的 `mountKeyedFor`。

beta.2 复用 record 时只执行 `oldRecord.item = item` / `index = i`，但 render closure 仍可能持有旧 item；随后
`moveRangeBefore()` 对已处于正确位置的 record 也调用 `insertBefore`。这同时是 correctness 风险和小步滚动
的无效 DOM 工作。

建议：

- record 持有 shallow item/index signal，render closure 消费该 signal。
- 复用时更新 signal，而不是只改普通字段。
- 已紧邻 anchor 的 range 跳过 move。
- 对复杂 reorder 使用 prefix/suffix fast path；确有收益后再考虑 LIS，不必第一版过度实现。

验收信号：append/prepend/reverse/reorder fuzz、same-key item update、multi-node record、duplicate-key policy、
dispose ordering、focus preservation。

beta.3 通过 exact-pinned Zeus core `0.1.1-beta.1` 使用 item/index signal，并在 range 已紧邻 anchor 时
跳过 move；same-key replacement、duplicate key、focus 与 dispose 路径已有测试。

### E. 固定行高模式复用 row/cell DOM（beta.3 固定行高路径已完成）

位置：`data-grid/src/components/data-grid.tsx` 的 row/cell `<For>` 与
`data-grid/src/core/grid-virtualizer.ts`。

beta.2 的 key 包含 `rowRenderVersion:row.key`。Nyala 的 20 个样本会跨数千行跳转，窗口 key 没有 overlap，
所以每次都销毁并重建整窗 DOM/effect tree，尽管 DOM 总量始终约 330。

建议先只在 `virtual && fixed rowHeight` 开启 viewport-slot pool：

- pool 大小固定为 visible rows + overscan。
- DOM identity 使用 viewport slot；业务 row key 继续写入 DOM/ARIA 和事件 payload。
- 每个 slot 持有 shallow reactive `{ virtualItem, row }`，滚动时原地更新 transform/text/attrs/event data。
- focused row 被回收时安全迁移 focus；不能保证时关闭 pooling。
- variable-height 模式继续走原路径。

验收信号：warm-up 后 MutationObserver 观察到近零 row/cell create/remove；随机长跳仍显示正确 row index、
text 和 column；keyboard、selection、`aria-activedescendant`、sort、data replacement、screen reader 与 heap
plateau 全部通过。

beta.3 已对固定行高 row/header/cell 使用 viewport slot key，并覆盖 long jump、payload/text/ARIA、sort、
replace 与 focus。measured row 或当前 focus 无法安全复用时会退出 pooling；variable-height 路径仍保留原行为。

### Scheduler 与 fixed-size virtualizer 实验（beta.3 未实施）

`virtual/src/core/scheduler.ts` 当前 scroll path 形态是：

```ts
const scheduleUpdateRange = nativeEvent => {
	scheduler.schedule(() => updateRange(nativeEvent));
};
```

`createRafScheduler()` 把整个 range calculation 推迟到 rAF。它可能与宿主 probe 的 rAF 注册顺序形成
frame-order race，但 beta.3 合并 profile 的 240 个 Zeus samples 全部第一次提交，因此它不是已确认的稳定
额外一帧原因。

在 P0 timing 到位后，可以做一个 fixed-size-only A/B：scroll event 中读取 offset/viewport 并同步 O(1)
计算 range，只把 state/DOM commit 合并到单个 rAF。连续事件保留最后一个 snapshot，stale rAF 不得覆盖
更新 range。不要为了让 benchmark 更好看而强行同步全部 DOM patch。

`SizeCache` 在固定 row height 下必须持续满足 offset/range O(1)。如果 measurements 出现后会退化为线性
loop，优先用 sparse prefix structure 或显式 fixed-size fast path；但当前没有证据要求先重写该模块。

## 可选上游 API

除 shallow prop 与 diagnostics 外，若 A/B 后 100k 数据仍受 wrapper model 限制，可以增加 indexed、
immutable row source，保留现有 `rows` API：

```ts
export interface ReadonlyGridRowSource<Row> {
	readonly length: number;
	readonly revision: string | number;
	at(index: number): Row;
	keyAt(index: number): string | number;
}
```

这样 virtualizer 只访问当前 window，不必预先为全部 10k/100k rows 建 wrapper。排序时返回 index order，
不要复制 row object。只有 browser A/B 证明 wrapper 仍是主要成本后再公开该 API，避免过早增加两套数据
合同。

Data Grid 内还应按 model revision 缓存：

- `rowKey -> rowIndex`
- `columnId -> columnIndex`
- normalized column geometry
- sort order/index array

rows、columns、sort、viewport 各自失效对应缓存；viewport 变化不应重建 row model，column resize 不应
重建所有 row wrappers。

## 上游测试清单

| 改动             | 必需测试                                                                | 失败信号                           |
| ---------------- | ----------------------------------------------------------------------- | ---------------------------------- |
| A 单次建模       | 初次 mount counter、首次 render 前 prop change、无 sort reference reuse | model build >1 或显示旧 props      |
| B shallow props  | top-level replacement、nested mutation contract、identity/proxy count   | 替换不刷新或隐式 deep Proxy        |
| C static binding | same-key replacement、reactive state、effect counters                   | text/ARIA stale 或 effect 数未下降 |
| F snapshot cache | scroll/resize/reconnect/horizontal/narrow                               | 重算 >1、range stale、layout 溢出  |
| D keyed `For`    | reorder fuzz、same-key update、multi-node、focus/dispose                | stale item、错误 move、focus 丢失  |
| E DOM pool       | long jump、node churn、keyboard/selection/ARIA、sort/replace            | stale payload、空白窗口、ARIA 错位 |
| Scheduler A/B    | coalescing、stale task、one-frame commit、120Hz                         | stale range 覆盖、>1 frame miss    |
| Fixed-size math  | offset/range property tests、operation counter                          | 非 O(1) 或边界 off-by-one          |

性能测试需要同时记录 median、p95、max 与 trace，不能只报告平均值。Mount 使用 fresh process；steady
scroll 先预热后测；GC、node/effect churn 与 long task 单独记录。

## 新性能指标提案

### 先建 diagnostic profile，再决定 measurement contract v7

建议先建立独立的 `sql-grid-performance-profile-v1`，字段明确写
`decisionUse: "diagnostic-only"`。产品负责人在看到正式双平台结果前签署 metric ADR；批准后再建立 v7
gate schema。v6 artifact/verifier 不变，v7 只能消费 v7 evidence。

### Primary A：连续滚动 jank rate

使用 embedded WebView 中的真实 wheel/trackpad-like input，执行 5 秒双向纵向和横向滚动。先在 idle
rAF 测得当前环境 `T_vsync`：

```text
jank_i = 1[frameInterval_i > 1.5 * T_vsync]
jankRate = sum(jank_i) / frameCount
```

建议预注册：

- 10k x 50 superiority：只有 Workbench baseline jank point estimate `>=1%` 时，才使用 paired bootstrap
  95% CI 的 `jankRate_Z / jankRate_W` 上界 `<= 0.80`。该 eligibility rule 必须在正式采数前固定。
- 1k x 20 non-inferiority：`jankRate_Z - jankRate_W` 的 95% CI 上界 `<= +1 percentage point`。
- 若 Workbench baseline `<1%`，10k superiority 结果记为 `NOT-EVALUABLE`，不能临时切换 absolute margin，
  也不能仅凭 CPU 或 DOM 指标发出性能 Go。此时需要选择能产生可测 jank 的预注册 workload，或接受本轮
  没有证明用户可感知收益。

这把原来的“10k 至少改善 20%”放到具有大量实际 frames、能区分 renderer 工作的指标上。

### Primary B：renderer-owned CPU p95

用 P0 marks 计算 handler、window calculation、DOM patch 和同步 layout read 的 main-thread duration。
这些区间可能嵌套，必须取区间并集而不是直接相加，并明确排除 rAF/task queue 的空等时间：

```text
rendererCpu_i = duration(union(handlerIntervals,
                               rangeIntervals,
                               patchIntervals,
                               forcedLayoutIntervals))
```

建议预注册：

- 10k x 50：paired bootstrap 95% CI 的 `Q95(cpu_Z) / Q95(cpu_W)` 上界 `<= 0.80`。
- 1k x 20：同一 ratio 上界 `<= 1.10`。

WorkbenchTable 必须通过 benchmark-only instrumentation 或同源 performance trace 产生相同区间定义，并
校验 interval nesting/union；否则禁止计算 ratio。CPU 指标只能用于归因，不能单独冒充用户延迟。
Primary A 与 B 应同时通过。

### Guard C：一帧内正确呈现

```text
framesToCorrect = input 后直到正确 row identity/content 可见所跨的 presentation opportunities
miss = 1[framesToCorrect > 1]
```

要求 Zeus 相对 WorkbenchTable 的 miss-rate difference 95% CI 上界不超过 `+1 percentage point`，并继续
校验实际 offset、row index/content 和 blank-window。现有每个 renderer 的 120 个 inputs 聚类在 6 个
runs 内；观察到零失败只能作为诊断，不能把 `n=120` 直接代入独立 Bernoulli 置信区间。

正式 Guard C 另建至少 300 个 paired correctness blocks。每个 block 为两个 renderer 各创建 fresh
document/instance，完成 ready/preposition 后只发一个随机化 input，再销毁实例；block 顺序 balanced。以
block 为独立单位，使用预注册的 paired exact/score interval。`300` 是零事件率约 1% 上界的初始下限；
正式 ADR 的 power calculation 或平台相关性分析要求更多 blocks 时必须增加，不能把 steady run 内的 20
个 inputs 补算为独立样本。

### 次级护栏

| 护栏            |                  建议阈值 |           当前诊断值 | 说明                                                      |
| --------------- | ------------------------: | -------------------: | --------------------------------------------------------- |
| mount p95 ratio | Zeus / Workbench `<=1.10` |  `30.9/30.1 = 1.027` | 当前 n=6 max 仅 sizing；正式用 30 fresh-process runs + CI |
| DOM ratio       | Zeus / Workbench `<=0.50` |    `330/914 = 0.361` | 资源收益，不代替 UX                                       |
| 1k correctness  |      0 错误/空白/错误 row |             当前通过 | 必须保留                                                  |
| gzip bundle     |          `<=30,000` bytes |       `24,311` bytes | fresh exact bundle                                        |
| retained heap   |          先报告，不设主门 | 仅 2/6 与 1/6 值可用 | 需 controlled GC/可靠 API                                 |

## 正式验收矩阵

| 维度               | 正式取值                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------- |
| Platforms          | macOS embedded WKWebView、Windows embedded WebView2                                          |
| Diagnostic only    | Chromium headless，不作 admission evidence                                                   |
| Primary workloads  | 1k x 20 non-inferiority、10k x 50 superiority                                                |
| Guard workloads    | wide-columns 横向滚动、narrow-panel 布局与 correctness                                       |
| Renderers          | real WorkbenchTable、exact-pinned Zeus canary/release                                        |
| Steady runs        | 每个平台/primary workload/renderer 30 个 balanced paired runs                                |
| Per steady run     | 5 秒 continuous wheel trace；附加 inputs 仅作 clustered diagnosis                            |
| Correctness blocks | 每个平台/primary workload 至少 300 个 fresh-instance paired one-input blocks                 |
| Mount runs         | 每个平台/primary workload/renderer 30 个 fresh-process runs，并报告 quantile CI              |
| Guard runs         | wide/narrow 每个平台/renderer 至少 10 个 balanced runs；只作 correctness/截图，不作 p95 推断 |
| Statistics         | 以 run/block 为独立单位做 paired bootstrap/permutation，不把同一 run 内 frame 当独立实验     |
| Environment        | 记录 refresh rate、WebView build、OS、DPR、viewport、binary/bundle digest                    |
| Correctness        | offset、row identity/content、blank window、keyboard、selection、ARIA、截图                  |

Steady run 内的 frames/inputs 是同一 run 的相关观测，只能按 run/block 聚类分析，不能展开后提高样本量。
Guard C 使用独立的 fresh-instance paired blocks。Renderer 顺序继续 balanced rotation，mount、steady、
correctness blocks 与 wide/narrow guard 分开报告。

只有以下项目同时通过，新的 v7 才有资格记录性能 Go：

1. Primary A continuous-scroll jank。
2. Primary B renderer CPU。
3. Guard C one-frame correctness。
4. Mount、DOM、bundle 与功能护栏。
5. 两个 embedded WebView 的 revision-bound evidence 与 protected provenance。

## 交付顺序

1. **已完成：**冻结 beta.2/beta.3 历史 profile 与旧 v6 `NO-GO`，没有覆盖历史 gate artifact。
2. **已完成：**修复 zeus-ui published-package smoke，由 Actions 发布 beta.4 并取得全绿 publish evidence；
   exact pin Zeus core beta.2，两个仓库均未修改 `latest`。
3. **已完成既定范围：**Data Grid 补真实 input timestamp 与 wrapper/node diagnostics；core 补
   effect/proxy/scope/ref/memo/allocation create/dispose counters并保持 scheduler 不变。generated wrapper
   diagnostics d.ts 收窄仍是非阻塞后续；inactive published-package 差分微基准已记录，但尚未注册为 CI gate。
4. **已完成：**消除 Data Grid eager O(N) row wrappers、duplicate-key second `Set` 和导航 `findIndex`
   热点；10k/100k、focus、sort、replacement 与 allocation tests 已覆盖。
5. **已完成有限范围：**core `@once` 与 keyed `For` 已发布；在新的 allocation/CPU 证据出现前不再盲目
   扩大 static binding。
6. **保持 deferred：**只有 timing 证明 frame-order race 时才实验 scheduler fixed-size synchronous range；
   variable-height `SizeCache` 仅在对应 workload 复现后处理。
7. **下一步：**产品负责人在正式 v7 采数前预注册 metric ADR、schema、threshold 和 sample plan。
8. **已完成：**beta.4 fresh structured audit 通过 `gzip <= 30,000`，但只余 159 bytes，下一版仍须先过门。
9. **v6 evidence 已完成、admission 未通过：**双原生 WebView 的 120/120 records 与 24/24 screenshots
   完整，5 个性能检查失败，因此不具备 protected Go attestation 资格。
10. 新 gate 全部通过并产生 protected Go 后，Nyala 才能重新评估 Z1.3；在此之前不开始 Z2。

## 明确不要做

- 不要把 row overscan 从 4 改为 0；单变量实验已经证明它更慢。
- 不要恢复 adapter 的 `refreshViewport()`；它是重复工作。
- 不要重新把二维 rows 映射成 10k record objects；当前 array-index 是已验证的更快路径。
- 不要把工作强行搬进同步 setter，只为了让后续 presentation wait 变短。
- 不要恢复 renderer-specific immediate probe，或删除 row/content/presentation correctness boundary。
- 不要用 `p95(total) - p95(floor)` 宣称组件 CPU 改善。
- 不要把 DOM/heap 下降单独描述为用户交互性能 Go。
- 不要修改旧 v6 report、20% 阈值或 `phase-z1-gate.json` 来接纳已经看到的数据。

## 维护者交接清单

Zeus/zeus-ui canary 交付时请附：

- 每个 A-F 改动的独立 commit 与变更说明。
- unit、runtime fuzz、Data Grid browser/e2e、keyboard/ARIA 测试结果。
- exact package versions、tarball integrity、bundle raw/gzip/SHA-256。
- 10k mount 的 model/proxy/effect allocation counters。
- continuous-scroll CPU marks、frame intervals、long tasks、GC 与 node churn trace。
- 1k x 20、10k x 50、wide-columns、narrow-panel 的原始 records，不只给 summary。
- shallow rows 的 mutation/replace contract 与 upgrade note。
- keyed `For` same-key update 和 focus semantics 的 compatibility note。

Nyala 收到 canary 后负责运行 isolated real WorkbenchTable 对照与两个 embedded WebView 的正式 evidence。
在新 metric 完成预注册、双平台通过并生成 protected gate 之前，旧 Z1 结论保持 `NO-GO`。
