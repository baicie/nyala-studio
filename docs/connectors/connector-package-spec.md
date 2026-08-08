# Nyala Database Connector Package Specification v1

- Status: Proposed
- Package kind: `databaseConnector`
- Archive extension: `.nyala-connector`
- Manifest: `nyala-connector.json`
- JSON Schema: [`schema/nyala-connector-v1.schema.json`](./schema/nyala-connector-v1.schema.json)

## 1. Scope

This specification defines the installable package consumed by the JDBC host
architecture in ADR 0001 and the marketplace transaction in ADR 0002.

Version 1 supports pure-Java JDBC drivers and an optional reviewed Java adapter.
It does not support:

- Workbench JavaScript or CSS;
- Node, VSIX, or WASM extension entry points;
- native libraries or executables;
- post-install, activation, or uninstall scripts;
- arbitrary filesystem or network capabilities;
- runtime Maven/Gradle dependency resolution;
- connector-defined credential storage;
- connector-defined HTML connection forms.

## 2. Archive layout

A `.nyala-connector` is a deterministic ZIP archive with this root layout:

```text
nyala-connector.json       required
lib/                       bundled JDBC and optional adapter JARs
assets/icon.png            optional, static image only
LICENSES/                  required for bundled third-party artifacts
SBOM/cyclonedx.json        required for marketplace publication
README.md                  optional author documentation
```

The manifest must be at the archive root. A wrapper directory is not allowed.
Archive entries must use `/` separators and normalized relative paths.

Marketplace version 1 rejects:

- absolute paths and `..` path segments;
- symbolic links, hardlinks, device nodes, and executable bits;
- duplicate or case-colliding paths;
- encrypted ZIP entries;
- nested archives unless explicitly declared as passive documentation;
- files not declared by the manifest, except `README.md`, `LICENSES/**`, and
  `SBOM/**`;
- an archive whose expanded size or file count exceeds installer policy.

## 3. Manifest example

```json
{
	"$schema": "https://schemas.nyala.dev/connectors/v1/nyala-connector.schema.json",
	"schemaVersion": 1,
	"kind": "databaseConnector",
	"id": "example.acmedb",
	"displayName": "AcmeDB",
	"description": "Connect to AcmeDB through its JDBC 4 driver.",
	"version": "1.0.0",
	"publisher": {
		"id": "example",
		"displayName": "Example Database Company",
		"homepage": "https://example.invalid"
	},
	"license": "Apache-2.0",
	"engines": {
		"nyala": ">=0.2.0 <0.3.0",
		"jdbcHostProtocol": ">=1.0.0 <2.0.0",
		"java": ">=21 <22"
	},
	"connector": {
		"driverId": "acmedb",
		"dialectId": "generic-sql",
		"driverClass": "com.example.acme.jdbc.AcmeDriver",
		"jdbcUrlTemplate": "jdbc:acme://{host}:{port}/{database}",
		"defaultPort": 15432,
		"artifacts": [
			{
				"id": "jdbc-driver",
				"role": "driver",
				"delivery": "bundled",
				"path": "lib/acmedb-jdbc-1.0.0.jar",
				"sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				"sizeBytes": 1234567
			}
		],
		"connectionFields": [
			{
				"id": "host",
				"label": "Host",
				"type": "string",
				"required": true,
				"persistence": "profile"
			},
			{
				"id": "port",
				"label": "Port",
				"type": "integer",
				"required": true,
				"persistence": "profile",
				"default": 15432,
				"minimum": 1,
				"maximum": 65535
			},
			{
				"id": "database",
				"label": "Database",
				"type": "string",
				"required": true,
				"persistence": "profile"
			},
			{
				"id": "username",
				"label": "Username",
				"type": "string",
				"required": true,
				"persistence": "profile"
			},
			{
				"id": "password",
				"label": "Password",
				"type": "secret",
				"required": false,
				"persistence": "never"
			},
			{
				"id": "sslMode",
				"label": "SSL mode",
				"type": "enum",
				"required": true,
				"persistence": "profile",
				"default": "prefer",
				"options": ["disable", "prefer", "require"]
			}
		],
		"connectionProperties": [
			{ "name": "user", "field": "username", "omitWhenEmpty": true },
			{ "name": "password", "field": "password", "omitWhenEmpty": true },
			{ "name": "sslMode", "field": "sslMode", "omitWhenEmpty": true }
		],
		"capabilities": [
			"connection.test",
			"query.execute",
			"query.cancel",
			"transaction",
			"metadata.catalogs",
			"metadata.schemas",
			"metadata.tables",
			"metadata.columns"
		],
		"defaults": {
			"connectTimeoutMs": 5000,
			"socketTimeoutMs": 30000,
			"fetchSize": 500,
			"maxRows": 100000
		}
	},
	"assets": {
		"icon": "assets/icon.png"
	},
	"support": {
		"homepage": "https://example.invalid/acmedb",
		"issues": "https://example.invalid/acmedb/issues"
	}
}
```

## 4. Identity

`id` has the form `<publisher>.<name>` and is globally immutable after its
first marketplace publication. Both segments use lowercase ASCII letters,
digits, and hyphens. The publisher object must agree with the ID prefix.

`version` uses SemVer without a leading `v`. Republishing different bytes under
an existing ID/version is forbidden, including prerelease versions.

`driverId` is the runtime driver identity exposed to Nyala SQL services. It is
not automatically created by installing the package. A product release must
recognize that driver ID and its authoritative runtime status before sessions
can open.

## 5. Engine compatibility

The `engines` object defines three independent compatibility ranges:

- `nyala`: product API and package behavior understood by the desktop app;
- `jdbcHostProtocol`: Rust-to-Java protocol major/minor compatibility;
- `java`: Java feature release supported by connector bytecode and driver.

Ranges use the SemVer range subset selected by the package validator. Java
feature releases are represented as SemVer-compatible integers in the range
syntax. The package CLI and client must use the same range implementation and
contract fixtures.

Compatibility is checked at catalogue display, install, activation, and host
handshake. An installed incompatible version remains on disk for rollback but
cannot become active.

## 6. JDBC driver loading

`driverClass` names the JDBC `java.sql.Driver` implementation. The host loads it
from the connector's isolated class loader and calls the driver directly. It
does not depend on global `DriverManager` registration or the thread context
class loader.

The driver should implement JDBC 4 and may also provide
`META-INF/services/java.sql.Driver`. The explicit manifest class remains the
source of truth so loading is deterministic.

Exactly one artifact has role `driver`. Optional artifacts can have role
`dependency` or `adapter`. All are loaded only from the installed connector
version. A connector cannot add JARs to the application, Workbench extension
host, or another connector's class path.

## 7. JDBC URL and connection properties

Version 1 URL templates accept only these placeholders:

```text
{host}
{port}
{database}
```

The host validates and renders them by type:

- `host`: normalized DNS name, IPv4, or bracketed IPv6 host;
- `port`: integer from 1 through 65535;
- `database`: encoded as one URL path segment.

Unknown placeholders are invalid. Username, password, token, and other secrets
must not appear in `jdbcUrlTemplate`.

Additional driver options use `connectionProperties`. Each mapping references a
declared connection field and becomes a JDBC `Properties` entry. The host does
not log property values. Duplicate property names are invalid. A property name
cannot alter the JDBC URL, driver class, classpath, Java system properties, or
host process options.

Connectors whose JDBC syntax cannot be expressed by this v1 template require a
reviewed specification extension; they must not concatenate a raw user-provided
URL in a hidden adapter.

## 8. Connection fields

Connection forms are generated from declarative fields. Version 1 supports:

| Type      | UI and validation                                           |
| --------- | ----------------------------------------------------------- |
| `string`  | Single-line text with length and required validation.       |
| `integer` | Numeric input with minimum and maximum.                     |
| `boolean` | Checkbox/toggle.                                            |
| `enum`    | Select/menu restricted to declared options.                 |
| `secret`  | Masked transient input; never returned in profile listings. |

Field IDs are stable API. `host`, `port`, `database`, `username`, `password`,
and `sslMode` use their standard meanings when present.

Persistence is explicit:

- `profile`: safe public value may be persisted in a saved profile;
- `never`: value is transient and omitted from saved profiles, receipts, logs,
  and diagnostics.

Every `secret` field must use `persistence: "never"`. A non-secret field must
not be used to smuggle an access token, password, private key, or full
credential-bearing URL into storage.

Version 1 manifests define validation and labels only. They cannot provide HTML,
JavaScript, CSS, expressions, event handlers, or arbitrary regular expressions.

## 9. Artifact delivery

Each artifact uses one delivery mode.

### Bundled

`delivery: "bundled"` requires `path`, `sha256`, and `sizeBytes`. The artifact
must exist inside the archive at exactly that path. It is covered by the outer
marketplace target digest and verified again against the manifest.

### User-provided

`delivery: "userProvided"` omits `path` and declares:

- `acceptedArtifacts`: reviewed file name, vendor version, byte length, and
  SHA-256 tuples;
- `vendorDownloadPage`: an HTTPS page opened only by explicit user action.

The marketplace package cannot contain an automatic download URL for this mode.
The user-selected file is copied into managed storage and its digest is written
to the install receipt. An unknown digest is rejected in normal mode and can be
accepted only as an untrusted local override in Developer Mode.

All transitive JAR dependencies must be individually declared. The host never
downloads missing classes or resolves a Maven POM at activation time.

## 10. Capabilities

Capabilities describe operations the connector claims to support; they do not
grant OS permissions and do not override runtime maturity or SQL safety policy.

Version 1 capabilities are:

```text
connection.test
query.execute
query.cancel
transaction
metadata.catalogs
metadata.schemas
metadata.tables
metadata.columns
```

The host may downgrade an optional capability after a deterministic probe or a
known compatibility rule. The UI must display actual negotiated capabilities,
not only manifest claims.

## 11. Timeouts and result bounds

Connector defaults are hints bounded by Nyala policy. A manifest cannot raise
global maximums or disable deadlines.

- `connectTimeoutMs`: default connect deadline;
- `socketTimeoutMs`: default driver I/O deadline where supported;
- `fetchSize`: JDBC fetch-size hint;
- `maxRows`: maximum rows before result truncation.

The Rust request deadline remains authoritative. A driver that ignores timeout
or cancellation may have its connection closed by the host.

## 12. Assets

Version 1 permits one PNG icon. The installer validates MIME type from bytes,
dimensions, and decoded size. SVG, HTML, animated images, remote URLs, and data
URLs are not accepted in connector packages.

The icon is decorative catalogue data. It is never rendered as trusted HTML and
cannot load external resources.

## 13. Optional Java adapter

An artifact with role `adapter` declares an adapter class in a future-compatible
manifest field approved by the host SPI. Until that SPI has its own accepted
ADR, marketplace version 1 treats adapters as first-party preview-only content.

An adapter is for narrow JDBC compatibility fixes, such as correcting vendor
metadata. It must not:

- replace marketplace or package installation;
- create UI or invoke Workbench commands;
- store credentials;
- open undeclared files or network destinations;
- launch processes or load native libraries;
- implement a general extension runtime.

## 14. Deterministic packaging

Official packages are reproducible from a tagged source revision:

- files sorted lexicographically;
- normalized ZIP timestamps and permissions;
- no build-machine absolute paths;
- no nondeterministic generated identifiers;
- fixed compression settings;
- dependency lock/checksum input committed by the publisher;
- CycloneDX or SPDX SBOM generated from the resolved artifacts.

The package digest in repository metadata is computed after deterministic
packing. The package does not contain its own mutable marketplace signature.

## 15. Validation levels

Validation is split so installation does not execute connector code:

1. Schema: parse manifest and reject unknown critical fields.
2. Archive: path, size, type, and file-count checks.
3. Integrity: outer target digest and every artifact digest/length.
4. Policy: namespace, license, compatibility, and prohibited-content checks.
5. Contract: run JDBC host tests in CI or explicit local development.
6. Live integration: opt-in database instance checks for connection, metadata,
   query, cancellation, transaction, and cleanup behavior.

Only levels 1-4 run during normal installation. Levels 5-6 run before
publication and when a user explicitly tests a connection.

## 16. Versioning policy

Schema version 1 is closed and rejects unknown fields. Editorial schema fixes
that do not change accepted instances can retain version 1. Adding a manifest
field, enum value, security meaning, archive behavior, URL rendering rule,
artifact-loading rule, or secret-persistence rule requires a new schema version
and an ADR.

Clients fail closed on an unsupported `schemaVersion`. They preserve the
package on disk but do not activate it.
