# ADR 0005: Zeus 10k Scroll Latency Causes and a Frame-Aware Z1 Gate

- Status: Proposed
- Date: 2026-10-14
- Owners: SQL Result, Product, Zeus Evaluation
- Related: [ADR 0004](./0004-zeus-data-grid-v7-floor-aware-metrics.md), [beta31 platform forensics](../reviews/2026-10-14-beta31-platform-forensics.md)

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

All numbers below come from the admission records themselves (`platform-evidence.json` for runs
`38523458804` and `38525197105`). Admission runs carry `diagnosticProfile=true` and
`floorOnly=true`, so `inputMs`, `presentationWaitMs`, `validationMs` and the Zeus `segmentTrace`
timestamps are present in the formal records; no sidecar summary is mixed in. `phase=sample`
trace segments carry `sampleIndex` and `targetOffset`, which join 100/100 to `scroll.samples[]`
in all eight run x platform x workload groups.

## What the evidence shows

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

Consequence: no Zeus or zeus-ui production change is indicated by this evidence. A binding-path
optimization, a synchronous-commit change, and a scroll-subsystem rewrite were all considered;
the first two are unsupported and the third is an unrelated architecture project.

## Decision

1. Do not change Zeus or `@zeus-web/data-grid` to chase the `10k-x-50` gap. Record the cause
   analysis and revisit only when a candidate binds to a measured interval.
2. Propose that the Z1 gate measure the two things it can actually attribute:
   - **Primary (renderer work)**: median `commit` interval per sample, from the Zeus
     `segmentTrace`, compared against `min(WorkbenchTable, native)` on the same records. This is
     the only part of the latency the framework controls.
   - **Guard (excess over the host interval)**: report `p95(totalMs) - hostRafToTask` per
     platform, where `hostRafToTask` is that platform's own median
     `nextPaintTaskTime - nextPaintRafTime`. This bounds the part of the tail that host
     scheduling cannot explain, and is reported per platform rather than pooled.
3. Keep `bestNonZeus` and the per-platform split. A pooled ratio hides the macOS host gap that
   this analysis identified, so a single cross-platform improvement number must not be the gate.
4. Do not adopt a floor subtraction. On `10k-x-50` the Zeus wait (`15.3ms`) and the shared floor
   (`16.7-17.0ms`) are two measurements of the same frame wait, not additive budgets; subtracting
   them produces a number with no physical referent.

## Consequences

- Z1.3 stays `NO-GO`. This ADR does not turn it into a Go, and it does not authorize a
  production `@zeus-web/data-grid` dependency or Z2.
- A v8 verifier would need the segment trace to be present on every admission record (it
  already is at contract v7) and a per-platform `raf -> task` measurement, which the current
  `presentationFloor` does not provide. That is a harness change, not a renderer change, and it
  must be pre-registered before it is used for admission.
- The `20%` target and the v6/v7 artifacts stay unchanged until a v8 schema is accepted.
- If a future candidate regresses `commit` interval or the two-frame share, that is the signal to
  optimize. Until then the framework is not the bottleneck on this workload.

## Metric check on the two completed gate runs

Both proposed metrics were recomputed from the raw records before being written here, and the
first form of the guard did not survive that check.

Primary (median per-sample commit union, `max` over the commits the sample claims) is computed
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
Where both sides exist, Zeus spends `2.0-2.6ms` per sample against WorkbenchTable's
`5.6-25.0ms`, a `2.2x`-`12.5x` difference. This is the quantity the framework can move, and it
is the opposite sign of the current gate: the gate compares `scrollP95Ms`, where Zeus already has
the better median.

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

`Proposed` is ready for product review. It is not an implementation contract, not a sampling
authorization, and not a performance Go.
