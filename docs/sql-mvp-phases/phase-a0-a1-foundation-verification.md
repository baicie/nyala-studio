# MVP vNext Agent Foundation Verification

- Date: 2026-08-12
- Updated: 2026-08-16
- Scope: A0.2 parser spike, A1.2 bounded schema search/cache, and A1.3 SQLite Schema Graph
- Status: complete for the recorded Agent foundation scope

## A0.2

The parser spike is recorded in [ADR 0003](../adr/0003-sql-agent-parser-boundary.md).
`sqlparser 0.62.0` was evaluated in a temporary crate and was not added to
Cargo or the lockfile. The decision is No-Go for this slice because the default
dependency closure added 20 packages and the minimal release harness grew by
5,837,440 bytes. The candidate also rejected several project corpus dialect
extensions, while successful parsing still required the local safety policy.

The local analyzer was strengthened after the spike: unclosed strings,
comments, brackets, and parentheses now return `Unknown`/fail closed. The
shared SQL analysis and lexer tests cover these cases.

## A1.2

`LocalSqlCoreAdapter::search_schema` now provides:

- normalized object, column-token, explicit-table, and deterministic fuzzy ranking;
- stable `(score, schema, kind, name)` tie-breaking;
- hard object, column, and serialized UTF-8 byte budgets with explicit truncation;
- a per-connection schema snapshot cache with a 30-second TTL;
- cache keys containing the opaque connection id, schema, and monotonic metadata
  revision, with no query text in the key;
- explicit invalidation and revision changes for close/reopen, refresh, and
  successful V1 statements that may change metadata;
- structured fail-closed behavior for MySQL Preview and PostgreSQL Planned
  metadata capabilities;
- typed evidence serialization that excludes V1/V2 store identity, paths,
  hosts, usernames, and secrets.

### 2026-08-14 bounded snapshot contract hardening

The SQLite driver now constructs the schema snapshot under fixed object,
global-column, and serialized-byte limits instead of loading an unbounded table
and column graph before applying the Agent search budget. It reports top-level
and per-object truncation explicitly. Dense tables are read through per-object
column probes capped by the remaining global column budget, so SQL-side sorting
cannot materialize the complete column graph before the cap is applied.

`LocalSqlCoreAdapter` treats the driver response as an untrusted internal
boundary. Before mapping or caching it, the adapter rejects snapshots that
exceed any hard limit, overflow the checked global column count, exceed the
serialized byte cap, or report `columnsTruncated = true` while the top-level
`truncated` flag is false. A rejected snapshot is not cached, so a later valid
reload can recover.

The cache stores only local schema shape. It does not store query text, model
messages, result rows, or credentials. At the time of A1.2, foreign-key graph
retrieval remained a later A1 task. A1.3 below closes that task without
broadening driver maturity.

## A1.3

SQLite Stable now exposes bounded declared foreign-key metadata through the
existing V2 `SqlConnection` boundary. The driver applies table, foreign-key,
column, and serialized-byte hard caps while reading metadata and reports its
scanned table count. Composite foreign keys preserve column ordinal and are
admitted atomically: if a budget cannot admit the complete relationship, the
whole relationship is omitted and the snapshot is marked truncated. Dense
foreign-key tables use a global row probe, and scanned-table count growth is
byte-checked before the next table is read.

`LocalSqlCoreAdapter::search_relations` validates the driver snapshot before
mapping or caching it, then returns deterministic one- or two-hop paths from a
per-connection/schema/revision graph cache. Traversal is bidirectional, while
every edge preserves its declared source and target. Close/reopen, metadata
refresh, and successful metadata-changing statements invalidate both schema
and relation caches. A rejected over-budget or internally inconsistent driver
snapshot is never cached, so a later valid load can recover.

Supported-empty, unsupported, and truncated are distinct states. MySQL Preview
and PostgreSQL Planned remain unsupported, and no driver maturity changes.
Generate receives backend-owned typed relation context: renderer input cannot
forge it, generated JOINs require matching `declared_foreign_key` evidence,
and column-name similarity is not relationship evidence. Non-conventional and
composite foreign-key columns are supported.

Schema-aware Generate performs seed schema search, graph expansion, and final
bounded schema search inside the existing `schema.search` step. Its external
tool order remains `schema.search -> sql.parse -> final` with zero query calls.
Explore carries the same typed relation context while retaining exactly one
explicit read-only query in its execution phase. No secret, V1/V2 store
identity, query text, or query rows are added to the relation cache or default
evidence payload.

## Verification commands

The following focused commands are the evidence for this slice:

```text
cargo test --lib commands::sql::sql_lexer::tests
cargo test --lib commands::sql::sql_analysis::tests
cargo test --lib commands::sql::agent::schema_context::tests
cargo test --lib commands::sql::agent::core_adapter::tests
cargo test -p sql-studio-next --lib commands::sql::agent
cargo test -p sql-studio-next --lib foreign_key_snapshot
cargo test --lib commands::sql::driver_registry::tests
cargo test --lib commands::sql::connection_manager::tests
cargo test --lib commands::sql::query::tests
cargo fmt --all -- --check
```

2026-08-14 additional evidence:

- `commands::sql::driver_registry::tests`: 13/13 passed, including real SQLite
  object, global-column, and serialized-byte caps;
- `commands::sql::agent::core_adapter::tests`: 31/31 passed, including driver
  contract violations and rejected-snapshot cache recovery;
- `pnpm run test:sql-agent`: 149/149 Rust Agent tests and 2/2 canonical
  capability tests passed;
- `pnpm run test:rust`: 376 passed, 2 ignored.

2026-08-16 A1.3 evidence:

- `cargo test -p sql-studio-next --lib commands::sql::agent`: 199/199
  passed, including declared-FK graph/cache, strict driver contract,
  backend-owned relation context, Generate/Fix, and Suggest-only ordering tests;
- `cargo test -p sql-studio-next --lib foreign_key_snapshot`: 9/9 passed,
  including composite-key atomicity, dense metadata probes, and
  table/FK/column/byte hard caps;
- `commands::sql::driver_registry::tests`: 22/22 passed, including dense schema
  and FK reads plus exact scanned-table byte-boundary truncation;
- `pnpm run test:sql-agent`: 199/199 Rust Agent tests and 2/2 canonical
  capability tests passed;
- `pnpm run test:rust`: 453 passed, 2 ignored;
- `pnpm run rust:check`, `pnpm run rust:clippy`, and `pnpm run rust:fmt`:
  exit 0;
- `pnpm run build` and `pnpm run lint`: exit 0;
- `pnpm run test`: exit 0 for the complete default repository chain;
- targeted Prettier check for the four updated Agent roadmap/design records and
  `git diff --check`: exit 0.

The full Rust and repository gates remain release checks in the vNext roadmap.
This A1.3 addendum is foundation evidence only. It does not change Checkpoint R
or W, Zeus Z1/Z2, R0, or any driver maturity.
