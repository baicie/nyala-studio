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

test('SQL_CONNECTION_PREVIEW_KINDS exposes SQLite and PostgreSQL only', () => {
	assert.deepEqual(SQL_CONNECTION_PREVIEW_KINDS, [
		SqlConnectionKind.Sqlite,
		SqlConnectionKind.PostgreSql
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

test('createDefaultSqlConnectionFormState creates PostgreSQL preview defaults', () => {
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

test('normalizeSqlConnectionFormState disables save and autoConnect for PostgreSQL preview', () => {
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

test('createSqlConnectionInputFromFormState creates PostgreSQL preview input', () => {
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
	assert.equal(preview.maskedInput.password, undefined);
	assert.match(preview.message, /preview-only/);
});

test('canSubmitSqlConnectionForm returns false for PostgreSQL preview', () => {
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
		'PostgreSQL Preview · localhost:5432/app · PostgreSQL is preview-only in Phase 9.1. Runtime connection is not enabled yet.'
	);
});
