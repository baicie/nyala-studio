import assert from 'node:assert/strict';
import test from 'node:test';
import {
	SQL_RESULT_GRID_JANK_BOOTSTRAP_RESAMPLES,
	SQL_RESULT_GRID_JANK_BOOTSTRAP_SEED,
	SQL_RESULT_GRID_JANK_CORRELATION,
	SQL_RESULT_GRID_JANK_FRAME_MULTIPLIER,
	SQL_RESULT_GRID_JANK_INPUT_CADENCE_MS,
	SQL_RESULT_GRID_JANK_INPUT_SEGMENTS,
	SQL_RESULT_GRID_JANK_INPUT_SOURCE,
	SQL_RESULT_GRID_JANK_MINIMUM_BASELINE_RATE,
	SQL_RESULT_GRID_JANK_MINIMUM_FRAME_INTERVALS,
	SQL_RESULT_GRID_JANK_MINIMUM_HORIZONTAL_SPAN_PX,
	SQL_RESULT_GRID_JANK_MINIMUM_VERTICAL_SPAN_PX,
	SQL_RESULT_GRID_JANK_ONE_K_DIFFERENCE_THRESHOLD,
	SQL_RESULT_GRID_JANK_ONE_K_WORKLOAD_ID,
	SQL_RESULT_GRID_JANK_TEN_K_RATIO_THRESHOLD,
	SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID,
	SQL_RESULT_GRID_JANK_TRACE_DURATION_MS,
	SQL_RESULT_GRID_JANK_TRACE_LIMITATIONS,
	SQL_RESULT_GRID_JANK_TRACE_VERSION,
	SQL_RESULT_GRID_JANK_VSYNC_CALIBRATION_FRAMES,
	SQL_RESULT_GRID_JANK_VSYNC_SOURCE,
	createBootstrapUpperBound,
	createJankTraceCollector,
	createScrollOffsetSampler,
	createTraceScrollOffsets,
	createSqlResultGridJankProfile,
	isJankTraceRecord,
	summarizeJankIntervals,
	validateJankTraceSnapshot,
	waitForJankTraceFlag
} from './sql-result-grid-jank-trace.mjs';

const TRACE_RUN_TOKEN = '0f0f0f0f-1111-4222-8333-444444444444';
const BASE_FRAME_MS = 16;
const JANK_FRAME_MS = 48;
const BASE_INTERVAL_COUNT = 312;
const WORKLOADS = {
	[SQL_RESULT_GRID_JANK_ONE_K_WORKLOAD_ID]: { id: SQL_RESULT_GRID_JANK_ONE_K_WORKLOAD_ID, rows: 1_000, columns: 20 },
	[SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID]: { id: SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID, rows: 10_000, columns: 50 }
};

function createFrameIntervals({ intervalCount = BASE_INTERVAL_COUNT, jankIndices = [] } = {}) {
	const jank = new Set(jankIndices);
	return Array.from({ length: intervalCount }, (_, index) => (jank.has(index) ? JANK_FRAME_MS : BASE_FRAME_MS));
}

function createInputPlan() {
	return {
		source: SQL_RESULT_GRID_JANK_INPUT_SOURCE,
		durationMs: SQL_RESULT_GRID_JANK_TRACE_DURATION_MS,
		cadenceMs: SQL_RESULT_GRID_JANK_INPUT_CADENCE_MS,
		segmentDurationMs: SQL_RESULT_GRID_JANK_TRACE_DURATION_MS / SQL_RESULT_GRID_JANK_INPUT_SEGMENTS.length,
		eventsPerSegment: Math.round(
			SQL_RESULT_GRID_JANK_TRACE_DURATION_MS /
				SQL_RESULT_GRID_JANK_INPUT_SEGMENTS.length /
				SQL_RESULT_GRID_JANK_INPUT_CADENCE_MS
		),
		eventCount: 315,
		dispatchDurationMs: BASE_INTERVAL_COUNT * BASE_FRAME_MS,
		segments: SQL_RESULT_GRID_JANK_INPUT_SEGMENTS.map(segment => ({ ...segment }))
	};
}

function createScrollOffsets() {
	const minTop = 0;
	const maxTop = 2_400;
	const minLeft = 0;
	const maxLeft = 640;
	return {
		sampleCount: BASE_INTERVAL_COUNT,
		first: { top: 0, left: 0 },
		last: { top: 0, left: 0 },
		minTop,
		maxTop,
		minLeft,
		maxLeft,
		verticalSpanPx: maxTop - minTop,
		horizontalSpanPx: maxLeft - minLeft
	};
}

/**
 * Builds a snapshot that satisfies every pre-registered check, computed from the
 * same raw intervals the validator is expected to recompute from.
 */
function createSnapshot({
	workloadId = SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID,
	frameIntervalsMs = createFrameIntervals({ jankIndices: [10, 20, 30] }),
	vsyncMs = BASE_FRAME_MS
} = {}) {
	const workload = WORKLOADS[workloadId];
	const summary = summarizeJankIntervals(frameIntervalsMs, vsyncMs, SQL_RESULT_GRID_JANK_FRAME_MULTIPLIER);
	return {
		version: SQL_RESULT_GRID_JANK_TRACE_VERSION,
		timingClock: 'performance-now',
		correlation: SQL_RESULT_GRID_JANK_CORRELATION,
		vsyncSource: SQL_RESULT_GRID_JANK_VSYNC_SOURCE,
		vsyncCalibrationFrames: SQL_RESULT_GRID_JANK_VSYNC_CALIBRATION_FRAMES,
		vsyncMs,
		frameMultiplier: SQL_RESULT_GRID_JANK_FRAME_MULTIPLIER,
		jankThresholdMs: summary.jankThresholdMs,
		durationMs: summary.durationMs,
		frameCount: summary.frameCount,
		frameIntervalsMs,
		jankFrameCount: summary.jankFrameCount,
		jankRate: summary.jankRate,
		traceRunToken: TRACE_RUN_TOKEN,
		workloadId,
		workload: { rows: workload.rows, columns: workload.columns },
		inputPlan: createInputPlan(),
		scrollOffsets: createScrollOffsets()
	};
}

function assertSnapshotRejected(snapshot, pattern, options) {
	assert.throws(() => validateJankTraceSnapshot(snapshot, options), pattern);
}

function createTraceRecord({ workloadId, renderer, iteration, jankIndices, status = 'ok' }) {
	return {
		workloadId,
		renderer,
		iteration,
		status,
		diagnostics: { jankTrace: createSnapshot({ workloadId, frameIntervalsMs: createFrameIntervals({ jankIndices }) }) }
	};
}

function createReport({
	workloadId = SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID,
	pairCount = 3,
	zeusJankIndices = [1, 2],
	workbenchTableJankIndices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
	metadata = {}
} = {}) {
	const records = [];
	for (let iteration = 1; iteration <= pairCount; iteration += 1) {
		records.push(createTraceRecord({ workloadId, renderer: 'zeus', iteration, jankIndices: zeusJankIndices }));
		records.push(
			createTraceRecord({
				workloadId,
				renderer: 'workbench-table',
				iteration,
				jankIndices: workbenchTableJankIndices
			})
		);
	}
	return {
		version: 1,
		diagnosticProfile: {
			jankTrace: {
				version: SQL_RESULT_GRID_JANK_TRACE_VERSION,
				correlation: SQL_RESULT_GRID_JANK_CORRELATION,
				inputSource: SQL_RESULT_GRID_JANK_INPUT_SOURCE,
				durationMs: SQL_RESULT_GRID_JANK_TRACE_DURATION_MS,
				frameMultiplier: SQL_RESULT_GRID_JANK_FRAME_MULTIPLIER,
				vsyncCalibrationFrames: SQL_RESULT_GRID_JANK_VSYNC_CALIBRATION_FRAMES,
				...metadata
			}
		},
		records
	};
}

/**
 * Node has no animation frame scheduler, so the page-side helpers are exercised
 * against a queue the test pumps with explicit timestamps.
 */
function installFakeAnimationFrames() {
	const original = globalThis.requestAnimationFrame;
	let queue = [];
	globalThis.requestAnimationFrame = callback => {
		queue.push(callback);
		return queue.length;
	};
	return {
		pump(timestamps) {
			for (const timestamp of timestamps) {
				const callbacks = queue;
				queue = [];
				for (const callback of callbacks) callback(timestamp);
			}
		},
		restore() {
			if (original === undefined) delete globalThis.requestAnimationFrame;
			else globalThis.requestAnimationFrame = original;
		}
	};
}

test('pre-registered jank trace constants match the ADR 0004 Primary A registration', () => {
	assert.equal(SQL_RESULT_GRID_JANK_TRACE_VERSION, 1);
	assert.equal(SQL_RESULT_GRID_JANK_TRACE_DURATION_MS, 5_000);
	assert.equal(SQL_RESULT_GRID_JANK_FRAME_MULTIPLIER, 1.5);
	assert.equal(SQL_RESULT_GRID_JANK_VSYNC_CALIBRATION_FRAMES, 60);
	assert.equal(SQL_RESULT_GRID_JANK_CORRELATION, 'raf-interval-v1');
	assert.equal(SQL_RESULT_GRID_JANK_VSYNC_SOURCE, 'idle-raf-median');
	assert.equal(SQL_RESULT_GRID_JANK_INPUT_SOURCE, 'cdp-mouse-wheel-v1');
	assert.equal(SQL_RESULT_GRID_JANK_INPUT_CADENCE_MS, 16);
	assert.equal(SQL_RESULT_GRID_JANK_MINIMUM_FRAME_INTERVALS, 30);
	assert.equal(SQL_RESULT_GRID_JANK_MINIMUM_VERTICAL_SPAN_PX, 2_000);
	assert.equal(SQL_RESULT_GRID_JANK_MINIMUM_HORIZONTAL_SPAN_PX, 500);
	assert.equal(SQL_RESULT_GRID_JANK_MINIMUM_BASELINE_RATE, 0.01);
	assert.equal(SQL_RESULT_GRID_JANK_TEN_K_RATIO_THRESHOLD, 0.8);
	assert.equal(SQL_RESULT_GRID_JANK_ONE_K_DIFFERENCE_THRESHOLD, 0.01);
	assert.equal(SQL_RESULT_GRID_JANK_BOOTSTRAP_RESAMPLES, 10_000);
	assert.equal(SQL_RESULT_GRID_JANK_BOOTSTRAP_SEED, 1_570_635_077);
});

test('pre-registered wheel plan is frozen and bidirectional', () => {
	assert.equal(Object.isFrozen(SQL_RESULT_GRID_JANK_INPUT_SEGMENTS), true);
	for (const segment of SQL_RESULT_GRID_JANK_INPUT_SEGMENTS) {
		assert.equal(Object.isFrozen(segment), true);
	}
	assert.deepEqual(
		SQL_RESULT_GRID_JANK_INPUT_SEGMENTS.map(segment => segment.label),
		['vertical-down', 'vertical-up', 'horizontal-right', 'horizontal-left', 'vertical-down-return']
	);
	assert.ok(SQL_RESULT_GRID_JANK_INPUT_SEGMENTS.some(segment => segment.deltaY > 0));
	assert.ok(SQL_RESULT_GRID_JANK_INPUT_SEGMENTS.some(segment => segment.deltaY < 0));
	assert.ok(SQL_RESULT_GRID_JANK_INPUT_SEGMENTS.some(segment => segment.deltaX > 0));
	assert.ok(SQL_RESULT_GRID_JANK_INPUT_SEGMENTS.some(segment => segment.deltaX < 0));
});

test('jank summary recomputes duration, frame count, jank count and rate from raw intervals', () => {
	const summary = summarizeJankIntervals([16, 16, 24.1, 16], 16, 1.5);
	assert.equal(summary.jankThresholdMs, 24);
	assert.equal(summary.durationMs, 72.1);
	assert.equal(summary.frameCount, 5);
	assert.equal(summary.jankFrameCount, 1);
	assert.equal(summary.jankRate, 0.25);
});

test('jank summary treats an interval exactly at the threshold as not jank', () => {
	const summary = summarizeJankIntervals([16, 24, 24.000001], 16, 1.5);
	assert.equal(summary.jankFrameCount, 1);
	assert.equal(summary.jankRate, 1 / 3);
});

test('jank summary rejects missing intervals and invalid calibration inputs', () => {
	assert.throws(() => summarizeJankIntervals([], 16, 1.5), /frame intervals are missing/i);
	assert.throws(() => summarizeJankIntervals(undefined, 16, 1.5), /frame intervals are missing/i);
	assert.throws(() => summarizeJankIntervals([16], 0, 1.5), /vsync interval must be a positive finite number/i);
	assert.throws(() => summarizeJankIntervals([16], Number.NaN, 1.5), /vsync interval must be a positive finite number/i);
	assert.throws(() => summarizeJankIntervals([16], 16, 0.9), /frame multiplier must be at least 1/i);
	assert.throws(() => summarizeJankIntervals([16, -1], 16, 1.5), /frame interval 1 must be a positive finite number/i);
	assert.throws(() => summarizeJankIntervals([16, Number.NaN], 16, 1.5), /frame interval 1 must be a positive finite number/i);
});

test('well-formed jank trace snapshot validates and is returned unchanged', () => {
	const snapshot = createSnapshot();
	assert.equal(validateJankTraceSnapshot(snapshot), snapshot);
	assert.equal(
		validateJankTraceSnapshot(snapshot, {
			expectedWorkload: WORKLOADS[SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID],
			expectedTraceRunToken: TRACE_RUN_TOKEN
		}),
		snapshot
	);
});

test('jank trace snapshot rejects a missing or non-object payload', () => {
	assertSnapshotRejected(undefined, /snapshot is missing/i);
	assertSnapshotRejected(null, /snapshot is missing/i);
	assertSnapshotRejected([], /snapshot is missing/i);
});

test('jank trace snapshot rejects a contract identity mismatch', () => {
	const cases = [
		['version', snapshot => (snapshot.version = 2), /version is invalid/i],
		['timing clock', snapshot => (snapshot.timingClock = 'date-now'), /timing clock is invalid/i],
		['correlation', snapshot => (snapshot.correlation = 'raf-interval-v2'), /correlation contract is invalid/i],
		['vsync source', snapshot => (snapshot.vsyncSource = 'nominal-60hz'), /vsync source is invalid/i],
		[
			'calibration frames',
			snapshot => (snapshot.vsyncCalibrationFrames = 30),
			/vsync calibration frame count must be 60/i
		],
		['frame multiplier', snapshot => (snapshot.frameMultiplier = 2), /frame multiplier must be 1\.5/i],
		['vsync interval', snapshot => (snapshot.vsyncMs = 0), /vsync interval is invalid/i]
	];
	for (const [name, tamper, pattern] of cases) {
		const snapshot = createSnapshot();
		tamper(snapshot);
		assert.throws(() => validateJankTraceSnapshot(snapshot), pattern, name);
	}
});

test('jank trace snapshot recomputes every summary field from the raw intervals', () => {
	const cases = [
		['frame count', snapshot => (snapshot.frameCount += 1), /frame count does not recompute/i],
		['duration', snapshot => (snapshot.durationMs += 1), /duration does not recompute/i],
		['jank threshold', snapshot => (snapshot.jankThresholdMs += 1), /jank threshold does not recompute/i],
		['jank frame count', snapshot => (snapshot.jankFrameCount += 1), /jank frame count does not recompute/i],
		['jank rate', snapshot => (snapshot.jankRate = 0), /jank rate does not recompute/i]
	];
	for (const [name, tamper, pattern] of cases) {
		const snapshot = createSnapshot();
		tamper(snapshot);
		assert.throws(() => validateJankTraceSnapshot(snapshot), pattern, name);
	}
});

test('jank trace snapshot rejects raw intervals that cannot support the summary', () => {
	const missing = createSnapshot();
	delete missing.frameIntervalsMs;
	assertSnapshotRejected(missing, /frame intervals are missing/i);

	const tooFew = createSnapshot({ frameIntervalsMs: createFrameIntervals({ intervalCount: 29 }) });
	assertSnapshotRejected(tooFew, /frame interval count must be at least 30/i);

	const negativeInterval = createSnapshot();
	negativeInterval.frameIntervalsMs = [...negativeInterval.frameIntervalsMs.slice(0, -1), -1];
	assertSnapshotRejected(negativeInterval, /frame interval 311 must be a positive finite number/i);
});

test('jank trace snapshot rejects a trace outside the pre-registered duration window', () => {
	const tooShort = createSnapshot({ frameIntervalsMs: createFrameIntervals({ intervalCount: 100 }) });
	assertSnapshotRejected(tooShort, /trace duration 1600ms is outside the expected 5000ms window/i);

	const tooLong = createSnapshot({ frameIntervalsMs: createFrameIntervals({ intervalCount: 1_000 }) });
	assertSnapshotRejected(tooLong, /trace duration 16000ms is outside the expected 5000ms window/i);
});

test('jank trace snapshot rejects an invalid or unexpected run token', () => {
	const missing = createSnapshot();
	missing.traceRunToken = 'standalone';
	assertSnapshotRejected(missing, /trace run token is invalid/i);

	const mismatched = createSnapshot();
	assertSnapshotRejected(
		mismatched,
		/trace run token does not match the expected run/i,
		{ expectedTraceRunToken: 'ffffffff-1111-4222-8333-444444444444' }
	);
});

test('jank trace snapshot rejects a workload that does not match the expected shape', () => {
	const wrongId = createSnapshot();
	wrongId.workloadId = SQL_RESULT_GRID_JANK_ONE_K_WORKLOAD_ID;
	assertSnapshotRejected(wrongId, /workload id does not match/i, {
		expectedWorkload: WORKLOADS[SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID]
	});

	const wrongShape = createSnapshot();
	wrongShape.workload.rows = 1_000;
	assertSnapshotRejected(wrongShape, /workload shape does not match/i, {
		expectedWorkload: WORKLOADS[SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID]
	});
});

test('jank trace snapshot rejects a trace whose viewport never displaced enough', () => {
	const vertical = createSnapshot();
	vertical.scrollOffsets.maxTop = SQL_RESULT_GRID_JANK_MINIMUM_VERTICAL_SPAN_PX - 1;
	vertical.scrollOffsets.verticalSpanPx = vertical.scrollOffsets.maxTop - vertical.scrollOffsets.minTop;
	assertSnapshotRejected(vertical, /vertical scroll span 1999px is below the pre-registered 2000px/i);

	const horizontal = createSnapshot();
	horizontal.scrollOffsets.maxLeft = SQL_RESULT_GRID_JANK_MINIMUM_HORIZONTAL_SPAN_PX - 1;
	horizontal.scrollOffsets.horizontalSpanPx = horizontal.scrollOffsets.maxLeft - horizontal.scrollOffsets.minLeft;
	assertSnapshotRejected(horizontal, /horizontal scroll span 499px is below the pre-registered 500px/i);
});

test('jank trace snapshot rejects scroll offsets that cannot be audited', () => {
	const missing = createSnapshot();
	delete missing.scrollOffsets;
	assertSnapshotRejected(missing, /scroll offsets are missing/i);

	const badOffset = createSnapshot();
	badOffset.scrollOffsets.minTop = '0';
	assertSnapshotRejected(badOffset, /scroll offset minTop is invalid/i);

	const missingFirst = createSnapshot();
	delete missingFirst.scrollOffsets.first;
	assertSnapshotRejected(missingFirst, /scroll offset first sample is missing/i);

	const inverted = createSnapshot();
	inverted.scrollOffsets.maxTop = -1;
	assertSnapshotRejected(inverted, /scroll offset bounds are inverted/i);

	const fewSamples = createSnapshot();
	fewSamples.scrollOffsets.sampleCount = SQL_RESULT_GRID_JANK_MINIMUM_FRAME_INTERVALS - 1;
	assertSnapshotRejected(fewSamples, /scroll offset sample count must be at least 30/i);

	const staleSpan = createSnapshot();
	staleSpan.scrollOffsets.verticalSpanPx = 3_000;
	assertSnapshotRejected(staleSpan, /vertical scroll span does not recompute/i);
});

test('jank trace snapshot rejects every tampered wheel input plan', () => {
	const cases = [
		['missing plan', snapshot => (snapshot.inputPlan = null), /input plan is missing/i],
		['source', snapshot => (snapshot.inputPlan.source = 'physical-trackpad'), /input plan source is invalid/i],
		['duration', snapshot => (snapshot.inputPlan.durationMs = 4_000), /input plan duration is invalid/i],
		[
			'segment count',
			snapshot => (snapshot.inputPlan.segments = snapshot.inputPlan.segments.slice(0, 4)),
			/input plan segments are missing/i
		],
		['segment delta', snapshot => (snapshot.inputPlan.segments[2].deltaX = 24), /segment 2 does not match/i],
		['segment order', snapshot => snapshot.inputPlan.segments.reverse(), /segment 0 does not match/i],
		['event count', snapshot => (snapshot.inputPlan.eventCount = 49), /event count must be at least 50/i],
		['non-integer event count', snapshot => (snapshot.inputPlan.eventCount = 315.5), /event count must be at least 50/i],
		[
			'short dispatch window',
			snapshot => (snapshot.inputPlan.dispatchDurationMs = 2_499),
			/input plan dispatch duration is invalid/i
		],
		[
			'dispatch window drift',
			snapshot => (snapshot.inputPlan.dispatchDurationMs = 6_100),
			/trace duration does not match the wheel dispatch window/i
		]
	];
	for (const [name, tamper, pattern] of cases) {
		const snapshot = createSnapshot();
		tamper(snapshot);
		assert.throws(() => validateJankTraceSnapshot(snapshot), pattern, name);
	}
});

test('jank trace collector recomputes its summary from calibrated frames', async () => {
	const frames = installFakeAnimationFrames();
	try {
		const collector = createJankTraceCollector({ frameMultiplier: SQL_RESULT_GRID_JANK_FRAME_MULTIPLIER });
		const calibration = collector.calibrate(4);
		frames.pump([0, 16, 32, 48]);
		const calibrated = await calibration;
		assert.equal(calibrated.frameCount, 4);
		assert.equal(calibrated.medianMs, BASE_FRAME_MS);

		const session = collector.begin();
		frames.pump([0, 16, 32, 80]);
		const trace = collector.end(session, calibrated);
		assert.equal(trace.version, SQL_RESULT_GRID_JANK_TRACE_VERSION);
		assert.equal(trace.timingClock, 'performance-now');
		assert.equal(trace.correlation, SQL_RESULT_GRID_JANK_CORRELATION);
		assert.equal(trace.vsyncSource, SQL_RESULT_GRID_JANK_VSYNC_SOURCE);
		assert.equal(trace.vsyncCalibrationFrames, 4);
		assert.equal(trace.vsyncMs, BASE_FRAME_MS);
		assert.equal(trace.jankThresholdMs, 24);
		assert.deepEqual(trace.frameIntervalsMs, [16, 16, 48]);
		assert.equal(trace.durationMs, 80);
		assert.equal(trace.frameCount, 4);
		assert.equal(trace.jankFrameCount, 1);
		assert.equal(trace.jankRate, 1 / 3);
	} finally {
		frames.restore();
	}
});

test('jank trace collector refuses an invalid multiplier, a short calibration and a stopped session', async () => {
	assert.throws(() => createJankTraceCollector({}), /requires a frame multiplier of at least 1/i);
	assert.throws(() => createJankTraceCollector({ frameMultiplier: 0.5 }), /requires a frame multiplier of at least 1/i);

	const frames = installFakeAnimationFrames();
	try {
		const collector = createJankTraceCollector({ frameMultiplier: SQL_RESULT_GRID_JANK_FRAME_MULTIPLIER });
		await assert.rejects(collector.calibrate(1), /calibration requires at least two frames/i);

		const session = collector.begin();
		frames.pump([0, 16]);
		const trace = collector.end(session, { frameCount: 2, medianMs: BASE_FRAME_MS });
		assert.equal(trace.frameCount, 2);
		assert.throws(() => collector.end(session, { frameCount: 2, medianMs: BASE_FRAME_MS }), /already stopped/i);
		assert.throws(() => collector.end(undefined, { frameCount: 2, medianMs: BASE_FRAME_MS }), /missing or already stopped/i);
	} finally {
		frames.restore();
	}
});

test('jank trace reads live offsets only from the explicit renderer controller', () => {
	const scroll = { scrollTop: 0, scrollLeft: 0 };
	const offsets = createTraceScrollOffsets({ scroll, viewport: { scrollTop: 999, scrollLeft: 999 } });
	scroll.scrollTop = 2_400;
	scroll.scrollLeft = 640;
	assert.equal(offsets.scrollTop, 2_400);
	assert.equal(offsets.scrollLeft, 640);
	scroll.scrollLeft = 0;
	assert.equal(offsets.scrollLeft, 0);
});

test('jank trace rejects incomplete or invalid controllers instead of using native viewport offsets', () => {
	for (const scroll of [
		undefined,
		{},
		{ scrollTop: 0 },
		{ scrollLeft: 0 },
		{ scrollTop: NaN, scrollLeft: 0 },
		{ scrollTop: 0, scrollLeft: Infinity },
		{ scrollTop: 0, scrollLeft: '640' }
	]) {
		assert.throws(
			() => createTraceScrollOffsets({ scroll, viewport: { scrollTop: 0, scrollLeft: 640 } }),
			/explicit scroll controller with finite scrollTop and scrollLeft/
		);
	}
});

test('jank trace scroll sampler records bidirectional displacement and stops on demand', () => {
	const frames = installFakeAnimationFrames();
	try {
		const element = { scrollTop: 0, scrollLeft: 0 };
		const sampler = createScrollOffsetSampler(element);

		element.scrollTop = 2_400;
		frames.pump([0]);
		element.scrollLeft = 640;
		frames.pump([16]);
		element.scrollTop = 0;
		element.scrollLeft = 0;
		frames.pump([32]);
		sampler.stop();
		frames.pump([48]);

		const snapshot = sampler.snapshot();
		assert.equal(snapshot.sampleCount, 3);
		assert.deepEqual(snapshot.first, { top: 2_400, left: 0 });
		assert.deepEqual(snapshot.last, { top: 0, left: 0 });
		assert.equal(snapshot.minTop, 0);
		assert.equal(snapshot.maxTop, 2_400);
		assert.equal(snapshot.minLeft, 0);
		assert.equal(snapshot.maxLeft, 640);
		assert.equal(snapshot.verticalSpanPx, 2_400);
		assert.equal(snapshot.horizontalSpanPx, 640);
	} finally {
		frames.restore();
	}
});

test('jank trace scroll sampler requires a scrollable element', () => {
	assert.throws(() => createScrollOffsetSampler(null), /requires a scrollable element/i);
	assert.throws(() => createScrollOffsetSampler({ scrollTop: 0 }), /requires an element with scroll offsets/i);
});

test('jank trace control flag wait resolves only once the driver sets the flag', async () => {
	const control = { begin: false };
	const wait = waitForJankTraceFlag(control, 'begin', 1_000);
	control.begin = true;
	await wait;
});

test('jank trace control flag wait rejects when the flag never arrives', async () => {
	await assert.rejects(waitForJankTraceFlag({ begin: false }, 'begin', 1), /control flag begin was not set within 1ms/i);
});

test('jank trace record guard accepts plain objects only', () => {
	assert.equal(isJankTraceRecord({}), true);
	assert.equal(isJankTraceRecord(Object.create(null)), true);
	assert.equal(isJankTraceRecord([]), false);
	assert.equal(isJankTraceRecord(null), false);
	assert.equal(isJankTraceRecord('{}'), false);
});

test('bootstrap interval uses the registered one-sided 95 percent upper bound', () => {
	const interval = createBootstrapUpperBound(100, SQL_RESULT_GRID_JANK_BOOTSTRAP_SEED, Array.from({ length: 100 }, (_, index) => index));
	assert.deepEqual(interval, {
		level: 0.95,
		method: 'percentile',
		sidedness: 'upper',
		quantile: 0.95,
		resamples: 100,
		seed: SQL_RESULT_GRID_JANK_BOOTSTRAP_SEED,
		available: true,
		lower: null,
		upper: 95
	});
});

test('10k jank profile reports pooled rates and a ratio upper bound that exceeds the threshold at parity', () => {
	const profile = createSqlResultGridJankProfile(createReport(), SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID);
	assert.equal(profile.version, SQL_RESULT_GRID_JANK_TRACE_VERSION);
	assert.equal(profile.workloadId, SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID);
	assert.equal(profile.correlation, SQL_RESULT_GRID_JANK_CORRELATION);
	assert.equal(profile.inputSource, SQL_RESULT_GRID_JANK_INPUT_SOURCE);
	assert.equal(profile.pairedRunCount, 3);
	assert.deepEqual(profile.recordCounts, { total: 6, zeus: 3, workbenchTable: 3 });
	assert.equal(profile.renderers.zeus.recordCount, 3);
	assert.equal(profile.renderers.zeus.frameCount, 3 * 313);
	assert.equal(profile.renderers.zeus.frameIntervalCount, 3 * 312);
	assert.equal(profile.renderers.zeus.jankFrameCount, 6);
	assert.equal(profile.renderers.workbenchTable.jankFrameCount, 30);
	assert.equal(profile.baselinePointEstimate, 30 / 936);
	assert.equal(profile.ratioPointEstimate, 0.2);
	assert.equal(profile.differencePointEstimate, 6 / 936 - 30 / 936);
	assert.equal(profile.thresholdEvaluation.metric, 'ratio');
	assert.equal(profile.thresholdEvaluation.threshold, SQL_RESULT_GRID_JANK_TEN_K_RATIO_THRESHOLD);
	assert.equal(profile.thresholdEvaluation.definition, 'paired-bootstrap one-sided 95% upper bound');
	assert.equal(profile.ratioConfidenceInterval.lower, null);
	assert.equal(profile.thresholdEvaluation.evaluable, true);
	assert.equal(profile.thresholdEvaluation.notEvaluableReason, null);
	assert.equal(profile.thresholdEvaluation.outcome, 'UPPER-BOUND-WITHIN-THRESHOLD');
	assert.equal(profile.thresholdEvaluation.withinThreshold, true);
	assert.ok(profile.thresholdEvaluation.upperBound <= SQL_RESULT_GRID_JANK_TEN_K_RATIO_THRESHOLD);
	assert.deepEqual(profile.limitations, [...SQL_RESULT_GRID_JANK_TRACE_LIMITATIONS]);
});

test('10k jank profile refuses to score parity as within the superiority bound', () => {
	const profile = createSqlResultGridJankProfile(
		createReport({ zeusJankIndices: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }),
		SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID
	);
	assert.equal(profile.ratioPointEstimate, 1);
	assert.equal(profile.thresholdEvaluation.evaluable, true);
	assert.equal(profile.thresholdEvaluation.upperBound, 1);
	assert.equal(profile.thresholdEvaluation.withinThreshold, false);
	assert.equal(profile.thresholdEvaluation.outcome, 'UPPER-BOUND-EXCEEDS-THRESHOLD');
});

test('10k jank profile reports NOT-EVALUABLE when the Workbench baseline is below one percent', () => {
	const profile = createSqlResultGridJankProfile(
		createReport({ workbenchTableJankIndices: [] }),
		SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID
	);
	assert.equal(profile.baselinePointEstimate, 0);
	assert.equal(profile.ratioPointEstimate, null);
	assert.equal(profile.ratioConfidenceInterval.available, false);
	assert.equal(profile.thresholdEvaluation.evaluable, false);
	assert.equal(profile.thresholdEvaluation.withinThreshold, null);
	assert.equal(profile.thresholdEvaluation.upperBound, null);
	assert.equal(profile.thresholdEvaluation.outcome, 'NOT-EVALUABLE');
	assert.match(profile.thresholdEvaluation.notEvaluableReason, /baseline jank rate is below 1%/i);
});

test('10k jank profile reports NOT-EVALUABLE when a ratio resample hits a zero baseline', () => {
	const report = createReport({ pairCount: 2, workbenchTableJankIndices: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
	report.records.find(record => record.renderer === 'workbench-table' && record.iteration === 2).diagnostics.jankTrace =
		createSnapshot({
			frameIntervalsMs: createFrameIntervals({ jankIndices: [] })
		});
	const profile = createSqlResultGridJankProfile(report, SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID);
	assert.ok(profile.baselinePointEstimate >= SQL_RESULT_GRID_JANK_MINIMUM_BASELINE_RATE);
	assert.equal(profile.ratioConfidenceInterval.available, false);
	assert.equal(profile.thresholdEvaluation.evaluable, false);
	assert.equal(profile.thresholdEvaluation.outcome, 'NOT-EVALUABLE');
	assert.match(profile.thresholdEvaluation.notEvaluableReason, /one or more resamples hit a zero baseline rate/i);
});

test('1k jank profile scores the non-inferiority difference bound', () => {
	const within = createSqlResultGridJankProfile(
		createReport({
			workloadId: SQL_RESULT_GRID_JANK_ONE_K_WORKLOAD_ID,
			zeusJankIndices: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
		}),
		SQL_RESULT_GRID_JANK_ONE_K_WORKLOAD_ID
	);
	assert.equal(within.workloadId, SQL_RESULT_GRID_JANK_ONE_K_WORKLOAD_ID);
	assert.equal(within.pairedRunCount, 3);
	assert.equal(within.differencePointEstimate, 0);
	assert.equal(within.thresholdEvaluation.metric, 'difference');
	assert.equal(within.thresholdEvaluation.threshold, SQL_RESULT_GRID_JANK_ONE_K_DIFFERENCE_THRESHOLD);
	assert.equal(within.thresholdEvaluation.outcome, 'UPPER-BOUND-WITHIN-THRESHOLD');

	const exceeds = createSqlResultGridJankProfile(
		createReport({
			workloadId: SQL_RESULT_GRID_JANK_ONE_K_WORKLOAD_ID,
			zeusJankIndices: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
			workbenchTableJankIndices: []
		}),
		SQL_RESULT_GRID_JANK_ONE_K_WORKLOAD_ID
	);
	assert.equal(exceeds.differencePointEstimate, 10 / 312);
	assert.equal(exceeds.thresholdEvaluation.evaluable, true);
	assert.equal(exceeds.thresholdEvaluation.withinThreshold, false);
	assert.equal(exceeds.thresholdEvaluation.outcome, 'UPPER-BOUND-EXCEEDS-THRESHOLD');
});

test('jank profile is deterministic for a fixed report and seed', () => {
	const report = createReport();
	assert.deepEqual(
		createSqlResultGridJankProfile(report, SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID),
		createSqlResultGridJankProfile(report, SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID)
	);
});

test('jank profile never reports a threshold outcome it did not evaluate', () => {
	const reports = [
		createReport(),
		createReport({ workbenchTableJankIndices: [] }),
		createReport({ workloadId: SQL_RESULT_GRID_JANK_ONE_K_WORKLOAD_ID })
	];
	for (const report of reports) {
		for (const workloadId of [SQL_RESULT_GRID_JANK_ONE_K_WORKLOAD_ID, SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID]) {
			if (report.records.every(record => record.workloadId !== workloadId)) continue;
			const evaluation = createSqlResultGridJankProfile(report, workloadId).thresholdEvaluation;
			if (evaluation.evaluable) {
				assert.ok(['UPPER-BOUND-WITHIN-THRESHOLD', 'UPPER-BOUND-EXCEEDS-THRESHOLD'].includes(evaluation.outcome));
				assert.equal(evaluation.withinThreshold, evaluation.upperBound <= evaluation.threshold);
			} else {
				assert.equal(evaluation.outcome, 'NOT-EVALUABLE');
				assert.equal(evaluation.withinThreshold, null);
				assert.equal(evaluation.upperBound, null);
				assert.equal(typeof evaluation.notEvaluableReason, 'string');
			}
		}
	}
});

test('jank profile rejects an unsupported workload and a report without records', () => {
	assert.throws(
		() => createSqlResultGridJankProfile(createReport(), '5k-x-10'),
		/workload must be one of: 1k-x-20, 10k-x-50/i
	);
	assert.throws(() => createSqlResultGridJankProfile({}, SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID), /report with records/i);
	assert.throws(
		() => createSqlResultGridJankProfile({ records: [] }, SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID),
		/metadata is missing/i
	);
});

test('jank profile rejects metadata that does not match the registered contract', () => {
	const cases = [
		['version', { version: 2 }, /jank trace version must be 1/i],
		['correlation', { correlation: 'raf-interval-v2' }, /correlation is invalid/i],
		['input source', { inputSource: 'physical-trackpad' }, /input source is invalid/i],
		['duration', { durationMs: 4_000 }, /jank trace duration must be 5000/i],
		['frame multiplier', { frameMultiplier: 2 }, /frame multiplier must be 1\.5/i],
		['calibration frames', { vsyncCalibrationFrames: 30 }, /vsync calibration must be 60 frames/i]
	];
	for (const [name, metadata, pattern] of cases) {
		assert.throws(
			() => createSqlResultGridJankProfile(createReport({ metadata }), SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID),
			pattern,
			name
		);
	}
});

test('jank profile fails closed on missing, unpaired or non-ok records', () => {
	const otherWorkload = createReport({ workloadId: SQL_RESULT_GRID_JANK_ONE_K_WORKLOAD_ID });
	assert.throws(
		() => createSqlResultGridJankProfile(otherWorkload, SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID),
		/records for workload 10k-x-50 are missing/i
	);

	const nonOk = createReport();
	nonOk.records.find(record => record.renderer === 'zeus').status = 'error';
	assert.throws(
		() => createSqlResultGridJankProfile(nonOk, SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID),
		/contains a non-ok zeus record/i
	);

	const missingRenderer = createReport();
	missingRenderer.records = missingRenderer.records.filter(record => record.renderer !== 'zeus');
	assert.throws(
		() => createSqlResultGridJankProfile(missingRenderer, SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID),
		/requires both zeus and workbench-table records/i
	);

	const duplicate = createReport();
	duplicate.records.push(createTraceRecord({ workloadId: SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID, renderer: 'zeus', iteration: 1, jankIndices: [1] }));
	assert.throws(
		() => createSqlResultGridJankProfile(duplicate, SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID),
		/has duplicate renderer iterations/i
	);

	const unpaired = createReport();
	unpaired.records.find(record => record.renderer === 'workbench-table' && record.iteration === 3).iteration = 4;
	assert.throws(
		() => createSqlResultGridJankProfile(unpaired, SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID),
		/iteration 3 is not paired/i
	);
});

test('jank profile validates every attached trace instead of trusting the record', () => {
	const report = createReport();
	report.records.find(record => record.renderer === 'zeus').diagnostics.jankTrace.jankRate = 0;
	assert.throws(
		() => createSqlResultGridJankProfile(report, SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID),
		/jank rate does not recompute/i
	);

	const shortTrace = createReport();
	const shortTraceOffsets = shortTrace.records.find(record => record.renderer === 'workbench-table').diagnostics.jankTrace
		.scrollOffsets;
	shortTraceOffsets.maxTop = 0;
	shortTraceOffsets.verticalSpanPx = 0;
	assert.throws(
		() => createSqlResultGridJankProfile(shortTrace, SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID),
		/vertical scroll span 0px is below the pre-registered 2000px/i
	);
});

test('jank profile limitations are a copy that callers cannot mutate globally', () => {
	const profile = createSqlResultGridJankProfile(createReport(), SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID);
	profile.limitations.push('mutated');
	assert.equal(
		createSqlResultGridJankProfile(createReport(), SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID).limitations.length,
		SQL_RESULT_GRID_JANK_TRACE_LIMITATIONS.length
	);
});
