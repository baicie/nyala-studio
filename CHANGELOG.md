# Changelog

All notable changes to Nyala Studio are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once a public Tauri build is published.

## [Unreleased]

### Planned

- Transient-open API for the MySQL Preview validation profile
  (Phase 08 §2.5 follow-up; today the v2 connection service
  upserts every opened profile).
- Editor-area `Welcome` content as an `EditorInput` so the
  welcome surface is reachable from the editor tab strip
  instead of the SQL Results panel.
- Phase 09 — `PostgreSQL Preview` driver on the same runtime
  status table.
- Capability schema unification across the `plugin` /
  `agent` / `ai` contribution surfaces (already landed for
  the help view in Phase 06).

## [0.1.0] - 2026-07-05

The first end-to-end MVP build. App launches as **Nyala Studio**
(not SideX / SQL Studio), opens a local SQLite demo database,
runs `SELECT 1`, and shows the result in a panel. Phase 00–08
are all green at this tag.

### Added

- **Branding** — `productName`, identifier, window title, and
  bundle metadata now resolve to **Nyala Studio**. The SideX
  updater endpoint is no longer referenced anywhere in the
  repo.
- **Runtime status table** — `RuntimeStatus` and `DriverId`
  drive a single source of truth that every subsequent phase
  consumes (`docs/sql-mvp-phases/phase-00-runtime-status.md`).
- **Connections MVP** — `sql_test_connection_v2`,
  `sql_open_connection_v2`, `sql_close_connection_v2`,
  `sql_list_connections_v2`, `sql_upsert_connection_v2`,
  `sql_forget_secrets`. Profiles persist to
  `<DATA>/sql-studio-next/saved-connections.json` and never
  carry a plaintext password; secrets live only in the
  in-memory manager.
- **Metadata Explorer** — three-level tree of
  schemas / tables / columns with per-node error and refresh,
  routed through the new `ISqlMetadataServiceV2`.
- **SQL Editor** — `SqlEditorInput` + `SqlEditorPane` +
  serializer + commands. Submits `SELECT` queries with
  `Ctrl+Enter` and `Shift+Enter` for selection.
- **Result Panel** — `SqlResultsView` + `SqlResultsModel` with
  the four explicit states
  (columns-rows / affected-only / elapsed / error) and a
  guarded `execute first 100 rows` cap.
- **History + Formatter + Snippets + Explain** — local-only,
  deterministic, capped at 100 entries.
- **AI Helper foundation** — `ISqlAiService` with a
  deterministic provider and a Capability Guard; the helper
  can only suggest, never auto-execute.
- **Plugin API MVP** — 13 contribution points + a local-only
  loader; no marketplace, no remote install.
- **SQLite Demo Bootstrap** —
  `sql_bootstrap_demo` Tauri command seeds
  `<DATA>/nyala-studio/demo.db` with `users` and `orders`
  tables and registers the connection as `Demo (SQLite)` on
  first launch.
- **MySQL Preview opt-in validation** —
  `sql_validate_mysql_preview` runs a CREATE / INSERT /
  SELECT / DROP round-trip against an open MySQL Preview
  connection. Fronted by `MysqlPreviewValidationController`
  + `IMysqlPreviewValidator`. Warnings surface in the
  UI; the Rust command returns a structured
  `MysqlValidationReportDto`. The transient profile is left
  open so a follow-up query can reuse credentials.
- **Welcome pane** — `SqlProductWelcomePane` renders four
  starting tiles (open demo / add connection / browse
  history / show shortcuts) in the SQL Results panel.
  `mapWelcomeActionToCommandId` is the pure routing table.
  Auto-open on first launch is gated by the existing
  `openWelcomeQueryOnFirstLaunch` preference.
- **Preferences** — `restoreSqlLayoutOnStartup`,
  `openWelcomeQueryOnFirstLaunch`,
  `restoreEditorDraftsOnStartup`, `autoSaveEditorDrafts`,
  `resultMaxRows`, `maxRestoredEditorDrafts`,
  `defaultQuery`. Toggle commands live in the command
  palette.
- **Release Readiness docs** — root `README.md` documents the
  local-green check sequence and the optional opt-in
  `test:mysql-integration` harness.

### Test inventory (green at this tag)

```
pnpm run rust:fmt            # cargo fmt --all -- --check
pnpm run rust:check          # cargo check
pnpm run rust:clippy         # cargo clippy --all-targets -- -D warnings
pnpm run test:rust           # 157 passed, 1 ignored (live MySQL probe)
pnpm run test:sql-runtime-status  16/16
pnpm run test:sql-services         62/62
pnpm run test:sql-domain           20/20
pnpm run test:sql-connections      93/93
pnpm run test:sql-editor           59/59
pnpm run test:sql-result           57/57
pnpm run test:sql-history          27/27
pnpm run test:sql-product          51/51
pnpm run test:sql-advanced         63/63
pnpm run lint                # exit 0, 0 warnings
pnpm run build               # exit 0
```

### Known gaps (intentional, follow-up tracked above)

- `pnpm run test:mysql-integration` requires a real MySQL at
  `127.0.0.1:3306`; the live probe is `#[ignore]` in
  `mysql_runtime.rs` and runs only when the
  `NYALA_TEST_MYSQL_*` env vars are set.
- The PostgreSQL driver is a stub that refuses to open. It
  exists only to keep the runtime-status table honest.
- The MySQL Preview validation profile is *transient* in
  semantics but not in storage; the v2 connection service
  upserts every opened profile until a true transient-open
  API lands (tracked in `phase-08-mvp-packaging.md §2.5`).
- `Welcome` is a panel-docked view, not an editor-area
  `EditorInput`. A future `SqlProductWelcomeInput` can
  re-use the same model + routing table.

### Migration notes

- Saved connection profiles written by earlier pre-MVP builds
  are still readable. Passwords continue to be optional;
  empty / missing password means the manager will prompt at
  `open()` time.
- Demo database created by `sql_bootstrap_demo` is stored at
  `<DATA>/nyala-studio/demo.db` per the Phase 08 README
  spec; deleting this file and the
  `sqlStudio.product.bootstrapped` storage key triggers a
  fresh demo on next launch.

[Unreleased]: https://github.com/baicie/nyala-studio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/baicie/nyala-studio/releases/tag/v0.1.0