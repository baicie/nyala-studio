import {
	EXECUTION_ORDER,
	MEASUREMENT_CONTRACT_VERSION,
	SCROLL_COMMIT_BOUNDARY
} from './sql-result-grid-benchmark-contract.mjs';

export const SQL_RESULT_GRID_FRAME_AWARE_PROFILE_VERSION = 2;

export const SQL_RESULT_GRID_FRAME_AWARE_LIMITATIONS = Object.freeze([
	'Frame-aware metrics are diagnostic only and cannot rewrite v6 or v7 admission evidence or flip the Z1 gate.',
	'Renderer work and host frame excess are reported separately; neither substitutes for the registered scrollP95Ms admission metric.',
	'Each renderer hostIntervalMs is its median nextPaintTaskTime - nextPaintRafTime on the diagnostic trace; missing traces provide no interval.',
	'WorkbenchTable commit unions and Zeus commit spans come from different collectors, so their ratio is a shape indicator, not an admission metric.',
	'Commit spans are elapsed wall time, including any synchronous style or layout work they trigger; they are not pure JavaScript CPU time. WorkbenchTable includes range calculation and row-width reads inside render, while Zeus starts its commit span after range calculation.',
	'WebDriver segment traces come from a separate diagnostic navigation. Matching sampleIndex values identify target positions, not the same scroll execution; hostExcess combines primary totals with a trace median and cannot establish per-sample causality.',
	'The rAF-to-task span includes the visibility probe, possible pending style/layout and rendering, and timer scheduling. It is not a renderer-independent host floor, so subtracting it does not isolate renderer-owned latency.',
	'This profile compares Zeus with WorkbenchTable only; native has no collected commit interval and is not a measured renderer-work baseline.',
	'The renderers can perform different DOM work, including Zeus column virtualization versus WorkbenchTable full-column rendering; commit ratios do not isolate core signal or compiler performance.',
	'Missing scroll samples or trace commit intervals are reflected in the per-renderer sample counts, never imputed.'
]);

export function createSqlResultGridFrameAwareProfile(report, options = {}) {
	validateFrameAwareReport(report);
	const workloadIds =
		Array.isArray(options.workloadIds) && options.workloadIds.length > 0
			? [...new Set(options.workloadIds)]
			: [...new Set(report.records.map(record => record.workloadId))];
	const workloads = workloadIds.map(workloadId => createWorkloadProfile(report, workloadId));
	return {
		version: SQL_RESULT_GRID_FRAME_AWARE_PROFILE_VERSION,
		measurementContractVersion: report.measurementContractVersion,
		scrollCommitBoundary: report.scrollCommitBoundary,
		executionOrder: report.executionOrder,
		workloads,
		limitations: [...(report.limitations ?? []), ...SQL_RESULT_GRID_FRAME_AWARE_LIMITATIONS]
	};
}

function createWorkloadProfile(report, workloadId) {
	const records = report.records.filter(record => record.workloadId === workloadId);
	const renderers = ['zeus', 'workbench-table']
		.map(renderer =>
			createRendererProfile(
				records.filter(record => record.renderer === renderer),
				renderer
			)
		)
		.filter(profile => profile !== undefined);
	return { workloadId, renderers };
}

function createRendererProfile(records, renderer) {
	if (records.length === 0) {
		return undefined;
	}
	const scrolls = [];
	const commitUnions = [];
	const hostIntervals = [];
	for (const record of records) {
		if (record.status !== 'ok') {
			throw new Error(`${record.workloadId}/${renderer}/${record.iteration} benchmark record is not ok.`);
		}
		const samples = record.scroll?.samples;
		if (!Array.isArray(samples) || samples.length === 0) {
			continue;
		}
		for (const sample of samples) {
			if (Number.isFinite(sample.totalMs)) {
				scrolls.push(sample.totalMs);
			}
		}
		const commits = collectCommitUnions(record, renderer);
		commitUnions.push(...commits);
		hostIntervals.push(...collectHostIntervals(record));
	}
	const hostIntervalMedian = hostIntervals.length > 0 ? median(hostIntervals) : null;
	return {
		renderer,
		recordCount: records.length,
		scrollSampleCount: scrolls.length,
		commitSampleCount: commitUnions.length,
		rendererWork: summarizeMetric(commitUnions),
		scrollTotal: summarizeMetric(scrolls),
		hostIntervalMs: hostIntervalMedian,
		hostExcess:
			hostIntervalMedian === null || scrolls.length === 0
				? { available: false, reason: 'No segment trace on this renderer records.' }
				: { available: true, p95ExcessMs: nearestRank(scrolls, 0.95) - hostIntervalMedian }
	};
}

function collectCommitUnions(record, renderer) {
	const trace = record.segmentTrace;
	if (!trace || typeof trace !== 'object' || !Array.isArray(trace.segments)) {
		return [];
	}
	const diagnostics = trace.diagnostics;
	if (!diagnostics || !Array.isArray(diagnostics.commits)) {
		return [];
	}
	const byId = new Map(diagnostics.commits.map(commit => [commit.transactionId, commit]));
	const widths = [];
	for (const segment of trace.segments) {
		if (segment?.phase !== 'sample') {
			continue;
		}
		const intervals = [];
		for (const id of segment.commitTransactionIds ?? []) {
			const commit = byId.get(id);
			if (renderer === 'zeus') {
				if (
					Number.isFinite(commit?.commitStartTime) &&
					Number.isFinite(commit?.commitEndTime) &&
					commit.commitEndTime >= commit.commitStartTime
				) {
					intervals.push([commit.commitStartTime, commit.commitEndTime]);
				}
			} else if (Array.isArray(commit?.commitIntervals)) {
				intervals.push(...commit.commitIntervals);
			}
		}
		if (intervals.length > 0) {
			// Count all commits, merge overlaps, and exclude time between commits.
			widths.push(unionMs(intervals));
		}
	}
	return widths;
}

function collectHostIntervals(record) {
	const trace = record.segmentTrace;
	if (!trace || typeof trace !== 'object' || !Array.isArray(trace.segments)) {
		return [];
	}
	const widths = [];
	for (const segment of trace.segments) {
		if (segment?.phase !== 'sample') {
			continue;
		}
		const rafTime = segment.nextPaintRafTime;
		const taskTime = segment.nextPaintTaskTime;
		if (Number.isFinite(rafTime) && Number.isFinite(taskTime) && taskTime >= rafTime) {
			widths.push(taskTime - rafTime);
		}
	}
	return widths;
}

function validateFrameAwareReport(report) {
	if (!report || typeof report !== 'object' || Array.isArray(report)) {
		throw new TypeError('A platform evidence object is required.');
	}
	if (report.measurementContractVersion !== MEASUREMENT_CONTRACT_VERSION) {
		throw new Error(`Evidence measurement contract must be version ${MEASUREMENT_CONTRACT_VERSION}.`);
	}
	if (report.scrollCommitBoundary !== SCROLL_COMMIT_BOUNDARY) {
		throw new Error(`Evidence scroll commit boundary must be ${SCROLL_COMMIT_BOUNDARY}.`);
	}
	if (report.executionOrder !== EXECUTION_ORDER) {
		throw new Error(`Evidence execution order must be ${EXECUTION_ORDER}.`);
	}
	if (!Array.isArray(report.records) || report.records.length === 0) {
		throw new Error('Evidence records are missing.');
	}
}

export function unionMs(intervals) {
	const spans = intervals
		.filter(interval => Array.isArray(interval) && interval.length >= 2)
		.map(interval => [interval[0], interval[1]])
		.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start)
		.sort((left, right) => left[0] - right[0]);
	if (spans.length === 0) {
		return 0;
	}
	let total = 0;
	let currentStart = spans[0][0];
	let currentEnd = spans[0][1];
	for (const [start, end] of spans.slice(1)) {
		if (start > currentEnd) {
			total += currentEnd - currentStart;
			currentStart = start;
			currentEnd = end;
		} else if (end > currentEnd) {
			currentEnd = end;
		}
	}
	return total + (currentEnd - currentStart);
}

export function nearestRank(values, quantile) {
	if (values.length === 0) {
		return null;
	}
	const sorted = [...values].sort((left, right) => left - right);
	const rank = Math.ceil(sorted.length * quantile) - 1;
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

export function median(values) {
	if (values.length === 0) {
		return null;
	}
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function summarizeMetric(values) {
	if (values.length === 0) {
		return { available: false, reason: 'No samples were captured for this renderer.' };
	}
	return {
		available: true,
		count: values.length,
		medianMs: median(values),
		p95Ms: nearestRank(values, 0.95)
	};
}
