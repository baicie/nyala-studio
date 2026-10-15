export function evaluateNativeWheelSmoke({ nativeInput, before, after }) {
	const trustedWheelEvents = (after?.wheelEvents ?? []).filter(candidate => candidate.isTrusted === true);
	const event = trustedWheelEvents[0];
	const viewportScrollEvents = after?.scrollEvents ?? [];
	return {
		nativeInputPosted: nativeInput?.posted === true,
		trustedWheelObserved: Boolean(event),
		singleTrustedWheelObserved: trustedWheelEvents.length === 1,
		wheelTargetedViewport: event?.pathContainsViewport === true,
		singleViewportScrollObserved: viewportScrollEvents.length === 1,
		viewportMoved:
			Number.isFinite(before?.scrollTop) && Number.isFinite(after?.scrollTop) && after.scrollTop !== before.scrollTop,
		visibleRowChanged:
			Number.isInteger(before?.visibleRowIndex) &&
			Number.isInteger(after?.visibleRowIndex) &&
			before.visibleRowIndex !== after.visibleRowIndex
	};
}

export function evaluateNativeWheelTimeline({ after }) {
	const timeline = Array.isArray(after?.timeline) ? after.timeline : [];
	const wheel = timeline.find(
		event => event?.kind === 'wheel' && event.isTrusted === true && Number.isSafeInteger(event.gestureId)
	);
	const gestureId = wheel?.gestureId;
	const operation = after?.diagnostics?.operation;
	const snapshot = after?.diagnostics?.snapshot;
	const commitIds = Array.isArray(operation?.commitTransactionIds) ? operation.commitTransactionIds : [];
	const linkedCommitIds = new Set(commitIds);
	const operationValid =
		operation?.phase === 'native-wheel' &&
		operation.sampleIndex === 0 &&
		commitIds.length > 0 &&
		linkedCommitIds.size === commitIds.length &&
		operation.primaryCommitTransactionId === commitIds.at(-1);
	const scroll = timeline.find(event => event?.kind === 'scroll' && event.gestureId === gestureId);
	const commits = (snapshot?.commits ?? []).filter(
		candidate => candidate?.source === 'scroll' && linkedCommitIds.has(candidate.transactionId)
	);
	const commitEvents = timeline.filter(
		event => event?.kind === 'renderer-commit' && linkedCommitIds.has(event.transactionId)
	);
	const commit = commits.at(-1);
	const commitEvent = commitEvents.find(event => event.transactionId === commit?.transactionId);
	const diagnosticsEnd = timeline.find(
		event => event?.kind === 'renderer-diagnostics-end' && event.gestureId === gestureId
	);
	const raf = timeline.find(
		event =>
			event?.kind === 'raf' &&
			event.gestureId === gestureId &&
			Number.isFinite(commit?.commitEndTime) &&
			event.at >= commit.commitEndTime
	);
	const afterFrameTask = timeline.find(
		event =>
			event?.kind === 'after-frame-task' &&
			event.gestureId === gestureId &&
			Number.isFinite(raf?.at) &&
			event.at >= raf.at
	);
	const timelineOrder = event => (Number.isSafeInteger(event?.sequence) ? event.sequence : timeline.indexOf(event));
	const allCommitTimingValid =
		commits.length > 0 &&
		commits.every(candidate => {
			const times = [
				candidate.handlerStartTime,
				candidate.handlerEndTime,
				candidate.rangeStartTime,
				candidate.rangeCalculatedTime,
				candidate.commitStartTime,
				candidate.commitEndTime
			];
			const linkedEvent = commitEvents.find(event => event.transactionId === candidate.transactionId);
			return (
				times.every(Number.isFinite) &&
				times.every((time, index) => index === 0 || times[index - 1] <= time) &&
				Number.isFinite(scroll?.eventTimeStamp) &&
				candidate.inputTime === scroll.eventTimeStamp &&
				Number.isFinite(linkedEvent?.at) &&
				linkedEvent.at === candidate.commitEndTime &&
				linkedEvent.gestureId === gestureId
			);
		});
	const commitTimingValid =
		allCommitTimingValid && commitEvents.length === commitIds.length && commits.length === commitIds.length;
	const rendererCommitObserved = Boolean(operationValid && commit && commitEvent && commitTimingValid);
	const wheelBeforeScroll = timelineOrder(wheel) < timelineOrder(scroll);
	const eventTimestampOrderValid =
		Number.isFinite(wheel?.eventTimeStamp) &&
		Number.isFinite(scroll?.eventTimeStamp) &&
		wheel.eventTimeStamp <= scroll.eventTimeStamp;
	const inputOrderValid = (wheelBeforeScroll || timelineOrder(scroll) < timelineOrder(wheel)) && eventTimestampOrderValid;
	const timelineOrderValid = Boolean(
		Number.isFinite(wheel?.at) &&
		Number.isFinite(scroll?.at) &&
		Number.isFinite(commitEvent?.at) &&
		Number.isFinite(raf?.at) &&
		Number.isFinite(afterFrameTask?.at) &&
		inputOrderValid &&
		scroll.at <= commit.handlerStartTime &&
		commitEvent.at <= raf.at &&
		raf.at <= afterFrameTask.at &&
		timelineOrder(scroll) < timelineOrder(commitEvent) &&
		timelineOrder(commitEvent) < timelineOrder(raf) &&
		timelineOrder(raf) < timelineOrder(afterFrameTask)
	);
	const afterFrameRowCorrect = Boolean(
		Number.isFinite(afterFrameTask?.scrollTop) &&
		Number.isSafeInteger(afterFrameTask?.visibleRowIndex) &&
		Number.isSafeInteger(afterFrameTask?.expectedVisibleRowIndex) &&
		afterFrameTask.visibleRowIndex === afterFrameTask.expectedVisibleRowIndex &&
		afterFrameTask.scrollTop === after?.scrollTop &&
		afterFrameTask.visibleRowIndex === after?.visibleRowIndex
	);
	return {
		trustedWheelTimestampRecorded:
			Number.isSafeInteger(gestureId) && Number.isFinite(wheel?.at) && Number.isFinite(wheel?.eventTimeStamp),
		scrollTimestampRecorded:
			Number.isSafeInteger(gestureId) &&
			Number.isFinite(scroll?.at) &&
			Number.isFinite(scroll?.eventTimeStamp) &&
			inputOrderValid,
		rendererCommitObserved,
		commitTimingValid,
		timelineOrderValid,
		rafOpportunityRecorded: Number.isFinite(raf?.at) && raf.gestureId === gestureId,
		afterFrameTaskRecorded: Number.isFinite(afterFrameTask?.at) && afterFrameTask.gestureId === gestureId,
		afterFrameRowCorrect,
		diagnosticOperationClosed:
			after?.diagnosticComplete === true &&
			operationValid &&
			after?.diagnostics?.gestureId === gestureId &&
			Boolean(diagnosticsEnd) &&
			Number.isFinite(diagnosticsEnd.at) &&
			diagnosticsEnd.at >= (raf?.at ?? Infinity) &&
			timelineOrder(raf) < timelineOrder(diagnosticsEnd) &&
			timelineOrder(diagnosticsEnd) < timelineOrder(afterFrameTask)
	};
}

export function summarizeNativeWheelTimeline({ after }) {
	const timeline = Array.isArray(after?.timeline) ? after.timeline : [];
	const wheel = timeline.find(
		event => event?.kind === 'wheel' && event.isTrusted === true && Number.isSafeInteger(event.gestureId)
	);
	const gestureId = wheel?.gestureId;
	const linkedCommitIds = new Set(after?.diagnostics?.operation?.commitTransactionIds ?? []);
	const commit = (after?.diagnostics?.snapshot?.commits ?? [])
		.filter(candidate => candidate?.source === 'scroll' && linkedCommitIds.has(candidate.transactionId))
		.at(-1);
	const scroll = timeline.find(event => event?.kind === 'scroll' && event.gestureId === gestureId);
	const commitEvent = timeline.find(
		event =>
			event?.kind === 'renderer-commit' &&
			event.gestureId === gestureId &&
			event.transactionId === commit?.transactionId
	);
	const diagnosticsEnd = timeline.find(
		event => event?.kind === 'renderer-diagnostics-end' && event.gestureId === gestureId
	);
	const raf = timeline.find(
		event =>
			event?.kind === 'raf' &&
			event.gestureId === gestureId &&
			Number.isFinite(commit?.commitEndTime) &&
			event.at >= commit.commitEndTime
	);
	const afterFrameTask = timeline.find(
		event =>
			event?.kind === 'after-frame-task' &&
			event.gestureId === gestureId &&
			Number.isFinite(raf?.at) &&
			event.at >= raf.at
	);
	const difference = (end, start) => (Number.isFinite(end) && Number.isFinite(start) ? end - start : null);
	return {
		timingClock: 'performance-now',
		wheelEventTimeStamp: Number.isFinite(wheel?.eventTimeStamp) ? wheel.eventTimeStamp : null,
		wheelCaptureAt: Number.isFinite(wheel?.at) ? wheel.at : null,
		scrollEventTimeStamp: Number.isFinite(scroll?.eventTimeStamp) ? scroll.eventTimeStamp : null,
		rendererCommitAt: Number.isFinite(commitEvent?.at) ? commitEvent.at : null,
		rendererDiagnosticsEndAt: Number.isFinite(diagnosticsEnd?.at) ? diagnosticsEnd.at : null,
		wheelToScrollMs: difference(scroll?.at, wheel?.at),
		wheelToCommitHandlerMs: difference(commit?.handlerStartTime, wheel?.at),
		commitDurationMs: difference(commit?.commitEndTime, commit?.handlerStartTime),
		commitToRafMs: difference(raf?.at, commit?.commitEndTime),
		wheelToRafMs: difference(raf?.at, wheel?.at),
		wheelToAfterFrameTaskMs: difference(afterFrameTask?.at, wheel?.at),
		commitInputTime: Number.isFinite(commit?.inputTime) ? commit.inputTime : null,
		commitInputToScrollEventTimestampMs: difference(commit?.inputTime, scroll?.eventTimeStamp)
	};
}

export function parseNativeWheelHelperResult({ stdout = '', stderr = '', status, errorMessage }) {
	let payload;
	try {
		payload = JSON.parse(stdout.trim());
	} catch {
		payload = {
			posted: false,
			error: stderr.trim() || stdout.trim() || errorMessage || 'Native input helper returned no JSON.'
		};
	}
	const helperStderr = stderr.trim();
	if (helperStderr) payload.helperStderr = helperStderr;
	if (errorMessage) payload.error = errorMessage;
	if (status !== 0 && payload.posted !== false) payload.posted = false;
	return payload;
}
