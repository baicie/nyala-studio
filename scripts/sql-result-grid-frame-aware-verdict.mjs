import {
	createNonInferiorityVerdict,
	SQL_RESULT_GRID_EVALUABLE_OUTCOME
} from './sql-result-grid-floor-evaluable.mjs';

/**
 * v8 renderer-work thresholds. These are pre-registered values, not fitted to
 * the recorded runs: the renderer-work ratio between Zeus and the fastest
 * baseline is 2.2x-12.5x across every recorded set, so a 20% requirement is
 * the conservative end of that observed range and keeps the existing product
 * target unchanged. Changing them is a contract change, not a tuning knob.
 */
export const SQL_RESULT_GRID_FRAME_AWARE_TEN_K_MINIMUM_IMPROVEMENT = 0.2;

/**
 * v8 admission outcome for the frame-aware renderer-work gate. The measured
 * quantity is the per-sample renderer commit interval, which is the only part
 * of scroll latency that renderer code can change. Host frame scheduling is
 * reported alongside it and is never subtracted: the host interval and the
 * renderer interval are two measurements of different work, not a budget.
 */
export const SQL_RESULT_GRID_FRAME_AWARE_OUTCOME = Object.freeze({
	unavailable: 'UNAVAILABLE',
	superiorWithinThreshold: 'SUPERIOR-WITHIN-THRESHOLD',
	superiorBelowThreshold: 'SUPERIOR-BELOW-THRESHOLD',
	nonInferiorWithinThreshold: 'NON-INFERIOR-WITHIN-THRESHOLD',
	nonInferiorExceedsThreshold: 'NON-INFERIOR-EXCEEDS-THRESHOLD'
});

function median(values) {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * @param {object} input
 * @param {string} input.label human-readable workload label.
 * @param {ReadonlyArray<{renderer: string, rendererWork: {available: boolean, medianMs: number}}>} input.renderers
 * @param {number} input.requiredImprovement minimum fractional renderer-work improvement.
 */
export function createFrameAwareSuperiorityVerdict(input) {
	const { label, renderers, requiredImprovement } = input;
	const usable = (renderers ?? []).filter(
		entry => entry?.rendererWork?.available === true && Number.isFinite(entry.rendererWork.medianMs)
	);
	const zeus = usable.find(entry => entry.renderer === 'zeus');
	const baselines = usable.filter(entry => entry.renderer !== 'zeus');
	if (!zeus || baselines.length === 0) {
		return {
			outcome: SQL_RESULT_GRID_FRAME_AWARE_OUTCOME.unavailable,
			label,
			zeusRendererWorkMs: zeus?.rendererWork?.medianMs ?? null,
			baselineRendererWorkMs: null,
			baselineRenderer: null,
			requiredImprovement,
			reason: `${label}: renderer work is unavailable for Zeus or for every baseline renderer`
		};
	}
	const best = baselines.reduce((left, right) => (right.rendererWork.medianMs < left.rendererWork.medianMs ? right : left));
	const baselineRendererWorkMs = best.rendererWork.medianMs;
	const zeusRendererWorkMs = zeus.rendererWork.medianMs;
	if (!(baselineRendererWorkMs > 0)) {
		return {
			outcome: SQL_RESULT_GRID_FRAME_AWARE_OUTCOME.unavailable,
			label,
			zeusRendererWorkMs,
			baselineRendererWorkMs,
			baselineRenderer: best.renderer,
			requiredImprovement,
			reason: `${label}: baseline renderer work must be positive to score an improvement`
		};
	}
	const improvement = (baselineRendererWorkMs - zeusRendererWorkMs) / baselineRendererWorkMs;
	const passed = improvement >= requiredImprovement;
	return {
		outcome: passed
			? SQL_RESULT_GRID_FRAME_AWARE_OUTCOME.superiorWithinThreshold
			: SQL_RESULT_GRID_FRAME_AWARE_OUTCOME.superiorBelowThreshold,
		label,
		zeusRendererWorkMs,
		baselineRendererWorkMs,
		baselineRenderer: best.renderer,
		improvement,
		requiredImprovement,
		reason: passed
			? `${label}: renderer work improvement ${(improvement * 100).toFixed(1)}% meets the ${(requiredImprovement * 100).toFixed(0)}% threshold`
			: `${label}: renderer work improvement ${(improvement * 100).toFixed(1)}% is below the ${(requiredImprovement * 100).toFixed(0)}% threshold`
	};
}

/**
 * The host-excess guard is reported, never thresholded. Its purpose is to keep
 * the host scheduling cost visible next to the renderer verdict so a future
 * regression can be attributed, not to fail admission on a platform whose
 * WebView schedules frames slowly.
 */
export function createFrameAwareHostExcessReport(input) {
	const { label, renderers } = input;
	const rows = (renderers ?? [])
		.filter(entry => entry?.hostExcess?.available === true)
		.map(entry => ({
			renderer: entry.renderer,
			hostIntervalMs: entry.hostIntervalMs,
			p95ExcessMs: entry.hostExcess.p95ExcessMs,
			scrollP95Ms: entry.scrollTotal?.p95Ms ?? null
		}));
	return { label, rows, note: 'Host excess is reported for attribution and does not gate admission.' };
}

export { median as frameAwareMedian, createNonInferiorityVerdict, SQL_RESULT_GRID_EVALUABLE_OUTCOME };
