# Release workflow configuration

This document describes the configuration read by
`.github/workflows/release.yml`. For the release-day procedure, see
[`RELEASE-RUNBOOK.md`](./RELEASE-RUNBOOK.md).

## Workflow contract

The workflow accepts either:

- a manual dispatch from the protected `mvp` branch with a SemVer `version`;
- a pushed `v*` tag whose commit is contained in `mvp` and whose version
  matches all application version files.

Every run executes the SQL MVP gate, builds six artifact groups, verifies that
none are empty, generates `SHA256SUMS.txt`, and publishes a non-draft GitHub
Release. A SemVer prerelease such as `0.0.1-dev.0` is marked as a GitHub
prerelease and is never promoted to the stable updater channel.

The build matrix is:

| Artifact group    | Runner           | Rust target                |
| ----------------- | ---------------- | -------------------------- |
| `macos-arm64`     | `macos-latest`   | `aarch64-apple-darwin`     |
| `macos-x64`       | `macos-latest`   | `x86_64-apple-darwin`      |
| `macos-universal` | `macos-latest`   | `universal-apple-darwin`   |
| `windows-x64`     | `windows-latest` | `x86_64-pc-windows-msvc`   |
| `windows-arm64`   | `windows-latest` | `aarch64-pc-windows-msvc`  |
| `linux-x64`       | `ubuntu-22.04`   | `x86_64-unknown-linux-gnu` |

Artifact filenames are prefixed with their group name before upload. This
keeps updater archives from different architectures unique in GitHub Releases
and Cloudflare R2.

## Development prereleases need no secrets

A development release can run with no repository secrets. In that mode the
workflow runs `tauri build --ci --no-sign`, skips R2, and publishes unsigned
installers to GitHub with checksum verification. This is the expected mode for
`0.0.1-dev.0`.

Unsigned packages are suitable for installation and smoke testing, but users
will see platform trust warnings. They must not be represented as notarized,
Authenticode-signed, or production-ready.

## Repository variables

These optional Actions variables override Nyala defaults:

| Variable                | Default                                          | Purpose                        |
| ----------------------- | ------------------------------------------------ | ------------------------------ |
| `NYALA_R2_BUCKET`       | `nyala-assets`                                   | R2 artifact bucket             |
| `NYALA_R2_RELEASE_PATH` | `nyala`                                          | Path below `/releases/`        |
| `NYALA_CDN_BASE_URL`    | `https://cdn.nyala.studio/releases/nyala/latest` | URL root used by `latest.json` |
| `NYALA_PRODUCT_NAME`    | `Nyala Studio`                                   | GitHub Release title prefix    |

Configure them under **Settings > Secrets and variables > Actions >
Variables**. Empty or missing values use the defaults above.

## Optional secret groups

Secrets are detected as complete groups. An incomplete group is treated as
disabled rather than failing unrelated GitHub packaging.

### Tauri updater signing

| Secret                               | Purpose                                      |
| ------------------------------------ | -------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Signs Tauri updater archives                 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the private key, when encrypted |

`TAURI_SIGNING_PRIVATE_KEY` enables `tauri.release.conf.json`, which creates
the `.tar.gz` or `.zip` updater archives and matching `.sig` files. The
password may be empty only when the key itself has no password.

### Apple signing and notarization

| Secret                       | Purpose                                        |
| ---------------------------- | ---------------------------------------------- |
| `APPLE_CERTIFICATE`          | Base64-encoded Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` password                                |
| `KEYCHAIN_PASSWORD`          | Temporary CI keychain password                 |
| `APPLE_ID`                   | Apple account used for notarization            |
| `APPLE_ID_PASSWORD`          | App-specific Apple password                    |
| `APPLE_TEAM_ID`              | Apple Developer team ID                        |

The first three secrets enable certificate import and macOS code signing. The
last three enable notarization when Tauri detects the complete Apple account
configuration. All identities must belong to the Nyala publisher.

### Azure Trusted Signing

| Secret                   | Purpose                        |
| ------------------------ | ------------------------------ |
| `AZURE_TENANT_ID`        | Microsoft Entra tenant         |
| `AZURE_CLIENT_ID`        | Signing application client ID  |
| `AZURE_CLIENT_SECRET`    | Signing application credential |
| `AZURE_SIGNING_ENDPOINT` | Trusted Signing endpoint       |
| `AZURE_SIGNING_ACCOUNT`  | Trusted Signing account        |
| `AZURE_CERT_PROFILE`     | Certificate profile            |

All six are required to enable the Azure step. It signs both `.exe` and `.msi`
installers after Tauri packaging.

### Cloudflare R2

| Secret                 | Purpose                            |
| ---------------------- | ---------------------------------- |
| `R2_ACCESS_KEY_ID`     | R2 S3 API access key               |
| `R2_SECRET_ACCESS_KEY` | R2 S3 API secret                   |
| `R2_ACCOUNT_ID`        | Account-specific endpoint assembly |

All three enable upload to the versioned R2 folder. The workflow updates
`latest/` and `latest.json` only for a stable SemVer release and only when a
Tauri updater signing key is present. Prereleases never overwrite `latest`.

## Behavior matrix

| Configuration           | GitHub packages           | Updater archives | R2 version folder | R2 `latest`                |
| ----------------------- | ------------------------- | ---------------- | ----------------- | -------------------------- |
| No secrets, prerelease  | unsigned                  | no               | skipped           | skipped                    |
| Updater key, prerelease | platform signing optional | signed           | optional          | skipped                    |
| R2 only, prerelease     | unsigned                  | no               | uploaded          | skipped                    |
| Full signing, stable    | signed                    | signed           | optional          | updated when R2 is enabled |

## Security properties

- Workflow permissions default to `contents: read`; only the final Release job
  receives `contents: write`.
- Checkout credentials are not persisted.
- Third-party actions are pinned to full commit SHAs.
- Credentials are scoped to the detection or provider step that consumes them.
- The workflow emits only boolean availability outputs, never secret values.
- Prereleases cannot replace the stable R2 updater channel.

Do not print, download, or add secret values to diagnostic output. Verify
configured secret names through GitHub's metadata API or settings UI only.
