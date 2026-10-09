# ADR 0004: Zeus Data Grid Floor-Aware Performance Metrics (v7)

- Status: Proposed
- Date: 2026-09-17
- Owners: SQL Result, Product, Zeus Evaluation
- Related: [MVP vNext roadmap](../sql-mvp-phases/mvp-vnext-agent-zeus-roadmap.md), [Z1 spike verification](../sql-mvp-phases/phase-z1-spike-verification.md), [performance remediation](../reviews/2026-08-18-zeus-data-grid-performance-remediation.md)

## Context

Z1.1 and Z1.2 are complete. Zeus core `0.1.1-beta.3` and zeus-ui
`0.1.0-beta.5` are published. The currently published zeus-ui beta.5 package
still declares the Zeus runtime and peer closure at core `0.1.1-beta.2`, so
Nyala's beta.5 audit records the actual closure and does not claim core beta.3
integration. Revision-bound macOS WKWebView and Windows WebView2 evidence exists
for the earlier pinned revision, but no new evidence has been collected for the
beta.5 pin.
Measurement contract v6 still fails five performance checks, so `Z1.3 = NO-GO`.

The failure is not a missing audit. It is a measurement-contract defect: v6
implicitly requires the baseline to be at least `1.25 x` the shared
post-presentation floor, because `required = 0.8 x baseline` and no renderer's
p95 can sit below that floor. Every recorded evidence set misses that
precondition.

Recomputable form, using
[`scripts/analyze-sql-result-grid-floor-headroom.mjs`](../../scripts/analyze-sql-result-grid-floor-headroom.mjs)
against reports that pass the existing diagnostic validator:

| Evidence set                                                                    | baseline p95 | shared floor p95 | required Zeus p95 | baseline / floor |
| ------------------------------------------------------------------------------- | -----------: | ---------------: | ----------------: | ---------------: |
| recorded characterization profile, rev `63698263` (HEAD blob `f1d4dade`)        |      20.10ms |          18.50ms |           16.08ms |            1.086 |
| regenerated working-tree profile, real WorkbenchTable (uncommitted, `c4ab123d`) |      17.70ms |          17.50ms |           14.16ms |            1.011 |
| churn A/B r3, churn enabled (local diagnostic)                                  |      20.90ms |          16.90ms |           16.72ms |            1.237 |
| churn A/B r3, churn disabled (local diagnostic)                                 |      20.80ms |          17.40ms |           16.64ms |            1.195 |
| churn A/B r5, churn enabled (local diagnostic)                                  |      20.50ms |          16.80ms |           16.40ms |            1.220 |
| churn A/B r5, churn disabled (local diagnostic)                                 |      20.50ms |          16.90ms |           16.40ms |            1.213 |
| real WorkbenchTable r5, pre-instrumentation bundle (`nyala-real-wbt-r5.json`)   |      17.60ms |          17.80ms |           14.08ms |            0.989 |

All seven surviving sets land in `0.989-1.237`, so the `20%` superiority target is
unreachable even with a zero-cost renderer: the best surviving case caps at
`19.62%`, `0.38` percentage points short. An earlier attribution report quoted
`18.6 / 14.8ms`; that report has been deleted and its bundle digest
(`2f763047`) differs from the surviving A/B bundles, so this ADR cites only
recomputable numbers. The two profile rows are the same file at two revisions:
the recorded blob is the fixed-row characterization artifact, and the working
tree now holds a regenerated run against the real WorkbenchTable. The last row is
the first surviving set whose baseline sits at the floor (`baseline / floor < 1`),
because a production WorkbenchTable is faster than the characterization stand-in
the frozen v6 Chromium evidence used.

The floor itself is run-dependent: `16.7-18.6ms` across the 33 Zeus-side 10k
records of the seven surviving sets (`28` of them excluding the
real-WorkbenchTable r5 set), about one 60Hz frame. Four workbench-table records
sat above that span (`18.7`, `20.1`, `21.4`, `31.7ms`; three of them above
`20ms`), so the full 66-record span is `16.7-31.7ms`; the shared floor uses
per-report medians and is not driven by those outliers. What stays invariant is
the sign, with `required < floor` in every set.

Reproduction check (2026-09-18, HEAD `882ba222`): pointing the CLI at the raw
reports below reproduced every `baseline p95` / `shared floor p95` /
`required Zeus p95` value in this ADR and in the seven-set table of the
[Z1 spike verification](../sql-mvp-phases/phase-z1-spike-verification.md); the
best floor-bounded improvement stayed `19.62%`. Both profile runs used the same
Zeus bundle (`0dddde8f65195667d1bdd0f574f2ac3a4ffa1c5b019c8f1a13db5bd2fc0a6794`),
so the Zeus side is comparable across them; the `1.086 -> 1.011` shift comes from
the baseline change (fixed-row characterization at HEAD, real WorkbenchTable in
the working tree) plus floor drift, not from a Zeus change. The recorded row is
reproduced by materializing the HEAD blob first:

```bash
git show HEAD:docs/sql-mvp-phases/phase-z1-feasibility-profile.json > /tmp/nyala-head-feasibility-profile.json
node scripts/analyze-sql-result-grid-floor-headroom.mjs \
  --report /tmp/nyala-head-feasibility-profile.json \
  --report docs/sql-mvp-phases/phase-z1-feasibility-profile.json \
  --report /tmp/nyala-zeus-ab/ab-enabled.json \
  --report /tmp/nyala-zeus-ab/ab-disabled.json \
  --report /tmp/nyala-zeus-ab/ab-enabled-r5.json \
  --report /tmp/nyala-zeus-ab/ab-disabled-r5.json \
  --report /tmp/nyala-real-wbt-r5.json
```

Evidence identifiers:

- recorded checked-in profile: git blob `f1d4dade10eb537ec0e3c31c703a49160af6eaf0`
  (`git rev-parse HEAD:docs/sql-mvp-phases/phase-z1-feasibility-profile.json`) — checked in.
- regenerated working-tree profile: sha256
  `c4ab123db9b1aaea59353b49f90436a7e0a911522f7b0b0be3f247e437587949` — uncommitted.
- churn A/B r3 `ab-enabled.json` / `ab-disabled.json`: sha256
  `a76482cfa734db0a7f51b05ac5f82a5bf46db0cd0f91efc14e556b1d3592a922` /
  `f11b8735a11d4bf5d66f2b59fd26e1672c5638f8f1ef1ff335d96804461ac09d` — `/tmp`, volatile.
- churn A/B r5 `ab-enabled-r5.json` / `ab-disabled-r5.json`: sha256
  `07590708c95fd2c94896022cac44fa0e3acec2f6a94f1b5e2307a98539e4fb75` /
  `ced53e663f2fe8d1769ad231bcb0270cc27f6e3d22a8558fbe661a3e98d071aa` — `/tmp`, volatile.
- real WorkbenchTable r5 `nyala-real-wbt-r5.json` (2026-09-18, revision `882ba222`,
  `sourceTreeClean=false`, real-WorkbenchTable bundle
  `f58986b454aeecbe8500c0357f76839140f26f22149294f14a5e8435a4128a35`): sha256
  `f4e08b7d8968e71c67632c6e3e8503547c28df68cb99a7f8038b9db74e5894be` — `/tmp`,
  volatile, regenerable from the command in the identifiability check.

Only the recorded profile is checked in; the A/B reports and the real
WorkbenchTable run are local-only and must be preserved by hand — or regenerated
from the recorded commands — for a reviewer to recompute the other six sets.
That does not weaken the decision: the recorded row alone caps any renderer at
`13.43%`.

The surviving 5-repeat A/B arms decompose the same gap: Zeus renderer interval
unions (handler, range, patch, and layout reads, unioned rather than summed) are
`1.60 / 2.50ms` p50/p95 with churn enabled and `1.30 / 2.20ms` with churn
disabled, against paired shared floors of `16.80ms` / `16.90ms`. All 200 scroll
samples per arm needed exactly one presentation opportunity, so the measured
latency is dominated by the frame wait, not by renderer work.

A diagnostic-only Chromium profile also recorded instrumented commit intervals
of `1.3 / 2.1 / 2.2ms`, but beta.4 counted MutationObserver records and walked
the Node tree before writing `commitEndTime`. Those numbers are upper bounds, not
production pool cost. The v6 gate verifier contains no floor check at all, so a
floor-aware contract must sample the floor inside the same paired evidence set.

### Identifiability check (2026-09-18, local diagnostic)

Three independent reads of the surviving evidence show that the v6 ratios are
not distinguishable from frame phase at this floor. None of them changes a
threshold, a gate, or a dependency decision.

1. Aggregation decides the sign. On the frozen v6 Chromium benchmark
   (`docs/sql-mvp-phases/phase-z1-benchmark.json`, 3 runs x 20 samples per
   renderer, 10k x 50), the v6 aggregation (median of per-run p95) gives
   WorkbenchTable `19.80ms` and Zeus `19.60ms`, ratio `0.990` — Zeus nominally
   ahead. Pooling the same 60 samples per renderer gives WorkbenchTable
   `20.10ms` and Zeus `37.90ms`, ratio `1.886`. The swing is one `142.4ms` Zeus
   run; the frozen record is identical in both readings.
2. The production baseline sits on the floor. With
   `--workbench-table-implementation real`, baseline p95 is `17.70ms`
   (worktree profile) and `17.60ms` (pre-instrumentation r5 run), against shared floors of
   `17.50ms` / `17.80ms`; `required = 14.08-14.16ms` is `2.8-3.7ms` below the
   floor. v6 evidence used a fixed-row characterization at `19.80-20.10ms`, so
   v6 was measured against a slower stand-in than the renderer Z2 would ship.
3. Every Chromium sample settled in one frame. Content was correct at the first
   post-input presentation opportunity in `720/720` legacy v6 samples,
   `240/240` worktree-profile samples, `200/200` pre-instrumentation real-WorkbenchTable
   samples, and `400/400` A/B samples. The `10%` / `20%` thresholds are
   `1.8-4.0ms` at an `~18ms` baseline, roughly `0.1-0.25` of a 60Hz frame, and
   the only large renderer-owned split in that harness is the synchronous input
   path: input p95 `4.40-7.30ms` (real WorkbenchTable) versus `0.10-0.20ms`
   (Zeus), with settle p95 `13.90-14.10ms` versus `19.10-20.40ms`. The totals are
   floor-bound for both renderers, so v6 cannot see the difference it is
   nominally measuring.

Native evidence points the same way but cannot be decomposed: macOS 10k x 50
recorded `19.0ms` baseline against `22.0ms` Zeus (`-15.8%`) and Windows
`26.0ms` against `22.0ms` (`+15.4%`), both below the `20%` bar, and the native
records carry no presentation-floor diagnostics because that probe is Chromium
diagnostic-profile only.

Regeneration (writes only the report; the analyzer remains read-only):

```bash
node scripts/benchmark-sql-result-grid.mjs \
  --renderer workbench-table,zeus --workload 10k-x-50 --repeat 5 \
  --workbench-table-implementation real --require-zeus true \
  --zeus-bundle /tmp/nyala-zeus-ab/data-grid-bundle.js \
  --diagnostic-profile true --output /tmp/nyala-real-wbt-r5.json
```

This ADR pre-registers a replacement metric contract. It does not rewrite v6,
does not flip `phase-z1-gate.json`, and does not authorize Z2 or R0.

## Decision

Keep measurement contract v6 and the recorded `NO-GO` frozen. If product accepts
this ADR, Nyala will add a separate measurement contract v7 that can only consume
v7 evidence. v7 evidence cannot be used to rewrite a v6 report.

Until this ADR is `Accepted`, no v7 sampling is admission evidence.

### Diagnostic prerequisite

Before any v7 CPU interval is treated as renderer-owned:

1. `@zeus-web/data-grid` must record `commitEndTime` at the renderer commit
   boundary, before `MutationObserver.takeRecords()` and Node tree counting.
2. Diagnostics traversal must end at a separate `diagnosticsEndTime`.
3. Production bench primary metrics must not include diagnostics traversal.
4. Nyala may accept `diagnosticsEndTime` as optional on the existing diagnostic
   sidecar so beta.4 samples remain valid. Split timing becomes required only
   after a published Data Grid that exposes the field is exact-pinned for v7.

5. An unpublished or diagnostic-only Data Grid may expose `measureNodeChurn:
false` so renderer commit cost can be A/B'd with diagnostics traversal
   excluded. That switch is not a pin and is not v7 admission evidence.

6. The Nyala benchmark harness must emit the same interval definitions for the
   WorkbenchTable renderer. Today only Zeus writes a diagnostics sidecar
   (`createZeusDataGridDiagnosticCollector` in
   `scripts/sql-result-grid-zeus-diagnostics.mjs`); WorkbenchTable records carry
   the presentation floor only, so `Q95(cpu_Z) / Q95(cpu_W)` cannot be computed
   at all until that instrumentation exists. Its absence is a prerequisite, not
   a Go.

Unpublished zeus-ui working-tree changes are not a pin and are not a release.

Implementation status (2026-09-17 audit, not admission evidence): an unpublished
zeus-ui working tree (`codex/release-0.1.0-beta.5`, 4 modified files) implements
items 1-5 above (the zeus-ui-side items; item 6 is a Nyala harness prerequisite).
A rebuild from that tree, run through the same esbuild
invocation as the A/B recordings, is byte-identical to the bundle those
recordings used (SHA-256
`3f66cf7e58e8e4ac523bfc4644f1a735fe0fe5f4db5a8469e365f69523ad2c58`, 90,370
bytes), so those results are attributable to those bytes rather than to an
unknown build. The tree is not committed, not released, and remains neither a
pin nor v7 evidence; this record changes no gate status.

Implementation status (2026-09-18, item 6, Nyala harness, not admission
evidence): the benchmark harness now emits the same interval definitions for the
real WorkbenchTable renderer.
`scripts/sql-result-grid-workbench-table-diagnostics.mjs` wraps
`ListView.prototype` `onScroll` / `getRenderRange` / `render` /
`measureItemWidth` before the table is constructed (the `ListView` captures its
scroll handler at construction time) and records `handlerStartTime`,
`handlerEndTime`, `rangeIntervals`, `commitIntervals`, and
`layoutReadIntervals` per scroll commit. Calls outside an explicitly opened
diagnostic operation window are not recorded, and the instrumentation is
enabled only by `--diagnostic-profile true`.
`scripts/sql-result-grid-floor-headroom.mjs` unions the intervals per record and
now reports `rendererCpuRatio` next to the existing floor math.

The instrumentation changes the benchmark bundle, so its identity is recorded
per state: the committed pre-instrumentation entry builds to
`f58986b454aeecbe8500c0357f76839140f26f22149294f14a5e8435a4128a35`, while the
uncommitted instrumented entry builds to
`a5f54dff362f5533f85cf0b5c4f37e736b25a921b2056456bc2df30d53abb382` (886,181
JavaScript bytes and 20,650 CSS bytes; hash over `JavaScript + NUL + CSS`). The
diagnostic runs below record the latter.

A fresh diagnostic run (`10k x 50`, `--repeat 3`, real WorkbenchTable against
the same Zeus bundle) recorded on 2026-09-18:

```bash
node scripts/benchmark-sql-result-grid.mjs \
  --renderer workbench-table,zeus --workload 10k-x-50 --repeat 3 \
  --workbench-table-implementation real --require-zeus true \
  --zeus-bundle /tmp/nyala-zeus-ab/data-grid-bundle.js \
  --diagnostic-profile true --output /tmp/nyala-wbt-diagnostic-r3.json
node scripts/analyze-sql-result-grid-floor-headroom.mjs \
  --report /tmp/nyala-wbt-diagnostic-r3.json
```

That run yields Zeus interval-union p95 `2.30ms`, WorkbenchTable interval-union
p95 `4.60ms`, and `Q95(cpu_Z) / Q95(cpu_W) = 0.500`, against baseline p95
`17.00ms` and shared floor p95 `17.20ms`. Both sides summarize only the scroll
commits their sidecar claims for `phase: 'sample'` operations; the collectors
also record one preposition scroll commit (on the Zeus side that scroll
operation carries no commit link, and a separate `resize` commit exists), and
counting it on one side only would compare different event sets. The first pass
counted that commit on the WorkbenchTable side and read `5.00ms / 0.460`;
restricting both sides to `phase: 'sample'`
commits re-reads the same report as `4.60ms / 0.500` with 60 commits per side,
and a contract test now rejects preposition commits. Report sha256
`fe476fb2ddd1614004ac7e7ed1fabab8bb9aaa344f120f90a1b94d18443c9434` — `/tmp`,
volatile. The ratio the v6 evidence could not compute at all is now computable
on symmetric definitions, and the measured ratio is far below the proposed
`0.80`. This is still not a Go: the same run's baseline sits below
`1.25 x` floor, so `required = 13.60ms` is unreachable below the `17.20ms`
floor and the floor-bounded improvement caps at `1.18%`. The instrumentation is
local, Chromium/CDP, and diagnostic only; it changes no gate status, and
`phase-z1-gate.json` stays `NO-GO` until a v7 contract is accepted and sampled
under the formal plan below.

A follow-up run on the same day sampled the ratio on the other primary
workload. The harness only assembles a diagnostic report when the selection
includes `10k-x-50`, so the run carries both primary workloads and the
workload-scoped analyzer entry point extracts the `1k x 20` records:

```bash
node scripts/benchmark-sql-result-grid.mjs \
  --renderer workbench-table,zeus --workload 1k-x-20,10k-x-50 --repeat 3 \
  --workbench-table-implementation real --require-zeus true \
  --zeus-bundle /tmp/nyala-zeus-ab/data-grid-bundle.js \
  --diagnostic-profile true --output /tmp/nyala-wbt-diagnostic-1k-r3.json
node scripts/analyze-sql-result-grid-floor-headroom.mjs \
  --report /tmp/nyala-wbt-diagnostic-1k-r3.json --workload 1k-x-20
```

On `1k x 20` that run yields Zeus interval-union p95 `2.50ms`, WorkbenchTable
interval-union p95 `3.10ms`, and `Q95(cpu_Z) / Q95(cpu_W) = 0.806` (6 records,
60 sample scroll commits per side, one-frame `120/120`); the same report's
`10k x 50` records give `0.490`. The 1k point estimate sits below the proposed
`1.10` non-inferiority bound and above the `0.80` superiority bound, which is
the shape the per-workload thresholds were registered for. Both numbers are
single-run point estimates from Chromium/CDP; they do not compute the
paired-bootstrap confidence bound the proposed thresholds are defined on, and
they change no gate status.

A later 5-repeat run on the same day sampled both primary workloads inside one
report (`/tmp/nyala-real-wbt-cpu-both-r5.json`, sha256
`d2d260db9f15f7b44533c7ab96e0e957e150c34c31f7f0a9dde07449f63c42f3`, `/tmp`,
volatile, same command with `--workload 1k-x-20,10k-x-50 --repeat 5`). On
`10k x 50` it gives baseline p95 `17.50ms`, required `14.00ms`, shared floor p95
`17.40ms`, Zeus interval-union p95 `3.00ms`, WorkbenchTable interval-union p95
`6.00ms`, ratio `0.500`, one-frame `200/200`, and 100 sample scroll commits per
side; on `1k x 20` it gives `3.00ms / 3.10ms / 0.968`. The two `1k x 20` point
estimates (`0.806` at `--repeat 3`, `0.968` at `--repeat 5`) bracket the
proposed `0.80` superiority bound on the same machine, which is exactly why the
registered thresholds are paired-bootstrap bounds rather than point values. The
10k `required` sits `3.40ms` below the shared floor there, so the floor-bounded
improvement caps at `0.57%` (`4.57%` at the most optimistic floor) and the 20%
gate remains unreachable.

### Primary A: continuous-scroll jank

Use real wheel or trackpad-like input in the embedded WebView for 5 seconds of
bidirectional vertical and horizontal scrolling. Measure idle rAF `T_vsync` first:

```text
jank_i = 1[frameInterval_i > 1.5 * T_vsync]
jankRate = sum(jank_i) / frameCount
```

Proposed thresholds, fixed before sampling:

- 10k x 50 superiority: evaluate `jankRate_Z / jankRate_W` only when the
  Workbench baseline point estimate is `>=1%`. The paired bootstrap 95% CI upper
  bound must be `<= 0.80`. If baseline jank is `<1%`, the result is
  `NOT-EVALUABLE`. Do not swap in an absolute margin after seeing data.
- 1k x 20 non-inferiority: the 95% CI upper bound of `jankRate_Z - jankRate_W`
  must be `<= +1` percentage point.

### Primary B: renderer-owned CPU p95

Take the union of handler, window calculation, DOM patch, and synchronous layout
read intervals. Exclude rAF or task-queue idle, and exclude diagnostics
traversal after `commitEndTime`.

```text
rendererCpu_i = duration(union(handlerIntervals,
                               rangeIntervals,
                               patchIntervals,
                               forcedLayoutIntervals))
```

Proposed thresholds:

- 10k x 50: paired bootstrap 95% CI upper bound of `Q95(cpu_Z) / Q95(cpu_W) <= 0.80`.
- 1k x 20: the same ratio upper bound `<= 1.10`.

WorkbenchTable must emit the same interval definitions. Nested intervals are
unioned, not summed. Primary A and Primary B must both pass. CPU alone is not a
user-latency Go.

### Guard C: one-frame correctness

```text
framesToCorrect = presentation opportunities from input until the correct
                  row identity and content are visible
miss = 1[framesToCorrect > 1]
```

Zeus minus WorkbenchTable miss-rate difference 95% CI upper bound must be
`<= +1` percentage point. Offset, row identity/content, and blank-window checks
remain mandatory.

Formal Guard C needs at least 300 fresh-instance paired one-input blocks per
platform and primary workload. Do not treat 20 inputs inside one steady run as
independent Bernoulli trials.

### Secondary guards

| Guard           | Proposed threshold                         |
| --------------- | ------------------------------------------ |
| mount p95 ratio | Zeus / Workbench `<= 1.10`                 |
| DOM ratio       | Zeus / Workbench `<= 0.50`                 |
| 1k correctness  | 0 wrong, blank, or identity-mismatched row |
| gzip bundle     | `<= 30,000` bytes                          |
| retained heap   | report only; no primary gate               |

### Sample plan

| Dimension          | Formal value                                                                |
| ------------------ | --------------------------------------------------------------------------- |
| Platforms          | macOS embedded WKWebView, Windows embedded WebView2                         |
| Diagnostic only    | Chromium headless; never admission evidence                                 |
| Primary workloads  | 1k x 20 non-inferiority, 10k x 50 superiority                               |
| Guard workloads    | wide-columns horizontal scroll, narrow-panel layout and correctness         |
| Renderers          | real WorkbenchTable, exact-pinned Zeus                                      |
| Steady runs        | 30 balanced paired runs per platform / primary workload / renderer          |
| Per steady run     | 5s continuous wheel trace                                                   |
| Correctness blocks | at least 300 fresh-instance paired one-input blocks per platform / workload |
| Mount runs         | 30 fresh-process runs per platform / primary workload / renderer            |
| Statistics         | pair by run or block; do not treat frames inside a run as independent       |

### Statistics

Every confidence interval is a one-sided 95% upper bound from a paired
bootstrap, fixed here so that no analysis choice can follow the data:

- Resampling unit: the paired run for Primary A, Primary B, and the secondary
  ratios; the paired correctness block for Guard C. Frames inside one run and
  inputs inside one steady run are never independent units.
- Pairing: each resample draws the same run or block indices for both renderers,
  so every statistic is computed on `n` paired draws of the registered
  per-workload quantity. Arms are never resampled independently, and a run is
  never dropped on one side only.
- Resamples: 10,000, percentile method, one-sided 95% upper bound.
- Seed and estimator identity are recorded in the report, and the gate verifier
  recomputes the interval from raw records rather than trusting a summary field.
- Intervals are per platform and per workload. Pooling platforms, pooling
  workloads, or deriving a combined interval from two intervals is not a v7
  result.
- With resampling disabled the estimator must reproduce the report's point
  estimate (`Q95` ratio, jank ratio, or miss-rate difference) exactly, so a v7
  report and its interval can be checked against each other.

v7 may record a performance Go only when Primary A, Primary B, Guard C,
secondary guards, revision-bound two-WebView evidence, and protected provenance
all pass. A `NOT-EVALUABLE` Primary A is not a Go.

## Consequences

- Product must accept this ADR before a v7 schema, verifier, or protected
  workflow is built.
- Old v6 artifacts, 20% thresholds, and `phase-z1-gate.json` stay unchanged.
- Zeus core scheduler and `SizeCache` stay deferred until split timing shows a
  frame-order or variable-height problem.
- Z2 remains forbidden while `Z1.3 = NO-GO`.
- Accepting this ADR still does not pin a new zeus-ui release or add a
  production `@zeus-web/data-grid` dependency.

## Status meaning

`Proposed` is ready for product review. It is not an implementation contract
and not a sampling authorization.
