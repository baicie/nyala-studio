## 总体判断

当前路线 **是对的，而且比继续在原 React/Tauri MVP 上堆功能更稳**。核心判断不变：

```txt
先用 SideX / VS Code Workbench 壳跑通 SQL 产品闭环
再迁移旧 sql-studio/mvp 里的领域资产
不要一开始就搬旧 React 壳、插件市场、多数据库、AI
```

你现在实际已经走到 **Phase 4 左右**：包名、描述、测试脚本已经变成 `sql-studio-next`，测试脚本里已有 `test:branding / test:rust / test:sql-services / test:sql-connections`，但还没有 `test:sql-editor`，说明 Phase 5 还没真正进入主线。

`workbench.common.main.ts` 里已经注册了 SQL Service 和 SQL Connections contribution，但还没有 SQL Editor contribution，所以当前仓库状态大致是：

```txt
Phase 1 基本完成
Phase 2 基本完成
Phase 3 基本完成
Phase 4 基本完成 / 待最终验证
Phase 5 尚未落地
```

SQL Service 已经进入启动链路，SQL Connections 也已经作为 Workbench contribution 引入。

---

# 这条路线目前最大的优点

## 1. 没有一上来就大改 Workbench

这是正确的。你现在是在 SideX 的 `workbench/common/main` 中逐步追加 SQL 贡献点，而不是直接砍 Explorer、SCM、Debug、Terminal。这样风险小很多。

当前仍然保留 Explorer、Search、SCM、Remote 等原始能力。

这符合你路线里说的：

```txt
先新增 SQL 专属 contribution
不要先删旧功能
```

这个策略应该继续保持到 **Result Panel 闭环完成之后**。

---

## 2. SQL 能力分层是对的

当前路线是：

```txt
Rust SQL command
  -> Workbench SQL service
  -> SQL Connections View
  -> SQL Editor
  -> Result Panel
```

这个分层是合理的，因为它避免了后续 UI 到处直接写 `invoke()`。

Rust 侧已经有 `SqlConnectionStore`，里面维护连接 map、SQLite connection、metadata 查询、query 执行等逻辑。

`execute_query` 也已经具备基本查询结果结构：columns、rows、affectedRows、rowCount、elapsedMs、truncated。

所以后续 Phase 5 / Phase 6 不应该绕过这条服务链。

---

## 3. Phase 4 的方向已经基本成立

SQL Connections View 目前已经有：

```txt
- 连接表单
- :memory: 默认值
- createIfMissing 默认勾选
- listConnections
- listTables
- listColumns
- tree render
- close connection
```

这些都在 `sqlConnectionsView.ts` 里。

之前我指出的折叠和 listener 泄漏问题，现在从代码看已经修掉了：树重渲染前会 `treeRenderDisposables.clear()`，折叠状态也已经变成 `collapsedNodes`。

这说明 Phase 4 可以继续作为后续入口。

---

# 当前路线需要调整的地方

## 调整 1：不要把 Phase 9 CI 放到最后

你文档里把测试与 CI 放在 Phase 9，这个顺序需要改。

现在仓库已经在 `package.json` 里接了多段测试：

```txt
test:branding
test:rust
test:sql-services
test:sql-connections
```

所以 CI 不应该等到 Phase 9。正确做法是：

```txt
从 Phase 5 开始，每个 phase 必须：
- 有 unit test
- 进 package.json test 链路
- 至少跑 rust:check / rust:clippy / build
```

也就是说，Phase 9 应该改成：

```txt
Phase X 持续质量门禁
```

而不是最后再补。

---

## 调整 2：Phase 5 前应该插入 Phase 4.5

当前路线从 Connection Tree 直接进入 SQL Editor，但中间少了一步：

```txt
Connection Tree -> Open New Query
Table -> Generate SELECT
```

文档里 Phase 4 写了“右键 Open New Query / Browse Table”，但实际当前 `SqlConnectionsView` 还只是 Connect / Refresh / Close，没有看到打开 SQL Query 的命令接入。

建议新增：

```txt
Phase 4.5：SQL Connections 与 SQL Editor 打通
```

内容：

```txt
1. Connection row 加 Open Query
2. Table row 加 Select Top 100
3. View row 加 Select Top 100
4. 注入 ICommandService
5. executeCommand('sql.newQuery', { connectionId, connectionName, initialSql })
```

如果没有这个阶段，Phase 5 的 SQL Editor 会是孤立入口，只能从 Command Palette 打开，产品闭环感不强。

---

## 调整 3：Phase 5 不能只做 Notification，需要为 Phase 6 留事件通道

你之前 Phase 5 的设计里已经加入 `SqlEditorEventService`，这个方向很好。

最终 Phase 5 应该保证：

```txt
SQL Editor 执行 SQL
  -> ISqlQueryService.executeQuery()
  -> fireQueryStarted
  -> fireQueryCompleted / fireQueryFailed
  -> 临时 notification
```

Phase 6 的 Result Panel 只订阅事件，不反向耦合 Editor。

如果 Phase 5 只是“执行后 notification”，Phase 6 会返工。

---

## 调整 4：Phase 6 Result Panel 是路线成立的真正验收点

这条路线是否成立，不是看 Phase 5 编辑器能不能打开，而是看：

```txt
SQLite 连接
  -> 展开表
  -> 打开 SQL
  -> 执行 SELECT
  -> Result Panel 展示表格
```

所以 Phase 6 不要拖太久，也不要在 Phase 6 前做这些：

```txt
- 多数据库
- 插件 API
- AI Agent
- VS Code 原始入口裁剪
- 复杂右键菜单
- 历史记录
```

你当前路线里说“死盯 SQLite + SQL Editor + Result Panel”，这个判断非常对。

---

## 调整 5：连接持久化要提前到 Phase 6.5

当前 Rust `SqlConnectionStore` 是内存态，连接存在 `HashMap` 里，重启应用连接会丢。

MVP 初期可以接受，但 Result Panel 完成后马上会变成产品体验问题。

建议加：

```txt
Phase 6.5：Connection Persistence
```

内容：

```txt
1. SQLite 连接配置落本地 storage db
2. app 启动后恢复 connections
3. 支持 remove saved connection
4. 支持 readOnly / createIfMissing / displayName
5. 敏感信息预留 secret store，不要明文密码
```

SQLite 先没有密码，可以简单持久化；MySQL/Postgres 之前必须先设计 secret 存储。

---

# 建议调整后的路线

我建议改成下面这样：

```txt
Phase 0：SideX fork 能构建展示 ✅

Phase 1：产品化收口 / 去 SideX 品牌 ✅

Phase 2：Rust SQL Backend Bridge ✅
- SQLite only
- sql_* commands
- Rust tests

Phase 3：Workbench SQL Service Bridge ✅
- ISqlConnectionService
- ISqlMetadataService
- ISqlQueryService
- service tests

Phase 4：SQL Connections Activity ✅/验证中
- Activity Bar
- Connection Tree
- Add / Refresh / Close
- tree model tests

Phase 4.5：Connection Tree -> SQL Editor 打通
- Open Query
- Select Top 100
- Browse table 先生成 SQL，不做结果页

Phase 5：SQL EditorInput / SQL EditorPane
- New SQL Query
- Monaco SQL editor
- execute all / selection
- keyboard shortcut
- SqlEditorEventService

Phase 6：Query Result Panel
- 订阅 SqlEditorEventService
- 展示 columns / rows
- error / messages
- copy / export CSV 可选

Phase 6.5：连接持久化
- saved connections
- startup restore
- remove saved connection

Phase 7：迁移旧 sql-studio/mvp 领域资产
- sqlgui-db
- sqlgui-common
- Postgres / MySQL
- sqlgui-api 类型思想

Phase 8：产品裁剪
- 隐藏 Explorer / SCM / Debug / Remote
- 默认进入 SQL Connections
- 菜单收口

Phase 9：插件 / AI / 高级能力
- extension manifest
- SQL formatter
- AI SQL assistant
- query history
- explain plan
```

---

# 当前最应该做的下一步

现在不要急着做多数据库，也不要急着裁剪 VS Code 功能。

最优下一步是：

```txt
Phase 4.5 + Phase 5
```

也就是：

```txt
SQL Connections View
  -> Open New Query
  -> 打开 SqlEditorInput
  -> 选中 connectionId
  -> 执行 SELECT
  -> 先 notification
  -> 同时 fire event 给 Phase 6
```

完成后再做 Result Panel。

---

# 当前路线风险评估

| 风险                                   | 等级 | 说明                                         | 处理方式                             |
| -------------------------------------- | ---: | -------------------------------------------- | ------------------------------------ |
| SideX 原始 Workbench 太重              |   中 | 当前仍保留 Explorer/SCM/Remote/Search        | SQL 闭环前不要裁剪                   |
| SQL Editor 接入 Workbench 生命周期复杂 | 中高 | EditorInput/EditorPane 容易踩生命周期坑      | 单独 Phase 5，不夹杂 Result Panel    |
| Connection 不持久化                    |   中 | 重启丢连接                                   | Phase 6.5 解决                       |
| SQLite 后端过简                        |   低 | MVP 足够                                     | Result Panel 后再迁移 sqlgui-db      |
| Result Grid 性能                       |   中 | 大结果集可能卡                               | Phase 6 限制 row limit，后续虚拟滚动 |
| 多数据库提前做导致发散                 |   高 | Postgres/MySQL 会引入凭据、驱动、schema 差异 | Phase 7 再做                         |
| AI Agent 提前做导致路线跑偏            |   高 | 当前没有基础产品闭环                         | Result Panel 后再考虑                |

---

# 我对路线的最终判断

**继续走 SideX fork 这条线。**

但路线需要从：

```txt
Phase 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9
```

调整成：

```txt
Phase 1 -> 2 -> 3 -> 4 -> 4.5 -> 5 -> 6 -> 6.5 -> 7 -> 8 -> 9
```

其中真正的“生死点”是：

```txt
Phase 6：Result Panel
```

只要做到：

```txt
打开应用
  -> 添加 SQLite
  -> 展开表
  -> Open Query
  -> SELECT
  -> 结果表格展示
```

这条路线就成立。

在 Phase 6 之前，不要做多数据库、AI、插件市场、深度裁剪。当前策略是对的，继续推进，但要把 **Phase 4.5 和 Phase 6.5** 补进路线。
