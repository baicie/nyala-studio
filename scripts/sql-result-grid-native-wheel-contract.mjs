export function evaluateNativeWheelSmoke({ nativeInput, before, after }) {
	const event = after?.wheelEvents?.find(candidate => candidate.isTrusted === true);
	return {
		nativeInputPosted: nativeInput?.posted === true,
		trustedWheelObserved: Boolean(event),
		wheelTargetedViewport: event?.pathContainsViewport === true,
		viewportMoved:
			Number.isFinite(before?.scrollTop) && Number.isFinite(after?.scrollTop) && after.scrollTop !== before.scrollTop,
		visibleRowChanged:
			Number.isInteger(before?.visibleRowIndex) &&
			Number.isInteger(after?.visibleRowIndex) &&
			before.visibleRowIndex !== after.visibleRowIndex
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
