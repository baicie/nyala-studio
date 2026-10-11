import { SCROLL_TIMING_TOLERANCE_MS } from './sql-result-grid-benchmark-contract.mjs';

/**
 * v7 admission outcomes. `NOT-EVALUABLE` is not a pass: it reports that the
 * shared presentation floor sits above the absolute value the gate demands, so
 * no implementation can satisfy the threshold on this platform and workload.
 */
export const SQL_RESULT_GRID_EVALUABLE_OUTCOME = Object.freeze({
	notEvaluable: 'NOT-EVALUABLE',
	nonInferiorWithinThreshold: 'NON-INFERIOR-WITHIN-THRESHOLD',
	nonInferiorExceedsThreshold: 'NON-INFERIOR-EXCEEDS-THRESHOLD',
	superiorWithinThreshold: 'SUPERIOR-WITHIN-THRESHOLD',
	superiorBelowThreshold: 'SUPERIOR-BELOW-THRESHOLD'
});

function median(values) {
	if (values.length === 0) return Number.NaN;
	return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
}

/**
 * The presentation floor is paid identically by every renderer because it is
 * owned by the host WebView rather than by renderer code, so the shared floor
 * is the median across all renderers measured on the same platform and
 * workload.
 *
 * @param {ReadonlyArray<number>} floorP95ByRenderer per-renderer empty-loop p95 values.
 */
export function sharedPresentationFloorP95(floorP95ByRenderer) {
	const usable = floorP95ByRenderer.filter(value => Number.isFinite(value) && value >= 0);
	if (usable.length === 0) return Number.NaN;
	return median(usable);
}

/**
 * Decide whether a superiority target is discriminable at all, before scoring
 * any renderer against it. A target is unsatisfiable when the value it demands
 * is below the shared presentation floor, because that floor is the cost of an
 * empty measurement loop that performs no renderer work whatsoever.
 *
 * @param {object} input
 * @param {string} input.label human-readable platform/workload label.
 * @param {number} input.baselineP95Ms baseline renderer p95.
 * @param {number} input.sharedPresentationFloorP95Ms shared empty-loop p95.
 * @param {number} input.requiredImprovement minimum fractional improvement.
 */
export function createSuperiorityEvaluability(input) {
	const { label, baselineP95Ms, sharedPresentationFloorP95Ms, requiredImprovement } = input;
	if (!Number.isFinite(baselineP95Ms) || baselineP95Ms <= 0) {
		throw new Error(`${label}: a positive baseline p95 is required for evaluability.`);
	}
	const requiredP95Ms = baselineP95Ms * (1 - requiredImprovement);
	if (!Number.isFinite(sharedPresentationFloorP95Ms)) {
		return {
			evaluable: true,
			outcome: null,
			label,
			baselineP95Ms,
			requiredP95Ms,
			sharedPresentationFloorP95Ms: null,
			floorHeadroomMs: null,
			notEvaluableReason: null
		};
	}
	const floorExceedsTarget = requiredP95Ms + SCROLL_TIMING_TOLERANCE_MS < sharedPresentationFloorP95Ms;
	return {
		evaluable: !floorExceedsTarget,
		outcome: floorExceedsTarget ? SQL_RESULT_GRID_EVALUABLE_OUTCOME.notEvaluable : null,
		label,
		baselineP95Ms,
		requiredP95Ms,
		sharedPresentationFloorP95Ms,
		// How much room any renderer actually has above the floor it cannot avoid.
		floorHeadroomMs: Math.max(0, baselineP95Ms - sharedPresentationFloorP95Ms),
		notEvaluableReason: floorExceedsTarget
			? `${label}: the shared presentation floor ${sharedPresentationFloorP95Ms.toFixed(2)}ms is above the ${requiredP95Ms.toFixed(2)}ms that a ${(requiredImprovement * 100).toFixed(0)}% improvement requires, so the target is not discriminable on this platform and workload`
			: null
	};
}

/**
 * Renderer cost above the shared presentation floor. Subtracting the floor
 * does not relax the threshold: a twenty percent improvement must still be a
 * twenty percent improvement. It only removes the component every renderer
 * pays identically.
 */
export function floorAdjustedP95(rendererP95Ms, sharedFloorP95Ms) {
	if (!Number.isFinite(rendererP95Ms)) return Number.NaN;
	if (!Number.isFinite(sharedFloorP95Ms)) return rendererP95Ms;
	return Math.max(0, rendererP95Ms - sharedFloorP95Ms);
}

/**
 * Score a renderer against a superiority target, after evaluability has been
 * settled. Returns the plain v6-shaped ratio so callers keep one comparison
 * shape across both contract versions.
 */
export function createSuperiorityVerdict(input) {
	const { baselineP95Ms, zeusP95Ms, requiredImprovement, label, sharedPresentationFloorP95Ms } = input;
	if (!Number.isFinite(baselineP95Ms) || baselineP95Ms <= 0 || !Number.isFinite(zeusP95Ms)) {
		throw new Error(`${label}: finite positive baseline and Zeus p95 values are required.`);
	}
	const improvement = (baselineP95Ms - zeusP95Ms) / baselineP95Ms;
	const withinThreshold = improvement >= requiredImprovement;
	const detail = {
		baselineP95Ms,
		zeusP95Ms,
		improvement,
		requiredImprovement,
		sharedPresentationFloorP95Ms: Number.isFinite(sharedPresentationFloorP95Ms) ? sharedPresentationFloorP95Ms : null,
		baselineFloorAdjustedP95Ms: floorAdjustedP95(baselineP95Ms, sharedPresentationFloorP95Ms),
		zeusFloorAdjustedP95Ms: floorAdjustedP95(zeusP95Ms, sharedPresentationFloorP95Ms)
	};
	return {
		...detail,
		outcome: withinThreshold
			? SQL_RESULT_GRID_EVALUABLE_OUTCOME.superiorWithinThreshold
			: SQL_RESULT_GRID_EVALUABLE_OUTCOME.superiorBelowThreshold,
		reason: `${label}: scroll p95 improvement ${(improvement * 100).toFixed(1)}% ${withinThreshold ? 'meets' : 'is below'} the ${(requiredImprovement * 100).toFixed(0)}% threshold`
	};
}

/**
 * Score a renderer against a non-inferiority (no regression) target. A
 * non-inferiority target is always discriminable because it permits regression
 * up to the limit, so the floor can never push the required value below the
 * cost of an empty loop.
 */
export function createNonInferiorityVerdict(input) {
	const { baselineP95Ms, zeusP95Ms, maxRegression, label, sharedPresentationFloorP95Ms } = input;
	if (!Number.isFinite(baselineP95Ms) || baselineP95Ms <= 0 || !Number.isFinite(zeusP95Ms)) {
		throw new Error(`${label}: finite positive baseline and Zeus p95 values are required.`);
	}
	const regression = (zeusP95Ms - baselineP95Ms) / baselineP95Ms;
	const withinThreshold = regression <= maxRegression;
	return {
		baselineP95Ms,
		zeusP95Ms,
		regression,
		maxRegression,
		sharedPresentationFloorP95Ms: Number.isFinite(sharedPresentationFloorP95Ms) ? sharedPresentationFloorP95Ms : null,
		baselineFloorAdjustedP95Ms: floorAdjustedP95(baselineP95Ms, sharedPresentationFloorP95Ms),
		zeusFloorAdjustedP95Ms: floorAdjustedP95(zeusP95Ms, sharedPresentationFloorP95Ms),
		outcome: withinThreshold
			? SQL_RESULT_GRID_EVALUABLE_OUTCOME.nonInferiorWithinThreshold
			: SQL_RESULT_GRID_EVALUABLE_OUTCOME.nonInferiorExceedsThreshold,
		reason: `${label}: scroll p95 regression ${(regression * 100).toFixed(1)}% ${withinThreshold ? 'is within' : 'exceeds'} the ${(maxRegression * 100).toFixed(0)}% limit`
	};
}
