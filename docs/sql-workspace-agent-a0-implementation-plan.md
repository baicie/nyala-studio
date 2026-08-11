# SQL Workspace Agent A0 Implementation Plan

> **Status:** Complete
>
> **Date:** 2026-08-11
>
> **Baseline:** `mvp` at `ffb13b98`
>
> **Target branch:** `codex/feat-sql-agent-intelligence`
>
> Parent design: [`sql-workspace-agent-design.md`](./sql-workspace-agent-design.md)

## Goal

Deliver only A0 SQL Intelligence in the local Rust core: turn SQL text and the existing dialect model into a serializable `SqlAnalysis` containing statement count, statement class, risk, referenced tables, and warnings.

This slice establishes one deterministic safety vocabulary for later Agent tools. It does not expose a Tauri command or add an Agent execution path; the existing read-only guard consumes the stricter classification and therefore rejects ambiguous forms that the legacy keyword check could allow.

The user explicitly authorized A0 on 2026-08-11 while SQL MVP Phase 08 remains partial. This is the sequence exception allowed by the parent design; it does not change Phase 08 status or any driver maturity.

## Decisions

- Reuse `src-tauri/src/commands/sql/sql_lexer.rs`; do not add a parser crate or change Cargo files.
- Reuse the existing `SqlDialect` type and serialize it instead of introducing a second dialect enum.
- Keep analysis in one Rust module with inline unit tests; no trait, factory, runtime state, or frontend mirror yet.
- Treat empty, malformed, unsupported, and multi-statement input as `Unknown`. `Unknown` is fail-closed and must never be considered executable by a future Agent policy.
- Extract only lexical table references that can be identified safely. When syntax exceeds that ceiling, return a warning instead of guessing.
- Route the existing legacy read-only guard through the typed analysis after the corpus is green; keep the MySQL result-shape detector and database executors unchanged.

## Scope

### Included

- Serializable `SqlAnalysis`, `StatementClass`, `StatementRisk`, table reference, and warning types.
- SQL statement counting that ignores semicolons inside supported strings, quoted identifiers, and comments.
- Explicit classification for metadata, read-only query, read-only explain, transactional write, DDL, destructive, forbidden, and unknown input.
- Best-effort extraction for simple `FROM`, `JOIN`, `UPDATE`, `INTO`, and DDL table targets, including qualified and quoted names.
- Dialect corpus for SQLite, MySQL Preview, and PostgreSQL-planned lexical forms.
- Explicit tests for CTE, `PRAGMA`, `ATTACH`, `DETACH`, `VACUUM`, `EXPLAIN ANALYZE`, comments, quoted semicolons, dangerous SQL, and unknown keywords.

### Excluded

- A0.2 parser dependency spike or ADR.
- Tauri IPC, `sql.parse` tool registration, Agent runtime, model calls, schema lookup, or database validation.
- New approval policy, write-mode behavior, editor splitting, or frontend types; A0 only makes the existing read-only guard consume the stricter shared classification.
- Full SQL grammar coverage, semantic name resolution, CTE lineage, function side-effect detection, and dialect-specific validation.

## Implementation slices

### 1. Contract and red tests

Files: `sql_analysis.rs`, `mod.rs`, optionally `dialect.rs`.

- Define the wire-safe domain types and expected serde names.
- Add a table-driven corpus covering every `StatementRisk` variant.
- Add focused tests for statement boundaries, references, warnings, and `Unknown` fail-closed behavior.
- Run the focused test target and confirm the new tests fail because the implementation is absent.

### 2. Minimal lexer-backed implementation

Files: `sql_lexer.rs`, `sql_analysis.rs`, `dialect.rs`, `mod.rs`.

- Add only the lexer output needed by analysis: statement slices and identifier/symbol tokens.
- Implement classification from the first effective statement keyword, reusing the existing CTE helper.
- Force multi-statement, malformed, and unsupported forms to `Unknown`.
- Extract stable lexical table references and emit `references_incomplete` for ambiguous syntax.
- Serialize DTO fields as camelCase and enum values as snake_case.
- Replace the legacy first-keyword read-only check with the typed risk result, preserving fail-closed behavior.

### 3. Refactor and verify

Files: the same Rust files, `state.rs`, plus this plan.

- Remove duplication without changing database executor implementations; the only intended behavior change is stricter fail-closed rejection in the existing read-only guard.
- Run formatting, Clippy, focused tests, the full Rust library suite, and the relevant project suites.
- Mark this plan complete only after required A0 checks exit 0, any repository-baseline failure is isolated with unchanged-input evidence, and the final diff stays within A0.

## Acceptance criteria

- `SqlAnalysis` serializes with `dialect`, `statementCount`, `statementClass`, `risk`, `referencedTables`, and `warnings`.
- Empty/comment-only SQL reports zero statements, `Unknown`, and an explicit warning.
- Semicolons in comments and supported quoted forms do not increase `statementCount`.
- More than one executable statement reports the exact count and `Unknown` risk.
- `SELECT`/`VALUES`, `SHOW`/`DESCRIBE`, safe `EXPLAIN`, writes, DDL, destructive statements, and forbidden maintenance/attachment statements map deterministically.
- `EXPLAIN ANALYZE`, unsupported `PRAGMA`, malformed CTE, and unknown keywords fail closed.
- Simple qualified/quoted table references are deduplicated in encounter order; ambiguous references produce a warning rather than fabricated metadata.
- No dependency, lockfile, IPC, frontend, connection lifecycle, or database executor change is introduced; the existing read-only guard becomes stricter for ambiguous SQL.

## Verification

```bash
cd src-tauri && cargo test --lib sql_analysis
pnpm run rust:fmt
pnpm run rust:clippy
pnpm run test:rust
pnpm run test:sql-connection-mvp
pnpm run test:sql-services
pnpm run test:sql-advanced
pnpm run format:check
git diff --check
```

`pnpm run build` is required only if the final diff unexpectedly touches frontend or bundling inputs; the planned Rust-only slice does not.

### Completion record (2026-08-11)

TDD evidence:

- Red: the first six behavior groups were run against `todo!()` and all six failed at the unimplemented analysis entry point.
- Green/refactor: the final focused corpus passes 9/9 and the legacy read-only tests pass through the typed risk path.

| Check                                                   | Exit | Result                                 |
| ------------------------------------------------------- | ---: | -------------------------------------- |
| `cd src-tauri && cargo test --lib sql_analysis`         |    0 | 9 passed                               |
| `pnpm run rust:fmt`                                     |    0 | Rust formatting clean                  |
| `pnpm run rust:check`                                   |    0 | Rust compile check clean               |
| `pnpm run rust:clippy`                                  |    0 | `--all-targets -- -D warnings` clean   |
| `pnpm run test:rust`                                    |    0 | 210 passed, 2 ignored live MySQL tests |
| `pnpm run test:sql-services`                            |    0 | 86 passed                              |
| `pnpm run test:sql-advanced`                            |    0 | 63 passed                              |
| `pnpm run build`                                        |    0 | Vite production build completed        |
| targeted Prettier check for changed roadmap/design docs |    0 | All matched files use Prettier style   |
| `git diff --check`                                      |    0 | No whitespace errors                   |
| `pnpm run test:sql-connection-mvp`                      |    1 | 3 unchanged baseline verifier misses   |
| `pnpm run format:check`                                 |    1 | 149 unchanged TypeScript files         |

Two repository-baseline gates remain non-green and are not caused by A0:

- `pnpm run test:sql-connection-mvp` exits 1 on three static-regex checks (`sql_test_connection_v2`, `sql_open_connection_v2`, and managed `connection_manager`). The verifier and the reported `connection_v2.rs` / `lib.rs` inputs are unchanged from `HEAD`; Rust command tests and `test:sql-services` are green.
- `pnpm run format:check` exits 1 on 149 pre-existing TypeScript files. A0 changes no `src/**/*.ts` file, and the changed roadmap/design documents pass the targeted Prettier check.

## Known ceiling

The A0 lexer is intentionally a conservative classifier, not a SQL parser. `ReadOnly` and `ExplainReadOnly` describe static syntax only: user-defined functions and built-ins such as PostgreSQL `nextval` can still have side effects. Agent execution must additionally use database-enforced read-only permissions/transactions in A3; A0 risk alone is never an authorization result.

A0.2 should evaluate a maintained parser only after this corpus exposes concrete coverage gaps; approval must include dialect coverage, binary size, license, Rust version, and maintenance data.
