# Contributing to Nyala Studio

Thank you for helping build Nyala Studio, a local-first SQL workbench based on SideX and Code - OSS workbench concepts.

Before changing code, read [README.md](./README.md), [AGENTS.md](./AGENTS.md), and the current [SQL MVP roadmap](./docs/sql-mvp-phases/README.md).

## Before You Start

- Search [existing issues](https://github.com/baicie/nyala-studio/issues) before opening a duplicate.
- Open an issue before a large architectural change or an upstream subsystem removal.
- Keep changes focused on one feature, fix, or cleanup.
- Report vulnerabilities through [SECURITY.md](./SECURITY.md), not a public issue.
- Follow the [Code of Conduct](./CODE_OF_CONDUCT.md) in every project space.

Nyala Studio keeps the SideX / VS Code-style workbench architecture. Add SQL product behavior through workbench contributions and services; do not rewrite the workbench shell for a feature.

## Development Setup

Install the Rust toolchain, the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/), Node.js, and the pnpm version declared in `package.json`.

```bash
git clone https://github.com/baicie/nyala-studio.git
cd nyala-studio
pnpm install
pnpm run dev
```

Do not add `package-lock.json` or `yarn.lock`. Dependencies are managed with pnpm.

## Contribution Workflow

1. Fork the repository and create a topic branch from `mvp`.
2. Use a descriptive branch name, such as `feat/sql-result-export` or `fix/sqlite-connection-error`.
3. Follow nearby code patterns and keep unrelated formatting or cleanup out of the change.
4. Add or update tests for changed behavior.
5. Run the relevant checks and the full release gate when practical.
6. Open a pull request against `mvp` with a clear explanation and verification results.

Use conventional commits with an imperative subject of at most 72 characters. Common examples are `feat(sql):`, `fix(sql):`, `test(sql):`, `docs(sql):`, and `chore(rust):`.

## Architecture Guidelines

### TypeScript

- Keep SQL contributions under `src/vs/workbench/contrib/sql*`.
- Keep shared SQL services and types under `src/vs/workbench/services/sql/`.
- Reuse workbench services, contributions, commands, context keys, lifecycle phases, and disposables.
- Route native calls through a service. Do not invoke Tauri directly from a view.
- Dispose listeners, models, timers, and widgets through the existing disposable lifecycle.

### Rust

- Keep SQL commands under `src-tauri/src/commands/sql/` and register commands through the existing Tauri command structure.
- Return structured success values and `SqlCommandError` failures. Do not panic or return raw strings for user input errors.
- Add unit tests for commands and critical services when practical.
- Never log credentials, full connection URLs, query results, or other sensitive database data.
- Preserve read-only safeguards and reject unsafe SQL by default when behavior is ambiguous.

See [AGENTS.md](./AGENTS.md) for the complete architecture, security, and implementation rules.

## Verification

Run the smallest relevant suite while developing. The available granular commands are listed in `package.json` and [AGENTS.md](./AGENTS.md).

Before requesting merge, run the release gate:

```bash
pnpm run lint
pnpm run build
pnpm run rust:fmt
pnpm run rust:check
pnpm run rust:clippy
pnpm run test
```

Check changed frontend files with `pnpm exec prettier --check <paths>`. The CI formatting job is change-scoped because the inherited workbench still has upstream formatting debt; do not reformat unrelated files. Use `pnpm run rust:fmt:fix` before committing Rust changes.

The live MySQL Preview integration suite is opt-in and requires a disposable test database:

```bash
pnpm run test:mysql-integration
```

Never point that suite at production data. Report every command you ran and its exit status in the pull request; explain any check you could not run.

## Pull Requests

A useful pull request includes:

- the problem and why the change is needed;
- the architectural approach and affected services;
- tests added or updated;
- exact verification commands and results;
- screenshots or a short recording for visible UI changes;
- security, migration, or extension-host risks, when applicable.

Reviewers may ask for a smaller change if a pull request mixes unrelated work or bypasses established workbench boundaries.

## License and Attribution

By contributing, you agree that your contribution is licensed under the repository's [MIT License](./LICENSE).

Keep applicable copyright notices, license headers, and attribution for SideX, Code - OSS, and other upstream work.
