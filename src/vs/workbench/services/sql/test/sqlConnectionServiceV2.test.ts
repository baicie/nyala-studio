/*---------------------------------------------------------------------------------------------
 * Nyala Studio - V2 Connection service tests (Phase 01).
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlConnectionServiceV2 } from '../browser/sqlConnectionServiceV2.js';
import { ISqlCommandExecutor } from '../browser/sqlCommandExecutor.js';
import { SqlSslMode } from '../common/sqlTypes.js';

class FakeExecutor implements ISqlCommandExecutor {
	readonly calls: Array<{ command: string; args?: Record<string, unknown>; allowVoid?: boolean }> = [];
	private readonly responses = new Map<string, unknown>();
	private readonly failures = new Map<string, unknown>();

	reply<T>(command: string, value: T): void {
		this.responses.set(command, value);
	}

	failWith(command: string, error: unknown): void {
		this.failures.set(command, error);
	}

	async execute<T>(
		command: string,
		args: Record<string, unknown> = {},
		options: { allowVoid?: boolean } = {}
	): Promise<T> {
		this.calls.push({ command, args, allowVoid: options.allowVoid });
		if (this.failures.has(command)) {
			throw this.failures.get(command);
		}
		const value = this.responses.get(command);
		if (value === undefined && !options.allowVoid) {
			throw new Error(`no fake response for ${command}`);
		}
		return value as T;
	}
}

test('list fetches and stores idle profiles', async () => {
	const executor = new FakeExecutor();
	executor.reply('sql_list_connections_v2', [
		{ id: 'a', label: 'a', driver: 'sqlite', readOnly: false, createdAtMs: 0 },
		{ id: 'b', label: 'b', driver: 'mysql', readOnly: true, host: '127.0.0.1', port: 3306, createdAtMs: 0 }
	]);

	const svc = new SqlConnectionServiceV2(executor);
	const list = await svc.list();
	assert.equal(list.length, 2);
	assert.equal(list[0].status.kind, 'idle');
	assert.equal(list[1].profile.driver, 'mysql');
});

test('list refresh does not emit a connection mutation event', async () => {
	const executor = new FakeExecutor();
	executor.reply('sql_list_connections_v2', []);
	const svc = new SqlConnectionServiceV2(executor);
	let changeCount = 0;
	const subscription = svc.onChange(() => changeCount++);

	await svc.list();

	assert.equal(changeCount, 0);
	subscription.dispose();
});

test('open forwards profile and secret to the backend', async () => {
	const executor = new FakeExecutor();
	executor.reply('sql_open_connection_v2', 'a');
	const svc = new SqlConnectionServiceV2(executor);
	const id = await svc.open(
		{
			id: 'a',
			label: 'a',
			driver: 'mysql',
			readOnly: false,
			host: '127.0.0.1',
			port: 3306,
			database: 'app',
			sslMode: SqlSslMode.Require,
			createdAtMs: 0
		},
		{ password: 'redacted' }
	);
	assert.equal(id, 'a');
	assert.equal(executor.calls[0].command, 'sql_open_connection_v2');
	const payload = executor.calls[0].args as {
		profile: { sslMode?: SqlSslMode };
		secret: { password?: string };
	};
	assert.equal(payload.profile.sslMode, SqlSslMode.Require);
	assert.equal(payload.secret.password, 'redacted');
});

test('close invokes backend with profile id only', async () => {
	const executor = new FakeExecutor();
	executor.reply('sql_close_connection_v2', undefined);
	const svc = new SqlConnectionServiceV2(executor);
	let changeCount = 0;
	const subscription = svc.onChange(() => changeCount++);
	await svc.close('a');
	assert.equal(executor.calls[0].command, 'sql_close_connection_v2');
	assert.equal(executor.calls[0].args?.['profileId'], 'a');
	assert.equal(changeCount, 1);
	subscription.dispose();
});

test('forgetAllSecrets wipes backend memory', async () => {
	const executor = new FakeExecutor();
	executor.reply('sql_forget_secrets', undefined);
	const svc = new SqlConnectionServiceV2(executor);
	await svc.forgetAllSecrets();
	assert.equal(executor.calls[0].command, 'sql_forget_secrets');
});

test('test routes to sql_test_connection_v2 with secret', async () => {
	const executor = new FakeExecutor();
	executor.reply('sql_test_connection_v2', undefined);
	const svc = new SqlConnectionServiceV2(executor);
	await svc.test({ id: 'a', label: 'a', driver: 'sqlite', readOnly: false, createdAtMs: 0 }, { password: 'x' });
	assert.equal(executor.calls[0].command, 'sql_test_connection_v2');
});

test('open throws when backend rejects and surfaces error message', async () => {
	const executor = new FakeExecutor();
	executor.failWith('sql_open_connection_v2', new Error('boom'));
	const svc = new SqlConnectionServiceV2(executor);
	await assert.rejects(
		svc.open({ id: 'a', label: 'a', driver: 'sqlite', readOnly: false, createdAtMs: 0 }, { password: 'x' }),
		/boom/
	);
});
