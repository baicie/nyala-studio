import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlDriverCatalogService } from '../browser/sqlDriverCatalogService.js';
import { ISqlCommandExecutor, SqlServiceError, TauriSqlCommandExecutor } from '../browser/sqlCommandExecutor.js';
import { SqlRuntimeDriverId, SqlRuntimeStatus } from '../common/sqlDriverCatalog.js';

class FakeSqlCommandExecutor implements ISqlCommandExecutor {
	readonly calls = [];
	responses = new Map();
	errors = new Map();
	allowVoid = true;

	async execute(command, args = {}, options) {
		this.calls.push({ command, args, options });

		if (this.errors.has(command)) {
			throw this.errors.get(command);
		}

		return this.responses.get(command);
	}
}

test('SqlDriverCatalogService maps raw payload to typed entries', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_list_driver_runtime_status', [
		{
			id: 'sqlite',
			displayName: 'SQLite',
			status: 'stable',
			summary: 'File / in-memory database for MVP stable usage.',
			notes: ['supports file path']
		},
		{
			id: 'mysql',
			displayName: 'MySQL',
			status: 'preview',
			summary: 'Local/dev validation only.',
			notes: ['connection enabled', 'cancellation not yet']
		},
		{
			id: 'postgres',
			displayName: 'PostgreSQL',
			status: 'planned',
			summary: 'Protocol fields exist.',
			notes: ['do not show as available']
		}
	]);

	const service = new SqlDriverCatalogService(executor);
	const entries = await service.getRuntimeStatus();

	assert.equal(entries.length, 3);
	assert.equal(entries[0].id, SqlRuntimeDriverId.Sqlite);
	assert.equal(entries[0].status, SqlRuntimeStatus.Stable);
	assert.equal(entries[1].id, SqlRuntimeDriverId.MySql);
	assert.equal(entries[1].status, SqlRuntimeStatus.Preview);
	assert.equal(entries[2].id, SqlRuntimeDriverId.Postgres);
	assert.equal(entries[2].status, SqlRuntimeStatus.Planned);

	// ensure read-only contract
	assert.ok(Object.isFrozen(entries[0].notes));
});

test('SqlDriverCatalogService caches the snapshot for subsequent reads', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_list_driver_runtime_status', [
		{
			id: 'sqlite',
			displayName: 'SQLite',
			status: 'stable',
			summary: 's',
			notes: []
		}
	]);

	const service = new SqlDriverCatalogService(executor);

	const first = await service.getRuntimeStatus();
	const second = await service.getRuntimeStatus();

	assert.equal(first, second);
	assert.equal(executor.calls.length, 1);
});

test('SqlDriverCatalogService refreshes a cached snapshot from the backend', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_list_driver_runtime_status', [
		{ id: 'mysql', displayName: 'MySQL', status: 'preview', summary: 'before', notes: [] }
	]);
	const service = new SqlDriverCatalogService(executor);
	let changeCount = 0;
	const subscription = service.onChange(() => changeCount++);

	const first = await service.getRuntimeStatus();
	executor.responses.set('sql_list_driver_runtime_status', [
		{ id: 'mysql', displayName: 'MySQL', status: 'disabled', summary: 'after', notes: [] }
	]);

	const cached = await service.getRuntimeStatus();
	const firstRefresh = service.refreshRuntimeStatus();
	const concurrentRefresh = service.refreshRuntimeStatus();
	const refreshed = await firstRefresh;

	assert.equal(cached, first);
	assert.equal(firstRefresh, concurrentRefresh);
	assert.notEqual(refreshed, first);
	assert.equal(refreshed[0].status, SqlRuntimeStatus.Disabled);
	assert.equal(refreshed[0].summary, 'after');
	assert.equal(service.getCachedRuntimeStatus(), refreshed);
	assert.equal(await service.getRuntimeStatus(), refreshed);
	assert.equal(executor.calls.length, 2);
	assert.equal(changeCount, 2);

	subscription.dispose();
	service.dispose();
});

test('SqlDriverCatalogService returns offline fallback when tauri backend is unavailable', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.errors.set(
		'sql_list_driver_runtime_status',
		new SqlServiceError('Tauri runtime is not available', 'sql_list_driver_runtime_status')
	);

	const service = new SqlDriverCatalogService(executor);

	const entries = await service.getRuntimeStatus();

	assert.equal(entries.length, 3);
	assert.equal(entries[0].id, SqlRuntimeDriverId.Sqlite);
	assert.equal(entries[0].status, SqlRuntimeStatus.Stable);
	assert.equal(entries[1].id, SqlRuntimeDriverId.MySql);
	assert.equal(entries[1].status, SqlRuntimeStatus.Preview);
	assert.equal(entries[2].id, SqlRuntimeDriverId.Postgres);
	assert.equal(entries[2].status, SqlRuntimeStatus.Planned);
});

test('SqlDriverCatalogService throws when getCachedRuntimeStatus is called before init', () => {
	const executor = new FakeSqlCommandExecutor();
	const service = new SqlDriverCatalogService(executor);

	assert.throws(() => service.getCachedRuntimeStatus(), /not been initialised/);
});

test('SqlDriverCatalogService.isDriverRunnable only allows Stable and Preview', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_list_driver_runtime_status', [
		{ id: 'sqlite', displayName: 'SQLite', status: 'stable', summary: 's', notes: [] },
		{ id: 'mysql', displayName: 'MySQL', status: 'preview', summary: 'p', notes: [] },
		{ id: 'postgres', displayName: 'PostgreSQL', status: 'planned', summary: 'p', notes: [] }
	]);

	const service = new SqlDriverCatalogService(executor);
	await service.getRuntimeStatus();

	assert.equal(service.isDriverRunnable(SqlRuntimeDriverId.Sqlite), true);
	assert.equal(service.isDriverRunnable(SqlRuntimeDriverId.MySql), true);
	assert.equal(service.isDriverRunnable(SqlRuntimeDriverId.Postgres), false);
});

test('SqlDriverCatalogService.findRuntimeStatus returns the matching entry', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_list_driver_runtime_status', [
		{ id: 'sqlite', displayName: 'SQLite', status: 'stable', summary: 's', notes: [] },
		{ id: 'mysql', displayName: 'MySQL', status: 'preview', summary: 'p', notes: [] }
	]);

	const service = new SqlDriverCatalogService(executor);
	await service.getRuntimeStatus();

	assert.equal(service.findRuntimeStatus(SqlRuntimeDriverId.MySql).summary, 'p');
	assert.equal(service.findRuntimeStatus(SqlRuntimeDriverId.Postgres), undefined);
});

test('SqlDriverCatalogService rejects unknown driver ids from the backend', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_list_driver_runtime_status', [
		{ id: 'oracle', displayName: 'Oracle', status: 'stable', summary: 'o', notes: [] }
	]);

	const service = new SqlDriverCatalogService(executor);

	await assert.rejects(() => service.getRuntimeStatus(), /Unknown driver id/);
});

test('SqlDriverCatalogService rejects unknown statuses from the backend', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_list_driver_runtime_status', [
		{ id: 'sqlite', displayName: 'SQLite', status: 'beta', summary: 's', notes: [] }
	]);

	const service = new SqlDriverCatalogService(executor);

	await assert.rejects(() => service.getRuntimeStatus(), /Unknown status/);
});

test('SqlDriverCatalogService normalises postgresql alias to postgres', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_list_driver_runtime_status', [
		{ id: 'postgresql', displayName: 'PostgreSQL', status: 'planned', summary: 'p', notes: [] }
	]);

	const service = new SqlDriverCatalogService(executor);
	const entries = await service.getRuntimeStatus();

	assert.equal(entries[0].id, SqlRuntimeDriverId.Postgres);
});

test('SqlDriverCatalogService.assertAtLeast enforces the complete runtime maturity matrix', async () => {
	const expectations: Record<SqlRuntimeStatus, Record<SqlRuntimeStatus, boolean>> = {
		[SqlRuntimeStatus.Stable]: {
			[SqlRuntimeStatus.Stable]: true,
			[SqlRuntimeStatus.Preview]: true,
			[SqlRuntimeStatus.Planned]: true,
			[SqlRuntimeStatus.Disabled]: true
		},
		[SqlRuntimeStatus.Preview]: {
			[SqlRuntimeStatus.Stable]: false,
			[SqlRuntimeStatus.Preview]: true,
			[SqlRuntimeStatus.Planned]: true,
			[SqlRuntimeStatus.Disabled]: true
		},
		[SqlRuntimeStatus.Planned]: {
			[SqlRuntimeStatus.Stable]: false,
			[SqlRuntimeStatus.Preview]: false,
			[SqlRuntimeStatus.Planned]: true,
			[SqlRuntimeStatus.Disabled]: true
		},
		[SqlRuntimeStatus.Disabled]: {
			[SqlRuntimeStatus.Stable]: false,
			[SqlRuntimeStatus.Preview]: false,
			[SqlRuntimeStatus.Planned]: false,
			[SqlRuntimeStatus.Disabled]: false
		}
	};
	const statuses: readonly SqlRuntimeStatus[] = [
		SqlRuntimeStatus.Stable,
		SqlRuntimeStatus.Preview,
		SqlRuntimeStatus.Planned,
		SqlRuntimeStatus.Disabled
	];

	for (const current of statuses) {
		const executor = new FakeSqlCommandExecutor();
		executor.responses.set('sql_list_driver_runtime_status', [
			{ id: 'sqlite', displayName: 'SQLite', status: current, summary: 's', notes: [] }
		]);
		const service = new SqlDriverCatalogService(executor);
		await service.getRuntimeStatus();

		for (const minimum of statuses) {
			const shouldPass = expectations[current][minimum];
			const assertStatus = () => service.assertAtLeast(SqlRuntimeDriverId.Sqlite, minimum);

			if (shouldPass) {
				assert.doesNotThrow(assertStatus, `current=${current}, minimum=${minimum}`);
			} else {
				assert.throws(assertStatus, undefined, `current=${current}, minimum=${minimum}`);
			}
		}

		service.dispose();
	}
});

test('SqlDriverCatalogService disposes change listeners with the service', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_list_driver_runtime_status', [
		{ id: 'sqlite', displayName: 'SQLite', status: 'stable', summary: 's', notes: [] }
	]);
	const service = new SqlDriverCatalogService(executor);
	let changeCount = 0;
	const subscription = service.onChange(() => changeCount++);

	assert.equal(typeof service.dispose, 'function');
	assert.equal(typeof subscription.dispose, 'function');
	service.dispose();
	await service.getRuntimeStatus();

	assert.equal(changeCount, 0);
	subscription.dispose();
});

test('TauriSqlCommandExecutor handles sql_list_driver_runtime_status and sql_assert_driver_runtime_status', async () => {
	const previousWindow = globalThis.window;
	try {
		const calls = [];
		globalThis.window = {
			__TAURI__: {
				core: {
					invoke: async (cmd, args) => {
						calls.push({ cmd, args });
						if (cmd === 'sql_list_driver_runtime_status') {
							return [];
						}
						return undefined;
					}
				}
			}
		};

		const executor = new TauriSqlCommandExecutor();

		const result = await executor.execute('sql_list_driver_runtime_status', {}, { allowVoid: true });
		assert.deepEqual(result, []);

		await executor.execute(
			'sql_assert_driver_runtime_status',
			{ driverId: 'sqlite', minimum: 'stable' },
			{ allowVoid: true }
		);
		assert.equal(calls.length, 2);
		assert.equal(calls[1].cmd, 'sql_assert_driver_runtime_status');
	} finally {
		if (previousWindow === undefined) {
			delete globalThis.window;
		} else {
			globalThis.window = previousWindow;
		}
	}
});
