import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
	SQL_RESULT_GRID_SEGMENT_TRACE_CORRELATION,
	SQL_RESULT_GRID_SEGMENT_TRACE_INSTRUMENTATION,
	SQL_RESULT_GRID_SEGMENT_TRACE_VERSION,
	validateObserverFreeSegmentTraceSnapshot
} from './sql-result-grid-segment-trace.mjs';

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
		domObserverFree: true,
		diagnosticsCallback: true,
		measureNodeChurn: true,
		maximumOffset: 1000,
		segments: [],
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
		domObserverFree: true,
		diagnosticsCallback: false,
		measureNodeChurn: false,
		maximumOffset: 1000,
		segments,
		diagnostics: { commits: [] }
	};
	assert.equal(validateObserverFreeSegmentTraceSnapshot(snapshot, { expectedSampleCount: 3 }), snapshot);
});
