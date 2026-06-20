重新把 **Nyala Studio 的 MVP 阶段目标** 收口一下。这里的 MVP 不应该再继续无限膨胀，核心效果应该是：

```txt
一个轻量级、可本地运行、以 SQL 查询为核心的数据库客户端，
具备 SQLite + MySQL 的基础连接和查询能力，
有 SQL 编辑器、结果面板、连接管理、查询历史、基础高级能力，
并且为后续插件化和 AI 能力留下清晰地基。
```

---

# 一、MVP 最终要达到的产品效果

用户打开应用后，应该能完成这条完整链路：

```txt
打开 Nyala
  → 新建 / 选择一个连接
  → 浏览数据库 / 表 / 字段
  → 编写 SQL
  → 格式化 SQL
  → 执行 SQL
  → 查看结果
  → 查看查询历史
  → 保存常用查询 / snippet
  → 对错误或 SQL 使用 AI 辅助
```

也就是说，MVP 的核心不是“像 VS Code 一样完整”，而是 **围绕 SQL 工作流闭环**。

---

# 二、MVP 必须具备的核心能力

## 1. 应用壳与产品化 Workbench

MVP 需要从 VS Code 上游的通用 IDE 体验里收口成 SQL 产品体验。

需要具备：

```txt
1. 启动后默认进入 SQL 工作区
2. 默认显示 SQL Connections / SQL Results
3. 有 Nyala 产品级命令
4. 有本地偏好设置
5. 不暴露太多 VS Code 原生开发工具心智
6. 保留必要的编辑器 / 命令 / 面板能力
```

用户感知上应该是：

```txt
这是一个 SQL 客户端，不是一个改皮肤的 VS Code。
```

---

## 2. 数据库连接能力

MVP 阶段建议明确支持：

```txt
SQLite：稳定支持
MySQL：Preview runtime 支持
PostgreSQL：只保留协议 / UI / 方言地基，不作为 MVP 可用数据库
```

SQLite 必须完整可用：

```txt
1. 打开本地 .db 文件
2. 支持 :memory:
3. 支持 read-only
4. 支持 create if missing
5. 支持保存连接
6. 支持自动恢复连接
```

MySQL Preview 至少要可用：

```txt
1. 输入 host / port / database / username / password
2. 能真实连接
3. 能列 databases
4. 能列 tables
5. 能列 columns
6. 能执行 query
7. password 不落盘
```

暂不要求：

```txt
1. MySQL Secret Store
2. MySQL auto connect
3. PostgreSQL runtime
4. 高级 SSL 证书配置
5. 连接池高级配置
```

---

## 3. 元数据浏览能力

MVP 要能让用户看到数据库结构。

至少包括：

```txt
1. 连接列表
2. saved connections
3. 当前打开连接
4. databases / schemas
5. tables
6. views
7. columns
8. primary key / nullable / data type / default value
```

SQLite：

```txt
main
  tables
  views
  columns
```

MySQL：

```txt
databases
  tables
  views
  columns
```

PostgreSQL：

```txt
只保留 dialect / profile / catalog 地基，不进入可用浏览能力
```

---

## 4. SQL 编辑器能力

SQL Editor 是 MVP 核心。

必须有：

```txt
1. 新建 Query
2. 选择连接
3. 编写 SQL
4. 执行当前 SQL
5. 执行选中 SQL
6. 执行当前 statement
7. 格式化 SQL
8. Explain Plan
9. 草稿自动保存
10. 重启恢复 draft
```

MVP 不要求复杂编辑器能力：

```txt
1. 不要求完整 SQL LSP
2. 不要求智能补全非常完美
3. 不要求复杂语法树解析
4. 不要求多 cursor 高级 SQL 语义能力
```

但需要有基础体验：

```txt
执行 SQL 不应该丢内容
切换连接不应该混乱
错误要能清楚展示
结果和历史要能对应到查询
```

---

## 5. 查询执行能力

MVP 查询执行要稳定。

必须支持：

```txt
1. SELECT 查询
2. INSERT / UPDATE / DELETE
3. DDL：CREATE / DROP / ALTER
4. 查询耗时
5. affected rows
6. row count
7. limit / truncation
8. cancel query，SQLite 至少可用，MySQL 可提示暂不支持
```

结果数据类型至少要处理：

```txt
NULL
Integer
Real / Float
Text
Blob
Date / Time 以 Text 展示
```

---

## 6. 结果面板能力

SQL Results 是用户每天看的区域。

必须具备：

```txt
1. 表格展示 columns / rows
2. 空结果展示 affected rows
3. 错误展示
4. 查询耗时展示
5. row count 展示
6. 超限 truncated 提示
7. 支持重新渲染最近一次结果
```

MVP 可不做：

```txt
1. 大数据虚拟滚动极致优化
2. 复杂筛选排序
3. 导出 CSV / Excel
4. 图表可视化
```

---

## 7. 查询历史能力

MVP 应该有基础 Query History。

需要支持：

```txt
1. 记录执行过的 SQL
2. 记录 connectionId / connectionName
3. 记录成功 / 失败
4. 记录耗时
5. 记录执行时间
6. 点击历史重新打开 SQL
7. 清空历史
```

不要求：

```txt
1. 云同步历史
2. 团队共享历史
3. 历史全文搜索高级索引
```

---

## 8. Query Snippets

MVP 需要有基础 snippets，提高可用性。

必须有：

```txt
1. 内置 snippets
2. SELECT
3. COUNT
4. INSERT
5. UPDATE
6. EXPLAIN
7. 插入到 SQL 编辑器
8. 变量替换
```

后续再做：

```txt
1. snippet 文件夹管理
2. snippet marketplace
3. snippet 多人同步
```

---

## 9. SQL Formatter

MVP 要把之前 placeholder 改成可用 formatter。

要求：

```txt
1. 支持基本 keyword 大写
2. SELECT / FROM / WHERE / LIMIT 分行
3. 保护字符串
4. 保护注释
5. 保护 quoted identifier
6. 可格式化当前 SQL
```

不要求：

```txt
1. 完整 SQL AST formatter
2. 所有方言 100% 美化
3. 复杂 CTE / window function 完美缩进
```

---

## 10. Explain Plan

MVP 要有基础 explain。

支持：

```txt
SQLite: EXPLAIN QUERY PLAN
MySQL: EXPLAIN
PostgreSQL: 只生成 SQL，不作为 runtime 可用
```

展示方式：

```txt
1. 作为普通查询结果展示在 SQL Results
2. 不做复杂图
3. 不做 AI 深度解读作为必选
```

---

## 11. Workspace Project

MVP 需要有 workspace 地基，但不需要做很重。

至少模型层具备：

```txt
1. workspace name
2. rootUri
3. connections refs
4. query files refs
5. snippets refs
6. metadata cache 开关
```

产品效果上可以先轻量：

```txt
Nyala 能知道当前 workspace 是什么，
后续 snippets / AI / plugin 能拿 workspace 上下文。
```

不要求：

```txt
1. 完整项目资源管理器
2. 复杂文件树
3. Git 集成
4. 多 workspace 窗口管理
```

---

## 12. 插件 API 地基

MVP 需要插件地基，但不做真正 marketplace。

必须具备：

```txt
1. plugin manifest
2. plugin registry
3. command contribution
4. sql action contribution
5. plugin activate 状态
```

不做：

```txt
1. 远程插件加载
2. 插件市场
3. 插件沙箱完整安全模型
4. 第三方插件运行时
```

MVP 目标是：

```txt
架构上后续能扩展，不是现在就开放生态。
```

---

## 13. AI SQL Assistant

MVP 可以有 AI 能力，但必须控制范围。

建议 MVP 只做：

```txt
1. AI provider 抽象
2. deterministic/mock provider
3. AI context model
4. assistant prompt
5. explain error prompt
6. generate query prompt
7. optimize query prompt
8. 结果插入 SQL Editor
```

不强制接真实 LLM。

必须避免：

```txt
1. 一开始就绑定某个商业 API
2. 没有 provider 抽象就写死 OpenAI
3. 没有 schema 上下文就乱生成
4. 没有用户确认就自动执行 AI SQL
```

AI MVP 的正确效果是：

```txt
AI 能帮你生成 / 解释 / 优化 SQL，
但生成结果先进入编辑器，由用户确认执行。
```

---

# 三、MVP 的边界

## MVP 要做

```txt
SQLite 完整可用
MySQL Preview 可连接可查询
SQL 编辑器可用
结果面板可用
查询历史可用
连接管理可用
SQL formatter 可用
Explain Plan 可用
Snippets 可用
Workspace 地基有
Plugin API 地基有
AI SQL assistant 地基有
产品启动体验收口
本地偏好可用
测试链路完整
```

## MVP 不做

```txt
PostgreSQL 真实连接
Secret Store
复杂权限系统
云同步
多端协作
插件市场
远程插件执行
完整 SQL LSP
复杂可视化图表
数据编辑器
ER 图
表结构设计器
CSV / Excel 高级导入导出
生产级 AI Agent 自动执行
完整 VS Code 功能裁剪
```

---

# 四、MVP 最终能力清单

按用户视角，MVP 最终应该能做到：

```txt
1. 我能打开 Nyala
2. 我能打开 SQLite 数据库
3. 我能连接 MySQL
4. 我能看到数据库 / 表 / 字段
5. 我能写 SQL
6. 我能格式化 SQL
7. 我能执行 SQL
8. 我能查看结果
9. 我能查看查询历史
10. 我能 explain query
11. 我能插入常用 snippet
12. 我能保存常用连接，至少 SQLite 完整支持
13. 我能保存 workspace 级项目上下文
14. 我能通过 AI 生成 SQL
15. 我能通过 AI 解释 SQL 错误
16. 我能通过 AI 优化 SQL
17. 我能看到插件 API 的架构入口
```

---

# 五、工程架构最终形态

MVP 的架构应该收敛成这几层：

```txt
Workbench Shell
  ├─ SQL Product Bootstrap
  ├─ SQL Preferences
  ├─ SQL Connections
  ├─ SQL Editor
  ├─ SQL Results
  ├─ SQL History
  ├─ SQL Advanced
  └─ SQL Services
```

Tauri 后端：

```txt
src-tauri/src/commands/sql
  ├─ types.rs
  ├─ driver.rs
  ├─ state.rs
  ├─ connection.rs
  ├─ metadata.rs
  ├─ query.rs
  ├─ persistence.rs
  ├─ dialect.rs
  ├─ mysql_runtime.rs
  └─ mod.rs
```

前端服务层：

```txt
src/vs/workbench/services/sql
  ├─ common/sqlTypes.ts
  ├─ common/sqlDrivers.ts
  ├─ common/sqlDialect.ts
  ├─ common/sqlValidation.ts
  ├─ common/sqlConnection.ts
  ├─ common/sqlMetadata.ts
  ├─ common/sqlQuery.ts
  └─ browser/*
```

高级能力：

```txt
src/vs/workbench/contrib/sqlAdvanced
  ├─ formatter
  ├─ explain
  ├─ snippets
  ├─ workspace
  ├─ plugin api
  └─ ai
```

---

# 六、MVP 验收标准

我建议用这份作为 MVP 验收 Checklist：

> 2026-06-20 审查说明：`[x]` 表示已有自动化验证；桌面 UI 冒烟和真实 MySQL 集成项在实际执行前保持未勾选。详见 `docs/reviews/2026-06-20-roadmap-progress-review.md`。

```txt
[ ] 应用启动后进入 Nyala 工作区（待桌面冒烟）
[ ] SQL Connections 默认可见（启动计划已覆盖，待桌面冒烟）
[ ] SQL Results 默认可见（启动计划已覆盖，待桌面冒烟）
[x] SQLite :memory: 可连接
[x] SQLite 文件可连接
[x] SQLite saved connection 可恢复
[ ] MySQL 可连接（已有 runtime，待 `pnpm run test:mysql-integration`）
[ ] MySQL 可 list databases（待真实 MySQL 集成测试）
[ ] MySQL 可 list tables（待真实 MySQL 集成测试）
[ ] MySQL 可 list columns（待真实 MySQL 集成测试）
[ ] MySQL 可 SELECT 1（待真实 MySQL 集成测试）
[x] SQL Editor 可新建 query
[x] SQL Editor 可执行 query
[x] SQL Editor 可格式化 SQL
[x] SQL Editor 可 Explain Plan
[x] SQL Result 可展示 rows / columns / elapsed / error
[x] Query History 可记录成功和失败查询
[x] Snippets 可选择并插入 SELECT / COUNT / INSERT / UPDATE / EXPLAIN
[x] Workspace model 可保存 / 恢复
[x] Plugin registry 可注册 command / sql action
[x] AI assistant 可生成 deterministic prompt / SQL
[x] AI explain error 可生成解释 prompt
[x] AI generate query 可生成 SQL draft
[x] AI optimize query 可生成优化建议
[x] 默认 SQL 相关测试全部通过（MySQL live test 为显式 opt-in）
[x] Tauri cargo test / cargo check 通过
[x] pnpm build 通过
```

---

# 七、MVP 阶段最终路线锁定

```txt
Phase 0 - 3：基础工程 / SQL MVP 雏形
Phase 4 - 6：SQL Editor / Results / History / SQLite 完整闭环
Phase 7：连接管理增强
Phase 8：产品化收口
Phase 9：多数据库地基 + MySQL Preview
Phase 10：高级能力整体包
```

MVP 到 **Phase 10 完成** 就应该停止继续加大功能范围，进入：

```txt
修 bug
打磨体验
跑端到端
做 release
写使用文档
准备 demo
```

而不是继续加 Phase 11 / 12 扩展功能。

---

# 八、最终一句话

Nyala Studio 的 MVP 不是“做一个完整数据库 IDE”，而是：

```txt
一个以 SQL 查询为中心的轻量数据库客户端：
SQLite 稳定可用，MySQL Preview 可用，
编辑 / 执行 / 结果 / 历史 / 元数据闭环完整，
并带有 formatter、explain、snippets、workspace、plugin API、AI assistant 的高级能力地基。
```

这才是 MVP 阶段应该交付的效果。
