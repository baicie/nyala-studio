# MVP vNext Agent Foundation Verification

- Date: 2026-08-12
- Scope: A0.2 parser spike and A1.2 bounded schema search/cache
- Status: complete for Slice 1

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

The cache stores only local schema shape. It does not store query text, model
messages, result rows, or credentials. Foreign-key graph retrieval remains a
later A1 task and unsupported metadata remains an explicit capability state.

## Verification commands

The following focused commands are the evidence for this slice:

```text
cargo test --lib commands::sql::sql_lexer::tests
cargo test --lib commands::sql::sql_analysis::tests
cargo test --lib commands::sql::agent::schema_context::tests
cargo test --lib commands::sql::agent::core_adapter::tests
cargo test --lib commands::sql::connection_manager::tests
cargo test --lib commands::sql::query::tests
cargo fmt --all -- --check
```

The full Rust and repository gates remain release checks in the vNext roadmap;
this record does not claim A2-A4, Zeus, or R0 completion.
