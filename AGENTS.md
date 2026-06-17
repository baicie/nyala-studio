# AGENTS.md — SQL Studio Next

## Project Identity

This repository is **SQL Studio Next**, a SideX hard fork intended to become a VS Code-like SQL workbench.

The product goal is not to build a generic code editor. The goal is:

```txt
SQL Studio Next =
  SideX / VS Code-style Workbench shell
  + Tauri Rust backend
  + SQL connections
  + SQL editor
  + query result panel
  + database metadata explorer
  + future SQL extension / AI agent system
```

````

This repo is currently in the **fork stabilization and SQL MVP phase**. Treat the original SideX / VS Code-like workbench as a vendor-grade base. Do not casually rewrite it.

---

## Current MVP Goal

The immediate minimum viable goal is:

```txt
Launch app
  -> show SQL Studio branded workbench
  -> add/open SQLite connection
  -> list database tables
  -> open SQL editor
  -> execute SELECT query
  -> show result in panel
```

Do not expand scope until this loop works.

---

## Priority Order

Always prioritize work in this order:

1. Keep the app buildable.
2. Preserve SideX / VS Code Workbench architecture.
3. Complete the SQL MVP loop.
4. Add tests for every Rust command and critical service.
5. Only then refactor, optimize, or remove upstream features.

---

## High-Level Roadmap

### Phase 1 — Product Branding

Replace remaining SideX branding with SQL Studio Next / Nyala.

Allowed changes:

```txt
package.json
src-tauri/tauri.conf.json
README.md
menu labels
about labels
window title
app identifier
bundle metadata
icons
updater config
```

Expected target:

```txt
productName: SQL Studio Next
identifier: com.baicie.sqlstudio
window title: SQL Studio
```

The upstream SideX updater endpoint must not be used in this fork.

---

### Phase 2 — SQL Rust Commands

Add SQL-specific Tauri commands under:

```txt
src-tauri/src/commands/sql/
```

Recommended structure:

```txt
src-tauri/src/commands/sql/
├── mod.rs
├── types.rs
├── state.rs
├── connection.rs
├── metadata.rs
└── query.rs
```

Register the module through:

```txt
src-tauri/src/commands/mod.rs
src-tauri/src/lib.rs
```

Minimum commands:

```txt
sql_test_connection
sql_open_connection
sql_close_connection
sql_list_connections
sql_list_tables
sql_list_columns
sql_execute_query
sql_cancel_query
```

SQLite comes first. Do not add PostgreSQL/MySQL before the SQLite flow is stable.

---

### Phase 3 — Workbench SQL Services

Add frontend service abstractions before UI.

Preferred location:

```txt
src/vs/workbench/services/sql/common/
src/vs/workbench/services/sql/browser/
```

Minimum services:

```txt
ISqlConnectionService
ISqlMetadataService
ISqlQueryService
```

Do not call Tauri `invoke()` directly from random UI components. All SQL operations should go through Workbench services.

---

### Phase 4 — SQL Connections View

Add a SQL activity/view contribution.

Preferred location:

```txt
src/vs/workbench/contrib/sqlConnections/
```

Minimum UI:

```txt
Activity Bar:
  SQL Connections

Side Bar:
  Connections
    SQLite Connection
      tables
        users
        orders
```

Minimum commands:

```txt
sql.addConnection
sql.refreshConnections
sql.openNewQuery
sql.copyConnectionName
sql.removeConnection
```

Do not remove Explorer/Search/Terminal at this phase. Hide later if needed.

---

### Phase 5 — SQL Editor

Add SQL editor support using Workbench editor patterns.

Preferred location:

```txt
src/vs/workbench/contrib/sqlEditor/
```

Use the VS Code-like model:

```txt
SqlEditorInput
SqlEditorPane
SqlEditorSerializer
SqlEditorCommands
SqlEditorActions
```

Minimum commands:

```txt
sql.newQuery
sql.executeQuery
sql.executeSelection
sql.changeConnection
```

Minimum shortcuts:

```txt
Cmd/Ctrl + Enter     execute current query
Shift + Enter        execute selected query
```

Do not introduce React Router-style pages for the SQL editor.

---

### Phase 6 — Query Result Panel

Add a SQL result panel.

Preferred location:

```txt
src/vs/workbench/contrib/sqlResult/
```

Minimum panel:

```txt
Panel: Query Results
├── toolbar
├── result grid
├── messages
└── errors
```

Minimum display:

```txt
columns
rows
elapsed time
row count
error detail
```

Use a simple table/grid first. Do not introduce a heavy virtualized grid before the SQL MVP loop works.

---

### Phase 7 — Migrate Assets From Old sql-studio MVP

The old `baicie/sql-studio/tree/mvp` project is not the final shell, but it contains useful domain assets.

Migration rule:

```txt
Migrate domain logic, not React shell code.
```

Worth migrating later:

```txt
crates/sqlgui-db
crates/sqlgui-common
crates/sqlgui-extension
SQL API type design
extension manifest / permission design
SQL formatter demo
result-grid interaction ideas
connection form field design
```

Do not migrate:

```txt
React application shell
React Router structure
Zustand global state model
shadcn page layout
old desktop app layout
```

---

## Architecture Rules

### Preserve SideX / VS Code Layering

Respect this layering:

```txt
src/vs/base        low-level utilities
src/vs/platform    platform services
src/vs/editor      editor core integration
src/vs/workbench   product shell, services, contributions
src-tauri          Rust backend and native commands
```

Do not add SQL product code to `base` or `platform` unless it is truly generic.

SQL-specific frontend code should live under:

```txt
src/vs/workbench/contrib/sql*
src/vs/workbench/services/sql*
```

SQL-specific Rust code should live under:

```txt
src-tauri/src/commands/sql/
```

---

### Use Contribution-Based UI

New product features should be added as Workbench contributions.

Prefer:

```txt
sqlConnections.contribution.ts
sqlEditor.contribution.ts
sqlResult.contribution.ts
```

Avoid:

```txt
random global imports
one-off DOM manipulation
React Router pages
monolithic app state
```

---

### Use Services Before UI

Any cross-cutting behavior must be represented as a service.

Good:

```txt
ISqlConnectionService
ISqlQueryService
ISqlMetadataService
```

Bad:

```txt
import { invoke } from '@tauri-apps/api/core' directly inside every view
```

---

### Do Not Deeply Delete Upstream Yet

Until the SQL MVP loop works, do not delete large upstream SideX/VS Code features.

Allowed before MVP:

```txt
rename
hide
disable menus
add SQL contributions
add SQL services
add SQL commands
```

Avoid before MVP:

```txt
deleting Debug
deleting SCM
deleting Extensions
deleting Terminal
rewriting Workbench boot
rewriting editor infrastructure
```

The product can hide old features first and remove them later.

---

## Rust Rules

### Command Design

Every Tauri command should:

1. Return structured result types.
2. Never panic for user input errors.
3. Convert internal errors into serializable error objects.
4. Avoid leaking credentials or full connection strings.
5. Have at least one unit test when practical.

Preferred error shape:

```rust
#[derive(Debug, serde::Serialize)]
pub struct SqlCommandError {
    pub code: String,
    pub message: String,
    pub detail: Option<String>,
}
```

Preferred result shape:

```rust
#[derive(Debug, serde::Serialize)]
pub struct SqlQueryResult {
    pub columns: Vec<SqlColumn>,
    pub rows: Vec<Vec<SqlValue>>,
    pub affected_rows: Option<u64>,
    pub elapsed_ms: u128,
}
```

---

### SQLite First

Implement SQLite first.

Do not add PostgreSQL/MySQL until these work:

```txt
test connection
open connection
list tables
list columns
execute select
return rows
return SQL error
cancel query or safely ignore cancel
```

---

### SQL Safety

Default query mode should be safe.

For the first MVP:

```txt
SELECT queries are allowed.
Mutation queries should require explicit write mode.
Multiple statements should be rejected unless intentionally supported.
Dangerous statements should be blocked in readonly mode.
```

Dangerous examples:

```sql
DROP TABLE
DROP DATABASE
TRUNCATE
DELETE
UPDATE
INSERT
ALTER
CREATE
VACUUM
ATTACH
DETACH
```

When in doubt, block by default and return a clear error.

---

### Secrets

Never log credentials.

Never print:

```txt
password
token
secret
private key
full database URL with credentials
```

Connection display names must be safe.

---

## TypeScript Rules

### Prefer Existing VS Code Style

This project inherits a VS Code-like codebase. Prefer existing conventions over introducing new app-level conventions.

Use:

```txt
services
contributions
commands
context keys
disposables
lifecycle management
```

Avoid:

```txt
global singleton objects
implicit mutable module state
ad-hoc event buses
unscoped DOM listeners
```

---

### Disposal Is Mandatory

Any listener, model, editor widget, timer, or subscription must be disposed.

Use existing disposable patterns from the codebase.

Bad:

```ts
window.addEventListener('resize', handler);
```

Good:

```ts
this._register(addDisposableListener(window, 'resize', handler));
```

---

### SQL Types

Centralize SQL shared types.

Preferred:

```txt
src/vs/workbench/services/sql/common/sqlTypes.ts
```

Do not duplicate SQL result/connection types across contributions.

---

## UI Rules

### SQL Studio Is a Workbench, Not a SPA

Do not build product UI as independent pages.

Correct model:

```txt
Activity Bar
Side Bar
Editor Area
Panel
Status Bar
Commands
Context Menus
```

Incorrect model:

```txt
/routes/connections
/routes/query
/routes/results
```

---

### Result Grid First Version

The first result grid should be boring and reliable.

Required:

```txt
column headers
row rendering
null value display
error state
empty state
elapsed time
row count
horizontal scroll
vertical scroll
```

Not required for MVP:

```txt
column resizing
cell editing
infinite scrolling
copy range
CSV export
filtering
sorting
virtualization
large result streaming
```

---

### Status Bar

Once query execution works, add minimal status items:

```txt
current connection
current database
query elapsed time
row count
readonly/write mode
```

---

## Testing Requirements

Before marking a task complete, run relevant checks.

Default commands:

```bash
pnpm run lint
pnpm run build
pnpm run rust:fmt
pnpm run rust:check
pnpm run rust:clippy
```

For Rust SQL commands, add focused tests where possible:

```bash
cd src-tauri && cargo test sql
```

Minimum SQL test cases:

```txt
select 1 returns one row
invalid SQL returns structured error
list tables returns known table
readonly mode blocks write query
connection close removes connection
```

---

## Build Rules

Use the existing package manager declared by the repo.

Preferred:

```bash
pnpm install
pnpm run build
pnpm run tauri dev
pnpm run tauri build
```

Do not introduce npm/yarn lockfiles.

Do not modify lockfiles unless dependencies actually changed.

---

## Dependency Rules

Avoid new dependencies unless clearly justified.

Before adding a dependency, check:

```txt
Can existing VS Code/SideX utilities do this?
Can Rust std or existing crate do this?
Can a small local helper solve it?
Is the dependency maintained?
Does it increase bundle size significantly?
Does it work in Tauri/webview?
```

Do not add heavy UI libraries for MVP result grid.

Do not add ORM layers before the SQLite command bridge is stable.

---

## Security Rules

This is a desktop SQL client. Treat local files, database credentials, and query results as sensitive.

Rules:

```txt
Do not upload user data.
Do not add telemetry without explicit product decision.
Do not log query results by default.
Do not log credentials.
Do not keep upstream SideX updater endpoints.
Do not broaden Tauri filesystem scopes without justification.
```

---

## Agent Behavior Rules

When modifying this repository:

1. First inspect nearby files and follow existing patterns.
2. Keep changes small and phase-aligned.
3. Prefer adding SQL-specific modules instead of rewriting upstream internals.
4. Do not perform broad cleanup unrelated to the requested task.
5. Do not rename large directories unless explicitly asked.
6. Do not remove upstream features before the SQL MVP loop is complete.
7. Always mention tests/checks run.
8. If checks cannot be run, state that clearly.
9. Do not claim a build passes unless actually verified.
10. Do not output patch files unless explicitly requested.

---

## Output Rules For Coding Tasks

When asked for implementation, provide:

```txt
1. Design summary
2. File list
3. Full code for new files
4. Full replacement code for changed files when reasonable
5. Tests
6. Verification commands
7. Risk notes
```

Avoid vague snippets when the user asks for complete code.

Do not answer with only a conceptual plan if the user requested implementation details.

---

## Commit Style

Use concise conventional commit messages.

Examples:

```txt
chore: rename app branding to SQL Studio
feat(sql): add SQLite query command bridge
feat(sql): add SQL connection service
feat(sql): add SQL connections view
feat(sql): add SQL editor contribution
feat(sql): add query result panel
test(sql): cover SQLite query command
refactor(sql): extract shared SQL result types
```

---

## Branch Naming

Recommended branch names:

```txt
chore/product-branding
feat/sql-command-bridge
feat/sql-service-layer
feat/sql-connections-view
feat/sql-editor
feat/sql-result-panel
feat/sqlite-mvp
```

---

## Do Not Do Yet

Until the MVP loop is complete, do not work on:

```txt
AI Agent
plugin marketplace
PostgreSQL
MySQL
schema diff
ER diagram
large result streaming
notebook
query history sync
cloud account
team collaboration
extension compatibility with VS Code
deep deletion of SideX subsystems
```

These are later phases.

---

## Definition of Done For Current MVP

The MVP is complete when:

```txt
1. App launches as SQL Studio, not SideX.
2. A SQLite connection can be added.
3. Tables can be listed.
4. A SQL editor can be opened.
5. SELECT query can be executed.
6. Query result appears in a panel grid.
7. Invalid SQL returns a visible structured error.
8. pnpm run build passes.
9. pnpm run rust:check passes.
10. SQL command tests pass.
```

Only after this point may agents start product cleanup, upstream feature removal, multi-database support, plugin system, or AI assistant work.

```

```
````
