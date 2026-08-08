# Nyala Studio release runbook

This runbook covers version preparation, protected-branch delivery, GitHub
Actions packaging, and release verification. Configuration and secret groups
are documented in [`CI-NYALA-SECRETS.md`](./CI-NYALA-SECRETS.md).

## Release guarantees

`.github/workflows/release.yml` publishes only after all of these conditions
are met:

1. The requested version is valid SemVer.
2. Manual dispatch runs from `mvp`.
3. A pushed release tag points to a commit already contained in `mvp`.
4. `package.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`, and `Cargo.lock` agree with that version.
5. The reusable SQL MVP gate passes.
6. All six platform artifact groups build and contain at least one package.
7. The Release job creates checksums before publishing.

For a manual dispatch, the GitHub Release action creates the `v<version>` tag
on the exact protected-branch commit that was built. Do not create the tag in
advance for this path.

## 1. Prepare the version

Start from the current protected branch on a topic branch:

```bash
git fetch origin
git switch -c chore/release-0.0.1-dev.0 origin/mvp
pnpm install --frozen-lockfile
pnpm run release:prepare -- 0.0.1-dev.0
pnpm run release:check -- 0.0.1-dev.0
```

`release:prepare` updates the four version sources together and runs Cargo to
refresh lock metadata. Inspect the resulting diff; a release version change
must not modify dependency versions.

Run the local gates:

```bash
pnpm run test:release
pnpm run lint
pnpm run build
pnpm run rust:fmt
pnpm run rust:check
pnpm run rust:clippy
pnpm run test
```

Every command must exit 0 before the branch is pushed.

## 2. Merge through the protected branch

Commit the version and workflow changes, push the topic branch, and create a
pull request targeting `mvp`. Wait for every required check, then squash merge.
Do not bypass branch protection for a release.

Confirm the merged source version:

```bash
git fetch origin
git show origin/mvp:package.json | jq -r .version
```

The output must be the requested version.

## 3. Dispatch the development prerelease

For `0.0.1-dev.0`, run the workflow from `mvp` without the optional live MySQL
test unless that integration is specifically under test:

```bash
gh workflow run release.yml \
  --repo baicie/nyala-studio \
  --ref mvp \
  -f version=0.0.1-dev.0 \
  -f run_mysql_integration=false
```

Find and follow the run:

```bash
RUN_ID=$(gh run list \
  --repo baicie/nyala-studio \
  --workflow release.yml \
  --event workflow_dispatch \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')

gh run watch "$RUN_ID" --repo baicie/nyala-studio --exit-status
```

Expected behavior with no repository secrets:

- the SQL MVP gate passes;
- all six build jobs use the unsigned development path;
- R2 reports that it is disabled and skips upload steps;
- the GitHub Release job succeeds independently of R2;
- `v0.0.1-dev.0` is published as a prerelease, not a draft or latest release.

## 4. Verify the GitHub Release

Check release metadata:

```bash
gh release view v0.0.1-dev.0 \
  --repo baicie/nyala-studio \
  --json tagName,name,isDraft,isPrerelease,url,targetCommitish
```

Required values:

| Field             | Expected value              |
| ----------------- | --------------------------- |
| `tagName`         | `v0.0.1-dev.0`              |
| `name`            | `Nyala Studio v0.0.1-dev.0` |
| `isDraft`         | `false`                     |
| `isPrerelease`    | `true`                      |
| `targetCommitish` | merged `mvp` release commit |

Download and verify all assets in an isolated directory:

```bash
RELEASE_DIR=$(mktemp -d)
gh release download v0.0.1-dev.0 \
  --repo baicie/nyala-studio \
  --dir "$RELEASE_DIR"

cd "$RELEASE_DIR"
sha256sum -c SHA256SUMS.txt
```

On macOS, use `shasum -a 256 -c SHA256SUMS.txt` when GNU
`sha256sum` is not installed.

The release must contain nonempty packages prefixed by each artifact group:

- `macos-arm64-`
- `macos-x64-`
- `macos-universal-`
- `windows-x64-`
- `windows-arm64-`
- `linux-x64-`
- `SHA256SUMS.txt`

The exact extensions depend on Tauri's platform bundles. The current target
set normally includes DMG, NSIS/MSI, DEB/RPM, and AppImage packages.

## 5. Platform smoke checks

### macOS

```bash
hdiutil verify macos-arm64-*.dmg
```

Mount the DMG, launch Nyala Studio, and confirm the About/version surface reads
`0.0.1-dev.0`. An unsigned development build may require the explicit macOS
open/approval flow; that warning is expected for this release.

### Windows

Install both x64 and ARM64 packages on matching systems or VMs. Confirm that
the app launches and reports `0.0.1-dev.0`. With no Azure secrets,
`Get-AuthenticodeSignature` should report the package as unsigned; do not claim
Trusted Signing coverage from this run.

### Linux

Inspect package metadata before installation:

```bash
dpkg-deb --info linux-x64-*.deb
rpm -qip linux-x64-*.rpm
```

Run the AppImage and one native package on an x64 Linux host. Confirm launch,
version, SQLite connection creation, query execution, and result rendering.

## 6. Stable release requirements

Before dispatching a version without a prerelease suffix:

- configure and validate Apple signing/notarization;
- configure Azure Trusted Signing for `.exe` and `.msi` packages;
- configure the Tauri updater signing key;
- configure R2 only if the CDN updater channel is intended to go live;
- verify `NYALA_CDN_BASE_URL` serves the selected R2 bucket over HTTPS;
- run a signed prerelease rehearsal first.

A stable release with updater signing and R2 enabled updates the versioned R2
folder, the `latest/` mirror, and `latest.json`. A prerelease never updates
those stable pointers.

## 7. Failure and retry

If a build or gate fails, fix the source through another PR and dispatch again.
No tag or GitHub Release is created until the final job, so failed build runs
do not reserve the version.

If the Release job fails after creating a partial release, inspect it before
retrying. The release action overwrites same-named assets, but a clean retry is
easier to audit:

```bash
gh release delete v0.0.1-dev.0 \
  --repo baicie/nyala-studio \
  --cleanup-tag \
  --yes
```

This deletion is destructive and should be used only for an unpublished test
version or an explicitly approved rollback.

If a published build is bad, do not reuse its version. Mark the release notes,
remove it from updater promotion if applicable, fix forward, and publish a new
SemVer version.

## 8. Evidence to retain

Record these items in the release issue or PR:

- merged commit SHA;
- Release workflow run URL and conclusion;
- exact version-check and local gate results;
- GitHub Release URL and metadata;
- asset inventory and sizes;
- `SHA256SUMS.txt` verification result;
- which signing and R2 groups were enabled;
- platform smoke-test results and any unsigned-package warnings.
