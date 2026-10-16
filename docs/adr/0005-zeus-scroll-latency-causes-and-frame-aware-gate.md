# ADR 0005: Zeus 10k Scroll Latency Causes and a Frame-Aware Z1 Gate

- Status: Accepted
- Date: 2026-10-14
- Owners: SQL Result, Product, Zeus Evaluation
- Related: [ADR 0004](./0004-zeus-data-grid-v7-floor-aware-metrics.md), [beta31 platform forensics](../reviews/2026-10-14-beta31-platform-forensics.md)

## Audit correction, 2026-10-14

The [collector comparability audit](../reviews/2026-10-14-collector-comparability-audit.md)
supersedes the causal conclusions below. The WebDriver attaches a trace from a separate
diagnostic navigation to each primary record. Matching sample indexes identify target
positions, not the same execution; the tail/body decomposition using primary totals and
trace timestamps is withdrawn. The rAF-to-task span includes the visibility probe and
possible browser style/layout/rendering, so it is not an independent host-only floor.

WorkbenchTable commits include range calculation and synchronous row-width measurement;
Zeus starts its commit span after range calculation. Their commit ratio describes elapsed
time within different boundaries, not pure CPU superiority. The new two-platform run
reproduces a 53.0%-91.3% commit-median improvement, with 76.6%-87.6% of WorkbenchTable commit
time inside its width-measurement wrappers. This does not exclude a production bottleneck
in Zeus, prove one exists, or support the assertion that only a gate change remains.

The decision below accepts a separate, pre-registered v8 measurement contract. It does not
change the frozen v7 evidence or turn Z1 into a `GO`. v8 admission is allowed only for new
records that carry symmetric renderer-operation boundaries and same-execution attribution;
the historical separately navigated traces remain diagnostic-only.

## Context

Z1.3 is `NO-GO` on five consecutive revision-bound platform gates (runs `38508002618`,
`38510371921`, `38512191285`, `38523458804`, `38525197105`), all on measurement contract v7
with candidate Zeus core `0.1.1-beta.12` and `@zeus-web/data-grid@0.1.0-beta.31`. The gate
asks for a `>= 20%` p95 improvement of Zeus `scrollP95Ms` against `bestNonZeus` on `10k-x-50`.
The observed point estimates are `13.9%` (Windows WebView2) and `9.8%` (macOS WKWebView).

ADR 0004 already argued that the `20%` target is unreachable at a ~one-frame floor. This ADR
does not reopen that argument. It records what the two completed gate runs and the paired
20-pair beta30/beta31 experiment can now say about **where the remaining latency comes from**,
and proposes the smallest gate change that is consistent with that evidence.

The evidence files for runs `38523458804` and `38525197105` contain primary admission records
plus separately navigated diagnostic traces. Primary records use `diagnosticProfile=true` and
`floorOnly=true`; the attached traces use instrumentation. Matching `sampleIndex` and
`targetOffset` across these navigations identifies the input plan, not a common execution.
The primary `inputMs`/`presentationWaitMs`/`validationMs` cannot be decomposed using attached
trace timestamps.

## Historical interpretation (superseded by the audit correction)

Zeus commits in `2.0-3.0ms` (`signalPublishStartTime -> signalPublishEndTime` and
`commitStartTime -> commitEndTime`, medians). That work is identical in the tail and in the
body: on run `38525197105` Windows `10k-x-50`, the 94 single-frame samples have a `2.55ms`
median commit and the 6 two-frame samples also have `2.55ms`; the input-end-to-dispatch gap is
`14.90ms` and `14.95ms` respectively. No sample in the eight groups is rejected by
`rowDelta` or offset tolerance, and both renderers advance the same rows (median `5549` rows
per sample on `10k-x-50`, visible range `0-9987`).

`inputMs` differs by an order of magnitude (Zeus `0.00-1.00ms`, WorkbenchTable
`6.35-22.00ms`) because WorkbenchTable renders inside the assignment call stack:
`Scrollable.setScrollPositionNow` fires `this._onScroll` synchronously
(`src/vs/base/common/scrollable.ts:399`) and `ListView.onScroll` calls `this.render(...)`
(`listView.ts:1346`). Zeus renders from the DOM scroll event instead. The split is an
accounting difference, not a latency difference: the per-sample median total is already
`15.4ms` (Zeus) against `18.0ms` (WorkbenchTable) on Windows `10k-x-50`.

On macOS the wait exceeds `inputEnd -> dispatch -> firstVisible` by `+8ms` at the median. That
excess sits in `nextPaintTaskTime - nextPaintRafTime` (`16.00ms` against `5.50ms` on Windows),
the interval between the rAF callback and the following paint task, which
`waitForFrame` (`sql-result-grid-segment-trace.mjs:43-60`) samples but Zeus does not own.
`firstVisiblePhase` is `raf` for all 800 Zeus samples.

Three candidate causes were tested against the data:

| Hypothesis                                              | Verdict                                                                                                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A slow binding/commit path drives the 10k tail          | Rejected: tail and body commits are the same `2.55ms`.                                                                                                                                                             |
| Native scroll-event dispatch costs Zeus one extra frame | Rejected as a latency source: a Chromium A/B of both models (`25.4ms` vs `25.3ms` total, 40 samples each) shows no difference, because the dispatch point sits at the same place relative to the frame either way. |
| The macOS residual is Zeus work                         | Rejected: it is host frame scheduling in the `raf -> task` gap.                                                                                                                                                    |

The interpretation above did not validate a specific Zeus or zeus-ui production fix. It also
does not rule one out: same-execution measurements with calibrated boundaries are required
before attributing the remaining latency.

## Accepted v8 decision

1. Keep measurement contract v7, its verifier, fixtures, and attestations frozen for
   historical evidence. v8 uses an independent verifier and must reject v7 records.
2. Measure only the Zeus and repository WorkbenchTable renderers. Native has no equivalent
   renderer-operation collector and is not a v8 baseline.
3. For each scroll input, both renderers must report one same-execution operation with the
   boundary `symmetric-renderer-work-v1`: `startTime`, `endTime`, `durationMs`, and the
   associated `commitTransactionIds`. The duration must be recomputable from the timestamps,
   and the operation must be linked to the same sample input.
4. Use the per-platform `10k-x-50` renderer-work median as the primary metric. Zeus must
   improve over WorkbenchTable by at least 20%. The renderer-work p95 is a non-regression
   guard, and `1k-x-20` total latency may regress by at most 10%.
5. Require calibration evidence for instrumentation overhead. The calibration must show
   renderer-work relative change no greater than 5% and absolute change no greater than
   0.25ms; missing or failing calibration is `UNAVAILABLE`/`NO-GO`.
6. Require matching provenance, bundle digests, run tokens, session generation, and workflow
   identity for every paired record. Any recovery, retry, app restart, session-generation
   transition, diagnostic-only flag, or cross-navigation trace makes v8 admission unavailable.
7. Host frame excess and presentation-floor values may be reported for context but cannot
   by themselves change an admission result.

This is a measurement-contract decision only. It authorizes implementation of the v8
collector, verifier, and workflow; it does not authorize a production renderer change,
release, or a `GO` result without new real-platform evidence.

## Historical proposal (superseded by the accepted decision)

1. Do not change Zeus or `@zeus-web/data-grid` solely on the withdrawn causal decomposition.
   Establish same-execution measurements before selecting a production fix.
2. Propose candidate statistics that need calibrated attribution before any Z1 gate use:
   - **Primary (renderer work)**: median `commit` interval per sample, from the Zeus
     `segmentTrace`, compared against `min(WorkbenchTable, native)` on the same records. This is
     a candidate diagnostic quantity requiring symmetric boundary calibration. Native has no
     measured commit interval in the current profile, so that proposed baseline is incomplete.
   - **Guard (excess over the host interval)**: report `p95(totalMs) - hostRafToTask` per
     platform, where `hostRafToTask` is that platform's own median
     `nextPaintTaskTime - nextPaintRafTime`. This remains a cross-navigation descriptive
     statistic, not an established causal bound or guard,
     and is reported per platform rather than pooled.
3. Keep the intended `bestNonZeus` comparison and the per-platform split. A pooled ratio can
   hide platform differences and cannot establish both platforms' admission conditions.
4. Do not adopt a floor subtraction. The separately sampled reference distribution is not an
   additive budget within the same scroll event; subtraction does not establish causality.

## Consequences

- Z1.3 stays `NO-GO`. This ADR does not turn it into a Go, and it does not authorize a
  production `@zeus-web/data-grid` dependency or Z2.
- A future v8 verifier needs validated symmetric measurements and same-execution attribution.
  The attached v7 diagnostic traces do not supply that requirement. Any new measurement
  contract must be pre-registered before admission use.
- The `20%` target and the v6/v7 artifacts stay unchanged until a v8 schema is accepted.
- A commit regression may motivate investigation; existing evidence does not establish whether
  renderer work drives the primary tail.

## Metric check on the two completed gate runs

Both proposed metrics were recomputed from the raw records before being written here, and the
first form of the guard did not survive that check.

The historical primary (`max` over commit widths the sample claims) is computed
from `segmentTrace.diagnostics.commits` joined by `commitTransactionIds`. Zeus commits are
`commitEndTime - commitStartTime`; WorkbenchTable commits are the union of its nested
`commitIntervals`.

| Run / platform / workload | Zeus median | WorkbenchTable median |
| ------------------------- | ----------: | --------------------: |
| `38523458804` win 10k     |        2.90 |                     — |
| `38525197105` win 1k      |        2.50 |                  5.55 |
| `38525197105` win 10k     |        2.55 |                 10.40 |
| `38525197105` mac 1k      |        2.00 |                  8.50 |
| `38525197105` mac 10k     |        2.00 |                 25.00 |

Run `38523458804` carries no WorkbenchTable commit intervals, so the primary is Zeus-only there.
Where both sides exist, captured commit spans are `2.0-2.6ms` for Zeus against WorkbenchTable's
`5.6-25.0ms`, a `2.2x`-`12.5x` difference within different collector boundaries. This cannot
replace the current `scrollP95Ms` gate or isolate framework CPU performance. Diagnostic profile
v2 now unions all claimed commit intervals instead of taking the longest one.

The guard's first form (`share of samples above 1.5 x host interval`) was rejected: it returns
`100%` for nearly every renderer and workload, including WorkbenchTable, so it carries no signal.
Subtracting the host interval and taking `p95` of the remainder does discriminate:

| Run / platform / workload | Zeus excess | WorkbenchTable excess |
| ------------------------- | ----------: | --------------------: |
| `38523458804` win 1k      |       13.70 |                     — |
| `38523458804` win 10k     |       18.10 |                     — |
| `38525197105` win 1k      |       13.70 |                 14.90 |
| `38525197105` win 10k     |       23.60 |                 26.00 |
| `38525197105` mac 1k      |       26.00 |                 27.00 |
| `38525197105` mac 10k     |       26.00 |                 45.00 |

Zeus's excess is at or below the baseline's on five of the six comparable rows, and clearly
below on macOS `10k-x-50` (`26.00` against `45.00`). A v8 threshold would still have to be
pre-registered; this table only shows that the quantity is well-defined and separates the two
renderers, and it does not propose a value.

## Status meaning

`Accepted` makes the v8 measurement contract binding for new work. It does not rewrite v7
evidence, approve a production optimization, authorize a release, or change the Z1 result.
