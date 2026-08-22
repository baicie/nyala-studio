import assert from 'node:assert/strict';
import test from 'node:test';

import {
	resolveSqlToExecute,
	SqlEditorExecutionController,
	SqlEditorRunningState
} from '../common/sqlEditorExecutionController.js';
import { SqlEditorExecutionSource } from '../common/sqlEditorModel.js';
import { SqlCellKind, SqlExecuteQueryRequest, SqlQueryResult } from '../../../services/sql/common/sqlTypes.js';

class FakeQueryService {
	cancelled = false;
	executeCalls = 0;
	cancelCalls = 0;
	readonly executeRequests: SqlExecuteQueryRequest[] = [];
	private readonly executeImpl: (request: SqlExecuteQueryRequest) => Promise<unknown>;
	private readonly cancelImpl: (request: { connectionId: string; queryId?: string }) => Promise<unknown>;

	constructor(
		options: {
			execute?: (request: SqlExecuteQueryRequest) => Promise<unknown>;
			cancel?: (request: { connectionId: string; queryId?: string }) => Promise<unknown>;
		} = {}
	) {
		this.executeImpl =
			options.execute ??
			(() =>
				Promise.resolve({
					columns: [{ name: 'value', ordinal: 0 }],
					rows: [[{ kind: SqlCellKind.Integer, value: 1 }]],
					rowCount: 1,
					elapsedMs: 2,
					truncated: false
				}));
		this.cancelImpl =
			options.cancel ??
			((request: { connectionId: string; queryId?: string }) => {
				this.cancelled = true;
				return Promise.resolve({
					cancelled: true,
					connectionId: request.connectionId,
					queryId: request.queryId,
					message: 'cancelled'
				});
			});
	}

	async executeQuery(request: SqlExecuteQueryRequest): Promise<unknown> {
		this.executeCalls++;
		this.executeRequests.push(request);
		return this.executeImpl(request);
	}

	async cancelQuery(request: { connectionId: string; queryId?: string }): Promise<unknown> {
		this.cancelCalls++;
		return this.cancelImpl(request);
	}
}

function emptyResult(): SqlQueryResult {
	return {
		columns: [],
		rows: [],
		rowCount: 0,
		elapsedMs: 0,
		truncated: false
	};
}

function resultWithValue(value: number): SqlQueryResult {
	return {
		columns: [{ name: 'value', ordinal: 0 }],
		rows: [[{ kind: SqlCellKind.Integer, value }]],
		rowCount: 1,
		elapsedMs: value,
		truncated: false
	};
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
		editorVersionId: 7,
		connectionId: 'conn-1',
		fullSql: 'select 1',
		source: SqlEditorExecutionSource.All
	});

	assert.equal(service.executeCalls, 1);
	assert.equal(result.started.startedAt, 10);
	assert.equal(result.started.source, SqlEditorExecutionSource.All);
	assert.equal(result.started.connectionId, 'conn-1');
	assert.equal(result.started.editorVersionId, 7);
	assert.equal(result.started.statementCount, 1);
	assert.equal(result.started.sql, 'select 1');

	assert.ok(result.completed);
	assert.equal(result.completed?.editorVersionId, 7);
	assert.equal(result.completed?.statementCount, 1);
	assert.equal(result.completed?.completedAt, 11);
	assert.equal(result.completed?.result.rowCount, 1);
	assert.equal(result.failed, undefined);
	assert.equal(controller.state.state, SqlEditorRunningState.Idle);
});

test('execute all runs multiple statements sequentially', async () => {
	const service = new FakeQueryService({
		execute: request => Promise.resolve(resultWithValue(request.sql.includes('select 2') ? 2 : 1))
	});
	const controller = new SqlEditorExecutionController(cast(service), () => 0);

	const result = await controller.execute({
		editorId: 'editor-1',
		connectionId: 'conn-1',
		fullSql: "select ';' as value; -- keep ; here\nselect 2;",
		source: SqlEditorExecutionSource.All
	});

	assert.deepEqual(
		service.executeRequests.map(request => request.sql),
		["select ';' as value", '-- keep ; here\nselect 2']
	);
	assert.ok(result.completed);
	assert.deepEqual(
		result.completed?.statementResults.map(statement => ({
			sql: statement.sql,
			statementIndex: statement.statementIndex,
			statementCount: statement.statementCount,
			value: statement.result.rows[0][0].value
		})),
		[
			{ sql: "select ';' as value", statementIndex: 0, statementCount: 2, value: 1 },
			{ sql: '-- keep ; here\nselect 2', statementIndex: 1, statementCount: 2, value: 2 }
		]
	);
	assert.equal(new Set(result.completed?.statementResults.map(statement => statement.resultId)).size, 2);
	assert.equal(result.completed?.result.rows[0][0].value, 2);
});

test('execute all stops after the first failed statement', async () => {
	const service = new FakeQueryService({
		execute: request =>
			request.sql === 'select 2' ? Promise.reject(new Error('second statement failed')) : Promise.resolve(emptyResult())
	});
	const controller = new SqlEditorExecutionController(cast(service), () => 0);

	const result = await controller.execute({
		editorId: 'editor-1',
		connectionId: 'conn-1',
		fullSql: 'select 1; select 2; select 3;',
		source: SqlEditorExecutionSource.All
	});

	assert.deepEqual(
		service.executeRequests.map(request => request.sql),
		['select 1', 'select 2']
	);
	assert.equal(result.failed?.error.message, 'second statement failed');
	assert.deepEqual(
		result.failed?.statementResults.map(statement => statement.sql),
		['select 1']
	);
	assert.equal(result.failed?.failedStatement?.sql, 'select 2');
	assert.equal(result.failed?.failedStatement?.statementIndex, 1);
	assert.equal(result.failed?.failedStatement?.statementCount, 3);
});

test('execute forwards limit when provided', async () => {
	let observed: { limit?: number } = {};
	const service = new FakeQueryService({
		execute: () =>
			Promise.resolve({
				columns: [],
				rows: [],
				rowCount: 0,
				elapsedMs: 0,
				truncated: false
			})
	});
	service.executeQuery = async request => {
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
		() =>
			controller.execute({
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
		() =>
			controller.execute({
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
		execute: () =>
			new Promise(resolve => {
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
		() =>
			controller.execute({
				editorId: 'editor-1',
				connectionId: 'conn-1',
				fullSql: 'select 2',
				source: SqlEditorExecutionSource.All
			}),
		/already running/
	);

	resolveExecute(emptyResult());
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
		execute: () =>
			new Promise(resolve => {
				resolveExecute = resolve;
			}),
		cancel: request =>
			Promise.resolve({
				cancelled: true,
				connectionId: request.connectionId,
				queryId: request.queryId,
				message: 'stopped'
			})
	});
	const controller = new SqlEditorExecutionController(cast(service), () => time++);

	const executePromise = controller.execute({
		editorId: 'editor-1',
		editorVersionId: 9,
		connectionId: 'conn-1',
		fullSql: 'select 1',
		source: SqlEditorExecutionSource.All
	});

	assert.equal(controller.state.state, SqlEditorRunningState.Running);
	assert.match(controller.state.executionId ?? '', /^sql-execution-/);
	assert.equal(controller.state.canCancel, true);

	const cancelled = await controller.cancel('query-1');

	assert.ok(cancelled);
	assert.equal(cancelled?.editorId, 'editor-1');
	assert.equal(cancelled?.editorVersionId, 9);
	assert.equal(cancelled?.source, SqlEditorExecutionSource.All);
	assert.equal(cancelled?.statementCount, 1);
	assert.equal(cancelled?.startedAt, 100);
	assert.equal(cancelled?.completedAt, 101);
	assert.equal(cancelled?.message, 'stopped');
	assert.equal(service.cancelCalls, 1);
	assert.equal(controller.state.state, SqlEditorRunningState.Idle);

	resolveExecute(emptyResult());

	const executeResult = await executePromise;
	assert.equal(executeResult.completed, undefined);
	assert.equal(executeResult.failed, undefined);
	assert.equal(executeResult.cancelled?.message, 'stopped');
	assert.equal(controller.state.state, SqlEditorRunningState.Idle);
});

test('execute resolves as cancelled instead of completed after a successful cancel', async () => {
	let resolveExecute: (value: unknown) => void = () => undefined;
	let time = 100;

	const service = new FakeQueryService({
		execute: () =>
			new Promise(resolve => {
				resolveExecute = resolve;
			}),
		cancel: request =>
			Promise.resolve({
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

	const cancelled = await controller.cancel('query-1');
	assert.ok(cancelled);
	assert.equal(controller.state.state, SqlEditorRunningState.Idle);

	resolveExecute(emptyResult());

	const executeResult = await executePromise;
	assert.equal(executeResult.completed, undefined);
	assert.equal(executeResult.failed, undefined);
	assert.equal(executeResult.cancelled?.message, 'stopped');
});

test('cancel preserves statements that completed before the active statement', async () => {
	let resolveSecond: (value: unknown) => void = () => undefined;
	let executeCalls = 0;
	const service = new FakeQueryService({
		execute: () => {
			executeCalls++;
			if (executeCalls === 1) {
				return Promise.resolve(resultWithValue(1));
			}

			return new Promise(resolve => {
				resolveSecond = resolve;
			});
		},
		cancel: request =>
			Promise.resolve({
				cancelled: true,
				connectionId: request.connectionId,
				queryId: request.queryId,
				message: 'stopped'
			})
	});
	const controller = new SqlEditorExecutionController(cast(service), () => 0);
	const executePromise = controller.execute({
		editorId: 'editor-1',
		connectionId: 'conn-1',
		fullSql: 'select 1; select 2;',
		source: SqlEditorExecutionSource.All
	});

	while (executeCalls < 2) {
		await new Promise<void>(resolve => setImmediate(resolve));
	}

	const cancelled = await controller.cancel();
	assert.deepEqual(
		cancelled?.statementResults?.map(statement => statement.sql),
		['select 1']
	);

	resolveSecond(emptyResult());
	const result = await executePromise;
	assert.equal(result.cancelled?.statementResults?.length, 1);
});

test('execute resolves as cancelled instead of failed when cancellation races a thrown error', async () => {
	const executeSignals: { resolve: (value: unknown) => void; reject: (reason?: unknown) => void } = {
		resolve: () => undefined,
		reject: () => undefined
	};

	const service = new FakeQueryService({
		execute: () =>
			new Promise<unknown>((resolve, reject) => {
				executeSignals.resolve = resolve;
				executeSignals.reject = reject;
			}),
		cancel: request =>
			Promise.resolve({
				cancelled: true,
				connectionId: request.connectionId,
				queryId: request.queryId,
				message: 'stopped'
			})
	});

	const controller = new SqlEditorExecutionController(cast(service), () => 1);

	const executePromise = controller.execute({
		editorId: 'editor-1',
		connectionId: 'conn-1',
		fullSql: 'select 1',
		source: SqlEditorExecutionSource.All
	});

	const cancelled = await controller.cancel('query-1');
	assert.ok(cancelled);

	executeSignals.reject(new Error('late connection reset'));

	const executeResult = await executePromise;
	assert.equal(executeResult.failed, undefined);
	assert.equal(executeResult.cancelled?.message, 'stopped');
});

test('stale execute completion after cancel does not reset a newer running query', async () => {
	let resolveFirst: (value: unknown) => void = () => undefined;
	let resolveSecond: (value: unknown) => void = () => undefined;
	let call = 0;

	const service = new FakeQueryService({
		execute: () =>
			new Promise(resolve => {
				call++;
				if (call === 1) {
					resolveFirst = resolve;
				} else {
					resolveSecond = resolve;
				}
			}),
		cancel: request =>
			Promise.resolve({
				cancelled: true,
				connectionId: request.connectionId,
				queryId: request.queryId,
				message: 'stopped'
			})
	});

	const controller = new SqlEditorExecutionController(cast(service), () => 1);

	const first = controller.execute({
		editorId: 'editor-1',
		connectionId: 'conn-1',
		fullSql: 'select 1',
		source: SqlEditorExecutionSource.All
	});

	await controller.cancel('query-1');
	assert.equal(controller.state.state, SqlEditorRunningState.Idle);

	const second = controller.execute({
		editorId: 'editor-1',
		connectionId: 'conn-1',
		fullSql: 'select 2',
		source: SqlEditorExecutionSource.All
	});

	assert.equal(controller.state.state, SqlEditorRunningState.Running);
	assert.equal(controller.state.sql, 'select 2');

	resolveFirst(emptyResult());

	await first;
	assert.equal(controller.state.state, SqlEditorRunningState.Running);
	assert.equal(controller.state.sql, 'select 2');

	resolveSecond(emptyResult());

	await second;
	assert.equal(controller.state.state, SqlEditorRunningState.Idle);
});

test('cancel returns undefined when the underlying service says cancel had no effect', async () => {
	let resolveExecute: (value: unknown) => void = () => undefined;
	const service = new FakeQueryService({
		execute: () =>
			new Promise(resolve => {
				resolveExecute = resolve;
			}),
		cancel: request =>
			Promise.resolve({
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

	resolveExecute(emptyResult());

	const executeResult = await executePromise;
	assert.ok(executeResult.completed);
	assert.equal(executeResult.cancelled, undefined);
	assert.equal(executeResult.failed, undefined);
});

test('cancel refuses to call the service when canCancel is disabled', async () => {
	let resolveExecute: (value: unknown) => void = () => undefined;
	const service = new FakeQueryService({
		execute: () =>
			new Promise(resolve => {
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

	resolveExecute(emptyResult());
	await executePromise;
});
