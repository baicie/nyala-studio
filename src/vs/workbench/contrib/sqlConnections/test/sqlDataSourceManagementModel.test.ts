/*---------------------------------------------------------------------------------------------
 * Nyala Studio - Data Sources management model tests.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlConnectionKind, SqlSavedConnection } from '../../../services/sql/common/sqlTypes.js';
import {
	buildSqlDataSourceManagementItems,
	createSqlDataSourceRemovalRequest,
	groupSqlDataSourceManagementActions,
	getSqlDataSourceManagementActions,
	matchesSqlDataSourceManagementItem,
	SqlDataSourceManagementAction,
	SqlDataSourceManagementState
} from '../common/sqlDataSourceManagementModel.js';

const savedSqlite: SqlSavedConnection = {
	id: 'demo-sqlite',
	name: 'Demo SQLite',
	kind: SqlConnectionKind.Sqlite,
	databasePath: '/data/demo.db',
	readOnly: false,
	createIfMissing: true,
	autoConnect: true
};

const savedMysql: SqlSavedConnection = {
	id: 'mysql-prod',
	name: 'Production MySQL',
	kind: SqlConnectionKind.MySql,
	host: 'db.example.test',
	port: 3306,
	database: 'app',
	username: 'app_user',
	readOnly: true,
	createIfMissing: false,
	autoConnect: false
};

test('management items merge an open session into its saved profile', () => {
	const [item] = buildSqlDataSourceManagementItems(
		[savedMysql],
		[
			{
				id: savedMysql.id,
				name: savedMysql.name,
				kind: savedMysql.kind,
				host: savedMysql.host,
				port: savedMysql.port,
				database: savedMysql.database,
				username: savedMysql.username,
				sslMode: savedMysql.sslMode,
				readOnly: savedMysql.readOnly
			}
		]
	);

	assert.equal(item.id, savedMysql.id);
	assert.equal(item.state, SqlDataSourceManagementState.Connected);
	assert.equal(item.isSaved, true);
	assert.equal(item.target, 'db.example.test:3306/app');
	assert.deepEqual(getSqlDataSourceManagementActions(item), [
		SqlDataSourceManagementAction.Reveal,
		SqlDataSourceManagementAction.OpenQuery,
		SqlDataSourceManagementAction.Refresh,
		SqlDataSourceManagementAction.Edit,
		SqlDataSourceManagementAction.Test,
		SqlDataSourceManagementAction.Reconnect,
		SqlDataSourceManagementAction.Disconnect,
		SqlDataSourceManagementAction.Delete
	]);
	assert.deepEqual(createSqlDataSourceRemovalRequest(item), {
		connectionId: savedMysql.id,
		closeIfOpen: true
	});
});

test('management items expose metadata errors without losing reconnect actions', () => {
	const [item] = buildSqlDataSourceManagementItems(
		[savedMysql],
		[
			{
				id: savedMysql.id,
				name: savedMysql.name,
				kind: savedMysql.kind,
				host: savedMysql.host,
				port: savedMysql.port,
				database: savedMysql.database,
				username: savedMysql.username,
				sslMode: savedMysql.sslMode,
				readOnly: savedMysql.readOnly
			}
		],
		{ [savedMysql.id]: 'metadata probe failed' }
	);

	assert.equal(item.state, SqlDataSourceManagementState.Error);
	assert.equal(item.error, 'metadata probe failed');
	assert.deepEqual(getSqlDataSourceManagementActions(item), [
		SqlDataSourceManagementAction.Reveal,
		SqlDataSourceManagementAction.OpenQuery,
		SqlDataSourceManagementAction.Refresh,
		SqlDataSourceManagementAction.Edit,
		SqlDataSourceManagementAction.Test,
		SqlDataSourceManagementAction.Reconnect,
		SqlDataSourceManagementAction.Disconnect,
		SqlDataSourceManagementAction.Delete
	]);
});

test('saved-only restore errors are visible and keep reconnect actions', () => {
	const [item] = buildSqlDataSourceManagementItems([savedMysql], [], { [savedMysql.id]: 'password rejected' });

	assert.equal(item.state, SqlDataSourceManagementState.Error);
	assert.equal(item.error, 'password rejected');
	assert.deepEqual(getSqlDataSourceManagementActions(item), [
		SqlDataSourceManagementAction.Reconnect,
		SqlDataSourceManagementAction.Edit,
		SqlDataSourceManagementAction.Test,
		SqlDataSourceManagementAction.Delete
	]);
});

test('management items retain saved-only and open-only sources without duplicates', () => {
	const items = buildSqlDataSourceManagementItems(
		[savedSqlite],
		[
			{
				id: 'scratch-sqlite',
				name: 'Scratch',
				kind: SqlConnectionKind.Sqlite,
				databasePath: ':memory:',
				readOnly: false
			}
		]
	);

	assert.deepEqual(
		items.map(item => ({ id: item.id, state: item.state, isSaved: item.isSaved, target: item.target })),
		[
			{ id: savedSqlite.id, state: SqlDataSourceManagementState.Saved, isSaved: true, target: '/data/demo.db' },
			{ id: 'scratch-sqlite', state: SqlDataSourceManagementState.Connected, isSaved: false, target: ':memory:' }
		]
	);
	assert.deepEqual(getSqlDataSourceManagementActions(items[0]), [
		SqlDataSourceManagementAction.Connect,
		SqlDataSourceManagementAction.Edit,
		SqlDataSourceManagementAction.Test,
		SqlDataSourceManagementAction.Delete
	]);
	assert.deepEqual(createSqlDataSourceRemovalRequest(items[0]), {
		connectionId: savedSqlite.id,
		closeIfOpen: false
	});
});

test('management search matches name, driver, and safe target summary', () => {
	const [item] = buildSqlDataSourceManagementItems([savedMysql], []);

	assert.equal(matchesSqlDataSourceManagementItem(item, 'production mysql'), true);
	assert.equal(matchesSqlDataSourceManagementItem(item, '3306 app'), true);
	assert.equal(matchesSqlDataSourceManagementItem(item, 'password'), false);
	assert.equal(matchesSqlDataSourceManagementItem(item, 'sqlite'), false);
});

test('management model limits actions for an unsaved open source', () => {
	const item = buildSqlDataSourceManagementItems(
		[],
		[
			{
				id: 'open-only',
				name: 'Open only',
				kind: SqlConnectionKind.Sqlite,
				databasePath: ':memory:',
				readOnly: false
			}
		]
	)[0];

	assert.equal(item.isSaved, false);
	assert.deepEqual(getSqlDataSourceManagementActions(item), [
		SqlDataSourceManagementAction.Reveal,
		SqlDataSourceManagementAction.OpenQuery,
		SqlDataSourceManagementAction.Refresh,
		SqlDataSourceManagementAction.Disconnect
	]);
	assert.equal(createSqlDataSourceRemovalRequest(item), undefined);
});

test('connected saved sources expose complete grouped context menu actions', () => {
	const [item] = buildSqlDataSourceManagementItems(
		[savedMysql],
		[
			{
				id: savedMysql.id,
				name: savedMysql.name,
				kind: savedMysql.kind,
				host: savedMysql.host,
				port: savedMysql.port,
				database: savedMysql.database,
				username: savedMysql.username,
				readOnly: savedMysql.readOnly
			}
		]
	);

	assert.deepEqual(groupSqlDataSourceManagementActions(item), [
		{
			id: 'primary',
			actions: [
				SqlDataSourceManagementAction.Reveal,
				SqlDataSourceManagementAction.OpenQuery,
				SqlDataSourceManagementAction.Refresh
			]
		},
		{
			id: 'manage',
			actions: [
				SqlDataSourceManagementAction.Edit,
				SqlDataSourceManagementAction.Test,
				SqlDataSourceManagementAction.Reconnect,
				SqlDataSourceManagementAction.Disconnect
			]
		},
		{ id: 'destructive', actions: [SqlDataSourceManagementAction.Delete] }
	]);
});

test('saved sources keep connect edit test and delete in context menu groups', () => {
	const [item] = buildSqlDataSourceManagementItems([savedSqlite], []);

	assert.deepEqual(groupSqlDataSourceManagementActions(item), [
		{ id: 'primary', actions: [SqlDataSourceManagementAction.Connect] },
		{
			id: 'manage',
			actions: [SqlDataSourceManagementAction.Edit, SqlDataSourceManagementAction.Test]
		},
		{ id: 'destructive', actions: [SqlDataSourceManagementAction.Delete] }
	]);
});
