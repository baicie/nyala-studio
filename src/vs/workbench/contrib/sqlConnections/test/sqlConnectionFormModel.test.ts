import assert from 'node:assert/strict';
import test from 'node:test';

import {
	canSaveSqlConnectionForm,
	canSubmitSqlConnectionForm,
	createDefaultSqlConnectionFormState,
	createSqlConnectionFormPreview,
	createSqlConnectionInputFromFormState,
	getSqlConnectionFormStatus,
	maskSqlConnectionInput,
	normalizeSqlConnectionFormState,
	SQL_CONNECTION_PREVIEW_KINDS
} from '../common/sqlConnectionFormModel.js';
import { SqlDriverAvailability } from '../../../services/sql/common/sqlDrivers.js';
import {
	SqlConnectionKind,
	SqlSslMode
} from '../../../services/sql/common/sqlTypes.js';

test('SQL_CONNECTION_PREVIEW_KINDS exposes SQLite PostgreSQL and MySQL', () => {
	assert.deepEqual(SQL_CONNECTION_PREVIEW_KINDS, [
		SqlConnectionKind.Sqlite,
		SqlConnectionKind.PostgreSql,
		SqlConnectionKind.MySql
	]);
});

test('createDefaultSqlConnectionFormState creates SQLite defaults', () => {
	assert.deepEqual(createDefaultSqlConnectionFormState(SqlConnectionKind.Sqlite), {
		kind: SqlConnectionKind.Sqlite,
		name: undefined,
		databasePath: ':memory:',
		readOnly: false,
		createIfMissing: true,
		saveConnection: false,
		autoConnect: false
	});
});

test('createDefaultSqlConnectionFormState creates PostgreSQL planned defaults', () => {
	assert.deepEqual(createDefaultSqlConnectionFormState(SqlConnectionKind.PostgreSql), {
		kind: SqlConnectionKind.PostgreSql,
		name: undefined,
		host: 'localhost',
		port: 5432,
		database: 'postgres',
		username: undefined,
		password: undefined,
		sslMode: SqlSslMode.Prefer,
		readOnly: false,
		createIfMissing: false,
		saveConnection: false,
		autoConnect: false
	});
});

test('createDefaultSqlConnectionFormState creates MySQL defaults', () => {
	assert.deepEqual(createDefaultSqlConnectionFormState(SqlConnectionKind.MySql), {
		kind: SqlConnectionKind.MySql,
		name: undefined,
		host: 'localhost',
		port: 3306,
		database: 'mysql',
		username: undefined,
		password: undefined,
		sslMode: SqlSslMode.Prefer,
		readOnly: false,
		createIfMissing: false,
		saveConnection: false,
		autoConnect: false
	});
});

test('normalizeSqlConnectionFormState normalizes SQLite fields', () => {
	const state = normalizeSqlConnectionFormState({
		kind: SqlConnectionKind.Sqlite,
		name: ' Local ',
		databasePath: ' /tmp/app.db ',
		readOnly: true,
		createIfMissing: false,
		saveConnection: true,
		autoConnect: true
	});

	assert.deepEqual(state, {
		kind: SqlConnectionKind.Sqlite,
		name: 'Local',
		databasePath: '/tmp/app.db',
		readOnly: true,
		createIfMissing: false,
		saveConnection: true,
		autoConnect: true
	});
});

test('normalizeSqlConnectionFormState disables save and autoConnect for PostgreSQL planned driver', () => {
	const state = normalizeSqlConnectionFormState({
		kind: SqlConnectionKind.PostgreSql,
		name: ' PG ',
		host: ' db.local ',
		port: 15432,
		database: ' app ',
		username: ' user ',
		password: ' secret ',
		sslMode: SqlSslMode.Require,
		saveConnection: true,
		autoConnect: true,
		readOnly: true,
		createIfMissing: true
	});

	assert.deepEqual(state, {
		kind: SqlConnectionKind.PostgreSql,
		name: 'PG',
		host: 'db.local',
		port: 15432,
		database: 'app',
		username: 'user',
		password: 'secret',
		sslMode: SqlSslMode.Require,
		readOnly: false,
		createIfMissing: false,
		saveConnection: false,
		autoConnect: false
	});
});

test('createSqlConnectionInputFromFormState creates SQLite input', () => {
	assert.deepEqual(
		createSqlConnectionInputFromFormState({
			kind: SqlConnectionKind.Sqlite,
			name: 'Local',
			databasePath: '/tmp/app.db',
			readOnly: true,
			createIfMissing: false
		}),
		{
			name: 'Local',
			kind: SqlConnectionKind.Sqlite,
			databasePath: '/tmp/app.db',
			readOnly: true,
			createIfMissing: false
		}
	);
});

test('createSqlConnectionInputFromFormState creates PostgreSQL planned input', () => {
	assert.deepEqual(
		createSqlConnectionInputFromFormState({
			kind: SqlConnectionKind.PostgreSql,
			name: 'App PG',
			host: 'localhost',
			port: 5432,
			database: 'app',
			username: 'user',
			password: 'secret',
			sslMode: SqlSslMode.Require
		}),
		{
			name: 'App PG',
			kind: SqlConnectionKind.PostgreSql,
			host: 'localhost',
			port: 5432,
			database: 'app',
			username: 'user',
			password: 'secret',
			sslMode: SqlSslMode.Require,
			readOnly: false,
			createIfMissing: false
		}
	);
});

test('maskSqlConnectionInput removes password', () => {
	assert.deepEqual(
		maskSqlConnectionInput({
			kind: SqlConnectionKind.PostgreSql,
			host: 'localhost',
			port: 5432,
			database: 'app',
			username: 'user',
			password: 'secret',
			sslMode: SqlSslMode.Prefer
		}),
		{
			kind: SqlConnectionKind.PostgreSql,
			host: 'localhost',
			port: 5432,
			database: 'app',
			username: 'user',
			sslMode: SqlSslMode.Prefer
		}
	);
});

test('createSqlConnectionFormPreview allows SQLite connect', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.Sqlite,
		databasePath: '/tmp/app.db'
	});

	assert.equal(preview.label, 'SQLite');
	assert.equal(preview.availability, SqlDriverAvailability.Enabled);
	assert.equal(preview.canConnect, true);
	assert.equal(preview.summary, 'SQLite · /tmp/app.db');
});

test('createSqlConnectionFormPreview prevents saving memory SQLite connection', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.Sqlite,
		databasePath: ':memory:',
		saveConnection: true
	});

	assert.equal(preview.canConnect, true);
	assert.equal(preview.canSave, false);
});

test('createSqlConnectionFormPreview blocks PostgreSQL connect', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.PostgreSql,
		host: 'localhost',
		port: 5432,
		database: 'app',
		username: 'user',
		password: 'secret'
	});

	assert.equal(preview.label, 'PostgreSQL');
	assert.equal(preview.availability, SqlDriverAvailability.Planned);
	assert.equal(preview.canConnect, false);
	assert.equal(preview.canSave, false);
	assert.equal(preview.input.password, undefined);
	assert.equal(preview.maskedInput.password, undefined);
	assert.match(preview.message, /planned/);
});

test('canSubmitSqlConnectionForm returns false for PostgreSQL planned driver', () => {
	assert.equal(
		canSubmitSqlConnectionForm({
			kind: SqlConnectionKind.PostgreSql,
			host: 'localhost',
			database: 'app'
		}),
		false
	);
});

test('canSaveSqlConnectionForm returns true only for persistable SQLite', () => {
	assert.equal(
		canSaveSqlConnectionForm({
			kind: SqlConnectionKind.Sqlite,
			databasePath: '/tmp/app.db',
			saveConnection: true
		}),
		true
	);

	assert.equal(
		canSaveSqlConnectionForm({
			kind: SqlConnectionKind.Sqlite,
			databasePath: ':memory:',
			saveConnection: true
		}),
		false
	);
});

test('getSqlConnectionFormStatus returns preview status', () => {
	assert.equal(
		getSqlConnectionFormStatus({
			kind: SqlConnectionKind.PostgreSql,
			host: 'localhost',
			port: 5432,
			database: 'app'
		}),
		'PostgreSQL Planned · localhost:5432/app · PostgreSQL is planned. Runtime connection is not enabled yet.'
	);
});

test('blank SQLite database path stays blank instead of falling back to memory database', () => {
	const state = normalizeSqlConnectionFormState({
		kind: SqlConnectionKind.Sqlite,
		databasePath: '   '
	});

	assert.equal(state.databasePath, '');

	const preview = createSqlConnectionFormPreview(state);

	assert.equal(preview.canConnect, false);
	assert.equal(preview.canSave, false);
	assert.equal(preview.summary, 'SQLite · missing database path');
	assert.equal(preview.message, 'SQLite database path is required.');
});

test('undefined SQLite database path still uses default memory database', () => {
	const state = normalizeSqlConnectionFormState({
		kind: SqlConnectionKind.Sqlite
	});

	assert.equal(state.databasePath, ':memory:');

	const preview = createSqlConnectionFormPreview(state);

	assert.equal(preview.canConnect, true);
	assert.equal(preview.canSave, false);
	assert.equal(preview.summary, 'SQLite · :memory:');
});

test('PostgreSQL planned input is masked and does not expose password', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.PostgreSql,
		host: 'localhost',
		port: 5432,
		database: 'app',
		username: 'user',
		password: 'secret'
	});

	assert.equal(preview.input.password, undefined);
	assert.equal(preview.maskedInput.password, undefined);
	assert.deepEqual(preview.input, preview.maskedInput);
});

test('PostgreSQL preview reports missing host and database', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.PostgreSql,
		host: '   ',
		database: '   ',
		port: 5432
	});

	assert.equal(preview.canConnect, false);
	assert.equal(preview.canSave, false);
	assert.equal(preview.summary, 'PostgreSQL Planned · missing host, database');
	assert.equal(
		preview.message,
		'PostgreSQL Planned is missing host, database. Runtime connection is not enabled yet.'
	);
});

test('createSqlConnectionFormPreview allows MySQL connect', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: 'app',
		username: 'root',
		password: 'secret'
	});

	assert.equal(preview.label, 'MySQL');
	assert.equal(preview.availability, SqlDriverAvailability.Enabled);
	assert.equal(preview.canConnect, true);
	assert.equal(preview.canSave, false);
	assert.equal(preview.message, 'MySQL Preview runtime is ready. Query cancellation is not supported yet.');
	assert.equal(preview.summary, 'MySQL Preview · localhost:3306/app');
	assert.equal(preview.input.password, undefined);
});

test('canSaveSqlConnectionForm allows MySQL public profile save without auto connect', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: 'app',
		saveConnection: true,
		autoConnect: true
	});

	assert.equal(preview.canConnect, true);
	assert.equal(preview.canSave, true);

	const state = normalizeSqlConnectionFormState({
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: 'app',
		saveConnection: true,
		autoConnect: true
	});

	assert.equal(state.saveConnection, true);
	assert.equal(state.autoConnect, false);
});

test('MySQL preview reports missing database', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: ''
	});

	assert.equal(preview.canConnect, false);
	assert.equal(preview.summary, 'MySQL Preview · missing database');
	assert.equal(preview.message, 'MySQL connection is missing database.');
});

test('MySQL preview input is masked and does not expose password', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: 'app',
		username: 'root',
		password: 'secret'
	});

	assert.equal(preview.input.password, undefined);
	assert.equal(preview.maskedInput.password, undefined);
	assert.deepEqual(preview.input, preview.maskedInput);
});
