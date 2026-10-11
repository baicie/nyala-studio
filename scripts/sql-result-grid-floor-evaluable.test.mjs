import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createNonInferiorityVerdict,
	createSuperiorityEvaluability,
	createSuperiorityVerdict,
	floorAdjustedP95,
	sharedPresentationFloorP95,
	SQL_RESULT_GRID_EVALUABLE_OUTCOME
} from './sql-result-grid-floor-evaluable.mjs';

test('shared presentation floor is the median across renderers because the host owns it', () => {
	assert.equal(sharedPresentationFloorP95([18, 16, 20]), 18);
	assert.equal(sharedPresentationFloorP95([17.5, 17.5]), 17.5);
	assert.ok(Number.isNaN(sharedPresentationFloorP95([])));
	assert.ok(Number.isNaN(sharedPresentationFloorP95([Number.NaN, Number.NaN])));
});

test('a superiority target below the shared floor is NOT-EVALUABLE rather than failed', () => {
	const evaluability = createSuperiorityEvaluability({
		label: 'windows-webview2 10k-x-50',
		baselineP95Ms: 16.4,
		sharedPresentationFloorP95Ms: 16.4,
		requiredImprovement: 0.2
	});
	assert.equal(evaluability.evaluable, false);
	assert.equal(evaluability.outcome, SQL_RESULT_GRID_EVALUABLE_OUTCOME.notEvaluable);
	assert.match(evaluability.notEvaluableReason, /not discriminable/);
	// The demanded absolute value is below what an empty measurement loop costs.
	assert.ok(evaluability.requiredP95Ms < evaluability.sharedPresentationFloorP95Ms);
});

test('a superiority target above the shared floor stays evaluable', () => {
	const evaluability = createSuperiorityEvaluability({
		label: 'macos-webkit 10k-x-50',
		baselineP95Ms: 44,
		sharedPresentationFloorP95Ms: 18,
		requiredImprovement: 0.2
	});
	assert.equal(evaluability.evaluable, true);
	assert.equal(evaluability.outcome, null);
	assert.equal(evaluability.floorHeadroomMs, 26);
});

test('an unknown floor does not silently mark a target NOT-EVALUABLE', () => {
	const evaluability = createSuperiorityEvaluability({
		label: 'legacy 10k-x-50',
		baselineP95Ms: 40,
		sharedPresentationFloorP95Ms: Number.NaN,
		requiredImprovement: 0.2
	});
	assert.equal(evaluability.evaluable, true);
});

test('superiority verdict reports the plain v6 ratio alongside floor-adjusted values', () => {
	const verdict = createSuperiorityVerdict({
		label: 'macos-webkit 10k-x-50',
		baselineP95Ms: 44,
		zeusP95Ms: 34,
		requiredImprovement: 0.2,
		sharedPresentationFloorP95Ms: 18
	});
	assert.equal(verdict.outcome, SQL_RESULT_GRID_EVALUABLE_OUTCOME.superiorWithinThreshold);
	// 22.7% raw improvement must still satisfy the 20% requirement.
	assert.ok(Math.abs(verdict.improvement - 10 / 44) < 1e-9);
	assert.equal(verdict.baselineFloorAdjustedP95Ms, 26);
	assert.equal(verdict.zeusFloorAdjustedP95Ms, 16);
});

test('superiority verdict fails when the improvement is short', () => {
	const verdict = createSuperiorityVerdict({
		label: 'windows-webview2 10k-x-50',
		baselineP95Ms: 40,
		zeusP95Ms: 36,
		requiredImprovement: 0.2,
		sharedPresentationFloorP95Ms: 10
	});
	assert.equal(verdict.outcome, SQL_RESULT_GRID_EVALUABLE_OUTCOME.superiorBelowThreshold);
	assert.equal(verdict.passed, undefined);
});

test('non-inferiority is never blocked by the floor and still reports real regressions', () => {
	const withinLimit = createNonInferiorityVerdict({
		label: 'windows-webview2 1k-x-20',
		baselineP95Ms: 16.5,
		zeusP95Ms: 17.6,
		maxRegression: 0.1,
		sharedPresentationFloorP95Ms: 16.5
	});
	assert.equal(withinLimit.outcome, SQL_RESULT_GRID_EVALUABLE_OUTCOME.nonInferiorWithinThreshold);

	// v7 must not launder a genuine regression into a pass.
	const regression = createNonInferiorityVerdict({
		label: 'macos-webkit 1k-x-20',
		baselineP95Ms: 26,
		zeusP95Ms: 33,
		maxRegression: 0.1,
		sharedPresentationFloorP95Ms: 26
	});
	assert.equal(regression.outcome, SQL_RESULT_GRID_EVALUABLE_OUTCOME.nonInferiorExceedsThreshold);
	assert.ok(Math.abs(regression.regression - 7 / 26) < 1e-9);
});

test('floor adjustment removes only the shared component and never goes negative', () => {
	assert.equal(floorAdjustedP95(30, 18), 12);
	assert.equal(floorAdjustedP95(15, 18), 0);
	assert.equal(floorAdjustedP95(30, Number.NaN), 30);
});
