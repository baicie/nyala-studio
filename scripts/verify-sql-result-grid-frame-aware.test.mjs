import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createSqlResultGridFrameAwareProfile,
	median,
	nearestRank,
	unionMs
} from './sql-result-grid-frame-aware-profile.mjs';
import {
	createFrameAwareHostExcessReport,
	createFrameAwareSuperiorityVerdict,
	SQL_RESULT_GRID_FRAME_AWARE_OUTCOME,
	SQL_RESULT_GRID_FRAME_AWARE_TEN_K_MINIMUM_IMPROVEMENT
} from './sql-result-grid-frame-aware-verdict.mjs';

const BASE = {
	measurementContractVersion: 7,
	scrollCommitBoundary: 'post-presentation-opportunity',
	executionOrder: 'renderer-balanced-rotation-v1'
};

function segment(sampleIndex, transactionId, rafTime, taskTime) {
	return {
		phase: 'sample',
		sampleIndex,
		commitTransactionIds: [transactionId],
		nextPaintRafTime: rafTime,
		nextPaintTaskTime: taskTime
	};
}

function zeusRecord({ totals, commitMs = 2, rafToTask = 5 }) {
	let raf = 100;
	const segments = [];
	const commits = [];
	const samples = [];
	for (const [sampleIndex, totalMs] of totals.entries()) {
		const commitStart = raf - 1;
		segments.push(segment(sampleIndex, sampleIndex + 1, raf, raf + rafToTask));
		commits.push({
			transactionId: sampleIndex + 1,
			commitStartTime: commitStart,
			commitEndTime: commitStart + commitMs,
			layoutReadIntervals: []
		});
		samples.push({ sampleIndex, totalMs, committed: true });
		raf += 20;
	}
	return {
		...BASE,
		workloadId: '10k-x-50',
		renderer: 'zeus',
		iteration: 1,
		status: 'ok',
		workload: { rows: 10000, columns: 50 },
		scroll: { samples },
		segmentTrace: {
			version: 1,
			segments,
			diagnostics: { commits, version: 1 }
		}
	};
}

function workbenchTableRecord({ totals, rafToTask = 2 }) {
	const segments = [];
	const commits = [];
	const samples = totals.map((totalMs, sampleIndex) => {
		const start = 100 + sampleIndex * 20;
		segments.push(segment(sampleIndex, sampleIndex + 1, start, start + rafToTask));
		commits.push({
			transactionId: sampleIndex + 1,
			commitIntervals: [
				[start, start + 10],
				[start + 2, start + 6]
			],
			layoutReadIntervals: []
		});
		return { sampleIndex, totalMs, committed: true };
	});
	return {
		...BASE,
		workloadId: '10k-x-50',
		renderer: 'workbench-table',
		iteration: 1,
		status: 'ok',
		workload: { rows: 10000, columns: 50 },
		scroll: { samples },
		segmentTrace: {
			version: 1,
			segments,
			diagnostics: { commits, version: 1 }
		}
	};
}

test('frame-aware profile reports renderer work and host excess per workload', () => {
	const profile = createSqlResultGridFrameAwareProfile({
		...BASE,
		records: [zeusRecord({ totals: [15, 15, 30, 15] }), workbenchTableRecord({ totals: [18, 18, 18, 18] })]
	});
	const workload = profile.workloads[0];
	assert.equal(workload.workloadId, '10k-x-50');
	const zeus = workload.renderers.find(entry => entry.renderer === 'zeus');
	const wbt = workload.renderers.find(entry => entry.renderer === 'workbench-table');

	assert.equal(zeus.rendererWork.available, true);
	assert.equal(zeus.rendererWork.count, 4);
	assert.equal(zeus.rendererWork.medianMs, 2);
	assert.equal(zeus.hostIntervalMs, 5);
	// p95 of [15,15,15,30] is 30; the host excess is 30 - 5.
	assert.equal(zeus.hostExcess.p95ExcessMs, 25);

	// WorkbenchTable commits are interval unions: [100,110] swallows [102,106].
	assert.equal(wbt.rendererWork.medianMs, 10);
	assert.equal(wbt.hostIntervalMs, 2);
	assert.equal(wbt.hostExcess.p95ExcessMs, 16);
});

test('frame-aware profile reports a renderer without a trace as unavailable', () => {
	const record = zeusRecord({ totals: [15, 15] });
	delete record.segmentTrace;
	const profile = createSqlResultGridFrameAwareProfile({ ...BASE, records: [record] });
	const zeus = profile.workloads[0].renderers[0];
	assert.equal(zeus.hostIntervalMs, null);
	assert.equal(zeus.hostExcess.available, false);
	assert.match(zeus.hostExcess.reason, /segment trace/i);
});

test('frame-aware profile counts every Zeus commit in a sample without counting idle gaps', () => {
	const record = zeusRecord({ totals: [15] });
	record.segmentTrace.segments[0].commitTransactionIds = [1, 2, 3];
	record.segmentTrace.diagnostics.commits = [
		{ transactionId: 1, commitStartTime: 100, commitEndTime: 104 },
		{ transactionId: 2, commitStartTime: 102, commitEndTime: 106 },
		{ transactionId: 3, commitStartTime: 110, commitEndTime: 113 },
		// An unclaimed mount commit must not be attributed to this scroll sample.
		{ transactionId: 4, source: 'mount', commitStartTime: 0, commitEndTime: 90 }
	];
	const profile = createSqlResultGridFrameAwareProfile({ ...BASE, records: [record] });
	assert.equal(profile.workloads[0].renderers[0].rendererWork.count, 1);
	assert.equal(profile.workloads[0].renderers[0].rendererWork.medianMs, 9);
});

test('frame-aware profile unions nested WorkbenchTable intervals across all sample commits', () => {
	const record = workbenchTableRecord({ totals: [18] });
	record.segmentTrace.segments[0].commitTransactionIds = [1, 2];
	record.segmentTrace.diagnostics.commits = [
		{
			transactionId: 1,
			commitIntervals: [
				[100, 110],
				[102, 106]
			]
		},
		{
			transactionId: 2,
			commitIntervals: [
				[108, 112],
				[120, 123]
			]
		}
	];
	const profile = createSqlResultGridFrameAwareProfile({ ...BASE, records: [record] });
	assert.equal(profile.workloads[0].renderers[0].rendererWork.count, 1);
	assert.equal(profile.workloads[0].renderers[0].rendererWork.medianMs, 15);
});

test('frame-aware profile rejects evidence from another contract', () => {
	assert.throws(
		() => createSqlResultGridFrameAwareProfile({ ...BASE, measurementContractVersion: 6, records: [] }),
		/measurement contract must be version 7/
	);
	assert.throws(() => createSqlResultGridFrameAwareProfile({ ...BASE, records: [] }), /records are missing/);
});

test('union merges overlapping intervals and ignores malformed entries', () => {
	assert.equal(
		unionMs([
			[0, 10],
			[2, 6]
		]),
		10
	);
	assert.equal(
		unionMs([
			[0, 5],
			[6, 9]
		]),
		8
	);
	assert.equal(unionMs([[4, 4]]), 0);
	assert.equal(unionMs([]), 0);
	assert.equal(unionMs([[1, 'x']]), 0);
});

test('median and nearest-rank follow the registered conventions', () => {
	assert.equal(median([3, 1, 2]), 2);
	assert.equal(median([4, 1, 2, 3]), 2.5);
	assert.equal(nearestRank([1, 2, 3, 4], 0.95), 4);
	assert.equal(nearestRank([1, 2, 3, 4], 0.5), 2);
	assert.equal(nearestRank([], 0.95), null);
});

function renderer(rendererName, medianMs) {
	return { renderer: rendererName, rendererWork: { available: true, medianMs } };
}

test('frame-aware verdict scores renderer work against the fastest baseline', () => {
	const verdict = createFrameAwareSuperiorityVerdict({
		label: 'win/10k-x-50',
		renderers: [renderer('zeus', 2.5), renderer('workbench-table', 10), renderer('native', 8)],
		requiredImprovement: SQL_RESULT_GRID_FRAME_AWARE_TEN_K_MINIMUM_IMPROVEMENT
	});
	// The fastest baseline is native at 8ms, not WorkbenchTable at 10ms.
	assert.equal(verdict.baselineRenderer, 'native');
	assert.equal(verdict.improvement, (8 - 2.5) / 8);
	assert.equal(verdict.outcome, SQL_RESULT_GRID_FRAME_AWARE_OUTCOME.superiorWithinThreshold);
});

test('frame-aware verdict reports below-threshold superiority without failing', () => {
	const verdict = createFrameAwareSuperiorityVerdict({
		label: 'mac/10k-x-50',
		renderers: [renderer('zeus', 9), renderer('workbench-table', 10)],
		requiredImprovement: 0.2
	});
	assert.equal(verdict.improvement, 0.1);
	assert.equal(verdict.outcome, SQL_RESULT_GRID_FRAME_AWARE_OUTCOME.superiorBelowThreshold);
	assert.match(verdict.reason, /below the 20% threshold/);
});

test('frame-aware verdict is unavailable when either side lacks renderer work', () => {
	const missingBaseline = createFrameAwareSuperiorityVerdict({
		label: 'win/10k-x-50',
		renderers: [renderer('zeus', 2.5), { renderer: 'workbench-table', rendererWork: { available: false } }],
		requiredImprovement: 0.2
	});
	assert.equal(missingBaseline.outcome, SQL_RESULT_GRID_FRAME_AWARE_OUTCOME.unavailable);

	const missingZeus = createFrameAwareSuperiorityVerdict({
		label: 'win/10k-x-50',
		renderers: [{ renderer: 'zeus', rendererWork: { available: false } }, renderer('native', 8)],
		requiredImprovement: 0.2
	});
	assert.equal(missingZeus.outcome, SQL_RESULT_GRID_FRAME_AWARE_OUTCOME.unavailable);
	assert.equal(missingZeus.zeusRendererWorkMs, null);
});

test('frame-aware verdict rejects a non-positive baseline as unscoreable', () => {
	const verdict = createFrameAwareSuperiorityVerdict({
		label: 'win/10k-x-50',
		renderers: [renderer('zeus', 2.5), renderer('native', 0)],
		requiredImprovement: 0.2
	});
	assert.equal(verdict.outcome, SQL_RESULT_GRID_FRAME_AWARE_OUTCOME.unavailable);
	assert.match(verdict.reason, /must be positive/);
});

test('host excess is reported for attribution and never gates', () => {
	const report = createFrameAwareHostExcessReport({
		label: 'mac/10k-x-50',
		renderers: [
			{
				renderer: 'zeus',
				hostIntervalMs: 16,
				hostExcess: { available: true, p95ExcessMs: 26 },
				scrollTotal: { p95Ms: 42 }
			},
			{ renderer: 'native', rendererWork: { available: true, medianMs: 8 }, hostExcess: { available: false } }
		]
	});
	assert.equal(report.rows.length, 1);
	assert.deepEqual(report.rows[0], {
		renderer: 'zeus',
		hostIntervalMs: 16,
		p95ExcessMs: 26,
		scrollP95Ms: 42
	});
	assert.match(report.note, /does not gate admission/);
});
