/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection form busy-state helpers.
 *--------------------------------------------------------------------------------------------*/

export interface SqlConnectionFormTextControl {
	disabled: boolean;
}

export function setSqlConnectionFormTextControlsBusy(
	controls: readonly SqlConnectionFormTextControl[],
	isBusy: boolean
): void {
	for (const control of controls) {
		control.disabled = isBusy;
	}
}
