import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildSqlConnectionTree,
	describeSqlConnection,
	describeSqlConnectionKind,
	getColumnNodeId,
	getColumnsKey,
	getConnectionColumnsKeyPrefix,
	getConnectionNodeId,
	getDatabaseNodeId,
	getSqlConnectionTreeInlineActions,
	getSqlConnectionDriverBadge,
	getTableNodeId,
	SqlConnectionTreeInlineAction,
	SqlConnectionTreeNodeType
} from '../common/sqlConnectionTreeModel.js';
import { SqlDriverAvailability } from '../../../services/sql/common/sqlDrivers.js';
import { SqlConnectionKind, SqlDatabase, SqlTableType } from '../../../services/sql/common/sqlTypes.js';

test('buildSqlConnectionTree returns empty node when there are no connections', () => {
	const nodes = buildSqlConnectionTree({
		connections: []
	});

	assert.equal(nodes.length, 1);
	assert.equal(nodes[0].type, SqlConnectionTreeNodeType.Empty);
	assert.equal(nodes[0].label, 'No database connections');
	assert.equal(nodes[0].description, 'Add a SQLite or MySQL Preview connection to start browsing schemas.');
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

test('table and view nodes omit inline actions so their labels retain row width', () => {
	for (const type of [SqlConnectionTreeNodeType.Table, SqlConnectionTreeNodeType.View]) {
		assert.deepEqual(
			getSqlConnectionTreeInlineActions({
				type,
				connectionId: 'local'
			}),
			[]
		);
	}
});

test('connection and error nodes retain their compact inline actions', () => {
	assert.deepEqual(
		getSqlConnectionTreeInlineActions({
			type: SqlConnectionTreeNodeType.Connection,
			connectionId: 'local'
		}),
		[
			SqlConnectionTreeInlineAction.OpenQuery,
			SqlConnectionTreeInlineAction.RefreshConnection,
			SqlConnectionTreeInlineAction.CloseConnection
		]
	);
	assert.deepEqual(
		getSqlConnectionTreeInlineActions({
			type: SqlConnectionTreeNodeType.Error,
			connectionId: 'local'
		}),
		[SqlConnectionTreeInlineAction.RetryMetadata]
	);
	assert.deepEqual(
		getSqlConnectionTreeInlineActions({
			type: SqlConnectionTreeNodeType.Error
		}),
		[]
	);
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
	assert.equal(getConnectionNodeId('local/db 1'), 'sql/connection/local%2Fdb%201');
});

test('getConnectionColumnsKeyPrefix matches table key prefix', () => {
	assert.equal(getConnectionColumnsKeyPrefix('local/db 1'), 'sql/connection/local%2Fdb%201/');
});

test('describeSqlConnectionKind returns driver label for each kind', () => {
	assert.equal(describeSqlConnectionKind(SqlConnectionKind.Sqlite), 'SQLite');
	assert.equal(describeSqlConnectionKind(SqlConnectionKind.MySql), 'MySQL');
	assert.equal(describeSqlConnectionKind(SqlConnectionKind.PostgreSql), 'PostgreSQL');
});

test('getSqlConnectionDriverBadge reflects product driver status', () => {
	assert.equal(getSqlConnectionDriverBadge(SqlConnectionKind.Sqlite), 'Stable');
	assert.equal(getSqlConnectionDriverBadge(SqlConnectionKind.MySql), 'Preview');
	assert.equal(getSqlConnectionDriverBadge(SqlConnectionKind.PostgreSql), 'Planned');
});

test('describeSqlConnection combines kind preview planned and readOnly flags', () => {
	assert.equal(
		describeSqlConnection({
			id: 'local',
			name: 'Local',
			kind: SqlConnectionKind.Sqlite,
			databasePath: '/tmp/app.db',
			readOnly: false
		}),
		'SQLite'
	);

	assert.equal(
		describeSqlConnection({
			id: 'local',
			name: 'Local',
			kind: SqlConnectionKind.Sqlite,
			databasePath: '/tmp/app.db',
			readOnly: true
		}),
		'SQLite · read-only'
	);

	assert.equal(
		describeSqlConnection({
			id: 'mysql',
			name: 'Local MySQL',
			kind: SqlConnectionKind.MySql,
			host: 'localhost',
			port: 3306,
			database: 'app',
			readOnly: false
		}),
		'MySQL · Preview'
	);

	assert.equal(
		describeSqlConnection({
			id: 'pg',
			name: 'Planned PG',
			kind: SqlConnectionKind.PostgreSql,
			host: 'localhost',
			port: 5432,
			database: 'app',
			readOnly: false
		}),
		'PostgreSQL · Planned'
	);
});

test('buildSqlConnectionTree renders driver-aware connection description', () => {
	const sqliteNodes = buildSqlConnectionTree({
		connections: [
			{
				id: 'local',
				name: 'Local SQLite',
				kind: SqlConnectionKind.Sqlite,
				databasePath: '/tmp/app.db',
				readOnly: true
			}
		]
	});
	assert.equal(sqliteNodes[0].description, 'SQLite · read-only');

	const mysqlNodes = buildSqlConnectionTree({
		connections: [
			{
				id: 'mysql',
				name: 'Local MySQL',
				kind: SqlConnectionKind.MySql,
				host: 'localhost',
				port: 3306,
				database: 'app',
				readOnly: false
			}
		]
	});
	assert.equal(mysqlNodes[0].description, 'MySQL · Preview');

	const postgresqlNodes = buildSqlConnectionTree({
		connections: [
			{
				id: 'pg',
				name: 'Planned PG',
				kind: SqlConnectionKind.PostgreSql,
				host: 'localhost',
				port: 5432,
				database: 'app',
				readOnly: false
			}
		]
	});
	assert.equal(postgresqlNodes[0].description, 'PostgreSQL · Planned');
});

test('SqlDriverAvailability catalog matches tree badge expectations', () => {
	assert.equal(SqlDriverAvailability.Enabled, 'enabled');
	assert.equal(SqlDriverAvailability.Planned, 'planned');
});

test('getDatabaseNodeId escapes special characters', () => {
	assert.equal(getDatabaseNodeId('local/db 1', 'app-db'), 'sql/connection/local%2Fdb%201/database/app-db');
});

test('SQLite connection with explicit databases exposes database node with tables group', () => {
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
		databasesByConnectionId: {
			local: [{ name: 'main' }]
		},
		tablesByConnectionId: {
			local: [{ schema: 'main', name: 'users', tableType: SqlTableType.Table }]
		}
	});

	const connection = nodes[0];
	assert.equal(connection.type, SqlConnectionTreeNodeType.Connection);

	const database = connection.children?.find(child => child.type === SqlConnectionTreeNodeType.Database);
	assert.ok(database, 'SQLite tree should expose a Database node when databases map is present');
	assert.equal(database?.label, 'main');
	assert.equal(database?.description, 'database');
	assert.equal(database?.databaseName, 'main');

	const tablesGroup = database?.children?.find(child => child.type === SqlConnectionTreeNodeType.Group);
	assert.ok(tablesGroup);
	assert.equal(tablesGroup?.description, '1');
});

test('MySQL connection with explicit databases groups tables under schema', () => {
	const nodes = buildSqlConnectionTree({
		connections: [
			{
				id: 'mysql',
				name: 'Local MySQL',
				kind: SqlConnectionKind.MySql,
				host: 'localhost',
				port: 3306,
				database: 'app',
				readOnly: false
			}
		],
		databasesByConnectionId: {
			mysql: [{ name: 'app' }, { name: 'archive' }]
		},
		tablesByConnectionId: {
			mysql: [
				{ schema: 'app', name: 'users', tableType: SqlTableType.Table },
				{ schema: 'archive', name: 'audit', tableType: SqlTableType.Table }
			]
		}
	});

	const connection = nodes[0];
	assert.equal(connection.description, 'MySQL · Preview');

	const databases = connection.children ?? [];
	assert.equal(databases.length, 2);

	const appDatabase = databases.find(
		child => child.type === SqlConnectionTreeNodeType.Database && child.label === 'app'
	);
	assert.ok(appDatabase);
	assert.equal(appDatabase?.description, 'schema');

	const tablesGroup = appDatabase?.children?.find(child => child.type === SqlConnectionTreeNodeType.Group);
	const userTable = tablesGroup?.children?.find(child => child.label === 'users');
	assert.equal(userTable?.databaseName, 'app');
});

test('Empty MySQL connection falls back to the connection database name', () => {
	const nodes = buildSqlConnectionTree({
		connections: [
			{
				id: 'mysql',
				name: 'Empty MySQL',
				kind: SqlConnectionKind.MySql,
				host: 'localhost',
				port: 3306,
				database: 'app',
				readOnly: false
			}
		],
		databasesByConnectionId: {
			mysql: [] as SqlDatabase[]
		}
	});

	const connection = nodes[0];
	const database = connection.children?.find(child => child.type === SqlConnectionTreeNodeType.Database);
	assert.ok(database);
	assert.equal(database?.label, 'app');
});

test('Per-table column load error is isolated to the failed table', () => {
	const usersTable = { schema: 'main', name: 'users', tableType: SqlTableType.Table };
	const ordersTable = { schema: 'main', name: 'orders', tableType: SqlTableType.Table };

	const usersKey = getColumnsKey('local', usersTable);
	const ordersKey = getColumnsKey('local', ordersTable);

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
		databasesByConnectionId: {
			local: [{ name: 'main' }]
		},
		tablesByConnectionId: {
			local: [usersTable, ordersTable]
		},
		columnsByTableId: {
			[ordersKey]: [{ name: 'id', ordinal: 0, notNull: true, primaryKey: true }]
		},
		errorsByTableId: {
			[usersKey]: 'permission denied'
		}
	});

	const connection = nodes[0];
	const database = connection.children?.find(child => child.type === SqlConnectionTreeNodeType.Database);
	const tablesGroup = database?.children?.find(child => child.type === SqlConnectionTreeNodeType.Group);

	const failedTable = tablesGroup?.children?.find(child => child.label === 'users');
	assert.equal(failedTable?.children?.length, 1);
	const failedChild = failedTable?.children?.[0];
	assert.equal(failedChild?.type, SqlConnectionTreeNodeType.Error);
	assert.equal(failedChild?.tableType, SqlTableType.Table);
	assert.equal(failedChild?.label, 'Failed to load columns');
	assert.match(failedChild?.description ?? '', /permission denied/);

	const okTable = tablesGroup?.children?.find(child => child.label === 'orders');
	assert.equal(okTable?.children?.length, 1);
	assert.equal(okTable?.children?.[0].type, SqlConnectionTreeNodeType.Column);
});

test('Connection-level metadata error blocks tables but stays scoped', () => {
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
	const error = connection.children?.find(child => child.type === SqlConnectionTreeNodeType.Error);
	assert.equal(error?.label, 'Failed to load metadata');
	assert.equal(error?.description, 'database is locked');
});

test('MySQL derives database nodes from table schemas when database list is empty', () => {
	const nodes = buildSqlConnectionTree({
		connections: [
			{
				id: 'mysql',
				name: 'Local MySQL',
				kind: SqlConnectionKind.MySql,
				host: 'localhost',
				port: 3306,
				database: 'app',
				readOnly: false
			}
		],
		databasesByConnectionId: {
			mysql: [] as SqlDatabase[]
		},
		tablesByConnectionId: {
			mysql: [{ schema: 'app', name: 'users', tableType: SqlTableType.Table }]
		}
	});

	const connection = nodes[0];
	const database = connection.children?.find(child => child.type === SqlConnectionTreeNodeType.Database);

	assert.ok(database);
	assert.equal(database?.label, 'app');

	const tablesGroup = database?.children?.find(child => child.label === 'Tables');
	assert.ok(tablesGroup);
	assert.equal(tablesGroup?.children?.[0].label, 'users');
});

test('MySQL falls back to connection database when databases and table schemas are empty', () => {
	const nodes = buildSqlConnectionTree({
		connections: [
			{
				id: 'mysql',
				name: 'Local MySQL',
				kind: SqlConnectionKind.MySql,
				host: 'localhost',
				port: 3306,
				database: 'app',
				readOnly: false
			}
		],
		databasesByConnectionId: {
			mysql: [] as SqlDatabase[]
		}
	});

	const connection = nodes[0];
	const database = connection.children?.find(child => child.type === SqlConnectionTreeNodeType.Database);

	assert.ok(database);
	assert.equal(database?.label, 'app');
});
