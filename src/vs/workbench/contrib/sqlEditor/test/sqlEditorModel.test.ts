import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createExecutePayload,
	createFormatterPlaceholderResult,
	findSqlStatementAtOffset,
	getSqlEditorStatusLabel,
	normalizeExecutableSql,
	normalizeSqlEditorOptions,
	SqlEditorExecutionSource
} from '../common/sqlEditorModel.js';

test('normalizeSqlEditorOptions creates defaults', () => {
	const normalized = normalizeSqlEditorOptions(
		{},
		'SELECT 1;',
		() => 'query-1'
	);

	assert.deepEqual(normalized, {
		id: 'query-1',
		connectionId: undefined,
		connectionName: undefined,
		initialSql: 'SELECT 1;'
	});
});

test('normalizeSqlEditorOptions trims optional fields', () => {
	const normalized = normalizeSqlEditorOptions(
		{
			id: ' query-1 ',
			connectionId: ' local ',
			connectionName: ' Local SQLite ',
			initialSql: 'SELECT 2;'
		},
		'SELECT 1;',
		() => 'query-fallback'
	);

	assert.equal(normalized.id, 'query-1');
	assert.equal(normalized.connectionId, 'local');
	assert.equal(normalized.connectionName, 'Local SQLite');
	assert.equal(normalized.initialSql, 'SELECT 2;');
});

test('normalizeExecutableSql trims SQL', () => {
	assert.equal(normalizeExecutableSql(' SELECT 1; '), 'SELECT 1;');
});

test('createExecutePayload creates executable payload', () => {
	assert.deepEqual(
		createExecutePayload(' local ', ' SELECT 1; ', SqlEditorExecutionSource.Statement),
		{
			connectionId: 'local',
			sql: 'SELECT 1;',
			source: SqlEditorExecutionSource.Statement
		}
	);
});

test('createExecutePayload rejects missing connection', () => {
	assert.throws(
		() => createExecutePayload(undefined, 'SELECT 1;', SqlEditorExecutionSource.All),
		/No SQL connection selected/
	);
});

test('createExecutePayload rejects empty SQL', () => {
	assert.throws(
		() => createExecutePayload('local', '   ', SqlEditorExecutionSource.All),
		/SQL is empty/
	);
});

test('findSqlStatementAtOffset returns first statement', () => {
	const sql = 'SELECT 1;\nSELECT 2;';
	const statement = findSqlStatementAtOffset(sql, 3);

	assert.deepEqual(statement, {
		start: 0,
		end: 8,
		sql: 'SELECT 1'
	});
});

test('findSqlStatementAtOffset returns second statement', () => {
	const sql = 'SELECT 1;\nSELECT 2;';
	const statement = findSqlStatementAtOffset(sql, sql.indexOf('2'));

	assert.deepEqual(statement, {
		start: 10,
		end: 18,
		sql: 'SELECT 2'
	});
});

test('findSqlStatementAtOffset ignores semicolon inside single quote', () => {
	const sql = "SELECT ';' AS value;\nSELECT 2;";
	const statement = findSqlStatementAtOffset(sql, 5);

	assert.equal(statement.sql, "SELECT ';' AS value");
});

test('findSqlStatementAtOffset ignores semicolon inside double quote', () => {
	const sql = 'SELECT ";" AS value;\nSELECT 2;';
	const statement = findSqlStatementAtOffset(sql, 5);

	assert.equal(statement.sql, 'SELECT ";" AS value');
});

test('findSqlStatementAtOffset ignores semicolon inside line comment', () => {
	const sql = 'SELECT 1 -- ; comment\n;\nSELECT 2;';
	const statement = findSqlStatementAtOffset(sql, 5);

	assert.equal(statement.sql, 'SELECT 1 -- ; comment');
});

test('findSqlStatementAtOffset ignores semicolon inside block comment', () => {
	const sql = 'SELECT 1 /* ; comment */;\nSELECT 2;';
	const statement = findSqlStatementAtOffset(sql, 5);

	assert.equal(statement.sql, 'SELECT 1 /* ; comment */');
});

test('getSqlEditorStatusLabel renders connection status', () => {
	assert.equal(
		getSqlEditorStatusLabel({
			connectionId: 'local',
			connectionName: 'Local SQLite',
			dirty: false,
			running: false
		}),
		'Ready · Local SQLite'
	);

	assert.equal(
		getSqlEditorStatusLabel({
			connectionId: 'local',
			dirty: true,
			running: false
		}),
		'Draft saved · local'
	);

	assert.equal(
		getSqlEditorStatusLabel({
			connectionId: 'local',
			running: true
		}),
		'Running · local'
	);
});

test('createFormatterPlaceholderResult is a no-op placeholder', () => {
	assert.equal(createFormatterPlaceholderResult('SELECT 1;'), 'SELECT 1;');
});
