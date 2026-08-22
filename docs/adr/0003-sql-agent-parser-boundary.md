# ADR 0003: SQL Agent Parser Boundary

- Status: Accepted
- Date: 2026-08-12
- Owners: SQL Intelligence, Product Security
- Related: [SQL Workspace Agent design](../sql-workspace-agent-design.md), [A0 plan](../sql-workspace-agent-a0-implementation-plan.md), [MVP vNext roadmap](../sql-mvp-phases/mvp-vnext-agent-zeus-roadmap.md)

## Context

A0.2 asks whether Nyala should replace the local conservative SQL lexer and
classifier with a general-purpose parser. The Agent safety contract is stricter
than syntax parsing: malformed input, unsupported dialect forms, multi-statement
input, and unknown side effects must remain fail-closed. A parser can therefore
be useful for typed references without becoming the authorization boundary.

The current local corpus has 44 SQL/dialect scenarios across SQLite, MySQL, and
PostgreSQL. The primary classification matrix covers 10 of 24 dialect/risk
cells; auxiliary tests cover 15 of 24. The existing tests also exercise quoted
identifiers, comments, CTEs, malformed input, multi-statements, `SELECT INTO`,
locking and unsafe MySQL output forms.

## Spike method and evidence

The candidate was evaluated in a temporary crate and was not added to this
repository. Commands used:

```text
cargo info sqlparser@0.62.0
cargo tree --features parser --no-dev-dependencies
cargo metadata --format-version 1 --features parser
cargo build --release --no-default-features
cargo build --release --features parser
```

The temporary harness used `sqlparser = 0.62.0` with default features. It
compiled on the installed Rust 1.96.0 toolchain. The repository minimum is
Rust 1.91.0; the crate does not declare a `rust-version`, so compatibility with
the minimum toolchain is not proven by this spike.

The activated dependency closure contained 20 packages (including the harness
root). The candidate is Apache-2.0. The closure licenses reported by Cargo
metadata were Apache-2.0, MIT, Unicode-3.0, Unlicense, and
Apache-2.0 WITH LLVM-exception; no new copyleft license was present in the
temporary closure. The default `recursive-protection` feature adds `recursive`,
`stacker`, `psm`, and their build dependencies.

The minimal release binary comparison was:

```text
without parser: 431,216 bytes
with sqlparser: 6,268,656 bytes
delta: 5,837,440 bytes
```

This is a directional harness measurement, not a claim about the final Nyala
binary delta. It is nevertheless large enough to require an explicit product
and release decision before adding the dependency.

Representative dialect results from the same harness:

| Input shape                                                   | Result                             |
| ------------------------------------------------------------- | ---------------------------------- |
| SQLite `SELECT`, `EXPLAIN QUERY PLAN`, and CTE query          | Parsed                             |
| SQLite `PRAGMA journal_mode = WAL`                            | Rejected: expects a concrete value |
| MySQL `INTO OUTFILE`, `LOCK IN SHARE MODE`, versioned comment | Rejected                           |
| PostgreSQL `FOR NO KEY UPDATE`                                | Rejected                           |
| PostgreSQL dollar-quoted text containing `;`                  | Parsed as two statements           |
| SQLite CTE `UPDATE`                                           | Parsed as one statement            |
| Generic `SELECT; DROP`                                        | Parsed as two statements           |

These results demonstrate both sides of the boundary: dialect extensions still
need local fail-closed handling, and successful parsing does not make a query
safe or single-statement.

## Decision

Nyala will **not add `sqlparser` to Cargo** for A0.2. The existing local
analysis remains the safety and authorization input. A0.2 is complete as a
No-Go dependency decision, with the following follow-up work kept inside the
local parser:

1. add malformed string/comment/parenthesis cases to the shared corpus and
   classify them as `Unknown`;
2. preserve explicit multi-statement rejection even if a future parser accepts
   a statement list;
3. keep typed table references conservative for CTEs and derived tables;
4. maintain dialect-specific risk tests for the forms listed above.

If a future spike proposes a parser again, it must use an exact version and
repeat the corpus, license, Rust minimum, dependency closure, release-size,
and dialect-gap measurements. It must also show how local policy remains the
authorization boundary. No Cargo or lockfile change is authorized by this ADR.

## Consequences

The Agent avoids a new parser dependency and its measured release-size risk.
The local lexer remains intentionally incomplete and must continue to return
`Unknown` whenever it cannot establish a safe interpretation. A future typed
AST may still be introduced as a separate, reviewed decision; it cannot weaken
the current fail-closed behavior.
