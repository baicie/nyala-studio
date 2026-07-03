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

### Phase 1 — Product Branding

- Rename app metadata to Nyala Studio
- Replace Tauri product name and bundle identifier
- Remove upstream updater endpoint
- Replace visible SideX menu labels
- Replace local app data database filenames
- Add branding regression tests

### Phase 2 — SQL Rust Commands

- Add SQLite connection command bridge
- Add query execution command
- Add table and column metadata commands
- Add structured SQL error model

### Phase 3 — SQL Workbench Services

- Add `ISqlConnectionService`
- Add `ISqlMetadataService`
- Add `ISqlQueryService`
- Route all SQL frontend operations through services

### Phase 4 — SQL Connections View

- Add SQL activity bar entry
- Add connection tree
- Add SQLite connection flow
- Add table metadata expansion

### Phase 5 — SQL Editor

- Add SQL editor input
- Add SQL editor pane
- Add execute query command
- Add Cmd/Ctrl + Enter shortcut

### Phase 6 — Query Result Panel

- Add result panel
- Add simple result grid
- Add messages and error display
- Add elapsed time and row count

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
