# SQL Workspace Agent A5 Implementation Plan

> **Status:** Implemented (automated checkpoint complete)
>
> **Date:** 2026-08-17
>
> **Baseline:** `codex/feat-sql-agent-schema-adapter` at `63698263`
>
> Parent design: [`sql-workspace-agent-design.md`](./sql-workspace-agent-design.md)

## Goal

Deliver a SQLite-only Query Optimization workflow that grounds every suggestion
in bounded index metadata and typed `EXPLAIN QUERY PLAN` evidence. The workflow
compares an original read-only statement with a parsed rewrite, returns a
stale-safe editor artifact, and explicitly reports uncertainty when plans are
not comparable.

A5 is a post-vNext differentiator. It does not complete MVP vNext, alter the
Zeus `NO-GO`, satisfy Checkpoint W, or unblock R0. The user authorized selecting
and starting the next large development task on 2026-08-17 after those external
blockers were recorded.

## Architecture Decisions

- Extend the existing V2 `SqlConnection` metadata boundary and
  `SqlCoreAdapter`; do not add a driver, connection manager, or direct
  `rusqlite` dependency under the Agent module.
- Support only Stable SQLite. MySQL stays Preview with explicit unsupported
  index/plan comparison evidence, and PostgreSQL stays Planned.
- Enforce hard table, index, column, and serialized-byte caps in the SQLite
  driver, then validate the same contract again at the Agent adapter boundary.
- Treat indexes and plans as typed evidence. Model text cannot claim a speedup,
  invent an index, or turn incomparable plan shapes into a performance result.
- Keep Optimize in Read Only mode. It may call metadata, static parse, and
  explain tools, but it never calls query execution or exposes result rows.
- Reuse the editor identity/version artifact guard from A4. A rewrite is never
  auto-applied and stale context remains a visible diff.
- Add no dependency and do not modify Cargo or pnpm lockfiles.

## Dependency Graph

```text
bounded SQLite index snapshot
              |
              v
SqlCoreAdapter index context
              |
              v
index.list policy + evidence
              |
              v
normalized old/new explain plans
              |
              v
deterministic Optimize skill
              |
              v
stale-safe Workbench artifact
```

## Task 1: Bounded SQLite Index Metadata

**Description:** Add driver-owned index DTOs and a bounded SQLite snapshot,
then expose the validated data through the existing `SqlCoreAdapter`.

**Acceptance criteria:**

- [x] Named, unique, partial, composite, and implicit SQLite indexes have stable typed identities and ordered columns.
- [x] Table, index, column, and byte caps stop driver reads before crossing a hard limit and report truncation.
- [x] The adapter rejects malformed or oversized driver snapshots and returns explicit unsupported capability for MySQL/PostgreSQL.

**Verification:**

- [x] `cd src-tauri && cargo test --lib index_ -- --nocapture` (`20/20`, 2026-08-17).
- [x] `cd src-tauri && cargo test --lib core_adapter -- --nocapture` (`41/41`, 2026-08-17).

**Dependencies:** A3 and the existing A1 metadata adapter.

**Files likely touched:**

- `src-tauri/src/commands/sql/metadata_v2.rs`
- `src-tauri/src/commands/sql/driver_registry.rs`
- `src-tauri/src/commands/sql/agent/index_context.rs`
- `src-tauri/src/commands/sql/agent/core_adapter.rs`
- `src-tauri/src/commands/sql/agent/mod.rs`

**Estimated scope:** Medium.

## Task 2: Authorize And Execute `index.list`

**Description:** Register the canonical metadata tool, enforce backend-owned
capabilities, and store bounded index evidence without query calls.

**Acceptance criteria:**

- [x] `index.list` requires `database.readMetadata`, a non-empty opaque connection id, SQLite dialect, and a bounded table scope.
- [x] Suggest Only and Read Only callers cannot forge capabilities, rows, secrets, or unbounded limits.
- [x] Tool evidence is typed, revision-bound, byte-accounted, and zero-query.

**Verification:**

- [x] `cd src-tauri && cargo test --lib policy -- --nocapture` (`15/15`, 2026-08-17).
- [x] `cd src-tauri && cargo test --lib suggest_only -- --nocapture` (`13/13`, 2026-08-17).
- [x] `cd src-tauri && cargo test --lib read_only_composite_index_list -- --nocapture` (`1/1`, 2026-08-17).
- [x] `cd src-tauri && cargo test --lib optimize_backend_grant -- --nocapture` (`1/1`, 2026-08-17).
- [x] `pnpm run test:sql-agent` (`213` Rust Agent + `2` frontend capability tests, 2026-08-17).

**Dependencies:** Task 1.

**Files likely touched:**

- `src-tauri/src/commands/sql/agent/policy.rs`
- `src-tauri/src/commands/sql/agent/runtime.rs`
- `src-tauri/src/commands/sql/agent/evidence.rs`
- `src-tauri/src/commands/sql/agent/model.rs`
- `src-tauri/src/commands/sql/agent/bridge.rs`

**Estimated scope:** Medium.

## Checkpoint: Index Evidence

- [x] Tasks 1-2 focused tests pass.
- [x] `pnpm run rust:fmt`, `pnpm run rust:check`, and `pnpm run rust:clippy` exit 0 (2026-08-17).
- [x] SQLite maturity and the MySQL/PostgreSQL status contract are unchanged.

## Task 3: Normalize SQLite Explain Plans

**Description:** Convert SQLite `EXPLAIN QUERY PLAN` rows into bounded typed
nodes and compare only evidence fields with stable semantics.

**Acceptance criteria:**

- [x] Plan fixtures normalize scans, index searches, joins, temporary B-trees, and unknown detail without parsing fabricated costs.
- [x] Original and rewritten plans use the same connection, metadata revision, dialect, and normalization version.
- [x] Missing, truncated, or structurally incomparable plans return `uncertain`, never `improved`.

**Verification:**

- [x] `cd src-tauri && cargo test --lib plan::tests -- --nocapture` (`34/34`, 2026-08-17).
- [x] Existing read-only explain coverage remains green in `pnpm run test:sql-agent` (`261/261` Rust Agent tests, 2026-08-17).

**Dependencies:** Task 1.

**Files likely touched:**

- `src-tauri/src/commands/sql/agent/plan.rs`
- `src-tauri/src/commands/sql/agent/read_only.rs`
- `src-tauri/src/commands/sql/agent/core_adapter.rs`
- `src-tauri/src/commands/sql/agent/mod.rs`

**Estimated scope:** Medium.

## Task 4: Deterministic Optimize Skill

**Description:** Implement the fixed old-analysis/index/old-plan/rewrite/parse/
new-plan/compare sequence and produce a SQL artifact only after every contract
check succeeds.

**Acceptance criteria:**

- [x] The rewrite is a single SQLite `ReadOnly` statement and matches its parsed evidence exactly.
- [x] The run records original analysis, index capability, both plans, comparison, and uncertainty reason.
- [x] The run records exactly two `sql.explain` calls, zero `sql.execute_readonly` calls, and zero result rows; no model response can skip or reorder required tools.

**Verification:**

- [x] `cd src-tauri && cargo test --lib optimize::tests -- --nocapture` covers success, missing index support, combined uncertainty, incomparable plans, cancellation, budget exhaustion, and illegal tool order (`9/9`, 2026-08-17).
- [x] Real bridge coverage records two revision-bound plans, typed terminal evidence, zero rows, and no execute call (`1/1`, 2026-08-17).
- [x] `pnpm run test:sql-agent` passes (`261/261` Rust Agent + `2/2` frontend capability tests, 2026-08-17).

**Dependencies:** Tasks 2-3.

**Files likely touched:**

- `src-tauri/src/commands/sql/agent/model.rs`
- `src-tauri/src/commands/sql/agent/runtime.rs`
- `src-tauri/src/commands/sql/agent/bridge.rs`
- `src-tauri/src/commands/sql/agent/evidence.rs`

**Estimated scope:** Medium.

## Task 5: Stale-Safe Workbench Optimize Artifact

**Description:** Route the existing Optimize action through the A5 runtime and
reuse A4 editor identity/version checks when presenting or applying the draft.

**Acceptance criteria:**

- [x] Optimize submits opaque connection id, editor identity/version, and SQL; it never submits frontend metadata or rows.
- [x] The panel exposes plan comparison and uncertainty evidence.
- [x] Stale context detected before presentation removes Apply; identity, version, or baseline changes before write prevent overwrite, while Open draft remains available.

**Verification:**

- [x] `pnpm run test:sql-services` (`105/105`), `pnpm run test:sql-editor` (`77/77`), and `pnpm run test:sql-advanced` (`97/97`) pass (2026-08-17).
- [x] `pnpm run lint` and `pnpm run build` exit 0 (2026-08-17).

**Dependencies:** Task 4.

**Files likely touched:**

- `src/vs/workbench/contrib/sqlAdvanced/browser/sqlAdvancedActions.ts`
- `src/vs/workbench/services/sql/common/sqlAgent.ts`
- `src/vs/workbench/services/sql/browser/sqlAgentService.ts`
- focused service/editor/action tests

**Estimated scope:** Medium.

## Completion Checkpoint

- [x] All five task acceptances have direct automated evidence.
- [x] `pnpm run test:sql-agent` and relevant frontend suites exit 0.
- [x] `pnpm run rust:fmt`, `rust:check`, and `rust:clippy` exit 0.
- [x] `pnpm run lint` and `pnpm run build` exit 0.
- [x] Changed files pass targeted Prettier and `git diff --check`.
- [x] vNext roadmap records A5 as implemented but non-blocking and keeps Z2 prohibited.

## Risks And Mitigations

| Risk                                          | Impact | Mitigation                                                             |
| --------------------------------------------- | ------ | ---------------------------------------------------------------------- |
| Index metadata grows with schema size         | High   | Driver hard caps, adapter revalidation, stable truncation semantics.   |
| SQLite plan text is mistaken for a cost model | High   | Normalize only stable operations; default comparison to `uncertain`.   |
| Optimize silently executes a query            | High   | Fixed tool order excludes execute; assert zero query calls end to end. |
| Model invents index or plan facts             | High   | Final response must cite typed index/plan evidence refs.               |
| A5 is reported as vNext completion            | Medium | Keep this plan separate and preserve blocked vNext status.             |
| Dirty vNext work is mixed into A5             | Medium | Touch only task-owned files and report the mixed worktree explicitly.  |

## Known Ceiling

SQLite `EXPLAIN QUERY PLAN` is qualitative. It does not expose a stable numeric
cost that proves runtime improvement, and this stage does not execute benchmark
queries. A5 can show typed structural changes and grounded recommendations; it
must label actual performance impact as unverified until a separate, explicitly
approved measurement workflow exists.

Terminal evidence therefore remains `semanticsVerified=false` and
`performanceVerified=false`; A5 does not claim semantic equivalence or measured
speedup, including when the structural comparison is `structurally_improved`.
