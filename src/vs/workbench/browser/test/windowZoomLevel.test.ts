import assert from 'node:assert/strict';
import test from 'node:test';

import {
	WINDOW_ZOOM_LEVEL_DEFAULT,
	WINDOW_ZOOM_LEVEL_MAX,
	WINDOW_ZOOM_LEVEL_MIN,
	WINDOW_ZOOM_LEVEL_SETTING,
	normalizeWindowZoomLevel
} from '../windowZoomLevel.js';

test('normalizeWindowZoomLevel keeps in-range integers', () => {
	assert.equal(normalizeWindowZoomLevel(0), 0);
	assert.equal(normalizeWindowZoomLevel(3), 3);
	assert.equal(normalizeWindowZoomLevel(-4), -4);
	assert.equal(normalizeWindowZoomLevel(WINDOW_ZOOM_LEVEL_MAX), WINDOW_ZOOM_LEVEL_MAX);
	assert.equal(normalizeWindowZoomLevel(WINDOW_ZOOM_LEVEL_MIN), WINDOW_ZOOM_LEVEL_MIN);
});

test('normalizeWindowZoomLevel clamps out-of-range integers', () => {
	assert.equal(normalizeWindowZoomLevel(100), WINDOW_ZOOM_LEVEL_MAX);
	assert.equal(normalizeWindowZoomLevel(-100), WINDOW_ZOOM_LEVEL_MIN);
});

test('normalizeWindowZoomLevel returns 0 for non-finite or non-numeric values', () => {
	assert.equal(normalizeWindowZoomLevel(NaN), WINDOW_ZOOM_LEVEL_DEFAULT);
	assert.equal(normalizeWindowZoomLevel(Infinity), WINDOW_ZOOM_LEVEL_DEFAULT);
	assert.equal(normalizeWindowZoomLevel(-Infinity), WINDOW_ZOOM_LEVEL_DEFAULT);
	assert.equal(normalizeWindowZoomLevel(undefined), WINDOW_ZOOM_LEVEL_DEFAULT);
	assert.equal(normalizeWindowZoomLevel(null), WINDOW_ZOOM_LEVEL_DEFAULT);
	assert.equal(normalizeWindowZoomLevel('2'), WINDOW_ZOOM_LEVEL_DEFAULT);
	assert.equal(normalizeWindowZoomLevel({}), WINDOW_ZOOM_LEVEL_DEFAULT);
});

test('normalizeWindowZoomLevel truncates fractional input to integer', () => {
	// The zoom-level picker in the settings UI is integer only; clip
	// any fractional value the user might paste in.
	assert.equal(normalizeWindowZoomLevel(2.4), 2);
	assert.equal(normalizeWindowZoomLevel(-3.9), -3);
});

test('WINDOW_ZOOM_LEVEL_SETTING matches the registration in workbench.contribution.ts', () => {
	// Keep this in lockstep with the settings key registered in
	// workbench.contribution.ts so settings panel reads the same key.
	assert.equal(WINDOW_ZOOM_LEVEL_SETTING, 'window.zoomLevel');
});