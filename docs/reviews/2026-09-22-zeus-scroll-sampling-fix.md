# WBT 双轴滚动采样修复验证

日期：2026-09-22。对应[跨仓库根因报告](./2026-09-22-zeus-cross-repo-root-cause.md) §4.3 / P0。此次修改限于 Nyala benchmark adapter、采样桥和测试，没有修改 Zeus core、zeus-ui 或生产 WorkbenchTable。

## 修复

- `sql-result-grid-workbench-table-entry.ts` 为 `scroll` controller 暴露真实 `table.scrollLeft` getter，保留原有纵向坐标转换。
- `createTraceScrollOffsets` 移到 `sql-result-grid-jank-trace.mjs`，由 benchmark 页面注入同一函数。双轴只读取 renderer 明确提供的 `scroll` controller；缺失或非有限数值直接报错，不再回退到原生 viewport。
- 新增 `test:sql-result-grid-scroll-browser`：构建真实 WBT benchmark 页面，以 Chromium/CDP wheel 输入验证 1k×20、10k×50 的横向坐标、采样跨度、双轴往返、可见行 identity 与内容。输入循环有次数上限，并按实际位移结束，避免导航后偶发丢失输入造成固定次数测试误报。
- 将原有 jank 单元套件加入 `test:sql-result-grid-benchmark`，新增显式 controller 合同测试；500px 横向和 2,000px 纵向门槛没有改变。

## 复现与验证

修复前，新浏览器回归的两组场景都在“采样位置必须等于 cell 实际位移”断言失败：cell 左移 750 / 800px，采样横向跨度均为 0。仅补 getter 后，两组均通过，横向跨度为 800px。完成显式 controller 收口及测试驱动清理后再次通过；最终回归以 600px 横向、至少 2,400px 纵向作为输入停止条件，并保留原门槛断言。

| 命令 | 结果 |
| --- | --- |
| `pnpm run test:sql-result-grid-benchmark` | exit 0，100/100 |
| `pnpm run test:sql-result-grid-scroll-browser` | exit 0，两组 workload 通过（Node test 计父测试共 3/3）；包含真实 WBT 的 Vite 构建 |
| 下方完整诊断命令 | exit 0，12/12 records 为 `ok` |
| `node --check scripts/benchmark-sql-result-grid.mjs` | exit 0 |
| `node --check scripts/sql-result-grid-jank-trace.mjs` | exit 0 |
| `node --check scripts/sql-result-grid-scroll-browser.test.mjs` | exit 0 |

浏览器测试需要本机 Chrome，可用 `NYALA_CHROME` 指定可执行文件；缺少浏览器会失败，不会静默跳过。它是独立集成测试命令，未加入不要求安装浏览器的默认单元测试链。

```sh
node scripts/benchmark-sql-result-grid.mjs \
  --renderer workbench-table,zeus --repeat 3 \
  --workload 1k-x-20,10k-x-50 --workbench-table-implementation real \
  --require-zeus true \
  --zeus-bundle /tmp/nyala-zeus-root-cause-20260922/data-grid-bundle.js \
  --diagnostic-profile true --jank-trace true \
  --output /tmp/nyala-scroll-fix-ObX299/diagnostic-r3.json
```

完整诊断中，WBT 三轮 1k 横向跨度均为 810px，三轮 10k 均为 3,150px；纵向跨度均超过 3,150px，原来的横向 0px 错误消失。完整诊断保留原有固定输入方案，不使用回归测试的按位移停止逻辑。

原始 JSON 已[压缩归档](./2026-09-22-zeus-scroll-sampling-fix/diagnostic-r3.json.gz)，数据为合成 fixture。解压后 SHA-256：`d1962dd4a5575153f3a82484747de48f44d475a04012edae5fdae11632c7c44e`。

- Nyala HEAD：`882ba2225630bc2cfb0f007669ed4da73d41bf10`，本地脏工作树。
- Zeus bundle SHA-256：`3f66cf7e58e8e4ac523bfc4644f1a735fe0fe5f4db5a8469e365f69523ad2c58`，与根因报告使用的本地候选相同。
- 修复后的 WBT bundle SHA-256：`d96e269658160076f3436df4bd8d3c40ee43c8807b66f092e66936b8bd34e699`（JavaScript + NUL + CSS）。

## 发布就绪复核（2026-10-08）

为回答该修复能否进入下一版 Nyala dev 预发布，在同一工作树补跑了仓库要求的本地发布门禁。以下命令均为 exit 0：

- `pnpm run lint`
- `pnpm run build`
- `pnpm run rust:fmt`
- `pnpm run rust:check`
- `pnpm run rust:clippy`
- `pnpm run test`
- `pnpm run test:sql-result-grid-benchmark`（100/100）
- `pnpm run test:sql-result-grid-scroll-browser`（3/3）

代码门禁已通过，但当前修复仍位于未提交且包含其他改动的工作树；分支 `codex/feat-sql-agent-schema-adapter` 与 `origin/mvp` 双向各差 5 个提交。因此发布前仍需拆分并提交本修复、同步到受保护的 `mvp`，再将四处版本元数据统一准备为 `0.0.1-dev.2`。这次复核没有修改版本号、创建 tag 或发布 GitHub Release。

## 结论边界

此次修复证明横向采样恢复正确，不证明性能准入。10k 的 baseline jank 仍低于 1%，结果为 `NOT-EVALUABLE`；1k 这三对本地运行的差值上界在草案门槛内，也不能代替正式样本量与双原生 WebView 证据。WBT 与 Zeus 对同一 wheel 输入仍可能产生不同行程，完整轨迹与输入等价性问题留待正式测量合同明确。

初次修复验证没有执行原生 WebView 重测；后续本地发布门禁复核结果见上节。v6 阈值、历史证据和 `NO-GO` 不变，未启动 Z2。
