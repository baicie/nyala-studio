# SQL Workbench Refinement Spec

## Objective

Refine Nyala Studio's connection and query workflow using the interaction patterns proven by DBeaver and DataGrip while preserving the SideX / VS Code workbench architecture.

The primary user is a developer or data operator who needs to create a data source, verify it, browse metadata, run SQL, and inspect results without leaving the workbench.

## Current Implementation Status

The refinement slices are implemented on `refine-windows-icon-connectors` as of 2026-08-07:

- The new-data-source flow opens a native modal editor with All / Embedded / Server categories, search, connector icons, SQLite Stable, MySQL Preview, and disabled PostgreSQL Planned states.
- SQLite and MySQL use the existing service contracts for Test, MySQL Preview Validate, Save, Connect, and transient secret handling. A signed, pinned-host native boundary can cache verified MySQL/PostgreSQL JDBC JARs; cached packages are not loaded and do not change runtime maturity.
- Data Sources provides searchable saved/open profiles with status-safe targets and Connect, Edit, Test, New Query, Refresh, Disconnect, and confirmed Delete actions. The existing Connectors activity remains as a catalogue shortcut and opens the same modal flow.
- SQL execution and results support current / selection / all execution, cancellation, structured errors, empty and NULL states, scrolling, result snapshots, multi-statement result activation, responsive toolbar wrapping, and keyboard navigation for result history.

Phase 08 remains partial because the native WebView click record for live MySQL Preview Validate is still outstanding; no claim below treats that evidence as complete.

Product terms are fixed for this work:

- **Connector / driver**: a database implementation such as SQLite, MySQL, or PostgreSQL.
- **Data source**: a user-owned saved connection profile.
- **Connection**: an open runtime session for a data source or an unsaved profile.

## Delivery Slices

1. Replace the standalone Connectors activity with a settings-style modal connection editor.
2. Add a searchable connector picker with a left category rail and distinct connector icons.
3. Reuse the existing SQLite and MySQL create, test, validate, save, and connect contracts in the modal; secrets remain transient.
4. Consolidate saved profiles and open sessions into a data-source-oriented management surface with explicit status and context actions.
5. Move metadata discovery to expandable-node loading after the V1/V2 connection contract is unified.
6. Model driver delivery truthfully as bundled, installable, unavailable, or planned. Do not expose download actions until a signed package manifest and native install boundary exist.
7. Refine SQL execution and results around a dense editor-plus-panel workflow without replacing the workbench editor or panel infrastructure.

## Runtime Scope

| Connector  | Current delivery | Runtime maturity | User action                           |
| ---------- | ---------------- | ---------------- | ------------------------------------- |
| SQLite     | Bundled          | Stable           | Create, test, save, connect           |
| MySQL      | Bundled          | Preview          | Create, test, validate, save, connect |
| PostgreSQL | Planned          | Planned          | Visible but disabled                  |

Dynamic JDBC/ODBC/custom driver loading, PostgreSQL runtime enablement, SSH tunnels, proxy settings, and persistent passwords are not part of this goal unless their native security and loading contracts are separately approved.

## Commands

```bash
pnpm run test:sql-connections
pnpm run test:sql-services
pnpm run test:sql-editor
pnpm run test:sql-result
pnpm run test:sql-product
pnpm run test:sql-runtime-status
pnpm run lint
pnpm run build
pnpm run rust:check
pnpm run test
pnpm run dev:vite
```

## Project Structure

```txt
src/vs/workbench/contrib/sqlConnections/browser/  modal editor, picker, Data Sources UI
src/vs/workbench/contrib/sqlConnections/common/   navigation and pure presentation/state models
src/vs/workbench/contrib/sqlConnections/test/     connection contribution tests
src/vs/workbench/services/sql/common/              shared contracts and SQL types
src/vs/workbench/services/sql/browser/             frontend service implementations
src-tauri/src/commands/sql/                         native connection and driver commands
docs/sql-mvp-phases/                                authoritative Phase 00-08 status
```

## Code Style

New cross-cutting behavior continues to enter through workbench services and contributions. UI listeners are disposed with the owning pane or component.

```ts
this._register(
	addDisposableListener(button, EventType.CLICK, () => {
		this.commandService.executeCommand(SQL_CONNECTIONS_ADD_COMMAND_ID);
	})
);
```

Connector availability is derived from the runtime catalog. UI labels must not upgrade a connector's maturity or imply that a cached JDBC package enables a runtime driver.

## Testing Strategy

- Pure navigation, filtering, state, status, and view-model behavior uses Node unit tests in `contrib/sqlConnections/test`.
- Rust command or driver-delivery changes require focused Rust unit tests for structured errors, redaction, validation, and lifecycle behavior.
- Each UI slice runs its granular SQL suite before build/lint checks.
- User-visible modal, responsive layout, and result-grid changes receive browser screenshots at desktop and constrained viewport sizes when the Vite preview can exercise the affected path.
- The final release claim requires `pnpm run test`, `pnpm run lint`, `pnpm run build`, and `pnpm run rust:check` with reported exit codes.

## Boundaries

### Always

- Preserve workbench editor, panel, service, contribution, context-key, and disposable conventions.
- Keep passwords transient and outside saved profiles, logs, errors, and screenshots.
- Keep SQLite stable, MySQL preview, and PostgreSQL planned until their authoritative runtime contracts change.
- Confirm destructive data-source deletion and define whether an open session is also closed.

### Requires a separate design decision

- Adding a new database driver or dependency.
- Downloading executable/native driver artifacts or broadening Tauri filesystem/network capabilities.
- Removing upstream Debug, SCM, Extensions, or Terminal subsystems.
- Persisting secrets or adding remote/team connection storage.

The Phase 08 exception is limited to the built-in Ed25519-signed package manifest, pinned HTTPS hosts, exact size/SHA-256 verification, and an app-data cache. Dynamic loading, arbitrary repositories, and runtime maturity changes still require a separately accepted design.

### Never

- Call Tauri directly from a view.
- Show a driver download button that has no working native install contract.
- Duplicate connection/result shapes outside the SQL service types.
- Rewrite the workbench boot, editor infrastructure, or result panel host.

## Success Criteria

- `Nyala: New Data Source` opens an editor with `RequiresModal`, not a sidebar form.
- The modal uses a left connector area with All, Embedded, and Server categories, search, distinct connector icons, and bundled/planned status.
- Selecting SQLite or MySQL updates one right-side connection form; PostgreSQL remains visible and disabled with a clear reason.
- Test, MySQL Validate, and Connect use the existing SQL services, retain the busy guard, clear secrets, and show structured failures.
- A successful connection closes the modal, refreshes Data Sources, and reveals the connected item.
- Saved MySQL profiles that need a password reopen the same modal in edit/connect mode.
- The existing Connectors activity remains as a catalogue shortcut after the modal flow is verified; it shares the same native modal editor as Data Sources.
- Data Sources ultimately shows one row/node per profile with idle/open/error status and Connect, Disconnect/Reconnect, Edit, Test, New Query, Refresh, and confirmed Delete actions.
- Metadata children expose retryable per-node refresh/error actions; the current V1 refresh path may prefetch column details while the lazy-loading contract is still being refined.
- Driver delivery UI exposes only states backed by native capabilities and verified artifacts.
- SQL execution and results retain existing safety rules and gain no regression in execution source, error, empty, scrolling, elapsed-time, row-count, or null rendering behavior.

## Open Questions

No blocking product choice is required for the implemented modal and curated package-cache slices. Dynamic driver loading and marketplace distribution remain gated on separately accepted runtime and trust designs.
