import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlCellKind, SqlQueryResult } from '../../../services/sql/common/sqlTypes.js';
import {
	buildSqlResultDisplayGrid,
	createErrorSqlResultState,
	createIdleSqlResultState,
	createRunningSqlResultState,
	createSuccessSqlResultState,
	formatColumnLabel,
	formatSqlCellValue,
	getSqlResultSummary,
	sqlResultToCsv,
	SqlResultStateKind
} from '../common/sqlResultModel.js';
import { SqlResultService } from '../common/sqlResultService.js';

const sampleResult: SqlQueryResult = {
	columns: [
		{ name: 'id', ordinal: 0 },
		{ name: 'name', ordinal: 1 }
	],
	rows: [
		[
			{ kind: SqlCellKind.Integer, value: 1 },
			{ kind: SqlCellKind.Text, value: 'Alice' }
		],
		[
			{ kind: SqlCellKind.Integer, value: 2 },
			{ kind: SqlCellKind.Null, value: null }
		]
	],
	rowCount: 2,
	elapsedMs: 3,
	truncated: false
};

test('createIdleSqlResultState returns idle state', () => {
	const state = createIdleSqlResultState();

	assert.equal(state.kind, SqlResultStateKind.Idle);
	assert.equal(getSqlResultSummary(state), 'Run a SQL query to see results.');
});

test('createRunningSqlResultState stores query info', () => {
	const state = createRunningSqlResultState({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT 1',
		startedAt: 10
	});

	assert.equal(state.kind, SqlResultStateKind.Running);
	assert.equal(state.query.editorId, 'query-1');
	assert.equal(state.query.connectionId, 'local');
	assert.equal(getSqlResultSummary(state), 'Running query on local...');
});

test('createSuccessSqlResultState stores result', () => {
	const state = createSuccessSqlResultState({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT * FROM users',
		startedAt: 10,
		completedAt: 20,
		result: sampleResult
	});

	assert.equal(state.kind, SqlResultStateKind.Success);
	assert.equal(state.result.rowCount, 2);
	assert.equal(getSqlResultSummary(state), 'Query completed: 2 row(s) in 3ms.');
});

test('createSuccessSqlResultState summarizes affected rows when there are no columns', () => {
	const state = createSuccessSqlResultState({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'UPDATE users SET name = name',
		startedAt: 10,
		completedAt: 20,
		result: {
			columns: [],
			rows: [],
			affectedRows: 5,
			rowCount: 0,
			elapsedMs: 7,
			truncated: false
		}
	});

	assert.equal(getSqlResultSummary(state), 'Query completed: 5 row(s) affected in 7ms.');
});

test('createErrorSqlResultState stores error message', () => {
	const state = createErrorSqlResultState({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT FROM',
		startedAt: 10,
		completedAt: 20,
		error: new Error('syntax error')
	});

	assert.equal(state.kind, SqlResultStateKind.Error);
	assert.equal(state.errorMessage, 'syntax error');
	assert.equal(getSqlResultSummary(state), 'Query failed: syntax error');
});

test('formatColumnLabel falls back to ordinal label', () => {
	assert.equal(formatColumnLabel({ name: '', ordinal: 0 }), 'Column 1');
	assert.equal(formatColumnLabel({ name: 'name', ordinal: 1 }), 'name');
});

test('formatSqlCellValue formats primitive values', () => {
	assert.equal(formatSqlCellValue({ kind: SqlCellKind.Null, value: null }), 'NULL');
	assert.equal(formatSqlCellValue({ kind: SqlCellKind.Integer, value: 1 }), '1');
	assert.equal(formatSqlCellValue({ kind: SqlCellKind.Real, value: 1.5 }), '1.5');
	assert.equal(formatSqlCellValue({ kind: SqlCellKind.Text, value: 'Alice' }), 'Alice');
});

test('formatSqlCellValue formats blob values', () => {
	assert.equal(
		formatSqlCellValue({
			kind: SqlCellKind.Blob,
			value: {
				encoding: 'base64',
				data: 'AQID',
				byteLength: 3
			}
		}),
		'[blob 3 bytes]'
	);
});

test('buildSqlResultDisplayGrid builds display grid', () => {
	const grid = buildSqlResultDisplayGrid(sampleResult);

	assert.deepEqual(grid.columns, ['id', 'name']);
	assert.deepEqual(grid.rows, [
		['1', 'Alice'],
		['2', 'NULL']
	]);
	assert.equal(grid.renderedRowCount, 2);
	assert.equal(grid.totalRowCount, 2);
	assert.equal(grid.truncatedByBackend, false);
	assert.equal(grid.truncatedByPanel, false);
});

test('buildSqlResultDisplayGrid marks panel truncation', () => {
	const grid = buildSqlResultDisplayGrid(sampleResult, 1);

	assert.equal(grid.renderedRowCount, 1);
	assert.equal(grid.totalRowCount, 2);
	assert.equal(grid.truncatedByPanel, true);
});

test('buildSqlResultDisplayGrid rejects invalid maxRows', () => {
	assert.throws(() => buildSqlResultDisplayGrid(sampleResult, 0), /maxRows must be a positive integer/);
});

test('sqlResultToCsv escapes CSV cells', () => {
	const result: SqlQueryResult = {
		columns: [
			{ name: 'id', ordinal: 0 },
			{ name: 'text', ordinal: 1 }
		],
		rows: [
			[
				{ kind: SqlCellKind.Integer, value: 1 },
				{ kind: SqlCellKind.Text, value: 'hello, "world"' }
			]
		],
		rowCount: 1,
		elapsedMs: 1,
		truncated: false
	};

	assert.equal(sqlResultToCsv(result), 'id,text\n1,"hello, ""world"""');
});

test('SqlResultService emits state changes for query lifecycle', () => {
	const service = new SqlResultService();
	const states: SqlResultStateKind[] = [];

	service.onDidChangeResult(state => {
		states.push(state.kind);
	});

	service.setRunning({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT 1',
		startedAt: 1
	});

	service.setSuccess({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT 1',
		startedAt: 1,
		completedAt: 2,
		result: {
			columns: [{ name: 'value', ordinal: 0 }],
			rows: [[{ kind: SqlCellKind.Integer, value: 1 }]],
			rowCount: 1,
			elapsedMs: 1,
			truncated: false
		}
	});

	service.clear();

	assert.deepEqual(states, [
		SqlResultStateKind.Running,
		SqlResultStateKind.Success,
		SqlResultStateKind.Idle
	]);
});
