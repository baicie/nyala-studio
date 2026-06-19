import assert from 'node:assert/strict';
import test from 'node:test';

import {
	getSqlDriverDescriptor,
	isSqlDriverEnabled,
	listEnabledSqlDrivers,
	SQLITE_DRIVER,
	SqlDriverAvailability
} from '../common/sqlDrivers.js';
import { SqlDialect } from '../common/sqlDialect.js';
import { SqlConnectionKind } from '../common/sqlTypes.js';

test('SQLITE_DRIVER describes sqlite capabilities', () => {
	assert.equal(SQLITE_DRIVER.id, SqlConnectionKind.Sqlite);
	assert.equal(SQLITE_DRIVER.label, 'SQLite');
	assert.equal(SQLITE_DRIVER.dialect, SqlDialect.Sqlite);
	assert.equal(SQLITE_DRIVER.availability, SqlDriverAvailability.Enabled);
	assert.equal(SQLITE_DRIVER.capabilities.fileBased, true);
	assert.equal(SQLITE_DRIVER.capabilities.remote, false);
	assert.equal(SQLITE_DRIVER.capabilities.createIfMissing, true);
});

test('getSqlDriverDescriptor returns sqlite descriptor', () => {
	assert.equal(getSqlDriverDescriptor(SqlConnectionKind.Sqlite), SQLITE_DRIVER);
});

test('isSqlDriverEnabled returns true for sqlite', () => {
	assert.equal(isSqlDriverEnabled(SqlConnectionKind.Sqlite), true);
});

test('listEnabledSqlDrivers only includes enabled drivers', () => {
	assert.deepEqual(listEnabledSqlDrivers(), [SQLITE_DRIVER]);
});

test('enabled SQL drivers must match currently supported connection kinds', () => {
	const enabledDrivers = listEnabledSqlDrivers();

	assert.deepEqual(
		enabledDrivers.map(driver => driver.id),
		[SqlConnectionKind.Sqlite]
	);

	for (const driver of enabledDrivers) {
		assert.equal(driver.availability, SqlDriverAvailability.Enabled);
	}
});
