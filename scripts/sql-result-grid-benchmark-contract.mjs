export const MEASUREMENT_CONTRACT_VERSION = 6;
export const EXECUTION_ORDER = 'renderer-balanced-rotation-v1';
export const SCROLL_COMMIT_BOUNDARY = 'post-presentation-opportunity';
export const WORKBENCH_TABLE_IMPLEMENTATION_ID = 'vs.platform.list.browser.WorkbenchTable';
export const WORKBENCH_TABLE_RUNTIME_PROOF = 'exact-prototype-and-monaco-dom-v1';
export const WORKBENCH_TABLE_CHARACTERIZATION_ID = 'nyala.benchmark.fixed-row-virtual-list-characterization';
export const ROW_HEIGHT = 28;
export const HEADER_HEIGHT = 28;
export const RESERVED_VIEWPORT_HEIGHT = 20;
export const SCROLLBAR_THICKNESS_ESTIMATE = 15;
export const MAX_VIRTUAL_ROW_OVERSCAN = 16;
export const SCROLL_VIEWPORT_TOLERANCE = 16;
export const SCROLL_ROW_TOLERANCE = 2;
export const SCROLL_OFFSET_TOLERANCE = 1;
export const SCROLL_COMMIT_ATTEMPTS = 8;
export const SCROLL_TIMING_TOLERANCE_MS = 0.05;

export const SCROLL_TARGET_RATIOS = Object.freeze([
	[0, 1],
	[1, 1],
	[1, 9],
	[8, 9],
	[2, 9],
	[7, 9],
	[3, 9],
	[6, 9],
	[4, 9],
	[5, 9],
	[0, 1],
	[1, 1],
	[1, 8],
	[7, 8],
	[2, 8],
	[6, 8],
	[3, 8],
	[5, 8],
	[1, 1],
	[0, 1]
]);

export function createBalancedBenchmarkPlan(workloads, renderers, repeat) {
	const plan = [];
	let executionOrdinal = 1;
	for (let workloadIndex = 0; workloadIndex < workloads.length; workloadIndex += 1) {
		for (let iteration = 1; iteration <= repeat; iteration += 1) {
			const rendererOffset = (workloadIndex + iteration - 1) % renderers.length;
			for (let position = 0; position < renderers.length; position += 1) {
				plan.push({
					workload: workloads[workloadIndex],
					renderer: renderers[(rendererOffset + position) % renderers.length],
					iteration,
					executionOrdinal
				});
				executionOrdinal += 1;
			}
		}
	}
	return plan;
}

export function expectedScrollViewportHeight(workload) {
	return workload.height - RESERVED_VIEWPORT_HEIGHT - SCROLLBAR_THICKNESS_ESTIMATE;
}

export function maximumScrollOffset(rowCount, scrollViewportHeight) {
	return Math.max(0, rowCount * ROW_HEIGHT + HEADER_HEIGHT - scrollViewportHeight);
}

export function maximumVirtualRenderedRows(workload) {
	const viewportHeight = workload?.height ?? workload?.viewportHeight;
	if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0;
	const visibleRows = Math.ceil(
		Math.max(0, viewportHeight - RESERVED_VIEWPORT_HEIGHT - SCROLLBAR_THICKNESS_ESTIMATE) / ROW_HEIGHT
	);
	return visibleRows + MAX_VIRTUAL_ROW_OVERSCAN;
}

export function scrollTargetOffset(maximumOffset, sampleIndex) {
	const ratio = SCROLL_TARGET_RATIOS[sampleIndex];
	if (!ratio) throw new RangeError(`Unknown scroll sample index ${sampleIndex}`);
	return (maximumOffset * ratio[0]) / ratio[1];
}

export function expectedVisibleRowIndex(actualOffset, rowCount) {
	return Math.max(0, Math.min(rowCount - 1, Math.floor((actualOffset + ROW_HEIGHT / 2) / ROW_HEIGHT)));
}

export function isValidVisibleRowIndex(index, rowCount) {
	return Number.isInteger(index) && index >= 0 && index < rowCount;
}

export function isValidWorkbenchTableRendererImplementation(implementation, expectedBundleSha256) {
	return Boolean(
		implementation &&
		implementation.id === WORKBENCH_TABLE_IMPLEMENTATION_ID &&
		implementation.runtimeProof === WORKBENCH_TABLE_RUNTIME_PROOF &&
		implementation.exactPrototype === true &&
		implementation.domVerified === true &&
		typeof implementation.bundleSha256 === 'string' &&
		/^[a-f0-9]{64}$/.test(implementation.bundleSha256) &&
		(expectedBundleSha256 === undefined || implementation.bundleSha256 === expectedBundleSha256)
	);
}

export function waitForPresentationOpportunity(options = {}) {
	const requestFrame = options.requestFrame ?? globalThis.requestAnimationFrame?.bind(globalThis);
	const cancelFrame = options.cancelFrame ?? globalThis.cancelAnimationFrame?.bind(globalThis);
	const setTimer = options.setTimer ?? globalThis.setTimeout?.bind(globalThis);
	const clearTimer = options.clearTimer ?? globalThis.clearTimeout?.bind(globalThis);
	const timeoutMs = options.timeoutMs ?? 5_000;

	return new Promise((resolveOpportunity, rejectOpportunity) => {
		if (![requestFrame, cancelFrame, setTimer, clearTimer].every(callback => typeof callback === 'function')) {
			rejectOpportunity(new Error('Presentation opportunity APIs are unavailable.'));
			return;
		}

		let settled = false;
		let frameId;
		let afterFrameTimerId;
		const cleanup = () => {
			clearTimer(timeoutId);
			if (afterFrameTimerId !== undefined) clearTimer(afterFrameTimerId);
			if (frameId !== undefined) cancelFrame(frameId);
		};
		const finish = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolveOpportunity();
		};
		const timeoutId = setTimer(() => {
			if (settled) return;
			settled = true;
			cleanup();
			rejectOpportunity(new Error('Timed out waiting for a presentation opportunity.'));
		}, timeoutMs);
		frameId = requestFrame(() => {
			frameId = undefined;
			afterFrameTimerId = setTimer(finish, 0);
		});
	});
}

export function isBenchmarkResultForRun(record, expected) {
	return Boolean(
		record &&
		typeof record === 'object' &&
		record.runToken === expected.runToken &&
		record.renderer === expected.renderer &&
		record.measurementContractVersion === MEASUREMENT_CONTRACT_VERSION &&
		record.scrollCommitBoundary === SCROLL_COMMIT_BOUNDARY &&
		record.executionOrder === EXECUTION_ORDER &&
		record.executionOrder === expected.executionOrder &&
		record.executionOrdinal === expected.executionOrdinal &&
		record.workload?.rows === expected.workload.rows &&
		record.workload?.columns === expected.workload.columns &&
		record.workload?.wide === expected.workload.wide &&
		record.workload?.viewportWidth === expected.workload.width &&
		record.workload?.viewportHeight === expected.workload.height &&
		(expected.workbenchTableImplementation !== 'real' ||
			record.renderer !== 'workbench-table' ||
			isValidWorkbenchTableRendererImplementation(record.rendererImplementation, expected.workbenchTableBundleSha256))
	);
}
