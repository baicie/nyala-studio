import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlCellKind, SqlQueryResult } from '../../../services/sql/common/sqlTypes.js';
import {
	addSqlResultSnapshot,
	buildSqlResultDisplayGrid,
	createCancelledResultSnapshot,
	createCancelledResultSnapshotFromEvent,
	createCancelledSqlResultState,
	createEmptySqlResultPanelState,
	createErrorResultSnapshot,
	createErrorResultSnapshotFromEvent,
	createErrorSqlResultState,
	createIdleSqlResultState,
	createResultSnapshotId,
	createRunningSqlResultState,
	createSqlResultPreview,
	createSuccessResultSnapshot,
	createSuccessResultSnapshotFromEvent,
	createSuccessSqlResultState,
	formatColumnLabel,
	formatSqlCellValue,
	getActiveSqlResultSnapshot,
	getSqlResultSummary,
	removeSqlResultSnapshot,
	sqlResultToCsv,
	SqlResultSnapshotKind,
	SqlResultStateKind
} from '../common/sqlResultModel.js';
import { SqlEditorExecutionSource } from '../../sqlEditor/common/sqlEditorModel.js';
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

test('createCancelledSqlResultState stores cancelled message', () => {
	const state = createCancelledSqlResultState({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT sleep(10)',
		startedAt: 10,
		completedAt: 20,
		message: 'cancelled'
	});

	assert.equal(state.kind, SqlResultStateKind.Cancelled);
	assert.equal(state.query.sql, 'SELECT sleep(10)');
	assert.equal(state.message, 'cancelled');
	assert.equal(getSqlResultSummary(state), 'Query cancelled: cancelled');
});

test('createCancelledSqlResultState falls back when message is empty', () => {
	const state = createCancelledSqlResultState({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT sleep(10)',
		startedAt: 10,
		completedAt: 20,
		message: '   '
	});

	assert.equal(state.message, 'Query was cancelled.');
});

test('createSuccessResultSnapshotFromEvent creates success snapshot', () => {
	const snapshot = createSuccessResultSnapshotFromEvent({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT 1',
		source: SqlEditorExecutionSource.All,
		startedAt: 1,
		completedAt: 2,
		result: snapshotResult
	});

	assert.equal(snapshot.kind, SqlResultSnapshotKind.Success);
	assert.equal(snapshot.createdAt, 2);
	assert.equal(snapshot.id, createResultSnapshotId('query-1', 2));
});

test('createErrorResultSnapshotFromEvent creates error snapshot', () => {
	const snapshot = createErrorResultSnapshotFromEvent({
		editorId: 'query-2',
		connectionId: 'local',
		sql: 'SELECT FROM',
		source: SqlEditorExecutionSource.All,
		startedAt: 3,
		completedAt: 4,
		error: new Error('syntax error')
	});

	assert.equal(snapshot.kind, SqlResultSnapshotKind.Error);
	assert.equal(snapshot.errorMessage, 'syntax error');
	assert.equal(snapshot.createdAt, 4);
});

test('snapshot helpers create terminal snapshots from editor events', () => {
	const snapshot = createCancelledResultSnapshotFromEvent({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT sleep(10)',
		source: SqlEditorExecutionSource.All,
		startedAt: 10,
		completedAt: 20,
		message: 'cancelled'
	});

	assert.equal(snapshot.kind, SqlResultSnapshotKind.Cancelled);
	assert.equal(snapshot.createdAt, 20);
	assert.equal(snapshot.message, 'cancelled');
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

test('SqlResultService records success error and cancelled snapshots', () => {
	const service = new SqlResultService();

	service.setSuccess({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT 1',
		source: SqlEditorExecutionSource.All,
		startedAt: 1,
		completedAt: 2,
		result: snapshotResult
	});

	service.setError({
		editorId: 'query-2',
		connectionId: 'local',
		sql: 'SELECT FROM',
		source: SqlEditorExecutionSource.All,
		startedAt: 3,
		completedAt: 4,
		error: new Error('syntax error')
	});

	service.setCancelled({
		editorId: 'query-3',
		connectionId: 'local',
		sql: 'SELECT sleep(10)',
		source: SqlEditorExecutionSource.All,
		startedAt: 5,
		completedAt: 6,
		message: 'cancelled'
	});

	assert.deepEqual(
		service.panelState.snapshots.map(snapshot => snapshot.kind),
		[
			SqlResultSnapshotKind.Cancelled,
			SqlResultSnapshotKind.Error,
			SqlResultSnapshotKind.Success
		]
	);
	assert.equal(service.panelState.activeSnapshotId, service.panelState.snapshots[0].id);
	assert.equal(service.state.kind, SqlResultStateKind.Cancelled);
});

test('SqlResultService emits panel state change when a snapshot is added', () => {
	const service = new SqlResultService();

	let lastPanelState = service.panelState;
	service.onDidChangePanelState(state => {
		lastPanelState = state;
	});

	service.setSuccess({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT 1',
		source: SqlEditorExecutionSource.All,
		startedAt: 1,
		completedAt: 2,
		result: snapshotResult
	});

	assert.equal(lastPanelState.snapshots.length, 1);
	assert.equal(lastPanelState.snapshots[0].kind, SqlResultSnapshotKind.Success);
});

test('SqlResultService.removeSnapshot updates active snapshot', () => {
	const service = new SqlResultService();

	service.setSuccess({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT 1',
		source: SqlEditorExecutionSource.All,
		startedAt: 1,
		completedAt: 2,
		result: snapshotResult
	});

	service.setSuccess({
		editorId: 'query-2',
		connectionId: 'local',
		sql: 'SELECT 2',
		source: SqlEditorExecutionSource.All,
		startedAt: 3,
		completedAt: 4,
		result: snapshotResult
	});

	const activeId = service.panelState.activeSnapshotId;
	assert.ok(activeId);

	service.removeSnapshot(activeId!);

	assert.equal(service.panelState.snapshots.find(s => s.id === activeId), undefined);
	assert.notEqual(service.panelState.activeSnapshotId, activeId);
});

test('SqlResultService.clear resets both state and panel state', () => {
	const service = new SqlResultService();

	service.setSuccess({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT 1',
		source: SqlEditorExecutionSource.All,
		startedAt: 1,
		completedAt: 2,
		result: snapshotResult
	});

	service.clear();

	assert.equal(service.state.kind, SqlResultStateKind.Idle);
	assert.equal(service.panelState.snapshots.length, 0);
	assert.equal(service.panelState.activeSnapshotId, undefined);
});

const snapshotResult: SqlQueryResult = {
	columns: [{ name: 'id', ordinal: 0 }],
	rows: [[{ kind: SqlCellKind.Integer, value: 1 }]],
	rowCount: 1,
	elapsedMs: 3,
	truncated: false
};

test('createSuccessResultSnapshot builds grid and status', () => {
	const snapshot = createSuccessResultSnapshot({
		id: 'r1',
		editorId: 'e1',
		connectionId: 'c1',
		sql: 'select 1',
		result: snapshotResult,
		createdAt: 1
	});

	assert.equal(snapshot.kind, SqlResultSnapshotKind.Success);
	assert.equal(snapshot.grid.rows.length, 1);
	assert.ok(snapshot.status.includes('1 row'));
	assert.equal(snapshot.sql, 'select 1');
	assert.equal(snapshot.sqlPreview, 'select 1');
});

test('createErrorResultSnapshot summarizes first line', () => {
	const snapshot = createErrorResultSnapshot({
		id: 'r1',
		editorId: 'e1',
		connectionId: 'c1',
		sql: 'select',
		error: new Error('syntax error\nnear select'),
		createdAt: 1
	});

	assert.equal(snapshot.kind, SqlResultSnapshotKind.Error);
	assert.equal(snapshot.errorMessage, 'syntax error');
	assert.equal(snapshot.detail, 'syntax error\nnear select');
	assert.equal(snapshot.title, 'Query Error');
});

test('createErrorResultSnapshot falls back when no message is available', () => {
	const snapshot = createErrorResultSnapshot({
		id: 'r1',
		editorId: 'e1',
		connectionId: 'c1',
		sql: 'select',
		error: new Error('   \n   '),
		createdAt: 1
	});

	assert.equal(snapshot.errorMessage, 'Query failed.');
});

test('createCancelledResultSnapshot uses fallback message', () => {
	const snapshot = createCancelledResultSnapshot({
		id: 'r1',
		editorId: 'e1',
		connectionId: 'c1',
		sql: 'select 1',
		message: ' ',
		createdAt: 1
	});

	assert.equal(snapshot.kind, SqlResultSnapshotKind.Cancelled);
	assert.equal(snapshot.message, 'Query was cancelled.');
	assert.equal(snapshot.title, 'Query Cancelled');
});

test('addSqlResultSnapshot puts newest first and limits size', () => {
	let state = createEmptySqlResultPanelState();
	for (let index = 0; index < 3; index++) {
		state = addSqlResultSnapshot(
			state,
			createSuccessResultSnapshot({
				id: `r${index}`,
				editorId: 'e',
				connectionId: 'c',
				sql: `select ${index}`,
				result: snapshotResult,
				createdAt: index
			}),
			2
		);
	}

	assert.deepEqual(state.snapshots.map(item => item.id), ['r2', 'r1']);
	assert.equal(state.activeSnapshotId, 'r2');
});

test('addSqlResultSnapshot deduplicates by id', () => {
	let state = createEmptySqlResultPanelState();
	const base = createSuccessResultSnapshot({
		id: 'r1',
		editorId: 'e',
		connectionId: 'c',
		sql: 'select 1',
		result: snapshotResult,
		createdAt: 1
	});
	const updated = createSuccessResultSnapshot({
		id: 'r1',
		editorId: 'e',
		connectionId: 'c',
		sql: 'select 1 again',
		result: snapshotResult,
		createdAt: 2
	});

	state = addSqlResultSnapshot(state, base);
	state = addSqlResultSnapshot(state, updated);

	assert.equal(state.snapshots.length, 1);
	assert.equal(state.snapshots[0].sql, 'select 1 again');
});

test('addSqlResultSnapshot rejects non-positive maxSnapshots', () => {
	const snapshot = createSuccessResultSnapshot({
		id: 'r1',
		editorId: 'e',
		connectionId: 'c',
		sql: 'select 1',
		result: snapshotResult,
		createdAt: 1
	});

	assert.throws(
		() => addSqlResultSnapshot(createEmptySqlResultPanelState(), snapshot, 0),
		/maxSnapshots must be a positive integer/
	);
});

test('removeSqlResultSnapshot moves active snapshot', () => {
	const r1 = createSuccessResultSnapshot({
		id: 'r1',
		editorId: 'e',
		connectionId: 'c',
		sql: 'select 1',
		result: snapshotResult,
		createdAt: 1
	});
	const r2 = createSuccessResultSnapshot({
		id: 'r2',
		editorId: 'e',
		connectionId: 'c',
		sql: 'select 2',
		result: snapshotResult,
		createdAt: 2
	});

	let state = addSqlResultSnapshot(addSqlResultSnapshot(createEmptySqlResultPanelState(), r1), r2);
	state = removeSqlResultSnapshot(state, 'r2');

	assert.equal(state.snapshots.length, 1);
	assert.equal(state.activeSnapshotId, 'r1');
	assert.equal(getActiveSqlResultSnapshot(state)?.id, 'r1');
});

test('removeSqlResultSnapshot ignores empty snapshotId', () => {
	const snapshot = createSuccessResultSnapshot({
		id: 'r1',
		editorId: 'e',
		connectionId: 'c',
		sql: 'select 1',
		result: snapshotResult,
		createdAt: 1
	});

	const state = addSqlResultSnapshot(createEmptySqlResultPanelState(), snapshot);
	const next = removeSqlResultSnapshot(state, '   ');

	assert.equal(next, state);
});

test('getActiveSqlResultSnapshot falls back to first snapshot when active id is missing', () => {
	const r1 = createSuccessResultSnapshot({
		id: 'r1',
		editorId: 'e',
		connectionId: 'c',
		sql: 'select 1',
		result: snapshotResult,
		createdAt: 1
	});
	const state = { snapshots: [r1], activeSnapshotId: 'does-not-exist' } as const;

	assert.equal(getActiveSqlResultSnapshot(state)?.id, 'r1');
});

test('createSqlResultPreview compacts whitespace and truncates', () => {
	assert.equal(createSqlResultPreview(' select\n* from users ', 12), 'select * fr…');
});

test('createSqlResultPreview returns sql as-is when shorter than maxLength', () => {
	assert.equal(createSqlResultPreview('select 1', 160), 'select 1');
});

test('createResultSnapshotId is deterministic for editor and time', () => {
	assert.equal(createResultSnapshotId('editor', 100), createResultSnapshotId('editor', 100));
	assert.notEqual(createResultSnapshotId('editor', 100), createResultSnapshotId('editor', 101));
});
