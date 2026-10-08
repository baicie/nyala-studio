# MVP vNext Agent Foundation Verification

- Date: 2026-08-12
- Updated: 2026-08-18
- Scope: A0.2 parser spike, A1.2 bounded schema search/cache, and A1.3 SQLite Schema Graph
- Status: complete for the recorded Agent foundation scope

## A0.2

The parser spike is recorded in [ADR 0003](../adr/0003-sql-agent-parser-boundary.md).
`scripts/run-sqlparser-spike.mjs` creates an isolated temporary crate with an
exact `sqlparser = "=0.62.0"` pin and removes it after emitting structured JSON.
It does not change the Nyala Cargo workspace or lockfile. The 2026-08-18 run
resolved 21 metadata packages including the harness, measured a 5,836,912-byte
release harness delta, and found four dialect gaps in 11 fixed fixtures.
Successful parsing still required the local safety policy.

The local analyzer already returned `Unknown`/fail closed for unclosed strings,
comments, brackets, and parentheses. The spike hardening added explicit shared
SQL analysis and lexer characterization for the SQLite bracket case; no parser
production logic changed.

### 2026-08-18 reproducible evidence hardening

The runner records fixture inputs/results, the locked Cargo tree and normalized
metadata package closure, license closure, platform-specific binary bytes and
hashes, installed Rust and repository MSRV, crates.io maintenance metadata,
every child command exit code, and normalized output hashes. Command output is
bounded to 32 MiB per stream, crates.io bodies to 4 MiB, and network/build steps
have explicit deadlines. The recorded run used Rust/Cargo 1.96.0 on darwin/arm64.
`sqlparser` declares no `rust-version`; Rust 1.91.0 was not installed, so the
exact repository-MSRV build remains explicitly `not_run` rather than being
inferred from the newer compiler. The complete artifact is
[`phase-a0-parser-spike.json`](./phase-a0-parser-spike.json).

Maintenance evidence reported 0.62.0 as published on 2026-05-07, not yanked,
and still the latest stable release at measurement time. The exact registry
checksum was
`13c6d1b651dc4edf07eead2a0c6c78016ce971bc2c10da5266861b13f25e7cec`.
The trace hashes are:

```text
runner script:       d0ed9957ca2785e4b908a51004a128d17c92fbf372a844946a5ddddb759dd1e7
generated Rust source: 3f132697d9244aeb63b4cd3a53b70110428fc2c8f5138ec253ac135d1f718a49
harness source set:  dceecd0d5da33a084e67c10ea9bbd2d9dd77f94ee6f0dd0631b62eb52518642c
measurement:         e08e5dbbf5b9c8cfb048b5985e281272280c74bf5d48ada044a63eb1a5ae3375
cargo tree:          10c31472470addba7d111de7e42f2a84172cf7ade00d03a7b90c07cf666d2e16
normalized packages: cd031965b00ed68cc3ef995438277fa9239035d893e4be88ef1079a29199fe1d
temporary lock:      5442b475dd621cb1e8fe377ae81f5509035b414ae361ddeff643b40210b09c42
corpus output:       2efd980dac84da59f0aa44528e098459a2ace6bc9dce5fa05bca5f75e3ee1209
```

The newly added unclosed SQLite bracket cases were characterization tests: both
passed against the existing fail-closed implementation before the harness and
documentation changes. No analyzer production logic change was required.

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

### 2026-08-18 refresh and revision-race hardening

Workbench metadata refresh now crosses the existing `ISqlMetadataService`
boundary before reloading either tree implementation. The service invokes the
structured `sql_refresh_metadata` command, advances the shared Rust metadata
revision, and then drops its frontend TTL entries. Views do not invoke Tauri
directly, and the command returns only the opaque connection id; no profile
target, path, host, username, secret, query text, or result row is added to the
wire response. Both the V2 and legacy connection models record a backend
refresh failure on the target tree node before notifying their caller.

Frontend TTL entries use structured tuple keys and retain their exact owning
profile, so delimiter-bearing identifiers cannot collide and invalidating one
profile cannot evict a prefixed sibling. Each profile also owns a cache epoch;
an older request that resolves after refresh may return to its original caller
but cannot repopulate the current cache. Refreshes for one profile are
serialized, and a V2 metadata read started during a queued refresh waits for
that refresh before consulting the TTL cache. A failed refresh remains owned by
its caller and does not make the existing cache unreadable.

The V2 connection tree pairs that profile epoch with per-node operation
revisions. Refresh or a newer expansion therefore wins over older datasource,
schema, and table requests, while stale sibling operations restore their prior
non-loading state. Legacy whole-connection and table-column refresh paths also
advance the same Rust metadata revision before reloading. Refreshing an unknown
or saved-but-closed profile remains a successful compatibility no-op and never
opens a connection.

Schema, declared-relation, and index results now share one return-time runtime
revision check. If refresh, close/reopen, or a successful metadata-changing
statement advances the revision while a bounded result is being constructed,
the in-flight call fails closed instead of returning evidence tagged with the
old revision. Its next call resolves the new revision and cannot reuse the old
cache key.

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
node --check scripts/run-sqlparser-spike.mjs
node scripts/run-sqlparser-spike.mjs --output docs/sql-mvp-phases/phase-a0-parser-spike.json
cargo test --lib commands::sql::sql_lexer::tests
cargo test --lib commands::sql::sql_analysis::tests
cargo test --lib commands::sql::agent::schema_context::tests
cargo test --lib commands::sql::agent::core_adapter::tests
cargo test --lib commands::sql::metadata_v2::tests
cargo test -p sql-studio-next --lib commands::sql::agent
cargo test -p sql-studio-next --lib foreign_key_snapshot
cargo test --lib commands::sql::driver_registry::tests
cargo test --lib commands::sql::connection_manager::tests
cargo test --lib commands::sql::query::tests
cargo fmt --all -- --check
pnpm run test:sql-services
pnpm run test:sql-connections
```

2026-08-18 A0.2/A1.2 hardening evidence:

- isolated parser spike runner: exit 0; 11 fixtures, 4 dialect gaps, exact
  dependency/binary/license/maintenance hashes recorded above and in ADR 0003;
- `commands::sql::sql_lexer::tests`: 5/5 passed and
  `commands::sql::sql_analysis::tests`: 9/9 passed, including the unclosed
  SQLite bracket characterization;
- `commands::sql::metadata_v2::tests`: 13/13 passed, including structured
  refresh revision advancement, blank-id rejection, and deterministic
  return-time revision-race rejection;
- `commands::sql::agent::core_adapter::tests`: 46/46 passed, including
  public schema, relation, and index return-time revision mismatch rejection;
- `test:sql-services`: 111/111 passed, including serialized refresh ordering,
  refresh/read races, stale TTL repopulation, and structured tuple-key collision
  rejection;
- `test:sql-connections`: 171/171 passed, including lifecycle invalidation,
  backend refresh ordering,
  last-started-wins expansion, and stale sibling loading-state release;
- `pnpm run test:sql-agent`: 265 Rust Agent tests and 2 canonical capability
  tests passed;
- `pnpm run test:rust`: 534 passed, 2 ignored;
- `pnpm run rust:check`, `pnpm run rust:clippy`, `pnpm run rust:fmt`,
  `pnpm run lint`, and `pnpm run build`: exit 0;
- `pnpm run test`: exit 0 for the complete default repository chain.

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
