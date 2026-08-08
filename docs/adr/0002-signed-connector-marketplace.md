# ADR 0002: Signed Connector Marketplace and Installation

- Status: Proposed
- Date: 2026-08-08
- Owners: Connector Platform, Product Security, Release Engineering
- Related: [ADR 0001](./0001-jdbc-sidecar-and-connector-boundary.md), [Connector package specification](../connectors/connector-package-spec.md), [Connector authoring guide](../connectors/authoring-guide.md)

## Context

Database connectors are executable Java code. A connector can observe the
database credentials and query traffic passed to its JDBC driver and, without
an OS sandbox, can access resources available to the desktop user. Connector
installation therefore cannot be treated as downloading a theme or static
asset.

Phase 08 currently embeds one Ed25519-signed JSON manifest and pins one public
key in the application. That implementation is appropriate for a small,
first-party bootstrap list. A production marketplace additionally needs:

- key rotation and threshold trust;
- protection against rollback and frozen metadata;
- immutable package identity and version history;
- compatibility filtering;
- atomic installation and rollback;
- revocation and security advisories;
- explicit license and permission disclosure;
- support for drivers that cannot legally be redistributed;
- a path for private enterprise repositories and local development.

## Decision

Nyala Studio will provide a curated connector marketplace backed by static,
cryptographically signed repository metadata. The repository will use The
Update Framework (TUF) trust model rather than a custom single-key manifest.

The first marketplace version distributes only `databaseConnector` packages.
It does not distribute Workbench JavaScript, Node extensions, WASM extensions,
themes, agents, or arbitrary native binaries. A future unified catalogue may
display multiple package kinds, but each kind keeps its own runtime, permission,
and install policy.

### Repository layout

A repository can be served from object storage and a CDN:

```text
/<repository>/
  tuf/
    root.json
    timestamp.json
    snapshot.json
    targets.json
    delegated/*.json
  catalog/v1/catalog.json
  advisories/v1/advisories.json
  packages/<publisher>/<name>/<version>/<digest>.nyala-connector
```

`catalog.json`, `advisories.json`, and every connector archive are TUF targets.
Search metadata is useful for discovery but never sufficient to authorize an
installation. Before download, the client resolves an exact target path,
length, digest, and compatibility record from verified, non-expired metadata.

The initial catalogue is downloaded and searched locally. A server-side search
API may be added when catalogue size requires it, but its responses are
untrusted hints and must be reconciled with signed target metadata before the
Install button becomes actionable.

### Root trust and key operation

- The official repository root metadata is pinned in the application bundle.
- Root metadata uses offline threshold keys. No single online key can replace
  the root of trust.
- Timestamp metadata uses a short-lived online key so stale/frozen repository
  state is detected.
- Snapshot and target roles are versioned and expiry checked.
- Root rotation follows the TUF consecutive-version update procedure.
- Release operations publish metadata only after all referenced targets are
  uploaded and immutable.
- Signing keys never live in the application repository or ordinary CI logs.

Version 1 is curated: the Nyala marketplace operator signs accepted targets and
is accountable for the publisher and license metadata it exposes. Delegated
publisher roles and Sigstore provenance may be added later, but do not replace
repository target verification.

### Repository sources

Nyala recognizes three source classes:

| Source     | Trust                                             | Default behavior                                                            |
| ---------- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| Official   | Root bundled with Nyala                           | Enabled by default; curated packages only.                                  |
| Enterprise | Root explicitly imported by an administrator/user | Disabled until trust root and URL are confirmed. Source is always visible.  |
| Local file | Exact `.nyala-connector` selected by the user     | Signed package accepted normally; unsigned package requires Developer Mode. |

Repository roots are isolated. Trusting an enterprise root does not allow it to
replace packages from the official namespace unless an explicit namespace
override policy is configured. Repository URLs must use HTTPS except loopback
development repositories in Developer Mode.

Nyala does not bind this feature to Microsoft Marketplace, the existing SideX
marketplace endpoint, or Maven Central's search API. Maven Central may be an
upstream artifact source during marketplace publishing, but desktop clients do
not resolve Maven coordinates or execute dependency resolution at runtime.

### Package identity and versioning

Connector identity is `<publisher>.<name>`, lowercase ASCII, and immutable once
published. Versions use SemVer. Reusing an identity/version pair with different
bytes is forbidden.

Each target records:

```json
{
	"kind": "databaseConnector",
	"id": "nyala.postgresql",
	"version": "1.0.0",
	"channel": "stable",
	"nyalaEngine": ">=0.2.0 <0.3.0",
	"jdbcHostProtocol": ">=1.0.0 <2.0.0",
	"java": ">=21 <22",
	"length": 1200000,
	"sha256": "..."
}
```

Stable users do not receive prerelease versions unless they explicitly opt into
the connector's preview channel. Compatibility is evaluated before download
and again before activation.

### Package formats and licensing

The package format is a deterministic ZIP archive with the extension
`.nyala-connector`. Its contents are defined in the connector package
specification.

Two artifact delivery modes are supported:

1. `bundled`: redistributable JDBC JARs are inside the signed package.
2. `userProvided`: the package contains metadata and accepted artifact
   fingerprints; the user supplies a driver obtained under the vendor's terms.

The installer never follows an arbitrary driver URL from a connector manifest.
For `userProvided`, Nyala may open a documented vendor webpage in the system
browser, but it does not scrape, authenticate to, or automatically download
from that site. The selected local file is copied into the connector version's
managed directory after all declared checks pass.

Every package declares SPDX license expressions and includes notices for all
redistributed artifacts. Marketplace ingestion blocks packages with missing or
inconsistent license material. Legal approval remains a release requirement,
not a property inferred from a successful hash check.

### Marketplace user experience

The Connector catalogue is a Workbench view backed by SQL connector services.
It exposes:

- search and categories such as Embedded, Server, Warehouse, and Analytics;
- publisher, source, version, channel, license, package size, and trust status;
- product maturity separately from installation state;
- Install, Update, Roll Back, Disable, Enable, and Uninstall commands;
- release notes and security advisories;
- local package installation and repository management commands.

Installation is always an explicit command. Selecting a connector in the New
Data Source editor may offer an Install action, but cannot start a background
download merely because the card was focused.

Normal package states are:

```text
notInstalled
checking
downloading
verifying
staging
installed
updateAvailable
pendingActivation
active
disabled
incompatible
revoked
failed
pendingRemoval
```

Package state does not change the authoritative driver maturity. For example,
an installed PostgreSQL connector remains unusable while PostgreSQL runtime
status is `planned`.

### Download and installation transaction

Every installation follows this state machine:

```text
resolve signed target
  -> confirm source/license/size
  -> download to same-filesystem temporary file
  -> verify target length and digest while streaming
  -> parse archive into a staging directory
  -> validate package and every artifact
  -> write installation receipt
  -> fsync files and parent directory where supported
  -> atomically rename staging to <id>/<version>
  -> atomically update installed-state index
  -> activate now or mark pending activation
```

The installer enforces:

- HTTPS and redirect policy tied to trusted repository configuration;
- connection, total download, and idle timeouts;
- declared compressed size, maximum uncompressed size, and file-count limits;
- safe ZIP paths with no absolute paths or `..` traversal;
- no symlinks, hardlinks, devices, post-install scripts, or executable native
  files in marketplace version 1;
- JSON Schema validation and unknown critical-field rejection;
- exact artifact path, length, and SHA-256 validation;
- connector ID/version agreement between target metadata and package manifest;
- engine, host protocol, and Java compatibility;
- duplicate ID and namespace ownership rules.

Validation does not load or execute the JDBC driver. Driver class loading first
occurs when the user tests or opens a connection. This prevents installation
from becoming an implicit code-execution event.

Partially downloaded and staged content is never visible as installed. Startup
cleanup can remove abandoned temporary directories older than a defined grace
period after checking that no install lock is active.

### Receipts and local state

Each installed version gets an immutable receipt containing:

- package ID and version;
- target digest and length;
- repository ID and trusted root version;
- install timestamp;
- manifest digest and artifact digests;
- selected channel;
- whether artifacts were bundled or user-provided;
- activation and compatibility decision.

Receipts contain no credential, database URL, username, query, host name, or
connection profile ID. Global state records the enabled version and update
policy. State writes use a temporary file plus atomic replacement.

### Updates, rollback, and uninstall

- Updates install side by side; they never overwrite the active version.
- Existing sessions stay pinned to their connector version.
- A compatible update activates after sessions close or after a JDBC host
  restart initiated by the user/app lifecycle.
- At least one previously working version is retained until the new version
  completes a successful local connection test or the user removes it.
- Rollback changes the active version pointer and restarts only affected JDBC
  runtime state.
- Uninstall of an in-use connector becomes `pendingRemoval` and completes after
  its last session closes.
- Automatic background checks are allowed. Automatic installation is opt-in;
  automatic activation never interrupts an active transaction.

### Revocation and advisories

The signed advisory target can mark a connector version as:

| Severity              | Client behavior                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| informational         | Display notice.                                                                                |
| updateRecommended     | Offer a compatible update prominently.                                                         |
| blockedForNewSessions | Keep files for rollback/audit, but prevent new sessions.                                       |
| revoked               | Disable activation and require an explicit security override available only in Developer Mode. |

Revocation is a signed repository policy, not an unauthenticated remote kill
switch. Offline clients use the most recent unexpired metadata they possess.
Expired metadata prevents new marketplace installs; it does not silently delete
installed connectors or terminate active database transactions.

### Publishing pipeline

The official repository accepts packages through a review pipeline rather than
direct client uploads:

```text
scaffold
  -> validate manifest/schema
  -> run connector contract tests
  -> build reproducibly
  -> generate SBOM and notices
  -> scan dependencies and archive
  -> verify upstream provenance/license
  -> human review for new publishers/capabilities
  -> immutable upload
  -> threshold metadata signing
  -> publish timestamp last
```

Publishing checks are deterministic CLI operations. The future connector
development skill must invoke these commands and schemas; it must not implement
its own packaging or signing logic.

### Privacy and observability

Marketplace requests contain only the information required to fetch repository
metadata and packages. Nyala does not upload connection profiles, installed
database hosts, queries, results, or credentials.

Installation logs include package ID, version, repository ID, state transitions,
digest prefixes, and structured error codes. They exclude full local paths when
unnecessary and always exclude connection data and secrets. Marketplace usage
telemetry requires a separate explicit product decision.

## Alternatives considered

### Keep the embedded single-key manifest as the marketplace

Rejected for production scale. It lacks robust root rotation, threshold trust,
expiry, rollback protection, delegated ownership, and signed advisories. It
remains acceptable as a temporary bootstrap catalogue during migration.

### Download declared Maven coordinates directly on the desktop

Rejected. Runtime dependency resolution expands the network and supply-chain
surface, makes builds non-reproducible, and cannot solve vendor redistribution
licenses. Publishing resolves and reviews artifacts before client delivery.

### Use Open VSX or VSIX packages for JDBC connectors

Rejected. Those formats and trust expectations target editor extensions, not
JDBC code that receives database credentials. The existing extension stack can
remain for Workbench compatibility, but it is not the connector installer.

### Allow arbitrary package URLs

Rejected in normal mode. An arbitrary URL bypasses namespace, compatibility,
revocation, and repository trust. Developer Mode may install a user-selected
local archive with explicit warnings.

### Build a dynamic marketplace backend first

Rejected for version 1. A signed static catalogue on object storage is easier
to audit and operate. Accounts, ratings, analytics, and paid packages are not
required to safely discover and install connectors.

## Consequences

Positive consequences:

- Downloads remain verifiable even when delivered by an untrusted CDN.
- Connector updates, rollback, and revocation have explicit semantics.
- Static hosting keeps initial marketplace operations small.
- Enterprise and offline repositories can use the same format.
- Drivers with restrictive redistribution terms have a supported path.

Costs and limitations:

- TUF repository operation and offline key custody add release complexity.
- Marketplace curation requires license and security review.
- Side-by-side versions consume additional disk space.
- A signed package is trusted provenance, not a sandbox or proof of benign code.
- Version 1 cannot ship native driver libraries or install scripts.
- The current Phase 08 package service must be migrated rather than expanded
  into an incompatible second marketplace protocol.

## Acceptance criteria

This ADR can move to `Accepted` after review confirms:

- TUF as the repository trust model;
- static signed catalogue as the version 1 discovery model;
- explicit install and side-by-side atomic activation;
- `bundled` and `userProvided` artifact delivery modes;
- no native binaries, scripts, or arbitrary URLs in marketplace version 1;
- revocation behavior and Developer Mode boundaries;
- separation from the Workbench extension marketplace.

Marketplace implementation is not complete until tampered metadata, expired
metadata, rollback attempts, redirect escape, size mismatch, digest mismatch,
ZIP traversal, interrupted install, incompatible engine, revoked package,
in-use update, rollback, and uninstall recovery all have automated tests.

## Open follow-up decisions

- Exact threshold values and operational ownership for official signing keys.
- Retention limit for old connector versions and package cache.
- Whether verified third-party publishers receive delegated TUF roles.
- Whether organization policy may mandate automatic security updates.
- Whether a future marketplace combines search UI for Workbench extensions and
  connectors while preserving separate installation services.
