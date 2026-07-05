# Nyala Studio deploy runbook — cutting and verifying a `v*` release

This is the **operational** counterpart of
[`docs/CI-NYALA-SECRETS.md`](./CI-NYALA-SECRETS.md), which only
documents the secrets table and the pre-tag git checklist. The
runbook below is what the on-call maintainer follows on the day
a release goes out, end to end.

The intended reader is the maintainer who is on the hook for a
working `Nyala Studio v0.1.0` (or `v0.1.x`) release. They have
**not** provisioned the Nyala Cloudflare bucket yet, **or** they
are returning to refresh an existing one before the next cut.
Either way, they should be able to finish this runbook on a
Saturday morning with a coffee and a fresh shell.

The runbook assumes the `mvp` branch is green on `pnpm run
lint`, `pnpm run build`, and `pnpm run test`. If any of those
fail locally, fix the merge first; this runbook does **not**
debug the build.

---

## Phase 0 — Pre-flight (T-7 days from release day)

The goal of T-7 is to surface every blocker that would
otherwise block a tag push at T-0. Every item here has a
verifiable "green" state; do not skip any.

### 0.1  Confirm the branch is releasable

```bash
git checkout mvp
git pull --rebase origin mvp
git status --short          # must be clean
git log --oneline -10       # eyeball for fixup commits
```

If `git status` is non-empty:

- **Stash untracked work**, do not commit it on top of `mvp`.
- If there are fixup commits to drop, run an
  `interactive rebase` against the latest tag (not against
  `HEAD` of `mvp`). Squash stragglers into the original commit
  that introduced them. Document the decision in
  `docs/reviews/<date>-release-prep.md` so the audit trail
  matches git history.

Once `git status` is clean:

```bash
pnpm install --frozen-lockfile
pnpm run lint
pnpm run build
pnpm run test
pnpm run rust:fmt
pnpm run rust:check
pnpm run rust:clippy
cd src-tauri && cargo test --workspace && cd ..
```

Every command must exit 0. If `pnpm run test` is replaced by
`pnpm run vitest` in your checkout, run that instead; the
intent is the same: every test green.

### 0.2  Confirm the secrets in this repo still resolve to Nyala identities

Open [CI-NYALA-SECRETS.md](./CI-NYALA-SECRETS.md) and re-read
the secrets table. For each Apple / Azure / Cloudflare
credential, open the provider's console and verify the team,
tenant, or account **starts with `Nyala`** rather than `SideX`,
`*Community`, or any historical owner. Record the verification
in `docs/reviews/<date>-release-prep.md` with a date stamp; if
anything is still on a SideX identity, **stop the runbook and
re-provision**. Apple Developer Team transfer takes a working
day minimum; the schedule will slip.

### 0.3  Confirm `tauri.conf.json` and `tauri.release.conf.json` point at Nyala

```bash
grep -nE 'sidex|siden|SIDEX|SideX|cdn\.siden' \
  src-tauri/tauri.conf.json \
  src-tauri/tauri.release.conf.json \
  || echo "no SideX refs in tauri config"
```

If the grep returns anything, **stop and fix**. The retarget
commit is meant to have eliminated every SideX literal. The
`updater` block must reference
`https://cdn.nyala.studio/releases/nyala/latest/latest.json`,
not a `sidex.updater` host.

### 0.4  Smoke-test the release workflow on `workflow_dispatch`

The release workflow runs on `workflow_dispatch` with a single
`version` input. Use a throwaway version to verify the full
end-to-end pipeline before cutting a real tag:

1. GitHub Actions → *Release* → *Run workflow* → set
   `version` to `0.1.0-rc.1`.
2. Watch every step. Confirm:
   - macOS signing succeeded for all three targets
     (`macos-latest` job).
   - Windows signing succeeded (`windows-latest` job).
   - R2 upload logs show the bucket name as `nyala-assets`.
     If you see `siden-assets`, **stop** — a SideX reference
     slipped back into the workflow.
   - The draft GitHub Release title reads
     `Nyala Studio v0.1.0-rc.1`, not `SideX v...`.
3. If anything failed, cancel the run from the Actions UI.
   Do not delete the draft release; keeping it makes it easy
   for the next maintainer to compare.

If the smoke test passes, **delete** the draft release, then
delete the RC artifacts from the bucket:

```bash
aws s3 rm "s3://nyala-assets/releases/nyala/0.1.0-rc.1/" --recursive \
  --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
aws s3 rm "s3://nyala-assets/releases/nyala/latest/latest.json" \
  --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
```

The second `rm` matters because the workflow's "overwrite
latest" step will overwrite `latest/` with the RC artifacts;
without the second `rm`, the next real release's `latest.json`
will point at the dead RC files for up to several seconds
between the versioned upload and the `latest.json` write.

---

## Phase 1 — Provisioning (T-3 days from release day)

The platform provisioning steps. These only run **once per
maintainer** until either Cloudflare, Apple, or Azure rotates a
credential. Skip directly to Phase 2 on subsequent releases if
your account is already provisioned.

### 1.1  Cloudflare account + R2 bucket

1. Sign in to [Cloudflare](https://dash.cloudflare.com) using
   the org-level account. The account email **must** belong to
   the Nyala domain; if a SideX employee originally created
   the account, transfer ownership first.
2. R2 → *Create bucket* → `nyala-assets`. Region: *Automatic*.
   Object lifecycle: leave at default. *Create*.
3. R2 → *Manage R2 API tokens* → *Create API token* → name it
   `nyala-github-actions`. Permissions:
   *Object Read & Write*. Scope: `nyala-assets`. *Create*.
4. Save the three values that appear once:
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_ACCOUNT_ID` (visible on the bucket page)
5. Verify from a local shell:

   ```bash
   aws s3 ls "s3://nyala-assets/" \
     --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
   ```

   The directory listing should be empty (no objects yet) and
   exit 0.

### 1.2  Cloudflare zone + public domain

1. *Add a site* → `nyala.studio`. Choose the Free plan; the
   paid features the release pipeline uses are also in the
   free tier.
2. Cloudflare returns two nameservers (`arielle.ns.cloudflare.com`,
   `dave.ns.cloudflare.com` style). Update the registrar's
   nameserver records for `nyala.studio` to those values.
3. Wait for the zone to provision. The dashboard shows
   *Active* when ready; Cloudflare usually sends an email
   confirmation as well. Typical wall-clock: 10 minutes for
   Cloudflare, up to 24 hours for registrar + DNS propagation.
4. R2 → `nyala-assets` → Settings → *Public access* → *Connect
   domain* → `cdn.nyala.studio`. Cloudflare creates a CNAME
   that points the subdomain at the bucket; HTTPS is
   automatic via the Cloudflare-issued cert.

   Wait for *Active*. This is the moment a user can `curl
   https://cdn.nyala.studio/releases/nyala/latest/latest.json`
   and get a JSON blob. Until then, **do not cut a tag**:
   the in-app updater will see a `latest.json` 404, and users
   on the previous release will silently fail to update.

5. Smoke test:

   ```bash
   echo '{"test":1}' > /tmp/latest.json
   aws s3 cp /tmp/latest.json \
     "s3://nyala-assets/releases/nyala/latest/latest.json" \
     --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
     --content-type "application/json"
   curl -fsSL https://cdn.nyala.studio/releases/nyala/latest/latest.json
   aws s3 rm "s3://nyala-assets/releases/nyala/latest/latest.json" \
     --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
   ```

   `curl` must return the JSON. If it returns HTML, the CNAME
   has not propagated yet; wait and retry.

### 1.3  Apple Developer Program (macOS signing)

1. Enroll or transfer the Apple Developer account at
   `developer.apple.com`. The team name **must** contain
   `Nyala`; if it still reads `SideX`, you are about to ship
   macOS binaries signed by a third party. Open a working-day
   long support ticket with Apple to resolve before tag day.
2. *Certificates, Identifiers & Profiles* → *Certificates* →
   *+* → *Developer ID Application* (this is the
   "distribute outside the Mac App Store" cert). Generate a
   `.p12`:
   - Open *Keychain Access* on a Mac.
   - *Certificate Assistant* → *Request a Certificate From a
     Certificate Authority* with a Nyala-team email.
   - Upload the resulting `.certSigningRequest` to Apple.
   - Download the `.cer` from Apple. Double-click to import
     into Keychain.
   - In Keychain, export the cert *with* its private key to
     `nyala-developer-id.p12`. Set a strong password; this
     becomes `APPLE_CERTIFICATE_PASSWORD`.
3. Base64 the `.p12` to fit a GitHub Actions secret:

   ```bash
   base64 -i nyala-developer-id.p12 -o nyala-developer-id.p12.b64
   cat nyala-developer-id.p12.b64
   ```

   The output of `cat` is `APPLE_CERTIFICATE`.

4. Generate an *App-Specific Password* for the notarisation
   step from `appleid.apple.com`. This becomes
   `APPLE_ID_PASSWORD`. The Apple ID itself is `APPLE_ID`,
   and the team identifier visible in the developer portal is
   `APPLE_TEAM_ID`.
5. Pick any throwaway string for `KEYCHAIN_PASSWORD` (it is
   only used by the GitHub Actions macOS runner to unlock the
   keychain it constructs; it does not need to match anything
   on Apple's side).

### 1.4  Azure Trusted Signing (Windows)

1. Create or transfer an Azure subscription at
   `portal.azure.com`. The subscription name should contain
   `Nyala`.
2. Trusted Signing is in public preview; enroll the
   subscription at `aka.ms/trustedsigning`.
3. Create a *Trusted Signing account* in `East US` (the
   currently supported region). Save its name; that is
   `AZURE_SIGNING_ACCOUNT`.
4. Create a *Certificate profile* (code-signing, `1ES`
   standard). Save its name; that is `AZURE_CERT_PROFILE`.
   Wait until the profile shows *Active*. Approval takes
   minutes to a few hours depending on Microsoft's queue.
5. Register an app in Microsoft Entra ID. Save the
   *Application (client) ID* and *Directory (tenant) ID*.
   Create a *client secret*; save its value (it shows once).
   These three become `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
   and `AZURE_CLIENT_SECRET`.
6. The endpoint URL is `https://eus.codesigning.azure.net`
   for the East US region; that is `AZURE_SIGNING_ENDPOINT`.
   If a different region is used, the endpoint URL changes
   accordingly.
7. From a local shell with the Azure CLI:

   ```bash
   az login --service-principal \
     -u "${AZURE_CLIENT_ID}" -p "${AZURE_CLIENT_SECRET}" --tenant "${AZURE_TENANT_ID}"
   az codesigning show \
     --account-name "${AZURE_SIGNING_ACCOUNT}" \
     --profile-name "${AZURE_CERT_PROFILE}" \
     --endpoint "${AZURE_SIGNING_ENDPOINT}"
   ```

   If `az codesigning show` exits 0, the credentials work.
   If it returns 403, the service principal lacks the
   *Trusted Signing Certificate Signer* role; grant it via
   *Access control (IAM)* on the Trusted Signing account.

### 1.5  Tauri signing key

Generate the key that signs `update.json`:

```bash
cargo install tauri-cli --version "^2.0" --locked
cd src-tauri
tauri signer generate --password "<strong-password>" \
  --output nyala-update-signing.key
```

The output file is the private key; do **not** commit it. Read
the contents of `nyala-update-signing.key`, plus its password,
into GitHub Actions as `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Store a copy of the key
file in `1Password` (or whatever the team uses); losing this
key means **future updates from existing installs will fail
signature verification**, so the key deserves the same
treatment as a root certificate.

### 1.6  Load all secrets into the repo

GitHub → Settings → Secrets and variables → Actions → *New
repository secret*. Add each of the 17 secrets in
[CI-NYALA-SECRETS.md](./CI-NYALA-SECRETS.md#secrets-the-workflow-reads)
and the 4 repo variables (`NYALA_R2_BUCKET`, etc.). After
saving, *do not* test the secrets by downloading them; the
GitHub UI will not show them again, and any leak is permanent.

---

## Phase 2 — Tag cut (release day, T-0 morning)

### 2.1  Bump versions in lockstep

Five files track the version. They **must** agree, otherwise
the Tauri bundler will produce installers that update the app
to a version number the updater does not expect.

```bash
grep -rn "0\.1\.0" \
  package.json \
  src-tauri/Cargo.toml \
  src-tauri/tauri.conf.json \
  src-tauri/tauri.release.conf.json \
  CHANGELOG.md
```

If any of those files still reads the previous version (e.g.
`0.1.0` while you are cutting `0.1.1`), edit it; the
allowable spots for a `X.Y.Z` bump are:

- `package.json` → top-level `"version"`
- `src-tauri/Cargo.toml` → `[package] version`
- `src-tauri/tauri.conf.json` → top-level `"version"`
- `src-tauri/tauri.release.conf.json` → top-level `"version"`
- `CHANGELOG.md` → new heading `## [X.Y.Z] - YYYY-MM-DD`

Bump all five to `X.Y.Z`. Commit as a single chore commit
*before* tagging.

### 2.2  Final local verification on the bumped tree

```bash
pnpm install --frozen-lockfile
pnpm run lint && pnpm run build && pnpm run test
cd src-tauri && cargo fmt --all && cd ..
cd src-tauri && cargo check --workspace && cd ..
```

Every step exits 0. The `pnpm run build` step in particular
**must** succeed because it is the closest local
approximation of what the GitHub Actions runners will do.

### 2.3  Cut the tag

```bash
git checkout -b release/v0.1.0
git add -A
git commit -m "chore(release): bump to v0.1.0" --no-verify
git tag -a v0.1.0 -m "v0.1.0 MVP"
git push origin release/v0.1.0
```

Wait — this pushes the branch but **not the tag**. Push the
tag last, because the workflow triggers on tag push, not on
branch push:

```bash
git push origin v0.1.0
```

Pushing the tag is **the moment of no return**. Confirm the
above grep:

```bash
git tag -l --format='%(contents:subject)' v0.1.0
```

returns `v0.1.0 MVP`. If you tagged the wrong commit because
of an amend mistake, delete the tag and start over — never
amend a tag after the workflow has already consumed it.

### 2.4  Watch the release pipeline

GitHub Actions → *Release* → `v0.1.0`. The workflow has
six build jobs, three signing jobs, three upload jobs, one
release job. They run in parallel for the build matrix; signing
depends on its target's build; uploads depend on signing;
release depends on uploads. Total wall-clock is typically 30
minutes; macOS is the slowest leg.

If any job fails, jump to Phase 5 (Rollback).

---

## Phase 3 — Verify the artifacts (T-0 +30 min)

The pipeline ran. The artifacts are at `s3://nyala-assets/releases/nyala/v0.1.0/`.
Verify **manually** before publishing the release.

### 3.1  Object inventory

```bash
aws s3 ls "s3://nyala-assets/releases/nyala/v0.1.0/" --recursive \
  --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
```

The list should include, at minimum:

- `nyala-studio_0.1.0_aarch64.dmg`
- `nyala-studio_0.1.0_x64.dmg` (or `..._universal.dmg`)
- `nyala-studio_0.1.0_amd64.AppImage`
- `nyala-studio_0.1.0_x64-setup.exe.zip`
- `nyala-studio_0.1.0_aarch64-setup.exe.zip`
- `*.sig` files for each platform (Tauri update signatures)

The exact filenames depend on the bundler config; the
*count* matters more than the names. Six platforms, six
signatures.

### 3.2  Signature validity

```bash
for sig in $(aws s3 ls "s3://nyala-assets/releases/nyala/v0.1.0/" \
  --recursive --endpoint-url "..." \
  | awk '{print $4}' | grep '\.sig$'); do
  echo "verifying $sig"
  curl -fsSL "https://cdn.nyala.studio/releases/nyala/v0.1.0/${sig}" -o /tmp/sig
  curl -fsSL "https://cdn.nyala.studio/releases/nyala/v0.1.0/${sig%.sig}" -o /tmp/bin
  cargo install tauri-cli --version "^2.0" --locked 2>/dev/null
  tauri signer verify --public-key <Nyala-update-public-key> \
    -s /tmp/sig -b /tmp/bin
done
```

If the public key was lost, the release is **unverifiable**;
do not publish. The private key in GitHub Secrets is used to
sign; the matching public key is somewhere in the team's
password manager as `nyala-update-signing.pub`. If lost,
restore from backup and re-rotate the key as a follow-up.

### 3.3  macOS Gatekeeper

On a Mac without the cert installed in the local Keychain:

```bash
xattr -d com.apple.quarantine nyala-studio_0.1.0_aarch64.dmg || true
open nyala-studio_0.1.0_aarch64.dmg
```

Drag the app to `/Applications`, then:

```bash
codesign -dvvv /Applications/Nyala\ Studio.app 2>&1 | head -20
spctl --assess --verbose=4 \
  /Applications/Nyala\ Studio.app
```

`codesign` must show *Nyala* as the team. `spctl` must return
*accepted*. If `spctl` rejects, the notarisation step in the
pipeline failed silently — check the relevant job's log and
re-run the job.

### 3.4  SmartScreen (Windows)

On a Windows 11 VM:

1. Download `...x64-setup.exe.zip` from
   `https://cdn.nyala.studio/releases/nyala/v0.1.0/`.
2. Unzip, run the installer.
3. Open PowerShell and check the signature:

   ```powershell
   Get-AuthenticodeSignature "C:\Program Files\Nyala Studio\Nyala Studio.exe" |
     Format-List *
   ```

   `SignerCertificate.Subject` should contain `Nyala`.
   `Status` should be `Valid`. Until SmartScreen reputation
   builds, Windows will show a blue "unknown publisher"
   dialog; that is *expected* on day one and goes away after
   roughly 1,000 installs over the next 7–14 days.

### 3.5  `latest.json` shape

```bash
curl -fsSL https://cdn.nyala.studio/releases/nyala/latest/latest.json |
  python -m json.tool
```

Check that:

- `"version"` matches `v0.1.0`.
- Every `platforms.*.url` is reachable via HTTPS and returns
  the expected file size.
- `pub_date` is a recent ISO 8601 timestamp.

If `latest.json` is missing keys or has stale URLs, the Tauri
updater inside existing installs will throw at next launch.
Re-run the *Generate and upload latest.json* step; **do not
manually edit `latest.json`** because its `pub_date` and
signatures depend on the upload order.

---

## Phase 4 — Publish the GitHub Release (T-0 +45 min)

### 4.1  Review the draft

GitHub → Releases → *Draft* at the top of the page. The
workflow has prefilled:

- Title: `Nyala Studio v0.1.0` (driven by `NYALA_PRODUCT_NAME`).
- Body: the auto-generated notes via `generate_release_notes`.
- Files: all six artifacts.

Read the body, particularly the *What's Changed* section,
which is auto-generated from the PRs merged since the last
release. If the body is unreadable — usually because someone
merged with a title like `wip` — go fix those titles before
publishing. The first release sets the tone for every
subsequent one.

### 4.2  Mark as pre-release (or not)

For the very first public release, *do not* mark it as a
pre-release; let it be the production default. For `0.1.x`
service releases after that, the call depends on the change
set. Anything touching the SQL Rust command layer, secrets
handling, or the workbench boot sequence should be
pre-release to avoid breaking **every** existing install at
once.

### 4.3  Publish

Click *Publish release*. The moment you do:

- Existing `v0.1.0` installs check `latest.json` on next
  launch and pull the new build.
- Anyone watching the repo gets an email.

**There is no undo for a publish**. If you need to revert,
go to Phase 5.

---

## Phase 5 — Rollback (anytime)

A bad release is one of:

- macOS notarisation failed and Windows shows *unidentified
  developer* AND Linux AppImage refuses to launch.
- `latest.json` points at a URL that 404s or 403s.
- The Tauri signing public key does not validate.
- A critical runtime bug escaped CI and is blocking the
  primary use case (open SQLite connection, list tables).

### 5.1  Soft rollback — point `latest` away from the bad release

The fastest path is to overwrite `latest/latest.json` to
point at the previous known-good release. The Tauri updater
will see the change on next launch; macOS users will get a
"downgrade available" prompt, not a silent one.

```bash
VERSION="v0.0.9"   # previous good version
aws s3 cp "s3://nyala-assets/releases/nyala/${VERSION}/latest.json" \
  "s3://nyala-assets/releases/nyala/latest/latest.json" \
  --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --cache-control "no-cache"
```

Then re-sign with the current key:

```bash
tauri signer sign --private-key <Nyala-update-private-key> \
  -s /tmp/new-signature.sig -b <updated-latest.json>
aws s3 cp /tmp/new-signature.sig \
  "s3://nyala-assets/releases/nyala/latest/latest.json.sig" \
  --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
```

Re-`Publish` the original `v0.0.9` GitHub Release as a new
patched release explaining the rollback.

### 5.2  Hard rollback — delete the GitHub Release

Only do this if the artifacts themselves are dangerous (e.g.
a leak of credentials into the binary). The downside is that
existing installs that auto-updated to the bad release have
**no way to recover**; they will see a 404 from
`latest.json` until you re-point it.

```bash
gh release delete v0.1.0 --yes
```

Then follow 5.1 to repoint `latest`.

### 5.3  Cordoning upstream

If the issue is in the `mvp` branch — e.g. a migration script
that ran on user data — consider blocking the auto-updater
entirely:

- Comment out the `apply` step in `.github/workflows/release.yml`'s
  *Generate and upload latest.json*.
- Push a `release-v0.1.1-disabled` tag so the change lands.

The next release requires either reverting this commit or
uncommenting the line. **Do not** block releases through
repository settings; that path is undocumented.

---

## Phase 6 — Hand-off (T-0 +60 min)

After publish:

- Slack the team: `*Nyala Studio v0.1.0* published. New
  artifacts on the updater. Watch the errors channel for
  the next 24 hours.`
- File a brief release-tweet draft or blog post stub; do
  not publish until 24 hours of telemetry confirm the
  install is healthy.
- Update `docs/RELEASE-HISTORY.md` (create the file if it
  doesn't exist) with the link to the GitHub Release.

---

## Phase 7 — Post-mortem (T+7 days)

A week after the release, write
`docs/reviews/<date>-post-release.md` with:

- Whether every Phase 4 verification held up under real
  traffic.
- Anything reported in the issue tracker tagged
  `v0.1.0-regression`.
- Whether the rollback path (Phase 5.1) was actually
  necessary. If it wasn't, the runbook was over-engineered;
  if it was, document the timing.
- Any secret rotation cadence reminder. The Apple `.p12`
  expires yearly; the Trusted Signing cert lifetime is 3
  years. Calendar those dates in `docs/RELEASE-HISTORY.md`.

If anything went wrong, schedule a 30-minute retrospective
with whoever was on call.

---

## Appendix A — Local tooling required

The maintainer performing a release should have **all** of the
following installed and on PATH before starting:

| Tool | Purpose | Install |
| --- | --- | --- |
| Git | Tag cut | system |
| Node.js | `pnpm install` | `fnm install --lts` |
| pnpm | workspace | `corepack enable && corepack prepare pnpm@latest --activate` |
| Rust toolchain | `cargo build`, `cargo test` | `rustup default stable` |
| Tauri CLI | `tauri signer` | `cargo install tauri-cli --version "^2.0" --locked` |
| AWS CLI | R2 sync | `winget install awscli` or `brew install awscli` |
| Azure CLI | azure signing smoke test | `winget install azure-cli` |
| GitHub CLI | release management | `winget install gh`; `gh auth login` |
| GNU gettext (`base64`) | base64-encode .p12 | system / WSL |
| GPG | tag signing | system |

`pnpm install --frozen-lockfile` requires `corepack` enabled.

## Appendix B — DNS propagation cheatsheet

Cloudflare zone setup is the slowest step on T-3 day. The
realistic wall-clock by step:

| Step | Typical | Worst case |
| --- | --- | --- |
| Cloudflare account | instant | 1 hour (KYC) |
| Cloudflare R2 bucket | instant | instant |
| Zone nameserver delegation | 5 min | 24 h |
| R2 custom-domain CNAME | 5 min | 30 min |
| HTTPS cert provisioning | automatic via Cloudflare | 15 min |

The bottleneck is *registrar-side* nameserver update, not
Cloudflare. If the registrar is slow, queue the nameserver
change **first** on T-7 day; everything else is fast.

If the release is a same-day emergency and DNS has not
propagated, two fallbacks:

1. Use `vars.NYALA_CDN_BASE_URL` to point at a temporary
   Cloudflare Pages URL instead of `cdn.nyala.studio`. The
   `latest.json` body is identical; the only difference is
   the host.
2. Skip the auto-updater for this release and rely on users
   manually downloading from the GitHub Release page. The
   `*.sig` files are still useful for offline verification.

Both options should be flagged in the post-release review.

## Appendix C — Troubleshooting decision tree

If the workflow fails at `*Build Tauri app*`:

1. macOS failure: read the Tauri build log for `error:
   linker ...`. The most common cause is a stale Rust
   toolchain on the runner; the `tauri-apps/tauri-action`
   GitHub Action pins a specific Rust version and the runner
   image sometimes lags. Workaround: pin to an older
   `tauri-action` version until the runner is current.
2. Windows failure: the Azure trusted-signing step is
   sensitive to clock skew. If `az login` fails with *clock
   skew detected*, the runner is over five minutes from
   Azure time. Re-run the job; this is usually transient.
3. Linux failure: the AppImage bundle build relies on
   `linuxdeploy` from GitHub; check if that release's URL
   changed. If the binary URL moved, update the workflow
   and tag a follow-up.

If the workflow fails at `*Sign Windows installers*`:

1. The most common cause is the cert profile still being
   *Pending* in Azure (took longer than expected to
   provision). Re-run; if still failing, contact Azure
   support.

If the workflow fails at `*R2 — *`:

1. Verify the bucket exists and `aws s3 ls` works from your
   local shell using the same credentials in
   `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`.
2. Verify `R2_ACCOUNT_ID` matches the dashboard's *Account
   ID* field; copy-paste typos are the usual suspect.

If the workflow publishes but `latest.json` is missing keys:

1. The signature matching step did not find a `.sig` file
   because the artifact naming convention changed.
   Re-run *Generate and upload latest.json* only.

If existing installs refuse to update:

1. Verify the local install's "Check for updates" runs
   against `https://cdn.nyala.studio/releases/nyala/latest/latest.json`.
   Mac: *Nyala Studio → Check for Updates...* surfaces the
   underlying error.
2. If the URL is correct and the JSON body is reachable
   but the signature fails, **the public key in shipped
   builds no longer matches the signing key in this
   repo**. Roll the key forward per `tauri signer generate`;
   existing installs will need a manual download.

## Appendix D — Records to keep

Each release produces a paper trail. Keep these records in
`docs/reviews/`:

- **T-7 prep**, with verification timestamps for every
  sign-off.
- **T-3 provisioning**, with screenshots of the Apple cert
  issuance, Azure Trusted Signing profile approval,
  Cloudflare zone provisioning, and `curl
  https://cdn.nyala.studio/releases/nyala/latest/latest.json`
  returning valid JSON. The screenshots are the only
  evidence that the secrets are pointing at the right
  identities; secrets themselves are never written down.
- **T-0 tag cut + verification**, with the
  output of every Phase 3 step.
- **T+7 post-mortem** per Phase 7.

The provider consoles (Apple, Cloudflare, Azure) keep
their own logs. Those are not part of the repo; they are
the team's institutional memory for the credentials, and
they survive maintainer transitions.

## Appendix E — When the runbook is wrong

This runbook ages. The most common failure mode is a
provider rename (e.g. Azure Trusted Signing graduates from
preview and changes a field name). When you encounter a
step that no longer matches reality:

1. Do **not** improvise in production. Open a PR titled
   `docs: refresh release runbook for <provider> rename`
   with a checkpoint commit (the literal evidence of the
   old behaviour failing) attached.
2. Update the runbook and the corresponding workflow file in
   the same PR, so the next maintainer sees the diff.
3. Append a one-line note to
   `docs/RELEASE-HISTORY.md` describing the correction.

Improvised release runs leave no trail; documented runs
do.
