import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlCellKind } from '../../../services/sql/common/sqlTypes.js';
import {
	addHistoryEntry,
	createCompletedQueryHistoryEntry,
	createFailedQueryHistoryEntry,
	createSqlPreview,
	deserializeHistory,
	getHistoryEntryDetail,
	getHistoryEntryLabel,
	normalizeHistoryEntries,
	removeHistoryEntry,
	serializeHistory,
	SqlQueryHistoryEntry,
	SqlQueryHistoryStatus
} from '../common/sqlQueryHistoryModel.js';

const completedEvent = {
	editorId: 'editor-1',
	connectionId: 'local',
	sql: 'SELECT 1 AS value;',
	startedAt: 1000,
	completedAt: 1042,
	result: {
		columns: [{ name: 'value', ordinal: 0 }],
		rows: [[{ kind: SqlCellKind.Integer, value: 1 }]],
		rowCount: 1,
		elapsedMs: 12,
		truncated: false
	}
};

const failedEvent = {
	editorId: 'editor-1',
	connectionId: 'local',
	sql: 'SELECT * FROM missing_table;',
	startedAt: 2000,
	completedAt: 2030,
	error: new Error('no such table: missing_table')
};

test('createCompletedQueryHistoryEntry creates success entry', () => {
	const entry = createCompletedQueryHistoryEntry(completedEvent);

	assert.equal(entry.connectionId, 'local');
	assert.equal(entry.sql, 'SELECT 1 AS value;');
	assert.equal(entry.status, SqlQueryHistoryStatus.Success);
	assert.equal(entry.rowCount, 1);
	assert.equal(entry.elapsedMs, 12);
	assert.equal(entry.durationMs, 42);
	assert.ok(entry.id);
});

test('createFailedQueryHistoryEntry creates error entry', () => {
	const entry = createFailedQueryHistoryEntry(failedEvent);

	assert.equal(entry.connectionId, 'local');
	assert.equal(entry.status, SqlQueryHistoryStatus.Error);
	assert.equal(entry.errorMessage, 'no such table: missing_table');
	assert.equal(entry.durationMs, 30);
});

test('createSqlPreview normalizes whitespace and truncates long SQL', () => {
	assert.equal(createSqlPreview(' SELECT   1 \n AS value; '), 'SELECT 1 AS value;');

	const preview = createSqlPreview('SELECT ' + 'x'.repeat(200), 20);
	assert.equal(preview.length, 20);
	assert.ok(preview.endsWith('…'));
});

test('addHistoryEntry prepends and caps entries', () => {
	const first = createCompletedQueryHistoryEntry(completedEvent);
	const second = createFailedQueryHistoryEntry(failedEvent);

	const entries = addHistoryEntry([first], second, 1);

	assert.deepEqual(entries.map(entry => entry.id), [second.id]);
});

test('normalizeHistoryEntries removes duplicate and invalid entries', () => {
	const first = createCompletedQueryHistoryEntry(completedEvent);

	const invalid = {
		...first,
		id: '',
		sql: ''
	} as SqlQueryHistoryEntry;

	const entries = normalizeHistoryEntries([first, first, invalid]);

	assert.deepEqual(entries.map(entry => entry.id), [first.id]);
});

test('removeHistoryEntry removes matching entry', () => {
	const first = createCompletedQueryHistoryEntry(completedEvent);
	const second = createFailedQueryHistoryEntry(failedEvent);

	const entries = removeHistoryEntry([first, second], first.id);

	assert.deepEqual(entries.map(entry => entry.id), [second.id]);
});

test('serializeHistory and deserializeHistory round trip', () => {
	const first = createCompletedQueryHistoryEntry(completedEvent);
	const document = serializeHistory([first]);

	assert.equal(document.version, 1);

	const entries = deserializeHistory(document);

	assert.equal(entries.length, 1);
	assert.equal(entries[0].id, first.id);
	assert.equal(entries[0].sqlPreview, first.sqlPreview);
});

test('deserializeHistory rejects unknown document', () => {
	assert.deepEqual(deserializeHistory(undefined), []);
	assert.deepEqual(deserializeHistory({ version: 999, entries: [] }), []);
	assert.deepEqual(deserializeHistory({ version: 1, entries: 'bad' }), []);
});

test('getHistoryEntryLabel and detail return readable strings', () => {
	const success = createCompletedQueryHistoryEntry(completedEvent);
	const failure = createFailedQueryHistoryEntry(failedEvent);

	assert.ok(getHistoryEntryLabel(success).includes('OK'));
	assert.ok(getHistoryEntryLabel(failure).includes('ERR'));

	assert.equal(getHistoryEntryDetail(success), '1 row · 12ms');
	assert.equal(getHistoryEntryDetail(failure), '30ms · no such table: missing_table');
});
