```txt
Phase 0：SideX Fork 能构建展示 ✅

Phase 1：产品化收口 / 去 SideX 品牌 ✅

Phase 2：Rust SQLite Backend Bridge ✅
- sql_test_connection
- sql_open_connection
- sql_close_connection
- sql_list_connections
- sql_list_tables
- sql_list_columns
- sql_execute_query
- sql_cancel_query

Phase 3：Workbench SQL Service Bridge ✅
- ISqlConnectionService
- ISqlMetadataService
- ISqlQueryService
- TauriSqlCommandExecutor
- 前端 service tests

Phase 4：SQL Connections Activity ✅
- SQL Activity
- SQL Connections View
- Add / Refresh / Close
- Connection Tree
- Tables / Views / Columns

Phase 4.5：Connection Tree -> SQL Editor ✅
- Connection -> Open Query
- Table -> SELECT Top 100
- View -> SELECT Top 100
- ICommandService 调用 sql.newQuery

Phase 5：SQL EditorInput / SQL EditorPane ✅
- SqlEditorInput
- SqlEditorPane
- New SQL Query
- Execute All
- Execute Selection
- Ctrl/Cmd + Enter
- Shift + Ctrl/Cmd + Enter
- SqlEditorEventService

Phase 6：Query Result Panel ✅
- SQL Results Panel
- SqlResultService
- SqlResultBridgeContribution
- Running / Success / Error / Idle
- columns / rows 展示
- affected rows
- Copy CSV
- Clear

Phase 6.5：Connection Persistence ✅/修复中
- saved connections
- startup restore
- remove saved connection
- Save / Auto connect
- 禁止默认保存 :memory:
- void command 正确处理
- openNow 先打开成功再持久化
- 已打开连接重复 Open 幂等处理

Phase 6.6：SQL Domain Cleanup 可选
- sqlDialect
- sqlDrivers
- quote identifier
- qualified name
- preview SQL
- 只作为内部清理
- 不继续扩展多数据库 UI

Phase 7：Result Grid & Query UX Migration
- SqlResultGridModel
- Cell / Row / Column model
- 选中单元格
- Copy Cell
- Copy Row
- Copy CSV
- Copy TSV
- NULL / blob / number / text 展示区分
- Result status bar
- 大结果集限制 1000 行
- 不做虚拟滚动 / AG Grid / 多数据库

Phase 7.2：Query History & Recent SQL
- 最近执行 SQL
- connectionId
- elapsedMs
- rowCount
- success / error
- executedAt
- Open in Editor
- Rerun
- Clear History
- 本地持久化

Phase 7.3：SQL Editor UX Enhancement
- 当前连接显示
- 切换 connection
- 执行当前语句
- 执行选区
- SQL formatter 预留入口
- 错误定位预留
- 保存临时 SQL 草稿
- 恢复未关闭 query tab

Phase 7.4：Schema Tree UX Enhancement
- 刷新单个 connection
- 刷新单个 table
- Copy table name
- Copy qualified name
- Generate SELECT
- Generate COUNT
- Generate INSERT template
- Generate UPDATE template
- 仍然只服务 SQLite

Phase 8：产品收口 / Workbench 裁剪
- 隐藏 Explorer
- 隐藏 SCM
- 隐藏 Debug
- 隐藏 Remote
- 隐藏无关菜单
- 默认打开 SQL Connections
- 默认显示 SQL Results
- 欢迎页改成 SQL Studio
- 命令面板收口
- 先隐藏入口，不直接删除源码

Phase 8.5：轻量设置与本地偏好
- 默认 row limit
- 默认 auto connect
- 默认 result copy format
- 默认 editor font size
- 默认 theme
- 结果表格最大渲染行数

Phase 9：多数据库地基
- Driver abstraction
- Connection form abstraction
- Rust driver trait
- Secret Store
- saved connection schema v2
- connection test abstraction
- metadata abstraction
- query abstraction

Phase 9.1：Postgres Preview
- Postgres connection
- list schemas
- list tables
- list columns
- execute query
- password 不明文保存

Phase 9.2：MySQL Preview
- MySQL connection
- list databases
- list tables
- list columns
- execute query
- dialect SQL generation

Phase 10：高级能力
- SQL formatter
- Explain Plan
- Query snippets
- Workspace project
- 插件 API
- AI SQL assistant
- AI explain error
- AI generate query
- AI optimize query
```

```txt
核心顺序：

先完成 SQLite SQL GUI 日常可用
再做 Workbench 产品裁剪
再做多数据库地基
最后做插件与 AI
```
