import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createSqlResultGridFrameAwareProfile,
	median,
	nearestRank,
	unionMs
} from './sql-result-grid-frame-aware-profile.mjs';

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
