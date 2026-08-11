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

| Driver     | Status     | Notes                                                                                                                   |
| ---------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| SQLite     | MVP stable | File database, `:memory:`, metadata, query execution, cancellation and read-only mode are enabled.                      |
| MySQL      | Preview    | Connection, metadata and query execution are enabled for local/dev validation. Query cancellation is not supported yet. |
| PostgreSQL | Planned    | Protocol fields exist, but the runtime driver is not enabled yet.                                                       |

The connector manager can cache the signed MySQL Connector/J and PostgreSQL
JDBC packages for future runtime integrations. Package installation is kept
separate from runtime maturity: downloading PostgreSQL does not enable its
planned connection runtime, and MySQL connections continue to use the native
Preview driver.

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

The proposed post-MVP evolution from the deterministic AI Helper to a
local-first SQL Workspace Agent is specified in
[`docs/sql-workspace-agent-design.md`](./docs/sql-workspace-agent-design.md).
Its `A0-A8` Agent Stages are not SQL MVP Phase numbers and do not change the
current Phase 08 or driver-runtime status.

## SQLite Demo Flow

Nyala Studio ships with a built-in demo SQLite database that lets a new
user reach a runnable query in under a minute.

- On first launch (or on demand), the workbench calls the
  `sql_bootstrap_demo` Tauri command, which seeds
  `<data_dir>/nyala-studio/demo.db` with a `users` table (5 rows) and an
  `orders` table (5 rows joined to users), then registers and opens a
  `Demo (SQLite)` profile (id `demo-sqlite`) in both connection runtimes.
  The visible metadata tree and query path currently use V1; V2 is kept in
  sync as an explicit compatibility bridge until the connection stacks merge.
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
gates on pushes to `mvp` and pull requests targeting `mvp`.

```bash
pnpm run lint
pnpm run build
pnpm run rust:fmt
pnpm run rust:check
pnpm run rust:clippy
pnpm run test
```

Prepare and validate a release version with the repository scripts:

```bash
pnpm run release:prepare -- 0.0.1-dev.0
pnpm run release:check -- 0.0.1-dev.0
```

`release:prepare` updates `package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`, and the Cargo lock metadata together. The Release
workflow can then be dispatched from the protected `mvp` branch or triggered
by a matching `v*` tag. It runs the SQL MVP gate, builds macOS, Windows, and
Linux installers, generates `SHA256SUMS.txt`, and publishes a GitHub Release.
Prerelease versions such as `0.0.1-dev.0` are published as GitHub pre-releases
and never replace the stable R2 `latest` channel.

Windows versions that cannot be represented by WiX/MSI, including named
prereleases such as `0.0.1-dev.0`, are packaged as NSIS installers only.
MSI and NSIS are both built when the SemVer value satisfies WiX's numeric
version limits.

Platform signing and Cloudflare R2 deployment are optional. When their
repository secrets are absent, development pre-releases still publish
unsigned GitHub installation packages and state that limitation in the
release notes. Production releases should configure signing before promotion.

`pnpm run test` is a chain that runs the branding and application-icon guards,
the runtime status consistency check, the demo data-directory suite, the Rust
`cargo test --lib` suite (currently 210 passing tests plus 2 ignored live
integration test), the Tauri search cancellation suite, and every
per-subsystem frontend suite (`test:icons`, `test:seed-demo`, `test:search`,
`test:sql-services`, `test:sql-domain`, `test:sql-connections`,
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
The implemented deliverable includes the demo seed, real Welcome ViewPane,
separate Data Sources and Connectors workbench surfaces, transient MySQL
Preview command, Connect form validation, and CI release gate.
MySQL validation sends `{ input, secret }` directly to the dedicated Tauri
command and never creates or saves a temporary profile. The Windows/Tauri
Demo-to-query walkthrough was recorded green on 2026-07-26, and the opt-in
live MySQL Preview command validation passed against an isolated MySQL 8
instance on 2026-07-27. The corresponding native WebView Validate click
against a live MySQL instance is still an unrecorded Phase 08 acceptance item.

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

The SQL Workspace Agent follows the same boundary: Workbench UI is a service
and contribution, while the proposed Agent loop, policy, tool execution and
evidence handling stay in the local Tauri Rust runtime. See the
[`SQL Workspace Agent design`](./docs/sql-workspace-agent-design.md).

## Upstream Attribution

Nyala Studio is based on SideX, which is a Tauri port of Code - OSS / VS Code workbench concepts.

The upstream project and Code - OSS are MIT licensed. See `LICENSE` for details.
