import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createExecutePayload,
	createFormatterPlaceholderResult,
	findSqlStatementAtOffset,
	getSqlEditorToolbarState,
	getSqlEditorStatusLabel,
	normalizeExecutableSql,
	normalizeSqlEditorOptions,
	splitSqlStatements,
	SqlEditorConnectionRefreshCoordinator,
	SqlEditorExecutionSource
} from '../common/sqlEditorModel.js';

interface TestConnection {
	readonly id: string;
}

test('normalizeSqlEditorOptions creates defaults', () => {
	const normalized = normalizeSqlEditorOptions({}, 'SELECT 1;', () => 'query-1');

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

test('connection refresh uses a new editor input instead of the previous selection', async () => {
	const coordinator = new SqlEditorConnectionRefreshCoordinator<TestConnection>();

	const result = await coordinator.load(async () => [{ id: 'connection-a' }, { id: 'connection-b' }], {
		inputConnectionId: 'connection-b',
		preserveCurrentSelection: false,
		getCurrentSelection: () => 'connection-a'
	});

	assert.equal(result?.succeeded && result.selectedConnectionId, 'connection-b');
});

test('connection refresh preserves a current selection for the same editor input', async () => {
	const coordinator = new SqlEditorConnectionRefreshCoordinator<TestConnection>();

	const result = await coordinator.load(async () => [{ id: 'connection-a' }, { id: 'connection-b' }], {
		inputConnectionId: 'connection-a',
		preserveCurrentSelection: true,
		getCurrentSelection: () => 'connection-b'
	});

	assert.equal(result?.succeeded && result.selectedConnectionId, 'connection-b');
});

test('connection refresh ignores a stale success after a newer request', async () => {
	const coordinator = new SqlEditorConnectionRefreshCoordinator<TestConnection>();
	let resolveFirst!: (connections: TestConnection[]) => void;
	const first = coordinator.load(
		() =>
			new Promise(resolve => {
				resolveFirst = resolve;
			}),
		{
			inputConnectionId: 'connection-a',
			getCurrentSelection: () => undefined
		}
	);
	const second = await coordinator.load(async () => [{ id: 'connection-b' }], {
		inputConnectionId: 'connection-b',
		getCurrentSelection: () => undefined
	});

	resolveFirst([{ id: 'connection-a' }]);

	assert.equal(second?.succeeded && second.selectedConnectionId, 'connection-b');
	assert.equal(await first, undefined);
});

test('connection refresh ignores a stale failure after invalidation', async () => {
	const coordinator = new SqlEditorConnectionRefreshCoordinator<TestConnection>();
	let rejectLoad!: (error: Error) => void;
	const pending = coordinator.load(
		() =>
			new Promise((_resolve, reject) => {
				rejectLoad = reject;
			}),
		{
			inputConnectionId: 'connection-a',
			getCurrentSelection: () => undefined
		}
	);

	coordinator.invalidate();
	const error = new Error('stale connection failure');
	rejectLoad(error);

	assert.equal(await pending, undefined);
});

test('createExecutePayload creates executable payload', () => {
	assert.deepEqual(createExecutePayload(' local ', ' SELECT 1; ', SqlEditorExecutionSource.Statement), {
		connectionId: 'local',
		sql: 'SELECT 1;',
		source: SqlEditorExecutionSource.Statement
	});
});

test('createExecutePayload rejects missing connection', () => {
	assert.throws(
		() => createExecutePayload(undefined, 'SELECT 1;', SqlEditorExecutionSource.All),
		/No SQL connection selected/
	);
});

test('createExecutePayload rejects empty SQL', () => {
	assert.throws(() => createExecutePayload('local', '   ', SqlEditorExecutionSource.All), /SQL is empty/);
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

test('findSqlStatementAtOffset falls back to the last statement after a trailing delimiter', () => {
	const sql = 'SELECT 1;\nSELECT 2;\n\n';
	const statement = findSqlStatementAtOffset(sql, sql.length);

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

test('splitSqlStatements ignores semicolon inside MySQL backtick identifier', () => {
	const sql = 'SELECT `a;b` FROM records;\nSELECT 2;';

	assert.deepEqual(
		splitSqlStatements(sql).map(statement => statement.sql),
		['SELECT `a;b` FROM records', 'SELECT 2']
	);
});

test('splitSqlStatements ignores semicolon inside SQLite bracket identifier', () => {
	const sql = 'SELECT [a;b] FROM records;\nSELECT 2;';

	assert.deepEqual(
		splitSqlStatements(sql).map(statement => statement.sql),
		['SELECT [a;b] FROM records', 'SELECT 2']
	);
});

test('splitSqlStatements ignores semicolon after backslash-escaped single quote', () => {
	const sql = String.raw`SELECT 'a\';b' AS value;
SELECT 2;`;

	assert.deepEqual(
		splitSqlStatements(sql).map(statement => statement.sql),
		[String.raw`SELECT 'a\';b' AS value`, 'SELECT 2']
	);
});

test('splitSqlStatements ignores semicolon after backslash-escaped double quote', () => {
	const sql = String.raw`SELECT "a\";b" AS value;
SELECT 2;`;

	assert.deepEqual(
		splitSqlStatements(sql).map(statement => statement.sql),
		[String.raw`SELECT "a\";b" AS value`, 'SELECT 2']
	);
});

test('findSqlStatementAtOffset ignores semicolon inside line comment', () => {
	const sql = 'SELECT 1 -- ; comment\n;\nSELECT 2;';
	const statement = findSqlStatementAtOffset(sql, 5);

	assert.equal(statement.sql, 'SELECT 1 -- ; comment');
});

test('findSqlStatementAtOffset ignores semicolon inside MySQL hash comment', () => {
	const sql = 'SELECT 1 # ; comment\n;\nSELECT 2;';
	const statement = findSqlStatementAtOffset(sql, 5);

	assert.equal(statement.sql, 'SELECT 1 # ; comment');
});

test('findSqlStatementAtOffset ignores semicolon inside block comment', () => {
	const sql = 'SELECT 1 /* ; comment */;\nSELECT 2;';
	const statement = findSqlStatementAtOffset(sql, 5);

	assert.equal(statement.sql, 'SELECT 1 /* ; comment */');
});

test('splitSqlStatements keeps quoted and commented semicolons inside statements', () => {
	const sql = "SELECT ';' AS value; -- keep ; here\nSELECT 2;";

	assert.deepEqual(
		splitSqlStatements(sql).map(statement => statement.sql),
		["SELECT ';' AS value", '-- keep ; here\nSELECT 2']
	);
});

test('getSqlEditorStatusLabel renders connection status', () => {
	assert.equal(
		getSqlEditorStatusLabel({
			connectionId: 'local',
			connectionName: 'Local SQLite',
			readOnly: true,
			dirty: false,
			running: false
		}),
		'Ready · Local SQLite · Read-only'
	);

	assert.equal(
		getSqlEditorStatusLabel({
			connectionId: 'local',
			readOnly: false,
			dirty: false,
			running: false
		}),
		'Ready · local · Write mode'
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

test('getSqlEditorToolbarState requires a selection for selection execution', () => {
	assert.deepEqual(
		getSqlEditorToolbarState({
			hasConnection: true,
			hasConnections: true,
			hasSelection: false,
			running: false,
			canCancel: false
		}),
		{
			canExecuteStatement: true,
			canExecuteSelection: false,
			canExecuteAll: true,
			canFormat: true,
			canChangeConnection: true,
			canCancel: false
		}
	);
});

test('getSqlEditorToolbarState exposes only cancellation while a cancellable query runs', () => {
	assert.deepEqual(
		getSqlEditorToolbarState({
			hasConnection: true,
			hasConnections: true,
			hasSelection: true,
			running: true,
			canCancel: true
		}),
		{
			canExecuteStatement: false,
			canExecuteSelection: false,
			canExecuteAll: false,
			canFormat: false,
			canChangeConnection: false,
			canCancel: true
		}
	);
});

test('createFormatterPlaceholderResult is a no-op placeholder', () => {
	assert.equal(createFormatterPlaceholderResult('SELECT 1;'), 'SELECT 1;');
});
