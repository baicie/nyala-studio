# Nyala Studio

**Local-first SQL Workbench**

Nyala Studio is a local-first SQL database workbench built on a Tauri-based VS Code-like workbench shell.

中文：Nyala Studio，本地优先的 SQL 数据库工作台。

The project is a product hard fork of SideX. The goal is not to build a generic code editor. The goal is to build a local-first database workbench with:

- SQL connections
- SQL editor
- query result panel
- database metadata explorer
- future SQL extension system
- future AI-assisted diagnosis and query workflow

## Current Status

This repository is currently in the SQL MVP productization phase.

Runtime driver status:

| Driver | Status | Notes |
| --- | --- | --- |
| SQLite | MVP stable | File database, `:memory:`, metadata, query execution, cancellation and read-only mode are enabled. |
| MySQL | Preview | Connection, metadata and query execution are enabled for local/dev validation. Query cancellation is not supported yet. |
| PostgreSQL | Planned | Protocol fields exist, but the runtime driver is not enabled yet. |

The immediate MVP target is:

```txt
Launch Nyala Studio
  -> show SQL-first workbench
  -> add/open SQLite or MySQL Preview connection
  -> list databases, tables, views and columns
  -> open SQL editor
  -> execute SELECT / selected SQL / current statement
  -> show result or error in panel
  -> save query draft and query history
```

Safety notes:

- Saved connections never persist secrets.
- Read-only connections block obvious DDL/DML statements.
- MySQL Preview is intended for local/dev validation first.
- PostgreSQL must be shown as planned until runtime support is added.

## Roadmap

The historical fork-stabilization phases have moved into the SQL MVP productization track.
The short-term roadmap is now aligned with the actual runtime status:

### Phase 00 — Runtime Status Alignment

- Keep README, SQL protocol comments and driver status terminology aligned.
- Document SQLite as MVP stable.
- Document MySQL as Preview.
- Document PostgreSQL as Planned.
- Add regression checks for stale runtime-status documentation.

### Phase 01 — Connection MVP Stabilization

- Stabilize SQLite connection flows.
- Stabilize MySQL Preview connection flows.
- Keep PostgreSQL visible only as planned.
- Preserve runtime-only secrets for test/open flows.
- Never persist connection passwords.
- Surface auto-connect restore errors in the UI.

### Phase 02 — Metadata Explorer

- List databases where the driver supports it.
- List tables and views.
- Expand columns with type, primary-key, nullability and default metadata.
- Support refresh and per-node metadata error states.

### Phase 03 — SQL Editor Execution Loop

- Open SQL editor tabs bound to a selected connection.
- Execute all SQL.
- Execute selected SQL.
- Execute the current statement.
- Support Cmd/Ctrl + Enter shortcuts.
- Show running, success and error states.

### Phase 04 — Query Result Panel

- Show result columns and rows.
- Show affected rows for non-result statements.
- Show elapsed time, row count and truncation state.
- Render query errors in the result panel.
- Support basic copy operations.

### Phase 05 — History, Formatter, Snippets and Explain

- Persist query history.
- Restore editor drafts.
- Provide reusable SQL snippets.
- Provide SQL formatting.
- Provide SQLite/MySQL explain-plan helpers.

### Phase 06 — AI Helper Foundation

- Keep deterministic AI provider as the default offline-safe provider.
- Build AI context from dialect, connection, schema, selected SQL, errors and explain plans.
- Generate SQL drafts without auto-executing them.
- Explain SQL errors and optimization opportunities.

### Phase 07 — Plugin API MVP

- Keep plugin loading local-only for the MVP.
- Register built-in commands and SQL actions through the plugin registry.
- Prepare view, panel, menu, keybinding and settings contribution points.
- Add permission-oriented capability declarations.

### Phase 08 — MVP Packaging and Demo Flow

- Provide a repeatable SQLite demo flow.
- Provide an opt-in MySQL Preview validation flow.
- Keep the default product experience SQL-first.
- Run the full check suite before release.

> Per-phase design contracts and the current verified state live in
> [`docs/sql-mvp-phases/README.md`](./docs/sql-mvp-phases/README.md).
> Always cross-check that table before claiming a phase is met.

## SQLite Demo Flow

Nyala Studio ships with a built-in demo SQLite database that lets a new
user reach a runnable query in under a minute.

- On first launch (or on demand), the workbench calls the
  `sql_bootstrap_demo` Tauri command, which seeds
  `<data_dir>/nyala-studio/demo.db` with a `users` table (5 rows) and an
  `orders` table (5 rows joined to users), then registers a
  `Demo (SQLite)` connection profile (id `demo-sqlite`) and opens it.
- The seeder is idempotent: subsequent launches reuse the existing file
  rather than duplicating rows.
- Override the data directory for tests or sandboxed runs:

  ```bash
  export NYALA_DATA_DIR=/tmp/nyala-test
  pnpm run seed:demo       # dev / CI helper that mirrors sql_bootstrap_demo
  ```

  On Windows (PowerShell):

  ```powershell
  $env:NYALA_DATA_DIR = 'D:\tmp\nyala-test'
  pnpm run seed:demo
  ```

The full Rust implementation lives in
[`src-tauri/src/commands/sql/demo_seed.rs`](./src-tauri/src/commands/sql/demo_seed.rs)
and [`src-tauri/src/commands/sql/product.rs`](./src-tauri/src/commands/sql/product.rs).

## Release Readiness

Before publishing a build, every check below must pass locally. The
GitHub Actions workflows under `.github/workflows/` enforce the same
gates on `main` and on every pull request.

```bash
pnpm run lint
pnpm run build
pnpm run rust:fmt
pnpm run rust:check
pnpm run rust:clippy
pnpm run test
```

`pnpm run test` is a chain that runs the branding guard, the runtime
status consistency check, the Rust `cargo test --lib` suite (currently
~157 tests), and every per-subsystem frontend suite
(`test:sql-services`, `test:sql-domain`, `test:sql-connections`,
`test:sql-editor`, `test:sql-result`, `test:sql-history`,
`test:sql-product`, `test:sql-advanced`).

Optional opt-in MySQL Preview validation. Only useful when you have a
local MySQL on `127.0.0.1:3306` with the test database/credentials
below — the test creates and drops a uniquely named table, but the
test account still needs CREATE / DROP privileges.

```bash
export NYALA_TEST_MYSQL_HOST='127.0.0.1'
export NYALA_TEST_MYSQL_DATABASE='nyala_test'
export NYALA_TEST_MYSQL_USERNAME='root'
export NYALA_TEST_MYSQL_PASSWORD='password'
pnpm run test:mysql-integration
```

The full Phase 08 acceptance checklist lives in
[`docs/sql-mvp-phases/phase-08-mvp-packaging.md`](./docs/sql-mvp-phases/phase-08-mvp-packaging.md).
The P0 deliverable (demo seed + MySQL Preview validation + Welcome view
model + Release Readiness doc) is shipped at commit `34128dc5`; the
remaining items are the `ViewPane` subclass that renders the welcome
tiles and a true transient-open API for the MySQL Preview profile, both
covered in `docs/sql-mvp-phases/README.md` Phase 08 footer.

## Development

Install dependencies:

```bash
pnpm install
```

Run the app in development:

```bash
pnpm tauri dev
```

Build frontend:

```bash
pnpm run build
```

Build desktop app:

```bash
pnpm tauri build
```

Run checks:

```bash
pnpm run lint
pnpm run build
pnpm run rust:fmt
pnpm run rust:check
pnpm run rust:clippy
pnpm run test
```

Run the opt-in MySQL Preview integration test against a disposable test database:

```powershell
$env:NYALA_TEST_MYSQL_HOST = '127.0.0.1'
$env:NYALA_TEST_MYSQL_DATABASE = 'nyala_test'
$env:NYALA_TEST_MYSQL_USERNAME = 'root'
$env:NYALA_TEST_MYSQL_PASSWORD = 'password'
pnpm run test:mysql-integration
```

The integration test creates and removes one uniquely named table. Do not point it at a database where the test account must remain read-only.

## Project Layout

```txt
sql-studio-next/
├── src/
│   └── vs/
│       ├── base/
│       ├── platform/
│       ├── editor/
│       └── workbench/
├── src-tauri/
│   └── src/
│       ├── commands/
│       ├── product.rs
│       ├── lib.rs
│       └── main.rs
├── crates/
├── scripts/
├── index.html
├── vite.config.ts
└── package.json
```

## Architecture Direction

SQL-specific frontend code should live under:

```txt
src/vs/workbench/contrib/sql*
src/vs/workbench/services/sql*
```

SQL-specific Rust code should live under:

```txt
src-tauri/src/commands/sql/
```

Do not build Nyala as a React Router-style SPA. This project should keep the VS Code-style Workbench model:

```txt
Activity Bar
Side Bar
Editor Area
Panel
Status Bar
Commands
Services
Contributions
```

## Upstream Attribution

Nyala Studio is based on SideX, which is a Tauri port of Code - OSS / VS Code workbench concepts.

The upstream project and Code - OSS are MIT licensed. See `LICENSE` for details.
