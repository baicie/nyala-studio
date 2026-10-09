/** Diagnostic-only, node-observer-free timing attribution for one scroll run. */
export const SQL_RESULT_GRID_SEGMENT_TRACE_VERSION = 1;
export const SQL_RESULT_GRID_SEGMENT_TRACE_CORRELATION = 'scroll-input-handler-range-commit-visible-paint-v1';
export const SQL_RESULT_GRID_SEGMENT_TRACE_INSTRUMENTATION = 'observer-free-v1';
export const SQL_RESULT_GRID_SEGMENT_TRACE_MAX_FRAMES = 8;

/**
 * Page-side helper. It is stringified into the benchmark document, so keep it
 * self-contained and pass all renderer-specific helpers through options.
 */
export async function runObserverFreeSegmentTrace(rendered, options = {}) {
	const maxFrames = options.maxFrames ?? SQL_RESULT_GRID_SEGMENT_TRACE_MAX_FRAMES;
	const targetRatios = options.targetRatios ?? [];
	const rowCount = options.rowCount ?? 0;
	const rowTolerance = options.rowTolerance ?? 2;
	const getVisibleRowIndex = options.getVisibleRowIndex;
	const expectedVisibleRowIndex = options.expectedVisibleRowIndex;
	if (!rendered?.scroll || !Array.isArray(targetRatios) || targetRatios.length === 0) {
		throw new Error('Observer-free segment trace requires a scroll controller and targets.');
	}
	if (typeof getVisibleRowIndex !== 'function' || typeof expectedVisibleRowIndex !== 'function') {
		throw new Error('Observer-free segment trace requires visible-row helpers.');
	}

	const diagnostics = rendered.zeusDiagnostics ?? rendered.diagnostics;
	const segments = [];
	const waitForFrame = () =>
		new Promise(resolve => {
			requestAnimationFrame(timestamp => {
				const rafTime = performance.now();
				const rafVisibleRowIndex = getVisibleRowIndex(rendered);
				setTimeout(
					() =>
						resolve({
							timestamp,
							rafTime,
							taskTime: performance.now(),
							rafVisibleRowIndex,
							taskVisibleRowIndex: getVisibleRowIndex(rendered)
						}),
					0
				);
			});
		});

	async function traceScroll(targetOffset, sampleIndex, phase) {
		const diagnosticSampleIndex = phase === 'sample' ? sampleIndex : null;
		const zeusOperation = rendered.zeusDiagnostics?.beginOperation(phase, diagnosticSampleIndex);
		const workbenchOperation = rendered.diagnostics?.beginOperation(phase, diagnosticSampleIndex);
		const inputStartTime = performance.now();
		rendered.scroll.scrollTop = targetOffset;
		const inputEndTime = performance.now();
		// Let the browser dispatch the native scroll event before sampling the next frame.
		await new Promise(resolve => setTimeout(resolve, 0));
		let firstVisibleTime;
		let firstVisiblePhase;
		let nextPaintRafTime;
		let nextPaintTaskTime;
		let visibleRowIndex = -1;
		let attempts = 0;
		for (; attempts < maxFrames; attempts += 1) {
			const frame = await waitForFrame();
			nextPaintRafTime ??= frame.rafTime;
			nextPaintTaskTime ??= frame.taskTime;
			for (const [phaseName, candidate] of [
				['raf', frame.rafVisibleRowIndex],
				['task', frame.taskVisibleRowIndex]
			]) {
				const expectedAtFrame = expectedVisibleRowIndex(rendered.scroll.scrollTop);
				if (
					Number.isInteger(candidate) &&
					candidate >= 0 &&
					candidate < rowCount &&
					Math.abs(candidate - expectedAtFrame) <= rowTolerance &&
					firstVisibleTime === undefined
				) {
					firstVisibleTime = phaseName === 'raf' ? frame.rafTime : frame.taskTime;
					firstVisiblePhase = phaseName;
					visibleRowIndex = candidate;
				}
			}
			if (firstVisibleTime !== undefined) {
				// Scroll events are dispatched asynchronously; keep the operation open
				// through one more presentation opportunity so the rAF commit is captured.
				await waitForFrame();
				for (let wait = 0; wait < maxFrames; wait += 1) {
					const commits = diagnostics?.snapshot?.().commits ?? [];
					const cursor = zeusOperation?.commitCursor ?? workbenchOperation?.commitCursor ?? 0;
					if (commits.slice(cursor).some(commit => commit.source === 'scroll')) break;
					await waitForFrame();
				}
				break;
			}
		}
		visibleRowIndex = getVisibleRowIndex(rendered);
		const actualOffset = rendered.scroll.scrollTop;
		const expectedRowIndex = expectedVisibleRowIndex(actualOffset);
		const rowDelta = Math.abs(visibleRowIndex - expectedRowIndex);
		if (zeusOperation || workbenchOperation) await Promise.resolve();
		const zeusCorrelation = zeusOperation ? rendered.zeusDiagnostics.endOperation(zeusOperation) : undefined;
		const workbenchCorrelation = workbenchOperation ? rendered.diagnostics.endOperation(workbenchOperation) : undefined;
		if (firstVisibleTime === undefined) {
			throw new Error(`Observer-free segment trace did not observe a visible row for ${phase}/${sampleIndex}.`);
		}
		return {
			phase,
			sampleIndex,
			targetOffset,
			actualOffset,
			expectedRowIndex,
			visibleRowIndex,
			rowDelta,
			attempts: attempts + 1,
			inputStartTime,
			inputEndTime,
			firstVisibleTime,
			firstVisiblePhase,
			nextPaintRafTime,
			nextPaintTaskTime,
			commitTransactionIds: zeusCorrelation?.commitTransactionIds ?? workbenchCorrelation?.commitTransactionIds ?? [],
			primaryCommitTransactionId:
				zeusCorrelation?.primaryCommitTransactionId ?? workbenchCorrelation?.primaryCommitTransactionId ?? null
		};
	}

	const maximumOffset = Math.max(0, rendered.scroll.scrollHeight - rendered.scroll.clientHeight);
	if (maximumOffset <= 1) throw new Error('Observer-free segment trace has no scroll range.');
	segments.push(await traceScroll(maximumOffset, null, 'preposition'));
	for (let sampleIndex = 0; sampleIndex < targetRatios.length; sampleIndex += 1) {
		const [numerator, denominator] = targetRatios[sampleIndex];
		segments.push(await traceScroll((maximumOffset * numerator) / denominator, sampleIndex, 'sample'));
	}
	segments.push(await traceScroll(0, null, 'reset'));

	const diagnosticSnapshot = rendered.zeusDiagnostics?.snapshot() ?? rendered.diagnostics?.snapshot();
	const commitById = new Map((diagnosticSnapshot?.commits ?? []).map(commit => [commit.transactionId, commit]));
	for (const segment of segments) {
		const commit = commitById.get(segment.primaryCommitTransactionId);
		if (!commit) continue;
		for (const field of [
			'handlerStartTime',
			'handlerEndTime',
			'rangeStartTime',
			'rangeCalculatedTime',
			'commitStartTime',
			'commitEndTime'
		]) {
			segment[field] = commit[field];
		}
	}
	return {
		version: 1,
		timingClock: 'performance-now',
		correlation: 'scroll-input-handler-range-commit-visible-paint-v1',
		instrumentation: 'observer-free-v1',
		observerFree: true,
		domObserverFree: true,
		diagnosticsCallback: true,
		measureNodeChurn: false,
		maximumOffset,
		segments,
		diagnostics: diagnosticSnapshot
	};
}

export function validateObserverFreeSegmentTraceSnapshot(snapshot, options = {}) {
	function fail(message) {
		throw new Error(`Observer-free segment trace ${message}`);
	}
	if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) fail('snapshot is missing.');
	if (snapshot.version !== SQL_RESULT_GRID_SEGMENT_TRACE_VERSION) fail('version is invalid.');
	if (snapshot.timingClock !== 'performance-now') fail('timing clock is invalid.');
	if (snapshot.correlation !== SQL_RESULT_GRID_SEGMENT_TRACE_CORRELATION) fail('correlation is invalid.');
	if (snapshot.instrumentation !== SQL_RESULT_GRID_SEGMENT_TRACE_INSTRUMENTATION) fail('instrumentation is invalid.');
	if (
		snapshot.observerFree !== true ||
		snapshot.domObserverFree !== true ||
		snapshot.diagnosticsCallback !== true ||
		snapshot.measureNodeChurn !== false
	)
		fail('observer-free flags are invalid.');
	if (!Number.isFinite(snapshot.maximumOffset) || snapshot.maximumOffset <= 1) fail('maximum offset is invalid.');
	if (!Array.isArray(snapshot.segments) || snapshot.segments.length === 0) fail('segments are missing.');
	if (options.expectedSampleCount !== undefined && snapshot.segments.length !== options.expectedSampleCount)
		fail('segment count is invalid.');
	const commits = new Map((snapshot.diagnostics?.commits ?? []).map(commit => [commit.transactionId, commit]));
	let previousTransactionId = 0;
	for (const [index, segment] of snapshot.segments.entries()) {
		if (!segment || typeof segment !== 'object') fail(`segment ${index} is invalid.`);
		if (!['preposition', 'sample', 'reset'].includes(segment.phase)) fail(`segment ${index} phase is invalid.`);
		if (segment.phase !== 'sample' && segment.sampleIndex !== null) fail(`segment ${index} control index is invalid.`);
		if (segment.phase === 'sample' && segment.sampleIndex !== index - 1)
			fail(`segment ${index} sample index is invalid.`);
		for (const field of [
			'inputStartTime',
			'inputEndTime',
			'firstVisibleTime',
			'nextPaintRafTime',
			'nextPaintTaskTime'
		]) {
			if (!Number.isFinite(segment[field])) fail(`segment ${index} ${field} is invalid.`);
		}
		if (!(
			segment.inputStartTime <= segment.inputEndTime &&
			segment.inputEndTime <= segment.nextPaintRafTime &&
			segment.nextPaintRafTime <= segment.nextPaintTaskTime
		))
			fail(`segment ${index} input/paint ordering is invalid.`);
		if (segment.firstVisibleTime < segment.nextPaintRafTime || segment.firstVisibleTime > segment.nextPaintTaskTime)
			fail(`segment ${index} first-visible timing is invalid.`);
		if (!Number.isInteger(segment.visibleRowIndex) || segment.visibleRowIndex < 0)
			fail(`segment ${index} visible row is invalid.`);
		if (!Number.isInteger(segment.expectedRowIndex) || segment.expectedRowIndex < 0)
			fail(`segment ${index} expected row is invalid.`);
		if (!Number.isInteger(segment.rowDelta) || segment.rowDelta < 0 || segment.rowDelta > 2)
			fail(`segment ${index} row delta is invalid.`);
		if (
			!Array.isArray(segment.commitTransactionIds) ||
			(segment.commitTransactionIds.length === 0 && segment.phase === 'sample')
		)
			fail(`segment ${index} commits are missing.`);
		if (segment.commitTransactionIds.length === 0) continue;
		if (segment.primaryCommitTransactionId !== segment.commitTransactionIds.at(-1))
			fail(`segment ${index} primary commit is invalid.`);
		const commit = commits.get(segment.primaryCommitTransactionId);
		if (!commit) fail(`segment ${index} primary commit is missing.`);
		if (!(
			commit.handlerStartTime <= commit.handlerEndTime &&
			commit.handlerEndTime <= commit.rangeStartTime &&
			commit.rangeStartTime <= commit.rangeCalculatedTime &&
			commit.rangeCalculatedTime <= commit.commitStartTime &&
			commit.commitStartTime <= commit.commitEndTime
		))
			fail(`segment ${index} renderer timing is invalid.`);
		if (segment.primaryCommitTransactionId <= previousTransactionId) fail(`segment ${index} commits are out of order.`);
		previousTransactionId = segment.primaryCommitTransactionId;
	}
	return snapshot;
}
