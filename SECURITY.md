# Security Policy

Nyala Studio handles database credentials, local files, SQL text, and query results. Treat unexpected access, disclosure, or unsafe execution as a potential security issue.

## Supported Versions

Security fixes are applied to the current maintained branches only.

| Version or branch                       | Supported |
| --------------------------------------- | --------- |
| Current `mvp`                           | Yes       |
| Current `main`                          | Yes       |
| Older branches, commits, or prereleases | No        |

## Report a Vulnerability

Do not open a public issue, discussion, or pull request for an unpatched vulnerability.

Use GitHub's private [Report a vulnerability](https://github.com/baicie/nyala-studio/security/advisories/new) form to create a draft Security Advisory for the maintainers.

Include enough information to reproduce and assess the issue:

- affected branch, commit, and platform;
- impact and realistic attack scenario;
- minimal reproduction steps or proof of concept;
- relevant logs with credentials and user data removed;
- suggested mitigation, if known;
- whether you intend to request public credit.

Never include real credentials, production data, private keys, or full connection URLs. Use synthetic test data and redact sensitive values.

If GitHub Security Advisories are unavailable, open a public issue containing no vulnerability details and ask the maintainers to enable a private reporting channel.

## Coordinated Disclosure

Give maintainers a reasonable opportunity to investigate and release a fix before publishing details. Do not disclose an unpatched vulnerability publicly.

Maintainers will use the draft advisory to confirm scope, coordinate remediation, and agree on disclosure timing. Credit will be handled through the advisory when requested and appropriate.

## Research Guidelines

- Test only systems and data you own or have explicit permission to use.
- Stop if testing exposes other users' data or affects service availability.
- Do not use social engineering, denial of service, destructive queries, or credential attacks.
- Minimize access, retain no sensitive data, and delete test artifacts when the investigation ends.

Good-faith research that follows this policy helps protect Nyala Studio users. This policy does not authorize activity prohibited by law or by third-party terms.

## Security Scope

Relevant reports include credential handling, Tauri command boundaries, filesystem permissions, SQL safety controls, extension or plugin loading, dependency risks, and unintended local data exposure.

General bugs, feature requests, and setup questions belong in [GitHub Issues](https://github.com/baicie/nyala-studio/issues).
