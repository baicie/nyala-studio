import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createConnectionProfileFromInput,
	getConnectionDisplayName,
	maskConnectionInput,
	SqlConnectionProfileMode,
	toConnectionInput
} from '../common/sqlConnectionProfile.js';
import { SqlConnectionKind, SqlSslMode } from '../common/sqlTypes.js';

test('createConnectionProfileFromInput creates sqlite file profile', () => {
	const profile = createConnectionProfileFromInput({
		kind: SqlConnectionKind.Sqlite,
		name: ' Local ',
		databasePath: ' /tmp/app.db ',
		readOnly: true,
		createIfMissing: true
	});

	assert.deepEqual(profile, {
		id: undefined,
		name: 'Local',
		kind: SqlConnectionKind.Sqlite,
		mode: SqlConnectionProfileMode.File,
		label: 'Local',
		databasePath: '/tmp/app.db',
		readOnly: true,
		createIfMissing: true
	});
});

test('createConnectionProfileFromInput creates postgresql network profile', () => {
	const profile = createConnectionProfileFromInput({
		kind: SqlConnectionKind.PostgreSql,
		host: ' localhost ',
		database: ' app ',
		username: ' user ',
		sslMode: SqlSslMode.Require
	});

	assert.equal(profile.kind, SqlConnectionKind.PostgreSql);
	assert.equal(profile.mode, SqlConnectionProfileMode.Network);
	assert.equal(profile.host, 'localhost');
	assert.equal(profile.port, 5432);
	assert.equal(profile.database, 'app');
	assert.equal(profile.username, 'user');
	assert.equal(profile.sslMode, SqlSslMode.Require);
	assert.equal(profile.label, 'PostgreSQL · localhost:5432/app');
});

test('createConnectionProfileFromInput creates mysql network profile', () => {
	const profile = createConnectionProfileFromInput({
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3307,
		database: 'app'
	});

	assert.equal(profile.kind, SqlConnectionKind.MySql);
	assert.equal(profile.mode, SqlConnectionProfileMode.Network);
	assert.equal(profile.port, 3307);
	assert.equal(profile.sslMode, SqlSslMode.Prefer);
	assert.equal(profile.label, 'MySQL · localhost:3307/app');
});

test('toConnectionInput converts profile back to input', () => {
	const profile = createConnectionProfileFromInput({
		id: 'db1',
		name: 'App DB',
		kind: SqlConnectionKind.Sqlite,
		databasePath: '/tmp/app.db',
		readOnly: true,
		createIfMissing: true
	});

	assert.deepEqual(toConnectionInput(profile), {
		id: 'db1',
		name: 'App DB',
		kind: SqlConnectionKind.Sqlite,
		databasePath: '/tmp/app.db',
		readOnly: true,
		createIfMissing: true
	});
});

test('getConnectionDisplayName returns profile label', () => {
	assert.equal(
		getConnectionDisplayName({
			kind: SqlConnectionKind.Sqlite,
			databasePath: '/tmp/app.db'
		}),
		'/tmp/app.db'
	);
});

test('maskConnectionInput removes password', () => {
	assert.deepEqual(
		maskConnectionInput({
			kind: SqlConnectionKind.PostgreSql,
			host: 'localhost',
			database: 'app',
			username: 'user',
			password: 'secret'
		}),
		{
			kind: SqlConnectionKind.PostgreSql,
			host: 'localhost',
			database: 'app',
			username: 'user'
		}
	);
});

test('createConnectionProfileFromInput rejects invalid port', () => {
	assert.throws(
		() =>
			createConnectionProfileFromInput({
				kind: SqlConnectionKind.PostgreSql,
				host: 'localhost',
				port: 999_999,
				database: 'app'
			}),
		/port/
	);
});

test('createConnectionProfileFromInput rejects empty databasePath', () => {
	assert.throws(
		() =>
			createConnectionProfileFromInput({
				kind: SqlConnectionKind.Sqlite,
				databasePath: '   '
			}),
		/databasePath/
	);
});
