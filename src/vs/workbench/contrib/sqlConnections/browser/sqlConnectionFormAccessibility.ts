/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection form accessibility helpers.
 *--------------------------------------------------------------------------------------------*/

import type {
	SqlConnectionFormFieldRequirements,
	SqlConnectionFormMissingField
} from '../common/sqlConnectionFormModel.js';

const SQL_CONNECTION_FORM_ACCESSIBILITY_FIELDS: readonly SqlConnectionFormMissingField[] = [
	'databasePath',
	'host',
	'port',
	'database',
	'username'
];

export interface SqlConnectionFormAccessibilityControl {
	required: boolean;
	readonly classList: {
		toggle(token: string, force: boolean): void;
	};
	setAttribute(name: string, value: string): void;
	removeAttribute(name: string): void;
}

export interface SqlConnectionFormAccessibilityOptions<TControl extends SqlConnectionFormAccessibilityControl> {
	readonly controls: Readonly<Record<SqlConnectionFormMissingField, TControl>>;
	readonly requirements: SqlConnectionFormFieldRequirements;
	readonly missingFields: readonly SqlConnectionFormMissingField[];
	readonly touchedControls: ReadonlySet<TControl>;
	readonly describedBy: string;
}

export function applySqlConnectionFormAccessibility<TControl extends SqlConnectionFormAccessibilityControl>(
	options: SqlConnectionFormAccessibilityOptions<TControl>
): boolean {
	const missingFields = new Set(options.missingFields);
	let hasVisibleError = false;

	for (const field of SQL_CONNECTION_FORM_ACCESSIBILITY_FIELDS) {
		const control = options.controls[field];
		const required = options.requirements[field];
		const invalid = options.touchedControls.has(control) && missingFields.has(field);

		control.required = required;
		setBooleanAttribute(control, 'aria-required', required);
		if (required) {
			control.setAttribute('aria-describedby', options.describedBy);
		} else {
			control.removeAttribute('aria-describedby');
		}

		control.classList.toggle('invalid', invalid);
		setBooleanAttribute(control, 'aria-invalid', invalid);
		hasVisibleError ||= invalid;
	}

	return hasVisibleError;
}

function setBooleanAttribute(
	control: SqlConnectionFormAccessibilityControl,
	name: 'aria-required' | 'aria-invalid',
	enabled: boolean
): void {
	if (enabled) {
		control.setAttribute(name, 'true');
	} else {
		control.removeAttribute(name);
	}
}
