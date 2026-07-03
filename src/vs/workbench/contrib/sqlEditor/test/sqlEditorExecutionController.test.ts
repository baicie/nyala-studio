import assert from 'node:assert/strict';
import test from 'node:test';

import {
	resolveSqlToExecute,
	SqlEditorExecutionController,
	SqlEditorRunningState
} from '../common/sqlEditorExecutionController.js';
import { SqlEditorExecutionSource } from '../common/sqlEditorModel.js';
import { SqlCellKind } from '../../../services/sql/common/sqlTypes.js';

class FakeQueryService {
	cancelled = false;
	executeCalls = 0;
	cancelCalls = 0;
	private readonly executeImpl: () => Promise<unknown>;
	private readonly cancelImpl: (request: { connectionId: string; queryId?: string }) => Promise<unknown>;

	constructor(options: {
		execute?: () => Promise<unknown>;
		cancel?: (request: { connectionId: string; queryId?: string }) => Promise<unknown>;
	} = {}) {
		this.executeImpl = options.execute ?? (() => Promise.resolve({
			columns: [{ name: 'value', ordinal: 0 }],
			rows: [[{ kind: SqlCellKind.Integer, value: 1 }]],
			rowCount: 1,
			elapsedMs: 2,
			truncated: false
		}));
		this.cancelImpl = options.cancel ?? ((request: { connectionId: string; queryId?: string }) => {
			this.cancelled = true;
			return Promise.resolve({
				cancelled: true,
				connectionId: request.connectionId,
				queryId: request.queryId,
				message: 'cancelled'
			});
		});
	}

	async executeQuery(): Promise<unknown> {
		this.executeCalls++;
		return this.executeImpl();
	}

	async cancelQuery(request: { connectionId: string; queryId?: string }): Promise<unknown> {
		this.cancelCalls++;
		return this.cancelImpl(request);
	}
}

function cast<T>(value: unknown): T {
	return value as T;
}

test('resolveSqlToExecute returns all sql', () => {
	assert.equal(
		resolveSqlToExecute({
			editorId: 'e',
			connectionId: 'c',
			fullSql: 'select 1',
			source: SqlEditorExecutionSource.All
		}),
		'select 1'
	);
});

test('resolveSqlToExecute returns selected sql', () => {
	assert.equal(
		resolveSqlToExecute({
			editorId: 'e',
			connectionId: 'c',
			fullSql: 'select 1',
			selectedSql: 'select 2',
			source: SqlEditorExecutionSource.Selection
		}),
		'select 2'
	);
});

test('resolveSqlToExecute falls back to empty selection when nothing is highlighted', () => {
	assert.equal(
		resolveSqlToExecute({
			editorId: 'e',
			connectionId: 'c',
			fullSql: 'select 1',
			source: SqlEditorExecutionSource.Selection
		}),
		''
	);
});

test('resolveSqlToExecute returns current statement by cursor offset', () => {
	const sql = 'select 1;\nselect 2;';
	assert.equal(
		resolveSqlToExecute({
			editorId: 'e',
			connectionId: 'c',
			fullSql: sql,
			cursorOffset: 12,
			source: SqlEditorExecutionSource.Statement
		}),
		'select 2'
	);
});

test('execute emits completed event and resets state', async () => {
	let time = 10;
	const service = new FakeQueryService();
	const controller = new SqlEditorExecutionController(cast(service), () => time++);

	const result = await controller.execute({
		editorId: 'editor-1',
		connectionId: 'conn-1',
		fullSql: 'select 1',
		source: SqlEditorExecutionSource.All
	});

	assert.equal(service.executeCalls, 1);
	assert.equal(result.started.startedAt, 10);
	assert.equal(result.started.source, SqlEditorExecutionSource.All);
	assert.equal(result.started.connectionId, 'conn-1');
	assert.equal(result.started.sql, 'select 1');

	assert.ok(result.completed);
	assert.equal(result.completed?.completedAt, 11);
	assert.equal(result.completed?.result.rowCount, 1);
	assert.equal(result.failed, undefined);
	assert.equal(controller.state.state, SqlEditorRunningState.Idle);
});

test('execute forwards limit when provided', async () => {
	let observed: { limit?: number } = {};
	const service = new FakeQueryService({
		execute: () => Promise.resolve({
			columns: [],
			rows: [],
			rowCount: 0,
			elapsedMs: 0,
			truncated: false
		})
	});
	service.executeQuery = async (request) => {
		service.executeCalls++;
		observed = request;
		return {
			columns: [],
			rows: [],
			rowCount: 0,
			elapsedMs: 0,
			truncated: false
		};
	};
	const controller = new SqlEditorExecutionController(cast(service), () => 0);

	await controller.execute({
		editorId: 'editor-1',
		connectionId: 'conn-1',
		fullSql: 'select 1',
		source: SqlEditorExecutionSource.All,
		limit: 42
	});

	assert.equal(observed.limit, 42);
});

test('execute returns failed event when the query service throws', async () => {
	const service = new FakeQueryService({
		execute: () => Promise.reject(new Error('boom'))
	});
	const controller = new SqlEditorExecutionController(cast(service), () => 0);

	const result = await controller.execute({
		editorId: 'editor-1',
		connectionId: 'conn-1',
		fullSql: 'select broken',
		source: SqlEditorExecutionSource.All
	});

	assert.equal(result.failed?.error.message, 'boom');
	assert.equal(result.completed, undefined);
	assert.equal(controller.state.state, SqlEditorRunningState.Idle);
});

test('execute normalizes non-Error throws into an Error instance', async () => {
	const service = new FakeQueryService({
		execute: () => Promise.reject('plain string failure')
	});
	const controller = new SqlEditorExecutionController(cast(service), () => 0);

	const result = await controller.execute({
		editorId: 'editor-1',
		connectionId: 'conn-1',
		fullSql: 'select broken',
		source: SqlEditorExecutionSource.All
	});

	assert.ok(result.failed?.error instanceof Error);
	assert.equal(result.failed?.error.message, 'plain string failure');
});

test('execute rejects when no connection is provided', async () => {
	const service = new FakeQueryService();
	const controller = new SqlEditorExecutionController(cast(service), () => 0);

	await assert.rejects(
		() => controller.execute({
			editorId: 'editor-1',
			fullSql: 'select 1',
			source: SqlEditorExecutionSource.All
		}),
		/No SQL connection selected/
	);
	assert.equal(service.executeCalls, 0);
});

test('execute rejects when sql is empty', async () => {
	const service = new FakeQueryService();
	const controller = new SqlEditorExecutionController(cast(service), () => 0);

	await assert.rejects(
		() => controller.execute({
			editorId: 'editor-1',
			connectionId: 'conn-1',
			fullSql: '   \n\t',
			source: SqlEditorExecutionSource.All
		}),
		/SQL is empty/
	);
	assert.equal(service.executeCalls, 0);
});

test('execute refuses to run a second query while one is in flight', async () => {
	let resolveExecute: (value: unknown) => void = () => undefined;
	const service = new FakeQueryService({
		execute: () => new Promise((resolve) => {
			resolveExecute = resolve;
		})
	});
	const controller = new SqlEditorExecutionController(cast(service), () => 0);

	const first = controller.execute({
		editorId: 'editor-1',
		connectionId: 'conn-1',
		fullSql: 'select 1',
		source: SqlEditorExecutionSource.All
	});

	await assert.rejects(
		() => controller.execute({
			editorId: 'editor-1',
			connectionId: 'conn-1',
			fullSql: 'select 2',
			source: SqlEditorExecutionSource.All
		}),
		/already running/
	);

	resolveExecute({
		columns: [],
		rows: [],
		rowCount: 0,
		elapsedMs: 0,
		truncated: false
	});
	await first;
	assert.equal(controller.state.state, SqlEditorRunningState.Idle);
});

test('cancel returns undefined when the controller is idle', async () => {
	const service = new FakeQueryService();
	const controller = new SqlEditorExecutionController(cast(service), () => 0);

	const cancelled = await controller.cancel('query-1');

	assert.equal(cancelled, undefined);
	assert.equal(service.cancelCalls, 0);
});

test('cancel returns cancelled event while a query is running and canCancel is allowed', async () => {
	let resolveExecute: (value: unknown) => void = () => undefined;
	let time = 100;
	const service = new FakeQueryService({
		execute: () => new Promise((resolve) => {
			resolveExecute = resolve;
		}),
		cancel: (request) => Promise.resolve({
			cancelled: true,
			connectionId: request.connectionId,
			queryId: request.queryId,
			message: 'stopped'
		})
	});
	const controller = new SqlEditorExecutionController(cast(service), () => time++);

	const executePromise = controller.execute({
		editorId: 'editor-1',
		connectionId: 'conn-1',
		fullSql: 'select 1',
		source: SqlEditorExecutionSource.All
	});

	assert.equal(controller.state.state, SqlEditorRunningState.Running);
	assert.equal(controller.state.canCancel, true);

	const cancelled = await controller.cancel('query-1');

	assert.ok(cancelled);
	assert.equal(cancelled?.editorId, 'editor-1');
	assert.equal(cancelled?.source, SqlEditorExecutionSource.All);
	assert.equal(cancelled?.startedAt, 100);
	assert.equal(cancelled?.completedAt, 101);
	assert.equal(cancelled?.message, 'stopped');
	assert.equal(service.cancelCalls, 1);
	assert.equal(controller.state.state, SqlEditorRunningState.Idle);

	resolveExecute({
		columns: [],
		rows: [],
		rowCount: 0,
		elapsedMs: 0,
		truncated: false
	});
	await executePromise;
});

test('cancel forwards the optional queryId to the query service', async () => {
	let resolveExecute: (value: unknown) => void = () => undefined;
	const service = new FakeQueryService({
		execute: () => new Promise((resolve) => {
			resolveExecute = resolve;
		})
	});
	const controller = new SqlEditorExecutionController(cast(service), () => 0);

	const executePromise = controller.execute({
		editorId: 'editor-1',
		connectionId: 'conn-1',
		fullSql: 'select 1',
		source: SqlEditorExecutionSource.All
	});

	await controller.cancel('query-abc');

	resolveExecute({
		columns: [],
		rows: [],
		rowCount: 0,
		elapsedMs: 0,
		truncated: false
	});
	await executePromise;
});

test('cancel returns undefined when the underlying service says cancel had no effect', async () => {
	let resolveExecute: (value: unknown) => void = () => undefined;
	const service = new FakeQueryService({
		execute: () => new Promise((resolve) => {
			resolveExecute = resolve;
		}),
		cancel: (request) => Promise.resolve({
			cancelled: false,
			connectionId: request.connectionId,
			queryId: request.queryId,
			message: 'query already finished'
		})
	});
	const controller = new SqlEditorExecutionController(cast(service), () => 0);

	const executePromise = controller.execute({
		editorId: 'editor-1',
		connectionId: 'conn-1',
		fullSql: 'select 1',
		source: SqlEditorExecutionSource.All
	});

	const cancelled = await controller.cancel('query-1');

	assert.equal(cancelled, undefined);
	assert.equal(controller.state.state, SqlEditorRunningState.Running);

	resolveExecute({
		columns: [],
		rows: [],
		rowCount: 0,
		elapsedMs: 0,
		truncated: false
	});
	await executePromise;
});

test('cancel refuses to call the service when canCancel is disabled', async () => {
	let resolveExecute: (value: unknown) => void = () => undefined;
	const service = new FakeQueryService({
		execute: () => new Promise((resolve) => {
			resolveExecute = resolve;
		})
	});
	const controller = new SqlEditorExecutionController(cast(service), () => 0);

	const executePromise = controller.execute({
		editorId: 'editor-1',
		connectionId: 'conn-1',
		fullSql: 'select 1',
		source: SqlEditorExecutionSource.All,
		canCancel: false
	});

	assert.equal(controller.state.state, SqlEditorRunningState.Running);
	assert.equal(controller.state.canCancel, false);

	const cancelled = await controller.cancel('query-1');
	assert.equal(cancelled, undefined);
	assert.equal(service.cancelCalls, 0);

	resolveExecute({
		columns: [],
		rows: [],
		rowCount: 0,
		elapsedMs: 0,
		truncated: false
	});
	await executePromise;
});