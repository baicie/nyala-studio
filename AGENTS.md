# AGENTS.md — Nyala Studio

Agent guidance for working in this repository. Read this before making non-trivial changes.

## Project Identity

Nyala Studio is a SideX hard fork intended to become a VS Code-like SQL workbench.

```txt
Nyala Studio =
  SideX / VS Code-style Workbench shell
  + Tauri Rust backend
  + SQL connections
  + SQL editor
  + query result panel
  + database metadata explorer
  + future SQL extension / AI agent system
```

Treat the SideX / VS Code workbench as vendor-grade. Do not casually rewrite it.

---

## Current Status

- Branch under development: `mvp`.
- MVP Definition of Done: met on commit `60ab89c0` (see `docs/sql-mvp-phases/phase-do-d-verification.md`).
- The MVP loop works: branded workbench, SQLite connection, table listing, SQL editor, SELECT execution, result panel, structured SQL error.
- Last cleanup round landed: SCM provider unloaded (commit `09bf4b65`), AGENTS Phase 7 dropped (commit `0306f70f`).

---

## Priority Order

Always work in this order. Reordering requires explicit user request.

1. Keep the app buildable.
2. Preserve SideX / VS Code workbench architecture.
3. Complete or polish the SQL MVP loop.
4. Add tests for every Rust command and critical service.
5. Only then refactor, optimize, or remove upstream features.

---

## High-Level Roadmap

Each phase lists the deliverable, where it lives, and what is **not** part of the phase.

### Phase 1 — Product Branding

Replace remaining SideX / SQL Studio branding with Nyala / Nyala Studio.

**Touch:** `package.json`, `src-tauri/tauri.conf.json`, `README.md`, menu labels, about labels, window title, app identifier, bundle metadata, icons, updater config.

**Target identifiers:** `productName: "Nyala Studio"`, `identifier: com.baicie.sqlstudio`, window title `Nyala`.

**Out of scope:** upstream SideX updater endpoints must not be reused.

### Phase 2 — SQL Rust Commands

Tauri command bridge for SQL.

**Location:** `src-tauri/src/commands/sql/`. Module wiring: `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`.

**Modules (current state):** `mod.rs`, `types.rs`, `state.rs`, `connection_manager.rs`, `metadata.rs`, `metadata_v2.rs`, `dialect.rs`, `driver.rs`, `driver_registry.rs`, `persistence.rs`, `persistence_v2.rs`, `runtime_status_export.rs`, `mysql_runtime.rs`. Add new modules here; do not scatter SQL logic elsewhere.

**Minimum commands:** `sql_test_connection`, `sql_open_connection`, `sql_close_connection`, `sql_list_connections`, `sql_list_tables`, `sql_list_columns`, `sql_execute_query`, `sql_cancel_query`.

**Out of scope:** PostgreSQL and MySQL production support until SQLite flow is stable end to end.

### Phase 3 — Workbench SQL Services

Frontend service abstractions that sit between the UI and the Tauri command bridge.

**Location:** `src/vs/workbench/services/sql/common/` and `src/vs/workbench/services/sql/browser/`.

**Core services:** `ISqlConnectionService`, `ISqlMetadataService`, `ISqlQueryService`.

**Rule:** UI components must call services, never `invoke()` directly. Every SQL Tauri command has exactly one browser-side service that wraps it.

### Phase 4 — SQL Connections View

Activity-bar + sidebar entry for managing connections.

**Location:** `src/vs/workbench/contrib/sqlConnections/`.

**UI shape:** activity-bar `SQL Connections`, sidebar tree (connection → database → schema → tables → columns).

**Commands:** `sql.addConnection`, `sql.refreshConnections`, `sql.openNewQuery`, `sql.copyConnectionName`, `sql.removeConnection`.

**Out of scope:** do not remove Explorer / Search / Terminal here. Hide later if needed.

### Phase 5 — SQL Editor

SQL editor contribution.

**Location:** `src/vs/workbench/contrib/sqlEditor/`.

**Model:** `SqlEditorInput`, `SqlEditorPane`, `SqlEditorModel`, `SqlEditorActions`, `SqlEditorExecutionController`, `SqlEditorDraftService`, `SqlEditorEvents`. A separate serializer class is not required — VS Code's editor registry handles input persistence via `editor.input.factory`.

**Commands:** `sql.newQuery`, `sql.executeQuery`, `sql.executeSelection`, `sql.changeConnection`.

**Shortcuts:**

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + Enter` | execute current query |
| `Shift + Enter` | execute selected query |

**Out of scope:** React-Router-style pages for the SQL editor.

### Phase 6 — Query Result Panel

Result panel below the editor area.

**Location:** `src/vs/workbench/contrib/sqlResult/`.

**Panel:** toolbar, result grid, messages, errors.

**Display:** columns, rows, elapsed time, row count, error detail.

**Out of scope:** column resizing, cell editing, infinite scrolling, copy range, CSV export, filtering, sorting, virtualization, large result streaming. Add these later, never block MVP on them.

### Phase 7+ — Post-MVP Cleanup

Free to explore once Phase 1-6 are stable and the Definition of Done has been met:

- Product polish, additional drivers, AI assistant stub, plugin system.

Do not start Post-MVP work until the build, lint, and test suites are all green for the work in flight.

---

## Architecture Rules

### Layer Boundaries

| Layer | Path | Holds |
|---|---|---|
| Base | `src/vs/base` | low-level utilities |
| Platform | `src/vs/platform` | platform services |
| Editor | `src/vs/editor` | editor core integration |
| Workbench | `src/vs/workbench` | product shell, services, contributions |
| Native | `src-tauri` | Rust backend and native commands |

**Do:** keep SQL-specific frontend code under `src/vs/workbench/contrib/sql*` and `src/vs/workbench/services/sql*`.

**Do not:** add SQL product code to `src/vs/base` or `src/vs/platform` unless it is genuinely generic.

### Add Features as Contributions

**Do:** add product features as workbench contributions (`*.contribution.ts`) that register services, commands, views, and menus.

**Do not:** scatter random global imports, one-off DOM manipulation, or monolithic app state across the tree.

### Always Go Through Services

**Do:** wrap every cross-cutting behavior in a service interface in `src/vs/workbench/services/sql/`.

**Do not:** call `import { invoke } from '@tauri-apps/api/core'` directly inside views.

### Upstream Cleanup

The MVP loop is met. Subsequent upstream cleanup is permitted under these constraints:

**Allowed at any time:** rename, hide, disable menus, add SQL contributions, add SQL services, add SQL commands.

**Allowed only with explicit user request and a documented plan:** deleting or major refactoring of upstream Debug / SCM / Extensions / Terminal subsystems. Audit their extHost dependencies first — `ITerminalService`, `IDebugService`, `IExtensionsWorkbenchService` are tied to `mainThreadTerminalService` / `mainThreadDebugService` / `mainThreadExtensionService`. Removing them breaks the extension host layer.

**Always avoided:** rewriting the workbench boot, rewriting editor infrastructure. The product can hide features first and remove them later.

---

## Rust Rules

### Command Design

Every Tauri command must:

1. Return structured result types.
2. Never panic for user input errors.
3. Convert internal errors into serializable error objects via `SqlCommandError`.
4. Avoid leaking credentials or full connection strings.
5. Have at least one unit test when practical.

```rust
#[derive(Debug, serde::Serialize)]
pub struct SqlCommandError {
    pub code: String,
    pub message: String,
    pub detail: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct SqlQueryResult {
    pub columns: Vec<SqlColumn>,
    pub rows: Vec<Vec<SqlValue>>,
    pub affected_rows: Option<u64>,
    pub elapsed_ms: u128,
}
```

### SQLite First

Do not add a new database driver until the SQLite MVP loop is verified working end to end. The current SQLite flow is stable.

### SQL Safety

Default query mode is safe-by-default:

- `SELECT` queries are always allowed.
- Mutation queries require explicit write-mode opt-in.
- Multiple statements are rejected unless intentionally supported.
- Dangerous statements are blocked in read-only mode.

Reference list of dangerous statements:

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

Block by default when in doubt. Return a clear structured error.

### Secrets

- Never log credentials.
- Never print passwords, tokens, secrets, private keys, or full database URLs with credentials.
- Connection display names must be safe for logs and UI.

---

## TypeScript Rules

### Match VS Code Conventions

This project inherits a VS Code-like codebase. Reuse its primitives: services, contributions, commands, context keys, disposables, lifecycle phases.

**Avoid:** global singleton objects, implicit mutable module state, ad-hoc event buses, unscoped DOM listeners.

### Dispose Everything

Any listener, model, editor widget, timer, or subscription must be disposed via `_register(...)` or returned as an `IDisposable`.

```ts
// bad
window.addEventListener('resize', handler);

// good
this._register(addDisposableListener(window, 'resize', handler));
```

### Centralize SQL Types

Keep SQL shared types in `src/vs/workbench/services/sql/common/sqlTypes.ts`. Do not duplicate connection / result / column shapes across contributions.

---

## UI Rules

### Workbench, Not SPA

The product is a workbench: activity bar, side bar, editor area, panel, status bar, commands, context menus. New product UI is registered as a contribution, not as a `/routes/X` page.

### Result Grid (MVP)

Required for MVP:

- column headers
- row rendering
- null value display
- error and empty states
- elapsed time, row count
- horizontal and vertical scrolling

Out of scope for MVP (add later): column resizing, cell editing, infinite scrolling, copy range, CSV export, filtering, sorting, virtualization, large result streaming.

### Status Bar

Once query execution works, surface minimal status items: current connection, current database, query elapsed time, row count, read-only / write mode.

---

## Testing & Verification

### Scripts (use these)

Always work from `package.json`:

```bash
pnpm run lint          # eslint src/**/*.ts
pnpm run lint:fix      # auto-fix safe lint issues
pnpm run format        # prettier --write
pnpm run format:check  # CI check
pnpm run build         # vite build
pnpm run rust:check    # cargo check
pnpm run rust:clippy   # cargo clippy --all-targets -- -D warnings
pnpm run rust:fmt      # cargo fmt --all -- --check
pnpm run rust:fmt:fix  # auto-fix
pnpm run test          # full chain: branding + runtime-status + rust + 8 frontend suites
pnpm run test:rust     # cargo test --lib
pnpm run test:branding
pnpm run test:sql-runtime-status
pnpm run test:sql-connection-mvp
pnpm run test:sql-services
pnpm run test:sql-domain
pnpm run test:sql-connections
pnpm run test:sql-editor
pnpm run test:sql-result
pnpm run test:sql-history
pnpm run test:sql-product
pnpm run test:sql-advanced
pnpm run test:mysql-integration   # ignored by default; opt in
```

The granular `test:sql-*` scripts let you verify a single subsystem in seconds rather than rerunning the entire chain.

### Frontend Suite Boundaries

- `test:sql-services` / `test:sql-domain`: pure unit tests for `src/vs/workbench/services/sql/`.
- `test:sql-connections` / `test:sql-editor` / `test:sql-result` / `test:sql-history` / `test:sql-product` / `test:sql-advanced`: contribution-level tests.
- `test:branding`: node script, asserts Nyala branding and pinned identifiers.
- `test:sql-runtime-status`: node script, asserts runtime status report matches observed state.

### Required Coverage for Rust SQL Commands

```rust
#[test]
fn select_one_returns_one_row() { /* … */ }

#[test]
fn invalid_sql_returns_structured_error() { /* … */ }

#[test]
fn list_tables_returns_known_table() { /* … */ }

#[test]
fn readonly_mode_blocks_write_query() { /* … */ }

#[test]
fn close_connection_removes_connection() { /* … */ }
```

Patterns above are the minimum. Real Rust command modules need more — see `src-tauri/src/commands/sql/` for current coverage.

### Definition of Verification

Before claiming a task complete, run the relevant subset and report exact commands + exit status. If a check cannot run, say so explicitly. Never assert "build passes" without showing the command and its exit code.

### Build Conventions

- Use the package manager declared in `package.json` (pnpm). Do not add `package-lock.json` or `yarn.lock`.
- Do not modify lockfiles unless dependencies actually changed.
- Rust formatting policy: `pnpm run rust:fmt:fix` before commit; CI runs `pnpm run rust:fmt` and `pnpm run rust:clippy` with `-D warnings`.

---

## Dependency Rules

Avoid new dependencies unless clearly justified. Before adding one, check:

- Can existing VS Code / SideX utilities do this?
- Can Rust std or an existing crate do this?
- Can a small local helper solve it?
- Is it maintained?
- Does it noticeably increase bundle size?
- Does it work in Tauri and the bundled webview?

**Hard no for MVP:** heavy UI libraries for the result grid, ORM layers before the SQLite command bridge is stable, telemetry / crash-reporter packages without explicit user approval.

---

## Security Rules

This is a desktop SQL client. Local files, database credentials, and query results are sensitive.

- Do not upload user data.
- Do not add telemetry without explicit product decision.
- Do not log query results by default.
- Do not log credentials (passwords, tokens, secret keys, full URLs with credentials).
- Do not keep upstream SideX updater endpoints.
- Do not broaden Tauri filesystem scopes without justification; default-deny escapes.

If unsure whether something leaks sensitive data, treat it as sensitive.

---

## Agent Behavior

When modifying this repository:

1. Inspect nearby files first and follow the existing pattern.
2. Keep changes small and phase-aligned.
3. Prefer adding SQL-specific modules over rewriting upstream internals.
4. Do not perform broad cleanup unrelated to the requested task.
5. Do not rename large directories unless explicitly asked.
6. Verify compilation and tests before claiming a task is done. Report commands and exit codes.
7. If a check cannot run (missing toolchain, network restriction, time), state that explicitly.
8. Do not output patch files unless explicitly requested.

### Output For Coding Tasks

When asked for implementation, deliver:

1. Design summary (what changed in the architecture, not just file names).
2. File list (new / modified / deleted with line counts when relevant).
3. Full code for new files; full replacement code for changed files when reasonable.
4. Tests added or modified.
5. Verification: exact commands run and their exit status.
6. Risk notes: extHost API surfaces affected, services touched, behavior changes for downstream callers.

Do not answer with a conceptual plan when the user requested implementation.

---

## Commit Style

Use conventional commits scoped to the area. Match an existing prefix from the repo history when possible.

```txt
feat(sql): add SQLite query command bridge
feat(sql): add SQL connection service
feat(sql): add SQL connections view
feat(sql): add SQL editor contribution
feat(sql): add query result panel
test(sql): cover SQLite query command
refactor(sql): extract shared SQL result types
fix(sql): handle empty result rowset correctly
docs(sql): record MVP Definition of Done verification report
chore(upstream): unload Tauri Git SCM provider
chore(rust): resolve cargo clippy lints
```

Subject ≤ 72 chars, imperative mood, no trailing period. Body explains the why and links to the code path that proves it.

---

## Branch Naming

Recommended pattern: `<type>/<scope>-<short-name>`.

```txt
chore/product-branding
feat/sql-command-bridge
feat/sql-service-layer
feat/sql-connections-view
feat/sql-editor
feat/sql-result-panel
feat/sqlite-mvp
```

`mvp` is the working branch; feature work happens on topic branches off `mvp`.

---

## Definition of Done (MVP)

Met on commit `60ab89c0`. Verification report: `docs/sql-mvp-phases/phase-do-d-verification.md`.

1. App launches as Nyala, not SideX or SQL Studio.
2. A SQLite connection can be added.
3. Tables can be listed.
4. A SQL editor can be opened.
5. `SELECT` query can be executed.
6. Query result appears in a panel grid.
7. Invalid SQL returns a visible structured error.
8. `pnpm run build` exits 0.
9. `pnpm run rust:check` is clean.
10. `pnpm run test` passes end to end (branding, runtime status, Rust + 8 frontend suites).

The list is read-only now. To open new work past the MVP, see "Post-MVP Cleanup" under the High-Level Roadmap.
