# Agent Checkpoint R Verification

日期：2026-08-15
范围：Checkpoint R 的 Demo SQLite Generate/Fix/Read-only Explore 自动化与原生走查。
状态：Checkpoint R 已完成；Checkpoint W 与 Zeus gate 保持独立且未完成。

## 已交付闭环

`Assistant + Read Only` 现在通过真实 Demo SQLite 完成固定的本地工具链：

```text
schema.search -> sql.parse -> sql.execute_readonly
-> result.inspect -> evidence answer
```

- Workbench 只提交用户 goal、opaque `connectionId` 和编辑器上下文，不提交 schema、
  `resultRef` 或 result shape。Read-only Assistant 只请求 `agent.tool`、
  `database.readMetadata`、`database.executeRead` 和 `database.readResultShape`。
- Rust bridge 只把 `Assistant + ReadOnly` 路由到 Explore，并按内建 profile 计算同样的四项
  capability grant；request 仍只能 opt down，不能扩大权限。
- `LocalReadOnlyExploreAgentToolExecutor` 组合既有 bounded schema/static-analysis executor 与
  SQLite read-only/result executor，不新增 driver、连接池或结果 wire shape。
- 自动化纵切调用产品 `bootstrap_demo_inner`，使用 Workbench 返回的固定 `demo-sqlite` ID 同时创建
  V1/V2 显式只读 runtime；不再用测试专属连接绕过 Phase 08 bootstrap。偏离的旧 V1 SQLite runtime
  会在 bootstrap 返回前 retire 并 drain，覆盖 active、queued 与 pre-VM 查询窗口。
- deterministic gateway 会把“按天汇总最近 7 天订单”落到真实 `orders.amount` 与
  `orders.created_at`。Demo 查询以数据集中最新订单日期为锚点生成七天聚合，不退化为
  `SELECT 1`，也不依赖已经过期的墙上时钟日期。
- 成功路径执行且只执行一条只读 SQLite query，最终 answer 返回经过 parse 的同一条 SQL 与
  bounded result-shape 摘要。

## Rust 强制边界

- runtime 分别绑定 run goal、run connection、已解析 SQL 与执行产生的 runtime-owned
  `resultRef`。schema search、execute 或 inspect 任一参数切换 scope 都会在对应工具前拒绝。
- Explore 必须严格按 `schema.search -> sql.parse -> sql.execute_readonly -> result.inspect -> final`
  前进；额外、缺失、乱序工具或 final SQL 替换均 fail closed。
- `sql.parse` 必须证明 draft 是单条 `ReadOnly` statement；执行工具必须报告
  `queryCallCount = 1`，其余三个工具必须报告 0。
- model gateway 返回后会再次检查 cancellation 与 budget；取消发生在 tool dispatch 前时，
  不接受该 turn，也不会执行 query。
- schema、parse、execute/inspect 分别必须产生 Schema、Analysis、ResultShape + Aggregate typed
  evidence。默认路径不授予 `database.readResultSample`，evidence 与 model context 均不含 rows。
- evidence batch 在分配 ID 或写入前统一完成 redaction、单项 byte、全局 entry/byte 与 ID 空间
  preflight。任一项失败时整批不写入、不消费 ID；usage、context 和 Explore state 也不提交。
- write、DDL、multi-statement、Unknown、sample、network、filesystem 和 history 仍未获授权。

## 自动化证据

| 命令                                                                                         | 结果                                                           |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `cargo test -p sql-studio-next --lib read_only_explore_`                                     | 9 个 Explore focused tests 通过                                |
| `cargo test -p sql-studio-next --lib bootstrap_demo_`                                        | 11 个 Agent-ready Demo bootstrap tests 通过                    |
| `pnpm run test:sql-agent`                                                                    | 177 个 Rust Agent tests + 2 个 canonical capability tests 通过 |
| `node --test --import tsx src/vs/workbench/contrib/sqlAgent/test/sqlAgentPanelModel.test.ts` | 13/13 通过                                                     |
| `pnpm run test:sql-services`                                                                 | 103/103 通过                                                   |
| `pnpm run test:sql-connections`                                                              | 165/165 通过                                                   |
| `pnpm run test:sql-product`                                                                  | 68/68 通过                                                     |
| `pnpm run test:sql-advanced`                                                                 | 88/88 通过                                                     |
| `pnpm run test:rust`                                                                         | 423 passed，2 ignored                                          |
| `pnpm run test`                                                                              | exit 0；包含全部 SQL、benchmark、WebDriver 与 visual suites    |
| `pnpm run lint` / `pnpm run build` / `pnpm run rust:check` / `pnpm run rust:fmt`             | 全部 exit 0                                                    |
| `pnpm run rust:clippy`                                                                       | exit 0                                                         |
| `pnpm run rust:fmt:fix`                                                                      | exit 0                                                         |

关键证明包括：

- 真实 seeded Demo SQLite、空 editor 和中文 goal 生成每日订单金额聚合，执行一次 query，并产生
  Schema、Analysis、ResultShape 与 Aggregate evidence；forged frontend schema/result handle 未被采用。
- V1/V2 saved/open Demo profile 都是只读；旧可写 runtime 会被实际替换并在 bootstrap 返回前排空，普通 mutation 被拒绝；
  每进程静默恢复会重开持久化 runtime，匹配的 V1 runtime 与物理 cancel handle 保持不变；schema search
  与 execute tool call 均绑定同一个 `demo-sqlite`。
- V1 lifecycle mutation 与 persistence transaction 串行化；失败保存并发 close 最终关闭回滚 runtime，
  失败保存并发 replace 最终保留最新 runtime，不会在成功操作之后复活旧 handle。
- 静默恢复不会重放 Welcome/layout、打开或聚焦 Data Sources；已实例化连接视图会刷新，已恢复 SQL Editor
  会通过连接缓存失效事件重新读取 `readOnly:true` 状态。
- exact sequence、parsed SQL replacement、cross-connection schema/execute、inspect handle mismatch、
  missing stage evidence 和 post-gateway cancellation 均有负例。
- 原子 evidence batch 测试覆盖敏感字段 redaction、单项/全局 budget 拒绝、容量拒绝和连续 ID；
  rejection 后 store、run evidence refs、usage 与下一个 evidence ID 保持原值。
- Workbench contract test 证明 Read-only Assistant 请求精确四项能力，其他 Read-only task 保持
  explain-only，且 request 不携带 schema、result shape 或 result handle。

## 原生三故事走查

2026-08-15 在 macOS 原生 Nyala bundle
`target/debug/bundle/macos/Nyala Studio.app` 中完成三个故事。运行使用隔离目录
`/tmp/nyala-checkpoint-r.20AAcf/app-data` 与
`/tmp/nyala-checkpoint-r.20AAcf/sql-data`；accessibility tree 记录 App 为
`Nyala Studio`、页面 URL 为 `tauri://localhost`，没有把 Chromium/local-dist preview 当作
native execution 证据。参与走查的 app binary SHA-256 为
`cb8100056c3b81f5bea811476f9ddf88d3bed1fc207dd20e4ebd3864779fae15`。

| Story    | 原生结果                                                                                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Generate | goal 为“查询最近 30 天消费金额最高的 10 个用户”；真实 navigator 与 draft 使用 `users`、`orders`、`user_id`、`amount`、`created_at`，生成 `SUM`、30 天过滤、group/order 与 `LIMIT 10`；`schema.search -> sql.parse`，3 model turns、2 tools、0 rows，只展示 Apply/Open/Cancel draft。 |
| Fix      | editor 中的 `SELECT amunt FROM orders` 先产生真实 SQLite structured error；Agent 返回 `SELECT amount FROM orders`；`schema.search -> sql.parse`，3 model turns、2 tools、0 rows，明确记录 draft was not executed，且只提供 Open/Cancel。                                             |
| Explore  | goal 为“按天汇总最近 7 天订单”，连接显示 `Demo (SQLite)` 与 `SQLite · read-only`；`schema.search -> sql.parse -> sql.execute_readonly -> result.inspect`，5 model turns、4 tools、3 rows，最终 answer 明确 result was not truncated。                                                |

原始截图和 accessibility tree 保存在 `/tmp/nyala-checkpoint-r.20AAcf/`：

| Artifact          | SHA-256                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `generate.png`    | `01a2d4a1e9483d40379597fff6759cff69e5e4d1c8ad2c772da3db5e651267d4` |
| `generate-ax.txt` | `3d42c7866af45b9734f74e15953d66c945afef490c608ced873431eb5902481f` |
| `fix.png`         | `91d0521eee51283bdb337332e6e188271622e285a189bd9161e093b67805a7dd` |
| `fix-ax.txt`      | `2cb187168e792fe3c6c702017310f7ebc5176c2962bb743efbf65ce8be1fc82f` |
| `explore.png`     | `e17b7c2f6e62456ea1be4eaeb74dc00a3649b82e0d9870061902307575b68e70` |
| `explore-ax.txt`  | `f46a2b3fe32038df6a465f66528a161c7c2a6ff2250113123fe933fa4c5f3a25` |

三个 PNG 均为 800x600。截图用于核对原生 surface，accessibility tree 用于核对完整 SQL、工具序列、
连接只读状态、turn/tool/row 计数与未截断结论；两类证据共同签收，不用截图中被折叠的文本作推断。

## 结论与剩余门禁

Checkpoint R 已完成。自动化证据证明 deny/cancel/budget/default-no-rows 等 Rust 强制边界，原生
证据证明 Demo SQLite Generate/Fix/Explore 三故事能从 Workbench 进入真实 Tauri backend 并返回
用户可见结果。这不宣称任意自然语言目标、外部模型或写模式已经可用。

Checkpoint W 的 macOS 真实键盘与 VoiceOver、Windows WebView2 与 Narrator 证据仍缺失。
Zeus Z1.3 仍为 `NO-GO`；没有新增 Zeus 生产依赖，也没有开始 Z2 renderer integration。
