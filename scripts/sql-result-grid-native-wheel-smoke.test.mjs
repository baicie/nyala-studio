import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateNativeWheelSmoke } from './sql-result-grid-native-wheel-contract.mjs';

test('native wheel smoke passes only for trusted input that reaches and scrolls the viewport', () => {
	const checks = evaluateNativeWheelSmoke({
		nativeInput: { posted: true },
		before: { scrollTop: 0, visibleRowIndex: 0 },
		after: {
			scrollTop: 84,
			visibleRowIndex: 3,
			wheelEvents: [{ isTrusted: true, pathContainsViewport: true }]
		}
	});
	assert.deepEqual(checks, {
		nativeInputPosted: true,
		trustedWheelObserved: true,
		wheelTargetedViewport: true,
		viewportMoved: true,
		visibleRowChanged: true
	});
});

test('native wheel smoke rejects synthetic, mis-targeted, or ineffective input', () => {
	const checks = evaluateNativeWheelSmoke({
		nativeInput: { posted: true },
		before: { scrollTop: 0, visibleRowIndex: 0 },
		after: {
			scrollTop: 0,
			visibleRowIndex: 0,
			wheelEvents: [
				{ isTrusted: false, pathContainsViewport: true },
				{ isTrusted: true, pathContainsViewport: false }
			]
		}
	});
	assert.deepEqual(checks, {
		nativeInputPosted: true,
		trustedWheelObserved: true,
		wheelTargetedViewport: false,
		viewportMoved: false,
		visibleRowChanged: false
	});
});
