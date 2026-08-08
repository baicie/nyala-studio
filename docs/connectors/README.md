# Nyala Database Connectors

Database connectors make JDBC drivers available to Nyala Studio. They are not
Workbench extensions and cannot contribute JavaScript, views, commands, agents,
or arbitrary UI.

Start here:

- [JDBC sidecar decision](../adr/0001-jdbc-sidecar-and-connector-boundary.md)
- [Marketplace and installation decision](../adr/0002-signed-connector-marketplace.md)
- [Connector package specification](./connector-package-spec.md)
- [Authoring guide and best practices](./authoring-guide.md)
- [Future connector development skill](./connector-development-skill.md)
- [Declarative connector template](./template/declarative-jdbc/README.md)

The documents are proposed contracts. They do not change the current runtime
status of SQLite, MySQL, or PostgreSQL and do not imply that the JDBC host or
marketplace has been implemented.

## Design rule

Prefer a manifest around a standard JDBC driver. Add Nyala-specific Java code
only when a proven JDBC metadata incompatibility cannot be represented by the
declarative package contract.
