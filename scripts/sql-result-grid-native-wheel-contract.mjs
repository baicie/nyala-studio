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
