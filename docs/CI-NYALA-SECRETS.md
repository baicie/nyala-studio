# Release pipeline runbook — `.github/workflows/release.yml`

This runbook is for the maintainer who cuts a `v*` tag. After the
mid-2026 Nyala retarget, every value listed below points at
Nyala-owned endpoints; if any value still resolves to a SideX
endpoint, **stop and reopen this file before tagging.**

For the **operational** counterpart — actual provisioning steps
(Cloudflare / Apple / Azure), DNS waits, artifact verification,
rollback decisions — see
[`docs/RELEASE-RUNBOOK.md`](./RELEASE-RUNBOOK.md). The two files
deliberately split along this line: this file documents *what
secrets the workflow expects and why*; the runbook documents
*what the maintainer does on release day*.

## What this workflow does

`.github/workflows/release.yml` runs whenever a `v*` tag is pushed
(or manually via `workflow_dispatch`). It:

1. Builds the Tauri desktop bundles for macOS (universal / arm64 /
   x64), Windows (x64 + arm64), and Linux x64.
2. Signs the macOS bundles via the imported Apple certificate and
   the Windows installers via Azure Trusted Signing.
3. Uploads all artifacts to Cloudflare R2 under
   `${NYALA_R2_BUCKET}/releases/${NYALA_R2_RELEASE_PATH}/`.
4. Refreshes the `latest/` mirror and writes
   `latest/latest.json` so the in-app updater can discover the
   current build.
5. Creates a draft GitHub Release with the artifacts attached.

The retarget commit introduced four workflow-level environment
variables that parameterise the SideX legacy:

| Variable                 | Default                              | Purpose                                 |
| ------------------------ | ------------------------------------ | --------------------------------------- |
| `NYALA_R2_BUCKET`        | `nyala-assets`                       | Cloudflare R2 bucket (artifact storage) |
| `NYALA_R2_RELEASE_PATH`  | `nyala`                              | Path segment under `/releases/`         |
| `NYALA_CDN_BASE_URL`     | `https://cdn.nyala.studio/releases/nyala/latest` | Base URL embedded in `latest.json` |
| `NYALA_PRODUCT_NAME`     | `Nyala Studio`                       | GitHub Release title prefix             |

These four are the **only** values to override if the maintainer
renames a bucket or moves the CDN. Repository-level overrides go
through *Settings → Secrets and variables → Actions → Variables*
(repo variables, not secrets) and are surfaced to the workflow as
`vars.NYALA_R2_BUCKET` etc. Each `aws s3 sync` call already pulls
the value from `env:` so a maintainer override is automatic.

## Secrets the workflow reads

The workflow needs every secret below before the first tag push.
Missing any one will fail at the matching step, not at the start
of the run, so a partial dry-run is possible by removing the
artifact collection steps.

| Secret                                   | Used by step                          | Required for                                          |
| ---------------------------------------- | ------------------------------------- | ----------------------------------------------------- |
| `R2_ACCESS_KEY_ID`                       | `R2 — *`                              | All Cloudflare R2 uploads                             |
| `R2_SECRET_ACCESS_KEY`                   | `R2 — *`                              | All Cloudflare R2 uploads                             |
| `R2_ACCOUNT_ID`                          | `R2 — *`                              | Endpoint URL assembly                                 |
| `APPLE_CERTIFICATE` (base64)             | `Import Apple signing certificate`    | macOS signing                                         |
| `APPLE_CERTIFICATE_PASSWORD`             | `Import Apple signing certificate`    | macOS signing                                         |
| `KEYCHAIN_PASSWORD`                      | Apple import + unlock + signing       | macOS signing                                         |
| `APPLE_ID`                               | `Build Tauri app`                     | macOS notarisation                                    |
| `APPLE_ID_PASSWORD`                      | `Build Tauri app`                     | macOS notarisation                                    |
| `APPLE_TEAM_ID`                          | `Build Tauri app`                     | macOS notarisation                                    |
| `TAURI_SIGNING_PRIVATE_KEY`              | `Build Tauri app`                     | Update signing (consumed by `tauri build`)           |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`     | `Build Tauri app`                     | Update signing                                        |
| `AZURE_TENANT_ID`                        | `Sign Windows installers`             | Windows authenticode                                  |
| `AZURE_CLIENT_ID`                        | `Sign Windows installers`             | Windows authenticode                                  |
| `AZURE_CLIENT_SECRET`                    | `Sign Windows installers`             | Windows authenticode                                  |
| `AZURE_SIGNING_ENDPOINT`                 | `Sign Windows installers`             | Windows authenticode                                  |
| `AZURE_SIGNING_ACCOUNT`                  | `Sign Windows installers`             | Windows authenticode                                  |
| `AZURE_CERT_PROFILE`                     | `Sign Windows installers`             | Windows authenticode                                  |

The macOS secrets must belong to the **Nyala** Apple Developer
team, not the original SideX team. Re-import is mandatory if the
upstream SideX team's signing identity was used during the fork
stabilisation phase.

## Pre-tag checklist

Run through this list before `git push origin v0.1.0`:

- [ ] Confirm every Cloudflare R2 path in the workflow resolves to
      `${NYALA_R2_BUCKET}/releases/${NYALA_R2_RELEASE_PATH}/...`,
      not `siden-assets/releases/sidex/...`. The grep for `siden`
      should now return only the historical comment at lines 17–18.
- [ ] Confirm `latest.json`'s `BASE_URL` resolves through
      `${NYALA_CDN_BASE_URL}` and the bucket it points at serves
      over HTTPS.
- [ ] Confirm the macOS signing secrets belong to the Nyala Apple
      Developer team.
- [ ] Confirm the `tauri.release.conf.json` `signingIdentity`
      and `signing` blocks reference the Nyala updater endpoint
      rather than the SideX updater.
- [ ] Run `pnpm run rust:fmt && pnpm run rust:check &&
      pnpm run rust:clippy && pnpm run lint && pnpm run build &&
      pnpm run test` locally; all must exit 0.
- [ ] `git tag -a v0.1.0 -m "v0.1.0 MVP"` with a GPG-signed
      annotated tag. Lightweight tags lose the running workflow's
      ability to surface the cut line on the GitHub Release.

## workflow_dispatch

The workflow also runs on `workflow_dispatch` with a single
`version` input (default `0.1.3`). Use this for rehearsal runs
that should not land on the public tag namespace. The same
secret set applies; the `deploy` and `release` jobs will still
fire unless the `version` input is preceded by a manual cancel
from the Actions UI.

## Difference from the upstream SideX workflow

The two upstream SideX values are now env-resolved, not
hardcoded:

- `siden-assets/releases/sidex/${VERSION}/` →
  `${NYALA_R2_BUCKET}/releases/${NYALA_R2_RELEASE_PATH}/${VERSION}/`
- `cdn.siden.ai/releases/sidex/latest` →
  `${NYALA_CDN_BASE_URL}`
- GitHub Release title `SideX v...` →
  `${NYALA_PRODUCT_NAME} v...`

If a maintainer needs to roll back to the original SideX
endpoints for any reason (e.g. cross-team collaboration), they
can do so without re-versioning this file by setting the four
variables in repo settings; the workflow picks them up at run
time.

## Known follow-ups

- The Windows `.exe.zip` and `.app.tar.gz` artifacts still use
  filenames SideX chose. Renaming is out of scope for this
  retarget because the in-app updater on the existing 0.1.0-rc
  builds expects the historical names. A coordinated rename
  must land with the first Nyala-public release.
- The macOS signing certificate renew cadence matches SideX's
  upstream; the Nyala Apple Developer team should re-import the
  refreshed `.p12` before its current expiry.
