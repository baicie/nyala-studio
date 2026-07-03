import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createTableSqlActions,
	formatQualifiedTableName,
	getObjectTypeLabel,
	SQL_CONNECTION_TREE_PREVIEW_DEFAULT_LIMIT,
	SQL_CONNECTION_TREE_PREVIEW_MAX_LIMIT,
	SqlConnectionTreeActionKind
} from '../common/sqlConnectionSqlActions.js';
import { SqlConnectionKind, SqlTableType } from '../../../services/sql/common/sqlTypes.js';

test('formatQualifiedTableName quotes sqlite identifiers without main schema', () => {
	assert.equal(
		formatQualifiedTableName(SqlConnectionKind.Sqlite, {
			name: 'user profile',
			schema: 'main',
			tableType: SqlTableType.Table
		}),
		'"user profile"'
	);
});

test('formatQualifiedTableName quotes sqlite attached schema and name', () => {
	assert.equal(
		formatQualifiedTableName(SqlConnectionKind.Sqlite, {
			name: 'orders',
			schema: 'attached',
			tableType: SqlTableType.Table
		}),
		'"attached"."orders"'
	);
});

test('formatQualifiedTableName escapes double quotes inside sqlite identifier', () => {
	assert.equal(
		formatQualifiedTableName(SqlConnectionKind.Sqlite, {
			name: 'weird"name',
			schema: 'main',
			tableType: SqlTableType.View
		}),
		'"weird""name"'
	);
});

test('formatQualifiedTableName quotes mysql schema and table identifiers with backticks', () => {
	assert.equal(
		formatQualifiedTableName(SqlConnectionKind.MySql, {
			schema: 'app-db',
			name: 'users',
			tableType: SqlTableType.Table
		}),
		'`app-db`.`users`'
	);
});

test('formatQualifiedTableName quotes mysql identifier without schema', () => {
	assert.equal(
		formatQualifiedTableName(SqlConnectionKind.MySql, {
			name: 'users',
			tableType: SqlTableType.Table
		}),
		'`users`'
	);
});

test('formatQualifiedTableName escapes backticks inside mysql identifier', () => {
	assert.equal(
		formatQualifiedTableName(SqlConnectionKind.MySql, {
			name: 'we`ird',
			schema: 'app',
			tableType: SqlTableType.Table
		}),
		'`app`.`we``ird`'
	);
});

test('formatQualifiedTableName keeps postgresql placeholder quoting', () => {
	assert.equal(
		formatQualifiedTableName(SqlConnectionKind.PostgreSql, {
			name: 'orders',
			schema: 'public',
			tableType: SqlTableType.Table
		}),
		'"orders"'
	);
});

test('formatQualifiedTableName rejects empty identifier', () => {
	assert.throws(
		() =>
			formatQualifiedTableName(SqlConnectionKind.Sqlite, {
				name: '   ',
				schema: 'main',
				tableType: SqlTableType.Table
			}),
		/name/
	);
});

test('getObjectTypeLabel returns view or table label', () => {
	assert.equal(
		getObjectTypeLabel({ tableType: SqlTableType.View }),
		'view'
	);
	assert.equal(
		getObjectTypeLabel({ tableType: SqlTableType.Table }),
		'table'
	);
});

test('createTableSqlActions returns five ordered actions', () => {
	const actions = createTableSqlActions({
		connectionKind: SqlConnectionKind.MySql,
		table: { schema: 'app', name: 'users', tableType: SqlTableType.Table },
		limit: 50
	});

	assert.equal(actions.length, 5);
	assert.deepEqual(
		actions.map(action => action.kind),
		[
			SqlConnectionTreeActionKind.CopyName,
			SqlConnectionTreeActionKind.CopySelect,
			SqlConnectionTreeActionKind.PreviewRows,
			SqlConnectionTreeActionKind.CountRows,
			SqlConnectionTreeActionKind.OpenQuery
		]
	);
});

test('createTableSqlActions produces mysql preview count and copy sql', () => {
	const actions = createTableSqlActions({
		connectionKind: SqlConnectionKind.MySql,
		table: { schema: 'app', name: 'users', tableType: SqlTableType.Table },
		limit: 50
	});

	assert.equal(
		actions.find(action => action.kind === SqlConnectionTreeActionKind.CopyName)?.clipboardText,
		'`app`.`users`'
	);
	assert.equal(
		actions.find(action => action.kind === SqlConnectionTreeActionKind.CopySelect)?.clipboardText,
		'SELECT *\nFROM `app`.`users`\nLIMIT 50;'
	);
	assert.equal(
		actions.find(action => action.kind === SqlConnectionTreeActionKind.PreviewRows)?.sql,
		'SELECT *\nFROM `app`.`users`\nLIMIT 50;'
	);
	assert.equal(
		actions.find(action => action.kind === SqlConnectionTreeActionKind.CountRows)?.sql,
		'SELECT COUNT(*) AS count\nFROM `app`.`users`;'
	);
	assert.equal(
		actions.find(action => action.kind === SqlConnectionTreeActionKind.OpenQuery)?.sql,
		'SELECT *\nFROM `app`.`users`\nLIMIT 50;'
	);
});

test('createTableSqlActions produces sqlite preview sql without main schema', () => {
	const actions = createTableSqlActions({
		connectionKind: SqlConnectionKind.Sqlite,
		table: { name: 'orders', schema: 'main', tableType: SqlTableType.Table }
	});

	assert.equal(
		actions.find(action => action.kind === SqlConnectionTreeActionKind.PreviewRows)?.sql,
		`SELECT *\nFROM "orders"\nLIMIT ${SQL_CONNECTION_TREE_PREVIEW_DEFAULT_LIMIT};`
	);
});

test('createTableSqlActions clamps invalid limits and uses defaults', () => {
	const actions = createTableSqlActions({
		connectionKind: SqlConnectionKind.MySql,
		table: { name: 'events', tableType: SqlTableType.Table },
		limit: Number.MAX_SAFE_INTEGER
	});

	const preview = actions.find(action => action.kind === SqlConnectionTreeActionKind.PreviewRows);
	assert.equal(preview?.sql, `SELECT *\nFROM \`events\`\nLIMIT ${SQL_CONNECTION_TREE_PREVIEW_MAX_LIMIT};`);
});

test('createTableSqlActions falls back to default limit when limit is not positive', () => {
	const actions = createTableSqlActions({
		connectionKind: SqlConnectionKind.MySql,
		table: { name: 'events', tableType: SqlTableType.Table },
		limit: 0
	});

	const preview = actions.find(action => action.kind === SqlConnectionTreeActionKind.PreviewRows);
	assert.equal(preview?.sql, `SELECT *\nFROM \`events\`\nLIMIT ${SQL_CONNECTION_TREE_PREVIEW_DEFAULT_LIMIT};`);
});