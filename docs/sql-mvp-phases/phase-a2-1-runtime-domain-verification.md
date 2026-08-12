# MVP vNext A2.1 Runtime Domain Verification

- Date: 2026-08-12
- Scope: Agent domain objects, run state machine, cancellation, budgets, and evidence store
- Status: complete for A2.1 only

## Delivered

`src-tauri/src/commands/sql/agent/domain.rs` now owns the in-memory Agent contract:

- `AgentRunState` enforces the documented lifecycle and rejects invalid transitions;
- cancellation is a shared atomic token and transitions every non-terminal run to `Cancelled`;
- wall-clock timeout and model/tool/schema/result/token budgets are checked before work can continue;
- budget updates are checked before mutation, so a rejected increment cannot partially update usage;
- run, turn, task, tool-call, context-ref, artifact, and approval shapes are typed and serializable;
- tool-call arguments are recursively redacted before they enter the audit shape;
- serialized run snapshots omit cancellation and monotonic clock internals.

`src-tauri/src/commands/sql/agent/evidence.rs` provides a local bounded evidence store:

- evidence is typed by kind and sensitivity;
- payloads are recursively redacted before byte accounting and storage;
- entry count, serialized-byte, and TTL limits are enforced;
- evidence is scoped by opaque run id and returned in stable creation order;
- the store keeps no V1/V2 identity, connection path, credential, model log, or query execution path.

No model provider, query tool, Tauri command, frontend service, or Zeus dependency was added in A2.1.
The default mode remains `SuggestOnly`; A2.2 capability/policy enforcement is the next slice.

## Verification commands

```text
cargo test --lib commands::sql::agent
cargo check -p sql-studio-next
cargo clippy -p sql-studio-next --lib -- -D warnings
cargo fmt --all -- --check
git diff --check
```

The focused agent suite passed 47/47 tests. This record does not claim A2 overall, A3-A4, Zeus, or R0 completion.
