export const WORKBENCH_TABLE_DIAGNOSTICS_VERSION = 1;
export const WORKBENCH_TABLE_DIAGNOSTICS_CORRELATION = 'sequential-callback-cursor-v1';
export const WORKBENCH_TABLE_DIAGNOSTICS_INSTRUMENTATION = 'listview-prototype-wrapper-v1';

/**
 * Emit renderer-owned CPU intervals for the repository WorkbenchTable scroll
 * path so that `Q95(cpu_zeus) / Q95(cpu_workbench-table)` becomes computable on
 * the same definitions the Zeus diagnostics sidecar uses.
 *
 * The collector wraps `ListView.prototype` methods before the table is
 * constructed, because `ListView` captures its scroll handler at construction
 * time (`this.scrollableElement.onScroll(this.onScroll, ...)`). Only calls that
 * happen inside an open operation window are recorded, so layout/splice renders
 * are never attributed to a scroll commit.
 *
 * Diagnostic only: this instrumentation never rewrites admission evidence.
 *
 * @param {{ ListViewPrototype: object }} options
 */
export function createWorkbenchTableDiagnosticCollector(options = {}) {
	const prototype = options?.ListViewPrototype;
	if (prototype === null || typeof prototype !== 'object') {
		throw new Error('WorkbenchTable diagnostics require the ListView prototype.');
	}
	const methodNames = ['onScroll', 'getRenderRange', 'render', 'measureItemWidth'];
	for (const methodName of methodNames) {
		if (typeof prototype[methodName] !== 'function') {
			throw new Error(`WorkbenchTable diagnostics require ListView.prototype.${methodName}.`);
		}
	}

	const originals = {
		onScroll: prototype.onScroll,
		getRenderRange: prototype.getRenderRange,
		render: prototype.render,
		measureItemWidth: prototype.measureItemWidth
	};
	const commits = [];
	const scrollOperations = [];
	const wrappers = {};
	let activeOperation;
	let activeTransaction;
	let nextTransactionId = 1;
	let disposed = false;

	function cloneTransaction(transaction) {
		return {
			transactionId: transaction.transactionId,
			source: transaction.source,
			handlerStartTime: transaction.handlerStartTime,
			handlerEndTime: transaction.handlerEndTime,
			rangeIntervals: transaction.rangeIntervals.map(interval => [interval[0], interval[1]]),
			commitIntervals: transaction.commitIntervals.map(interval => [interval[0], interval[1]]),
			layoutReadIntervals: transaction.layoutReadIntervals.map(interval => [interval[0], interval[1]]),
			firstRowIndex: transaction.renderedRange?.firstRowIndex ?? null,
			lastRowIndex: transaction.renderedRange?.lastRowIndex ?? null
		};
	}

	function cloneOperation(operation) {
		return {
			phase: operation.phase,
			sampleIndex: operation.sampleIndex,
			commitTransactionIds: [...operation.commitTransactionIds],
			primaryCommitTransactionId: operation.primaryCommitTransactionId
		};
	}

	wrappers.onScroll = prototype.onScroll = function (event) {
		if (activeOperation === undefined || activeTransaction !== undefined) {
			return originals.onScroll.call(this, event);
		}
		const transaction = {
			transactionId: nextTransactionId++,
			source: 'scroll',
			handlerStartTime: performance.now(),
			handlerEndTime: undefined,
			rangeIntervals: [],
			commitIntervals: [],
			layoutReadIntervals: [],
			renderedRange: undefined
		};
		activeTransaction = transaction;
		try {
			return originals.onScroll.call(this, event);
		} finally {
			transaction.handlerEndTime = performance.now();
			activeTransaction = undefined;
			commits.push(transaction);
		}
	};

	wrappers.getRenderRange = prototype.getRenderRange = function (renderTop, renderHeight) {
		const transaction = activeTransaction;
		if (transaction === undefined) {
			return originals.getRenderRange.call(this, renderTop, renderHeight);
		}
		const startedAt = performance.now();
		let range;
		try {
			range = originals.getRenderRange.call(this, renderTop, renderHeight);
			return range;
		} finally {
			transaction.rangeIntervals.push([startedAt, performance.now()]);
			if (range && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)) {
				transaction.renderedRange = { firstRowIndex: range.start, lastRowIndex: range.end - 1 };
			}
		}
	};

	wrappers.render = prototype.render = function (...args) {
		const transaction = activeTransaction;
		if (transaction === undefined) {
			return originals.render.apply(this, args);
		}
		const startedAt = performance.now();
		try {
			return originals.render.apply(this, args);
		} finally {
			transaction.commitIntervals.push([startedAt, performance.now()]);
		}
	};

	wrappers.measureItemWidth = prototype.measureItemWidth = function (item) {
		const transaction = activeTransaction;
		if (transaction === undefined) {
			return originals.measureItemWidth.call(this, item);
		}
		const startedAt = performance.now();
		try {
			return originals.measureItemWidth.call(this, item);
		} finally {
			transaction.layoutReadIntervals.push([startedAt, performance.now()]);
		}
	};

	return {
		beginOperation(phase, sampleIndex) {
			if (disposed) {
				throw new Error('WorkbenchTable diagnostics collector is disposed.');
			}
			if (activeOperation !== undefined) {
				throw new Error('WorkbenchTable diagnostics operations cannot be nested.');
			}
			activeOperation = { phase, sampleIndex, commitCursor: commits.length };
			return activeOperation;
		},
		endOperation(operation) {
			if (operation !== activeOperation) {
				throw new Error('WorkbenchTable diagnostics operations must be closed in order.');
			}
			if (activeTransaction !== undefined) {
				throw new Error('WorkbenchTable diagnostics operation ended with an open scroll transaction.');
			}
			activeOperation = undefined;
			const commitTransactionIds = commits.slice(operation.commitCursor).map(commit => commit.transactionId);
			const correlation = {
				phase: operation.phase,
				sampleIndex: operation.sampleIndex,
				commitTransactionIds,
				primaryCommitTransactionId: commitTransactionIds.at(-1) ?? null
			};
			scrollOperations.push(correlation);
			return cloneOperation(correlation);
		},
		snapshot() {
			return {
				version: 1,
				timingClock: 'performance-now',
				correlation: 'sequential-callback-cursor-v1',
				instrumentation: 'listview-prototype-wrapper-v1',
				commits: commits.map(cloneTransaction),
				scrollOperations: scrollOperations.map(cloneOperation)
			};
		},
		isInstalledOn(target) {
			return Boolean(
				target &&
				typeof target === 'object' &&
				Object.getPrototypeOf(target) === prototype &&
				prototype.onScroll === wrappers.onScroll &&
				prototype.render === wrappers.render
			);
		},
		dispose() {
			if (disposed) {
				return;
			}
			disposed = true;
			activeOperation = undefined;
			activeTransaction = undefined;
			for (const methodName of methodNames) {
				if (prototype[methodName] === wrappers[methodName]) {
					prototype[methodName] = originals[methodName];
				}
			}
		}
	};
}

export function validateWorkbenchTableDiagnosticSnapshot(snapshot, options) {
	function fail(message) {
		throw new Error(`WorkbenchTable diagnostics ${message}`);
	}

	function isRecord(value) {
		return value !== null && typeof value === 'object' && !Array.isArray(value);
	}

	function requireFinite(value, name) {
		if (!Number.isFinite(value)) fail(`${name} must be finite.`);
	}

	function requireCount(value, name) {
		if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a non-negative safe integer.`);
	}

	function requireIntervals(intervals, name) {
		if (!Array.isArray(intervals) || intervals.length === 0) fail(`${name} are missing.`);
		for (const [index, interval] of intervals.entries()) {
			if (!Array.isArray(interval) || interval.length !== 2) fail(`${name} interval ${index} is invalid.`);
			const [startTime, endTime] = interval;
			requireFinite(startTime, `${name} interval ${index} start`);
			requireFinite(endTime, `${name} interval ${index} end`);
			if (startTime > endTime) fail(`${name} interval ${index} timing is reversed.`);
		}
	}

	if (!isRecord(snapshot)) fail('snapshot is missing.');
	if (snapshot.version !== 1) fail('version must be 1.');
	if (snapshot.timingClock !== 'performance-now') fail('timing clock is invalid.');
	if (snapshot.correlation !== 'sequential-callback-cursor-v1') fail('correlation contract is invalid.');
	if (snapshot.instrumentation !== 'listview-prototype-wrapper-v1') fail('instrumentation contract is invalid.');
	if (!Array.isArray(snapshot.commits) || snapshot.commits.length === 0) fail('commits are missing.');
	if (!Array.isArray(snapshot.scrollOperations)) fail('scroll operations are missing.');

	const workload = options?.workload;
	if (!isRecord(workload) || !Number.isSafeInteger(workload.rows) || workload.rows < 1) {
		fail('benchmark workload shape is invalid.');
	}

	const commitById = new Map();
	let previousTransactionId = 0;
	for (let index = 0; index < snapshot.commits.length; index += 1) {
		const sample = snapshot.commits[index];
		if (!isRecord(sample)) fail(`commit ${index} is invalid.`);
		if (!Number.isSafeInteger(sample.transactionId) || sample.transactionId <= previousTransactionId) {
			fail(`commit ${index} transaction id is not strictly increasing.`);
		}
		previousTransactionId = sample.transactionId;
		if (sample.source !== 'scroll') fail(`commit ${index} source is invalid.`);
		requireFinite(sample.handlerStartTime, `commit ${index} handlerStartTime`);
		requireFinite(sample.handlerEndTime, `commit ${index} handlerEndTime`);
		if (sample.handlerStartTime > sample.handlerEndTime) fail(`commit ${index} handler timing is reversed.`);
		for (const field of ['rangeIntervals', 'commitIntervals', 'layoutReadIntervals']) {
			if (!Array.isArray(sample[field])) fail(`commit ${index} ${field} are missing.`);
		}
		requireIntervals(sample.rangeIntervals, `commit ${index} range`);
		requireIntervals(sample.commitIntervals, `commit ${index} commit`);
		for (const field of ['rangeIntervals', 'commitIntervals', 'layoutReadIntervals']) {
			for (const [intervalIndex, interval] of sample[field].entries()) {
				if (interval[0] < sample.handlerStartTime || interval[1] > sample.handlerEndTime) {
					fail(`commit ${index} ${field} interval ${intervalIndex} is outside the scroll handler window.`);
				}
			}
		}
		for (const [intervalIndex, interval] of sample.layoutReadIntervals.entries()) {
			const contained = sample.commitIntervals.some(
				commitInterval => interval[0] >= commitInterval[0] && interval[1] <= commitInterval[1]
			);
			if (!contained) {
				fail(`commit ${index} layout read interval ${intervalIndex} is outside every commit interval.`);
			}
		}
		requireCount(sample.firstRowIndex, `commit ${index} firstRowIndex`);
		requireCount(sample.lastRowIndex, `commit ${index} lastRowIndex`);
		if (sample.firstRowIndex > sample.lastRowIndex) fail(`commit ${index} rendered range is invalid.`);
		if (sample.lastRowIndex >= workload.rows) fail(`commit ${index} rendered range exceeds the benchmark workload.`);
		commitById.set(sample.transactionId, sample);
	}

	const expectedSampleCount = options?.expectedSampleCount;
	if (!Number.isSafeInteger(expectedSampleCount) || expectedSampleCount < 1) fail('expected sample count is invalid.');
	const scrollSamples = options?.scrollSamples;
	if (!Array.isArray(scrollSamples) || scrollSamples.length !== expectedSampleCount) {
		fail(`external scroll sample count must be ${expectedSampleCount}.`);
	}
	for (let sampleIndex = 0; sampleIndex < scrollSamples.length; sampleIndex += 1) {
		const sample = scrollSamples[sampleIndex];
		if (!isRecord(sample) || sample.sampleIndex !== sampleIndex) {
			fail(`external scroll sample ${sampleIndex} index is invalid.`);
		}
		for (const field of ['visibleRowIndex', 'expectedRowIndex']) {
			if (!Number.isSafeInteger(sample[field]) || sample[field] < 0 || sample[field] >= workload.rows) {
				fail(`external scroll sample ${sampleIndex} ${field} is invalid.`);
			}
		}
	}

	if (snapshot.scrollOperations.length !== expectedSampleCount + 2) {
		fail(`scroll operation count must be ${expectedSampleCount + 2}.`);
	}
	const expectedPhases = [
		{ phase: 'preposition', sampleIndex: null },
		...Array.from({ length: expectedSampleCount }, (_, sampleIndex) => ({ phase: 'sample', sampleIndex })),
		{ phase: 'reset', sampleIndex: null }
	];
	const claimedTransactions = new Set();
	let previousClaimedTransactionId = 0;
	for (let index = 0; index < expectedPhases.length; index += 1) {
		const operation = snapshot.scrollOperations[index];
		const expected = expectedPhases[index];
		if (!isRecord(operation) || operation.phase !== expected.phase || operation.sampleIndex !== expected.sampleIndex) {
			fail(`scroll operation ${index} phase or sample index is invalid.`);
		}
		if (!Array.isArray(operation.commitTransactionIds)) {
			fail(`scroll operation ${index} commit transactions are invalid.`);
		}
		if (operation.phase === 'sample' && operation.commitTransactionIds.length === 0) {
			fail(`scroll sample operation ${index} has no commit transactions.`);
		}
		if (operation.commitTransactionIds.length === 0) {
			if (operation.primaryCommitTransactionId !== null) {
				fail(`scroll operation ${index} primary transaction must be null.`);
			}
			continue;
		}
		if (operation.primaryCommitTransactionId !== operation.commitTransactionIds.at(-1)) {
			fail(`scroll operation ${index} primary transaction is invalid.`);
		}
		for (const transactionId of operation.commitTransactionIds) {
			if (claimedTransactions.has(transactionId)) fail(`scroll commit transaction ${transactionId} is reused.`);
			if (!Number.isSafeInteger(transactionId) || transactionId <= previousClaimedTransactionId) {
				fail(`scroll commit transaction ${transactionId} is out of order.`);
			}
			const commit = commitById.get(transactionId);
			if (!commit || commit.source !== 'scroll') {
				fail(`scroll commit transaction ${transactionId} is missing or not scroll.`);
			}
			claimedTransactions.add(transactionId);
			previousClaimedTransactionId = transactionId;
		}
		if (operation.phase === 'sample') {
			const externalSample = scrollSamples[operation.sampleIndex];
			const primaryCommit = commitById.get(operation.primaryCommitTransactionId);
			for (const rowIndex of [externalSample.visibleRowIndex, externalSample.expectedRowIndex]) {
				if (rowIndex < primaryCommit.firstRowIndex || rowIndex > primaryCommit.lastRowIndex) {
					fail(`external scroll sample ${operation.sampleIndex} row is outside its primary commit range.`);
				}
			}
		}
	}
	const unclaimedScrollCommit = snapshot.commits.find(commit => !claimedTransactions.has(commit.transactionId));
	if (unclaimedScrollCommit) {
		fail(`scroll commit transaction ${unclaimedScrollCommit.transactionId} is unclaimed.`);
	}

	return snapshot;
}
