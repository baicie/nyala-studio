import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
	createSqlResultGridFeasibilityProfile,
	SQL_RESULT_GRID_PRESENTATION_FLOOR_SAMPLE_COUNT
} from './profile-sql-result-grid-feasibility.mjs';

const MEASUREMENT_CONTRACT_VERSION = 6;
const SCROLL_COMMIT_BOUNDARY = 'post-presentation-opportunity';
const EXECUTION_ORDER = 'renderer-balanced-rotation-v1';
const WORKLOAD = Object.freeze({
	id: '10k-x-50',
	rows: 10_000,
	columns: 50,
	wide: false,
	viewportWidth: 1_440,
	viewportHeight: 420
});
const BALANCED_PLAN = Object.freeze([
	{ renderer: 'workbench-table', iteration: 1, executionOrdinal: 1 },
	{ renderer: 'zeus', iteration: 1, executionOrdinal: 2 },
	{ renderer: 'zeus', iteration: 2, executionOrdinal: 3 },
	{ renderer: 'workbench-table', iteration: 2, executionOrdinal: 4 },
	{ renderer: 'workbench-table', iteration: 3, executionOrdinal: 5 },
	{ renderer: 'zeus', iteration: 3, executionOrdinal: 6 }
]);

test('classifies a required Zeus target below the shared presentation floor as floor-limited', () => {
	const report = createSyntheticReport({
		workbenchP95Ms: [19, 20, 21],
		zeusP95Ms: [18, 19, 20],
		presentationFloorP95Ms: [15, 16, 17, 17, 18, 19]
	});

	const profile = createSqlResultGridFeasibilityProfile(report);

	assert.equal(profile.version, 1);
	assert.equal(profile.conclusion, 'PRESENTATION_FLOOR_LIMITED');
	assert.equal(profile.baselineRenderer, 'workbench-table');
	assert.equal(profile.baselineP95Ms, 20);
	assert.equal(profile.zeusP95Ms, 19);
	assert.equal(profile.requiredZeusP95Ms, 16);
	assert.equal(profile.sharedPresentationFloorP95Ms, 17);
	assert.equal(profile.observedImprovement, 0.05);
	assert.equal(profile.minimumRequiredImprovement, 0.2);
});

test('classifies an unmet threshold above the shared presentation floor as renderer-limited', () => {
	const report = createSyntheticReport({
		workbenchP95Ms: [19, 20, 21],
		zeusP95Ms: [17, 18, 19],
		presentationFloorP95Ms: [13, 14, 15, 15, 16, 17]
	});

	const profile = createSqlResultGridFeasibilityProfile(report);

	assert.equal(profile.conclusion, 'RENDERER_LIMITED');
	assert.equal(profile.baselineP95Ms, 20);
	assert.equal(profile.zeusP95Ms, 18);
	assert.equal(profile.requiredZeusP95Ms, 16);
	assert.equal(profile.sharedPresentationFloorP95Ms, 15);
	assert.equal(profile.observedImprovement, 0.1);
});

test('classifies Zeus at the exact twenty percent threshold as threshold met', () => {
	const report = createSyntheticReport({
		workbenchP95Ms: [19, 20, 21],
		zeusP95Ms: [15, 16, 17],
		presentationFloorP95Ms: [13, 14, 15, 15, 16, 17]
	});

	const profile = createSqlResultGridFeasibilityProfile(report);

	assert.equal(profile.conclusion, 'THRESHOLD_MET');
	assert.equal(profile.baselineP95Ms, 20);
	assert.equal(profile.zeusP95Ms, 16);
	assert.equal(profile.requiredZeusP95Ms, 16);
	assert.equal(profile.sharedPresentationFloorP95Ms, 15);
	assert.equal(profile.observedImprovement, 0.2);
});

test('rejects missing and non-v6 benchmark evidence', () => {
	assert.throws(() => createSqlResultGridFeasibilityProfile(), /benchmark report/i);

	const staleReport = createSyntheticReport();
	staleReport.measurementContractVersion = 5;
	assert.throws(() => createSqlResultGridFeasibilityProfile(staleReport), /measurement contract.*6/i);

	const staleRecord = createSyntheticReport();
	staleRecord.records[0].measurementContractVersion = 5;
	assert.throws(() => createSqlResultGridFeasibilityProfile(staleRecord), /measurement contract.*6/i);
});

test('rejects missing or stale diagnostic-profile metadata', () => {
	const missingProfile = createSyntheticReport();
	delete missingProfile.diagnosticProfile;
	assert.throws(() => createSqlResultGridFeasibilityProfile(missingProfile), /diagnostic profile/i);

	const staleProfile = createSyntheticReport();
	staleProfile.diagnosticProfile.version = 0;
	assert.throws(() => createSqlResultGridFeasibilityProfile(staleProfile), /diagnostic profile.*version/i);

	const wrongSampleCount = createSyntheticReport();
	wrongSampleCount.diagnosticProfile.presentationFloorSampleCount = 19;
	assert.throws(() => createSqlResultGridFeasibilityProfile(wrongSampleCount), /diagnostic profile.*sample count/i);
});

test('rejects v6 records with the wrong completion boundary, execution order, or ordinal', () => {
	const wrongReportBoundary = createSyntheticReport();
	wrongReportBoundary.scrollCommitBoundary = 'animation-frame';
	assert.throws(() => createSqlResultGridFeasibilityProfile(wrongReportBoundary), /scroll commit boundary/i);

	const wrongRecordBoundary = createSyntheticReport();
	wrongRecordBoundary.records[0].scrollCommitBoundary = 'animation-frame';
	assert.throws(() => createSqlResultGridFeasibilityProfile(wrongRecordBoundary), /scroll commit boundary/i);

	const wrongReportOrder = createSyntheticReport();
	wrongReportOrder.executionOrder = 'renderer-grouped';
	assert.throws(() => createSqlResultGridFeasibilityProfile(wrongReportOrder), /execution order/i);

	const wrongRecordOrder = createSyntheticReport();
	wrongRecordOrder.records[0].executionOrder = 'renderer-grouped';
	assert.throws(() => createSqlResultGridFeasibilityProfile(wrongRecordOrder), /execution order/i);

	const wrongOrdinal = createSyntheticReport();
	wrongOrdinal.records[1].executionOrdinal = 99;
	assert.throws(() => createSqlResultGridFeasibilityProfile(wrongOrdinal), /execution ordinal/i);
});

test('rejects missing or non-finite presentation-floor diagnostics', () => {
	const missingDiagnostics = createSyntheticReport();
	delete missingDiagnostics.records[0].diagnostics;
	assert.throws(() => createSqlResultGridFeasibilityProfile(missingDiagnostics), /presentation floor|diagnostic/i);

	const nonFiniteSample = createSyntheticReport();
	nonFiniteSample.records[0].diagnostics.presentationFloor.samples[0].totalMs = Number.NaN;
	assert.throws(() => createSqlResultGridFeasibilityProfile(nonFiniteSample), /presentation floor|diagnostic/i);
});

test('recomputes presentation-floor summaries and rejects every tampered aggregate', () => {
	for (const [field, value] of [
		['sampleCount', 4],
		['medianMs', 0],
		['p95Ms', 0],
		['maxMs', 0]
	]) {
		const report = createSyntheticReport();
		report.records[0].diagnostics.presentationFloor[field] = value;

		assert.throws(
			() => createSqlResultGridFeasibilityProfile(report),
			/presentation floor|diagnostic/i,
			`${field} must be recomputed from raw presentation-floor samples`
		);
	}
});

test('rejects presentation-floor samples whose zero-based indexes are not contiguous', () => {
	const report = createSyntheticReport();
	report.records[0].diagnostics.presentationFloor.samples[1].sampleIndex = 0;

	assert.throws(() => createSqlResultGridFeasibilityProfile(report), /sample index/i);
});

test('requires twenty presentation-floor samples per record', () => {
	assert.equal(SQL_RESULT_GRID_PRESENTATION_FLOOR_SAMPLE_COUNT, 20);
	const report = createSyntheticReport();
	report.records[0].diagnostics.presentationFloor.samples.pop();
	report.records[0].diagnostics.presentationFloor.sampleCount -= 1;

	assert.throws(() => createSqlResultGridFeasibilityProfile(report), /exactly 20 presentation floor samples/i);
});

test('does not mutate the input benchmark report', () => {
	const report = createSyntheticReport();
	const snapshot = structuredClone(report);

	createSqlResultGridFeasibilityProfile(report);

	assert.deepEqual(report, snapshot);
});

test('checked-in feasibility evidence recomputes from its raw records and floor samples', async () => {
	const report = JSON.parse(
		await readFile(new URL('../docs/sql-mvp-phases/phase-z1-feasibility-profile.json', import.meta.url), 'utf8')
	);
	const recomputed = createSqlResultGridFeasibilityProfile(report);

	assert.deepEqual(recomputed, report.feasibilityProfile);
	assert.equal(report.records.length, 12);
	assert.equal(report.records.flatMap(record => record.scroll.samples).length, 240);
	assert.equal(report.records.flatMap(record => record.diagnostics.presentationFloor.samples).length, 240);
	assert.ok(report.records.every(record => record.scroll.samples.every(sample => sample.committed)));
});

function createSyntheticReport(options = {}) {
	const workbenchP95Ms = options.workbenchP95Ms ?? [19, 20, 21];
	const zeusP95Ms = options.zeusP95Ms ?? [17, 18, 19];
	const presentationFloorP95Ms = options.presentationFloorP95Ms ?? [13, 14, 15, 15, 16, 17];
	const rendererIndex = new Map([
		['workbench-table', 0],
		['zeus', 0]
	]);
	const records = BALANCED_PLAN.map(planEntry => {
		const metricIndex = rendererIndex.get(planEntry.renderer);
		rendererIndex.set(planEntry.renderer, metricIndex + 1);
		const scrollP95Ms = planEntry.renderer === 'workbench-table' ? workbenchP95Ms[metricIndex] : zeusP95Ms[metricIndex];
		return createSyntheticRecord(planEntry, scrollP95Ms, presentationFloorP95Ms[planEntry.executionOrdinal - 1]);
	});

	return {
		version: 1,
		measurementContractVersion: MEASUREMENT_CONTRACT_VERSION,
		scrollCommitBoundary: SCROLL_COMMIT_BOUNDARY,
		executionOrder: EXECUTION_ORDER,
		diagnosticProfile: {
			version: 1,
			presentationFloorSampleCount: SQL_RESULT_GRID_PRESENTATION_FLOOR_SAMPLE_COUNT
		},
		repeat: 3,
		workloads: [
			{
				id: WORKLOAD.id,
				rows: WORKLOAD.rows,
				columns: WORKLOAD.columns,
				width: WORKLOAD.viewportWidth,
				height: WORKLOAD.viewportHeight,
				wide: WORKLOAD.wide
			}
		],
		renderers: ['workbench-table', 'zeus'],
		records
	};
}

function createSyntheticRecord(planEntry, scrollP95Ms, presentationFloorP95Ms) {
	return {
		status: 'ok',
		runToken: `synthetic-${planEntry.executionOrdinal}`,
		renderer: planEntry.renderer,
		measurementContractVersion: MEASUREMENT_CONTRACT_VERSION,
		scrollCommitBoundary: SCROLL_COMMIT_BOUNDARY,
		executionOrder: EXECUTION_ORDER,
		executionOrdinal: planEntry.executionOrdinal,
		workloadId: WORKLOAD.id,
		workload: {
			rows: WORKLOAD.rows,
			columns: WORKLOAD.columns,
			wide: WORKLOAD.wide,
			viewportWidth: WORKLOAD.viewportWidth,
			viewportHeight: WORKLOAD.viewportHeight
		},
		iteration: planEntry.iteration,
		scroll: { p95Ms: scrollP95Ms },
		diagnostics: {
			presentationFloor: createPresentationFloorDiagnostics(presentationFloorP95Ms)
		}
	};
}

function createPresentationFloorDiagnostics(p95Ms) {
	const samples = Array.from({ length: 20 }, (_, sampleIndex) => ({
		sampleIndex,
		totalMs: sampleIndex < 11 ? p95Ms - 2 : sampleIndex < 18 ? p95Ms - 1 : p95Ms
	}));
	return {
		sampleCount: samples.length,
		medianMs: p95Ms - 2,
		p95Ms,
		maxMs: p95Ms,
		samples
	};
}
