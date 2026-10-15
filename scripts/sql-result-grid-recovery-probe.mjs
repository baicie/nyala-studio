export const RECOVERY_PROBE_PHASE_BOUNDARY_REASON = 'recovery-probe-phase-boundary';

export function getRecoveryProbeRestartReason({ recoveryProbe, workloadId, iteration }) {
	return recoveryProbe && workloadId === 'narrow-panel' && iteration === 1
		? RECOVERY_PROBE_PHASE_BOUNDARY_REASON
		: undefined;
}

export function validateRecoveryProbe(records, appRestarts, repeat) {
	const nativeRecords = records.filter(record => record.workloadId === '10k-x-50');
	const narrowRecords = records.filter(record => record.workloadId === 'narrow-panel');
	const boundaryRestarts = appRestarts.filter(restart => restart.reason === RECOVERY_PROBE_PHASE_BOUNDARY_REASON);
	const restart = boundaryRestarts[0];
	const preBoundaryProcessIds = new Set(
		appRestarts
			.filter(candidate => candidate !== restart)
			.flatMap(candidate => [candidate.previousProcessId, candidate.nextProcessId])
			.concat(restart?.previousProcessId)
	);
	const lastNativeRecord = nativeRecords.at(-1);
	const checks = {
		exactlyOneBoundaryRestart: boundaryRestarts.length === 1 && appRestarts.at(-1) === restart,
		oldProcessStopped: restart?.status === 'recovered' && restart.stopConfirmed === true,
		endpointReleased: restart?.endpointReleased === true,
		newDriverReady: restart?.driverReady === true,
		processChanged:
			restart?.previousProcessId !== undefined &&
			restart?.nextProcessId !== undefined &&
			restart.previousProcessId !== restart.nextProcessId,
		sessionChanged:
			restart?.previousSessionId !== undefined &&
			restart?.nextSessionId !== undefined &&
			restart.previousSessionId !== restart.nextSessionId,
		generationChanged:
			restart?.previousGeneration !== undefined &&
			restart?.nextGeneration !== undefined &&
			restart.previousGeneration !== restart.nextGeneration,
		nativePhaseComplete: nativeRecords.length === repeat && nativeRecords.every(record => record.status === 'ok'),
		nativePhaseBeforeRestart:
			Boolean(restart) &&
			nativeRecords.every(
				record => record.appGeneration < restart.nextGeneration && preBoundaryProcessIds.has(record.appProcessId)
			) &&
			lastNativeRecord?.appGeneration === restart.previousGeneration &&
			lastNativeRecord?.appProcessId === restart.previousProcessId,
		narrowPhaseComplete: narrowRecords.length === repeat && narrowRecords.every(record => record.status === 'ok'),
		narrowPhaseAfterRestart:
			Boolean(restart) &&
			narrowRecords.every(
				record => record.appGeneration === restart.nextGeneration && record.appProcessId === restart.nextProcessId
			)
	};
	const failedChecks = Object.entries(checks)
		.filter(([, passed]) => !passed)
		.map(([name]) => name);
	return {
		passed: failedChecks.length === 0,
		checks,
		reason:
			failedChecks.length === 0
				? 'The 10k native phase completed before a whole-app restart at the phase boundary; all narrow-panel records used the ready replacement app.'
				: `Windows recovery probe failed checks: ${failedChecks.join(', ')}.`
	};
}
