# Nyala Studio 路线图进度审查

审查日期：2026-06-20  
审查基线：`docs/roadmap.md`、根目录 `AGENTS.md`、当前源码与自动化测试

## 结论

项目已经完成 SQL MVP 主要模块的代码骨架，但尚未达到可发布的 MVP Definition of Done。

- SQLite 核心闭环已经实现，并有较完整的 Rust 与 TypeScript 单元测试。
- Workbench SQL Services、Connections、Editor、Results、History、Product 和 Advanced contribution 均已接入。
- MySQL Preview 已有运行时代码，但缺少真实 MySQL 环境的集成验收。
- Formatter、Explain、Snippets、Workspace、Plugin API 和 deterministic AI provider 已有基础实现，部分交互仍属于演示级。
- 缺少桌面端端到端冒烟测试，不能仅凭模型单测宣称用户闭环完成。

## 初始发现

### 1. 品牌收口不完整

Tauri 配置已经使用 SQL Studio 品牌，但 Web 启动入口仍暴露 SideX：

- `index.html` 的页面标题与 `_VSCODE_PRODUCT_JSON`
- `src/main.ts` 的窗口指示器、产品配置、错误页面和运行日志
- branding 验证脚本没有覆盖这两个启动文件

这使“应用启动后不显示 SideX”无法通过。

### 2. SQL Editor 测试入口漏项

`src/vs/workbench/contrib/sqlEditor/test/sqlEditor.test.ts` 没有包含在 `test:sql-editor` 中。单独运行该文件时，`SqlEditorInput copy creates a new independent query input` 失败，因为 `copy()` 复用了原 query ID。

### 3. MySQL Preview 缺少真实集成验收

当前测试覆盖驱动配置、SQL 方言和 MySQL 值转换，但没有连接真实 MySQL 验证：

- test connection
- list databases / tables / columns
- `SELECT 1`

### 4. Snippet UI 只插入 SELECT

模型中已有 SELECT、COUNT、INSERT、UPDATE、EXPLAIN 五种内置 snippet，但命令固定选择 `builtin.select.all`，用户无法选择其他 snippet。

### 5. AI 命令使用硬编码上下文

AI action 固定使用 SQLite、`users` schema 和固定提示词，没有读取当前 SQL Editor 内容或用户请求。Provider 抽象存在，但用户交互尚未形成有效闭环。

### 6. 路线图状态失真

`docs/roadmap.md` 的验收项仍全部未勾选，且该文件在审查时未被 Git 跟踪。多个 `docs/mvp/roadmap*.md` 更像历史实施方案，而不是当前状态台账。

## 阶段判断

| 阶段 | 审查状态 |
| --- | --- |
| 产品 Branding | 部分完成 |
| Rust SQL Commands | 基本完成 |
| Workbench SQL Services | 完成 |
| Connections View | 基本完成 |
| SQL Editor | 基本完成，有测试缺陷 |
| Result Panel | 模型与 UI 已实现 |
| History / Persistence | 基本完成 |
| Product Bootstrap | 已实现，缺少真实 UI 冒烟 |
| MySQL Preview | 已实现，未做真实集成验收 |
| Advanced 能力 | 地基完成，产品交互部分完成 |

## 审查时验证结果

- 已注册 TypeScript SQL 测试：272 通过。
- Rust lib：78 通过。
- `cargo test sql`：62 通过。
- `pnpm run rust:check`：通过，有 3 个 dead-code warning。
- `pnpm run build`：通过。
- 遗漏的 SQL Editor 测试：13 通过、1 失败。
- 未执行真实桌面 E2E：当前环境未安装 Playwright。

## 本轮修复范围

1. 将用户可见品牌统一为：
   - Name：Nyala
   - Full Name：Nyala Studio
   - Tagline：Local-first SQL Workbench
   - 中文：Nyala Studio，本地优先的 SQL 数据库工作台
2. 扩展 branding 测试覆盖 Web 启动入口。
3. 修复 SQL Editor copy ID，并把遗漏测试纳入标准测试命令。
4. 为全部内置 snippets 提供选择入口。
5. AI action 改为读取当前编辑器 SQL，并向用户收集请求或错误信息。
6. 增加显式的 MySQL 集成测试入口；只有提供测试数据库环境时才执行。

## 兼容性边界

以下内部标识暂时保留，避免破坏既有配置、用户数据与命令协议：

- npm/package 与仓库名 `sql-studio-next`
- Tauri identifier `com.baicie.sqlstudio`
- `sqlStudio.*` Workbench command/storage IDs
- `sql_studio_*.db` 数据文件名及 SideX 迁移兼容常量

它们不是用户可见品牌，不应在本轮做破坏性重命名。

## 发布前仍需完成

- 在真实 Tauri 桌面运行时完成 SQLite 全链路冒烟。
- 使用受控 MySQL 测试实例运行集成测试。
- 增加可重复执行的桌面 E2E/Playwright 测试环境。
- 根据验证结果更新 `docs/roadmap.md` 的验收状态。

## 修复后状态

本轮已完成：

- 用户可见身份统一为 Nyala / Nyala Studio，并应用英文与中文 tagline。
- 默认 Light Modern 启动背景保持白色，避免加载阶段出现深色闪屏。
- branding 测试覆盖 Tauri 配置、`index.html`、`src/main.ts` 和 README。
- `SqlEditorInput.copy()` 为副本生成独立 query ID，原失败测试已转绿。
- `test:sql-editor` 已包含此前遗漏的 `sqlEditor.test.ts`。
- Windows 下 `lint` 脚本的引号兼容问题已修复。
- Snippet 命令现在提供 SELECT、COUNT、INSERT、UPDATE、EXPLAIN 选择器。
- AI action 使用当前 SQL Editor 的连接方言、连接名、SQL 与选中 SQL，并向用户收集请求或错误信息。
- 新增 `pnpm run test:mysql-integration`，用于对真实 MySQL 执行连接、数据库、表、列和 `SELECT 1` 验收。
- `docs/roadmap.md` 已按自动化证据更新验收状态。

修复后验证：

- `pnpm run lint`：通过。
- `pnpm run test`：通过；Rust 78 通过、1 个 MySQL live test 默认忽略，TypeScript SQL 测试全部通过。
- `pnpm run build`：通过。
- `pnpm run rust:fmt`：通过。
- `pnpm run rust:check`：通过。
- `pnpm run rust:clippy`：仍被 SideX 上游 `sidex-update`、`sidex-terminal`、`sidex-remote` 的既有 lint 阻塞，本轮未改写这些 vendor-grade 模块。
- `pnpm run test:mysql-integration`：未执行；当前未提供真实 MySQL 测试环境。
- 桌面 E2E：未执行；当前环境未安装 Playwright。
