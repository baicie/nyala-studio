/**
 * Accepted v8 contract for renderer-owned scroll work.
 *
 * v7 remains frozen for historical admission evidence. v8 is intentionally a
 * separate contract because its samples are associated with the same scroll
 * execution rather than a separately navigated diagnostic trace.
 */
export const FRAME_AWARE_MEASUREMENT_CONTRACT_VERSION = 8;
export const FRAME_AWARE_CONTRACT_VERSION = 1;
export const FRAME_AWARE_TIMING_CLOCK = 'performance-now';
export const FRAME_AWARE_CORRELATION = 'same-input-renderer-operation-v1';
export const FRAME_AWARE_BOUNDARY_VERSION = 'symmetric-renderer-work-v1';
export const FRAME_AWARE_ADMISSION_METRIC = 'rendererWorkP50Ms';
export const FRAME_AWARE_BASELINE_RENDERER = 'workbench-table';
export const FRAME_AWARE_REQUIRED_IMPROVEMENT = 0.2;
export const FRAME_AWARE_TOTAL_REGRESSION_LIMIT = 0.1;
export const FRAME_AWARE_CALIBRATION_VERSION = 1;
export const FRAME_AWARE_CALIBRATION_MAX_RELATIVE_CHANGE = 0.05;
export const FRAME_AWARE_CALIBRATION_MAX_ABSOLUTE_CHANGE_MS = 0.25;

export function createFrameAwareContractMetadata(overrides = {}) {
	return {
		version: FRAME_AWARE_CONTRACT_VERSION,
		measurementContractVersion: FRAME_AWARE_MEASUREMENT_CONTRACT_VERSION,
		timingClock: FRAME_AWARE_TIMING_CLOCK,
		correlation: FRAME_AWARE_CORRELATION,
		boundaryVersion: FRAME_AWARE_BOUNDARY_VERSION,
		admissionMetric: FRAME_AWARE_ADMISSION_METRIC,
		baselineRenderer: FRAME_AWARE_BASELINE_RENDERER,
		requiredImprovement: FRAME_AWARE_REQUIRED_IMPROVEMENT,
		totalRegressionLimit: FRAME_AWARE_TOTAL_REGRESSION_LIMIT,
		calibrationVersion: FRAME_AWARE_CALIBRATION_VERSION,
		calibrationMaxRelativeChange: FRAME_AWARE_CALIBRATION_MAX_RELATIVE_CHANGE,
		calibrationMaxAbsoluteChangeMs: FRAME_AWARE_CALIBRATION_MAX_ABSOLUTE_CHANGE_MS,
		...overrides
	};
}

export function validateFrameAwareContractMetadata(value) {
	const errors = [];
	if (!isRecord(value)) return ['frameAwareContract is missing'];
	const expected = createFrameAwareContractMetadata();
	for (const field of [
		'version',
		'measurementContractVersion',
		'timingClock',
		'correlation',
		'boundaryVersion',
		'admissionMetric',
		'baselineRenderer',
		'requiredImprovement',
		'totalRegressionLimit',
		'calibrationVersion',
		'calibrationMaxRelativeChange',
		'calibrationMaxAbsoluteChangeMs'
	]) {
		if (value[field] !== expected[field]) {
			errors.push(`frameAwareContract.${field} must be ${String(expected[field])}`);
		}
	}
	return errors;
}

export function validateFrameAwareCalibration(value) {
	const errors = [];
	if (!isRecord(value)) return ['frameAwareCalibration is missing'];
	if (value.version !== FRAME_AWARE_CALIBRATION_VERSION) {
		errors.push(`frameAwareCalibration.version must be ${FRAME_AWARE_CALIBRATION_VERSION}`);
	}
	if (value.passed !== true) errors.push('frameAwareCalibration.passed must be true');
	for (const field of ['rendererWorkRelativeChange', 'rendererWorkAbsoluteChangeMs', 'totalRelativeChange']) {
		if (!Number.isFinite(value[field]) || value[field] < 0) {
			errors.push(`frameAwareCalibration.${field} must be a non-negative finite number`);
		}
	}
	if (
		Number.isFinite(value.rendererWorkRelativeChange) &&
		value.rendererWorkRelativeChange > FRAME_AWARE_CALIBRATION_MAX_RELATIVE_CHANGE
	) {
		errors.push('frameAwareCalibration renderer-work relative change exceeds the 5% limit');
	}
	if (
		Number.isFinite(value.rendererWorkAbsoluteChangeMs) &&
		value.rendererWorkAbsoluteChangeMs > FRAME_AWARE_CALIBRATION_MAX_ABSOLUTE_CHANGE_MS
	) {
		errors.push('frameAwareCalibration renderer-work absolute change exceeds the 0.25ms limit');
	}
	return errors;
}

export function rendererOperationDuration(operation) {
	if (
		!isRecord(operation) ||
		operation.boundaryVersion !== FRAME_AWARE_BOUNDARY_VERSION ||
		!Number.isFinite(operation.startTime) ||
		!Number.isFinite(operation.endTime) ||
		operation.endTime < operation.startTime ||
		!Number.isFinite(operation.durationMs) ||
		Math.abs(operation.durationMs - (operation.endTime - operation.startTime)) > 0.05 ||
		!Array.isArray(operation.commitTransactionIds) ||
		operation.commitTransactionIds.length === 0
	) {
		return undefined;
	}
	return operation.durationMs;
}

function isRecord(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
