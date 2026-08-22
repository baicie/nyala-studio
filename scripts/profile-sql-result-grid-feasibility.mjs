import {
	createBalancedBenchmarkPlan,
	EXECUTION_ORDER,
	MEASUREMENT_CONTRACT_VERSION,
	SCROLL_COMMIT_BOUNDARY,
	SCROLL_TIMING_TOLERANCE_MS
} from './sql-result-grid-benchmark-contract.mjs';

export const SQL_RESULT_GRID_FEASIBILITY_PROFILE_VERSION = 1;
export const SQL_RESULT_GRID_PRESENTATION_FLOOR_SAMPLE_COUNT = 20;
export const SQL_RESULT_GRID_TEN_K_MINIMUM_IMPROVEMENT = 0.2;

const supportedConclusions = Object.freeze({
	thresholdMet: 'THRESHOLD_MET',
	presentationFloorLimited: 'PRESENTATION_FLOOR_LIMITED',
	rendererLimited: 'RENDERER_LIMITED'
});

export function createSqlResultGridFeasibilityProfile(report) {
	validateReport(report);
	const records = validateRecords(report);
	const tenKRecords = records.filter(record => record.workloadId === '10k-x-50');
	const rendererMetrics = summarizeRendererMetrics(tenKRecords);
	const baseline = selectBaseline(rendererMetrics);
	const zeusP95Ms = rendererMetrics.zeus?.scrollP95Ms;
	if (!Number.isFinite(zeusP95Ms)) {
		throw new Error('10k-x-50 Zeus scroll p95 benchmark evidence is missing.');
	}

	const requiredZeusP95Ms = baseline.scrollP95Ms * (1 - SQL_RESULT_GRID_TEN_K_MINIMUM_IMPROVEMENT);
	const observedImprovement = (baseline.scrollP95Ms - zeusP95Ms) / baseline.scrollP95Ms;
	const sharedPresentationFloorP95Ms = median(tenKRecords.map(record => validatePresentationFloor(record).p95));
	const thresholdMet = observedImprovement >= SQL_RESULT_GRID_TEN_K_MINIMUM_IMPROVEMENT;
	const floorLimited = !thresholdMet && requiredZeusP95Ms + SCROLL_TIMING_TOLERANCE_MS < sharedPresentationFloorP95Ms;

	return {
		version: SQL_RESULT_GRID_FEASIBILITY_PROFILE_VERSION,
		measurementContractVersion: MEASUREMENT_CONTRACT_VERSION,
		scrollCommitBoundary: SCROLL_COMMIT_BOUNDARY,
		executionOrder: EXECUTION_ORDER,
		conclusion: thresholdMet
			? supportedConclusions.thresholdMet
			: floorLimited
				? supportedConclusions.presentationFloorLimited
				: supportedConclusions.rendererLimited,
		baselineRenderer: baseline.renderer,
		baselineP95Ms: baseline.scrollP95Ms,
		zeusP95Ms,
		requiredZeusP95Ms,
		minimumRequiredImprovement: SQL_RESULT_GRID_TEN_K_MINIMUM_IMPROVEMENT,
		sharedPresentationFloorP95Ms,
		observedImprovement,
		maximumFloorBoundedImprovement: Math.max(
			0,
			(baseline.scrollP95Ms - sharedPresentationFloorP95Ms) / baseline.scrollP95Ms
		),
		tenKRecordCount: tenKRecords.length,
		renderers: rendererMetrics
	};
}

function validateReport(report) {
	if (!report || typeof report !== 'object' || Array.isArray(report)) {
		throw new TypeError('A benchmark report object is required.');
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
	if (report.diagnosticProfile.version !== SQL_RESULT_GRID_FEASIBILITY_PROFILE_VERSION) {
		throw new Error(`Benchmark diagnostic profile version must be ${SQL_RESULT_GRID_FEASIBILITY_PROFILE_VERSION}.`);
	}
	if (report.diagnosticProfile.presentationFloorSampleCount !== SQL_RESULT_GRID_PRESENTATION_FLOOR_SAMPLE_COUNT) {
		throw new Error(
			`Benchmark diagnostic profile sample count must be ${SQL_RESULT_GRID_PRESENTATION_FLOOR_SAMPLE_COUNT}.`
		);
	}
	if (!Number.isInteger(report.repeat) || report.repeat < 3) {
		throw new Error('Benchmark repeat must be an integer of at least three.');
	}
	if (!Array.isArray(report.workloads) || report.workloads.length === 0) {
		throw new Error('Benchmark workloads are missing.');
	}
	if (!Array.isArray(report.renderers) || !report.renderers.includes('zeus')) {
		throw new Error('Benchmark renderers must include Zeus.');
	}
	if (!report.renderers.some(renderer => renderer !== 'zeus')) {
		throw new Error('Benchmark renderers must include a non-Zeus baseline.');
	}
	if (!Array.isArray(report.records)) {
		throw new Error('Benchmark records are missing.');
	}
}

function validateRecords(report) {
	const plan = createBalancedBenchmarkPlan(report.workloads, report.renderers, report.repeat);
	if (report.records.length !== plan.length) {
		throw new Error(`Benchmark record count is ${report.records.length}; expected ${plan.length}.`);
	}

	for (let index = 0; index < plan.length; index += 1) {
		const expected = plan[index];
		const record = report.records[index];
		const tuple = `${expected.workload.id}/${expected.renderer}/${expected.iteration}`;
		if (!record || typeof record !== 'object' || record.status !== 'ok') {
			throw new Error(`${tuple} benchmark record is missing or not ok.`);
		}
		if (record.measurementContractVersion !== MEASUREMENT_CONTRACT_VERSION) {
			throw new Error(`${tuple} measurement contract must be version ${MEASUREMENT_CONTRACT_VERSION}.`);
		}
		if (record.scrollCommitBoundary !== SCROLL_COMMIT_BOUNDARY) {
			throw new Error(`${tuple} scroll commit boundary must be ${SCROLL_COMMIT_BOUNDARY}.`);
		}
		if (record.executionOrder !== EXECUTION_ORDER) {
			throw new Error(`${tuple} execution order must be ${EXECUTION_ORDER}.`);
		}
		if (record.executionOrdinal !== expected.executionOrdinal) {
			throw new Error(`${tuple} execution ordinal must be ${expected.executionOrdinal}.`);
		}
		if (
			record.workloadId !== expected.workload.id ||
			record.renderer !== expected.renderer ||
			record.iteration !== expected.iteration
		) {
			throw new Error(`${tuple} does not match the balanced execution plan.`);
		}
		if (!Number.isFinite(record.scroll?.p95Ms) || record.scroll.p95Ms < 0) {
			throw new Error(`${tuple} scroll p95 metric is invalid.`);
		}
		validatePresentationFloor(record);
	}

	return report.records;
}

function validatePresentationFloor(record) {
	const floor = record.diagnostics?.presentationFloor;
	const tuple = `${record.workloadId}/${record.renderer}/${record.iteration}`;
	if (!floor || !Array.isArray(floor.samples) || floor.samples.length === 0) {
		throw new Error(`${tuple} presentation floor diagnostics are missing.`);
	}
	if (floor.samples.length !== SQL_RESULT_GRID_PRESENTATION_FLOOR_SAMPLE_COUNT) {
		throw new Error(
			`${tuple} must include exactly ${SQL_RESULT_GRID_PRESENTATION_FLOOR_SAMPLE_COUNT} presentation floor samples.`
		);
	}
	if (floor.sampleCount !== floor.samples.length) {
		throw new Error(`${tuple} presentation floor sample count is invalid.`);
	}
	const values = floor.samples.map((sample, sampleIndex) => {
		if (sample?.sampleIndex !== sampleIndex) {
			throw new Error(`${tuple} presentation floor sample index ${sampleIndex} is invalid.`);
		}
		if (!Number.isFinite(sample.totalMs) || sample.totalMs < 0) {
			throw new Error(`${tuple} presentation floor diagnostic sample ${sampleIndex} is invalid.`);
		}
		return sample.totalMs;
	});
	const summary = summarize(values);
	for (const [field, expected] of [
		['medianMs', summary.median],
		['p95Ms', summary.p95],
		['maxMs', summary.max]
	]) {
		if (!approximatelyEqual(floor[field], expected)) {
			throw new Error(`${tuple} presentation floor ${field} does not match raw samples.`);
		}
	}
	return summary;
}

function summarizeRendererMetrics(records) {
	const groups = new Map();
	for (const record of records) {
		const group = groups.get(record.renderer) ?? [];
		group.push(record);
		groups.set(record.renderer, group);
	}
	if (!groups.has('zeus')) {
		throw new Error('10k-x-50 Zeus benchmark records are missing.');
	}
	if (![...groups.keys()].some(renderer => renderer !== 'zeus')) {
		throw new Error('10k-x-50 non-Zeus baseline records are missing.');
	}
	return Object.fromEntries(
		[...groups.entries()].map(([renderer, group]) => [
			renderer,
			{
				count: group.length,
				scrollP95Ms: median(group.map(record => record.scroll.p95Ms)),
				presentationFloorP95Ms: median(group.map(record => validatePresentationFloor(record).p95))
			}
		])
	);
}

function selectBaseline(rendererMetrics) {
	const candidates = Object.entries(rendererMetrics)
		.filter(([renderer]) => renderer !== 'zeus')
		.map(([renderer, metrics]) => ({ renderer, scrollP95Ms: metrics.scrollP95Ms }))
		.filter(candidate => Number.isFinite(candidate.scrollP95Ms) && candidate.scrollP95Ms > 0)
		.sort((left, right) => left.scrollP95Ms - right.scrollP95Ms || left.renderer.localeCompare(right.renderer));
	if (candidates.length === 0) {
		throw new Error('10k-x-50 non-Zeus baseline metric is unavailable.');
	}
	return candidates[0];
}

function summarize(values) {
	const sorted = [...values].sort((left, right) => left - right);
	return {
		median: sorted[Math.floor(sorted.length / 2)] ?? 0,
		p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
		max: sorted.at(-1) ?? 0
	};
}

function median(values) {
	if (values.length === 0) throw new Error('Cannot compute a median from an empty metric set.');
	return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
}

function approximatelyEqual(left, right) {
	return Number.isFinite(left) && Math.abs(left - right) <= SCROLL_TIMING_TOLERANCE_MS;
}
