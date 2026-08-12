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
	const event = {
		run: { runId: 'agent-run-1' },
		result: { queryCallCount: 0 }
	};
	executor.responses.set('sql_agent_start', event);
	executor.responses.set('sql_agent_cancel', event);
	executor.responses.set('sql_agent_get_run', event.run);
	const service = new SqlAgentService(executor);

	assert.deepEqual(await service.start(request), event);
	assert.deepEqual(service.getLastRunEvent(), event);
	assert.deepEqual(await service.cancel(' agent-run-1 '), event);
	assert.deepEqual(service.getLastRunEvent(), event);
	assert.deepEqual(await service.getRun('agent-run-1'), event.run);
	assert.deepEqual(
		executor.calls.map(call => call.command),
		['sql_agent_start', 'sql_agent_cancel', 'sql_agent_get_run']
	);
	service.dispose();
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
