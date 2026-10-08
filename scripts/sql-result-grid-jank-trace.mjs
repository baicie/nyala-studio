/**
 * Diagnostic continuous-scroll jank traces for ADR 0004 Primary A.
 *
 * The page-side collector records raw `requestAnimationFrame` timestamps while
 * the driver dispatches real DevTools-protocol wheel input, so the jank rate is
 * recomputable from raw frame intervals instead of a producer summary. This is
 * diagnostic instrumentation: it cannot rewrite v6 admission evidence, flip
 * `phase-z1-gate.json`, or serve as v7 admission evidence.
 */

export const SQL_RESULT_GRID_JANK_TRACE_VERSION = 1;
export const SQL_RESULT_GRID_JANK_TRACE_DURATION_MS = 5_000;
export const SQL_RESULT_GRID_JANK_FRAME_MULTIPLIER = 1.5;
export const SQL_RESULT_GRID_JANK_VSYNC_CALIBRATION_FRAMES = 60;
export const SQL_RESULT_GRID_JANK_CORRELATION = 'raf-interval-v1';
export const SQL_RESULT_GRID_JANK_VSYNC_SOURCE = 'idle-raf-median';
export const SQL_RESULT_GRID_JANK_INPUT_SOURCE = 'cdp-mouse-wheel-v1';
export const SQL_RESULT_GRID_JANK_INPUT_SEGMENTS = Object.freeze([
	Object.freeze({ label: 'vertical-down', deltaX: 0, deltaY: 120 }),
	Object.freeze({ label: 'vertical-up', deltaX: 0, deltaY: -120 }),
	Object.freeze({ label: 'horizontal-right', deltaX: 12, deltaY: 0 }),
	Object.freeze({ label: 'horizontal-left', deltaX: -12, deltaY: 0 }),
	Object.freeze({ label: 'vertical-down-return', deltaX: 0, deltaY: 120 })
]);
export const SQL_RESULT_GRID_JANK_INPUT_CADENCE_MS = 16;
export const SQL_RESULT_GRID_JANK_MINIMUM_FRAME_INTERVALS = 30;
export const SQL_RESULT_GRID_JANK_MINIMUM_VERTICAL_SPAN_PX = 2_000;
export const SQL_RESULT_GRID_JANK_MINIMUM_HORIZONTAL_SPAN_PX = 500;
export const SQL_RESULT_GRID_JANK_MINIMUM_BASELINE_RATE = 0.01;
export const SQL_RESULT_GRID_JANK_ONE_K_WORKLOAD_ID = '1k-x-20';
export const SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID = '10k-x-50';
export const SQL_RESULT_GRID_JANK_TEN_K_RATIO_THRESHOLD = 0.8;
export const SQL_RESULT_GRID_JANK_ONE_K_DIFFERENCE_THRESHOLD = 0.01;
export const SQL_RESULT_GRID_JANK_BOOTSTRAP_RESAMPLES = 10_000;
export const SQL_RESULT_GRID_JANK_BOOTSTRAP_SEED = 1_570_635_077;
export const SQL_RESULT_GRID_JANK_TRACE_LIMITATIONS = Object.freeze([
	'Continuous-scroll jank traces use DevTools-dispatched wheel input and headless rAF cadence; they are not macOS WKWebView or Windows WebView2 evidence.',
	'Wheel input is dispatched at roughly one event per frame through the DevTools protocol, not by a physical trackpad; absolute jank rates may differ from device input.',
	'The cadence is a target: when the renderer stalls, DevTools input acknowledgement backpressure stretches the wheel window and the trace window with it.',
	'Each trace runs in its own observer-free navigation after the paired Primary B record, so trace instrumentation never perturbs the Primary B evidence.',
	'A trace fails closed unless the per-frame scroll offsets show the pre-registered bidirectional displacement.',
	'The formal v7 sample plan requires 30 paired runs per platform and workload; this diagnostic profile computes confidence bounds on the available paired runs only.',
	'Paired bootstrap resamples whole runs; frames inside one run are never treated as independent Bernoulli trials.',
	'This profile is diagnostic only and cannot rewrite v6 admission evidence, flip the Z1 gate, or serve as v7 admission evidence.',
	'Chromium headless numbers are not macOS WKWebView or Windows WebView2 evidence.'
]);

const supportedWorkloads = new Set([
	SQL_RESULT_GRID_JANK_ONE_K_WORKLOAD_ID,
	SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID
]);

/**
 * Recompute the jank summary from raw frame intervals. Shared by the page-side
 * collector and the Node-side validator so both sides agree on the definition.
 *
 * @param {number[]} frameIntervalsMs
 * @param {number} vsyncMs
 * @param {number} frameMultiplier
 */
export function summarizeJankIntervals(frameIntervalsMs, vsyncMs, frameMultiplier) {
	if (!Array.isArray(frameIntervalsMs) || frameIntervalsMs.length === 0) {
		throw new Error('Jank trace frame intervals are missing.');
	}
	if (!Number.isFinite(vsyncMs) || vsyncMs <= 0) {
		throw new Error('Jank trace vsync interval must be a positive finite number.');
	}
	if (!Number.isFinite(frameMultiplier) || frameMultiplier < 1) {
		throw new Error('Jank trace frame multiplier must be at least 1.');
	}
	let durationMs = 0;
	let jankFrameCount = 0;
	const jankThresholdMs = frameMultiplier * vsyncMs;
	for (const [index, interval] of frameIntervalsMs.entries()) {
		if (!Number.isFinite(interval) || interval <= 0) {
			throw new Error(`Jank trace frame interval ${index} must be a positive finite number.`);
		}
		durationMs += interval;
		if (interval > jankThresholdMs) jankFrameCount += 1;
	}
	return {
		durationMs,
		frameCount: frameIntervalsMs.length + 1,
		jankThresholdMs,
		jankFrameCount,
		jankRate: jankFrameCount / frameIntervalsMs.length
	};
}

/**
 * Page-side collector. Injected into the benchmark page, so it must stay
 * self-contained apart from the injected `summarizeJankIntervals` helper.
 *
 * @param {{ frameMultiplier: number }} options
 */
export function createJankTraceCollector(options = {}) {
	const frameMultiplier = options.frameMultiplier;
	if (!Number.isFinite(frameMultiplier) || frameMultiplier < 1) {
		throw new Error('Jank trace collector requires a frame multiplier of at least 1.');
	}
	function intervalsFromTimestamps(timestamps) {
		const intervals = [];
		for (let index = 1; index < timestamps.length; index += 1) {
			intervals.push(timestamps[index] - timestamps[index - 1]);
		}
		return intervals;
	}
	function median(values) {
		const sorted = [...values].sort((left, right) => left - right);
		return sorted[Math.floor(sorted.length / 2)];
	}
	return {
		async calibrate(frameCount) {
			if (!Number.isSafeInteger(frameCount) || frameCount < 2) {
				throw new Error('Jank trace calibration requires at least two frames.');
			}
			const timestamps = await new Promise(resolve => {
				const frames = [];
				const step = timestamp => {
					frames.push(timestamp);
					if (frames.length >= frameCount) {
						resolve(frames);
						return;
					}
					requestAnimationFrame(step);
				};
				requestAnimationFrame(step);
			});
			const intervals = intervalsFromTimestamps(timestamps);
			return { frameCount, medianMs: median(intervals) };
		},
		begin() {
			const session = { timestamps: [], stopped: false };
			const step = timestamp => {
				if (session.stopped) return;
				session.timestamps.push(timestamp);
				requestAnimationFrame(step);
			};
			requestAnimationFrame(step);
			return session;
		},
		end(session, calibration) {
			if (!session || typeof session !== 'object' || session.stopped) {
				throw new Error('Jank trace session is missing or already stopped.');
			}
			session.stopped = true;
			const vsyncMs = calibration?.medianMs;
			const summary = summarizeJankIntervals(intervalsFromTimestamps(session.timestamps), vsyncMs, frameMultiplier);
			return {
				version: SQL_RESULT_GRID_JANK_TRACE_VERSION,
				timingClock: 'performance-now',
				correlation: SQL_RESULT_GRID_JANK_CORRELATION,
				vsyncSource: SQL_RESULT_GRID_JANK_VSYNC_SOURCE,
				vsyncCalibrationFrames: calibration.frameCount,
				vsyncMs,
				frameMultiplier,
				jankThresholdMs: summary.jankThresholdMs,
				durationMs: summary.durationMs,
				frameCount: summary.frameCount,
				frameIntervalsMs: intervalsFromTimestamps(session.timestamps),
				jankFrameCount: summary.jankFrameCount,
				jankRate: summary.jankRate
			};
		}
	};
}

/**
 * Page-side helper that waits until the driver sets a control flag. Polls with
 * timers instead of frames so a paused renderer cannot deadlock the trace.
 */
export function waitForJankTraceFlag(control, flag, timeoutMs) {
	return new Promise((resolve, reject) => {
		const deadline = performance.now() + timeoutMs;
		const poll = () => {
			if (control[flag] === true) {
				resolve();
				return;
			}
			if (performance.now() > deadline) {
				reject(new Error(`Jank trace control flag ${flag} was not set within ${timeoutMs}ms.`));
				return;
			}
			setTimeout(poll, 10);
		};
		poll();
	});
}

export function isJankTraceRecord(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireJankTraceClose(actual, expected, name, fail, epsilon = 1e-6) {
	if (!Number.isFinite(actual) || Math.abs(actual - expected) > epsilon * Math.max(1, Math.abs(expected))) {
		fail(`${name} does not recompute from the recorded samples.`);
	}
}

/**
 * Both axes must come from the renderer's explicit scroll controller. A
 * WorkbenchTable viewport's native scrollLeft does not track its internal
 * horizontal scrolling, so falling back to the viewport silently samples zero.
 */
export function createTraceScrollOffsets(rendered) {
	const scroll = rendered?.scroll;
	if (!Number.isFinite(scroll?.scrollTop) || !Number.isFinite(scroll?.scrollLeft)) {
		throw new Error('Jank trace requires an explicit scroll controller with finite scrollTop and scrollLeft.');
	}
	return scroll;
}

/**
 * Page-side sampler that records the scroll offsets of the traced viewport on
 * every animation frame. A trace is only admissible when the offsets show the
 * pre-registered bidirectional displacement, so a stalled or unbound viewport
 * cannot masquerade as a jank-free run.
 *
 * @param {{ scrollTop: number, scrollLeft: number }} element
 */
export function createScrollOffsetSampler(element) {
	if (!element || typeof element !== 'object') {
		throw new Error('Jank trace scroll sampler requires a scrollable element.');
	}
	if (typeof element.scrollTop !== 'number' || typeof element.scrollLeft !== 'number') {
		throw new Error('Jank trace scroll sampler requires an element with scroll offsets.');
	}
	const state = {
		stopped: false,
		sampleCount: 0,
		first: null,
		last: null,
		minTop: null,
		maxTop: null,
		minLeft: null,
		maxLeft: null
	};
	const step = () => {
		if (state.stopped) return;
		const top = element.scrollTop;
		const left = element.scrollLeft;
		if (state.first === null) state.first = { top, left };
		state.last = { top, left };
		state.minTop = state.minTop === null ? top : Math.min(state.minTop, top);
		state.maxTop = state.maxTop === null ? top : Math.max(state.maxTop, top);
		state.minLeft = state.minLeft === null ? left : Math.min(state.minLeft, left);
		state.maxLeft = state.maxLeft === null ? left : Math.max(state.maxLeft, left);
		state.sampleCount += 1;
		requestAnimationFrame(step);
	};
	requestAnimationFrame(step);
	return {
		stop() {
			state.stopped = true;
		},
		snapshot() {
			const minTop = state.minTop ?? 0;
			const maxTop = state.maxTop ?? 0;
			const minLeft = state.minLeft ?? 0;
			const maxLeft = state.maxLeft ?? 0;
			return {
				sampleCount: state.sampleCount,
				first: state.first,
				last: state.last,
				minTop,
				maxTop,
				minLeft,
				maxLeft,
				verticalSpanPx: maxTop - minTop,
				horizontalSpanPx: maxLeft - minLeft
			};
		}
	};
}

/**
 * Fail-closed validator for one merged jank trace snapshot.
 *
 * @param {object} snapshot
 * @param {{ expectedDurationMs?: number, expectedFrameMultiplier?: number, expectedVsyncCalibrationFrames?: number, expectedWorkload?: object, expectedTraceRunToken?: string }} options
 */
export function validateJankTraceSnapshot(snapshot, options = {}) {
	function fail(message) {
		throw new Error(`Jank trace ${message}`);
	}
	const expectedDurationMs = options.expectedDurationMs ?? SQL_RESULT_GRID_JANK_TRACE_DURATION_MS;
	const expectedFrameMultiplier = options.expectedFrameMultiplier ?? SQL_RESULT_GRID_JANK_FRAME_MULTIPLIER;
	const expectedVsyncCalibrationFrames =
		options.expectedVsyncCalibrationFrames ?? SQL_RESULT_GRID_JANK_VSYNC_CALIBRATION_FRAMES;
	if (!isJankTraceRecord(snapshot)) fail('snapshot is missing.');
	if (snapshot.version !== SQL_RESULT_GRID_JANK_TRACE_VERSION) fail('version is invalid.');
	if (snapshot.timingClock !== 'performance-now') fail('timing clock is invalid.');
	if (snapshot.correlation !== SQL_RESULT_GRID_JANK_CORRELATION) fail('correlation contract is invalid.');
	if (snapshot.vsyncSource !== SQL_RESULT_GRID_JANK_VSYNC_SOURCE) fail('vsync source is invalid.');
	if (snapshot.vsyncCalibrationFrames !== expectedVsyncCalibrationFrames) {
		fail(`vsync calibration frame count must be ${expectedVsyncCalibrationFrames}.`);
	}
	if (snapshot.frameMultiplier !== expectedFrameMultiplier) {
		fail(`frame multiplier must be ${expectedFrameMultiplier}.`);
	}
	if (!Number.isFinite(snapshot.vsyncMs) || snapshot.vsyncMs <= 0) fail('vsync interval is invalid.');
	if (!Array.isArray(snapshot.frameIntervalsMs)) fail('frame intervals are missing.');
	if (snapshot.frameIntervalsMs.length < SQL_RESULT_GRID_JANK_MINIMUM_FRAME_INTERVALS) {
		fail(`frame interval count must be at least ${SQL_RESULT_GRID_JANK_MINIMUM_FRAME_INTERVALS}.`);
	}
	const summary = summarizeJankIntervals(snapshot.frameIntervalsMs, snapshot.vsyncMs, snapshot.frameMultiplier);
	if (snapshot.frameCount !== summary.frameCount) fail('frame count does not recompute from the raw frame intervals.');
	requireJankTraceClose(snapshot.durationMs, summary.durationMs, 'duration', fail);
	requireJankTraceClose(snapshot.jankThresholdMs, summary.jankThresholdMs, 'jank threshold', fail);
	if (snapshot.jankFrameCount !== summary.jankFrameCount) {
		fail('jank frame count does not recompute from the raw frame intervals.');
	}
	requireJankTraceClose(snapshot.jankRate, summary.jankRate, 'jank rate', fail);
	if (snapshot.durationMs < expectedDurationMs * 0.8 || snapshot.durationMs > expectedDurationMs * 3) {
		fail(`trace duration ${snapshot.durationMs}ms is outside the expected ${expectedDurationMs}ms window.`);
	}
	if (typeof snapshot.traceRunToken !== 'string' || !/^[0-9a-f-]{36}$/.test(snapshot.traceRunToken)) {
		fail('trace run token is invalid.');
	}
	if (options.expectedTraceRunToken && snapshot.traceRunToken !== options.expectedTraceRunToken) {
		fail('trace run token does not match the expected run.');
	}
	const expectedWorkload = options.expectedWorkload;
	if (expectedWorkload) {
		if (snapshot.workloadId !== expectedWorkload.id) fail('workload id does not match the expected workload.');
		if (
			!isJankTraceRecord(snapshot.workload) ||
			snapshot.workload.rows !== expectedWorkload.rows ||
			snapshot.workload.columns !== expectedWorkload.columns
		) {
			fail('workload shape does not match the expected workload.');
		}
	}
	const scrollOffsets = snapshot.scrollOffsets;
	if (!isJankTraceRecord(scrollOffsets)) fail('scroll offsets are missing.');
	for (const key of ['minTop', 'maxTop', 'minLeft', 'maxLeft']) {
		if (!Number.isFinite(scrollOffsets[key])) fail(`scroll offset ${key} is invalid.`);
	}
	for (const key of ['first', 'last']) {
		if (!isJankTraceRecord(scrollOffsets[key])) fail(`scroll offset ${key} sample is missing.`);
		if (!Number.isFinite(scrollOffsets[key].top) || !Number.isFinite(scrollOffsets[key].left)) {
			fail(`scroll offset ${key} sample is invalid.`);
		}
	}
	if (scrollOffsets.maxTop < scrollOffsets.minTop || scrollOffsets.maxLeft < scrollOffsets.minLeft) {
		fail('scroll offset bounds are inverted.');
	}
	if (
		!Number.isSafeInteger(scrollOffsets.sampleCount) ||
		scrollOffsets.sampleCount < SQL_RESULT_GRID_JANK_MINIMUM_FRAME_INTERVALS
	) {
		fail(`scroll offset sample count must be at least ${SQL_RESULT_GRID_JANK_MINIMUM_FRAME_INTERVALS}.`);
	}
	requireJankTraceClose(scrollOffsets.verticalSpanPx, scrollOffsets.maxTop - scrollOffsets.minTop, 'vertical scroll span', fail);
	requireJankTraceClose(
		scrollOffsets.horizontalSpanPx,
		scrollOffsets.maxLeft - scrollOffsets.minLeft,
		'horizontal scroll span',
		fail
	);
	if (scrollOffsets.verticalSpanPx < SQL_RESULT_GRID_JANK_MINIMUM_VERTICAL_SPAN_PX) {
		fail(
			`vertical scroll span ${scrollOffsets.verticalSpanPx}px is below the pre-registered ${SQL_RESULT_GRID_JANK_MINIMUM_VERTICAL_SPAN_PX}px.`
		);
	}
	if (scrollOffsets.horizontalSpanPx < SQL_RESULT_GRID_JANK_MINIMUM_HORIZONTAL_SPAN_PX) {
		fail(
			`horizontal scroll span ${scrollOffsets.horizontalSpanPx}px is below the pre-registered ${SQL_RESULT_GRID_JANK_MINIMUM_HORIZONTAL_SPAN_PX}px.`
		);
	}
	const inputPlan = snapshot.inputPlan;
	if (!isJankTraceRecord(inputPlan)) fail('input plan is missing.');
	if (inputPlan.source !== SQL_RESULT_GRID_JANK_INPUT_SOURCE) fail('input plan source is invalid.');
	if (inputPlan.durationMs !== expectedDurationMs) fail('input plan duration is invalid.');
	if (!Array.isArray(inputPlan.segments) || inputPlan.segments.length !== SQL_RESULT_GRID_JANK_INPUT_SEGMENTS.length) {
		fail('input plan segments are missing.');
	}
	for (const [index, expectedSegment] of SQL_RESULT_GRID_JANK_INPUT_SEGMENTS.entries()) {
		const segment = inputPlan.segments[index];
		if (
			!isJankTraceRecord(segment) ||
			segment.label !== expectedSegment.label ||
			segment.deltaX !== expectedSegment.deltaX ||
			segment.deltaY !== expectedSegment.deltaY
		) {
			fail(`input plan segment ${index} does not match the pre-registered wheel plan.`);
		}
	}
	const minimumEventCount = Math.ceil(expectedDurationMs / 100);
	if (!Number.isSafeInteger(inputPlan.eventCount) || inputPlan.eventCount < minimumEventCount) {
		fail(`input plan event count must be at least ${minimumEventCount}.`);
	}
	if (!Number.isFinite(inputPlan.dispatchDurationMs) || inputPlan.dispatchDurationMs < expectedDurationMs * 0.5) {
		fail('input plan dispatch duration is invalid.');
	}
	if (Math.abs(snapshot.durationMs - inputPlan.dispatchDurationMs) > 1_000) {
		fail('trace duration does not match the wheel dispatch window.');
	}
	return snapshot;
}

function createSeededRandom(seed) {
	let state = seed >>> 0;
	return function random() {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function percentile(sortedValues, quantile) {
	const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor(quantile * sortedValues.length)));
	return sortedValues[index];
}

export function createBootstrapUpperBound(resamples, seed, values) {
	const finite = values.filter(Number.isFinite);
	if (finite.length === 0) {
		return {
			level: 0.95,
			method: 'percentile',
			sidedness: 'upper',
			quantile: 0.95,
			resamples,
			seed,
			available: false,
			lower: null,
			upper: null
		};
	}
	const sorted = [...finite].sort((left, right) => left - right);
	return {
		level: 0.95,
		method: 'percentile',
		sidedness: 'upper',
		quantile: 0.95,
		resamples,
		seed,
		available: finite.length === values.length,
		lower: null,
		upper: percentile(sorted, 0.95)
	};
}

function bootstrapPairedRuns(pairs, options = {}) {
	const resamples = options.resamples ?? SQL_RESULT_GRID_JANK_BOOTSTRAP_RESAMPLES;
	const seed = options.seed ?? SQL_RESULT_GRID_JANK_BOOTSTRAP_SEED;
	const random = createSeededRandom(seed);
	const ratios = [];
	const differences = [];
	for (let resample = 0; resample < resamples; resample += 1) {
		let zeusJankFrameCount = 0;
		let zeusFrameIntervalCount = 0;
		let workbenchTableJankFrameCount = 0;
		let workbenchTableFrameIntervalCount = 0;
		for (let draw = 0; draw < pairs.length; draw += 1) {
			const pair = pairs[Math.floor(random() * pairs.length)];
			zeusJankFrameCount += pair.zeus.jankFrameCount;
			zeusFrameIntervalCount += pair.zeus.frameIntervalCount;
			workbenchTableJankFrameCount += pair.workbenchTable.jankFrameCount;
			workbenchTableFrameIntervalCount += pair.workbenchTable.frameIntervalCount;
		}
		const zeusRate = zeusJankFrameCount / zeusFrameIntervalCount;
		const workbenchTableRate = workbenchTableJankFrameCount / workbenchTableFrameIntervalCount;
		ratios.push(workbenchTableRate > 0 ? zeusRate / workbenchTableRate : Number.NaN);
		differences.push(zeusRate - workbenchTableRate);
	}
	return {
		ratio: createBootstrapUpperBound(resamples, seed, ratios),
		difference: createBootstrapUpperBound(resamples, seed, differences)
	};
}

function summarizeRendererRuns(records) {
	const perRunRates = records
		.map(record => ({
			iteration: record.iteration,
			frameCount: record.diagnostics.jankTrace.frameCount,
			frameIntervalCount: record.diagnostics.jankTrace.frameIntervalsMs.length,
			jankFrameCount: record.diagnostics.jankTrace.jankFrameCount,
			jankRate: record.diagnostics.jankTrace.jankRate
		}))
		.sort((left, right) => left.iteration - right.iteration);
	const frameCount = perRunRates.reduce((total, run) => total + run.frameCount, 0);
	const frameIntervalCount = perRunRates.reduce((total, run) => total + run.frameIntervalCount, 0);
	const jankFrameCount = perRunRates.reduce((total, run) => total + run.jankFrameCount, 0);
	return {
		recordCount: perRunRates.length,
		frameCount,
		frameIntervalCount,
		jankFrameCount,
		jankRate: frameIntervalCount > 0 ? jankFrameCount / frameIntervalCount : null,
		perRunRates
	};
}

/**
 * Build the workload-scoped diagnostic jank profile from a diagnostic benchmark
 * report. Fails closed on missing traces, non-ok records, unpaired iterations,
 * and unsupported workloads.
 *
 * @param {object} report
 * @param {string} workloadId
 */
export function createSqlResultGridJankProfile(report, workloadId) {
	if (!supportedWorkloads.has(workloadId)) {
		throw new Error(`Jank profile workload must be one of: ${[...supportedWorkloads].join(', ')}.`);
	}
	if (!isJankTraceRecord(report) || !Array.isArray(report.records)) {
		throw new TypeError('A benchmark report with records is required.');
	}
	const metadata = report.diagnosticProfile?.jankTrace;
	if (!isJankTraceRecord(metadata)) {
		throw new Error('Benchmark diagnostic jank trace metadata is missing.');
	}
	if (metadata.version !== SQL_RESULT_GRID_JANK_TRACE_VERSION) {
		throw new Error(`Benchmark diagnostic jank trace version must be ${SQL_RESULT_GRID_JANK_TRACE_VERSION}.`);
	}
	if (metadata.correlation !== SQL_RESULT_GRID_JANK_CORRELATION) {
		throw new Error('Benchmark diagnostic jank trace correlation is invalid.');
	}
	if (metadata.inputSource !== SQL_RESULT_GRID_JANK_INPUT_SOURCE) {
		throw new Error('Benchmark diagnostic jank trace input source is invalid.');
	}
	if (metadata.durationMs !== SQL_RESULT_GRID_JANK_TRACE_DURATION_MS) {
		throw new Error(`Benchmark diagnostic jank trace duration must be ${SQL_RESULT_GRID_JANK_TRACE_DURATION_MS}.`);
	}
	if (metadata.frameMultiplier !== SQL_RESULT_GRID_JANK_FRAME_MULTIPLIER) {
		throw new Error(`Benchmark diagnostic jank trace frame multiplier must be ${SQL_RESULT_GRID_JANK_FRAME_MULTIPLIER}.`);
	}
	if (metadata.vsyncCalibrationFrames !== SQL_RESULT_GRID_JANK_VSYNC_CALIBRATION_FRAMES) {
		throw new Error(
			`Benchmark diagnostic jank trace vsync calibration must be ${SQL_RESULT_GRID_JANK_VSYNC_CALIBRATION_FRAMES} frames.`
		);
	}
	const workloadRecords = report.records.filter(record => record.workloadId === workloadId);
	if (workloadRecords.length === 0) {
		throw new Error(`Jank trace records for workload ${workloadId} are missing.`);
	}
	const nonOkRecord = workloadRecords.find(record => record.status !== 'ok');
	if (nonOkRecord) {
		throw new Error(`Jank trace workload ${workloadId} contains a non-ok ${nonOkRecord.renderer} record.`);
	}
	const rendererRecords = {
		zeus: workloadRecords.filter(record => record.renderer === 'zeus'),
		'workbench-table': workloadRecords.filter(record => record.renderer === 'workbench-table')
	};
	if (rendererRecords.zeus.length === 0 || rendererRecords['workbench-table'].length === 0) {
		throw new Error(`Jank trace workload ${workloadId} requires both zeus and workbench-table records.`);
	}
	for (const record of workloadRecords) {
		validateJankTraceSnapshot(record.diagnostics?.jankTrace, {
			expectedDurationMs: metadata.durationMs,
			expectedFrameMultiplier: metadata.frameMultiplier,
			expectedVsyncCalibrationFrames: metadata.vsyncCalibrationFrames
		});
	}
	const zeusByIteration = new Map(rendererRecords.zeus.map(record => [record.iteration, record]));
	const workbenchTableByIteration = new Map(
		rendererRecords['workbench-table'].map(record => [record.iteration, record])
	);
	if (zeusByIteration.size !== rendererRecords.zeus.length || workbenchTableByIteration.size !== rendererRecords['workbench-table'].length) {
		throw new Error(`Jank trace workload ${workloadId} has duplicate renderer iterations.`);
	}
	if (zeusByIteration.size !== workbenchTableByIteration.size) {
		throw new Error(`Jank trace workload ${workloadId} renderer runs are not paired.`);
	}
	const pairs = [];
	for (const [iteration, zeusRecord] of zeusByIteration) {
		const workbenchTableRecord = workbenchTableByIteration.get(iteration);
		if (!workbenchTableRecord) {
			throw new Error(`Jank trace workload ${workloadId} iteration ${iteration} is not paired.`);
		}
		pairs.push({
			iteration,
			zeus: {
				frameIntervalCount: zeusRecord.diagnostics.jankTrace.frameIntervalsMs.length,
				jankFrameCount: zeusRecord.diagnostics.jankTrace.jankFrameCount
			},
			workbenchTable: {
				frameIntervalCount: workbenchTableRecord.diagnostics.jankTrace.frameIntervalsMs.length,
				jankFrameCount: workbenchTableRecord.diagnostics.jankTrace.jankFrameCount
			}
		});
	}
	pairs.sort((left, right) => left.iteration - right.iteration);
	const zeusSummary = summarizeRendererRuns(rendererRecords.zeus);
	const workbenchTableSummary = summarizeRendererRuns(rendererRecords['workbench-table']);
	const bootstrap = bootstrapPairedRuns(pairs);
	const baselineEvaluable = workbenchTableSummary.jankRate >= SQL_RESULT_GRID_JANK_MINIMUM_BASELINE_RATE;
	const superiorityWorkload = workloadId === SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID;
	const threshold = superiorityWorkload
		? SQL_RESULT_GRID_JANK_TEN_K_RATIO_THRESHOLD
		: SQL_RESULT_GRID_JANK_ONE_K_DIFFERENCE_THRESHOLD;
	const interval = superiorityWorkload ? bootstrap.ratio : bootstrap.difference;
	const evaluable = superiorityWorkload ? baselineEvaluable && interval.available : interval.available;
	const upperBound = evaluable ? interval.upper : null;
	return {
		version: SQL_RESULT_GRID_JANK_TRACE_VERSION,
		workloadId,
		correlation: SQL_RESULT_GRID_JANK_CORRELATION,
		inputSource: SQL_RESULT_GRID_JANK_INPUT_SOURCE,
		frameMultiplier: SQL_RESULT_GRID_JANK_FRAME_MULTIPLIER,
		vsyncCalibrationFrames: SQL_RESULT_GRID_JANK_VSYNC_CALIBRATION_FRAMES,
		pairedRunCount: pairs.length,
		recordCounts: {
			total: workloadRecords.length,
			zeus: rendererRecords.zeus.length,
			workbenchTable: rendererRecords['workbench-table'].length
		},
		renderers: {
			zeus: zeusSummary,
			workbenchTable: workbenchTableSummary
		},
		baselinePointEstimate: workbenchTableSummary.jankRate,
		ratioPointEstimate:
			workbenchTableSummary.jankRate > 0 ? zeusSummary.jankRate / workbenchTableSummary.jankRate : null,
		differencePointEstimate: zeusSummary.jankRate - workbenchTableSummary.jankRate,
		ratioConfidenceInterval: bootstrap.ratio,
		differenceConfidenceInterval: bootstrap.difference,
		thresholdEvaluation: {
			metric: superiorityWorkload ? 'ratio' : 'difference',
			threshold,
			definition: 'paired-bootstrap one-sided 95% upper bound',
			evaluable,
			notEvaluableReason: evaluable
				? null
				: superiorityWorkload && !baselineEvaluable
					? `WorkbenchTable baseline jank rate is below ${SQL_RESULT_GRID_JANK_MINIMUM_BASELINE_RATE * 100}%.`
				: 'The paired-bootstrap ratio upper bound is unavailable because one or more resamples hit a zero baseline rate.',
			upperBound,
			withinThreshold: evaluable && upperBound !== null ? upperBound <= threshold : null,
			outcome: !evaluable
				? 'NOT-EVALUABLE'
				: upperBound <= threshold
					? 'UPPER-BOUND-WITHIN-THRESHOLD'
					: 'UPPER-BOUND-EXCEEDS-THRESHOLD'
		},
		limitations: [...SQL_RESULT_GRID_JANK_TRACE_LIMITATIONS]
	};
}
