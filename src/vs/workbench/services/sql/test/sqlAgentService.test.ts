import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlAgentMode, SqlAgentTaskKind } from '../common/sqlAgent.js';
import { SqlCapability } from '../common/sqlCapabilities.js';
import { SqlDialect } from '../common/sqlDialect.js';
import { ISqlCommandExecutor, SqlCommandName } from '../browser/sqlCommandExecutor.js';
import {
	SqlAgentService,
	normalizeSqlAgentReadOnlyRequest,
	normalizeSqlAgentStartRequest
} from '../browser/sqlAgentService.js';

class FakeExecutor implements ISqlCommandExecutor {
	readonly calls: Array<{ command: SqlCommandName; args?: Record<string, unknown> }> = [];
	responses = new Map<string, unknown>();

	async execute<T>(command: SqlCommandName, args?: Record<string, unknown>): Promise<T> {
		this.calls.push({ command, args });
		return this.responses.get(command) as T;
	}
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(resolvePromise => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

const request = {
	goal: '  generate a query  ',
	task: SqlAgentTaskKind.GenerateQuery,
	mode: SqlAgentMode.SuggestOnly,
	context: { dialect: SqlDialect.Sqlite, schema: [] },
	capabilities: [SqlCapability.AgentTool, SqlCapability.AgentTool]
};

test('normalizeSqlAgentStartRequest trims goal and deduplicates canonical capabilities', () => {
	const normalized = normalizeSqlAgentStartRequest(request);
	assert.equal(normalized.goal, 'generate a query');
	assert.deepEqual(normalized.capabilities, [SqlCapability.AgentTool]);
});

test('normalizeSqlAgentStartRequest preserves and trims structured error context', () => {
	const normalized = normalizeSqlAgentStartRequest({
		...request,
		task: SqlAgentTaskKind.FixError,
		context: {
			dialect: SqlDialect.Sqlite,
			errorMessage: ' legacy ',
			errorContext: { code: ' sqlite_error ', message: ' no such column ', detail: ' detail ' }
		}
	});
	assert.deepEqual(normalized.context.errorContext, {
		code: 'sqlite_error',
		message: 'no such column',
		detail: 'detail'
	});
});

test('normalizeSqlAgentStartRequest preserves the stale-safe editor identity', () => {
	const normalized = normalizeSqlAgentStartRequest({
		...request,
		task: SqlAgentTaskKind.FixError,
		context: {
			dialect: SqlDialect.Sqlite,
			editorId: ' query-7 ',
			editorVersionId: 9,
			sql: ' SELECT amunt FROM orders ',
			errorContext: { message: 'no such column: amunt' }
		}
	});

	assert.equal(normalized.context.editorId, 'query-7');
	assert.equal(normalized.context.editorVersionId, 9);
});

test('normalizeSqlAgentStartRequest rejects an invalid editor version identity', () => {
	assert.throws(
		() =>
			normalizeSqlAgentStartRequest({
				...request,
				context: { dialect: SqlDialect.Sqlite, editorVersionId: 0 }
			}),
		/editor version id/
	);
});

test('normalizeSqlAgentStartRequest reduces Optimize context to its opaque stale-safe allowlist', () => {
	const normalized = normalizeSqlAgentStartRequest({
		...request,
		task: SqlAgentTaskKind.OptimizeQuery,
		mode: SqlAgentMode.ReadOnly,
		context: {
			dialect: SqlDialect.Sqlite,
			connectionId: ' demo-reader ',
			editorId: ' query-7 ',
			editorVersionId: 9,
			sql: ' SELECT * FROM orders ',
			selectedSql: 'SELECT secret FROM credentials',
			errorMessage: 'legacy error',
			errorContext: { message: 'legacy structured error' },
			userPrompt: 'include every row',
			explainPlan: 'legacy frontend plan',
			schema: [{ name: 'credentials', columns: ['secret'] }],
			resultShape: { columns: [{ name: 'secret', ordinal: 0 }], rowCount: 1, elapsedMs: 1, truncated: false }
		}
	});

	assert.deepEqual(normalized.context, {
		dialect: SqlDialect.Sqlite,
		connectionId: 'demo-reader',
		editorId: 'query-7',
		editorVersionId: 9,
		sql: 'SELECT * FROM orders'
	});
});

test('normalizeSqlAgentStartRequest requires a complete Read Only SQLite context for Optimize', () => {
	const optimizeRequest = {
		...request,
		task: SqlAgentTaskKind.OptimizeQuery,
		mode: SqlAgentMode.ReadOnly,
		context: {
			dialect: SqlDialect.Sqlite,
			connectionId: 'demo-reader',
			editorId: 'query-7',
			editorVersionId: 9,
			sql: 'SELECT * FROM orders'
		}
	};

	assert.throws(
		() => normalizeSqlAgentStartRequest({ ...optimizeRequest, mode: SqlAgentMode.SuggestOnly }),
		/Read Only mode/
	);
	assert.throws(
		() =>
			normalizeSqlAgentStartRequest({
				...optimizeRequest,
				context: { ...optimizeRequest.context, dialect: SqlDialect.MySql }
			}),
		/SQLite/
	);
	assert.throws(
		() =>
			normalizeSqlAgentStartRequest({
				...optimizeRequest,
				context: { ...optimizeRequest.context, connectionId: '   ' }
			}),
		/connection id/
	);
	assert.throws(
		() =>
			normalizeSqlAgentStartRequest({
				...optimizeRequest,
				context: { ...optimizeRequest.context, editorId: '   ' }
			}),
		/editor id/
	);
	assert.throws(
		() =>
			normalizeSqlAgentStartRequest({
				...optimizeRequest,
				context: { ...optimizeRequest.context, editorVersionId: undefined }
			}),
		/editor version id/
	);
	assert.throws(
		() =>
			normalizeSqlAgentStartRequest({
				...optimizeRequest,
				context: { ...optimizeRequest.context, sql: '   ' }
			}),
		/SQL/
	);
});

test('normalizeSqlAgentStartRequest rejects malformed task, dialect, and capability', () => {
	assert.throws(() => normalizeSqlAgentStartRequest({ ...request, task: 'unknown' as never }), /task/);
	assert.throws(
		() => normalizeSqlAgentStartRequest({ ...request, context: { dialect: 'unknown' as never } }),
		/dialect/
	);
	assert.throws(
		() => normalizeSqlAgentStartRequest({ ...request, capabilities: ['agent.all'] as never }),
		/Unsupported SQL capability/
	);
});

test('SqlAgentService uses the command executor for start, cancel, and get', async () => {
	const executor = new FakeExecutor();
	const started = {
		run: { runId: 'agent-run-1', revision: 0 },
		result: undefined
	};
	const completed = {
		run: { runId: 'agent-run-1', state: 'completed', revision: 1 },
		result: { queryCallCount: 0 }
	};
	executor.responses.set('sql_agent_start', started);
	executor.responses.set('sql_agent_run', completed);
	executor.responses.set('sql_agent_cancel', completed);
	executor.responses.set('sql_agent_get_run', completed.run);
	const service = new SqlAgentService(executor);

	assert.deepEqual(await service.start(request), completed);
	assert.deepEqual(service.getLastRunEvent(), completed);
	assert.deepEqual(await service.cancel(' agent-run-1 '), completed);
	assert.deepEqual(service.getLastRunEvent(), completed);
	assert.deepEqual(await service.getRun('agent-run-1'), completed.run);
	assert.deepEqual(
		executor.calls.map(call => call.command),
		['sql_agent_start', 'sql_agent_run', 'sql_agent_cancel', 'sql_agent_get_run']
	);
	assert.deepEqual(executor.calls[1].args, { runId: 'agent-run-1' });
	service.dispose();
});

test('SqlAgentService publishes the allocated run before the background loop completes', async () => {
	const executor = new FakeExecutor();
	const started = { run: { runId: 'agent-run-1', state: 'created', revision: 0 } };
	const completed = {
		run: { runId: 'agent-run-1', state: 'completed', revision: 1 },
		result: { queryCallCount: 0 }
	};
	const background = deferred<typeof completed>();
	executor.responses.set('sql_agent_start', started);
	executor.responses.set('sql_agent_run', background.promise);
	const service = new SqlAgentService(executor);
	const events: unknown[] = [];
	service.onDidChangeRun(event => events.push(event));

	const completion = service.start(request);
	await new Promise<void>(resolve => setTimeout(resolve, 0));

	assert.deepEqual(events, [started]);
	assert.deepEqual(
		executor.calls.map(call => call.command),
		['sql_agent_start', 'sql_agent_run']
	);
	background.resolve(completed);
	assert.deepEqual(await completion, completed);
	assert.deepEqual(events, [started, completed]);
	service.dispose();
});

test('SqlAgentService deduplicates matching Rust events and command responses', async () => {
	const previousTauri = (globalThis as { __TAURI__?: unknown }).__TAURI__;
	let emitRunEvent: ((event: unknown) => void) | undefined;
	(globalThis as { __TAURI__?: unknown }).__TAURI__ = {
		event: {
			listen: async (_event: string, handler: (event: { payload: unknown }) => void) => {
				emitRunEvent = payload => handler({ payload });
				return () => undefined;
			}
		}
	};
	const executor = new FakeExecutor();
	const started = { run: { runId: 'agent-run-dedupe', state: 'created', revision: 0 } };
	const completed = {
		run: { runId: 'agent-run-dedupe', state: 'completed', revision: 3 },
		result: { queryCallCount: 0 }
	};
	const stale = { run: { runId: 'agent-run-dedupe', state: 'reasoning', revision: 2 } };
	executor.responses.set('sql_agent_start', started);
	executor.responses.set('sql_agent_run', completed);

	try {
		const service = new SqlAgentService(executor);
		const events: unknown[] = [];
		service.onDidChangeRun(event => events.push(event));
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		emitRunEvent?.(started);

		await service.start(request);
		emitRunEvent?.(completed);
		emitRunEvent?.(stale);

		assert.deepEqual(events, [started, completed]);
		assert.deepEqual(service.getLastRunEvent(), completed);
		service.dispose();
	} finally {
		if (previousTauri === undefined) {
			delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
		} else {
			(globalThis as { __TAURI__?: unknown }).__TAURI__ = previousTauri;
		}
	}
});

test('SqlAgentService validates run id before invoking cancel', async () => {
	const executor = new FakeExecutor();
	const service = new SqlAgentService(executor);
	await assert.rejects(() => service.cancel('   '), /run id/);
	assert.equal(executor.calls.length, 0);
	service.dispose();
});

test('normalizeSqlAgentReadOnlyRequest trims and bounds the SQLite tool request', () => {
	assert.deepEqual(normalizeSqlAgentReadOnlyRequest({ connectionId: ' reader ', sql: ' SELECT 1 ', limit: 5000 }), {
		connectionId: 'reader',
		sql: 'SELECT 1',
		limit: 1000
	});
	assert.throws(() => normalizeSqlAgentReadOnlyRequest({ connectionId: 'reader', sql: ' ' }), /statement/);
	assert.throws(() => normalizeSqlAgentReadOnlyRequest({ connectionId: 'reader', sql: 'SELECT 1', limit: 0 }), /limit/);
});

test('SqlAgentService routes A3 explain and execute through the command executor', async () => {
	const executor = new FakeExecutor();
	const executeResult = { connectionId: 'reader', result: {}, analysis: {} };
	const explainResult = { connectionId: 'reader', plan: {}, analysis: {} };
	executor.responses.set('sql_agent_execute_readonly', executeResult);
	executor.responses.set('sql_agent_explain', explainResult);
	const service = new SqlAgentService(executor);

	assert.deepEqual(await service.executeReadonly({ connectionId: 'reader', sql: 'SELECT 1' }), executeResult);
	assert.deepEqual(await service.explain({ connectionId: 'reader', sql: 'SELECT 1' }), explainResult);
	assert.deepEqual(
		executor.calls.map(call => call.command),
		['sql_agent_execute_readonly', 'sql_agent_explain']
	);
	service.dispose();
});

test('SqlAgentService releases a late Tauri run listener when disposed', async () => {
	const previousTauri = (globalThis as { __TAURI__?: unknown }).__TAURI__;
	let resolveListen: ((unlisten: () => void) => void) | undefined;
	let unlistenCount = 0;
	(globalThis as { __TAURI__?: unknown }).__TAURI__ = {
		event: {
			listen: () =>
				new Promise<() => void>(resolve => {
					resolveListen = resolve;
				})
		}
	};

	try {
		const service = new SqlAgentService(new FakeExecutor());
		service.dispose();
		resolveListen?.(() => {
			unlistenCount += 1;
		});
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		assert.equal(unlistenCount, 1);
	} finally {
		if (previousTauri === undefined) {
			delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
		} else {
			(globalThis as { __TAURI__?: unknown }).__TAURI__ = previousTauri;
		}
	}
});
