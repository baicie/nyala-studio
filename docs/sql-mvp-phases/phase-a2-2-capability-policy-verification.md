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

## 2026-08-14 Backend grant ownership hardening

The Tauri bridge now treats `request.capabilities` as an opt-down request, not an
authorization grant. Rust selects a fixed grant from the built-in task/mode profile,
intersects the requested set with that grant, and stores only the effective set in
the opaque pending run. `AgentPolicy` is constructed from that stored effective set
after `sql_agent_run` claims the run; a later IPC call cannot replace it.

The current fixed grants are intentionally narrow:

- Suggest-only actions receive `agent.tool` and `workspace.readSql` only when requested.
- Connected Suggest-only Generate may additionally receive `database.readMetadata`.
- Read-only Assistant may receive exactly `agent.tool`, `database.readMetadata`,
  `database.executeRead`, and `database.readResultShape`.
- Read-only Explain/Optimize may receive `database.explain`.
- No profile grants write, filesystem, network, history, or result-sample access.

Bridge tests inject otherwise valid `database.executeWrite`, `network.request`,
`database.readResultSample`, and metadata tokens into the wrong profiles and prove
that none reaches the effective policy. Omitting a required requested capability
still fails closed; the backend never silently adds a grant.

This boundary prevents a manifest, model response, or action request from inflating
the capability set of its selected built-in runtime profile. It does not claim that
a compromised main renderer cannot invoke another already-approved built-in action;
the single main-window Tauri ACL remains that principal boundary. Per-action native
principal isolation would require a separate WebView/ACL or native-issued grant token.
The grant applies to the Agent model/tool loop only. Standalone read-only Agent
commands and ordinary SQL commands remain separate Tauri surfaces with their own
input/read-only validation inside the same main-window ACL.

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

2026-08-14 hardening evidence:

- `pnpm run test:sql-agent`: 149/149 Rust Agent tests and 2/2 canonical capability tests;
- `pnpm run test:rust`: 376 passed, 2 ignored;
- `pnpm run test`: exit 0, including the Agent, SQL, benchmark, WebDriver, and visual suites.

2026-08-15 Checkpoint R Explore extension:

- backend and Workbench contract tests prove the Read-only Assistant grant is the exact four-token set above;
- sample, explain, workspace SQL, write, network, filesystem, and history capabilities remain absent;
- missing any requested required capability fails closed, while extra request tokens cannot inflate the grant;
- the grant enables only the A3 Explore model/tool loop recorded in
  [`phase-agent-checkpoint-r-explore-verification.md`](./phase-agent-checkpoint-r-explore-verification.md).
- `pnpm run test:sql-agent`: 159/159 Rust Agent tests and 2/2 canonical capability tests;
- `pnpm run test:rust`: 386 passed, 2 ignored; `pnpm run test`: exit 0.
