import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createExecutePayload,
	canLoadSqlEditorConnections,
	getSqlEditorDescription,
	getSqlEditorName,
	normalizeExecutableSql,
	normalizeSqlEditorOptions,
	shouldResolveDefaultSqlConnection,
	SqlEditorExecutionSource
} from '../common/sqlEditorModel.js';
import { SqlEditorInput } from '../common/sqlEditorInput.js';
import {
	SQL_EDITOR_DEFAULT_QUERY,
	SQL_EDITOR_INPUT_TYPE_ID,
	SQL_EDITOR_PANE_ID,
	SQL_EDITOR_SCHEME
} from '../common/sqlEditor.js';
import { SqlEditorEventService } from '../common/sqlEditorEvents.js';
import { EditorInputCapabilities } from '../../../common/editor.js';

test('normalizeSqlEditorOptions fills id and default sql', () => {
	const normalized = normalizeSqlEditorOptions({}, SQL_EDITOR_DEFAULT_QUERY, () => 'query-1');

	assert.equal(normalized.id, 'query-1');
	assert.equal(normalized.initialSql, SQL_EDITOR_DEFAULT_QUERY);
	assert.equal(normalized.connectionId, undefined);
});

test('normalizeSqlEditorOptions trims connection metadata', () => {
	const normalized = normalizeSqlEditorOptions(
		{
			id: ' query-1 ',
			connectionId: ' local ',
			connectionName: ' Local SQLite ',
			initialSql: ' SELECT 1 '
		},
		SQL_EDITOR_DEFAULT_QUERY,
		() => 'fallback'
	);

	assert.deepEqual(normalized, {
		id: 'query-1',
		connectionId: 'local',
		connectionName: 'Local SQLite',
		initialSql: ' SELECT 1 '
	});
});

test('getSqlEditorName uses connection name when present', () => {
	assert.equal(getSqlEditorName(), 'SQL Query');
	assert.equal(getSqlEditorName('Local SQLite'), 'SQL Query \xb7 Local SQLite');
});

test('getSqlEditorDescription describes connection state', () => {
	assert.equal(getSqlEditorDescription(), 'No connection selected');
	assert.equal(getSqlEditorDescription('local'), 'Connection: local');
});

test('normalizeExecutableSql trims SQL', () => {
	assert.equal(normalizeExecutableSql('  SELECT 1  '), 'SELECT 1');
});

test('shouldResolveDefaultSqlConnection skips browser previews and explicit connections', () => {
	assert.equal(canLoadSqlEditorConnections(false), false);
	assert.equal(canLoadSqlEditorConnections(true), true);
	assert.equal(shouldResolveDefaultSqlConnection(false, undefined), false);
	assert.equal(shouldResolveDefaultSqlConnection(true, 'local'), false);
	assert.equal(shouldResolveDefaultSqlConnection(true, undefined), true);
});

test('createExecutePayload rejects missing connection', () => {
	assert.throws(() => createExecutePayload(undefined, 'SELECT 1', 'all'), /No SQL connection selected/);
});

test('createExecutePayload rejects empty SQL', () => {
	assert.throws(() => createExecutePayload('local', '   ', 'all'), /SQL is empty/);
});

test('createExecutePayload returns normalized payload', () => {
	assert.deepEqual(createExecutePayload(' local ', ' SELECT 1 ', 'selection'), {
		connectionId: 'local',
		sql: 'SELECT 1',
		source: 'selection'
	});
});

test('SqlEditorInput exposes Workbench editor metadata', () => {
	const input = new SqlEditorInput({
		id: 'query-1',
		connectionId: 'local',
		connectionName: 'Local SQLite',
		initialSql: 'SELECT 1'
	});

	assert.equal(input.typeId, SQL_EDITOR_INPUT_TYPE_ID);
	assert.equal(input.editorId, SQL_EDITOR_PANE_ID);
	assert.equal(input.resource.scheme, SQL_EDITOR_SCHEME);
	assert.equal(input.getName(), 'SQL Query \xb7 Local SQLite');
	assert.equal(input.getDescription(), 'Connection: local');
	assert.equal(input.getTitle(), 'SQL Query \xb7 Local SQLite \u2014 Connection: local');
	assert.equal(input.initialSql, 'SELECT 1');
	assert.equal(input.hasCapability(EditorInputCapabilities.Scratchpad), true);
});

test('SqlEditorInput matches same query id', () => {
	const first = new SqlEditorInput({ id: 'query-1' });
	const second = new SqlEditorInput({ id: 'query-1' });
	const third = new SqlEditorInput({ id: 'query-2' });

	assert.equal(first.matches(second), true);
	assert.equal(first.matches(third), false);
});

test('SqlEditorInput copy creates a new independent query input', () => {
	const input = new SqlEditorInput({
		id: 'query-1',
		connectionId: 'local',
		connectionName: 'Local SQLite',
		initialSql: 'SELECT 1'
	});

	const copy = input.copy() as SqlEditorInput;

	assert.notEqual(copy.id, input.id);
	assert.equal(copy.connectionId, input.connectionId);
	assert.equal(copy.connectionName, input.connectionName);
	assert.equal(copy.initialSql, input.initialSql);
});

test('SqlEditorEventService emits query lifecycle events', () => {
	const service = new SqlEditorEventService();

	const events: string[] = [];

	service.onDidStartQuery(event => {
		events.push(`start:${event.editorId}:${event.connectionId}`);
	});

	service.onDidCompleteQuery(event => {
		events.push(`complete:${event.result.rowCount}`);
	});

	service.onDidFailQuery(event => {
		events.push(`fail:${event.error.message}`);
	});

	service.fireQueryStarted({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT 1',
		source: SqlEditorExecutionSource.All,
		startedAt: 1
	});

	service.fireQueryCompleted({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT 1',
		source: SqlEditorExecutionSource.All,
		startedAt: 1,
		completedAt: 2,
		result: {
			columns: [{ name: 'value', ordinal: 0 }],
			rows: [],
			rowCount: 1,
			elapsedMs: 1,
			truncated: false
		}
	});

	service.fireQueryFailed({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT FROM',
		source: SqlEditorExecutionSource.All,
		startedAt: 1,
		completedAt: 2,
		error: new Error('syntax error')
	});

	assert.deepEqual(events, ['start:query-1:local', 'complete:1', 'fail:syntax error']);
});

test('createExecutePayload trims connection id and SQL for all execution', () => {
	assert.deepEqual(createExecutePayload(' local ', ' SELECT 1; ', 'all'), {
		connectionId: 'local',
		sql: 'SELECT 1;',
		source: 'all'
	});
});

test('createExecutePayload trims connection id and SQL for selection execution', () => {
	assert.deepEqual(createExecutePayload(' local ', '\nSELECT 2;\n', 'selection'), {
		connectionId: 'local',
		sql: 'SELECT 2;',
		source: 'selection'
	});
});
