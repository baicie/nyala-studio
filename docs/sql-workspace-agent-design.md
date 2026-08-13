# SQL Workspace Agent 设计规格

> 状态：Proposed
>
> 设计基线：`mvp` 分支，`ffb13b98`（2026-08-11）
>
> 本文是 Phase 06 AI Helper 的后续演进设计，不表示 Agent Runtime 已实现，也不改变
> `docs/sql-mvp-phases/README.md` 中任何 Phase 的完成状态或 driver maturity。

## 1. 决策摘要

Nyala Studio 应演进出一个 **SQL Workspace Agent**，而不是增加一个脱离工作区的“SQL 专家聊天框”。

Agent 的核心价值是使用当前工作区中可验证的事实完成闭环：

```text
理解目标
  -> 检索相关 Schema
  -> 生成或修复 SQL
  -> 静态分类与风险检查
  -> 请求必要批准
  -> Explain / 执行
  -> 检查错误、计划或结果
  -> 生成可追溯结论与 SQL artifact
```

采用以下顶层决策：

1. **本地 Rust Runtime**：Agent loop、tool dispatch、policy、approval、budget 和 audit 位于 Tauri Rust 边界；数据库凭据和实际 tool execution 不离开本机。
2. **复用 SQL Core**：Agent 只能通过现有 connection、metadata、query、history 和 explain 能力的受控 adapter 工作，不实现第二套 driver 或连接池。
3. **Workbench 原生入口**：Agent 是 service + contribution，入口分布在 Editor、Result、Schema、Error 和 Agent Panel，不新增 SPA route。
4. **Capability + Policy 双门**：Capability 判断“能否调用”，Policy 判断“本次是否允许”；每次 tool call 都在 Rust 端重新校验，前端禁用状态不是安全边界。
5. **渐进式权限**：现有 Phase 06 的 draft-only 行为保持不变；读执行和写执行分别在后续 Stage 通过新的验收门开放。
6. **单 Agent + 固定 Skills**：第一阶段不做 multi-agent、通用 DAG planner、长期 memory 或 vector database。
7. **证据优先**：Schema、SQL analysis、Explain、database error 和 result sample 都以 typed evidence 进入上下文，模型文本不能伪装成数据库事实。

## 2. 目标与成功定义

目标用户是需要在一个本地 SQL workbench 内完成查询编写、排错、解释和优化的开发者、数据分析者与数据库操作人员。

成功不是“可以聊天”，而是以下四条工作流在真实工作区上下文中可重复完成：

1. 根据自然语言和真实 Schema 生成可审阅 SQL。
2. 根据当前 SQL、结构化数据库错误和相关列定义生成修复 patch。
3. 对只读 SQL 执行静态检查、Explain、运行和结果检查，并给出引用 evidence 的总结。
4. 对慢查询比较原 SQL 与重写 SQL 的 normalized plan；无法证明改善时明确返回“不确定”。

所有成功结果都必须包含可追溯的 `Artifact` 或 `EvidenceRef`，不能只返回模型自然语言。

## 3. 当前仓库基线

本文以当前代码而不是远期示例代码为准。当前具备的能力和缺口如下：

| 领域              | 当前实现                                                                                                                 | 对 Agent 的含义                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Workbench 壳      | `src/vs/workbench/contrib/sql*` contributions + `services/sql*` services                                                 | Agent UI 必须沿用 contribution、command、view/panel、context key 和 disposable 机制 |
| AI facade         | `ISqlAiService.complete()` 做 request validation 后委托 provider；现有 UI action 另走 `ISqlAdvancedService.completeAi()` | 两条 facade 尚未收敛；Agent 不能再引入第三条长期调用链                              |
| AI provider       | `DeterministicSqlAiProvider`，四种 task kind                                                                             | 仅生成 deterministic 文本或 SQL draft，不执行工具，不接云模型                       |
| AI context        | `buildSqlAiContext()` 可接收 dialect、connection、SQL、error、explain、tables/columns                                    | 目前没有相关性检索、Schema Graph、result sampling 或 evidence provenance            |
| AI UX             | Command Palette 输入后打开一个新 Query editor                                                                            | 目前没有 Agent Panel、run timeline、approval 或 streaming tool state                |
| 前端 SQL services | V1/V2 connection service、metadata service、query service、product service                                               | Agent 前端 facade 必须复用这些 contract，不允许 view 直接 `invoke`                  |
| Rust connection   | V1 `SqlConnectionStore` 与 V2 `ConnectionManager` 并存                                                                   | Agent 执行前必须先定义单一 adapter；不能绑定双栈中的任意一套并扩大漂移              |
| Rust driver       | V2 `SqlDriver`/`SqlConnection` 支持 open 与 schema/table/column metadata                                                 | 当前 trait 没有通用 execute、explain、index、foreign-key contract                   |
| SQL analysis      | `sql_lexer.rs` 与现有 read-only guard 做 token/statement 边界处理                                                        | 尚无通用 AST、表/列提取、normalized plan；不得把 lexer 宣称为完整 parser            |
| Explain           | 前端按 dialect 生成 Explain SQL，再走正常 query path                                                                     | 有用户触发的 Explain 基础，没有 Agent tool 或跨方言 normalized plan                 |
| Plugin capability | `SqlStudioPluginCapability` 有声明 token；built-in AI plugin 声明 `agent.tool`                                           | 当前声明不等于统一运行时强制；开放 Agent tool 前必须补齐真正的 guard                |
| Driver maturity   | SQLite Stable、MySQL Preview、PostgreSQL Planned                                                                         | 首个 Agent vertical slice 必须以 SQLite 为验收主线；不能按通用方案先做 PostgreSQL   |
| Phase 08          | P0 已验收；原生连接页 live MySQL Validate 证据于 2026-08-11 完成                                                         | Agent implementation 可按 A0 → A1 顺序继续，不改变 driver maturity                  |

这里有两个需要明确保留的事实：

- Phase 06 的 `AI never auto-execute` 仍然有效。本文只有在后续 Read-only Stage 验收后才允许受控的自动只读工具调用。
- Phase 07 的 capability declaration 是地基，不是已经完成的 security enforcement。Tool Runtime 不能仅相信 manifest 或模型声明。

## 4. 范围

原始构想的能力分层在本设计中的落点如下：

| 能力层                     | 产品含义                                  | 本设计落点                                |
| -------------------------- | ----------------------------------------- | ----------------------------------------- |
| L1 SQL Copilot             | generate/explain/fix/format/convert draft | 现有 Phase 05/06 + A2 Suggest-only        |
| L2 Context-aware Assistant | 使用真实 editor/schema/error context      | A1 Schema Context + A2 evidence envelope  |
| L3 SQL Agent               | 自主调用受控工具并验证只读结果            | A3 Read-only + A4 Workbench + A5 Optimize |
| L4 Database Agent          | write/DDL/migration/health 等数据库级任务 | A6-A8；不属于首个 milestone               |

### 4.1 第一条产品主线

第一条可交付主线使用 SQLite Stable，能力包括：

- 当前连接、database/schema、active editor、selection/current statement；
- 相关表和列检索；
- SQL draft、解释、修复；
- statement classification 与 risk result；
- 只读 Explain 和只读执行；
- 结构化错误与受限 result sample；
- Editor、Error、Schema、Result 和 Agent Panel 入口；
- run cancellation、budget、audit 与 evidence 引用。

MySQL Preview 在相同 contract 下做兼容验证，但不因 Agent 能力升级为 Stable。PostgreSQL 在 runtime status 升级前只允许 dialect-level draft，不允许 database tool。

### 4.2 非目标

以下内容不属于第一版：

- 写操作、DDL、migration 执行和 transaction guard；
- multi-agent、subagent、并行 worker；
- 通用 LLM planner 或任意 DAG；
- vector database、embedding schema index；
- 跨会话长期 memory；
- MCP server/client；
- 任意 remote plugin tool；
- 全量 result 上传；
- 自动创建索引或自动修改 schema；
- 新增 PostgreSQL、ClickHouse、SQL Server 等 runtime driver；
- 抽取通用 Agentic Harness crate。

这些能力可以进入后续 Stage，但不能被第一版接口暗中放开。

## 5. 架构

```text
Workbench Webview
  SQL Editor / Schema / Result / Error / Agent Panel
                    |
                    v
            ISqlAgentService
      (validation, events, cancellation)
                    |
                 Tauri IPC
                    |
                    v
Rust SQL Agent Runtime
  Run Store -> Context Engine -> Skill/Loop -> Model Gateway
       |              |              |
       |              +-------+------+
       |                      v
       +--------------> Policy Engine
                              |
                              v
                         Tool Runtime
                              |
             +----------------+----------------+
             v                v                v
       SQL Analysis      SQL Core Adapter    Evidence Store
                         (existing drivers)
                              |
                SQLite / MySQL / future drivers
```

### 5.1 进程职责

Workbench 负责：

- 捕获用户意图和当前 UI context reference；
- 展示 run、turn、tool、approval、artifact 和 error state；
- 把 SQL patch 应用到 editor；
- 通过 `ISqlAgentService` 订阅 Rust event；
- dispose 所有 event listener、stream、timer 和 view resource。

Rust Runtime 负责：

- run 生命周期和 finite-state transition；
- context retrieval、redaction、size budget；
- model request/response 与 tool-call schema validation；
- capability、risk、approval、driver maturity 和 connection mode 检查；
- 本地 tool execution；
- evidence/artifact/audit 记录；
- timeout、turn/tool/token budget 和 cancellation。

模型负责推理和提出结构化 tool call。模型不持有凭据、不直接访问 driver、不决定最终权限。

### 5.2 与现有 AI Helper 的迁移关系

不能同时长期维护 “TypeScript AI loop” 和 “Rust Agent loop”。迁移顺序为：

1. 保留现有 `ISqlAiService`、`ISqlAdvancedService.completeAi()` 和 deterministic provider，先用 characterization tests 固定 Phase 06 行为。
2. 引入独立 `ISqlAgentService`，最初只支持 Suggest-only run。
3. 将现有四类 AI action 映射成一个 turn 的固定 skill，并保持输出仍然只进 editor。
4. 行为与测试等价后，`ISqlAiService` 与 `ISqlAdvancedService.completeAi()` 都变成兼容 facade，内部委托 `ISqlAgentService`。
5. 删除旧 provider 只能单独计划，不能与首次 Agent vertical slice 同时完成。

### 5.3 与现有数据库层的关系

Agent 不直接依赖 `rusqlite`、`mysql` crate 或具体 pool。Tool Runtime 只依赖 `SqlCoreAdapter`：

```rust
pub trait SqlCoreAdapter: Send + Sync {
    fn runtime_capabilities(
        &self,
        connection_id: &str,
    ) -> Result<SqlRuntimeCapabilities, SqlCommandError>;

    fn list_schema_context(
        &self,
        request: SchemaContextRequest,
    ) -> Result<SchemaContextResult, SqlCommandError>;

    fn explain_readonly(
        &self,
        request: ExplainReadonlyRequest,
    ) -> Result<ExplainEvidence, SqlCommandError>;

    fn execute_readonly(
        &self,
        request: ExecuteReadonlyRequest,
    ) -> Result<QueryEvidence, SqlCommandError>;
}
```

这是对现有 SQL Core 的 adapter，不是新 driver abstraction。实现前必须解决 V1 query path 与 V2 metadata path 的所有权：

- 推荐先让 adapter 在单点组合现有 V1/V2 能力，并记录兼容层；
- 不允许 UI 或 Agent 分别猜测哪个 profile/connection id 属于哪套 store；
- 当所有 query consumer 迁到 V2 后，再把 execute/explain/index/FK 能力下沉到 `SqlConnection` trait；
- 不能为了 Agent 一次性删除 V1，也不能为 Agent 再创建 V3 connection manager。

### 5.4 模块位置

第一轮保持在现有 ownership boundary 内，不立即创建多个 crate：

```text
src/vs/workbench/services/sql/common/sqlAgent.ts
src/vs/workbench/services/sql/browser/sqlAgentService.ts
src/vs/workbench/contrib/sqlAgent/common/
src/vs/workbench/contrib/sqlAgent/browser/
src/vs/workbench/contrib/sqlAgent/test/

src-tauri/src/commands/sql/agent/
  mod.rs
  domain.rs
  runtime.rs
  context.rs
  policy.rs
  tools.rs
  model.rs
  evidence.rs
```

当 SQL analysis 已被 editor diagnostics、read-only guard 和 Agent 三个稳定 consumer 复用，并且 API 经过 Stage A0/A1 验证后，才评估抽取 `crates/sql-intelligence`。通用 `agent-runtime` crate 需要第二个真实产品 consumer 后再决定。

## 6. Agent Domain

第一版只需要这些核心对象：

| 对象         | 作用                                                  | 持久化策略                                    |
| ------------ | ----------------------------------------------------- | --------------------------------------------- |
| `Run`        | 一个用户目标的生命周期、mode、budget 和状态           | 默认仅内存；可持久化 redacted summary         |
| `Turn`       | 一次 model input/output                               | 默认仅内存                                    |
| `Task`       | 固定 skill 中的逻辑步骤                               | 与 Run 一起保存状态                           |
| `ToolCall`   | 经过 schema validation 的工具请求                     | audit 保存参数摘要，不保存 secret/result body |
| `ContextRef` | 指向 editor、connection、schema、error、result 的引用 | 保存稳定 id 和版本，不复制敏感内容            |
| `Evidence`   | Tool 产生的结构化事实                                 | 按敏感级别和 TTL 保存                         |
| `Artifact`   | SQL draft、patch、plan comparison、answer             | 可由用户显式保存                              |
| `Approval`   | 用户对某个 call hash 的决定                           | 保存 decision、scope、time；不做永久宽泛授权  |

最小 wire shape：

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolCall {
    pub run_id: String,
    pub call_id: String,
    pub tool: String,
    pub arguments: serde_json::Value,
    pub context_refs: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolResult {
    pub call_id: String,
    pub outcome: AgentToolOutcome,
    pub evidence_refs: Vec<String>,
    pub warnings: Vec<String>,
}
```

所有 Tauri command 继续返回 `Result<StructuredType, SqlCommandError>`。模型输出 JSON 解析失败、未知 tool、参数超限和非法状态迁移都必须是结构化错误，不能 panic。

### 6.1 Run 状态机

```text
Created -> BuildingContext -> Reasoning -> AwaitingTool
   -> AwaitingApproval -> ExecutingTool -> Reasoning -> Completed
                                      \-> Failed
任意非终态 --------------------------------------------> Cancelled
```

状态转换由 Rust Runtime 单点控制。Workbench event 只是 projection，不能通过 UI event 直接改变安全状态。

### 6.2 Budget

每个 run 必须有：

- 最大 model turns；
- 最大 tool calls；
- 最大 schema objects；
- 最大 result rows/bytes；
- 最大 wall-clock duration；
- provider 支持时的 token/cost ceiling；
- cancellation token。

任何 budget 到达上限都返回带已收集 evidence 的部分结果，不能静默继续。

## 7. Context Engine

### 7.1 Workspace context

Workbench 只发送当前状态的引用和必要快照：

```ts
export interface SqlWorkspaceContextRef {
	readonly connectionId?: string;
	readonly database?: string;
	readonly schema?: string;
	readonly editorResource?: string;
	readonly editorVersion?: number;
	readonly selectedSql?: string;
	readonly cursorOffset?: number;
	readonly activeTable?: { schema?: string; name: string };
	readonly lastQueryId?: string;
	readonly lastErrorId?: string;
	readonly lastResultId?: string;
}
```

提交 SQL patch 前必须比较 `editorVersion`。版本已变化时展示 diff/preview，不得覆盖用户的新编辑。

### 7.2 Schema retrieval

不能把整个 database schema 放进 prompt。第一版 retrieval 使用：

1. 当前 active table / selection 中显式引用的表；
2. table、column、comment 的 normalized token/fuzzy match；
3. 外键关系的一到两跳扩展；
4. 稳定排序与 object/byte budget；
5. 每个对象附来源 connection/schema 和 metadata version。

第一版不需要 embedding。没有 comment、index、FK 的 driver 必须通过 capability 返回 `unsupported`，不能用空数组伪装“数据库中不存在”。

### 7.3 Schema Graph

Schema Graph 是 per-connection cache：table/view 是 node，foreign key 是 directed edge。缓存 key 至少包含 connection id、database/schema 和 metadata revision。连接关闭、DDL 成功或用户 refresh 时失效。

如果当前 driver 没有 FK metadata，relation search 只能基于显式 join SQL 提供低置信候选，并标明 evidence kind，不能声明真实外键。

### 7.4 Result data policy

默认模型上下文只允许：

- column name/type；
- row count、affected rows、elapsed、truncated；
- database error；
- Explain summary；
- 本地计算得到的 aggregate summary。

`result.sample` 需要用户把 Data Access 从 `Shape only` 提升到 `Sampled rows`。sample 有固定 row/byte cap，进入 model gateway 前再次 redaction。第一版不提供 `Full result` 模式。

## 8. SQL Intelligence

SQL Intelligence 和 database validation 是两层：

```text
SQL text
  -> statement split / parse / classify / extract / risk
  -> driver-specific Explain or prepare-style validation
  -> structured database evidence
```

静态层至少输出：

```rust
pub struct SqlAnalysis {
    pub dialect: SqlDialectId,
    pub statement_count: usize,
    pub statement_class: StatementClass,
    pub risk: StatementRisk,
    pub referenced_tables: Vec<TableRef>,
    pub warnings: Vec<SqlAnalysisWarning>,
}
```

Risk 枚举：

```rust
pub enum StatementRisk {
    Metadata,
    ReadOnly,
    ExplainReadOnly,
    TransactionalWrite,
    Ddl,
    Destructive,
    Forbidden,
    Unknown,
}
```

规则：

- 多 statement 默认拒绝 Agent 执行；
- parse/classify 失败时是 `Unknown`，按最高风险处理；
- `EXPLAIN ANALYZE` 可能实际执行语句，不等同普通 Explain；
- CTE、PRAGMA、ATTACH/DETACH、VACUUM 和 dialect extension 必须有显式测试；
- `ReadOnly` / `ExplainReadOnly` 只是静态语法风险，不是执行授权；A3 仍需 database-enforced read-only permission/transaction；
- 静态 parser 通过不代表 SQL 对真实 database 有效；
- database error 不能把含 credential 的连接串写入 detail。

当前 Cargo 未引入 `sqlparser`。是否增加 parser dependency 必须先做 dialect corpus spike，比较现有 lexer、候选 crate 的覆盖、二进制体积、Rust 版本和维护状态；本文不预先批准依赖。

## 9. Tool Runtime

Tool 是固定 allowlist，不允许模型构造任意 Tauri command 名称。

| Tool                   | 首次开放 Stage          | Capability                                              | 主要输出                            |
| ---------------------- | ----------------------- | ------------------------------------------------------- | ----------------------------------- |
| `workspace.current`    | A1                      | `workspace.readSql`                                     | sanitized workspace context         |
| `schema.search`        | A1                      | `database.readMetadata`                                 | ranked schema refs                  |
| `table.describe`       | A1                      | `database.readMetadata`                                 | columns + supported metadata        |
| `relation.search`      | A1                      | `database.readMetadata`                                 | FK/path evidence 或 unsupported     |
| `index.list`           | A1/A5                   | `database.readMetadata`                                 | index evidence 或 unsupported       |
| `sql.parse`            | A0                      | `agent.tool`                                            | `SqlAnalysis`                       |
| `sql.validate`         | A2 static / A3 database | `agent.tool`；database path 还需 `database.executeRead` | static/database validation evidence |
| `sql.explain`          | A3                      | `database.explain`                                      | raw ref + normalized plan           |
| `sql.execute_readonly` | A3                      | `database.executeRead`                                  | shape + bounded local result ref    |
| `result.inspect`       | A3                      | `database.readResultShape`                              | shape/aggregate evidence            |
| `result.sample`        | A3                      | `database.readResultSample`                             | redacted bounded rows               |
| `history.search`       | A4                      | `history.read`                                          | redacted query history refs         |

每个 tool 定义必须包含：

- JSON input/output schema；
- required capabilities；
- supported driver/dialect matrix；
- timeout、row/byte cap；
- sensitivity classification；
- cache/invalidating policy；
- deterministic fake implementation；
- 至少一个 allow test 和一个 deny/error test。

## 10. Capability、Policy 与 Approval

### 10.1 单一 capability schema

当前 `SqlStudioPluginCapability` 已有：

```text
database.readMetadata
database.executeRead
database.executeWrite
filesystem.read
filesystem.write
network.request
agent.tool
```

Agent 引入前，在 `src/vs/workbench/services/sql/common/` 建立唯一 canonical schema，并让 plugin API re-export 或映射它。新增最小 token：

```text
workspace.readSql
database.readResultShape
database.readResultSample
database.explain
history.read
```

不要为 AI、plugin、Agent、MCP 各建一份字符串 union。`ConnectionSecret` 不进入 capability schema，因为任何 Agent/plugin/model 都不应获得 secret object；连接只能通过 opaque connection id 使用本地 driver。

### 10.2 Agent mode

| Mode                         | 自动允许                                        | 需要批准                          | 禁止                       |
| ---------------------------- | ----------------------------------------------- | --------------------------------- | -------------------------- |
| `Suggest Only`               | context、metadata、static analysis              | 无                                | Explain、query、write、DDL |
| `Read Only`                  | 上述 + 已验证的单 statement SELECT/安全 Explain | result sample access              | write、DDL、destructive    |
| `Allow Writes With Approval` | Read Only 能力                                  | 每个 transactional write/DDL call | forbidden class            |

默认 mode 在 A0-A2 为 `Suggest Only`。A3 验收后可由用户显式切换为 `Read Only`。`Full Access` 不属于本文范围；加入它需要独立安全设计。

### 10.3 Policy 顺序

每个 call 的检查顺序固定：

```text
tool allowlist
  -> input schema / size
  -> provider and plugin capability
  -> runtime driver maturity/capabilities
  -> connection/read-only state
  -> SQL parse + statement count + risk
  -> data access policy
  -> approval binding (if required)
  -> budget / cancellation
  -> execute
```

Approval 必须绑定 `run_id + call_id + tool + normalized argument hash + connection id`。SQL 或 connection 改变后旧批准失效。

### 10.4 写能力的后续门

Stage A6 才讨论 write，且至少需要：

- SQL preview 和影响范围说明；
- 明确目标 connection/database/schema；
- per-call 用户批准；
- driver-specific transaction support matrix；
- commit/rollback 二次选择；
- audit；
- destructive 强确认；
- `DROP DATABASE`、credential/permission mutation 等默认 forbidden。

在这些条件满足前，`database.executeWrite` 对 Agent 永远不授予。

## 11. Agent Loop 与 Skills

Runtime loop 保持简单：

```rust
loop {
    budget.check()?;
    let context = context_engine.build(&run)?;
    let response = model_gateway.generate(&run, context).await?;

    match response {
        ModelResponse::Final(answer) => return complete(run, answer),
        ModelResponse::ToolCall(call) => {
            let checked = policy.authorize(&run, call)?;
            let result = tools.execute(checked).await?;
            evidence.append(result)?;
        }
    }
}
```

常见任务使用固定 skill，不让 LLM 发明计划：

```text
generate-sql:    retrieve schema -> draft -> analyze -> validate -> present
fix-sql:         normalize error -> retrieve schema -> patch -> analyze -> present diff
explain-sql:     analyze -> retrieve schema -> explain text with evidence
optimize-query:  analyze -> index context -> explain old -> rewrite -> explain new -> compare
explore-data:    retrieve schema -> draft -> validate -> read execute -> inspect -> answer
```

Skill descriptor 可以先是 Rust/TS typed registry。引入 YAML、动态 skill loader 或 plugin-provided executable steps 需要单独的 trust model。

## 12. Model Gateway 与隐私

### 12.1 Provider 边界

Model Gateway 支持同一 request/stream contract 下的 deterministic、local 和 cloud provider。当前只启用 deterministic provider。BYO cloud key、Ollama 或其他 provider 必须分别通过配置、secret storage、network allowlist 和 privacy review。

Provider 看到的是 `ModelContextEnvelope`，永远不是 `ConnectionSecret`、driver handle 或 raw connection URL。

### 12.2 数据分级

| 数据                         | 默认是否可送模型               | 说明                                     |
| ---------------------------- | ------------------------------ | ---------------------------------------- |
| dialect/runtime capability   | 是                             | 不含 host/user                           |
| safe connection display name | 本地 provider 是；cloud 默认否 | 用户可显式开启                           |
| schema/table/column 名       | 是                             | 按相关性和预算裁剪                       |
| SQL text                     | 当前 action 明示时             | UI 必须显示将发送的范围                  |
| database error               | redaction 后                   | 去除 credential、host、URL 等敏感 detail |
| Explain summary              | 是                             | raw plan 先本地 normalize/裁剪           |
| result shape                 | 是                             | 不含 row body                            |
| sampled rows                 | 默认否                         | 单次批准 + cap + redaction               |
| full result                  | 否                             | 第一版没有此模式                         |
| password/token/private key   | 永远否                         | 不得进入 context、log、audit、telemetry  |

不新增 telemetry。Model request debug log 默认只记录 provider id、size、latency、outcome 和 redaction counts。

## 13. Workbench UX

Agent Panel 用于复杂 run 和 evidence timeline，但不是唯一入口：

- Editor：`Generate with Agent`、`Explain`、`Fix`、`Optimize`，输出 patch/diff；
- Error：结构化错误旁显示 `Fix with Agent`；
- Schema：table context menu 提供 `Describe`、`Generate Query`、`Find Relations`；
- Result：`Summarize Shape`，sample 能力需要显式批准；
- Explain：展示 raw/normalized plan 与 before/after comparison；
- Agent Panel：展示 goal、current step、tool status、approval、evidence、artifact、cancel/retry。

UI 规则：

- destructive 或 permission action 使用明确 command button，不隐藏在聊天文本里；
- SQL draft 默认进入 diff/preview，不直接替换 editor；
- tool running、waiting approval、cancelled、partial、failed、completed 都是稳定状态；
- 未支持的 driver/tool 显示 capability 原因，不显示空成功；
- model 文本与 verified evidence 有视觉区分；
- panel 关闭不自动取消 run，但必须 dispose UI subscriptions；run cancellation 是显式 command。

## 14. 演进 Stage

这里使用 `A0-A8`，避免与现有 SQL MVP Phase 00-08 混淆。

| Stage                    | 交付                                                  | 进入条件                        | 完成证据                                            |
| ------------------------ | ----------------------------------------------------- | ------------------------------- | --------------------------------------------------- |
| A0 SQL Intelligence      | split/parse/classify/risk/extract contract            | Phase 08 收口或用户明确调整顺序 | dialect corpus + dangerous SQL deny tests           |
| A1 Schema Context        | cache/search/graph/context budget                     | A0 typed refs 稳定              | 相关表召回、失效、unsupported tests                 |
| A2 Suggest-only Runtime  | Run/Turn/Tool/Evidence、deterministic gateway、stream | A1 + canonical capability guard | 四类现有 AI action 行为等价且零 query call          |
| A3 Read-only Agent       | explain/read execute/result inspect                   | A2 policy/audit/cancel 稳定     | SQLite 真实闭环 + deny writes/multi-statement       |
| A4 Workbench Integration | Editor/Error/Schema/Result/Panel                      | A3 service contract 稳定        | browser QA + disposables + accessibility tests      |
| A5 Query Optimization    | index metadata、plan normalize、before/after          | A3 + dialect adapters           | plan fixture tests + SQLite/MySQL opt-in comparison |
| A6 Write Agent           | approval、transaction guard、impact preview           | 独立 security design accepted   | rollback/commit/destructive deny integration tests  |
| A7 Skills                | typed reusable skill registry                         | 三个以上稳定 workflow           | skill conformance + capability tests                |
| A8 Advanced              | long-running tasks/history analysis/optional workers  | 单 Agent 已有量化瓶颈           | 独立规格，不由本文预先批准                          |

第一版产品里程碑是 A0-A4。A5 是差异化能力，但不阻塞 Read-only Agent 发布。A6-A8 不属于首个 milestone。

## 15. 第一版用户故事与验收

### Story 1：Schema-aware Generate

用户在 Demo SQLite 连接中输入“查询最近 30 天消费金额最高的 10 个用户”。

验收：

- run 只检索相关的 `users`/`orders` 和关系；
- SQL 使用真实列，不凭空增加列；
- `sql.parse` 返回单条 ReadOnly；
- Suggest-only 下只展示 SQL diff；
- Read-only 下执行仍需用户已显式启用该 mode；
- answer 引用 schema 与 query evidence。

### Story 2：Fix Error

用户执行包含不存在列的 SQL 后点击 `Fix with Agent`。

验收：

- 使用当前 editor version、原 SQL、structured error 和真实 columns；
- 返回 patch 与解释；
- editor 已变化时不覆盖，改为展示 stale-context diff；
- 修复稿不自动执行。

### Story 3：Read-only Explore

用户要求“按天汇总最近 7 天订单”。

验收：

- Tool Runtime 拒绝多 statement 和任何 mutation；
- query row/byte/time budget 生效；
- 默认只给模型 result shape/aggregate；
- run 可取消；
- 最终答案标明 truncated/partial 状态。

### Story 4：Optimize

用户对一条慢 SELECT 运行 `Optimize`。

验收：

- 记录 original SQL analysis、index metadata capability、old plan；
- rewrite 再次 parse/classify；
- new plan 通过同一 adapter 获取；
- comparison 不把不可比的 cost 当成性能证明；
- 缺 index/plan capability 时降级为建议并明确不确定性。

## 16. 实施任务切片

每个任务应控制在约 5 个文件内，并按依赖顺序实施：

- [x] A0.1：固化 `SqlAnalysis`、`StatementRisk` 和 dialect corpus。
  - Acceptance：现有 read-only 测试全部迁入 corpus，Unknown fail-closed。
  - Verify：focused Rust tests + `pnpm run test:rust`。
  - Files：`sql_lexer.rs`、新 analysis module/test、`mod.rs`。
  - Record：[`A0 Implementation Plan`](./sql-workspace-agent-a0-implementation-plan.md)（2026-08-11 完成）。
- [x] A0.2：完成 parser dependency spike/ADR；不通过则继续增强本地 parser。
  - Record：[`ADR 0003`](./adr/0003-sql-agent-parser-boundary.md)（2026-08-12，No-Go；malformed fail-closed 已补）。
  - Acceptance：覆盖率、体积、license、Rust 版本、dialect gaps 有数据。
  - Verify：fixture command 与 `cargo tree` 记录。
  - Files：ADR/spike doc；只有批准后才改 Cargo files。
- [x] A1.1：定义 metadata capability 与 `SqlCoreAdapter`，封装 V1/V2 id mapping。
  - Acceptance：Agent caller 看不到 store 版本。
  - Verify：SQLite adapter tests + MySQL unsupported/preview tests。
  - Plan：[`A1.1 Implementation Plan`](./sql-workspace-agent-a1-1-implementation-plan.md)。
  - Record：`e808fbef`、`08e4fc81`、`2007400a`（2026-08-11 完成；25 个 focused tests + 全量回归）。
- [x] A1.2：实现 bounded schema search/cache，之后再加 FK graph。
  - Record：[`Agent foundation verification`](./sql-mvp-phases/phase-a0-a1-foundation-verification.md)（2026-08-12）。
  - Acceptance：稳定排序、TTL/invalidation、object/byte cap 可测。
  - Verify：pure Rust tests。
- [x] A2.1：实现 domain、state machine、budget、evidence store。
  - Record：[`A2.1 Runtime Domain Verification`](./sql-mvp-phases/phase-a2-1-runtime-domain-verification.md)（2026-08-12 完成；47 个 agent focused tests）。
  - Acceptance：非法 transition、timeout、cancel、redaction 均有 tests。
  - Verify：`cargo test --lib agent`。
- [x] A2.2：统一 capability schema 并在 Rust policy 强制执行。
  - Record：[`A2.2 Capability Policy Verification`](./sql-mvp-phases/phase-a2-2-capability-policy-verification.md)（2026-08-12 完成；52 个 Rust agent tests + 2 个 canonical capability tests）。
  - Acceptance：manifest/model 不能绕过 tool capability。
  - Verify：allow/deny table tests + frontend type tests。
- [x] A2.3：实现 deterministic Model Gateway 与 Suggest-only loop。
  - Record：[`A2.3 Suggest-only Loop Verification`](./sql-mvp-phases/phase-a2-3-suggest-only-loop-verification.md)（2026-08-12 完成；62 个 Rust agent tests）。
  - Acceptance：未知 tool/坏 JSON/超预算是 structured error，零 query call。
  - Verify：scripted model integration tests。
- [x] A2.4：增加 `ISqlAgentService` 与 Tauri command/event bridge。
  - Record：[`A2.4 Service Bridge Verification`](./sql-mvp-phases/phase-a2-4-service-bridge-verification.md)（2026-08-12）。
  - Acceptance：view 不直接 invoke；stream/cancel listener 可 dispose。
  - Verify：`test:sql-services` + `test:sql-agent` + Rust checks。
  - Acceptance：view 不直接 invoke；stream/cancel listener 可 dispose。
  - Verify：`test:sql-services` + Rust command tests。
- [x] A3.1：增加 read-only explain/execute tools。
  - Record：[`A3.1 Read-only Tools Verification`](./sql-mvp-phases/phase-a3-1-read-only-tools-verification.md)（2026-08-12）。
  - Files：`agent/read_only.rs`、`agent/policy.rs`、`state.rs`、Workbench Agent service contract。
  - Acceptance：SQLite SELECT 成功，write/multi-statement/unknown 全拒绝。
  - Verify：Rust Agent integration + `test:sql-services` + `test:sql-domain`。
- [x] A3.2：实现 result shape/aggregate/sample policy。
  - Record：[`A3.2 Result Policy Verification`](./sql-mvp-phases/phase-a3-2-result-policy-verification.md)（2026-08-12）。
  - Acceptance：默认不外发 rows，sample cap/redaction/approval 可测。
  - Verify：policy tests + fake model envelope snapshot + scripted ReadOnly loop。
- [x] A4.1：先接 Editor/Error actions 和 diff artifact。
  - Record：[`A4 Workbench Verification`](./sql-mvp-phases/phase-a4-workbench-verification.md)（2026-08-12，browser QA pending）。
  - Acceptance：stale editor 不覆盖、已有 Phase 06 commands 不回归。
  - Verify：artifact tests + `test:sql-editor` + `test:sql-advanced`。
- [x] A4.2：最后接 Agent Panel、Schema/Result/Fix actions。
  - Record：[`A4 Workbench Verification`](./sql-mvp-phases/phase-a4-workbench-verification.md)（2026-08-13；actions、Panel 与 Chromium automation 已完成）。
  - Acceptance：全状态可见、键盘可达、dispose/cancel 行为清晰。
  - Verify：contribution tests + Playwright desktop/narrow viewport screenshots。
- [ ] Checkpoint W：完成 macOS 原生 viewport/键盘、Windows WebView2 与真实 VoiceOver/Narrator 走查。

## 17. Code Style

沿用 VS Code service/contribution 与 Rust structured error 风格。前端不直接调用 Tauri：

```ts
export class SqlAgentService implements ISqlAgentService {
	constructor(private readonly executor: ISqlCommandExecutor = new TauriSqlCommandExecutor()) {}

	start(request: SqlAgentStartRequest): Promise<SqlAgentRun> {
		return this.executor.execute('sql_agent_start', { request });
	}
}
```

Rust command 不接收 secret、不 panic、返回结构化错误：

```rust
#[tauri::command]
pub async fn sql_agent_start(
    state: tauri::State<'_, AgentRuntimeState>,
    request: SqlAgentStartRequest,
) -> Result<SqlAgentRun, SqlCommandError> {
    state.start(request).await.map_err(SqlCommandError::from)
}
```

复杂 listener、stream、timer 和 model 必须通过 `_register(...)` 或明确的 `IDisposable` 生命周期管理。

## 18. 测试策略与命令

### 18.1 测试层级

- Rust domain unit：state、budget、risk、policy、redaction、schema ranking、plan normalization；
- Rust command/integration：SQLite real DB、structured errors、cancel、driver capability、no-secret serialization；
- TypeScript service unit：wire validation、event projection、stale editor guard、disposal；
- Contribution tests：commands、context keys、menus、artifact apply；
- Scripted model tests：固定 tool-call sequence，不依赖外部模型；
- Browser QA：Panel、approval、diff、responsive、keyboard；
- MySQL live：仅 opt-in，保持 Preview，不计入默认 deterministic gate。

每个 Rust Agent command 至少覆盖 success、invalid input、policy deny、cancellation；涉及 SQL 的 command 还要覆盖 multi-statement 和 read-only mutation deny。

### 18.2 实施期命令

```bash
pnpm run test:sql-services
pnpm run test:sql-domain
pnpm run test:sql-editor
pnpm run test:sql-result
pnpm run test:sql-advanced
pnpm run test:rust
pnpm run lint
pnpm run build
pnpm run rust:check
pnpm run rust:clippy
pnpm run rust:fmt
pnpm run test
```

增加 Agent suite 时应新增 granular script（例如 `test:sql-agent`），再纳入 `pnpm run test`，不能只依赖全量 suite。

## 19. 边界

### Always

- 复用 workbench service/contribution 与 SQL driver/runtime status。
- 默认 fail closed；Unknown 等同高风险。
- 每个 tool call 在 Rust 端重新授权。
- Secret 与 result body 默认留在本机。
- 用 typed evidence 区分数据库事实和模型推断。
- 报告准确 command 与 exit status。

### Requires explicit review

- 增加 parser/model/network dependency；
- 增加 cloud provider 或 API key storage；
- 修改 Tauri capability、filesystem/network scope；
- 抽取新 workspace crate；
- 开放 result sample；
- 开放任何 write/DDL；
- plugin-provided tool/skill；
- 删除 V1 connection/query stack；
- 把 Agent 能力扩展到 Preview/Planned driver 的新 runtime surface。

### Never

- 在 view 中直接 `invoke`；
- 给模型、plugin 或 Agent 暴露 credential；
- 让模型构造任意 command/tool 名；
- 把 SQL draft 当已验证 SQL；
- 把空 metadata 当“数据库中不存在”；
- 默认上传 query rows；
- 用 UI confirmation 代替 backend policy；
- 因 Agent 引入第二套 database driver/connection manager；
- 在首版引入 multi-agent 或通用 planner。

## 20. 风险与缓解

| 风险                                          | 缓解                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| V1/V2 双栈让 Agent 读写不同连接               | 单一 `SqlCoreAdapter` + profile/id mapping contract + integration tests                 |
| 文档中的 capability 比代码 enforcement 更超前 | A2 前置 canonical schema 与 Rust guard；未完成前只有 Suggest-only                       |
| parser 对 dialect extension 误判              | Unknown fail-closed + dialect corpus + database validation；parser 不作为唯一正确性证明 |
| `EXPLAIN ANALYZE` 执行 mutation               | Explain tool 解析 inner statement，第一版拒绝 ANALYZE 和非 ReadOnly                     |
| prompt 注入诱导越权 tool                      | Tool allowlist、typed args、每 call backend policy；模型文本无 authority                |
| schema/result 泄露                            | retrieval budget、data classification、redaction、sample 单次批准、no telemetry         |
| 慢/失控 loop                                  | turn/tool/time/token budget + cancellation + partial result                             |
| 模型声称优化但 plan 不支持                    | evidence-bound comparison；不可比时返回 uncertain                                       |
| Preview driver 行为被误当 Stable              | 每 call 检查 runtime capability；文案与 status 不升级                                   |
| 通用 crate 过早固化错误 abstraction           | 先在 SQL ownership boundary 内完成两个 Stage，再按真实复用点抽取                        |

## 21. 开放问题

这些问题不阻塞本文落档，但必须在对应 Stage 前决策：

1. SQL parser spike 是否足以支持 SQLite/MySQL corpus，还是需要继续本地 parser？
2. V1/V2 query/metadata 统一采用临时 adapter 还是先完成 V2 execute contract？
3. Agent run 仅内存，还是允许持久化 redacted transcript？默认建议仅内存。
4. Read-only mode 是 workspace setting、connection setting，还是每 run 设置？默认建议每 run 继承 connection read-only 并允许更严格，不能放宽 connection policy。
5. Cloud model 的 API key 放在哪个 native secret store？在该设计获批前不启用 cloud provider。
6. Result sample 的 PII redaction 是规则式、column annotation，还是完全由用户选择？第一版建议规则式 + 单次批准。
7. MySQL Preview 是否支持 Agent read-only execution，要由现有 MySQL query/cancel contract 的真实验证决定，不能由 provider 能力推断。

## 22. 规格完成标准

本文进入 `Accepted` 前需要人工确认：

- 产品定位是单一 SQL Workspace Agent，而非多角色 Agent/聊天插件；
- Runtime 属于本地 Rust，Workbench 只负责 service/contribution UX；
- 首个 vertical slice 是 SQLite + Suggest-only，随后才开放 Read-only；
- Phase 06 draft-only 行为有清晰迁移路径；
- Agent 不复制 driver，V1/V2 通过一个 adapter 隔离；
- capability、policy、approval、data access、budget 和 evidence 均有 backend enforcement 设计；
- A0-A4 每个 Stage 有可执行任务与可验证 acceptance；
- A6 write 和 A8 advanced 保持在首版范围之外；
- Phase 08 状态和 SQLite/MySQL/PostgreSQL maturity 没有被本文改变。

本次用户已明确授权 A0.1 与 A1.1 作为顺序例外，并分别按独立 implementation plan 完成。A0.2、A1.2、A2.1-A2.4 与 A3.1-A3.2 已按独立 spike/implementation record 完成；A4 仍保持未实现，后续继续按 Stage 拆分，不能把 A0-A4 合并成一个大 PR。
