# Declarative JDBC Connector Template

This directory is the proposed source template for a connector that wraps a
standard JDBC 4 driver without Nyala-specific Java code.

It is intentionally not ready to publish. Replace every `example` value, add
the reviewed JDBC JAR under `lib/`, calculate its exact SHA-256 and size, add
license notices and an SBOM, then run the future connector validation commands.

## Template layout

```text
nyala-connector.json
LICENSES/README.md
SBOM/README.md
test/connector-contract.json
```

The source template does not include a third-party JAR or icon because their
license, provenance, digest, and visual ownership must be decided for each
connector.

## Values to replace

- `example.acmedb`, publisher identity, display name, and support URLs;
- driver version, class, archive path, SHA-256, and byte length;
- JDBC URL, default port, connection fields, and property names;
- dialect ID and measured capabilities;
- server image and SQL in the opt-in contract fixture;
- license notices and generated SBOM.

Do not add password or token examples. Test credentials belong in environment
variables supplied to a disposable integration database.

## Target workflow

These commands are part of the proposed toolchain and do not exist yet:

```bash
pnpm run connector:validate -- ./docs/connectors/template/declarative-jdbc
pnpm run connector:test -- ./docs/connectors/template/declarative-jdbc --profile integration
pnpm run connector:pack -- ./docs/connectors/template/declarative-jdbc --output ./dist
pnpm run connector:verify -- ./dist/example.acmedb-0.1.0.nyala-connector
```

The template becomes an officially supported scaffold only after those commands
and the JDBC host contract runner are implemented.
