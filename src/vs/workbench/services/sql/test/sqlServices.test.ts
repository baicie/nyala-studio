import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlConnectionService } from '../browser/sqlConnectionService.js';
import {
	ISqlCommandExecutor,
	SqlCommandName,
	SqlServiceError,
	TauriSqlCommandExecutor
} from '../browser/sqlCommandExecutor.js';
import { SqlMetadataService } from '../browser/sqlMetadataService.js';
import { SqlQueryService } from '../browser/sqlQueryService.js';
import { SqlCellKind, SqlConnectionKind, SqlTableType } from '../common/sqlTypes.js';
import {
	normalizeSqlConnectionInput,
	normalizeSqlExecuteQueryRequest,
	normalizeSqlSaveConnectionRequest,
	SQL_MAX_QUERY_LIMIT
} from '../common/sqlValidation.js';

interface FakeSqlCall {
	command: SqlCommandName;
	args: Record<string, unknown>;
	options?: { allowVoid?: boolean };
}

class FakeSqlCommandExecutor implements ISqlCommandExecutor {
	readonly calls: FakeSqlCall[] = [];
	responses = new Map<SqlCommandName, unknown>();
	errors = new Map<SqlCommandName, unknown>();

	async execute<T>(
		command: SqlCommandName,
		args: Record<string, unknown> = {},
		options?: { allowVoid?: boolean }
	): Promise<T> {
		const call: FakeSqlCall = { command, args };
		if (options !== undefined) {
			call.options = options;
		}
		this.calls.push(call);

		if (this.errors.has(command)) {
			throw this.errors.get(command);
		}

		return this.responses.get(command) as T;
	}

	lastCall(): FakeSqlCall {
		const call = this.calls.at(-1);
		assert.ok(call, 'expected command executor to be called');
		return call;
	}
}

test('normalizeSqlConnectionInput trims fields and applies boolean defaults', () => {
	const input = normalizeSqlConnectionInput({
		id: '  local  ',
		name: '  Local SQLite  ',
		kind: SqlConnectionKind.Sqlite,
		databasePath: '  /tmp/app.db  '
	});

	assert.deepEqual(input, {
		id: 'local',
		name: 'Local SQLite',
		kind: SqlConnectionKind.Sqlite,
		databasePath: '/tmp/app.db',
		readOnly: false,
		createIfMissing: false
	});
});

test('normalizeSqlConnectionInput rejects planned PostgreSQL driver', () => {
	assert.throws(
		() =>
			normalizeSqlConnectionInput({
				kind: SqlConnectionKind.PostgreSql,
				host: 'localhost',
				database: 'app'
			}),
		/PostgreSQL.*planned/
	);
});

test('normalizeSqlConnectionInput rejects planned MySQL driver', () => {
	assert.throws(
		() =>
			normalizeSqlConnectionInput({
				kind: SqlConnectionKind.MySql,
				host: 'localhost',
				database: 'app'
			}),
		/MySQL.*planned/
	);
});

test('normalizeSqlConnectionInput keeps SQLite path flow', () => {
	const result = normalizeSqlConnectionInput({
		kind: SqlConnectionKind.Sqlite,
		databasePath: ' /tmp/app.db ',
		readOnly: true,
		createIfMissing: true
	});

	assert.equal(result.kind, SqlConnectionKind.Sqlite);
	assert.equal(result.databasePath, '/tmp/app.db');
	assert.equal(result.readOnly, true);
	assert.equal(result.createIfMissing, true);
	assert.equal(result.id, undefined);
	assert.equal(result.name, undefined);
});

test('normalizeSqlExecuteQueryRequest trims sql and clamps large limit', () => {
	const request = normalizeSqlExecuteQueryRequest({
		connectionId: '  local  ',
		sql: '  SELECT 1  ',
		limit: SQL_MAX_QUERY_LIMIT + 1
	});

	assert.equal(request.connectionId, 'local');
	assert.equal(request.sql, 'SELECT 1');
	assert.equal(request.limit, SQL_MAX_QUERY_LIMIT);
});

test('normalizeSqlExecuteQueryRequest rejects empty sql', () => {
	assert.throws(
		() =>
			normalizeSqlExecuteQueryRequest({
				connectionId: 'local',
				sql: '   '
			}),
		/sql must not be empty/
	);
});

test('SqlConnectionService.testConnection invokes sql_test_connection with normalized input', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_test_connection', {
		ok: true,
		connection: {
			id: 'local',
			name: 'Local',
			kind: SqlConnectionKind.Sqlite,
			databasePath: '/tmp/app.db',
			readOnly: false
		}
	});

	const service = new SqlConnectionService(executor);

	const result = await service.testConnection({
		id: ' local ',
		name: ' Local ',
		kind: SqlConnectionKind.Sqlite,
		databasePath: ' /tmp/app.db ',
		createIfMissing: true
	});

	assert.equal(result.ok, true);

	assert.deepEqual(executor.lastCall(), {
		command: 'sql_test_connection',
		args: {
			input: {
				id: 'local',
				name: 'Local',
				kind: SqlConnectionKind.Sqlite,
				databasePath: '/tmp/app.db',
				readOnly: false,
				createIfMissing: true
			}
		}
	});
});

test('SqlConnectionService.openConnection invokes sql_open_connection', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_open_connection', {
		id: 'local',
		name: 'Local',
		kind: SqlConnectionKind.Sqlite,
		databasePath: '/tmp/app.db',
		readOnly: false
	});

	const service = new SqlConnectionService(executor);

	const connection = await service.openConnection({
		id: 'local',
		name: 'Local',
		kind: SqlConnectionKind.Sqlite,
		databasePath: '/tmp/app.db'
	});

	assert.equal(connection.id, 'local');
	assert.equal(executor.lastCall().command, 'sql_open_connection');
});

test('SqlConnectionService.closeConnection invokes sql_close_connection with allowVoid option', async () => {
	const executor = new FakeSqlCommandExecutor();
	const service = new SqlConnectionService(executor);

	await service.closeConnection('  local  ');

	assert.deepEqual(executor.lastCall(), {
		command: 'sql_close_connection',
		args: {
			connectionId: 'local'
		},
		options: { allowVoid: true }
	});
});

test('SqlConnectionService.listConnections returns empty array when backend returns non-array', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_list_connections', null);

	const service = new SqlConnectionService(executor);

	assert.deepEqual(await service.listConnections(), []);
});

test('SqlMetadataService.listTables invokes sql_list_tables', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_list_tables', [
		{
			schema: 'main',
			name: 'users',
			tableType: SqlTableType.Table
		}
	]);

	const service = new SqlMetadataService(executor);

	const tables = await service.listTables(' local ');

	assert.equal(tables[0].name, 'users');
	assert.deepEqual(executor.lastCall(), {
		command: 'sql_list_tables',
		args: {
			connectionId: 'local'
		}
	});
});

test('SqlMetadataService.listColumns invokes sql_list_columns with normalized request', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_list_columns', [
		{
			name: 'id',
			ordinal: 0,
			dataType: 'INTEGER',
			notNull: false,
			primaryKey: true
		}
	]);

	const service = new SqlMetadataService(executor);

	const columns = await service.listColumns({
		connectionId: ' local ',
		tableName: ' users ',
		schema: ' main '
	});

	assert.equal(columns[0].name, 'id');

	assert.deepEqual(executor.lastCall(), {
		command: 'sql_list_columns',
		args: {
			request: {
				connectionId: 'local',
				tableName: 'users',
				schema: 'main'
			}
		}
	});
});

test('SqlQueryService.executeQuery invokes sql_execute_query and returns query result', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_execute_query', {
		columns: [{ name: 'value', ordinal: 0 }],
		rows: [[{ kind: SqlCellKind.Integer, value: 1 }]],
		rowCount: 1,
		elapsedMs: 2,
		truncated: false
	});

	const service = new SqlQueryService(executor);

	const result = await service.executeQuery({
		connectionId: ' local ',
		sql: ' SELECT 1 AS value ',
		limit: 10
	});

	assert.equal(result.rowCount, 1);
	assert.equal(result.columns[0].name, 'value');

	assert.deepEqual(executor.lastCall(), {
		command: 'sql_execute_query',
		args: {
			request: {
				connectionId: 'local',
				sql: 'SELECT 1 AS value',
				limit: 10
			}
		}
	});
});

test('SqlQueryService.cancelQuery invokes sql_cancel_query with optional queryId', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_cancel_query', {
		cancelled: true,
		connectionId: 'local',
		queryId: 'q1',
		message: 'interrupt signal sent to SQLite connection'
	});

	const service = new SqlQueryService(executor);

	const result = await service.cancelQuery({
		connectionId: ' local ',
		queryId: ' q1 '
	});

	assert.equal(result.cancelled, true);

	assert.deepEqual(executor.lastCall(), {
		command: 'sql_cancel_query',
		args: {
			request: {
				connectionId: 'local',
				queryId: 'q1'
			}
		}
	});
});

test('SqlQueryService wraps backend errors into SqlServiceError', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.errors.set('sql_execute_query', 'database is locked');

	const service = new SqlQueryService(executor);

	await assert.rejects(
		() =>
			service.executeQuery({
				connectionId: 'local',
				sql: 'SELECT 1'
			}),
		error => {
			assert.ok(error instanceof SqlServiceError);
			assert.equal(error.command, 'sql_execute_query');
			assert.match(error.message, /database is locked/);
			return true;
		}
	);
});

test('TauriSqlCommandExecutor throws SqlServiceError when Tauri runtime is unavailable', async () => {
	const previousWindow = (globalThis as typeof globalThis & { window?: unknown }).window;

	try {
		delete (globalThis as typeof globalThis & { window?: unknown }).window;

		const executor = new TauriSqlCommandExecutor();

		await assert.rejects(
			() => executor.execute('sql_list_connections'),
			error => {
				assert.ok(error instanceof SqlServiceError);
				assert.equal(error.command, 'sql_list_connections');
				assert.match(error.message, /Tauri runtime is not available/);
				return true;
			}
		);
	} finally {
		if (previousWindow !== undefined) {
			(globalThis as typeof globalThis & { window?: unknown }).window = previousWindow;
		}
	}
});

test('TauriSqlCommandExecutor forwards command to window.__TAURI__.core.invoke', async () => {
	const previousWindow = (globalThis as typeof globalThis & { window?: unknown }).window;

	try {
		(globalThis as typeof globalThis & { window?: unknown }).window = {
			__TAURI__: {
				core: {
					invoke: async (cmd: string, args?: Record<string, unknown>) => ({
						cmd,
						args
					})
				}
			}
		};

		const executor = new TauriSqlCommandExecutor();

		const result = await executor.execute<{ cmd: string; args?: Record<string, unknown> }>(
			'sql_execute_query',
			{
				request: {
					connectionId: 'local',
					sql: 'SELECT 1'
				}
			}
		);

		assert.deepEqual(result, {
			cmd: 'sql_execute_query',
			args: {
				request: {
					connectionId: 'local',
					sql: 'SELECT 1'
				}
			}
		});
	} finally {
		if (previousWindow === undefined) {
			delete (globalThis as typeof globalThis & { window?: unknown }).window;
		} else {
			(globalThis as typeof globalThis & { window?: unknown }).window = previousWindow;
		}
	}
});

test('TauriSqlCommandExecutor allowVoid does not throw when backend returns null', async () => {
	const previousWindow = (globalThis as typeof globalThis & { window?: unknown }).window;

	try {
		(globalThis as typeof globalThis & { window?: unknown }).window = {
			__TAURI__: {
				core: {
					invoke: async () => null
				}
			}
		};

		const executor = new TauriSqlCommandExecutor();

		await executor.execute<void>(
			'sql_close_connection',
			{ connectionId: 'local' },
			{ allowVoid: true }
		);
	} finally {
		if (previousWindow === undefined) {
			delete (globalThis as typeof globalThis & { window?: unknown }).window;
		} else {
			(globalThis as typeof globalThis & { window?: unknown }).window = previousWindow;
		}
	}
});

test('SqlConnectionService.saveConnection invokes sql_save_connection with normalized request', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_save_connection', {
		id: 'local',
		name: 'Local SQLite',
		kind: SqlConnectionKind.Sqlite,
		databasePath: '/tmp/app.db',
		readOnly: false,
		createIfMissing: true,
		autoConnect: true
	});

	const service = new SqlConnectionService(executor);

	const saved = await service.saveConnection({
		input: {
			id: ' local ',
			name: ' Local SQLite ',
			kind: SqlConnectionKind.Sqlite,
			databasePath: ' /tmp/app.db ',
			createIfMissing: true
		},
		autoConnect: true,
		openNow: true
	});

	assert.equal(saved.id, 'local');

	assert.deepEqual(executor.lastCall(), {
		command: 'sql_save_connection',
		args: {
			request: {
				input: {
					id: 'local',
					name: 'Local SQLite',
					kind: SqlConnectionKind.Sqlite,
					databasePath: '/tmp/app.db',
					readOnly: false,
					createIfMissing: true
				},
				autoConnect: true,
				openNow: true
			}
		}
	});
});

test('SqlConnectionService.listSavedConnections returns empty array for non-array backend value', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_list_saved_connections', null);

	const service = new SqlConnectionService(executor);

	assert.deepEqual(await service.listSavedConnections(), []);
});

test('SqlConnectionService.removeSavedConnection invokes sql_remove_saved_connection with allowVoid option', async () => {
	const executor = new FakeSqlCommandExecutor();
	const service = new SqlConnectionService(executor);

	await service.removeSavedConnection({
		connectionId: ' local ',
		closeIfOpen: true
	});

	assert.deepEqual(executor.lastCall(), {
		command: 'sql_remove_saved_connection',
		args: {
			request: {
				connectionId: 'local',
				closeIfOpen: true
			}
		},
		options: { allowVoid: true }
	});
});

test('SqlConnectionService.restoreSavedConnections invokes sql_restore_saved_connections', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_restore_saved_connections', {
		opened: [],
		errors: []
	});

	const service = new SqlConnectionService(executor);
	const result = await service.restoreSavedConnections();

	assert.deepEqual(result, {
		opened: [],
		errors: []
	});

	assert.deepEqual(executor.lastCall(), {
		command: 'sql_restore_saved_connections',
		args: {}
	});
});

test('normalizeSqlSaveConnectionRequest rejects in-memory SQLite connection', () => {
	assert.throws(
		() =>
			normalizeSqlSaveConnectionRequest({
				input: {
					id: 'memory',
					name: 'Memory',
					kind: SqlConnectionKind.Sqlite,
					databasePath: ':memory:',
					createIfMissing: true
				},
				autoConnect: true,
				openNow: true
			}),
		/in-memory SQLite connections cannot be saved/
	);
});
