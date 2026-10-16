import assert from 'node:assert/strict';
import test from 'node:test';
import {
	FRAME_AWARE_BOUNDARY_VERSION,
	FRAME_AWARE_CALIBRATION_MAX_ABSOLUTE_CHANGE_MS,
	FRAME_AWARE_CALIBRATION_MAX_RELATIVE_CHANGE,
	FRAME_AWARE_MEASUREMENT_CONTRACT_VERSION,
	createFrameAwareContractMetadata,
	rendererOperationDuration,
	validateFrameAwareCalibration,
	validateFrameAwareContractMetadata
} from './sql-result-grid-frame-aware-contract.mjs';

test('v8 metadata is deterministic and validates its pre-registered values', () => {
	const metadata = createFrameAwareContractMetadata();
	assert.equal(metadata.measurementContractVersion, FRAME_AWARE_MEASUREMENT_CONTRACT_VERSION);
	assert.deepEqual(validateFrameAwareContractMetadata(metadata), []);
	assert.match(
		validateFrameAwareContractMetadata({ ...metadata, boundaryVersion: 'commit-only-v1' })[0],
		/boundaryVersion/
	);
});

test('v8 calibration requires the declared renderer-work limits', () => {
	const valid = {
		version: 1,
		passed: true,
		rendererWorkRelativeChange: FRAME_AWARE_CALIBRATION_MAX_RELATIVE_CHANGE,
		rendererWorkAbsoluteChangeMs: FRAME_AWARE_CALIBRATION_MAX_ABSOLUTE_CHANGE_MS,
		totalRelativeChange: 0.03
	};
	assert.deepEqual(validateFrameAwareCalibration(valid), []);
	assert.match(
		validateFrameAwareCalibration({ ...valid, rendererWorkRelativeChange: 0.051 }).join(' '),
		/relative change/
	);
});

test('v8 renderer operation duration requires a same-boundary operation', () => {
	const operation = {
		boundaryVersion: FRAME_AWARE_BOUNDARY_VERSION,
		startTime: 10,
		endTime: 13.25,
		durationMs: 3.25,
		commitTransactionIds: [4]
	};
	assert.equal(rendererOperationDuration(operation), 3.25);
	assert.equal(rendererOperationDuration({ ...operation, endTime: 14 }), undefined);
	assert.equal(rendererOperationDuration({ ...operation, commitTransactionIds: [] }), undefined);
});
