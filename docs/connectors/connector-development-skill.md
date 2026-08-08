# Future Skill Contract: Nyala Connector Development

- Status: Design only
- Proposed skill name: `nyala-connector-author`
- Purpose: help a developer scaffold, validate, test, and package a database connector through conversation

## Why the skill comes after the toolchain

The skill must be a guided interface over stable repository contracts. It must
not become an alternative package builder whose behavior exists only inside an
agent prompt.

Before creating the skill, the repository must provide:

- the accepted connector ADRs;
- a versioned manifest schema;
- the canonical connector template;
- deterministic `connector:init`, `validate`, `test`, `pack`, and `verify`
  commands;
- JDBC host contract fixtures;
- local Developer Mode installation;
- secret-redaction test helpers.

## Trigger and user experience

The skill should activate for requests such as:

```text
Create a Nyala connector for CockroachDB.
Wrap this JDBC driver as a connector.
Scaffold a database connector.
Help me publish this connector.
```

The conversation starts with the smallest set of facts that materially changes
the package:

1. Database product and supported server versions.
2. JDBC artifact source, version, driver class, and license.
3. JDBC URL shape and default port.
4. Required public and secret connection fields.
5. Existing Nyala dialect ID or `generic-sql` fallback.
6. Availability of a disposable integration database.

The skill recommends a declarative connector. It proposes Java adapter code
only after showing the failed contract that requires it and obtaining explicit
approval for the larger security surface.

## Required workflow

```text
discover
  -> verify repository context and ADR status
  -> inspect upstream JDBC documentation/artifact
  -> scaffold canonical template
  -> fill manifest without secrets
  -> validate schema and package policy
  -> generate unit and opt-in integration fixtures
  -> run contract tests
  -> generate notices and SBOM
  -> pack deterministically
  -> verify final archive
  -> produce publication checklist
```

At each step the skill reports the exact command and exit status. It does not
claim marketplace compatibility from source-directory validation alone.

## Generated output

For a normal connector, the skill creates or updates only:

```text
nyala-connector.json
README.md
LICENSES/*
SBOM/*
test/connector-contract.json
test/README.md
```

JDBC JARs are copied only from an explicit, verified source. The skill records
their digest and never commits a redistributable artifact before checking
license policy.

For an advanced adapter, the skill may additionally scaffold the accepted Java
SPI template and tests. That path is unavailable until the adapter SPI has an
accepted ADR and released SDK.

## Guardrails

The skill must always:

- read the current ADRs, schema, authoring guide, and target connector template;
- inspect repository status and preserve unrelated work;
- treat JDBC JARs as executable code;
- keep driver and dialect identities separate;
- use secret test environment variables and sentinel redaction tests;
- prefer existing repository scripts over generated one-off tooling;
- run validation against the final archive;
- label planned runtime support accurately.

The skill must ask before:

- adding a Java adapter or any native binary;
- downloading an artifact from a source not already approved by the user;
- accepting a license with redistribution or copyleft implications;
- running live integration tests against a non-disposable database;
- changing product runtime maturity, Tauri capabilities, CI, or marketplace
  signing configuration;
- publishing, uploading, signing, or sending a package externally.

The skill must never:

- put credentials in source, manifests, URLs, commands, logs, or fixtures;
- invent a package schema field to work around validation;
- disable TLS verification as a compatibility fix;
- run SQL mutations against an unconfirmed database;
- auto-publish or gain access to marketplace root signing keys;
- claim that a signature makes connector code sandboxed;
- rewrite Workbench or Rust SQL services to accommodate one connector.

## Vibe-development behavior

The skill can make connector development conversational without making it
guess-driven. For example, from "make a connector for AcmeDB" it can discover
the official JDBC class and license, draft fields and URL mapping, then show the
developer the concrete manifest and unresolved compatibility assumptions before
running anything.

Every generated choice remains inspectable in normal files. The developer can
leave the skill and continue with the same CLI, schema, and tests. There is no
hidden agent-only state.

## Skill acceptance criteria

- A first-time author can produce a schema-valid declarative connector from the
  canonical template without learning Nyala internals.
- Re-running the skill is idempotent and preserves manual changes outside its
  owned files.
- Invalid hashes, secrets, unsupported capabilities, missing notices, and
  nondeterministic archives are caught by repository tools, not prose alone.
- The skill can explain every manifest field it generated and cite the
  governing package-spec section.
- A connector created with the skill behaves identically when built manually
  with the documented commands.
- No external publish/sign operation occurs without a separate explicit user
  request and successful final verification.
