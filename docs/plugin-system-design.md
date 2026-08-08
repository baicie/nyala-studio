# SQL Studio Next 插件系统设计文档

## 1. 背景

SQL Studio Next 是一个基于 VS Code-like Workbench 前端和 Tauri Rust 后端的 SQL GUI。它继承了 SideX / VS Code 风格的工作台架构，同时目标不是成为通用代码编辑器，而是成为面向数据库连接、SQL 编辑、查询执行、结果查看和元数据浏览的 SQL 工作台。

插件系统的设计目标不是完整复刻 VS Code，而是在保留部分 VS Code 插件生态价值的同时，建立一套更适合 SQL 客户端的安全、稳定、可扩展能力模型。

当前仓库已经具备插件系统雏形：

- `src-tauri/extension-host/`：Node extension host 和 `vscode` compatibility shim。
- `src-tauri/src/commands/extensions.rs`：VSIX 安装、卸载、Marketplace 搜索和 contribution 读取。
- `src-tauri/src/commands/extension_platform.rs`：Rust 侧生成 VS Code-like extension init data。
- `src-tauri/src/commands/extension_wasm.rs`：WASM extension runtime 基础。
- `src-tauri/wit/world.wit`：WIT 定义的 WASM 插件 API 边界。
- `crates/sidex-extensions`：manifest、activation、contribution、registry、VSIX 等扩展基础能力。
- `crates/sidex-extension-api`：`vscode.window`、`vscode.workspace`、`vscode.commands`、`vscode.languages` 等 API compatibility shim。

因此，推荐方案不是从零实现插件系统，而是将现有 SideX 扩展基础收束为 SQL Studio Next 的正式插件平台。

## 2. 核心结论

SQL Studio Next 可以支持 VS Code 插件，但应定义为“部分兼容”，而不是“完整兼容”。

推荐产品定位：

```txt
SQL Studio Next is a VS Code-like SQL workbench with a VS Code-compatible extension subset and a first-class SQL-native plugin platform.
```

中文表达：

```txt
SQL Studio Next 是一个 VS Code-like SQL 工作台，支持部分 VS Code 兼容扩展，并提供一套面向数据库工作流的一等插件系统。
```

不建议承诺：

```txt
Supports all VS Code extensions.
```

建议承诺：

```txt
Supports selected VS Code-compatible extensions such as themes, syntax grammars, snippets, and SQL-focused extensions.
```

## 3. 设计目标

插件系统应满足以下目标：

1. 支持低风险 VS Code 兼容插件，例如主题、图标主题、语法、片段和部分命令。
2. 支持 SQL Studio 原生插件，例如 SQL 方言、formatter、metadata enhancer、result renderer、connection provider。
3. 所有敏感能力经过 Rust 权限网关，不允许插件绕过 Workbench service 和 Tauri command 边界。
4. 默认安全，尤其保护数据库凭据、连接字符串、查询结果和本地文件。
5. 插件运行时可诊断、可禁用、可二分、可恢复安全模式。
6. 插件系统不阻塞当前 SQLite MVP，不提前引入 PostgreSQL/MySQL、AI Agent、云账号或团队协作能力。

## 4. 非目标

当前阶段不追求：

- 完整 VS Code API 兼容。
- 完整 VS Code Marketplace 兼容。
- Electron API 兼容。
- VS Code Remote / Dev Container / WSL 兼容。
- Notebook 插件兼容。
- Debugger 插件完整兼容。
- 允许插件直接读取完整数据库连接字符串。
- 允许插件默认执行写 SQL。
- 允许插件默认访问网络或 shell。

## 5. VS Code 插件兼容策略

### 5.1 支持等级

| 插件能力 | 支持建议 | 说明 |
| --- | --- | --- |
| 主题插件 | 高优先级支持 | 低风险，高收益，适合早期开放 |
| 图标主题 | 高优先级支持 | 多为静态 contribution |
| TextMate 语法 | 高优先级支持 | 对 SQL 方言高亮有直接价值 |
| snippets | 高优先级支持 | 简单、安全、对 SQL 编写有价值 |
| commands | 部分支持 | 必须经过 command allowlist 和权限网关 |
| keybindings | 部分支持 | 不能覆盖核心 SQL 快捷键 |
| language providers | 部分支持 | completion、hover、formatting 可逐步开放 |
| webview | 谨慎支持 | 需要 CSP、资源隔离和消息权限模型 |
| debugger | 暂缓 | 不属于 SQL MVP |
| notebook | 暂缓 | 不属于当前产品阶段 |
| remote / devcontainer | 不支持 | 与产品定位和 Tauri 边界冲突 |
| native Node module | 默认不支持 | 跨平台和安全风险高 |
| proposed API | 不支持 | 兼容成本不可控 |

### 5.2 兼容层边界

VS Code 兼容层应通过 `extension-host` 执行插件 JavaScript，但插件不能直接控制 Tauri 或 Workbench 内部对象。

推荐边界：

```txt
VS Code Extension
  -> vscode shim
  -> Extension Host IPC
  -> SQL Studio Permission Broker
  -> Workbench Service / Tauri Command
  -> Rust backend
```

禁止边界：

```txt
VS Code Extension
  -> direct invoke()
  -> raw database command
```

## 6. 总体架构

推荐架构：

```txt
SQL Studio Plugin Platform
├── Extension Registry
├── Manifest Parser
├── Permission Broker
├── Activation Service
├── Contribution Service
├── Runtime Manager
│   ├── Built-in Workbench Contributions
│   ├── VS Code Compatibility Runtime
│   └── SQL Studio WASM Runtime
├── SQL Extension API
├── Marketplace / Local Install Service
└── Diagnostics / Bisect / Safe Mode
```

设计原则：

```txt
VS Code 插件用于兼容生态。
SQL Studio 插件用于产品能力。
WASM 插件作为默认安全运行时。
Node 插件作为兼容运行时。
所有敏感能力必须经过 Rust 权限网关。
```

## 7. 双运行时模型

### 7.1 VS Code Compatibility Runtime

用途：

```txt
运行已有 VSIX / package.json 插件。
```

现有基础：

```txt
src-tauri/extension-host/server.cjs
src-tauri/extension-host/host.cjs
crates/sidex-extension-api
crates/sidex-extensions
```

适合支持：

```txt
themes
iconThemes
grammars
snippets
commands
menus
keybindings
basic language providers
basic webview
```

默认限制：

```txt
不允许任意 shell 执行。
不允许任意文件系统访问。
不允许直接读取数据库凭据。
不允许直接执行 SQL。
不允许未声明的网络访问。
不保证 native Node module 可用。
不保证 Electron 相关插件可用。
```

### 7.2 SQL Studio WASM Runtime

用途：

```txt
运行 SQL Studio 原生插件。
```

现有基础：

```txt
src-tauri/src/commands/extension_wasm.rs
src-tauri/wit/world.wit
wasmtime
wasmtime-wasi
```

适合支持：

```txt
SQL formatter
SQL linter
SQL dialect parser
metadata transformer
result renderer
connection profile validator
readonly query assistant
schema explorer enhancer
```

推荐策略：

```txt
WASM 是官方推荐插件格式。
Node 是 VS Code 兼容格式。
```

原因：

- WASM 沙箱更强。
- 权限模型更容易约束。
- 跨平台表现更稳定。
- 更适合数据库客户端处理敏感数据。

## 8. Manifest 设计

插件应兼容 VS Code `package.json`，同时允许 SQL Studio 专属字段。

示例：

```json
{
  "name": "sqlite-tools",
  "publisher": "sqlstudio",
  "displayName": "SQLite Tools",
  "version": "0.1.0",
  "engines": {
    "vscode": "^1.80.0",
    "sqlStudio": "^0.1.0"
  },
  "activationEvents": [
    "onSqlDialect:sqlite",
    "onCommand:sqlstudio.sqlite.explainQuery"
  ],
  "main": "./dist/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "sqlstudio.sqlite.explainQuery",
        "title": "SQLite: Explain Query"
      }
    ],
    "sqlStudio": {
      "dialects": ["sqlite"],
      "formatters": ["sqlite"],
      "resultRenderers": ["table", "json"],
      "connectionProviders": ["sqlite"]
    }
  },
  "capabilities": {
    "sql": {
      "connections": "metadata",
      "query": "readonly"
    },
    "fs": {
      "read": ["workspace"]
    },
    "net": {
      "allow": []
    },
    "secrets": false
  }
}
```

WASM 插件可继续支持 `sidex.toml`，但建议未来重命名或兼容为：

```txt
sqlstudio.toml
```

短期可保留：

```txt
sidex.toml
```

作为迁移兼容格式。

## 9. 权限模型

SQL Studio 是桌面数据库客户端，权限模型必须比普通编辑器更严格。

### 9.1 SQL 权限

| 权限 | 含义 |
| --- | --- |
| `sql.connections.read` | 读取连接显示名、类型、状态，不含凭据 |
| `sql.connections.metadata` | 读取库、schema、表、列、索引等元数据 |
| `sql.query.readonly` | 执行只读查询 |
| `sql.query.write` | 执行写查询，必须用户确认 |
| `sql.results.read` | 读取当前查询结果 |
| `sql.results.render` | 渲染结果视图，不默认读取全部结果 |

### 9.2 系统权限

| 权限 | 含义 |
| --- | --- |
| `fs.workspace.read` | 读取 workspace 文件 |
| `fs.workspace.write` | 写入 workspace 文件 |
| `fs.extension.read` | 读取插件自身目录 |
| `secrets.read` | 读取插件自己的 secret |
| `secrets.write` | 写入插件自己的 secret |
| `net.request` | 网络请求，必须声明 allowlist |
| `clipboard.read` | 读取剪贴板 |
| `clipboard.write` | 写入剪贴板 |
| `shell.execute` | 执行 shell，默认禁用 |

### 9.3 安全规则

必须遵守：

```txt
插件永远不能直接拿完整连接字符串。
插件永远不能默认执行写 SQL。
插件读取 query result 需要显式权限。
插件网络访问必须声明域名 allowlist。
插件权限变更需要用户重新确认。
插件不能绕过 SQL service 直接调用 Tauri SQL command。
插件日志不能打印 password、token、secret、private key 或完整数据库 URL。
```

## 10. SQL 原生扩展 API

推荐提供独立 API 命名空间：

```ts
sqlstudio.sql
sqlstudio.connections
sqlstudio.metadata
sqlstudio.query
sqlstudio.results
sqlstudio.dialects
sqlstudio.secrets
```

示例：

```ts
sqlstudio.dialects.registerDialect({
  id: 'sqlite',
  displayName: 'SQLite',
  keywords: ['SELECT', 'FROM', 'WHERE']
});

sqlstudio.query.registerReadonlyProvider('sqlite', {
  explain(query, context) {
    return sqlstudio.query.executeReadonly({
      connectionId: context.connectionId,
      sql: `EXPLAIN QUERY PLAN ${query}`
    });
  }
});

sqlstudio.results.registerRenderer({
  id: 'json-tree',
  label: 'JSON Tree',
  supports(result) {
    return result.columns.some(column => column.type === 'json');
  },
  render(container, result) {
    // Render inside sandboxed result renderer surface.
  }
});
```

API 设计原则：

```txt
插件拿到的是能力，不是内部对象。
插件拿到的是安全 handle，不是原始凭据。
插件默认只读。
插件执行写操作必须经过显式权限和 UI 确认。
```

## 11. Contribution Points

SQL Studio 应新增以下 contribution points：

```txt
contributes.sqlStudio.connectionProviders
contributes.sqlStudio.dialects
contributes.sqlStudio.formatters
contributes.sqlStudio.linters
contributes.sqlStudio.resultRenderers
contributes.sqlStudio.metadataDecorators
contributes.sqlStudio.queryActions
contributes.sqlStudio.connectionForms
contributes.sqlStudio.statusItems
```

建议激活事件：

```txt
onSqlConnection:sqlite
onSqlDialect:sqlite
onSqlQueryExecuted
onSqlResultOpened
onSqlMetadataLoaded
onSqlEditorOpened
onCommand:...
```

## 12. 插件安装来源

推荐三层来源：

### 12.1 Built-in Extensions

内置插件随产品发布，例如：

```txt
SQL 基础语法
SQLite 基础能力
默认 SQL formatter
默认 SQL result renderer
默认主题和图标主题
```

### 12.2 Local Install

支持：

```txt
.vsix
.sqlstudio.vsix
WASM plugin bundle
```

### 12.3 Marketplace

建议长期建设 SQL Studio 自有插件源，或者兼容 Open VSX 风格 registry。

不建议直接绑定 Microsoft VS Code Marketplace 作为产品主要插件源，因为它涉及分发政策、产品标识和兼容性预期问题。

## 13. Workbench 集成方式

插件系统不应绕过 VS Code-like Workbench 架构。

推荐新增或整理：

```txt
src/vs/workbench/services/extensions/common/
src/vs/workbench/services/extensions/browser/
src/vs/workbench/services/sql/common/
src/vs/workbench/services/sql/browser/
src/vs/workbench/contrib/extensions/
src/vs/workbench/contrib/sqlExtensions/
```

核心服务：

```txt
IExtensionRegistryService
IExtensionRuntimeService
IExtensionPermissionService
IExtensionContributionService
ISqlExtensionService
```

SQL 插件调用数据库能力时必须经过：

```txt
ISqlConnectionService
ISqlMetadataService
ISqlQueryService
```

而不是直接调用：

```txt
invoke('sql_execute_query')
```

## 14. 诊断、安全模式与二分

插件系统必须提供：

```txt
禁用单个插件
禁用所有第三方插件
只启用内置插件
插件启动耗时统计
插件错误记录
插件 provider 调用耗时
插件二分诊断
插件权限审计
```

当前仓库已有 `extension_diagnostics` 和 bisect 相关 command，可以作为基础继续收束。

## 15. 演进路线

### Phase A：收束现有插件基础

目标：

```txt
把 SideX extension 基础整理成 SQL Studio Plugin Platform。
```

任务：

```txt
明确 Node host 是 VS Code compatibility runtime。
明确 WASM host 是 SQL Studio native runtime。
整理 sidex 命名迁移计划。
建立插件权限数据模型。
建立插件诊断视图。
```

### Phase B：开放低风险 VS Code 兼容能力

目标：

```txt
先支持静态、安全、对 SQL 工作台有价值的插件能力。
```

任务：

```txt
themes
iconThemes
grammars
snippets
commands
keybindings
```

### Phase C：开放 SQL 原生插件 API

目标：

```txt
让插件能增强 SQL 工作流，而不是只增强编辑器。
```

任务：

```txt
dialect provider
formatter provider
metadata decorator
readonly query action
result renderer
connection form contribution
```

### Phase D：插件市场和安全策略

目标：

```txt
让第三方插件可以安全分发、安装、审计和回滚。
```

任务：

```txt
插件签名
权限确认 UI
插件安全模式
插件二分诊断
插件兼容性标记
插件评分和来源标记
```

### Phase E：高级能力

目标：

```txt
在 SQLite MVP 稳定后，逐步开放更强能力。
```

任务：

```txt
数据库驱动插件
企业内部分发源
私有插件仓库
团队共享插件配置
```

## 16. 与当前 MVP 的关系

插件系统不应抢占当前 MVP 优先级。

当前 MVP 仍然优先：

```txt
Launch app
  -> show SQL Studio branded workbench
  -> add/open SQLite connection
  -> list database tables
  -> open SQL editor
  -> execute SELECT query
  -> show result in panel
```

插件系统在 MVP 阶段只应做两类工作：

1. 保留并修复现有 extension 基础，避免破坏构建。
2. 为 SQL service / SQL contrib 预留扩展点，但不提前承诺完整插件生态。

## 17. 推荐决策

最终推荐：

```txt
采用“双运行时、单注册表、单权限模型”的插件系统。
```

具体含义：

```txt
双运行时：
  Node runtime 负责 VS Code 兼容插件。
  WASM runtime 负责 SQL Studio 原生安全插件。

单注册表：
  所有插件统一扫描、安装、启用、禁用、诊断。

单权限模型：
  无论 Node 插件还是 WASM 插件，都必须通过同一套权限声明和权限网关。
```

这个方案能同时获得：

- VS Code 生态的主题、语法、片段和基础语言能力。
- Tauri + Rust 的安全边界。
- SQL 客户端所需的凭据保护和查询安全。
- 未来 SQL 插件生态的独立产品空间。

最重要的取舍：

```txt
不要追求 100% VS Code 插件兼容。
要追求 SQL 插件体验比 VS Code 更好、更安全、更贴近数据库工作流。
```

## 18. 数据库连接器边界

本文中的 Workbench / Node / WASM 插件系统不负责加载 JDBC 驱动。
数据库连接器是独立的可执行包类型：它运行在受 Tauri 监管的 Java
sidecar 中，不能贡献 WebView、Workbench command 或任意前端代码。

连接器市场、下载、签名、原子安装、回滚和作者模板的后续设计见：

- `docs/adr/0001-jdbc-sidecar-and-connector-boundary.md`
- `docs/adr/0002-signed-connector-marketplace.md`
- `docs/connectors/connector-package-spec.md`
- `docs/connectors/authoring-guide.md`

两个体系可以在未来共享 catalogue UI，但必须保留各自的安装服务、运行时、
权限和信任策略。安装 JDBC JAR 也不会自动改变 driver runtime status；
SQLite stable、MySQL preview、PostgreSQL planned 仍由 Rust runtime status 表决定。
