/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection form accessibility tests.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	applySqlConnectionFormAccessibility,
	SqlConnectionFormAccessibilityControl
} from '../browser/sqlConnectionFormAccessibility.js';
import {
	getSqlConnectionFormFieldRequirements,
	SqlConnectionFormMissingField,
	SqliteConnectionMode
} from '../common/sqlConnectionFormModel.js';
import { SqlConnectionKind } from '../../../services/sql/common/sqlTypes.js';

const STATUS_ID = 'sql-connector-form-status';

class RecordingClassList {
	readonly values = new Set<string>();
	readonly operations: string[] = [];

	toggle(token: string, force: boolean): void {
		this.operations.push(`toggle:${token}:${force}`);
		if (force) {
			this.values.add(token);
		} else {
			this.values.delete(token);
		}
	}
}

class RecordingControl implements SqlConnectionFormAccessibilityControl {
	required = false;
	readonly attributes = new Map<string, string>();
	readonly classList = new RecordingClassList();
	readonly operations: string[] = [];

	setAttribute(name: string, value: string): void {
		this.operations.push(`set:${name}:${value}`);
		this.attributes.set(name, value);
	}

	removeAttribute(name: string): void {
		this.operations.push(`remove:${name}`);
		this.attributes.delete(name);
	}
}

function createControls(): Record<SqlConnectionFormMissingField, RecordingControl> {
	return {
		databasePath: new RecordingControl(),
		host: new RecordingControl(),
		port: new RecordingControl(),
		database: new RecordingControl(),
		username: new RecordingControl()
	};
}

test('connection form accessibility follows connector requirements and touched validity', () => {
	const controls = createControls();
	const touchedControls = new Set<RecordingControl>();

	const sqliteHasVisibleError = applySqlConnectionFormAccessibility({
		controls,
		requirements: getSqlConnectionFormFieldRequirements({
			kind: SqlConnectionKind.Sqlite,
			sqliteMode: SqliteConnectionMode.File
		}),
		missingFields: ['databasePath'],
		touchedControls,
		describedBy: STATUS_ID
	});

	assert.equal(sqliteHasVisibleError, false);
	assert.equal(controls.databasePath.required, true);
	assert.equal(controls.databasePath.attributes.get('aria-required'), 'true');
	assert.equal(controls.databasePath.attributes.get('aria-describedby'), STATUS_ID);
	assert.equal(controls.databasePath.attributes.has('aria-invalid'), false);
	assert.equal(controls.databasePath.classList.values.has('invalid'), false);
	assert.equal(controls.host.required, false);

	const mysqlRequirements = getSqlConnectionFormFieldRequirements({ kind: SqlConnectionKind.MySql });
	const mysqlMissingFields: readonly SqlConnectionFormMissingField[] = ['host', 'port', 'database', 'username'];
	const untouchedMysqlHasVisibleError = applySqlConnectionFormAccessibility({
		controls,
		requirements: mysqlRequirements,
		missingFields: mysqlMissingFields,
		touchedControls,
		describedBy: STATUS_ID
	});

	assert.equal(untouchedMysqlHasVisibleError, false);
	assert.equal(controls.databasePath.required, false);
	assert.equal(controls.databasePath.attributes.has('aria-required'), false);
	assert.equal(controls.databasePath.attributes.has('aria-describedby'), false);
	for (const field of ['host', 'port', 'database', 'username'] as const) {
		assert.equal(controls[field].required, true);
		assert.equal(controls[field].attributes.get('aria-required'), 'true');
		assert.equal(controls[field].attributes.get('aria-describedby'), STATUS_ID);
		assert.equal(controls[field].attributes.has('aria-invalid'), false);
	}

	touchedControls.add(controls.host);
	const touchedMysqlHasVisibleError = applySqlConnectionFormAccessibility({
		controls,
		requirements: mysqlRequirements,
		missingFields: mysqlMissingFields,
		touchedControls,
		describedBy: STATUS_ID
	});

	assert.equal(touchedMysqlHasVisibleError, true);
	assert.equal(controls.host.attributes.get('aria-invalid'), 'true');
	assert.equal(controls.host.classList.values.has('invalid'), true);
	assert.equal(controls.host.classList.operations.at(-1), 'toggle:invalid:true');

	const restoredMysqlHasVisibleError = applySqlConnectionFormAccessibility({
		controls,
		requirements: mysqlRequirements,
		missingFields: [],
		touchedControls,
		describedBy: STATUS_ID
	});

	assert.equal(restoredMysqlHasVisibleError, false);
	assert.equal(controls.host.attributes.has('aria-invalid'), false);
	assert.equal(controls.host.classList.values.has('invalid'), false);
	assert.equal(controls.host.classList.operations.at(-1), 'toggle:invalid:false');
});
