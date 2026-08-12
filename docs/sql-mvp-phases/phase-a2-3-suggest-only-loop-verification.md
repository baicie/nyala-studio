# MVP vNext A2.3 Suggest-only Loop Verification

- Date: 2026-08-12
- Scope: strict model response parsing, deterministic gateway, and Rust Suggest-only loop
- Status: complete for A2.3 only

## Delivered

`src-tauri/src/commands/sql/agent/model.rs` defines the provider boundary:

- gateway implementations return JSON only; the runtime owns parsing and validation;
- internally tagged `final` and `tool_call` responses reject malformed JSON and unknown fields;
- the deterministic gateway preserves the four Phase 06 action kinds and drafts SQL from the supplied schema;
- model context contains only typed SQL/workspace shape and never a connection secret or driver handle.

`src-tauri/src/commands/sql/agent/runtime.rs` defines `SuggestOnlyAgentLoop`:

- it drives the Rust-owned run state machine and budget/cancellation checks;
- policy authorization happens before every tool dispatch;
- only workspace/schema/static parse/validate tools produce local typed evidence;
- explain, execute, result, history, arbitrary Tauri, and write tools cannot reach dispatch;
- tool evidence is stored through the bounded redacting evidence store;
- result projection exposes `queryCallCount`, which is always zero in A2.3.

Scripted gateway tests cover final completion, tool-to-final evidence, malformed JSON, unknown
tool, model-turn budget, and cancellation. No SQL query command or driver adapter is called.

## Verification commands

```text
pnpm run test:sql-agent
cd src-tauri && cargo test -p sql-studio-next --lib commands::sql::agent::runtime
pnpm run lint
pnpm run rust:check
pnpm run rust:fmt
cargo clippy -p sql-studio-next --lib -- -D warnings
git diff --check
```

`test:sql-agent` passed 62/62 Rust Agent tests and 2/2 canonical capability tests. This record
does not claim A2.4, A3-A4, Zeus, or R0 completion.
