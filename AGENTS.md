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

Source of truth for phase progress: **`docs/sql-mvp-phases/README.md`** and the per-phase docs under `docs/sql-mvp-phases/`. Read those before checking off any roadmap work.

- Core MVP baseline: `mvp@1dca498f`; active work normally happens on topic branches, so never assume the current branch or worktree is clean.
- MVP core loop (the 10-item Definition of Done) met on commit `60ab89c0`. Verification report: `docs/sql-mvp-phases/phase-do-d-verification.md`.
- Phases 00–08 are implemented at P0 scope. Phase 08 native Demo and live MySQL Preview Validate were recorded complete on `mvp@1dca498f`.
- The active MVP vNext route adds SQL Workspace Agent A0–A4 and a gated Zeus Data Grid Preview. Source of truth: `docs/sql-mvp-phases/mvp-vnext-agent-zeus-roadmap.md`.
- Agent A0.1/A0.2, A1.1-A1.3, A2.1-A2.4, A3.1/A3.2, and A4.1/A4.2 are implemented; Checkpoint R is complete with automated and macOS native Generate/Fix/Explore evidence, while A4 Checkpoint W still needs native keyboard, Windows WebView2, and real VoiceOver/Narrator walkthroughs. A0.2 is a recorded parser No-Go, A1.2/A1.3 provide bounded schema/FK graph search and cache, A2.1-A2.4 provide the runtime domain, Rust policy, deterministic Suggest-only loop, and Workbench/Tauri bridge, A3.1/A3.2 provide SQLite read-only explain/execute plus bounded result shape/aggregate/sample policy, and A4.1/A4.2 provide stale-safe editor artifacts, Schema/Result actions, and the SQL Agent Panel. A2 remains Suggest Only with zero query calls; A3 requires an explicitly read-only SQLite connection and keeps rows out of default evidence. Zeus Z1.1/Z1.2 remain non-production audits/benchmarks; Z1.3 is `NO-GO` because the recorded performance thresholds fail and revision-bound macOS/Windows evidence plus a fresh bundle audit are missing. There is still no production Zeus dependency or renderer integration, and Z2 must not start.
- Recent cleanup: SCM provider unloaded (`09bf4b65`), AGENTS Phase 7 dropped (`0306f70f`), AGENTS reorganized (`a0d56767`).

**Never claim a phase is met from this file alone — open `docs/sql-mvp-phases/README.md` and the matching phase doc first.**

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

The authoritative roadmap lives in **`docs/sql-mvp-phases/README.md`** (Core Phase 00–08 + MVP vNext + DoD verification). The summary below is a quick reference; **always open the per-phase or vNext doc before planning work.**

| Phase | Doc                                              | Scope                                                               |
| ----- | ------------------------------------------------ | ------------------------------------------------------------------- |
| 00    | `phase-00-runtime-status.md`                     | runtime status surface, scripts/verify-sql-runtime-status.mjs       |
| 01    | `phase-01-connection-mvp.md`                     | SQLite connection lifecycle + secret hygiene                        |
| 02    | `phase-02-metadata-explorer.md`                  | three-level tree, per-node error / refresh                          |
| 03    | `phase-03-editor-execution.md`                   | execute all / selection / current + Ctrl+Enter                      |
| 04    | `phase-04-result-panel.md`                       | columns / rows / affected / elapsed / error                         |
| 05    | `phase-05-history-formatter-snippets-explain.md` | history, snippets, formatter, explain                               |
| 06    | `phase-06-ai-helper-foundation.md`               | deterministic provider + capability guard                           |
| 07    | `phase-07-plugin-api-mvp.md`                     | 13 contribution points + local-only loader                          |
| 08    | `phase-08-mvp-packaging.md`                      | **P0 met** — demo.db seed + welcome flow + MySQL Preview validation |

Core implementation order remains the historical sequence `00 → 01 → 02 → 03 → 04 → 05 → 06 → 07 → 08`, now met.

MVP vNext order is dependency-driven:

```txt
A0/A1 → A2 → A3 → A4 ─┐
Z0 → Z1 ───────────────┤
                        └→ Z2 → R0
```

Z1 may run in parallel because it is a non-production spike. Z2 must wait for both Agent A4 and a recorded Z1 Go decision. Never treat a Zeus evaluation or failed spike as completed integration.

---

## Architecture Rules

### Layer Boundaries

| Layer     | Path               | Holds                                  |
| --------- | ------------------ | -------------------------------------- |
| Base      | `src/vs/base`      | low-level utilities                    |
| Platform  | `src/vs/platform`  | platform services                      |
| Editor    | `src/vs/editor`    | editor core integration                |
| Workbench | `src/vs/workbench` | product shell, services, contributions |
| Native    | `src-tauri`        | Rust backend and native commands       |

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

Out of scope for the historical Core MVP: column resizing, cell editing, infinite scrolling, filtering, sorting, virtualization, and large result streaming. MVP vNext may add only the gated Zeus success-grid Preview defined in `mvp-vnext-agent-zeus-roadmap.md`; streaming and large-result transport remain out of scope.

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

**Hard no:** ORM layers that duplicate the stable SQL Core, telemetry / crash-reporter packages without explicit user approval, or any global UI framework migration.

**Zeus exception for MVP vNext:** `@zeus-web/data-grid` may become an exact-pinned production dependency only after the Z1 dependency, bundle, performance, and two-WebView Go gate passes. It must stay inside the SQL Result contribution and retain the native renderer fallback. No other Zeus component is approved by that decision.

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

## Definition of Done (Core MVP)

The 10-item Core MVP gate was met on commit `60ab89c0`. Verification report: `docs/sql-mvp-phases/phase-do-d-verification.md`.

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

This list is **read-only** and a historical anchor only. Core phase evidence remains in the matching phase doc; all new Agent/Zeus work is checked against `docs/sql-mvp-phases/mvp-vnext-agent-zeus-roadmap.md`.
