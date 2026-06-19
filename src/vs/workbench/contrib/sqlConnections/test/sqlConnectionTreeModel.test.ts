import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildSqlConnectionTree,
	getColumnNodeId,
	getColumnsKey,
	getConnectionColumnsKeyPrefix,
	getConnectionNodeId,
	getTableNodeId,
	SqlConnectionTreeNodeType
} from '../common/sqlConnectionTreeModel.js';
import { SqlConnectionKind, SqlTableType } from '../../../services/sql/common/sqlTypes.js';

test('buildSqlConnectionTree returns empty node when there are no connections', () => {
	const nodes = buildSqlConnectionTree({
		connections: []
	});

	assert.equal(nodes.length, 1);
	assert.equal(nodes[0].type, SqlConnectionTreeNodeType.Empty);
	assert.equal(nodes[0].label, 'No database connections');
});

test('buildSqlConnectionTree sorts connections by name', () => {
	const nodes = buildSqlConnectionTree({
		connections: [
			{
				id: 'b',
				name: 'Beta',
				kind: SqlConnectionKind.Sqlite,
				databasePath: '/tmp/b.db',
				readOnly: false
			},
			{
				id: 'a',
				name: 'Alpha',
				kind: SqlConnectionKind.Sqlite,
				databasePath: '/tmp/a.db',
				readOnly: false
			}
		]
	});

	assert.equal(nodes.length, 2);
	assert.equal(nodes[0].label, 'Alpha');
	assert.equal(nodes[1].label, 'Beta');
});

test('buildSqlConnectionTree groups tables and views with columns', () => {
	const usersTable = {
		schema: 'main',
		name: 'users',
		tableType: SqlTableType.Table
	};

	const activeUsersView = {
		schema: 'main',
		name: 'active_users',
		tableType: SqlTableType.View
	};

	const usersKey = getColumnsKey('local', usersTable);

	const nodes = buildSqlConnectionTree({
		connections: [
			{
				id: 'local',
				name: 'Local SQLite',
				kind: SqlConnectionKind.Sqlite,
				databasePath: '/tmp/app.db',
				readOnly: false
			}
		],
		tablesByConnectionId: {
			local: [activeUsersView, usersTable]
		},
		columnsByTableId: {
			[usersKey]: [
				{
					name: 'name',
					ordinal: 1,
					dataType: 'TEXT',
					notNull: true,
					primaryKey: false
				},
				{
					name: 'id',
					ordinal: 0,
					dataType: 'INTEGER',
					notNull: false,
					primaryKey: true
				}
			]
		}
	});

	const connection = nodes[0];
	assert.equal(connection.type, SqlConnectionTreeNodeType.Connection);
	assert.equal(connection.children?.length, 2);

	const tablesGroup = connection.children![0];
	assert.equal(tablesGroup.label, 'Tables');
	assert.equal(tablesGroup.description, '1');

	const table = tablesGroup.children![0];
	assert.equal(table.type, SqlConnectionTreeNodeType.Table);
	assert.equal(table.label, 'users');

	assert.equal(table.children?.length, 2);
	assert.equal(table.children![0].label, 'id');
	assert.equal(table.children![0].description, 'INTEGER · PK');
	assert.equal(table.children![1].label, 'name');
	assert.equal(table.children![1].description, 'TEXT · NOT NULL');

	const viewsGroup = connection.children![1];
	assert.equal(viewsGroup.label, 'Views');
	assert.equal(viewsGroup.children![0].type, SqlConnectionTreeNodeType.View);
	assert.equal(viewsGroup.children![0].label, 'active_users');
});

test('buildSqlConnectionTree renders connection metadata error', () => {
	const nodes = buildSqlConnectionTree({
		connections: [
			{
				id: 'broken',
				name: 'Broken DB',
				kind: SqlConnectionKind.Sqlite,
				databasePath: '/tmp/broken.db',
				readOnly: false
			}
		],
		errorsByConnectionId: {
			broken: 'database is locked'
		}
	});

	const connection = nodes[0];
	const error = connection.children![0];

	assert.equal(error.type, SqlConnectionTreeNodeType.Error);
	assert.equal(error.label, 'Failed to load metadata');
	assert.equal(error.description, 'database is locked');
});

test('getTableNodeId and getColumnNodeId escape special characters', () => {
	const table = {
		schema: 'main schema',
		name: 'user/profile',
		tableType: SqlTableType.Table
	};

	const tableId = getTableNodeId('local connection', table);
	const columnId = getColumnNodeId('local connection', table, {
		name: 'display name'
	});

	assert.equal(tableId, 'sql/connection/local%20connection/table/main%20schema/user%2Fprofile');
	assert.equal(columnId, 'sql/connection/local%20connection/table/main%20schema/user%2Fprofile/column/display%20name');
});

test('connection node id matches encoded connection id convention', () => {
	const nodes = buildSqlConnectionTree({
		connections: [
			{
				id: 'local connection',
				name: 'Local SQLite',
				kind: SqlConnectionKind.Sqlite,
				databasePath: '/tmp/app.db',
				readOnly: false
			}
		]
	});

	assert.equal(nodes[0].id, 'sql/connection/local%20connection');
});

test('getConnectionNodeId escapes connection id', () => {
	assert.equal(
		getConnectionNodeId('local/db 1'),
		'sql/connection/local%2Fdb%201'
	);
});

test('getConnectionColumnsKeyPrefix matches table key prefix', () => {
	assert.equal(
		getConnectionColumnsKeyPrefix('local/db 1'),
		'sql/connection/local%2Fdb%201/'
	);
});
