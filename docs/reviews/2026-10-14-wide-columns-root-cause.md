# wide-columns 根因：池化行重绑导致每帧长文本重整形

## 结论

`wide-columns` 上 Zeus 独有的额外帧成本，来自虚拟滚动每次提交都对被池化复用的
cell 重写文本节点，迫使 WebKit 对超长 `white-space: nowrap` + `text-overflow:
ellipsis` 文本重新整形。文本写入次数与长文本列数近似线性，Zeus 与 native 的差距
不能用渲染规模解释。

这一结论修正了「10k 路径的全部成本都在宿主」的范围判断：它对 10k-x-50 成立，
对 wide-columns 不成立。

## 成本单位是「每帧重写的长文本 cell 数」

本机 WKWebView（embedded WebDriver，`target/debug/sql-studio-next`，
SHA `f98a9e02…`），每个配置 5 轮 x 20 采样，同一会话内统计 rafToTask
（`nextPaintTaskTime - nextPaintRafTime`）：

| 配置 | 行数 | 列数 | 长文本列 | rafToTask 中位 | 分布 (min/q1/med/q3/max) |
|---|---:|---:|---:|---:|---|
| native | 1000 | 20 | 20 | **5.0** | 1 / 3 / 5 / 7 / 10 |
| zeus | 1000 | 20 | 0 | **6.0** | 5 / 6 / 6 / 7 / 8 |
| zeus | 1000 | 20 | 1 | **7.0** | 6 / 7 / 7 / 8 / 10 |
| zeus | 1000 | 20 | 20 | **15-18** | 13 / 17 / 18 / 19 / 34 |

关键对照：native 在同一个 fixture 下渲染 **21034 个 DOM 节点、150 万字符可见文本**，
rafToTask 只有 5ms；Zeus 只渲染 403 个节点、2.2 万字符，却是 15-18ms。成本与
渲染量反向相关，因此瓶颈不可能是渲染规模，只能是每帧的重算路径。

拆分变量确认是 cell 长文本而非表头：长表头 + 短 cell 为 19ms，短表头 + 长 cell
为 13ms，两者都远高于全短文本的 6ms。

## 机制

data-grid 以 `key = index` 对行做池化（`getBodyRowReconciliationKey`），`For` 复用
同一条 record，只通过 `setItem(() => item)` 更新数据信号。cell 的文本绑定依赖
`rowItem.data`，行数据一变，被复用行的每个可见 cell 的文本绑定就重新求值并写入。

用 MutationObserver 直接测量滚动期间的写入量（诊断插桩，不改生产代码）：

| bundle | 每次滚动的文本写入 | 每次滚动的 DOM 增删 |
|---|---:|---:|
| baseline | **7028** | 0 / 0 |
| 跳过相同值写入 | **6422** | 0 / 0 |

6422 次正好对应 20 采样 x 23 行 x 14 可见 cell。DOM 节点零增删，证明复用是生效的，
成本全在文本内容重写上。

## 修复

`bindText` / `bindTextContent` 原先无条件 `node.data = …` / `el.textContent = …`，
而 `setAttr` 早就有「先比较序列化值，相同则跳过」的保护。文本绑定缺少同一保护，
导致任何依赖变化都会重写文本节点，即使值没变。

修复照 `setAttr` 的既有语义实现：比较实时 DOM 状态，相同则跳过；因为比较的是实时
状态，外部篡改仍会在下次绑定时被修复。TDD 三个用例（跳过冗余写入、`textContent`
版本、外部篡改后修复）先红后绿；runtime-dom 269 个测试与 `tsc --noEmit` 全部通过。

提交：`zeus` `ee2fa75`（修复）、`2cbac0f`（版本 bump 到 `0.1.1-beta.13`），
tag `v0.1.1-beta.13` 触发 npm 发布。

效果量级：文本写入 7028 → 6422（-8.6%）。这个数字是机制层面的确定性证据，但
**不是**性能收益证明，原因见下节。

## 已排除的候选

全部在同一 WKWebView 会话内测量。`white-space: nowrap` 早已存在（`components.css`），
因此「补 nowrap」这一常见猜测不成立。

| 候选 | rafToTask 中位 | 判断 |
|---|---:|---|
| baseline | 15-18 | — |
| cell 改 `position: absolute` + 像素 left/width（去掉 grid 轨道） | 14 | 无收益 |
| `text-overflow: clip` 替代 ellipsis | 16 | 更差 |
| cell `display: block` 替代 flex | 19 | 更差 |
| 移除 row 全宽 | 无变化 | 已排除 |
| 移除 header 全宽 | 无变化 | 已排除 |
| header `contain: strict` | 19 | 更差 |
| `content-visibility: auto` | — | 功能性失败，header 布局被折叠 |
| 状态 memo（`rowSelected` / `active`） | 无收益 | 已排除 |
| body+row 分离 transform | 无收益 | 已排除 |

## 测量方法：本机 rafToTask 不可单独采信

同一 bundle、同一配置、连续多次独立会话，rafToTask 中位数在 **6 / 11 / 13 / 18 /
19ms** 之间漂移，幅度超过除文本重写外的所有候选效果量。本机约 30Hz，很多候选的
scrollP95 已被帧地板压平。

曾有一次出现 baseline 11ms、候选 6ms 的组合，看起来是 -45% 收益；用未修复的
bundle 重跑同样得到 6ms，证明那是会话漂移而非修复效果。

因此本轮所有「已排除」结论都基于**同会话内**的分布比较，而不跨会话比较中位数。
修复的真实收益必须在 60Hz 官方 runner 上验证，不能用本机数字宣称。

## 前置事实修正：官方证据就是当前代码

CI 正式门（`sql-result-grid-platform.yml`）硬编码从 npm 拉
`@zeus-web/data-grid@0.1.0-beta.31`。按 CI 完全相同的 esbuild 命令本地重打，SHA
`9ef85faa…` 与 run38552402643 官方 evidence 中的 `zeusBundleSha256` **完全一致**；
与当前 HEAD 构建 `0d1e0eae…` 仅差开头 `"use strict"` 与 39 字节。

所以「官方证据来自过期 bundle、当前代码已经移动」这一说法不成立，重跑正式门不会
带来新的 provenance 信息。

## 复现数据

本机探针产物在 `/tmp/wide-ab3/`（`base`、`shorttext`、`shortcell`、`shorthdr`、
`onecol`、`nat`、`churn2`、`cand-churn`、`tr-base`、`tr-cand`），每个目录含
`platform-evidence.json`。诊断插桩（MutationObserver 文本写入计数）已合入本仓库
`scripts/benchmark-sql-result-grid.mjs`，通过 `record.textChurn` 输出，仅在页面内
安装 observer，不改变 admission 口径。
