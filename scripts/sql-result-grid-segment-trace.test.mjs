import assert from 'node:assert/strict';
import test from 'node:test';
import {
	SQL_RESULT_GRID_SEGMENT_TRACE_CORRELATION,
	SQL_RESULT_GRID_SEGMENT_TRACE_INSTRUMENTATION,
	SQL_RESULT_GRID_SEGMENT_TRACE_VERSION,
	validateObserverFreeSegmentTraceSnapshot
} from './sql-result-grid-segment-trace.mjs';

function commit(transactionId) {
	return {
		transactionId,
		handlerStartTime: transactionId,
		handlerEndTime: transactionId + 1,
		rangeStartTime: transactionId + 2,
		rangeCalculatedTime: transactionId + 3,
		commitStartTime: transactionId + 4,
		commitEndTime: transactionId + 5
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
