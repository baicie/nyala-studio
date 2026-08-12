# Architecture Decision Records

This directory records architectural decisions that affect Nyala Studio across
multiple phases or ownership boundaries.

## Status values

- `Proposed`: ready for review, but not yet an implementation contract.
- `Accepted`: approved and binding for new work.
- `Superseded`: replaced by a later ADR.
- `Rejected`: considered but intentionally not adopted.

## Index

| ADR                                                   | Status   | Decision                                                                                                       |
| ----------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| [0001](./0001-jdbc-sidecar-and-connector-boundary.md) | Proposed | Run JDBC drivers in a supervised Java sidecar and keep database connectors separate from Workbench extensions. |
| [0002](./0002-signed-connector-marketplace.md)        | Proposed | Distribute connector packages through a curated, signed, rollback-resistant marketplace.                       |
| [0003](./0003-sql-agent-parser-boundary.md)           | Accepted | Keep the local fail-closed SQL analyzer for A0.2; do not add `sqlparser` without a new approved spike.         |

An ADR becoming `Accepted` does not by itself change a driver's runtime
maturity. Runtime status remains governed by
`src-tauri/src/runtime_status/mod.rs` and the matching SQL phase document.
