import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildSqlQueryHistoryView,
	createCopyHistorySummary,
	createOpenHistorySqlDraft
} from '../common/sqlQueryHistoryViewModel.js';
import { SqlQueryHistoryEntry, SqlQueryHistoryStatus } from '../common/sqlQueryHistoryModel.js';

const entries: SqlQueryHistoryEntry[] = [
	{
		id: 'ok',
		editorId: 'e1',
		connectionId: 'local',
		sql: 'SELECT * FROM users',
		sqlPreview: 'SELECT * FROM users',
		status: SqlQueryHistoryStatus.Success,
		startedAt: 1,
		completedAt: 2,
		durationMs: 1,
		rowCount: 2,
		elapsedMs: 1
	},
	{
		id: 'err',
		editorId: 'e1',
		connectionId: 'mysql',
		sql: 'SELECT * FROM missing',
		sqlPreview: 'SELECT * FROM missing',
		status: SqlQueryHistoryStatus.Error,
		startedAt: 3,
		completedAt: 4,
		durationMs: 1,
		errorMessage: 'table missing'
	}
];

test('buildSqlQueryHistoryView returns all entries when filter is empty', () => {
	assert.deepEqual(
		buildSqlQueryHistoryView(entries).map(item => item.id),
		['ok', 'err']
	);
});

test('buildSqlQueryHistoryView filters by status', () => {
	assert.deepEqual(
		buildSqlQueryHistoryView(entries, { status: SqlQueryHistoryStatus.Error }).map(item => item.id),
		['err']
	);
	assert.deepEqual(
		buildSqlQueryHistoryView(entries, { status: SqlQueryHistoryStatus.Success }).map(item => item.id),
		['ok']
	);
	assert.deepEqual(
		buildSqlQueryHistoryView(entries, { status: 'all' }).map(item => item.id),
		['ok', 'err']
	);
});

test('buildSqlQueryHistoryView filters by connectionId', () => {
	assert.deepEqual(
		buildSqlQueryHistoryView(entries, { connectionId: 'mysql' }).map(item => item.id),
		['err']
	);
	assert.deepEqual(
		buildSqlQueryHistoryView(entries, { connectionId: 'local' }).map(item => item.id),
		['ok']
	);
});

test('buildSqlQueryHistoryView searches sql and error message', () => {
	assert.deepEqual(
		buildSqlQueryHistoryView(entries, { query: 'users' }).map(item => item.id),
		['ok']
	);
	assert.deepEqual(
		buildSqlQueryHistoryView(entries, { query: 'missing' }).map(item => item.id),
		['err']
	);
});

test('buildSqlQueryHistoryView searches connection id', () => {
	assert.deepEqual(
		buildSqlQueryHistoryView(entries, { query: 'mysql' }).map(item => item.id),
		['err']
	);
});

test('buildSqlQueryHistoryView is case insensitive for query', () => {
	assert.deepEqual(
		buildSqlQueryHistoryView(entries, { query: 'USERS' }).map(item => item.id),
		['ok']
	);
});

test('buildSqlQueryHistoryView tolerates whitespace in filter fields', () => {
	assert.deepEqual(
		buildSqlQueryHistoryView(entries, { connectionId: '  local  ' }).map(item => item.id),
		['ok']
	);
	assert.deepEqual(
		buildSqlQueryHistoryView(entries, { query: '   ' }).map(item => item.id),
		['ok', 'err']
	);
});

test('buildSqlQueryHistoryView list items expose label detail and timestamp', () => {
	const [first] = buildSqlQueryHistoryView(entries);
	assert.ok(first);
	assert.equal(first.id, 'ok');
	assert.ok(first.label.includes('OK'));
	assert.ok(first.label.includes('SELECT * FROM users'));
	assert.ok(first.detail.includes('2 rows'));
	assert.equal(first.timestamp, 2);
	assert.equal(first.sql, 'SELECT * FROM users');
	assert.equal(first.connectionId, 'local');
	assert.equal(first.status, SqlQueryHistoryStatus.Success);
});

test('createOpenHistorySqlDraft returns trimmed original sql', () => {
	assert.equal(createOpenHistorySqlDraft(entries[0]), 'SELECT * FROM users');
	assert.equal(
		createOpenHistorySqlDraft({ ...entries[0], sql: '  SELECT 1  ' }),
		'SELECT 1'
	);
});

test('createCopyHistorySummary contains status connection duration sql and detail', () => {
	const text = createCopyHistorySummary(entries[0]);
	assert.ok(text.includes('Status: success'));
	assert.ok(text.includes('Connection: local'));
	assert.ok(text.includes('Duration: 1ms'));
	assert.ok(text.includes('Detail: 2 rows · 1ms'));
	assert.ok(text.includes('SQL: SELECT * FROM users'));
});

test('createCopyHistorySummary exposes status for error entries', () => {
	const text = createCopyHistorySummary(entries[1]);
	assert.ok(text.includes('Status: error'));
	assert.ok(text.includes('Connection: mysql'));
	assert.ok(text.includes('Detail: 1ms · table missing'));
});