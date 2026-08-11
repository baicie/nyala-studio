# SQL Workspace Agent A1.1 Implementation Plan

> **Status:** In progress
>
> **Date:** 2026-08-11
>
> **Baseline:** `mvp` at `1dca498f`
>
> **Target branch:** `codex/feat-sql-agent-schema-adapter`
>
> Parent design: [`sql-workspace-agent-design.md`](./sql-workspace-agent-design.md)

## Goal

Define the first local Rust `SqlCoreAdapter` boundary for Agent metadata. The
adapter accepts one opaque workspace connection id, derives runtime and metadata
capabilities, and returns schema context without exposing whether the underlying
handle belongs to the V1 query store or V2 connection manager.

A1.1 is a metadata-only compatibility slice. It does not execute SQL, call
models, register Tauri commands, add frontend services, or implement A1.2
search/cache/budget behavior.

## Architecture Decisions

- V2 `ConnectionManager` is the authoritative metadata source for A1. It already
  owns the shared `SqlConnection` metadata contract and structured errors.
- A V2-only SQLite connection may provide Suggest-only schema context. Query
  execution is outside A1.1 and remains unavailable until A3 validates a V1
  execution binding.
- When a same-id V1 connection is open, the adapter validates driver, read-only
  mode, and SQLite file identity before returning metadata. Equal ids alone are
  never treated as proof that both stores target the same database.
- A dual-store in-memory SQLite binding is rejected because each store owns a
  different database. A V2-only in-memory connection remains valid for metadata.
- MySQL remains Preview and its V2 probe metadata is explicitly unsupported.
  Empty probe vectors must never be presented as evidence that a database has no
  objects. PostgreSQL remains Planned and not openable.
- The trait stays synchronous and object-safe. Existing metadata calls are
  blocking; future async command/tool boundaries will use `spawn_blocking`.
- No new dependency, connection manager, driver abstraction, secret flow, IPC,
  capability permission, query/explain path, or frontend type is introduced.

## Dependency Graph

```text
V1 safe open-connection identity
              |
              v
V2 profile/open-state + runtime truth
              |
              v
private validated connection binding
              |
       +------+------+
       v             v
runtime capability  schema context
```

## Task 1: Expose Safe V1 Connection Identity

**Description:** Add a crate-local `SqlConnectionStore` lookup that returns only
the public, secret-free `SqlConnection` identity for an open connection.

**Acceptance criteria:**

- [ ] A known open id returns its public connection identity.
- [ ] Missing and blank ids return structured `SqlCommandError` values.
- [ ] No runtime handle, pool, interrupt handle, password, or persisted secret is exposed.

**Verification:**

- [ ] Focused state tests pass: `cd src-tauri && cargo test --lib open_connection_info`
- [ ] Rust formatting is clean: `pnpm run rust:fmt`

**Dependencies:** None.

**Files likely touched:**

- `src-tauri/src/commands/sql/state.rs`

**Estimated scope:** Small.

## Task 2: Define Adapter And Capability Contract

**Description:** Add the Agent module, object-safe `SqlCoreAdapter` trait,
secret-free capability DTOs, and a local implementation backed by the existing
V2 manager plus optional validated V1 identity.

**Acceptance criteria:**

- [ ] Public adapter inputs and outputs contain one workspace connection id and no store ids.
- [ ] SQLite reports Stable schema-context support.
- [ ] MySQL reports Preview with explicit unsupported metadata; PostgreSQL is not promoted.
- [ ] Missing/closed V2 profiles and mismatched dual-store targets fail closed.

**Verification:**

- [ ] Focused adapter capability tests pass: `cd src-tauri && cargo test --lib sql_core_adapter`
- [ ] Capability serialization contains no secret, host, username, path, or store-version fields.

**Dependencies:** Task 1.

**Files likely touched:**

- `src-tauri/src/commands/sql/agent/mod.rs`
- `src-tauri/src/commands/sql/agent/core_adapter.rs`
- `src-tauri/src/commands/sql/mod.rs`

**Estimated scope:** Medium.

## Task 3: Return Typed Schema Context

**Description:** Implement scoped schema, table, and column retrieval through the
validated V2 connection and map existing metadata DTOs into Agent-owned context
types.

**Acceptance criteria:**

- [ ] A file-backed SQLite fixture returns `main`, seeded tables, and ordered columns.
- [ ] V2-only SQLite works; a compatible same-id V1 handle also works.
- [ ] Same-id connections targeting different files and dual-store `:memory:` fail closed.
- [ ] Unsupported MySQL metadata returns a structured error rather than empty success.

**Verification:**

- [ ] SQLite and MySQL fake-driver tests pass without a live database server.
- [ ] Adapter results serialize without `profileId`, `legacyConnectionId`, password, or URI fields.

**Dependencies:** Task 2.

**Files likely touched:**

- `src-tauri/src/commands/sql/agent/core_adapter.rs`

**Estimated scope:** Medium.

## Checkpoint: A1.1 Complete

- [ ] `cd src-tauri && cargo test --lib sql_core_adapter` passes.
- [ ] `pnpm run rust:fmt` passes.
- [ ] `pnpm run rust:check` passes.
- [ ] `pnpm run rust:clippy` passes with `-D warnings`.
- [ ] `pnpm run test:rust` passes.
- [ ] `pnpm run test` passes end to end.
- [ ] Changed Markdown passes targeted Prettier check.
- [ ] `git diff --check` passes.
- [ ] Parent design marks only A1.1 complete; A1.2 and A2+ remain unchecked.

## Risks And Mitigations

| Risk                                            | Impact | Mitigation                                                                                                       |
| ----------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| Equal ids point to different databases          | High   | Compare public driver, read-only mode, and canonical SQLite file identity before accepting a dual-store binding. |
| MySQL probe emptiness becomes false evidence    | High   | Capability is explicit `Unsupported`; retrieval returns a structured error.                                      |
| Adapter leaks credentials or connection targets | High   | Inputs use opaque ids; outputs omit host/user/path; serialization tests use a secret canary.                     |
| A1.1 grows into query/runtime work              | Medium | Keep execute/explain, Agent loop, IPC, cache/search, and result data outside this branch.                        |
| Blocking metadata stalls an async runtime       | Medium | Keep adapter synchronous; future Tauri/tool boundary owns `spawn_blocking`.                                      |

## Known Ceiling

V1-only connections are not metadata-capable through this adapter because A1.1
does not guess or synthesize a V2 profile. A V2-only connection can support
Suggest-only metadata, but it has no implied query binding. A3 must require a
separately validated V1 execution identity or a completed V2 execute contract
before any SQL can run.
