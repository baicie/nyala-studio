export function createSameExecutionProfileMetadata() {
	return {
		version: 1,
		timingClock: 'performance-now',
		correlation: 'same-input-operation-window-v1',
		instrumentation: 'scalar-callback-timestamps-v1',
		diagnosticOnly: true,
		admissionGrade: false,
		limitations: [
			'Same-execution timestamps and renderer observers add overhead to the primary scroll operation; this is diagnostic evidence and must not be scored for admission.',
			'Animation-frame, after-frame-task, and validation spans are wall-clock observations, not exclusive CPU time or proof of pixels presented.',
			'The profile adds no frame, timer, DOM probe, or alternate scroll input; it records the existing completion path with node-churn measurement disabled.'
		]
	};
}

// The completion contract schedules its after-frame task with delay 0 and its
// watchdog with a positive timeout. Wrap those existing callbacks locally;
// other presentation waits never see this operation's timestamps.
export function createSameExecutionPresentationOptions(timing, options = {}) {
	const requestFrame = options.requestFrame ?? globalThis.requestAnimationFrame?.bind(globalThis);
	const setTimer = options.setTimer ?? globalThis.setTimeout?.bind(globalThis);
	const now = options.now ?? (() => performance.now());
	return {
		...options,
		requestFrame(callback) {
			return requestFrame(timestamp => {
				timing.rafTime = now();
				callback(timestamp);
			});
		},
		setTimer(callback, delay) {
			return setTimer(
				delay === 0
					? () => {
							timing.afterFrameTaskTime = now();
							callback();
						}
					: callback,
				delay
			);
		}
	};
}

export function validateSameExecutionProfileRecord(record, options = {}) {
	const expectedSampleCount = options.expectedSampleCount ?? 20;
	const toleranceMs = 1;
	const fail = message => {
		throw new Error('Invalid same-execution profile: ' + message);
	};
	if (
		record?.diagnostic !== true ||
		record.admissionGrade !== false ||
		record.sameExecutionProfile?.version !== 1 ||
		record.sameExecutionProfile?.diagnosticOnly !== true ||
		record.sameExecutionProfile?.admissionGrade !== false
	)
		fail('diagnostic metadata is missing.');
	if (record.diagnostics?.floorOnly !== false || record.diagnostics?.measureNodeChurn !== false) {
		fail('renderer diagnostics must be enabled with node-churn measurement disabled.');
	}
	const samples = record.scroll?.samples;
	if (!Array.isArray(samples) || samples.length !== expectedSampleCount) fail('scroll sample count is incomplete.');
	const rendererSnapshot =
		record.renderer === 'zeus'
			? record.diagnostics.zeusDataGrid
			: record.renderer === 'workbench-table'
				? record.diagnostics.workbenchTable
				: undefined;
	if (record.renderer !== 'native' && !rendererSnapshot) fail('renderer operation sidecar is missing.');
	let previousEnd = -Infinity;
	const usedCommitIds = new Set();
	for (let index = 0; index < samples.length; index += 1) {
		const sample = samples[index];
		const timing = sample.sameExecution;
		if (
			sample.committed !== true ||
			sample.sampleIndex !== index ||
			timing?.phase !== 'sample' ||
			timing.sampleIndex !== index
		) {
			fail('sample indices or phases are out of order.');
		}
		if (
			!Number.isInteger(sample.attempts) ||
			sample.attempts < 1 ||
			sample.presentationOpportunities !== sample.attempts ||
			!Array.isArray(timing.waits) ||
			timing.waits.length !== sample.attempts
		)
			fail('wait count does not match attempts.');
		const orderedTimes = [timing.inputStart, timing.inputEnd];
		for (let attempt = 0; attempt < timing.waits.length; attempt += 1) {
			const wait = timing.waits[attempt];
			if (wait?.attempt !== attempt + 1) fail('wait attempt indices are out of order.');
			orderedTimes.push(
				wait.waitStart,
				wait.rafTime,
				wait.afterFrameTaskTime,
				wait.waitEnd,
				wait.offsetHeightStart,
				wait.offsetHeightEnd,
				wait.visibleRowValidationStart,
				wait.visibleRowValidationEnd
			);
		}
		orderedTimes.push(timing.endTime);
		if (
			orderedTimes.some(
				(time, position) => !Number.isFinite(time) || (position > 0 && time < orderedTimes[position - 1])
			)
		)
			fail('timestamps are missing, non-finite, or out of order.');
		if (timing.inputStart < previousEnd) fail('scroll operation windows overlap.');
		previousEnd = timing.endTime;
		if (
			!Number.isFinite(sample.inputMs) ||
			!Number.isFinite(sample.totalMs) ||
			Math.abs(sample.inputMs - (timing.inputEnd - timing.inputStart)) > toleranceMs ||
			Math.abs(sample.totalMs - (timing.endTime - timing.inputStart)) > toleranceMs
		) {
			fail('primary durations do not match the same input window.');
		}
		if (!rendererSnapshot) continue;
		const operations = rendererSnapshot.scrollOperations?.filter(
			operation => operation.phase === 'sample' && operation.sampleIndex === index
		);
		if (operations?.length !== 1) fail('renderer operation association is missing or ambiguous.');
		const operation = operations[0];
		const associated = timing.rendererOperation;
		const ids = operation.commitTransactionIds;
		if (
			associated?.phase !== 'sample' ||
			associated.sampleIndex !== index ||
			!Array.isArray(ids) ||
			ids.length === 0 ||
			!Array.isArray(associated.commitTransactionIds) ||
			associated.commitTransactionIds.length !== ids.length ||
			associated.commitTransactionIds.some((id, position) => id !== ids[position]) ||
			associated.primaryCommitTransactionId !== operation.primaryCommitTransactionId
		) {
			fail('renderer commit IDs do not match the same operation.');
		}
		for (const id of ids) {
			if (usedCommitIds.has(id)) fail('a renderer commit was reused by another input.');
			usedCommitIds.add(id);
			const commits = rendererSnapshot.commits?.filter(commit => commit.transactionId === id);
			if (commits?.length !== 1 || commits[0].source !== 'scroll')
				fail('associated scroll commit is missing or ambiguous.');
			const commit = commits[0];
			if (
				!Number.isFinite(commit.handlerStartTime) ||
				!Number.isFinite(commit.handlerEndTime) ||
				commit.handlerStartTime < timing.inputStart - toleranceMs ||
				commit.handlerEndTime > timing.endTime + toleranceMs ||
				commit.handlerEndTime < commit.handlerStartTime
			)
				fail('renderer commit lies outside its input window.');
			const commitIntervals =
				record.renderer === 'zeus' ? [[commit.commitStartTime, commit.commitEndTime]] : commit.commitIntervals;
			if (
				!Array.isArray(commitIntervals) ||
				commitIntervals.length === 0 ||
				commitIntervals.some(
					interval =>
						!Array.isArray(interval) ||
						interval.length !== 2 ||
						!interval.every(Number.isFinite) ||
						interval[0] < timing.inputStart - toleranceMs ||
						interval[1] > timing.endTime + toleranceMs ||
						interval[1] < interval[0]
				)
			)
				fail('renderer commit work lies outside its input window.');
		}
	}
	return record;
}
