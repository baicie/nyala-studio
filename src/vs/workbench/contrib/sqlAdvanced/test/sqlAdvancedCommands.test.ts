import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createExplainCommandResult,
	createExplainSql,
	createExplainSummaryCommandResult,
	createFormatCommandResult,
	createSnippetCommandResult,
	SqlAdvancedCommandKind
} from '../common/sqlAdvancedCommands.js';
import { SqlDialect } from '../../../services/sql/common/sqlDialect.js';

test('createExplainSql creates SQLite explain query plan', () => {
	assert.equal(
		createExplainSql(SqlDialect.Sqlite, 'select * from users;'),
		'EXPLAIN QUERY PLAN select * from users;'
	);
});

test('createExplainSql creates MySQL explain', () => {
	assert.equal(
		createExplainSql(SqlDialect.MySql, 'select * from users;'),
		'EXPLAIN select * from users;'
	);
});

test('createExplainSql creates PostgreSQL explain', () => {
	assert.equal(
		createExplainSql(SqlDialect.PostgreSql, 'select * from users;'),
		'EXPLAIN (FORMAT JSON) select * from users;'
	);
});

test('createExplainSql forwards SQLITE through the explain foundation', () => {
	assert.equal(
		createExplainSql(SqlDialect.Sqlite, '  SELECT * FROM users;  '),
		'EXPLAIN QUERY PLAN SELECT * FROM users;'
	);
});

test('createExplainSql strips trailing semicolons', () => {
	assert.equal(
		createExplainSql(SqlDialect.Sqlite, 'select 1;;;'),
		'EXPLAIN QUERY PLAN select 1;'
	);
});

test('createExplainSql rejects empty sql', () => {
	assert.throws(() => createExplainSql(SqlDialect.Sqlite, '   '), /SQL is empty/);
});

test('createExplainCommandResult returns sql command result', () => {
	const result = createExplainCommandResult(SqlDialect.Sqlite, 'select 1');
	assert.equal(result.kind, SqlAdvancedCommandKind.Explain);
	assert.equal(result.title, 'Explain Query');
	assert.equal(result.sql, 'EXPLAIN QUERY PLAN select 1;');
	assert.equal(result.content, undefined);
});

test('createExplainCommandResult for MySQL preserves the sql', () => {
	const result = createExplainCommandResult(SqlDialect.MySql, 'select 1');
	assert.equal(result.sql, 'EXPLAIN select 1;');
});

test('createExplainSummaryCommandResult reports no rows for empty plan', () => {
	assert.equal(
		createExplainSummaryCommandResult('   \n  \n').content,
		'No explain plan rows were returned.'
	);
});

test('createExplainSummaryCommandResult detects scan warning', () => {
	const result = createExplainSummaryCommandResult('SCAN users\nUSING INDEX users_idx');
	assert.ok(result.content?.includes('scan operation'));
	assert.ok(result.content?.includes('Explain plan rows: 2'));
});

test('createExplainSummaryCommandResult detects temporary and filesort warnings', () => {
	const result = createExplainSummaryCommandResult('Using temporary; Using filesort');
	assert.ok(result.content?.includes('temporary/filesort'));
});

test('createExplainSummaryCommandResult caps raw plan preview', () => {
	const lines = Array.from({ length: 200 }, (_, index) => `row-${index}`);
	const result = createExplainSummaryCommandResult(lines.join('\n'));
	const summary = result.content ?? '';
	const rawSection = summary.split('Raw plan:\n')[1] ?? '';
	const rawLines = rawSection.split('\n');
	assert.equal(rawLines.length, 50);
	assert.equal(rawLines[0], 'row-0');
	assert.equal(rawLines[49], 'row-49');
});

test('format and snippet command results are draft-only', () => {
	assert.equal(
		createFormatCommandResult('select 1', 'SELECT 1;').kind,
		SqlAdvancedCommandKind.Format
	);
	assert.equal(createFormatCommandResult('select 1', 'SELECT 1;').sql, 'SELECT 1;');
	assert.equal(
		createFormatCommandResult('select 1', '').sql,
		'select 1'
	);

	assert.equal(
		createSnippetCommandResult('Preview', 'SELECT * FROM users LIMIT 100;').kind,
		SqlAdvancedCommandKind.InsertSnippet
	);
	assert.equal(
		createSnippetCommandResult('Preview', 'SELECT * FROM users LIMIT 100;').title,
		'Preview'
	);
});