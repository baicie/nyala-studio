import assert from 'node:assert/strict';
import test from 'node:test';

import {
	assertSqlDriverEnabled,
	getSqlDriverDescriptor,
	isSqlDriverEnabled,
	listEnabledSqlDrivers,
	listPlannedSqlDrivers,
	listSqlDriverDescriptors,
	SqlDriverAvailability
} from '../common/sqlDrivers.js';
import { SqlDialect } from '../common/sqlDialect.js';
import { SqlConnectionKind } from '../common/sqlTypes.js';

test('driver catalog contains sqlite postgresql and mysql', () => {
	assert.deepEqual(
		listSqlDriverDescriptors().map(driver => driver.id),
		[
			SqlConnectionKind.Sqlite,
			SqlConnectionKind.PostgreSql,
			SqlConnectionKind.MySql
		]
	);
});

test('SQLite driver is enabled', () => {
	const sqlite = getSqlDriverDescriptor(SqlConnectionKind.Sqlite);

	assert.equal(sqlite.label, 'SQLite');
	assert.equal(sqlite.dialect, SqlDialect.Sqlite);
	assert.equal(sqlite.availability, SqlDriverAvailability.Enabled);
	assert.equal(sqlite.capabilities.fileBased, true);
	assert.equal(sqlite.capabilities.remote, false);
	assert.equal(sqlite.capabilities.credentials, false);
	assert.equal(isSqlDriverEnabled(SqlConnectionKind.Sqlite), true);
	assert.doesNotThrow(() => assertSqlDriverEnabled(SqlConnectionKind.Sqlite));
});

test('PostgreSQL driver is planned', () => {
	const postgres = getSqlDriverDescriptor(SqlConnectionKind.PostgreSql);

	assert.equal(postgres.label, 'PostgreSQL');
	assert.equal(postgres.dialect, SqlDialect.PostgreSql);
	assert.equal(postgres.availability, SqlDriverAvailability.Planned);
	assert.equal(postgres.defaultPorts?.default, 5432);
	assert.equal(postgres.capabilities.remote, true);
	assert.equal(postgres.capabilities.credentials, true);
	assert.equal(isSqlDriverEnabled(SqlConnectionKind.PostgreSql), false);
	assert.throws(() => assertSqlDriverEnabled(SqlConnectionKind.PostgreSql), /planned/);
});

test('MySQL driver is planned', () => {
	const mysql = getSqlDriverDescriptor(SqlConnectionKind.MySql);

	assert.equal(mysql.label, 'MySQL');
	assert.equal(mysql.dialect, SqlDialect.MySql);
	assert.equal(mysql.availability, SqlDriverAvailability.Planned);
	assert.equal(mysql.defaultPorts?.default, 3306);
	assert.equal(mysql.capabilities.remote, true);
	assert.equal(mysql.capabilities.credentials, true);
	assert.equal(isSqlDriverEnabled(SqlConnectionKind.MySql), false);
	assert.throws(() => assertSqlDriverEnabled(SqlConnectionKind.MySql), /planned/);
});

test('listEnabledSqlDrivers returns only SQLite', () => {
	assert.deepEqual(
		listEnabledSqlDrivers().map(driver => driver.id),
		[SqlConnectionKind.Sqlite]
	);
});

test('listPlannedSqlDrivers returns PostgreSQL and MySQL', () => {
	assert.deepEqual(
		listPlannedSqlDrivers().map(driver => driver.id),
		[SqlConnectionKind.PostgreSql, SqlConnectionKind.MySql]
	);
});
