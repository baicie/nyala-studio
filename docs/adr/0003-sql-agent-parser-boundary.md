# ADR 0003: SQL Agent Parser Boundary

- Status: Accepted
- Date: 2026-08-12
- Updated: 2026-08-18
- Owners: SQL Intelligence, Product Security
- Related: [SQL Workspace Agent design](../sql-workspace-agent-design.md), [A0 plan](../sql-workspace-agent-a0-implementation-plan.md), [MVP vNext roadmap](../sql-mvp-phases/mvp-vnext-agent-zeus-roadmap.md)

## Context

A0.2 asks whether Nyala should replace the local conservative SQL lexer and
classifier with a general-purpose parser. The Agent safety contract is stricter
than syntax parsing: malformed input, unsupported dialect forms, multi-statement
input, and unknown side effects must remain fail-closed. A parser can therefore
be useful for typed references without becoming the authorization boundary.

The local analyzer tests exercise SQLite, MySQL, and PostgreSQL quoted
identifiers, comments, CTEs, malformed input, multi-statements, `SELECT INTO`,
locking, and unsafe MySQL output forms. The checked-in spike runner owns a
separate fixed set of 11 representative fixtures. Its JSON output includes each
fixture's SQL, dialect, expected statement count, local risk, parser result, and
whether the result matches the dialect expectation, so coverage counts are
derived instead of manually maintained.

## Spike method and evidence

The candidate is evaluated by a checked-in runner that creates and removes an
isolated Cargo crate under the system temporary directory. Run it from the
repository root:

```text
node scripts/run-sqlparser-spike.mjs \
  --output docs/sql-mvp-phases/phase-a0-parser-spike.json
```

The runner exact-pins `sqlparser = "=0.62.0"`, generates the fixture source and
manifest, and records `cargo info`, the locked Cargo tree, the normalized
metadata package closure, baseline/parser release builds, corpus output,
toolchain/MSRV availability, crates.io maintenance data, and SHA-256 hashes as
structured JSON. Child output and crates.io response bodies are bounded, and
all network/build steps have deadlines. Nothing is added to the Nyala Cargo
workspace or production lockfile. The checked-in result is
[`phase-a0-parser-spike.json`](../sql-mvp-phases/phase-a0-parser-spike.json).

### Reproducible measurement

The 2026-08-18 Asia/Shanghai run used Rust/Cargo 1.96.0 on
`aarch64-apple-darwin`. The repository minimum is Rust 1.91.0, while the
candidate declares no `rust-version`. The runner did not install a toolchain;
because 1.91.0 was not already installed, the exact MSRV build remained
`not_run` and compatibility with the repository minimum remains unproven.

Locked Cargo metadata resolved 21 packages including the temporary harness, or
20 external packages across target conditions. The candidate is Apache-2.0.
The normalized closure contained only MIT, Apache-2.0, Unicode-3.0, Unlicense,
and Apache-2.0 WITH LLVM-exception license expressions; no copyleft license was
reported. The default `recursive-protection` feature activates `recursive`,
`stacker`, `psm`, and their build dependencies.

The minimal release binary comparison was:

```text
without parser: 431,216 bytes
with sqlparser: 6,268,128 bytes
delta: 5,836,912 bytes
```

This is a directional harness measurement, not a claim about the final Nyala
binary delta. It is nevertheless large enough to require an explicit product
and release decision before adding the dependency.

The exact fixture results were:

| Input shape                                          | Parser result                      | Local safety risk       |
| ---------------------------------------------------- | ---------------------------------- | ----------------------- |
| SQLite `SELECT`, `EXPLAIN QUERY PLAN`, and CTE query | Parsed as one statement            | read-only/explain-only  |
| SQLite `PRAGMA journal_mode = WAL`                   | Rejected: expects a concrete value | unknown                 |
| MySQL `INTO OUTFILE`                                 | Rejected at `OUTFILE`              | forbidden               |
| MySQL `LOCK IN SHARE MODE`                           | Rejected at `IN`                   | transactional write     |
| MySQL versioned comment                              | Parsed as one statement            | unknown                 |
| PostgreSQL `FOR NO KEY UPDATE`                       | Rejected at `NO`                   | transactional write     |
| PostgreSQL dollar-quoted semicolon                   | Parsed as one statement            | read-only               |
| SQLite CTE `UPDATE`                                  | Parsed as one statement            | transactional write     |
| Generic `SELECT; DROP`                               | Parsed as two statements           | unknown/multi-statement |

Four of 11 fixtures exposed dialect gaps. Three successful parses remained
non-read-only under local policy: the MySQL versioned comment, SQLite CTE
`UPDATE`, and generic multi-statement input. These results demonstrate both
sides of the boundary: dialect extensions still need local fail-closed
handling, and successful parsing does not make a query safe or single-statement.

The exact run is traceable through these hashes:

```text
runner script:       d0ed9957ca2785e4b908a51004a128d17c92fbf372a844946a5ddddb759dd1e7
generated Rust source: 3f132697d9244aeb63b4cd3a53b70110428fc2c8f5138ec253ac135d1f718a49
harness source set:  dceecd0d5da33a084e67c10ea9bbd2d9dd77f94ee6f0dd0631b62eb52518642c
measurement:         e08e5dbbf5b9c8cfb048b5985e281272280c74bf5d48ada044a63eb1a5ae3375
cargo tree:          10c31472470addba7d111de7e42f2a84172cf7ade00d03a7b90c07cf666d2e16
normalized packages: cd031965b00ed68cc3ef995438277fa9239035d893e4be88ef1079a29199fe1d
temporary lock:      5442b475dd621cb1e8fe377ae81f5509035b414ae361ddeff643b40210b09c42
corpus output:       2efd980dac84da59f0aa44528e098459a2ace6bc9dce5fa05bca5f75e3ee1209
baseline binary:     26df8fded64f209afd94612acb9dbf6655e6d75017fddea749451c2ab3bd5f9a
parser binary:       e3770ecd7d523df0d4658a0f668feed823a1bb523645c3a8bb3a2a1cefd7cbdd
```

The crates.io maintenance snapshot reported version 0.62.0 published on
2026-05-07, not yanked, and still the latest stable version at measurement
time. Its repository was
`https://github.com/apache/datafusion-sqlparser-rs`, license was Apache-2.0,
and registry checksum was
`13c6d1b651dc4edf07eead2a0c6c78016ce971bc2c10da5266861b13f25e7cec`.

## Decision

Nyala will **not add `sqlparser` to Cargo** for A0.2. The existing local
analysis remains the safety and authorization input. A0.2 is complete as a
No-Go dependency decision, with the following follow-up work kept inside the
local parser:

1. add malformed string/comment/bracket/parenthesis cases to the shared corpus
   and classify them as `Unknown`;
2. preserve explicit multi-statement rejection even if a future parser accepts
   a statement list;
3. keep typed table references conservative for CTEs and derived tables;
4. maintain dialect-specific risk tests for the forms listed above.

If a future spike proposes a parser again, it must update the exact version in
the isolated runner and repeat the corpus, license, maintenance, Rust minimum,
dependency closure, release-size, and dialect-gap measurements. It must also
show how local policy remains the authorization boundary. No production Cargo
or lockfile change is authorized by this ADR.

## Consequences

The Agent avoids a new parser dependency and its measured release-size risk.
The local lexer remains intentionally incomplete and must continue to return
`Unknown` whenever it cannot establish a safe interpretation. A future typed
AST may still be introduced as a separate, reviewed decision; it cannot weaken
the current fail-closed behavior.
