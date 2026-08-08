# Database Connector Authoring Guide

- Status: Proposed
- Audience: JDBC driver vendors, Nyala maintainers, and third-party connector authors
- Template: [`template/declarative-jdbc`](./template/declarative-jdbc/README.md)

## Choose the smallest connector

Start with a declarative connector. A normal JDBC 4 driver already implements
connection opening, statements, results, transactions, cancellation, and
metadata. The connector package should describe how Nyala loads and configures
that driver rather than wrap every JDBC method in new code.

Use a custom Java adapter only after a contract test demonstrates a specific
vendor incompatibility that cannot be fixed in the first-party host or manifest
schema. "We may need it later" is not sufficient justification.

## Prerequisites

Before authoring a package, establish:

- the exact JDBC artifact and driver class;
- supported database server versions;
- JDBC and Java compatibility;
- redistribution license and required notices;
- JDBC URL syntax and public connection fields;
- which secrets the driver needs;
- metadata behavior and known quirks;
- whether cancellation and read-only mode are genuinely supported;
- a disposable integration database for release tests.

Do not begin by downloading a random JAR into the application bundle. The
artifact and its provenance are part of the connector's public contract.

## Planned authoring commands

The connector toolchain is not implemented yet. Before external authoring is
advertised, the repository should provide these exact package scripts:

```bash
pnpm run connector:init -- --id example.acmedb --output ./acmedb-connector
pnpm run connector:validate -- ./acmedb-connector
pnpm run connector:test -- ./acmedb-connector --profile integration
pnpm run connector:pack -- ./acmedb-connector --output ./dist
pnpm run connector:verify -- ./dist/example.acmedb-1.0.0.nyala-connector
```

Their intended responsibilities are:

| Command              | Contract                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `connector:init`     | Copy the canonical template and replace identity placeholders. No network access.                                          |
| `connector:validate` | Validate schema, semantic rules, artifacts, licenses, SBOM, deterministic inputs, and prohibited files. No code execution. |
| `connector:test`     | Start the JDBC host in contract-test mode and run explicit unit/live fixtures. Never run without an explicit profile.      |
| `connector:pack`     | Create a deterministic archive and print its length and SHA-256.                                                           |
| `connector:verify`   | Re-open the final archive and repeat install-time validation without installing it.                                        |

The future developer skill must call these commands rather than reimplement
validation or ZIP assembly in generated scripts.

## Authoring workflow

### 1. Establish identity and ownership

Choose an immutable ID such as `acme.acmedb`. Confirm that the publisher owns
the namespace and that package/repository metadata use exactly the same ID.

Use the database product name for `displayName`; do not use "official" unless
the database vendor publishes or explicitly endorses the connector.

### 2. Audit the JDBC artifact

Record:

- upstream project and source repository;
- Maven coordinates or vendor release page used during publication;
- version and SHA-256;
- driver class;
- transitive JARs;
- SPDX license expression;
- notices and source-offer obligations;
- known CVEs and supported Java release.

Use `bundled` delivery only when redistribution is permitted. For restricted
drivers, use `userProvided` with reviewed hashes and an HTTPS vendor download
page. Do not turn a browser download URL into a hidden runtime dependency.

### 3. Define the connection model

Expose the smallest set of fields needed to open a connection. Prefer the
standard IDs:

```text
host
port
database
username
password
sslMode
```

Public profile values use `persistence: "profile"`. Passwords, access tokens,
private keys, and temporary credentials use `type: "secret"` and
`persistence: "never"`.

Do not expose a full JDBC URL field in marketplace version 1. A full URL can
contain credentials, enable driver-specific file access, or bypass validated
host/port fields. New URL shapes should extend the package specification
through review.

### 4. Build URL and properties declaratively

Keep the URL limited to `{host}`, `{port}`, and `{database}`. Send username,
password, SSL mode, and vendor options as JDBC properties.

Good:

```json
{
	"jdbcUrlTemplate": "jdbc:acme://{host}:{port}/{database}",
	"connectionProperties": [
		{ "name": "user", "field": "username" },
		{ "name": "password", "field": "password" }
	]
}
```

Rejected:

```json
{
	"jdbcUrlTemplate": "jdbc:acme://{username}:{password}@{rawHostAndOptions}"
}
```

### 5. Declare measured capabilities

Capabilities are claims backed by tests, not marketing labels. Omit a capability
until its contract passes on every supported server/driver version.

For example, declare `query.cancel` only when an in-flight query can be
cancelled within a bounded time and the connection remains in a known state.
Declare `transaction` only when begin, commit, rollback, and close cleanup have
repeatable behavior.

### 6. Add contract tests

Unit validation must run without a database and cover:

- manifest and semantic validation;
- URL rendering for DNS, IPv4, IPv6, spaces, and non-ASCII database names;
- secret exclusion from profiles, errors, and logs;
- type conversion fixtures;
- malformed metadata and driver exception mapping;
- timeout and cancellation state transitions.

Live integration tests are opt-in and run only against a disposable database.
They cover:

- valid and invalid authentication;
- TLS modes supported by the connector;
- `SELECT 1` and structured errors;
- tables, views, columns, nullable/default/primary-key metadata;
- NULL, signed/unsigned integer, decimal precision, floating point, boolean,
  Unicode text, date/time/timestamp, JSON, and binary values where supported;
- read-only write rejection;
- result truncation and fetch size;
- cancellation and post-cancel connection health;
- transaction commit and rollback;
- connection close and process shutdown;
- no leaked validation table or session after failure.

Credentials are supplied through connector-specific test environment variables
and are never committed or printed. CI logs use redaction fixtures containing
sentinel secrets and fail if a sentinel appears.

### 7. Package reproducibly

Generate the SBOM from the same resolved artifacts placed in `lib/`. Normalize
archive timestamps and ordering. Run `connector:verify` against the final bytes,
not only the source directory.

Record the resulting archive digest in the publication request. Never manually
edit or re-ZIP a package after verification.

### 8. Publish through review

A new package or publisher requires review of identity, license, artifact
provenance, URL/property behavior, requested capabilities, and live-test
evidence. A version update repeats automated checks and receives human review
when permissions, artifacts, license, or compatibility ranges change.

The marketplace operator publishes immutable target bytes before signing new
repository metadata. Authors do not receive official repository signing keys.

## JDBC best practices

### Connection lifecycle

- Let the JDBC host own session and transaction lifetime.
- Do not add HikariCP or another pool inside a connector package by default.
- Set connect and socket timeouts using documented driver properties.
- Close `ResultSet`, `Statement`, and `Connection` deterministically.
- Treat network failures as connection state changes, not only query errors.
- Never retry a write unless the user initiates a retry with known transaction
  state.

### Result handling

- Stream rows in bounded batches; never call helpers that materialize an
  unbounded result set.
- Preserve `DECIMAL`/`NUMERIC` as exact strings plus type metadata.
- Preserve temporal values and timezone information without converting through
  the workstation's default timezone.
- Encode binary values explicitly and enforce cell-size limits.
- Return database NULL as the protocol null variant, not the string `"NULL"`.
- Include JDBC type code and vendor type name even when the Workbench initially
  renders a simplified cell type.

### Metadata

- Prefer `DatabaseMetaData` and deterministic sorting.
- Filter system schemas only through explicit product policy, not a hidden
  connector assumption.
- Preserve catalog and schema as separate dimensions even when a database uses
  only one.
- Test quoted, mixed-case, Unicode, and reserved-word identifiers.
- Escape metadata search patterns according to the driver's JDBC behavior.

### Cancellation

- Keep the executing `Statement` associated with the protocol request ID.
- Call `Statement.cancel()` first when supported.
- Apply a bounded grace period, then close the connection if the driver remains
  blocked.
- Report whether the connection is reusable after cancellation.
- Never report cancellation as query success or silently retry it.

### Errors and logging

- Preserve SQL state, vendor code, and a sanitized message.
- Map connection, authentication, TLS, timeout, cancellation, syntax, and
  permission failures to stable Nyala codes where possible.
- Never log JDBC properties, full URLs, query result rows, or credentials.
- Avoid logging SQL text by default; diagnostics may log a request ID and
  statement class instead.
- Send protocol data only to stdout and sanitized logs only to stderr.

### Dependencies

- Keep connector dependencies minimal and pinned.
- Do not shade a second logging framework or JSON stack unless required by the
  upstream driver.
- Avoid duplicate JDBC driver versions in one package.
- Do not use dynamic classpath scanning, remote class loading, JNI, or native
  libraries in marketplace version 1.
- Publish an SBOM and update promptly for security fixes.

## Anti-patterns

The following fail review:

- a connector that contributes a custom login WebView;
- credentials embedded in a JDBC URL, manifest, fixture, or process argument;
- a post-install script that downloads Maven dependencies;
- `DriverManager` global registration used to affect another connector;
- a package that claims every capability without contract tests;
- catching `SQLException` and returning only `error.toString()`;
- buffering all rows before returning the first batch;
- using `Connection.setReadOnly(true)` as the only write barrier;
- shipping an unsigned replacement JAR under an existing version;
- requiring users to disable TLS certificate validation to connect.

## Definition of done for a connector release

- Manifest passes schema and semantic validation.
- Publisher identity and version are immutable and consistent.
- Every artifact has verified provenance, digest, license, and SBOM entry.
- No secret can reach saved profiles, receipts, logs, or diagnostics.
- Declared capabilities pass unit and live contract tests.
- Package is deterministic and the final archive passes independent verify.
- Compatibility ranges are tested against supported Nyala/JDBC host versions.
- Installation, update, rollback, disable, and uninstall behavior is covered.
- Security advisory and support contacts are documented.
- Product runtime maturity changes only through its own phase acceptance review.
