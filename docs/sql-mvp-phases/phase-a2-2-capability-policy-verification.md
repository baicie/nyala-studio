# MVP vNext A2.2 Capability Policy Verification

- Date: 2026-08-12
- Scope: canonical capability vocabulary and Rust-side Agent policy
- Status: complete for A2.2 only

## Delivered

`src/vs/workbench/services/sql/common/sqlCapabilities.ts` is the single frontend
capability vocabulary. It includes the existing plugin capabilities and the Agent
tokens required by the design (`workspace.readSql`, `database.readResultShape`,
`database.readResultSample`, `database.explain`, and `history.read`). The plugin API
re-exports this vocabulary instead of defining a second union, rejects unknown
runtime capability strings, and keeps declarations as non-authorizing UI metadata.

`src-tauri/src/commands/sql/agent/policy.rs` re-parses the same exact wire strings
at the backend boundary. It provides:

- a typed capability set that rejects unknown or invented capability names;
- a fixed Agent tool allowlist with explicit required capability per tool;
- A2 availability gating for workspace, schema, static parse, and static validate tools;
- denial of `sql.explain`, `sql.execute_readonly`, result, and history tools until their
  later stage, even when a manifest declares a matching capability;
- unknown-tool, missing-capability, and oversized-argument structured errors.

No policy path executes SQL, dispatches arbitrary Tauri commands, or upgrades driver
maturity. Suggest Only remains the default and Read Only does not open query tools
before A3.

## Verification commands

```text
pnpm run test:sql-agent
pnpm run test:sql-advanced
pnpm run lint
pnpm run rust:check
pnpm run rust:fmt
cargo clippy -p sql-studio-next --lib -- -D warnings
git diff --check
```

`test:sql-agent` passed 52/52 Rust Agent tests and 2/2 canonical capability tests;
`test:sql-advanced` passed 65/65. This record does not claim A2 overall, A2.3/A2.4,
A3-A4, Zeus, or R0 completion.
