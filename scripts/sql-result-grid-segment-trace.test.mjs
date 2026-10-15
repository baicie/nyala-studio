import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
	SQL_RESULT_GRID_SEGMENT_TRACE_CORRELATION,
	SQL_RESULT_GRID_SEGMENT_TRACE_INSTRUMENTATION,
	SQL_RESULT_GRID_SEGMENT_TRACE_VERSION,
	runObserverFreeSegmentTrace,
	validateObserverFreeSegmentTraceSnapshot
} from './sql-result-grid-segment-trace.mjs';
import {
	createWorkbenchTableDiagnosticCollector,
	validateWorkbenchTableDiagnosticSnapshot
} from './sql-result-grid-workbench-table-diagnostics.mjs';

test('frame timing exposes synchronous visibility probe work inside the RAF-to-task interval', async t => {
	let time = 100;
	t.mock.method(performance, 'now', () => time);
	t.mock.method(globalThis, 'setTimeout', callback => {
		queueMicrotask(callback);
		return 0;
	});
	const originalRaf = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
	globalThis.requestAnimationFrame = callback => {
		queueMicrotask(() => callback(time));
		return 0;
	};
	try {
		const scroll = {
			scrollTop: 0,
			scrollHeight: 1000,
			clientHeight: 100,
			addEventListener() {},
			removeEventListener() {}
		};
		const result = await runObserverFreeSegmentTrace(
			{ scroll },
			{
				maxFrames: 1,
				targetRatios: [[1, 2]],
				rowCount: 100,
				expectedVisibleRowIndex: () => 1,
				getVisibleRowIndex: () => {
					time += 7;
					return 1;
				}
			}
		);
		for (const segment of result.segments) {
			assert.equal(segment.nextPaintRafProbeEndTime - segment.nextPaintRafTime, 7);
			assert.ok(segment.nextPaintTaskTime >= segment.nextPaintRafProbeEndTime);
		}
	} finally {
		if (originalRaf) Object.defineProperty(globalThis, 'requestAnimationFrame', originalRaf);
		else delete globalThis.requestAnimationFrame;
	}
});

test('observer-free trace listens on the renderer viewport when the scroll adapter is not a DOM node', async () => {
	const source = await readFile(new URL('./sql-result-grid-segment-trace.mjs', import.meta.url), 'utf8');
	assert.match(source, /const scrollElement = rendered\.viewport \?\? rendered\.scroll/);
	assert.match(source, /scrollElement\.addEventListener\('scroll'/);
	assert.match(source, /scrollElement\.removeEventListener\('scroll'/);
	assert.doesNotMatch(source, /rendered\.scroll\.addEventListener\('scroll'/);
});

function commit(transactionId) {
	const handlerStartTime = transactionId * 10 + 2;
	return {
		transactionId,
		handlerStartTime,
		handlerEndTime: handlerStartTime + 1,
		rangeStartTime: handlerStartTime + 2,
		rangeCalculatedTime: handlerStartTime + 3,
		commitStartTime: handlerStartTime + 4,
		commitEndTime: handlerStartTime + 5
	};
}

function segment(phase, sampleIndex, transactionId) {
	return {
		phase,
		sampleIndex,
		targetOffset: transactionId * 100,
		actualOffset: transactionId * 100,
		expectedRowIndex: transactionId,
		visibleRowIndex: transactionId,
		rowDelta: 0,
		attempts: 1,
		inputStartTime: transactionId * 10,
		inputEndTime: transactionId * 10 + 1,
		eventDispatchTime: transactionId * 10 + 2,
		eventTimestamp: transactionId * 10,
		firstVisibleTime: transactionId * 10 + 3,
		nextPaintRafTime: transactionId * 10 + 2,
		nextPaintTaskTime: transactionId * 10 + 4,
		commitTransactionIds: [transactionId],
		primaryCommitTransactionId: transactionId
	};
}

test('observer-free trace validator accepts ordered renderer timing segments', () => {
	const snapshot = {
		version: SQL_RESULT_GRID_SEGMENT_TRACE_VERSION,
		timingClock: 'performance-now',
		correlation: SQL_RESULT_GRID_SEGMENT_TRACE_CORRELATION,
		instrumentation: SQL_RESULT_GRID_SEGMENT_TRACE_INSTRUMENTATION,
		observerFree: true,
		nativeScrollEvent: 'observed',
		domObserverFree: true,
		diagnosticsCallback: true,
		measureNodeChurn: false,
		maximumOffset: 1000,
		segments: [segment('preposition', null, 1), segment('sample', 0, 2), segment('reset', null, 3)],
		diagnostics: { commits: [commit(1), commit(2), commit(3)] }
	};
	assert.equal(validateObserverFreeSegmentTraceSnapshot(snapshot, { expectedSampleCount: 3 }), snapshot);
});

test('observer-free trace validator rejects node-churn instrumentation', () => {
	const snapshot = {
		version: SQL_RESULT_GRID_SEGMENT_TRACE_VERSION,
		timingClock: 'performance-now',
		correlation: SQL_RESULT_GRID_SEGMENT_TRACE_CORRELATION,
		instrumentation: SQL_RESULT_GRID_SEGMENT_TRACE_INSTRUMENTATION,
		observerFree: true,
		nativeScrollEvent: 'observed',
		domObserverFree: true,
		diagnosticsCallback: true,
		measureNodeChurn: true,
		maximumOffset: 1000,
		segments: [segment('sample', 0, 2)],
		diagnostics: { commits: [] }
	};
	assert.throws(() => validateObserverFreeSegmentTraceSnapshot(snapshot), /observer-free flags/);
});

test('observer-free trace validator accepts renderers without diagnostics callbacks', () => {
	const segments = [segment('preposition', null, 1), segment('sample', 0, 2), segment('reset', null, 3)].map(value => ({
		...value,
		commitTransactionIds: [],
		primaryCommitTransactionId: null
	}));
	const snapshot = {
		version: SQL_RESULT_GRID_SEGMENT_TRACE_VERSION,
		timingClock: 'performance-now',
		correlation: SQL_RESULT_GRID_SEGMENT_TRACE_CORRELATION,
		instrumentation: SQL_RESULT_GRID_SEGMENT_TRACE_INSTRUMENTATION,
		observerFree: true,
		nativeScrollEvent: 'observed',
		domObserverFree: true,
		diagnosticsCallback: false,
		measureNodeChurn: false,
		maximumOffset: 1000,
		segments,
		diagnostics: { commits: [] }
	};
	assert.equal(validateObserverFreeSegmentTraceSnapshot(snapshot, { expectedSampleCount: 3 }), snapshot);
});

function workbenchTrace() {
	const prototype = {
		onScroll() {
			this.getRenderRange();
			this.render();
		},
		getRenderRange() {
			return { start: 0, end: 10 };
		},
		render() {
			this.measureItemWidth();
		},
		measureItemWidth() {}
	};
	const collector = createWorkbenchTableDiagnosticCollector({ ListViewPrototype: prototype });
	const view = Object.create(prototype);
	try {
		const segments = ['preposition', 'sample', 'reset'].map((phase, index) => {
			const sampleIndex = phase === 'sample' ? 0 : null;
			const operation = collector.beginOperation(phase, sampleIndex);
			const inputStartTime = performance.now();
			view.onScroll();
			const inputEndTime = performance.now();
			return {
				...segment(phase, sampleIndex, index + 1),
				inputStartTime,
				inputEndTime,
				eventDispatchTime: null,
				eventTimestamp: null,
				firstVisibleTime: inputEndTime,
				nextPaintRafTime: inputEndTime,
				nextPaintTaskTime: inputEndTime,
				...collector.endOperation(operation)
			};
		});
		return {
			version: SQL_RESULT_GRID_SEGMENT_TRACE_VERSION,
			timingClock: 'performance-now',
			correlation: SQL_RESULT_GRID_SEGMENT_TRACE_CORRELATION,
			instrumentation: SQL_RESULT_GRID_SEGMENT_TRACE_INSTRUMENTATION,
			observerFree: true,
			nativeScrollEvent: 'not-emitted',
			domObserverFree: true,
			diagnosticsCallback: true,
			measureNodeChurn: false,
			maximumOffset: 1000,
			segments,
			diagnostics: collector.snapshot()
		};
	} finally {
		collector.dispose();
	}
}

test('observer-free trace accepts the WorkbenchTable collector nested interval model', () => {
	const snapshot = workbenchTrace();
	validateWorkbenchTableDiagnosticSnapshot(snapshot.diagnostics, {
		workload: { rows: 100 },
		expectedSampleCount: 1,
		scrollSamples: [snapshot.segments[1]]
	});
	assert.equal(validateObserverFreeSegmentTraceSnapshot(snapshot, { expectedSampleCount: 3 }), snapshot);
});

test('observer-free WorkbenchTable trace rejects intervals outside the handler and commit', () => {
	for (const field of ['rangeIntervals', 'commitIntervals', 'layoutReadIntervals']) {
		const snapshot = workbenchTrace();
		snapshot.diagnostics.commits[0][field][0][0] = snapshot.diagnostics.commits[0].handlerStartTime - 1;
		assert.throws(() => validateObserverFreeSegmentTraceSnapshot(snapshot), /renderer timing is invalid/);
	}
	const snapshot = workbenchTrace();
	snapshot.diagnostics.commits[0].layoutReadIntervals[0][0] = snapshot.diagnostics.commits[0].handlerStartTime;
	assert.throws(() => validateObserverFreeSegmentTraceSnapshot(snapshot), /renderer timing is invalid/);
});

test('observer-free Zeus trace still rejects stages that overlap its completed handler', () => {
	const snapshot = workbenchTrace();
	snapshot.segments = [segment('preposition', null, 1), segment('sample', 0, 2), segment('reset', null, 3)];
	snapshot.nativeScrollEvent = 'observed';
	snapshot.diagnostics = { commits: [commit(1), commit(2), commit(3)] };
	snapshot.diagnostics.commits[0].handlerEndTime = snapshot.diagnostics.commits[0].rangeStartTime + 1;
	assert.throws(() => validateObserverFreeSegmentTraceSnapshot(snapshot), /renderer timing is invalid/);
});
