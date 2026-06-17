# SQL Studio Next

SQL Studio Next is a VS Code-like SQL workbench built on a Tauri-based workbench shell.

The project is a product hard fork of SideX. The goal is not to build a generic code editor. The goal is to build a local-first database workbench with:

- SQL connections
- SQL editor
- query result panel
- database metadata explorer
- future SQL extension system
- future AI-assisted diagnosis and query workflow

## Current Status

This repository is currently in the fork stabilization phase.

The immediate MVP target is:

```txt
Launch app
  -> show SQL Studio branded workbench
  -> add/open SQLite connection
  -> list database tables
  -> open SQL editor
  -> execute SELECT query
  -> show result in panel
```

## Roadmap

### Phase 1 — Product Branding

- Rename app metadata to SQL Studio Next
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

Do not build SQL Studio as a React Router-style SPA. This project should keep the VS Code-style Workbench model:

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

SQL Studio Next is based on SideX, which is a Tauri port of Code - OSS / VS Code workbench concepts.

The upstream project and Code - OSS are MIT licensed. See `LICENSE` for details.
