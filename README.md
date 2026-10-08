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

Nyala Studio has completed its Core SQL MVP and is now executing the MVP vNext
track (SQL Workspace Agent plus a gated Zeus Data Grid Preview).

Core MVP:

- Phases 00–08 are implemented at P0 scope, and the 10-item Definition of Done
  was met on commit `60ab89c0`
  (`docs/sql-mvp-phases/phase-do-d-verification.md`).
- The Phase 08 native Demo walkthrough and the live MySQL Preview Validate were
  recorded complete on `mvp@1dca498f` (2026-08-11).

MVP vNext
([roadmap](./docs/sql-mvp-phases/mvp-vnext-agent-zeus-roadmap.md)):

- Agent A0–A4 are implemented, including the Rust Suggest-only runtime, the
  explicitly read-only SQLite execution loop, and the Workbench SQL Agent
  Panel; Checkpoint R is complete. A4 Checkpoint W still needs native keyboard,
  Windows WebView2, and real VoiceOver/Narrator walkthroughs.
- The post-vNext A5 SQLite query-optimization slice is implemented and stays
  outside the vNext release dependency chain.
- Zeus Z1.3 is `NO-GO`: revision-bound macOS WKWebView and Windows WebView2
  evidence, screenshots, and the fresh structured bundle audit exist, but five
  pre-registered measurement-contract v6 performance gates still fail. There is
  no production Zeus dependency or renderer integration, and Z2 must not start.
  The v7 floor-aware metric contract in
  [ADR 0004](./docs/adr/0004-zeus-data-grid-v7-floor-aware-metrics.md) is
  `Proposed` and is not admission evidence.
- R0 (vNext release gate) stays `NO-GO` until A4 Checkpoint W and the Zeus gate
  pass and the protected attestation environments exist.

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

The Core MVP target (met on `60ab89c0`) is:

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

The historical fork-stabilization phases have moved into the SQL MVP
productization track, and the Core Phase 00–08 sequence is met. The active
roadmap is the Core MVP + MVP vNext index in
[`docs/sql-mvp-phases/README.md`](./docs/sql-mvp-phases/README.md); the vNext
implementation order and acceptance contracts live in
[`docs/sql-mvp-phases/mvp-vnext-agent-zeus-roadmap.md`](./docs/sql-mvp-phases/mvp-vnext-agent-zeus-roadmap.md).
The Core MVP sequence below is kept as the historical record:

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

### MVP vNext — SQL Workspace Agent + Zeus Data Grid

```txt
A0/A1 → A2 → A3 → A4 ─┐
Z0 → Z1 ───────────────┤
                        └→ Z2 → R0
```

- **A0 SQL Intelligence** — A0.1 done; A0.2 recorded a parser No-Go
  ([ADR 0003](./docs/adr/0003-sql-agent-parser-boundary.md)), so the local
  fail-closed analyzer stays the trusted boundary.
- **A1 Schema Context** — A1.1–A1.3 done: bounded schema search, SQLite
  foreign-key graph, cache and invalidation.
- **A2 Suggest-only Runtime** — A2.1–A2.4 done: runtime domain, Rust
  capability policy, deterministic loop, Workbench/Tauri bridge; zero query
  calls.
- **A3 Read-only Agent** — A3.1/A3.2 done: SQLite `sql.explain` /
  `sql.execute_readonly` against an explicitly read-only connection, with
  bounded result shape, aggregate and sample policy; rows stay out of default
  evidence.
- **A4 Workbench Integration** — A4.1/A4.2 done: stale-safe editor artifacts,
  Schema/Result/Fix actions, and the SQL Agent Panel. Checkpoint W is still
  open on native keyboard, Windows WebView2, and VoiceOver/Narrator evidence.
- **A5 SQLite Query Optimization** — implemented as a post-vNext slice; it is
  not a vNext release dependency. See
  [`docs/sql-workspace-agent-a5-implementation-plan.md`](./docs/sql-workspace-agent-a5-implementation-plan.md).
- **Z0/Z1/Z2** — Z0 evaluation complete; Z1.3 `NO-GO`; Z2 must not start.
- **R0** — vNext release gate `NO-GO`.

The post-MVP evolution from the deterministic AI Helper to a local-first SQL
Workspace Agent is specified in
[`docs/sql-workspace-agent-design.md`](./docs/sql-workspace-agent-design.md)
and implemented through A4.2, with the A5 query-optimization slice landed as
post-vNext work. Its `A0-A8` Agent Stages (`A6`–`A8` remain outside the first
milestone) are not SQL MVP Phase numbers and do not change the Phase 08 or
driver-runtime status.

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
pnpm run release:prepare -- <next-semver>
pnpm run release:check -- <next-semver>
```

`release:prepare` updates `package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`, and the Cargo lock metadata together. The Release
workflow can then be dispatched from the protected `mvp` branch or triggered
by a matching `v*` tag. It runs the SQL MVP gate, builds macOS, Windows, and
Linux installers, generates `SHA256SUMS.txt`, and publishes a GitHub Release.
Prerelease versions such as the current `0.0.1-dev.1` are published as GitHub
pre-releases and never replace the stable R2 `latest` channel.

Windows versions that cannot be represented by WiX/MSI, including named
prereleases such as `0.0.1-dev.1`, are packaged as NSIS installers only.
MSI and NSIS are both built when the SemVer value satisfies WiX's numeric
version limits.

Platform signing and Cloudflare R2 deployment are optional. When their
repository secrets are absent, development pre-releases still publish
unsigned GitHub installation packages and state that limitation in the
release notes. Production releases should configure signing before promotion.

`pnpm run test` is the full local gate. It runs the release-version and GitHub
workflow checks, the Nyala branding and application-icon guards, the SQL
runtime-status consistency check, the demo data-directory suite, the Rust
`cargo test --lib` suite (534 passing tests plus 2 ignored live-integration
tests as of 2026-09-17), the SQL Agent Rust/TS suite, the Zeus result-grid
benchmark, WebDriver, audit, platform-evidence, gate, attestation and visual
harnesses, the Agent Workbench visual and Checkpoint W capture contracts, the
vNext release gate, the search-cancellation and preferences regression suites,
and every per-subsystem SQL frontend suite (`test:sql-services`,
`test:sql-domain`, `test:sql-connections`, `test:sql-editor`,
`test:sql-result`, `test:sql-history`, `test:sql-product`,
`test:sql-advanced`).

The MVP vNext gates keep their own fail-closed scripts and checked-in reports:
`pnpm run verify:sql-result-grid-gate`
([`phase-z1-gate.json`](./docs/sql-mvp-phases/phase-z1-gate.json)),
`pnpm run verify:sql-mvp-vnext-release`
([`phase-vnext-release-gate.json`](./docs/sql-mvp-phases/phase-vnext-release-gate.json)),
and the Checkpoint W verifier
([`phase-a4-checkpoint-w.json`](./docs/sql-mvp-phases/phase-a4-checkpoint-w.json)).
All three reports are currently `NO-GO`; see
[`docs/sql-mvp-phases/README.md`](./docs/sql-mvp-phases/README.md) for the
blocking checks.

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
instance on 2026-07-27. The native Tauri WebView Validate click against an
isolated live MySQL instance was recorded green on 2026-08-11; it returned the
success report and query cancellation warning, with no validation tables left
behind.

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
│           ├── contrib/          # sqlConnections / sqlEditor / sqlResult /
│           │                     # sqlHistory / sqlAdvanced / sqlProduct /
│           │                     # sqlAgent
│           └── services/sql/     # SQL services and shared contracts
├── src-tauri/
│   └── src/
│       ├── commands/sql/
│       │   ├── agent/            # SQL Workspace Agent runtime
│       │   └── ...               # connections, metadata, query, drivers
│       ├── runtime_status/       # driver maturity truth-of-record
│       ├── product.rs
│       ├── lib.rs
│       └── main.rs
├── crates/
├── docs/
│   ├── sql-mvp-phases/           # phase docs, verification and gate reports
│   └── adr/                      # architecture decision records
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
and contribution, while the Agent loop, policy, tool execution and
evidence handling stay in the local Tauri Rust runtime
(`src-tauri/src/commands/sql/agent/`). Agent drafts never execute on their own:
suggest-only runs stay at zero query calls, and only an explicit Read Only mode
on an explicitly read-only SQLite connection can run a single read-only
statement. See the
[`SQL Workspace Agent design`](./docs/sql-workspace-agent-design.md) and the
[`A5 implementation plan`](./docs/sql-workspace-agent-a5-implementation-plan.md).

Zeus is a leaf dependency: if Z2 is ever approved, `@zeus-web/data-grid` may
only be loaded from inside the SQL Result contribution, must stay exact-pinned,
and must retain the native renderer fallback. The current Z1.3 decision is
`NO-GO`, so no production Zeus dependency exists.

## Upstream Attribution

Nyala Studio is based on SideX, which is a Tauri port of Code - OSS / VS Code workbench concepts.

The upstream project and Code - OSS are MIT licensed. See `LICENSE` for details.
