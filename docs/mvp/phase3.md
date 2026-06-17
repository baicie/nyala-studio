# Phase 3：Workbench 前端 SQL Service Bridge

当前仓库适合直接按 VS Code/SideX 的服务模型接入。`workbench.common.main.ts` 已经通过 `registerSingleton(..., InstantiationType.Delayed)` 注册 Workbench 服务，且 `sidex-bridge.ts` 已有统一的 Tauri `invoke()` 封装，所以 Phase 3 不需要新增架构机制，只需要新增 SQL Service 并注册到 Workbench DI。

本阶段只做：

```txt
Rust Phase 2 SQL commands
  ↓
Tauri invoke bridge
  ↓
ISqlConnectionService
ISqlMetadataService
ISqlQueryService
  ↓
后续 SQL Connections View / SQL Editor / Result Panel 使用
```

不做：

```txt
- Activity Bar
- Connection Tree UI
- SQL EditorInput
- Result Panel
- MySQL/Postgres
- AI Agent
```

---

## 目标文件

新增：

```txt
src/vs/workbench/services/sql/common/sqlTypes.ts
src/vs/workbench/services/sql/common/sqlConnection.ts
src/vs/workbench/services/sql/common/sqlMetadata.ts
src/vs/workbench/services/sql/common/sqlQuery.ts
src/vs/workbench/services/sql/common/sqlValidation.ts

src/vs/workbench/services/sql/browser/sqlCommandExecutor.ts
src/vs/workbench/services/sql/browser/sqlConnectionService.ts
src/vs/workbench/services/sql/browser/sqlMetadataService.ts
src/vs/workbench/services/sql/browser/sqlQueryService.ts
src/vs/workbench/services/sql/browser/sqlService.contribution.ts

src/vs/workbench/services/sql/test/sqlServices.test.ts
```

修改：

```txt
src/vs/workbench/workbench.common.main.ts
package.json
```

---

# 1. `src/vs/workbench/services/sql/common/sqlTypes.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL service protocol types.
 *--------------------------------------------------------------------------------------------*/

export const enum SqlConnectionKind {
	Sqlite = 'sqlite'
}

export interface SqlConnectionInput {
	id?: string;
	name?: string;
	kind: SqlConnectionKind;
	databasePath: string;
	readOnly?: boolean;
	createIfMissing?: boolean;
}

export interface SqlConnection {
	id: string;
	name: string;
	kind: SqlConnectionKind;
	databasePath: string;
	readOnly: boolean;
}

export interface SqlConnectionTestResult {
	ok: boolean;
	connection?: SqlConnection;
	error?: string;
}

export const enum SqlTableType {
	Table = 'table',
	View = 'view'
}

export interface SqlTable {
	schema?: string;
	name: string;
	tableType: SqlTableType;
}

export interface SqlListColumnsRequest {
	connectionId: string;
	tableName: string;
	schema?: string;
}

export interface SqlColumn {
	name: string;
	ordinal: number;
	dataType?: string;
	notNull: boolean;
	primaryKey: boolean;
	defaultValue?: string;
}

export interface SqlExecuteQueryRequest {
	connectionId: string;
	sql: string;
	limit?: number;
}

export interface SqlCancelQueryRequest {
	connectionId: string;
	queryId?: string;
}

export interface SqlCancelQueryResult {
	cancelled: boolean;
	connectionId: string;
	queryId?: string;
	message: string;
}

export const enum SqlCellKind {
	Null = 'null',
	Integer = 'integer',
	Real = 'real',
	Text = 'text',
	Blob = 'blob'
}

export type SqlCellJsonValue =
	| null
	| boolean
	| number
	| string
	| {
			encoding: 'base64';
			data: string;
			byteLength: number;
	  };

export interface SqlCellValue {
	kind: SqlCellKind;
	value?: SqlCellJsonValue;
}

export interface SqlResultColumn {
	name: string;
	ordinal: number;
}

export interface SqlQueryResult {
	columns: SqlResultColumn[];
	rows: SqlCellValue[][];
	affectedRows?: number;
	rowCount: number;
	elapsedMs: number;
	truncated: boolean;
}
```

---

# 2. `src/vs/workbench/services/sql/common/sqlConnection.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL connection service contract.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SqlConnection, SqlConnectionInput, SqlConnectionTestResult } from './sqlTypes.js';

export const ISqlConnectionService = createDecorator<ISqlConnectionService>('sqlConnectionService');

export interface ISqlConnectionService {
	readonly _serviceBrand: undefined;

	testConnection(input: SqlConnectionInput): Promise<SqlConnectionTestResult>;

	openConnection(input: SqlConnectionInput): Promise<SqlConnection>;

	closeConnection(connectionId: string): Promise<void>;

	listConnections(): Promise<SqlConnection[]>;
}
```

---

# 3. `src/vs/workbench/services/sql/common/sqlMetadata.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL metadata service contract.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SqlColumn, SqlListColumnsRequest, SqlTable } from './sqlTypes.js';

export const ISqlMetadataService = createDecorator<ISqlMetadataService>('sqlMetadataService');

export interface ISqlMetadataService {
	readonly _serviceBrand: undefined;

	listTables(connectionId: string): Promise<SqlTable[]>;

	listColumns(request: SqlListColumnsRequest): Promise<SqlColumn[]>;
}
```

---

# 4. `src/vs/workbench/services/sql/common/sqlQuery.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL query service contract.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SqlCancelQueryRequest, SqlCancelQueryResult, SqlExecuteQueryRequest, SqlQueryResult } from './sqlTypes.js';

export const ISqlQueryService = createDecorator<ISqlQueryService>('sqlQueryService');

export interface ISqlQueryService {
	readonly _serviceBrand: undefined;

	executeQuery(request: SqlExecuteQueryRequest): Promise<SqlQueryResult>;

	cancelQuery(request: SqlCancelQueryRequest): Promise<SqlCancelQueryResult>;
}
```

---

# 5. `src/vs/workbench/services/sql/common/sqlValidation.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL service input validation helpers.
 *--------------------------------------------------------------------------------------------*/

import {
	SqlCancelQueryRequest,
	SqlConnectionInput,
	SqlConnectionKind,
	SqlExecuteQueryRequest,
	SqlListColumnsRequest
} from './sqlTypes.js';

export const SQL_DEFAULT_QUERY_LIMIT = 1_000;
export const SQL_MAX_QUERY_LIMIT = 100_000;
export const SQL_MAX_SQL_BYTES = 1_048_576;

export function assertNonEmptyString(value: unknown, fieldName: string): string {
	if (typeof value !== 'string') {
		throw new Error(`${fieldName} must be a string`);
	}

	const trimmed = value.trim();

	if (!trimmed) {
		throw new Error(`${fieldName} must not be empty`);
	}

	return trimmed;
}

export function normalizeSqlConnectionInput(input: SqlConnectionInput): SqlConnectionInput {
	if (!input || typeof input !== 'object') {
		throw new Error('connection input must be an object');
	}

	if (input.kind !== SqlConnectionKind.Sqlite) {
		throw new Error('only sqlite connections are supported in phase 3');
	}

	const databasePath = assertNonEmptyString(input.databasePath, 'databasePath');

	const normalized: SqlConnectionInput = {
		kind: SqlConnectionKind.Sqlite,
		databasePath,
		readOnly: input.readOnly === true,
		createIfMissing: input.createIfMissing === true
	};

	const id = typeof input.id === 'string' ? input.id.trim() : '';
	if (id) {
		normalized.id = id;
	}

	const name = typeof input.name === 'string' ? input.name.trim() : '';
	if (name) {
		normalized.name = name;
	}

	return normalized;
}

export function normalizeConnectionId(connectionId: unknown): string {
	return assertNonEmptyString(connectionId, 'connectionId');
}

export function normalizeSqlListColumnsRequest(request: SqlListColumnsRequest): SqlListColumnsRequest {
	if (!request || typeof request !== 'object') {
		throw new Error('list columns request must be an object');
	}

	const normalized: SqlListColumnsRequest = {
		connectionId: normalizeConnectionId(request.connectionId),
		tableName: assertNonEmptyString(request.tableName, 'tableName')
	};

	const schema = typeof request.schema === 'string' ? request.schema.trim() : '';
	if (schema) {
		normalized.schema = schema;
	}

	return normalized;
}

export function normalizeSqlExecuteQueryRequest(request: SqlExecuteQueryRequest): SqlExecuteQueryRequest {
	if (!request || typeof request !== 'object') {
		throw new Error('execute query request must be an object');
	}

	const sql = assertNonEmptyString(request.sql, 'sql');

	if (new TextEncoder().encode(sql).byteLength > SQL_MAX_SQL_BYTES) {
		throw new Error(`sql length exceeds maximum of ${SQL_MAX_SQL_BYTES} bytes`);
	}

	const normalized: SqlExecuteQueryRequest = {
		connectionId: normalizeConnectionId(request.connectionId),
		sql
	};

	if (request.limit !== undefined) {
		if (!Number.isInteger(request.limit) || request.limit <= 0) {
			throw new Error('limit must be a positive integer');
		}

		normalized.limit = Math.min(request.limit, SQL_MAX_QUERY_LIMIT);
	}

	return normalized;
}

export function normalizeSqlCancelQueryRequest(request: SqlCancelQueryRequest): SqlCancelQueryRequest {
	if (!request || typeof request !== 'object') {
		throw new Error('cancel query request must be an object');
	}

	const normalized: SqlCancelQueryRequest = {
		connectionId: normalizeConnectionId(request.connectionId)
	};

	const queryId = typeof request.queryId === 'string' ? request.queryId.trim() : '';
	if (queryId) {
		normalized.queryId = queryId;
	}

	return normalized;
}
```

---

# 6. `src/vs/workbench/services/sql/browser/sqlCommandExecutor.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Tauri command executor.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '../../../../sidex-bridge.js';

export type SqlCommandName =
	| 'sql_test_connection'
	| 'sql_open_connection'
	| 'sql_close_connection'
	| 'sql_list_connections'
	| 'sql_list_tables'
	| 'sql_list_columns'
	| 'sql_execute_query'
	| 'sql_cancel_query';

export interface ISqlCommandExecutor {
	execute<T>(command: SqlCommandName, args?: Record<string, unknown>): Promise<T>;
}

export class SqlServiceError extends Error {
	constructor(
		message: string,
		readonly command: SqlCommandName,
		readonly cause?: unknown
	) {
		super(message);
		this.name = 'SqlServiceError';
	}
}

export class TauriSqlCommandExecutor implements ISqlCommandExecutor {
	async execute<T>(command: SqlCommandName, args: Record<string, unknown> = {}): Promise<T> {
		try {
			return await invoke<T>(command, args);
		} catch (error) {
			throw toSqlServiceError(command, error);
		}
	}
}

export function toSqlServiceError(command: SqlCommandName, error: unknown): SqlServiceError {
	if (error instanceof SqlServiceError) {
		return error;
	}

	if (error instanceof Error) {
		return new SqlServiceError(error.message, command, error);
	}

	if (typeof error === 'string') {
		return new SqlServiceError(error, command, error);
	}

	try {
		return new SqlServiceError(JSON.stringify(error), command, error);
	} catch {
		return new SqlServiceError(String(error), command, error);
	}
}
```

---

# 7. `src/vs/workbench/services/sql/browser/sqlConnectionService.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL connection service implementation.
 *--------------------------------------------------------------------------------------------*/

import { ISqlConnectionService } from '../common/sqlConnection.js';
import { SqlConnection, SqlConnectionInput, SqlConnectionTestResult } from '../common/sqlTypes.js';
import { normalizeConnectionId, normalizeSqlConnectionInput } from '../common/sqlValidation.js';
import { ISqlCommandExecutor, TauriSqlCommandExecutor, toSqlServiceError } from './sqlCommandExecutor.js';

export class SqlConnectionService implements ISqlConnectionService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly executor: ISqlCommandExecutor = new TauriSqlCommandExecutor()) {}

	async testConnection(input: SqlConnectionInput): Promise<SqlConnectionTestResult> {
		const normalized = normalizeSqlConnectionInput(input);

		try {
			return await this.executor.execute<SqlConnectionTestResult>('sql_test_connection', {
				input: normalized
			});
		} catch (error) {
			throw toSqlServiceError('sql_test_connection', error);
		}
	}

	async openConnection(input: SqlConnectionInput): Promise<SqlConnection> {
		const normalized = normalizeSqlConnectionInput(input);

		try {
			return await this.executor.execute<SqlConnection>('sql_open_connection', {
				input: normalized
			});
		} catch (error) {
			throw toSqlServiceError('sql_open_connection', error);
		}
	}

	async closeConnection(connectionId: string): Promise<void> {
		const normalizedConnectionId = normalizeConnectionId(connectionId);

		try {
			await this.executor.execute<void>('sql_close_connection', {
				connectionId: normalizedConnectionId
			});
		} catch (error) {
			throw toSqlServiceError('sql_close_connection', error);
		}
	}

	async listConnections(): Promise<SqlConnection[]> {
		try {
			const connections = await this.executor.execute<SqlConnection[]>('sql_list_connections');
			return Array.isArray(connections) ? connections : [];
		} catch (error) {
			throw toSqlServiceError('sql_list_connections', error);
		}
	}
}
```

---

# 8. `src/vs/workbench/services/sql/browser/sqlMetadataService.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL metadata service implementation.
 *--------------------------------------------------------------------------------------------*/

import { ISqlMetadataService } from '../common/sqlMetadata.js';
import { SqlColumn, SqlListColumnsRequest, SqlTable } from '../common/sqlTypes.js';
import { normalizeConnectionId, normalizeSqlListColumnsRequest } from '../common/sqlValidation.js';
import { ISqlCommandExecutor, TauriSqlCommandExecutor, toSqlServiceError } from './sqlCommandExecutor.js';

export class SqlMetadataService implements ISqlMetadataService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly executor: ISqlCommandExecutor = new TauriSqlCommandExecutor()) {}

	async listTables(connectionId: string): Promise<SqlTable[]> {
		const normalizedConnectionId = normalizeConnectionId(connectionId);

		try {
			const tables = await this.executor.execute<SqlTable[]>('sql_list_tables', {
				connectionId: normalizedConnectionId
			});

			return Array.isArray(tables) ? tables : [];
		} catch (error) {
			throw toSqlServiceError('sql_list_tables', error);
		}
	}

	async listColumns(request: SqlListColumnsRequest): Promise<SqlColumn[]> {
		const normalized = normalizeSqlListColumnsRequest(request);

		try {
			const columns = await this.executor.execute<SqlColumn[]>('sql_list_columns', {
				request: normalized
			});

			return Array.isArray(columns) ? columns : [];
		} catch (error) {
			throw toSqlServiceError('sql_list_columns', error);
		}
	}
}
```

---

# 9. `src/vs/workbench/services/sql/browser/sqlQueryService.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL query service implementation.
 *--------------------------------------------------------------------------------------------*/

import { ISqlQueryService } from '../common/sqlQuery.js';
import {
	SqlCancelQueryRequest,
	SqlCancelQueryResult,
	SqlExecuteQueryRequest,
	SqlQueryResult
} from '../common/sqlTypes.js';
import { normalizeSqlCancelQueryRequest, normalizeSqlExecuteQueryRequest } from '../common/sqlValidation.js';
import { ISqlCommandExecutor, TauriSqlCommandExecutor, toSqlServiceError } from './sqlCommandExecutor.js';

export class SqlQueryService implements ISqlQueryService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly executor: ISqlCommandExecutor = new TauriSqlCommandExecutor()) {}

	async executeQuery(request: SqlExecuteQueryRequest): Promise<SqlQueryResult> {
		const normalized = normalizeSqlExecuteQueryRequest(request);

		try {
			return await this.executor.execute<SqlQueryResult>('sql_execute_query', {
				request: normalized
			});
		} catch (error) {
			throw toSqlServiceError('sql_execute_query', error);
		}
	}

	async cancelQuery(request: SqlCancelQueryRequest): Promise<SqlCancelQueryResult> {
		const normalized = normalizeSqlCancelQueryRequest(request);

		try {
			return await this.executor.execute<SqlCancelQueryResult>('sql_cancel_query', {
				request: normalized
			});
		} catch (error) {
			throw toSqlServiceError('sql_cancel_query', error);
		}
	}
}
```

---

# 10. `src/vs/workbench/services/sql/browser/sqlService.contribution.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL service registrations.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISqlConnectionService } from '../common/sqlConnection.js';
import { ISqlMetadataService } from '../common/sqlMetadata.js';
import { ISqlQueryService } from '../common/sqlQuery.js';
import { SqlConnectionService } from './sqlConnectionService.js';
import { SqlMetadataService } from './sqlMetadataService.js';
import { SqlQueryService } from './sqlQueryService.js';

registerSingleton(ISqlConnectionService, SqlConnectionService, InstantiationType.Delayed);
registerSingleton(ISqlMetadataService, SqlMetadataService, InstantiationType.Delayed);
registerSingleton(ISqlQueryService, SqlQueryService, InstantiationType.Delayed);
```

---

# 11. 修改 `src/vs/workbench/workbench.common.main.ts`

在 Workbench services import 区域追加一行。建议放在 `defaultLogLevels.js` 后面：

```ts
import './services/log/common/defaultLogLevels.js';
import './services/sql/browser/sqlService.contribution.js';
```

当前该文件已经集中加载 Workbench services 和 contributions，所以这个 import 会在 Workbench 启动时完成 SQL 服务注册。

---

# 12. 单元测试：`src/vs/workbench/services/sql/test/sqlServices.test.ts`

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlConnectionService } from '../browser/sqlConnectionService.js';
import { ISqlCommandExecutor, SqlCommandName, SqlServiceError } from '../browser/sqlCommandExecutor.js';
import { SqlMetadataService } from '../browser/sqlMetadataService.js';
import { SqlQueryService } from '../browser/sqlQueryService.js';
import { SqlCellKind, SqlConnectionKind, SqlTableType } from '../common/sqlTypes.js';
import {
	normalizeSqlConnectionInput,
	normalizeSqlExecuteQueryRequest,
	SQL_MAX_QUERY_LIMIT
} from '../common/sqlValidation.js';

class FakeSqlCommandExecutor implements ISqlCommandExecutor {
	readonly calls: Array<{ command: SqlCommandName; args: Record<string, unknown> }> = [];
	responses = new Map<SqlCommandName, unknown>();
	errors = new Map<SqlCommandName, unknown>();

	async execute<T>(command: SqlCommandName, args: Record<string, unknown> = {}): Promise<T> {
		this.calls.push({ command, args });

		if (this.errors.has(command)) {
			throw this.errors.get(command);
		}

		return this.responses.get(command) as T;
	}

	lastCall(): { command: SqlCommandName; args: Record<string, unknown> } {
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

test('normalizeSqlConnectionInput rejects unsupported connection kind', () => {
	assert.throws(
		() =>
			normalizeSqlConnectionInput({
				kind: 'postgres' as SqlConnectionKind,
				databasePath: '/tmp/app.db'
			}),
		/only sqlite connections are supported/
	);
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

test('SqlConnectionService.closeConnection invokes sql_close_connection with camelCase args', async () => {
	const executor = new FakeSqlCommandExecutor();
	const service = new SqlConnectionService(executor);

	await service.closeConnection('  local  ');

	assert.deepEqual(executor.lastCall(), {
		command: 'sql_close_connection',
		args: {
			connectionId: 'local'
		}
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
```

---

# 13. 修改 `package.json`

当前 `package.json` 已经有 `test:branding`、`test:rust` 和 `test`，但没有前端 service 单测脚本。

修改 scripts：

```json
{
	"scripts": {
		"test:branding": "node scripts/verify-branding.mjs",
		"test:rust": "cd src-tauri && cargo test --lib",
		"test:sql-services": "node --test --import tsx src/vs/workbench/services/sql/test/sqlServices.test.ts",
		"test": "pnpm run test:branding && pnpm run test:rust && pnpm run test:sql-services"
	}
}
```

在 `devDependencies` 增加：

```json
{
	"devDependencies": {
		"tsx": "^4.20.6"
	}
}
```

> 这里顺手把 `test:rust` 从 `cargo test product --lib` 改成 `cargo test --lib`，否则 Phase 2 的 SQL 后端单测不会被默认跑到。

---

# 14. Phase 3 验收方式

```bash
pnpm install
pnpm run test:sql-services
pnpm run test
pnpm run lint
pnpm run build
```

手动验证可在后续临时 command 或 DevTools 中通过 DI 创建服务调用，Phase 4 开始再接入正式 UI。

---

# 15. Phase 3 完成后的能力

完成后，后续 UI 不需要直接写：

```ts
invoke('sql_execute_query', ...)
```

而是统一走：

```ts
@ISqlConnectionService
@ISqlMetadataService
@ISqlQueryService
```

后续 Phase 4 可以直接做：

```txt
SQL Connections Activity
  -> ISqlConnectionService.openConnection()
  -> ISqlMetadataService.listTables()
```

Phase 5 可以直接做：

```txt
SQL Editor
  -> ISqlQueryService.executeQuery()
```

Phase 6 可以直接做：

```txt
Result Panel
  -> 消费 SqlQueryResult
```

最终这一阶段的核心价值是把 Phase 2 的 Rust command 变成 Workbench 原生服务，避免后续 contrib 到处散落 Tauri `invoke()`。
