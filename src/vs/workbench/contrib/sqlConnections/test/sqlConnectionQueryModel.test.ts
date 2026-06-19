import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createConnectionQueryDraft,
	createSqlEditorDraftFromTreeNode,
	createTablePreviewDraft,
	formatSqliteQualifiedName,
	quoteSqliteIdentifier,
	SQL_CONNECTION_TABLE_PREVIEW_LIMIT
} from '../common/sqlConnectionQueryModel.js';
import { SqlConnectionTreeNodeType } from '../common/sqlConnectionTreeModel.js';
import { SqlDialect } from '../../../services/sql/common/sqlDialect.js';
import { SqlTableType } from '../../../services/sql/common/sqlTypes.js';

test('quoteSqliteIdentifier quotes simple identifier', () => {
	assert.equal(quoteSqliteIdentifier('users'), '"users"');
});

test('quoteSqliteIdentifier escapes double quotes', () => {
	assert.equal(quoteSqliteIdentifier('weird"name'), '"weird""name"');
});

test('quoteSqliteIdentifier rejects empty identifier', () => {
	assert.throws(() => quoteSqliteIdentifier('  '), /identifier must not be empty/);
});

test('quoteSqliteIdentifier rejects NUL bytes', () => {
	assert.throws(() => quoteSqliteIdentifier('bad\0name'), /NUL/);
});

test('formatSqliteQualifiedName omits main schema', () => {
	assert.equal(formatSqliteQualifiedName('main', 'users'), '"users"');
});

test('formatSqliteQualifiedName includes non-main schema', () => {
	assert.equal(formatSqliteQualifiedName('analytics', 'events'), '"analytics"."events"');
});

test('createConnectionQueryDraft creates default query bound to connection', () => {
	const draft = createConnectionQueryDraft(' local ', ' Local SQLite ');

	assert.equal(draft.connectionId, 'local');
	assert.equal(draft.connectionName, 'Local SQLite');
	assert.match(draft.initialSql, /Connection: Local SQLite/);
	assert.match(draft.initialSql, /SELECT 1 AS value;/);
});

test('createTablePreviewDraft creates select top SQL for table node', () => {
	const draft = createTablePreviewDraft(
		{
			type: SqlConnectionTreeNodeType.Table,
			connectionId: 'local',
			schema: 'main',
			tableName: 'users',
			label: 'users'
		},
		{
			connectionName: 'Local SQLite'
		}
	);

	assert.equal(draft.connectionId, 'local');
	assert.equal(draft.connectionName, 'Local SQLite');
	assert.equal(
		draft.initialSql,
		`SELECT *
FROM "users"
LIMIT ${SQL_CONNECTION_TABLE_PREVIEW_LIMIT};
`
	);
});

test('createTablePreviewDraft creates select top SQL for attached schema', () => {
	const draft = createTablePreviewDraft(
		{
			type: SqlConnectionTreeNodeType.Table,
			connectionId: 'local',
			schema: 'analytics',
			tableName: 'events',
			label: 'events'
		},
		{
			limit: 50
		}
	);

	assert.equal(
		draft.initialSql,
		`SELECT *
FROM "analytics"."events"
LIMIT 50;
`
	);
});

test('createTablePreviewDraft clamps large limit', () => {
	const draft = createTablePreviewDraft(
		{
			type: SqlConnectionTreeNodeType.Table,
			connectionId: 'local',
			schema: 'main',
			tableName: 'users',
			label: 'users'
		},
		{
			limit: 20_000
		}
	);

	assert.match(draft.initialSql, /LIMIT 10000;/);
});

test('createTablePreviewDraft rejects invalid limit', () => {
	assert.throws(
		() =>
			createTablePreviewDraft(
				{
					type: SqlConnectionTreeNodeType.Table,
					connectionId: 'local',
					schema: 'main',
					tableName: 'users',
					label: 'users'
				},
				{
					limit: 0
				}
			),
		/limit must be a positive integer/
	);
});

test('createSqlEditorDraftFromTreeNode supports connection node', () => {
	const draft = createSqlEditorDraftFromTreeNode(
		{
			id: 'sql/connection/local',
			type: SqlConnectionTreeNodeType.Connection,
			label: 'Local SQLite',
			connectionId: 'local'
		},
		{
			connectionName: 'Local SQLite'
		}
	);

	assert.equal(draft.connectionId, 'local');
	assert.equal(draft.connectionName, 'Local SQLite');
	assert.match(draft.initialSql, /SELECT 1 AS value;/);
});

test('createSqlEditorDraftFromTreeNode supports table node', () => {
	const draft = createSqlEditorDraftFromTreeNode({
		id: 'sql/connection/local/table/main/users',
		type: SqlConnectionTreeNodeType.Table,
		label: 'users',
		connectionId: 'local',
		schema: 'main',
		tableName: 'users'
	});

	assert.equal(draft.connectionId, 'local');
	assert.match(draft.initialSql, /FROM "users"/);
});

test('createSqlEditorDraftFromTreeNode supports view node', () => {
	const draft = createSqlEditorDraftFromTreeNode({
		id: 'sql/connection/local/view/main/active_users',
		type: SqlConnectionTreeNodeType.View,
		label: 'active_users',
		connectionId: 'local',
		schema: 'main',
		tableName: 'active_users'
	});

	assert.equal(draft.connectionId, 'local');
	assert.match(draft.initialSql, /FROM "active_users"/);
});

test('createSqlEditorDraftFromTreeNode rejects column node', () => {
	assert.throws(
		() =>
			createSqlEditorDraftFromTreeNode({
				id: 'column',
				type: SqlConnectionTreeNodeType.Column,
				label: 'id',
				connectionId: 'local',
				tableName: 'users',
				columnName: 'id'
			}),
		/Cannot open SQL query from node type/
	);
});

test('createSqlEditorDraftFromTreeNode rejects node without connection id', () => {
	assert.throws(
		() =>
			createSqlEditorDraftFromTreeNode({
				id: 'empty',
				type: SqlConnectionTreeNodeType.Empty,
				label: 'Empty'
			}),
		/no connection id/
	);
});

test('SqlTableType is reachable from sqlTypes module', () => {
	assert.equal(SqlTableType.Table, 'table');
});

test('createTablePreviewDraft can generate sqlite SQL through dialect option', () => {
	const draft = createTablePreviewDraft(
		{
			type: SqlConnectionTreeNodeType.Table,
			connectionId: 'local',
			schema: 'main',
			tableName: 'users',
			label: 'users'
		},
		{
			dialect: SqlDialect.Sqlite,
			limit: 25
		}
	);

	assert.equal(
		draft.initialSql,
		`SELECT *
FROM "users"
LIMIT 25;
`
	);
});

test('createTablePreviewDraft supports attached sqlite schema', () => {
	const draft = createTablePreviewDraft(
		{
			type: SqlConnectionTreeNodeType.Table,
			connectionId: 'local',
			schema: 'analytics',
			tableName: 'events',
			label: 'events'
		},
		{
			limit: 50
		}
	);

	assert.equal(
		draft.initialSql,
		`SELECT *
FROM "analytics"."events"
LIMIT 50;
`
	);
});
