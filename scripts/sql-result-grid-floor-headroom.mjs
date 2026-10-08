import {
	createSqlResultGridFeasibilityProfile,
	SQL_RESULT_GRID_TEN_K_MINIMUM_IMPROVEMENT
} from './profile-sql-result-grid-feasibility.mjs';
import {
	EXECUTION_ORDER,
	MEASUREMENT_CONTRACT_VERSION,
	SCROLL_COMMIT_BOUNDARY,
	SCROLL_TIMING_TOLERANCE_MS
} from './sql-result-grid-benchmark-contract.mjs';
import { validateZeusDataGridDiagnosticSnapshot } from './sql-result-grid-zeus-diagnostics.mjs';
import { validateWorkbenchTableDiagnosticSnapshot } from './sql-result-grid-workbench-table-diagnostics.mjs';

export const SQL_RESULT_GRID_FLOOR_HEADROOM_VERSION = 1;

export const SQL_RESULT_GRID_WORKLOAD_CPU_RATIO_PROFILE_VERSION = 1;

export const SQL_RESULT_GRID_FLOOR_HEADROOM_LIMITATIONS = Object.freeze([
	'Floor headroom is diagnostic only and cannot rewrite v6 admission evidence.',
	'Zeus renderer intervals come from the diagnostic sidecar; enabling it adds observer overhead, so the union is an upper bound for production pool cost.',
	'WorkbenchTable renderer intervals come from a ListView prototype wrapper whose scroll handler window encloses the render call; only the interval union is definition-comparable with the Zeus commit timing.',
	'Renderer interval union is measured on scroll commits of the diagnostic profile only; it is not an admission metric.',
	'The renderer CPU ratio compares interval unions measured under two different instrumentation overheads; it is a diagnostic shape indicator, not an admission metric.',
	'Chromium headless numbers are not macOS WKWebView or Windows WebView2 evidence.'
]);

export const SQL_RESULT_GRID_WORKLOAD_CPU_RATIO_LIMITATIONS = Object.freeze([
	'Workload CPU ratio is a single-run diagnostic point estimate; the proposed v7 thresholds are registered on paired-bootstrap confidence bounds, which this profile does not compute.',
	'Workload CPU ratio is diagnostic only and cannot rewrite v6 admission evidence, flip the Z1 gate, or serve as v7 admission evidence.',
	'The ratio compares interval unions measured under two different instrumentation overheads; it is a diagnostic shape indicator, not an admission metric.',
	'Chromium headless numbers are not macOS WKWebView or Windows WebView2 evidence.'
]);

/**
 * Decompose the recorded v6 ten-k scroll metric into the shared presentation
 * floor, the renderer-owned interval union, and the floor-bounded improvement
 * that any renderer could reach on the same evidence set.
 *
 * @param {object} report a diagnostic-profile benchmark report that already
 *   satisfies the v6 feasibility contract.
 */
export function createSqlResultGridFloorHeadroomProfile(report) {
	const feasibility = createSqlResultGridFeasibilityProfile(report);
	const records = report.records.filter(record => record.workloadId === '10k-x-50');
	const zeusRecords = records.filter(record => record.renderer === 'zeus');
	const workbenchTableRecords = records.filter(record => record.renderer === 'workbench-table');
	const floorP95ByRecord = records.map(record => ({
		renderer: record.renderer,
		iteration: record.iteration,
		p95Ms: record.diagnostics.presentationFloor.p95Ms
	}));
	const mostOptimisticFloorP95Ms = Math.min(...floorP95ByRecord.map(entry => entry.p95Ms));
	const baselineP95Ms = feasibility.baselineP95Ms;
	const requiredZeusP95Ms = feasibility.requiredZeusP95Ms;
	const maximumFloorBoundedImprovementAtMostOptimisticFloor = Math.max(
		0,
		(baselineP95Ms - mostOptimisticFloorP95Ms) / baselineP95Ms
	);
	const zeusRendererIntervals = summarizeZeusRendererIntervals(zeusRecords);
	const workbenchTableRendererIntervals = summarizeWorkbenchTableRendererIntervals(workbenchTableRecords);

	return {
		version: SQL_RESULT_GRID_FLOOR_HEADROOM_VERSION,
		measurementContractVersion: report.measurementContractVersion,
		scrollCommitBoundary: report.scrollCommitBoundary,
		executionOrder: report.executionOrder,
		diagnosticProfile: {
			version: report.diagnosticProfile?.version ?? null,
			presentationFloorSampleCount: report.diagnosticProfile?.presentationFloorSampleCount ?? null,
			zeusMeasureNodeChurn: report.diagnosticProfile?.zeusDataGridDiagnostics?.measureNodeChurn ?? null,
			workbenchTableInstrumentation: report.diagnosticProfile?.workbenchTableDiagnostics?.instrumentation ?? null
		},
		baselineRenderer: feasibility.baselineRenderer,
		baselineP95Ms,
		zeusScrollP95Ms: feasibility.zeusP95Ms,
		requiredZeusP95Ms,
		requiredImprovement: SQL_RESULT_GRID_TEN_K_MINIMUM_IMPROVEMENT,
		sharedPresentationFloorP95Ms: feasibility.sharedPresentationFloorP95Ms,
		mostOptimisticFloorP95Ms,
		mostPessimisticFloorP95Ms: Math.max(...floorP95ByRecord.map(entry => entry.p95Ms)),
		requiredTargetHeadroomBelowFloorMs: feasibility.sharedPresentationFloorP95Ms - requiredZeusP95Ms,
		floorExceedsRequiredTargetWithinTolerance:
			requiredZeusP95Ms + SCROLL_TIMING_TOLERANCE_MS < feasibility.sharedPresentationFloorP95Ms,
		observedImprovement: feasibility.observedImprovement,
		maximumFloorBoundedImprovement: feasibility.maximumFloorBoundedImprovement,
		maximumFloorBoundedImprovementAtMostOptimisticFloor,
		floorBoundedSuperiorityReachable:
			maximumFloorBoundedImprovementAtMostOptimisticFloor >= SQL_RESULT_GRID_TEN_K_MINIMUM_IMPROVEMENT,
		feasibilityConclusion: feasibility.conclusion,
		recordFloorP95: floorP95ByRecord,
		scrollSamples: summarizeScrollSamples(records),
		zeusRendererIntervals,
		workbenchTableRendererIntervals,
		rendererCpuRatio: createRendererCpuRatio(zeusRendererIntervals, workbenchTableRendererIntervals),
		limitations: [...(report.limitations ?? []), ...SQL_RESULT_GRID_FLOOR_HEADROOM_LIMITATIONS]
	};
}

/**
 * Compute the workload-scoped renderer-owned CPU interval ratio
 * `Q95(Zeus union) / Q95(WorkbenchTable union)` from the symmetric diagnostic
 * sidecars, independent of the ten-k feasibility math. The proposed v7
 * Primary B threshold is registered for the 1k x 20 non-inferiority workload as
 * well, and those records carry no admission math of their own.
 *
 * @param {object} report a diagnostic-profile benchmark report.
 * @param {string} workloadId workload whose records must carry both sidecars.
 */
export function createSqlResultGridWorkloadCpuRatioProfile(report, workloadId) {
	validateCpuRatioReport(report, workloadId);
	const records = report.records.filter(record => record.workloadId === workloadId);
	const zeusRecords = records.filter(record => record.renderer === 'zeus');
	const workbenchTableRecords = records.filter(record => record.renderer === 'workbench-table');
	if (zeusRecords.length === 0) {
		throw new Error(`${workloadId} Zeus benchmark records are missing.`);
	}
	if (workbenchTableRecords.length === 0) {
		throw new Error(`${workloadId} WorkbenchTable benchmark records are missing.`);
	}
	for (const record of records) {
		if (record.status !== 'ok') {
			throw new Error(`${workloadId}/${record.renderer}/${record.iteration} benchmark record is not ok.`);
		}
		if (!Array.isArray(record.scroll?.samples) || record.scroll.samples.length === 0) {
			throw new Error(`${workloadId}/${record.renderer}/${record.iteration} scroll samples are missing.`);
		}
	}

	const zeusRendererIntervals = summarizeZeusRendererIntervals(zeusRecords);
	const workbenchTableRendererIntervals = summarizeWorkbenchTableRendererIntervals(workbenchTableRecords);
	return {
		version: SQL_RESULT_GRID_WORKLOAD_CPU_RATIO_PROFILE_VERSION,
		workloadId,
		measurementContractVersion: report.measurementContractVersion,
		scrollCommitBoundary: report.scrollCommitBoundary,
		executionOrder: report.executionOrder,
		recordCounts: {
			total: records.length,
			zeus: zeusRecords.length,
			workbenchTable: workbenchTableRecords.length
		},
		zeusRendererIntervals,
		workbenchTableRendererIntervals,
		rendererCpuRatio: createRendererCpuRatio(zeusRendererIntervals, workbenchTableRendererIntervals),
		limitations: [...(report.limitations ?? []), ...SQL_RESULT_GRID_WORKLOAD_CPU_RATIO_LIMITATIONS]
	};
}

function validateCpuRatioReport(report, workloadId) {
	if (!report || typeof report !== 'object' || Array.isArray(report)) {
		throw new TypeError('A benchmark report object is required.');
	}
	if (typeof workloadId !== 'string' || workloadId.length === 0) {
		throw new TypeError('A benchmark workload id is required.');
	}
	if (report.measurementContractVersion !== MEASUREMENT_CONTRACT_VERSION) {
		throw new Error(`Benchmark measurement contract must be version ${MEASUREMENT_CONTRACT_VERSION}.`);
	}
	if (report.scrollCommitBoundary !== SCROLL_COMMIT_BOUNDARY) {
		throw new Error(`Benchmark scroll commit boundary must be ${SCROLL_COMMIT_BOUNDARY}.`);
	}
	if (report.executionOrder !== EXECUTION_ORDER) {
		throw new Error(`Benchmark execution order must be ${EXECUTION_ORDER}.`);
	}
	if (!report.diagnosticProfile || typeof report.diagnosticProfile !== 'object') {
		throw new Error('Benchmark diagnostic profile metadata is missing.');
	}
	if (!Array.isArray(report.records) || report.records.length === 0) {
		throw new Error('Benchmark records are missing.');
	}
	if (!report.records.some(record => record?.workloadId === workloadId)) {
		throw new Error(`${workloadId} benchmark records are missing.`);
	}
}

function summarizeScrollSamples(records) {
	const buckets = new Map();
	for (const record of records) {
		const samples = record.scroll?.samples;
		if (!Array.isArray(samples) || samples.length === 0) {
			throw new Error(`${record.workloadId}/${record.renderer} scroll samples are missing.`);
		}
		const bucket = buckets.get(record.renderer) ?? {
			recordCount: 0,
			sampleCount: 0,
			waits: [],
			opportunities: new Map()
		};
		bucket.recordCount += 1;
		for (const sample of samples) {
			if (!Number.isSafeInteger(sample.presentationOpportunities) || sample.presentationOpportunities < 1) {
				throw new Error(
					`${record.workloadId}/${record.renderer} sample ${sample.sampleIndex} presentation opportunities are invalid.`
				);
			}
			if (!Number.isFinite(sample.presentationWaitMs) || sample.presentationWaitMs < 0) {
				throw new Error(
					`${record.workloadId}/${record.renderer} sample ${sample.sampleIndex} presentation wait is invalid.`
				);
			}
			bucket.sampleCount += 1;
			bucket.waits.push(sample.presentationWaitMs);
			bucket.opportunities.set(
				sample.presentationOpportunities,
				(bucket.opportunities.get(sample.presentationOpportunities) ?? 0) + 1
			);
		}
		buckets.set(record.renderer, bucket);
	}
	return Object.fromEntries(
		[...buckets.entries()].map(([renderer, bucket]) => {
			const histogram = Object.fromEntries(
				[...bucket.opportunities.entries()].sort((left, right) => left[0] - right[0])
			);
			const oneFrameSampleCount = bucket.opportunities.get(1) ?? 0;
			return [
				renderer,
				{
					recordCount: bucket.recordCount,
					sampleCount: bucket.sampleCount,
					presentationOpportunityHistogram: histogram,
					oneFrameSampleCount,
					oneFrameSampleRate: oneFrameSampleCount / bucket.sampleCount,
					presentationWaitMs: summarize(bucket.waits)
				}
			];
		})
	);
}

function summarizeZeusRendererIntervals(zeusRecords) {
	const instrumented = zeusRecords.filter(record => record.diagnostics?.zeusDataGrid !== undefined);
	if (instrumented.length === 0) {
		return {
			available: false,
			reason: 'Zeus data grid diagnostics are not part of this report; renderer interval union is unavailable.'
		};
	}
	if (instrumented.length !== zeusRecords.length) {
		throw new Error('Zeus data grid diagnostics must cover every Zeus record or none of them.');
	}

	const handler = [];
	const range = [];
	const commit = [];
	const layout = [];
	const union = [];
	const diagnosticsTail = [];
	for (const record of zeusRecords) {
		const samples = record.scroll.samples;
		const snapshot = validateZeusDataGridDiagnosticSnapshot(record.diagnostics.zeusDataGrid, {
			expectedSampleCount: samples.length,
			workload: record.workload,
			scrollSamples: samples
		});
		for (const sample of sampleCorrelatedCommits(snapshot)) {
			const intervals = {
				handler: [sample.handlerStartTime, sample.handlerEndTime],
				range: [sample.rangeStartTime, sample.rangeCalculatedTime],
				commit: [sample.commitStartTime, sample.commitEndTime]
			};
			handler.push(intervals.handler[1] - intervals.handler[0]);
			range.push(intervals.range[1] - intervals.range[0]);
			commit.push(intervals.commit[1] - intervals.commit[0]);
			layout.push(unionMs(sample.layoutReadIntervals));
			union.push(
				unionMs([
					intervals.handler,
					intervals.range,
					intervals.commit,
					...sample.layoutReadIntervals.map(interval => [interval[0], interval[1]])
				])
			);
			if (sample.diagnosticsEndTime !== undefined) {
				diagnosticsTail.push(sample.diagnosticsEndTime - sample.commitEndTime);
			}
		}
	}

	return {
		available: true,
		unit: 'scroll-commit',
		recordCount: zeusRecords.length,
		commitCount: union.length,
		unionMs: summarize(union),
		componentsMs: {
			handler: summarize(handler),
			range: summarize(range),
			commitPatch: summarize(commit),
			layoutRead: summarize(layout)
		},
		diagnosticsTailMs:
			diagnosticsTail.length === 0
				? { sampleCount: 0 }
				: {
						sampleCount: diagnosticsTail.length,
						...summarize(diagnosticsTail)
					}
	};
}

function summarizeWorkbenchTableRendererIntervals(workbenchTableRecords) {
	const instrumented = workbenchTableRecords.filter(record => record.diagnostics?.workbenchTable !== undefined);
	if (instrumented.length === 0) {
		return {
			available: false,
			reason: 'WorkbenchTable ListView diagnostics are not part of this report; renderer interval union is unavailable.'
		};
	}
	if (instrumented.length !== workbenchTableRecords.length) {
		throw new Error('WorkbenchTable diagnostics must cover every WorkbenchTable record or none of them.');
	}

	const handler = [];
	const range = [];
	const commit = [];
	const layout = [];
	const union = [];
	for (const record of workbenchTableRecords) {
		const samples = record.scroll.samples;
		const snapshot = validateWorkbenchTableDiagnosticSnapshot(record.diagnostics.workbenchTable, {
			expectedSampleCount: samples.length,
			workload: record.workload,
			scrollSamples: samples
		});
		for (const entry of sampleCorrelatedCommits(snapshot)) {
			const handlerInterval = [entry.handlerStartTime, entry.handlerEndTime];
			handler.push(handlerInterval[1] - handlerInterval[0]);
			range.push(unionMs(entry.rangeIntervals));
			commit.push(unionMs(entry.commitIntervals));
			layout.push(unionMs(entry.layoutReadIntervals));
			union.push(
				unionMs([
					handlerInterval,
					...entry.rangeIntervals.map(interval => [interval[0], interval[1]]),
					...entry.commitIntervals.map(interval => [interval[0], interval[1]]),
					...entry.layoutReadIntervals.map(interval => [interval[0], interval[1]])
				])
			);
		}
	}

	return {
		available: true,
		unit: 'scroll-commit',
		recordCount: workbenchTableRecords.length,
		commitCount: union.length,
		unionMs: summarize(union),
		componentsMs: {
			handler: summarize(handler),
			range: summarize(range),
			commitPatch: summarize(commit),
			layoutRead: summarize(layout)
		}
	};
}

/**
 * Restrict the interval summary to the commits that the sidecar itself claims
 * for `phase: 'sample'` scroll operations. Both renderers record one extra
 * preposition scroll commit that is not correlated to a measured sample; the
 * ratio must compare the same event set on both sides.
 */
function sampleCorrelatedCommits(snapshot) {
	const claimed = new Set();
	for (const operation of snapshot.scrollOperations) {
		if (operation.phase !== 'sample') continue;
		for (const transactionId of operation.commitTransactionIds) claimed.add(transactionId);
	}
	return snapshot.commits.filter(commit => claimed.has(commit.transactionId));
}

function createRendererCpuRatio(zeusRendererIntervals, workbenchTableRendererIntervals) {
	const zeusUnionP95Ms = zeusRendererIntervals.available ? zeusRendererIntervals.unionMs.p95 : null;
	const workbenchTableUnionP95Ms = workbenchTableRendererIntervals.available
		? workbenchTableRendererIntervals.unionMs.p95
		: null;
	const reasons = [];
	if (!zeusRendererIntervals.available) reasons.push(zeusRendererIntervals.reason);
	if (!workbenchTableRendererIntervals.available) reasons.push(workbenchTableRendererIntervals.reason);
	if (reasons.length > 0) {
		return {
			available: false,
			reason: reasons.join(' '),
			zeusUnionP95Ms,
			workbenchTableUnionP95Ms,
			ratio: null
		};
	}
	if (!(zeusUnionP95Ms > 0) || !(workbenchTableUnionP95Ms > 0)) {
		return {
			available: false,
			reason: 'Renderer interval unions are not positive; the CPU interval ratio is not computable.',
			zeusUnionP95Ms,
			workbenchTableUnionP95Ms,
			ratio: null
		};
	}
	return {
		available: true,
		definition: 'Q95(Zeus per-scroll-commit interval union) / Q95(WorkbenchTable per-scroll-commit interval union)',
		zeusUnionP95Ms,
		workbenchTableUnionP95Ms,
		ratio: zeusUnionP95Ms / workbenchTableUnionP95Ms
	};
}

function unionMs(intervals) {
	if (!Array.isArray(intervals) || intervals.length === 0) {
		return 0;
	}
	const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
	let total = 0;
	let [currentStart, currentEnd] = sorted[0];
	for (const [start, end] of sorted.slice(1)) {
		if (start <= currentEnd) {
			currentEnd = Math.max(currentEnd, end);
			continue;
		}
		total += currentEnd - currentStart;
		[currentStart, currentEnd] = [start, end];
	}
	return total + (currentEnd - currentStart);
}

function summarize(values) {
	if (values.length === 0) {
		return { count: 0 };
	}
	const sorted = [...values].sort((left, right) => left - right);
	return {
		count: sorted.length,
		median: sorted[Math.floor(sorted.length / 2)] ?? 0,
		p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
		max: sorted.at(-1) ?? 0
	};
}
