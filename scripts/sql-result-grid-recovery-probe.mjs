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
	const checks = {
		exactlyOneRestart: appRestarts.length === 1 && boundaryRestarts.length === 1,
		oldProcessStopped: restart?.status === 'recovered' && restart.stopConfirmed === true,
		endpointReleased: restart?.endpointReleased === true,
		newDriverReady: restart?.driverReady === true,
		processChanged: restart?.previousProcessId !== restart?.nextProcessId,
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
				record =>
					record.appGeneration === restart.previousGeneration && record.appProcessId === restart.previousProcessId
			),
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
				? '10k native records completed before one whole-app restart; all narrow-panel records used the ready replacement app.'
				: `Windows recovery probe failed checks: ${failedChecks.join(', ')}.`
	};
}
