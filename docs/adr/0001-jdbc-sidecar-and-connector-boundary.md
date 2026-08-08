# ADR 0001: JDBC Sidecar and Database Connector Boundary

- Status: Proposed
- Date: 2026-08-08
- Owners: SQL Runtime, SQL Services, Product Security
- Related: [Plugin system design](../plugin-system-design.md), [Phase 07](../sql-mvp-phases/phase-07-plugin-api-mvp.md), [Phase 08](../sql-mvp-phases/phase-08-mvp-packaging.md), [ADR 0002](./0002-signed-connector-marketplace.md)

## Context

Nyala Studio needs access to the mature JDBC driver ecosystem without
reimplementing each database wire protocol and its authentication, TLS,
metadata, cancellation, and type behavior in Rust.

The current product has three distinct extension concerns:

1. Workbench extensions contribute commands, views, SQL actions, formatters,
   and other user-facing behavior.
2. Database connectors establish database sessions and expose JDBC behavior.
3. SQL dialects describe parsing, formatting, quoting, and query semantics.

These concerns have different trust and lifecycle requirements. Treating all
three as one generic "plugin" format would let database code leak into the
WebView, couple driver updates to Workbench activation, and undermine the
existing invariant that driver and dialect are separate concepts.

Phase 08 already downloads signed MySQL and PostgreSQL JDBC JARs. Those files
are cached artifacts only; they do not currently provide a Java runtime or
change runtime maturity. This ADR defines the intended runtime boundary.

## Decision

Nyala Studio will use a supervised Java sidecar as the JDBC runtime. The app
will bundle a minimal Java runtime and a versioned `nyala-jdbc-host`; database
connector packages will be installed and updated independently.

```text
Workbench contribution
  -> ISqlConnectionService / ISqlMetadataService / ISqlQueryService
  -> Tauri SQL commands
  -> Rust SqlRuntimeBroker
  -> framed local IPC
  -> nyala-jdbc-host
  -> connector class loader
  -> JDBC Driver
  -> database
```

### Product terminology

The following names are normative:

| Term                | Meaning                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Workbench Extension | A contribution to commands, views, editor actions, formatters, renderers, or agents. It uses the existing extension/WASM direction.     |
| Database Connector  | A separately installed package that makes one JDBC driver available to the SQL runtime. It cannot contribute WebView or Workbench code. |
| JDBC Host           | The first-party Java process that loads connectors and translates JDBC operations into the Nyala runtime protocol.                      |
| Dialect             | SQL language behavior. A connector references a dialect ID but does not silently redefine that dialect.                                 |
| Driver Artifact     | A JAR contained in or referenced by a connector package. It is executable third-party code, not passive data.                           |

User-facing UI may use the short label "Connector". Source code and manifests
must not call a JDBC connector a Workbench plugin.

### Bundled core versus separately installed content

The application bundle contains:

```text
resources/jdbc-runtime/<target>/
  runtime/              # jlink Java runtime, no JDK/compiler
  nyala-jdbc-host.jar   # first-party protocol host
  THIRD_PARTY_NOTICES
```

The application data directory contains:

```text
<app_data_dir>/sql-connectors/
  repositories/         # trusted repository metadata and cache
  packages/<id>/<version>/
    nyala-connector.json
    lib/*.jar
    assets/*
    LICENSES/*
    install-receipt.json
  state/installed.json
```

SQLite remains on the current Rust runtime during the initial rollout. JDBC is
introduced behind the existing driver registry for remote database drivers.
Moving SQLite to JDBC requires a separate decision after behavior and packaging
parity are proven.

### Java runtime distribution

Nyala Studio bundles a `jlink` image built from an approved Java 21 LTS
distribution. It does not depend on a system-wide Java installation.

The runtime image includes only modules required by the host and supported
drivers, expected to include at least:

```text
java.base
java.logging
java.management
java.naming
java.security.jgss
java.sql
java.transaction.xa
java.xml
jdk.crypto.ec
jdk.unsupported
```

The exact module list is generated and measured per target. Release CI records
the compressed installer delta and uncompressed runtime size. A full JDK is
never shipped.

### Process and class-loading model

Version 1 uses one lazy-started JDBC host process per Nyala application
instance and one isolated class loader per connector ID and version.

- The host starts only when the first JDBC connector operation is requested.
- One connector version is active for new sessions at a time.
- Existing sessions remain pinned to the version that opened them.
- A connector update is installed side by side and activated only after its
  previous sessions close or the host restarts.
- The Rust broker owns startup, health checks, restart limits, shutdown, and
  mapping between frontend connection IDs and opaque host session IDs.
- Connector JARs never enter the Rust process, Node extension host, or WebView.

Class-loader isolation prevents ordinary dependency collisions. It is not a
security sandbox. All marketplace connectors are executable code running with
the desktop user's OS permissions. Version 1 therefore permits only curated
and cryptographically verified packages in normal mode.

Unsigned local packages are allowed only behind an explicit Developer Mode.
They are labeled untrusted, never auto-started, and cannot be submitted to the
marketplace without passing the publishing pipeline. Stronger OS-level
sandboxing or a process per untrusted connector is deferred to a later ADR.

### IPC protocol

Rust and Java communicate over the child's stdin/stdout. The process does not
listen on TCP, does not publish a local port, and receives no secret through
command-line arguments or environment variables.

Frames use a fixed-size length prefix followed by UTF-8 JSON. Standard output
is reserved for protocol frames; sanitized host logs go to standard error.
Every request carries a request ID, deadline, protocol version, and operation.

The initial protocol supports:

```text
handshake
loadConnector
testConnection
openConnection
closeConnection
listCatalogs
listSchemas
listTables
listColumns
execute
cancel
beginTransaction
commit
rollback
ping
shutdown
```

Long query results are emitted as `resultStart`, bounded `rowBatch`, and
`resultEnd` messages rather than one unbounded response. Version 1 may encode
binary cells as base64; a binary Arrow IPC transport can be added through a
negotiated protocol capability without changing Workbench service APIs.

Protocol requirements:

- Handshake fails closed on incompatible major versions.
- Unknown fields are ignored within a compatible major version.
- Every frame and row batch has a hard size limit.
- Every operation supports a deadline; cancellation is best effort and reports
  whether `Statement.cancel()` or connection close was required.
- Host crashes fail all affected requests with structured `host_unavailable`
  errors. Rust may restart the host, but never silently retry writes.
- Error DTOs may include SQL state and vendor code but must redact URLs,
  usernames when configured as sensitive, and all secret values.

### Connection and secret ownership

Saved profiles continue to contain public connection fields only. Secrets are
passed to Rust as transient `ConnectionSecret` values and sent once to the host
inside an `openConnection` or `testConnection` frame.

- Secrets are never written to connector directories, receipts, logs, crash
  reports, process arguments, or marketplace metadata.
- The host keeps credentials only for the lifetime required by JDBC.
- The host passes credentials to the selected JDBC driver through connection
  properties, not through a string assembled for logging.
- A connector manifest can declare secret fields, but cannot provide code that
  reads another connector's or another profile's secrets.

Java and JDBC APIs cannot guarantee immediate zeroization of every credential
copy. The security contract is therefore no persistence, no logging, minimal
lifetime, and process teardown on host shutdown, not a false promise of perfect
in-memory erasure.

### Safety ownership

Read-only policy remains a Nyala product rule and is not delegated to an
arbitrary JDBC driver.

1. Rust applies the existing statement safety policy before dispatch.
2. The host calls `Connection.setReadOnly(true)` where supported.
3. A first-party dialect/runtime adapter may issue a database-specific
   read-only transaction command where reliable.
4. The host rejects protocol operations inconsistent with the session's mode.

`Connection.setReadOnly` is only a JDBC hint for some drivers and is never the
sole write barrier. No write is silently retried after timeout or host failure.

### Connector implementation levels

Most connectors are declarative and contain an upstream JDBC driver plus a
manifest. They specify driver class, URL template, connection fields,
capabilities, and artifact hashes. No Nyala-specific Java code is required.

An optional advanced adapter may be introduced for metadata quirks that cannot
be handled by standard `DatabaseMetaData`. Such an adapter:

- implements a small, versioned Nyala JDBC Host SPI;
- cannot contribute UI, commands, arbitrary filesystem access, or a second
  update mechanism;
- does not receive raw credentials unless the SPI operation inherently opens a
  JDBC connection;
- is reviewed and signed like every other executable artifact.

The declarative path is the compatibility baseline. Advanced adapter APIs must
not be required merely to wrap a JDBC 4 driver.

### Driver and dialect remain separate

A connector declares one `dialectId`, such as `mysql`, `postgres`, or
`generic-sql`. That reference influences editor and formatter selection through
existing SQL services. Installing a connector does not install executable
Workbench code and does not elevate a dialect's product maturity.

Supporting an entirely new dialect can later require a separate Workbench
extension dependency. Connector installation must remain useful with the
`generic-sql` fallback when such a dependency is absent.

### Runtime status remains authoritative

These states are independent:

| State            | Source                    | Example                                             |
| ---------------- | ------------------------- | --------------------------------------------------- |
| Product maturity | Rust runtime status table | stable, preview, planned, disabled                  |
| Package state    | Connector package service | not installed, installed, update available, revoked |
| Runtime health   | JDBC broker               | stopped, starting, ready, failed                    |
| Session state    | Connection manager        | closed, opening, open, error                        |

Installing a JAR never changes `planned` to `preview` or `stable`. Enabling a
new runtime requires its phase acceptance criteria, tests, and an explicit
runtime status change.

## Alternatives considered

### Implement every database protocol in Rust

Rejected as the default ecosystem strategy. Native Rust drivers can remain for
specific databases where they are already stable, but reproducing JDBC breadth
would multiply compatibility, authentication, metadata, and maintenance work.

### Embed the JVM through JNI

Rejected. JNI would couple JVM crashes and thread attachment to the Tauri
process, complicate dynamic class loading, conflict with the repository's
`unsafe_code = deny` posture, and make packaging failures harder to isolate.

### Require a system JVM

Rejected for production. It produces smaller downloads but makes Java version,
modules, security updates, and supportability depend on the user's machine.

### Compile the host with GraalVM Native Image

Rejected for the general connector runtime. Closed-world analysis and
reflection configuration conflict with installing arbitrary JDBC JARs after
the application was built. Native images remain possible for a fixed,
first-party connector, but not as the ecosystem boundary.

### Run a remote JDBC gateway

Rejected as the default. It removes the local JVM but requires server
deployment and sends connection traffic through an additional service, which
conflicts with Nyala's local-first desktop model.

## Consequences

Positive consequences:

- Nyala can reuse JDBC drivers and vendor compatibility work.
- Database code is isolated from the WebView and Rust address space.
- Connector releases no longer require a full application release.
- Existing SQL service contracts remain the frontend boundary.
- A declarative connector can be authored with little or no Java code.

Costs and limitations:

- Each platform bundle gains a minimal Java runtime, expected to add roughly
  40-90 MB uncompressed before release measurement.
- One JVM adds startup and memory overhead when JDBC is first used.
- JDBC calls are blocking and require bounded host worker pools.
- Class-loader isolation does not prevent malicious code from using the desktop
  user's filesystem or network permissions.
- JDBC metadata is inconsistent across vendors; tested first-party adapters
  will still be needed for product-quality behavior.
- Cross-process result streaming and cancellation become explicit protocols
  that require compatibility tests.

## Acceptance criteria

This ADR can move to `Accepted` when reviewers approve:

- the terminology and separation from Workbench extensions;
- bundled Java 21 `jlink` runtime versus system JVM behavior;
- the length-prefixed, versioned IPC boundary;
- the secret, read-only, and crash behavior;
- the decision to keep SQLite native during initial rollout;
- package distribution and trust behavior in ADR 0002.

Implementation is complete only after a focused JDBC host slice can open,
query, stream bounded results, cancel, and close one MySQL test connection while
the existing SQLite path and all SQL MVP tests remain green.

## Open follow-up decisions

- Whether untrusted local connectors require one JVM process per connector.
- Whether binary Arrow IPC is needed before large-result streaming exits
  preview.
- Which Java distribution and update cadence are approved for release builds.
- Whether connector adapters are allowed in marketplace version 1 or only after
  declarative connectors reach parity for MySQL and PostgreSQL.
