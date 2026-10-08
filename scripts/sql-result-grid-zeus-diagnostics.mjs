export const ZEUS_DATA_GRID_DIAGNOSTICS_VERSION = 1;
export const ZEUS_DATA_GRID_DIAGNOSTICS_CORRELATION = 'sequential-callback-cursor-v1';

export function createZeusDataGridDiagnosticCollector(options = {}) {
	const modelBuilds = [];
	const commits = [];
	const scrollOperations = [];

	function cloneModelBuild(sample) {
		return {
			sequence: sample.sequence,
			modelVersion: sample.modelVersion,
			startTime: sample.startTime,
			endTime: sample.endTime,
			rowCount: sample.rowCount,
			columnCount: sample.columnCount,
			visibleColumnCount: sample.visibleColumnCount,
			sortActive: sample.sortActive,
			rowModelReused: sample.rowModelReused,
			rowIndexEntryCount: sample.rowIndexEntryCount,
			eagerRowWrapperAllocationCount: sample.eagerRowWrapperAllocationCount
		};
	}

	function cloneCommit(sample) {
		return {
			transactionId: sample.transactionId,
			source: sample.source,
			...(sample.inputTime === undefined ? {} : { inputTime: sample.inputTime }),
			handlerStartTime: sample.handlerStartTime,
			handlerEndTime: sample.handlerEndTime,
			rangeStartTime: sample.rangeStartTime,
			rangeCalculatedTime: sample.rangeCalculatedTime,
			commitStartTime: sample.commitStartTime,
			commitEndTime: sample.commitEndTime,
			...(Number.isFinite(sample.diagnosticsEndTime) ? { diagnosticsEndTime: sample.diagnosticsEndTime } : {}),
			layoutReadIntervals: Array.from(sample.layoutReadIntervals ?? [], interval => [interval[0], interval[1]]),
			firstRowIndex: sample.firstRowIndex,
			lastRowIndex: sample.lastRowIndex,
			firstColumnIndex: sample.firstColumnIndex,
			lastColumnIndex: sample.lastColumnIndex,
			createdNodeCount: sample.createdNodeCount,
			removedNodeCount: sample.removedNodeCount,
			rowWrapperAllocationCount: sample.rowWrapperAllocationCount
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

	return {
		observer: {
			onModelBuild(sample) {
				modelBuilds.push(cloneModelBuild(sample));
			},
			onCommit(sample) {
				commits.push(cloneCommit(sample));
			},
			...(options.measureNodeChurn === false ? { measureNodeChurn: false } : {})
		},
		beginOperation(phase, sampleIndex) {
			return {
				phase,
				sampleIndex,
				commitCursor: commits.length
			};
		},
		endOperation(operation) {
			const commitTransactionIds = commits
				.slice(operation.commitCursor)
				.filter(commit => commit.source === 'scroll')
				.map(commit => commit.transactionId);
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
				inputTimeClock: 'raw-event-timestamp',
				correlation: 'sequential-callback-cursor-v1',
				modelBuilds: modelBuilds.map(cloneModelBuild),
				commits: commits.map(cloneCommit),
				scrollOperations: scrollOperations.map(cloneOperation)
			};
		}
	};
}

export function validateZeusDataGridDiagnosticSnapshot(snapshot, options) {
	function fail(message) {
		throw new Error(`Zeus Data Grid diagnostics ${message}`);
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

	if (!isRecord(snapshot)) fail('snapshot is missing.');
	if (snapshot.version !== 1) fail('version must be 1.');
	if (snapshot.timingClock !== 'performance-now') fail('timing clock is invalid.');
	if (snapshot.inputTimeClock !== 'raw-event-timestamp') fail('input time clock is invalid.');
	if (snapshot.correlation !== 'sequential-callback-cursor-v1') fail('correlation contract is invalid.');
	if (!Array.isArray(snapshot.modelBuilds) || snapshot.modelBuilds.length === 0) fail('model builds are missing.');
	if (!Array.isArray(snapshot.commits) || snapshot.commits.length === 0) fail('commits are missing.');
	if (!Array.isArray(snapshot.scrollOperations)) fail('scroll operations are missing.');

	for (let index = 0; index < snapshot.modelBuilds.length; index += 1) {
		const sample = snapshot.modelBuilds[index];
		if (!isRecord(sample)) fail(`model build ${index} is invalid.`);
		if (sample.sequence !== index + 1) fail(`model build ${index} sequence is not contiguous.`);
		requireCount(sample.modelVersion, `model build ${index} modelVersion`);
		requireFinite(sample.startTime, `model build ${index} startTime`);
		requireFinite(sample.endTime, `model build ${index} endTime`);
		if (sample.startTime > sample.endTime) fail(`model build ${index} timing is reversed.`);
		for (const field of [
			'rowCount',
			'columnCount',
			'visibleColumnCount',
			'rowIndexEntryCount',
			'eagerRowWrapperAllocationCount'
		]) {
			requireCount(sample[field], `model build ${index} ${field}`);
		}
		if (sample.visibleColumnCount > sample.columnCount) fail(`model build ${index} visible columns exceed columns.`);
		if (sample.rowIndexEntryCount !== sample.rowCount)
			fail(`model build ${index} row index count does not match rows.`);
		if (typeof sample.sortActive !== 'boolean' || typeof sample.rowModelReused !== 'boolean') {
			fail(`model build ${index} flags are invalid.`);
		}
	}

	const workload = options?.workload;
	if (
		!isRecord(workload) ||
		!Number.isSafeInteger(workload.rows) ||
		workload.rows < 1 ||
		!Number.isSafeInteger(workload.columns) ||
		workload.columns < 1 ||
		!snapshot.modelBuilds.some(sample => sample.rowCount === workload.rows && sample.columnCount === workload.columns)
	) {
		fail('model builds do not include the benchmark workload shape.');
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

	const commitById = new Map();
	let previousTransactionId = 0;
	const supportedSources = new Set(['mount', 'scroll', 'resize', 'data', 'api']);
	for (let index = 0; index < snapshot.commits.length; index += 1) {
		const sample = snapshot.commits[index];
		if (!isRecord(sample)) fail(`commit ${index} is invalid.`);
		if (!Number.isSafeInteger(sample.transactionId) || sample.transactionId <= previousTransactionId) {
			fail(`commit ${index} transaction id is not strictly increasing.`);
		}
		previousTransactionId = sample.transactionId;
		if (!supportedSources.has(sample.source)) fail(`commit ${index} source is invalid.`);
		if (sample.inputTime !== undefined) requireFinite(sample.inputTime, `commit ${index} inputTime`);
		for (const field of [
			'handlerStartTime',
			'handlerEndTime',
			'rangeStartTime',
			'rangeCalculatedTime',
			'commitStartTime',
			'commitEndTime'
		]) {
			requireFinite(sample[field], `commit ${index} ${field}`);
		}
		if (!(
			sample.handlerStartTime <= sample.handlerEndTime &&
			sample.handlerEndTime <= sample.rangeStartTime &&
			sample.rangeStartTime <= sample.rangeCalculatedTime &&
			sample.rangeCalculatedTime <= sample.commitStartTime &&
			sample.commitStartTime <= sample.commitEndTime
		)) {
			fail(`commit timing ${index} is invalid.`);
		}
		if (sample.diagnosticsEndTime !== undefined) {
			requireFinite(sample.diagnosticsEndTime, `commit ${index} diagnosticsEndTime`);
			if (sample.diagnosticsEndTime < sample.commitEndTime) {
				fail(`commit ${index} diagnosticsEndTime precedes commitEndTime.`);
			}
		}
		if (!Array.isArray(sample.layoutReadIntervals) || sample.layoutReadIntervals.length === 0) {
			fail(`commit ${index} layout intervals are missing.`);
		}
		for (const [intervalIndex, interval] of sample.layoutReadIntervals.entries()) {
			if (!Array.isArray(interval) || interval.length !== 2)
				fail(`commit ${index} layout interval ${intervalIndex} is invalid.`);
			const [startTime, endTime] = interval;
			requireFinite(startTime, `commit ${index} layout interval ${intervalIndex} start`);
			requireFinite(endTime, `commit ${index} layout interval ${intervalIndex} end`);
			if (startTime < sample.rangeStartTime || startTime > endTime || endTime > sample.rangeCalculatedTime) {
				fail(`commit ${index} layout interval ${intervalIndex} is outside the range timing.`);
			}
		}
		for (const field of [
			'firstRowIndex',
			'lastRowIndex',
			'firstColumnIndex',
			'lastColumnIndex',
			'createdNodeCount',
			'removedNodeCount',
			'rowWrapperAllocationCount'
		]) {
			requireCount(sample[field], `commit ${index} ${field}`);
		}
		if (sample.firstRowIndex > sample.lastRowIndex || sample.firstColumnIndex > sample.lastColumnIndex) {
			fail(`commit ${index} range is invalid.`);
		}
		if (sample.lastRowIndex >= workload.rows || sample.lastColumnIndex >= workload.columns) {
			fail(`commit ${index} range exceeds the benchmark workload.`);
		}
		commitById.set(sample.transactionId, sample);
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
			if (!commit || commit.source !== 'scroll')
				fail(`scroll commit transaction ${transactionId} is missing or not scroll.`);
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
	const unclaimedScrollCommit = snapshot.commits.find(
		commit => commit.source === 'scroll' && !claimedTransactions.has(commit.transactionId)
	);
	if (unclaimedScrollCommit) {
		fail(`scroll commit transaction ${unclaimedScrollCommit.transactionId} is unclaimed.`);
	}

	return snapshot;
}
