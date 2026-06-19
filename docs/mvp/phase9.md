下面给出 **Phase 9：多数据库地基** 的详细设计与完整代码。

当前状态很清楚：前端协议 `SqlConnectionKind` 只有 `sqlite`，`SqlConnectionInput` 也是 SQLite 专属字段 `databasePath / readOnly / createIfMissing`。 Driver Catalog 也只有 SQLite 一个 enabled driver。 Dialect helper 也写明 Phase 6.6 只支持 SQLite。 Tauri 侧协议同样只有 `SqlConnectionKind::Sqlite`，并且 `SqlConnectionStore` 直接持有 `rusqlite::Connection`。

所以 Phase 9 的正确目标不是“马上接 MySQL/PostgreSQL”，而是：

```txt id="s9vxnc"
把 SQLite 专属协议，升级成多数据库可承载协议；
把 driver/dialect/capabilities/validation 抽出来；
PostgreSQL/MySQL 先进入 catalog，但 availability = planned；
后端收到非 SQLite 连接时明确返回 unsupported；
现有 SQLite 主流程完全不破坏。
```

---

# Phase 9：多数据库地基

## 目标

```txt id="6r0w5q"
1. 扩展 SqlConnectionKind：sqlite / postgresql / mysql
2. 建立 Driver Catalog：SQLite enabled，PostgreSQL/MySQL planned
3. 建立 Dialect 基础：quote identifier / qualified name / preview SQL
4. 建立 Connection Profile 模型：file-based / network-based 连接统一描述
5. 前端 validation 明确拒绝 planned driver
6. 后端协议预留 PostgreSQL/MySQL 字段，但 runtime 仍只打开 SQLite
7. 单元测试覆盖 driver/dialect/profile/validation
8. Rust 单元测试覆盖 unsupported driver
```

## 不做

```txt id="o1od5y"
1. 不实现 PostgreSQL/MySQL 真实连接
2. 不引入 sqlx/tokio-postgres/mysql crate
3. 不做密码保存
4. 不做 Secret Store
5. 不做多数据库连接表单
6. 不做迁移 UI
7. 不做 SQL 方言补全
```

---

# 文件变化

前端替换：

```txt id="zaogyf"
src/vs/workbench/services/sql/common/sqlTypes.ts
src/vs/workbench/services/sql/common/sqlDrivers.ts
src/vs/workbench/services/sql/common/sqlDialect.ts
src/vs/workbench/services/sql/common/sqlValidation.ts
```

前端新增：

```txt id="dev7zl"
src/vs/workbench/services/sql/common/sqlConnectionProfile.ts
src/vs/workbench/services/sql/test/sqlConnectionProfile.test.ts
```

补充/替换测试：

```txt id="4s6h81"
src/vs/workbench/services/sql/test/sqlDrivers.test.ts
src/vs/workbench/services/sql/test/sqlDialect.test.ts
src/vs/workbench/services/sql/test/sqlServices.test.ts
```

Tauri 替换/新增：

```txt id="u7y6cx"
src-tauri/src/commands/sql/types.rs
src-tauri/src/commands/sql/driver.rs
src-tauri/src/commands/sql/mod.rs
src-tauri/src/commands/sql/state.rs 局部修改
```

---

# 1. 替换前端协议：`sqlTypes.ts`

路径：

```txt id="tw9p93"
src/vs/workbench/services/sql/common/sqlTypes.ts
```

```ts id="3fgvbt"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL service protocol types.
 * Phase 9 introduces multi-database-capable protocol fields.
 * SQLite remains the only enabled runtime driver.
 *--------------------------------------------------------------------------------------------*/

export const enum SqlConnectionKind {
	Sqlite = 'sqlite',
	PostgreSql = 'postgresql',
	MySql = 'mysql'
}

export const enum SqlSslMode {
	Disable = 'disable',
	Prefer = 'prefer',
	Require = 'require'
}

export interface SqlConnectionInput {
	id?: string;
	name?: string;
	kind: SqlConnectionKind;

	/**
	 * SQLite-only.
	 */
	databasePath?: string;

	/**
	 * Network database fields.
	 * Reserved for PostgreSQL/MySQL foundation in Phase 9.
	 */
	host?: string;
	port?: number;
	database?: string;
	username?: string;
	password?: string;
	sslMode?: SqlSslMode;

	readOnly?: boolean;
	createIfMissing?: boolean;
}

export interface SqlConnection {
	id: string;
	name: string;
	kind: SqlConnectionKind;

	/**
	 * SQLite-only display/runtime path.
	 */
	databasePath?: string;

	/**
	 * Network database display fields.
	 * Password is intentionally never returned.
	 */
	host?: string;
	port?: number;
	database?: string;
	username?: string;
	sslMode?: SqlSslMode;

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

export interface SqlSavedConnection {
	id: string;
	name: string;
	kind: SqlConnectionKind;

	databasePath?: string;

	host?: string;
	port?: number;
	database?: string;
	username?: string;
	sslMode?: SqlSslMode;

	readOnly: boolean;
	createIfMissing: boolean;
	autoConnect: boolean;
}

export interface SqlSaveConnectionRequest {
	input: SqlConnectionInput;
	autoConnect?: boolean;
	openNow?: boolean;
}

export interface SqlRemoveSavedConnectionRequest {
	connectionId: string;
	closeIfOpen?: boolean;
}

export interface SqlRestoreSavedConnectionError {
	connectionId: string;
	name: string;
	error: string;
}

export interface SqlRestoreSavedConnectionsResult {
	opened: SqlConnection[];
	errors: SqlRestoreSavedConnectionError[];
}
```

---

# 2. 替换 Driver Catalog：`sqlDrivers.ts`

路径：

```txt id="7u0vo7"
src/vs/workbench/services/sql/common/sqlDrivers.ts
```

```ts id="wqqm31"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL driver catalog.
 * Phase 9 introduces multi-database foundations.
 * SQLite is enabled. PostgreSQL/MySQL are planned.
 *--------------------------------------------------------------------------------------------*/

import { SqlConnectionKind } from './sqlTypes.js';
import { SqlDialect } from './sqlDialect.js';

export const enum SqlDriverAvailability {
	Enabled = 'enabled',
	Planned = 'planned',
	Disabled = 'disabled'
}

export interface SqlDriverCapabilities {
	readonly fileBased: boolean;
	readonly remote: boolean;
	readonly schemas: boolean;
	readonly readOnly: boolean;
	readonly createIfMissing: boolean;
	readonly transactions: boolean;
	readonly explain: boolean;
	readonly ssl: boolean;
	readonly credentials: boolean;
}

export interface SqlDriverDefaultPorts {
	readonly default?: number;
	readonly alternatives: readonly number[];
}

export interface SqlDriverDescriptor {
	readonly id: SqlConnectionKind;
	readonly label: string;
	readonly dialect: SqlDialect;
	readonly availability: SqlDriverAvailability;
	readonly capabilities: SqlDriverCapabilities;
	readonly defaultPorts?: SqlDriverDefaultPorts;
	readonly reason?: string;
}

export const SQLITE_DRIVER: SqlDriverDescriptor = {
	id: SqlConnectionKind.Sqlite,
	label: 'SQLite',
	dialect: SqlDialect.Sqlite,
	availability: SqlDriverAvailability.Enabled,
	capabilities: {
		fileBased: true,
		remote: false,
		schemas: true,
		readOnly: true,
		createIfMissing: true,
		transactions: true,
		explain: true,
		ssl: false,
		credentials: false
	}
};

export const POSTGRESQL_DRIVER: SqlDriverDescriptor = {
	id: SqlConnectionKind.PostgreSql,
	label: 'PostgreSQL',
	dialect: SqlDialect.PostgreSql,
	availability: SqlDriverAvailability.Planned,
	defaultPorts: {
		default: 5432,
		alternatives: []
	},
	reason: 'PostgreSQL runtime driver is planned after the SQLite MVP is stable.',
	capabilities: {
		fileBased: false,
		remote: true,
		schemas: true,
		readOnly: false,
		createIfMissing: false,
		transactions: true,
		explain: true,
		ssl: true,
		credentials: true
	}
};

export const MYSQL_DRIVER: SqlDriverDescriptor = {
	id: SqlConnectionKind.MySql,
	label: 'MySQL',
	dialect: SqlDialect.MySql,
	availability: SqlDriverAvailability.Planned,
	defaultPorts: {
		default: 3306,
		alternatives: []
	},
	reason: 'MySQL runtime driver is planned after the SQLite MVP is stable.',
	capabilities: {
		fileBased: false,
		remote: true,
		schemas: true,
		readOnly: false,
		createIfMissing: false,
		transactions: true,
		explain: true,
		ssl: true,
		credentials: true
	}
};

export const SQL_DRIVER_CATALOG: readonly SqlDriverDescriptor[] = [
	SQLITE_DRIVER,
	POSTGRESQL_DRIVER,
	MYSQL_DRIVER
];

export function listSqlDriverDescriptors(): SqlDriverDescriptor[] {
	return [...SQL_DRIVER_CATALOG];
}

export function listEnabledSqlDrivers(): SqlDriverDescriptor[] {
	return SQL_DRIVER_CATALOG.filter(driver => driver.availability === SqlDriverAvailability.Enabled);
}

export function listPlannedSqlDrivers(): SqlDriverDescriptor[] {
	return SQL_DRIVER_CATALOG.filter(driver => driver.availability === SqlDriverAvailability.Planned);
}

export function getSqlDriverDescriptor(kind: SqlConnectionKind): SqlDriverDescriptor {
	const descriptor = SQL_DRIVER_CATALOG.find(driver => driver.id === kind);

	if (!descriptor) {
		throw new Error(`Unsupported SQL driver: ${kind}`);
	}

	return descriptor;
}

export function isSqlDriverEnabled(kind: SqlConnectionKind): boolean {
	return getSqlDriverDescriptor(kind).availability === SqlDriverAvailability.Enabled;
}

export function assertSqlDriverEnabled(kind: SqlConnectionKind): void {
	const descriptor = getSqlDriverDescriptor(kind);

	if (descriptor.availability !== SqlDriverAvailability.Enabled) {
		throw new Error(`SQL driver '${descriptor.label}' is ${descriptor.availability} and cannot be used yet.`);
	}
}
```

---

# 3. 替换 Dialect Helper：`sqlDialect.ts`

路径：

```txt id="7w29je"
src/vs/workbench/services/sql/common/sqlDialect.ts
```

```ts id="3u3vks"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL dialect domain helpers.
 * Phase 9 adds foundation for PostgreSQL/MySQL SQL generation.
 *--------------------------------------------------------------------------------------------*/

import { SqlConnectionKind } from './sqlTypes.js';

export const enum SqlDialect {
	Sqlite = 'sqlite',
	PostgreSql = 'postgresql',
	MySql = 'mysql'
}

export interface SqlQualifiedName {
	schema?: string;
	name: string;
}

export interface SqlTablePreviewOptions {
	dialect: SqlDialect;
	schema?: string;
	tableName: string;
	limit?: number;
}

export const SQL_DEFAULT_TABLE_PREVIEW_LIMIT = 100;
export const SQL_MAX_TABLE_PREVIEW_LIMIT = 10_000;

export function getDialectForConnectionKind(kind: SqlConnectionKind): SqlDialect {
	switch (kind) {
		case SqlConnectionKind.Sqlite:
			return SqlDialect.Sqlite;

		case SqlConnectionKind.PostgreSql:
			return SqlDialect.PostgreSql;

		case SqlConnectionKind.MySql:
			return SqlDialect.MySql;

		default:
			return assertNever(kind);
	}
}

export function quoteSqlIdentifier(dialect: SqlDialect, value: string): string {
	const normalized = normalizeIdentifier(value, 'identifier');

	switch (dialect) {
		case SqlDialect.Sqlite:
		case SqlDialect.PostgreSql:
			return `"${normalized.replaceAll('"', '""')}"`;

		case SqlDialect.MySql:
			return `\`${normalized.replaceAll('`', '``')}\``;

		default:
			return assertNever(dialect);
	}
}

export function formatQualifiedName(dialect: SqlDialect, qualifiedName: SqlQualifiedName): string {
	const name = normalizeIdentifier(qualifiedName.name, 'name');
	const schema = normalizeOptionalIdentifier(qualifiedName.schema, 'schema');

	if (!schema || shouldOmitSchema(dialect, schema)) {
		return quoteSqlIdentifier(dialect, name);
	}

	return `${quoteSqlIdentifier(dialect, schema)}.${quoteSqlIdentifier(dialect, name)}`;
}

export function createTablePreviewSql(options: SqlTablePreviewOptions): string {
	const limit = normalizeLimit(options.limit);
	const tableName = formatQualifiedName(options.dialect, {
		schema: options.schema,
		name: options.tableName
	});

	switch (options.dialect) {
		case SqlDialect.Sqlite:
		case SqlDialect.PostgreSql:
		case SqlDialect.MySql:
			return `SELECT *
FROM ${tableName}
LIMIT ${limit};
`;

		default:
			return assertNever(options.dialect);
	}
}

export function normalizePreviewLimit(limit: number | undefined): number {
	return normalizeLimit(limit);
}

function shouldOmitSchema(dialect: SqlDialect, schema: string): boolean {
	switch (dialect) {
		case SqlDialect.Sqlite:
			return schema === 'main';

		case SqlDialect.PostgreSql:
			return schema === 'public';

		case SqlDialect.MySql:
			return false;

		default:
			return assertNever(dialect);
	}
}

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined) {
		return SQL_DEFAULT_TABLE_PREVIEW_LIMIT;
	}

	if (!Number.isInteger(limit) || limit <= 0) {
		throw new Error('limit must be a positive integer');
	}

	return Math.min(limit, SQL_MAX_TABLE_PREVIEW_LIMIT);
}

function normalizeIdentifier(value: string, fieldName: string): string {
	if (typeof value !== 'string') {
		throw new Error(`${fieldName} must be a string`);
	}

	const normalized = value.trim();

	if (!normalized) {
		throw new Error(`${fieldName} must not be empty`);
	}

	if (normalized.includes('\0')) {
		throw new Error(`${fieldName} must not contain NUL bytes`);
	}

	return normalized;
}

function normalizeOptionalIdentifier(value: string | undefined, fieldName: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== 'string') {
		throw new Error(`${fieldName} must be a string`);
	}

	const normalized = value.trim();

	if (!normalized) {
		return undefined;
	}

	if (normalized.includes('\0')) {
		throw new Error(`${fieldName} must not contain NUL bytes`);
	}

	return normalized;
}

function assertNever(value: never): never {
	throw new Error(`Unsupported SQL dialect value: ${String(value)}`);
}
```

---

# 4. 新增 Connection Profile：`sqlConnectionProfile.ts`

路径：

```txt id="8x23oo"
src/vs/workbench/services/sql/common/sqlConnectionProfile.ts
```

```ts id="da881m"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - normalized SQL connection profile.
 * This is UI/domain foundation only. It does not enable non-SQLite runtimes.
 *--------------------------------------------------------------------------------------------*/

import { getSqlDriverDescriptor } from './sqlDrivers.js';
import {
	SqlConnection,
	SqlConnectionInput,
	SqlConnectionKind,
	SqlSavedConnection,
	SqlSslMode
} from './sqlTypes.js';

export const enum SqlConnectionProfileMode {
	File = 'file',
	Network = 'network'
}

export interface SqlConnectionProfile {
	readonly id?: string;
	readonly name?: string;
	readonly kind: SqlConnectionKind;
	readonly mode: SqlConnectionProfileMode;
	readonly label: string;

	readonly databasePath?: string;

	readonly host?: string;
	readonly port?: number;
	readonly database?: string;
	readonly username?: string;
	readonly sslMode?: SqlSslMode;

	readonly readOnly: boolean;
	readonly createIfMissing: boolean;
}

export function createConnectionProfileFromInput(input: SqlConnectionInput): SqlConnectionProfile {
	const kind = normalizeConnectionKind(input.kind);
	const descriptor = getSqlDriverDescriptor(kind);
	const id = normalizeOptionalString(input.id);
	const name = normalizeOptionalString(input.name);

	if (descriptor.capabilities.fileBased) {
		const databasePath = normalizeRequiredString(input.databasePath, 'databasePath');

		return {
			id,
			name,
			kind,
			mode: SqlConnectionProfileMode.File,
			label: name ?? databasePath,
			databasePath,
			readOnly: input.readOnly === true,
			createIfMissing: input.createIfMissing === true
		};
	}

	const host = normalizeRequiredString(input.host, 'host');
	const database = normalizeRequiredString(input.database, 'database');
	const port = normalizePort(input.port, descriptor.defaultPorts?.default);
	const username = normalizeOptionalString(input.username);

	return {
		id,
		name,
		kind,
		mode: SqlConnectionProfileMode.Network,
		label: name ?? `${descriptor.label} · ${host}:${port}/${database}`,
		host,
		port,
		database,
		username,
		sslMode: normalizeSslMode(input.sslMode),
		readOnly: input.readOnly === true,
		createIfMissing: false
	};
}

export function createConnectionProfileFromConnection(connection: SqlConnection): SqlConnectionProfile {
	return createConnectionProfileFromInput({
		id: connection.id,
		name: connection.name,
		kind: connection.kind,
		databasePath: connection.databasePath,
		host: connection.host,
		port: connection.port,
		database: connection.database,
		username: connection.username,
		sslMode: connection.sslMode,
		readOnly: connection.readOnly
	});
}

export function createConnectionProfileFromSavedConnection(connection: SqlSavedConnection): SqlConnectionProfile {
	return createConnectionProfileFromInput({
		id: connection.id,
		name: connection.name,
		kind: connection.kind,
		databasePath: connection.databasePath,
		host: connection.host,
		port: connection.port,
		database: connection.database,
		username: connection.username,
		sslMode: connection.sslMode,
		readOnly: connection.readOnly,
		createIfMissing: connection.createIfMissing
	});
}

export function toConnectionInput(profile: SqlConnectionProfile): SqlConnectionInput {
	if (profile.mode === SqlConnectionProfileMode.File) {
		return {
			id: profile.id,
			name: profile.name,
			kind: profile.kind,
			databasePath: profile.databasePath,
			readOnly: profile.readOnly,
			createIfMissing: profile.createIfMissing
		};
	}

	return {
		id: profile.id,
		name: profile.name,
		kind: profile.kind,
		host: profile.host,
		port: profile.port,
		database: profile.database,
		username: profile.username,
		sslMode: profile.sslMode,
		readOnly: profile.readOnly
	};
}

export function getConnectionDisplayName(input: SqlConnectionInput): string {
	return createConnectionProfileFromInput(input).label;
}

export function maskConnectionInput(input: SqlConnectionInput): SqlConnectionInput {
	const { password: _password, ...rest } = input;
	return rest;
}

function normalizeConnectionKind(kind: SqlConnectionKind): SqlConnectionKind {
	if (!Object.values(SqlConnectionKind).includes(kind)) {
		throw new Error(`Unsupported SQL connection kind: ${String(kind)}`);
	}

	return kind;
}

function normalizeRequiredString(value: string | undefined, fieldName: string): string {
	const normalized = normalizeOptionalString(value);

	if (!normalized) {
		throw new Error(`${fieldName} must not be empty`);
	}

	if (normalized.includes('\0')) {
		throw new Error(`${fieldName} must not contain NUL bytes`);
	}

	return normalized;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function normalizePort(value: number | undefined, fallback: number | undefined): number {
	const port = value ?? fallback;

	if (!Number.isInteger(port) || port! <= 0 || port! > 65_535) {
		throw new Error('port must be an integer between 1 and 65535');
	}

	return port!;
}

function normalizeSslMode(value: SqlSslMode | undefined): SqlSslMode {
	if (!value) {
		return SqlSslMode.Prefer;
	}

	if (!Object.values(SqlSslMode).includes(value)) {
		throw new Error(`Unsupported SQL ssl mode: ${String(value)}`);
	}

	return value;
}
```

---

# 5. 替换 Validation：`sqlValidation.ts`

路径：

```txt id="gk3mjh"
src/vs/workbench/services/sql/common/sqlValidation.ts
```

```ts id="0qzs97"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL service input validation helpers.
 *--------------------------------------------------------------------------------------------*/

import { assertSqlDriverEnabled } from './sqlDrivers.js';
import { createConnectionProfileFromInput, toConnectionInput } from './sqlConnectionProfile.js';
import {
	SqlCancelQueryRequest,
	SqlConnectionInput,
	SqlConnectionKind,
	SqlExecuteQueryRequest,
	SqlListColumnsRequest,
	SqlRemoveSavedConnectionRequest,
	SqlSaveConnectionRequest
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

	assertSqlDriverEnabled(input.kind);

	const profile = createConnectionProfileFromInput(input);
	const normalized = toConnectionInput(profile);

	/**
	 * Phase 9 still enables SQLite only.
	 * assertSqlDriverEnabled() already rejects planned drivers, but keep this
	 * explicit guard to prevent accidental remote driver activation by changing
	 * catalog metadata only.
	 */
	if (normalized.kind !== SqlConnectionKind.Sqlite) {
		throw new Error(`SQL driver '${normalized.kind}' is not enabled yet.`);
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

export function normalizeSqlSaveConnectionRequest(request: SqlSaveConnectionRequest): SqlSaveConnectionRequest {
	if (!request || typeof request !== 'object') {
		throw new Error('save connection request must be an object');
	}

	const input = normalizeSqlConnectionInput(request.input);

	if (input.kind === SqlConnectionKind.Sqlite && input.databasePath?.trim() === ':memory:') {
		throw new Error('in-memory SQLite connections cannot be saved');
	}

	return {
		input,
		autoConnect: request.autoConnect === true,
		openNow: request.openNow === true
	};
}

export function normalizeSqlRemoveSavedConnectionRequest(
	request: SqlRemoveSavedConnectionRequest
): SqlRemoveSavedConnectionRequest {
	if (!request || typeof request !== 'object') {
		throw new Error('remove saved connection request must be an object');
	}

	return {
		connectionId: normalizeConnectionId(request.connectionId),
		closeIfOpen: request.closeIfOpen === true
	};
}
```

---

# 6. 替换/补充前端测试

## 6.1 `sqlDrivers.test.ts`

路径：

```txt id="gjg6nw"
src/vs/workbench/services/sql/test/sqlDrivers.test.ts
```

```ts id="nlrv9h"
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	assertSqlDriverEnabled,
	getSqlDriverDescriptor,
	isSqlDriverEnabled,
	listEnabledSqlDrivers,
	listPlannedSqlDrivers,
	listSqlDriverDescriptors,
	SqlDriverAvailability
} from '../common/sqlDrivers.js';
import { SqlDialect } from '../common/sqlDialect.js';
import { SqlConnectionKind } from '../common/sqlTypes.js';

test('driver catalog contains sqlite postgresql and mysql', () => {
	assert.deepEqual(
		listSqlDriverDescriptors().map(driver => driver.id),
		[
			SqlConnectionKind.Sqlite,
			SqlConnectionKind.PostgreSql,
			SqlConnectionKind.MySql
		]
	);
});

test('SQLite driver is enabled', () => {
	const sqlite = getSqlDriverDescriptor(SqlConnectionKind.Sqlite);

	assert.equal(sqlite.label, 'SQLite');
	assert.equal(sqlite.dialect, SqlDialect.Sqlite);
	assert.equal(sqlite.availability, SqlDriverAvailability.Enabled);
	assert.equal(sqlite.capabilities.fileBased, true);
	assert.equal(sqlite.capabilities.remote, false);
	assert.equal(sqlite.capabilities.credentials, false);
	assert.equal(isSqlDriverEnabled(SqlConnectionKind.Sqlite), true);
	assert.doesNotThrow(() => assertSqlDriverEnabled(SqlConnectionKind.Sqlite));
});

test('PostgreSQL driver is planned', () => {
	const postgres = getSqlDriverDescriptor(SqlConnectionKind.PostgreSql);

	assert.equal(postgres.label, 'PostgreSQL');
	assert.equal(postgres.dialect, SqlDialect.PostgreSql);
	assert.equal(postgres.availability, SqlDriverAvailability.Planned);
	assert.equal(postgres.defaultPorts?.default, 5432);
	assert.equal(postgres.capabilities.remote, true);
	assert.equal(postgres.capabilities.credentials, true);
	assert.equal(isSqlDriverEnabled(SqlConnectionKind.PostgreSql), false);
	assert.throws(() => assertSqlDriverEnabled(SqlConnectionKind.PostgreSql), /planned/);
});

test('MySQL driver is planned', () => {
	const mysql = getSqlDriverDescriptor(SqlConnectionKind.MySql);

	assert.equal(mysql.label, 'MySQL');
	assert.equal(mysql.dialect, SqlDialect.MySql);
	assert.equal(mysql.availability, SqlDriverAvailability.Planned);
	assert.equal(mysql.defaultPorts?.default, 3306);
	assert.equal(mysql.capabilities.remote, true);
	assert.equal(mysql.capabilities.credentials, true);
	assert.equal(isSqlDriverEnabled(SqlConnectionKind.MySql), false);
	assert.throws(() => assertSqlDriverEnabled(SqlConnectionKind.MySql), /planned/);
});

test('listEnabledSqlDrivers returns only SQLite', () => {
	assert.deepEqual(
		listEnabledSqlDrivers().map(driver => driver.id),
		[SqlConnectionKind.Sqlite]
	);
});

test('listPlannedSqlDrivers returns PostgreSQL and MySQL', () => {
	assert.deepEqual(
		listPlannedSqlDrivers().map(driver => driver.id),
		[SqlConnectionKind.PostgreSql, SqlConnectionKind.MySql]
	);
});
```

---

## 6.2 `sqlDialect.test.ts`

路径：

```txt id="g3fv6g"
src/vs/workbench/services/sql/test/sqlDialect.test.ts"
```

```ts id="vbjvzo"
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createTablePreviewSql,
	formatQualifiedName,
	getDialectForConnectionKind,
	normalizePreviewLimit,
	quoteSqlIdentifier,
	SqlDialect
} from '../common/sqlDialect.js';
import { SqlConnectionKind } from '../common/sqlTypes.js';

test('getDialectForConnectionKind maps all known connection kinds', () => {
	assert.equal(getDialectForConnectionKind(SqlConnectionKind.Sqlite), SqlDialect.Sqlite);
	assert.equal(getDialectForConnectionKind(SqlConnectionKind.PostgreSql), SqlDialect.PostgreSql);
	assert.equal(getDialectForConnectionKind(SqlConnectionKind.MySql), SqlDialect.MySql);
});

test('quoteSqlIdentifier quotes sqlite identifiers', () => {
	assert.equal(quoteSqlIdentifier(SqlDialect.Sqlite, 'users'), '"users"');
	assert.equal(quoteSqlIdentifier(SqlDialect.Sqlite, 'a"b'), '"a""b"');
});

test('quoteSqlIdentifier quotes postgresql identifiers', () => {
	assert.equal(quoteSqlIdentifier(SqlDialect.PostgreSql, 'users'), '"users"');
	assert.equal(quoteSqlIdentifier(SqlDialect.PostgreSql, 'a"b'), '"a""b"');
});

test('quoteSqlIdentifier quotes mysql identifiers', () => {
	assert.equal(quoteSqlIdentifier(SqlDialect.MySql, 'users'), '`users`');
	assert.equal(quoteSqlIdentifier(SqlDialect.MySql, 'a`b'), '`a``b`');
});

test('formatQualifiedName omits sqlite main schema', () => {
	assert.equal(
		formatQualifiedName(SqlDialect.Sqlite, {
			schema: 'main',
			name: 'users'
		}),
		'"users"'
	);
});

test('formatQualifiedName omits postgresql public schema', () => {
	assert.equal(
		formatQualifiedName(SqlDialect.PostgreSql, {
			schema: 'public',
			name: 'users'
		}),
		'"users"'
	);
});

test('formatQualifiedName includes mysql database qualifier', () => {
	assert.equal(
		formatQualifiedName(SqlDialect.MySql, {
			schema: 'app',
			name: 'users'
		}),
		'`app`.`users`'
	);
});

test('createTablePreviewSql creates sqlite preview SQL', () => {
	assert.equal(
		createTablePreviewSql({
			dialect: SqlDialect.Sqlite,
			schema: 'main',
			tableName: 'users'
		}),
		`SELECT *
FROM "users"
LIMIT 100;
`
	);
});

test('createTablePreviewSql creates postgresql preview SQL', () => {
	assert.equal(
		createTablePreviewSql({
			dialect: SqlDialect.PostgreSql,
			schema: 'public',
			tableName: 'users',
			limit: 25
		}),
		`SELECT *
FROM "users"
LIMIT 25;
`
	);
});

test('createTablePreviewSql creates mysql preview SQL', () => {
	assert.equal(
		createTablePreviewSql({
			dialect: SqlDialect.MySql,
			schema: 'app',
			tableName: 'users',
			limit: 25
		}),
		`SELECT *
FROM \`app\`.\`users\`
LIMIT 25;
`
	);
});

test('normalizePreviewLimit clamps limit', () => {
	assert.equal(normalizePreviewLimit(undefined), 100);
	assert.equal(normalizePreviewLimit(100_000), 10_000);
	assert.throws(() => normalizePreviewLimit(0), /positive integer/);
});
```

---

## 6.3 新增 `sqlConnectionProfile.test.ts`

路径：

```txt id="vmen6n"
src/vs/workbench/services/sql/test/sqlConnectionProfile.test.ts"
```

```ts id="35gvtp"
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createConnectionProfileFromInput,
	getConnectionDisplayName,
	maskConnectionInput,
	SqlConnectionProfileMode,
	toConnectionInput
} from '../common/sqlConnectionProfile.js';
import { SqlConnectionKind, SqlSslMode } from '../common/sqlTypes.js';

test('createConnectionProfileFromInput creates sqlite file profile', () => {
	const profile = createConnectionProfileFromInput({
		kind: SqlConnectionKind.Sqlite,
		name: ' Local ',
		databasePath: ' /tmp/app.db ',
		readOnly: true,
		createIfMissing: true
	});

	assert.deepEqual(profile, {
		id: undefined,
		name: 'Local',
		kind: SqlConnectionKind.Sqlite,
		mode: SqlConnectionProfileMode.File,
		label: 'Local',
		databasePath: '/tmp/app.db',
		readOnly: true,
		createIfMissing: true
	});
});

test('createConnectionProfileFromInput creates postgresql network profile', () => {
	const profile = createConnectionProfileFromInput({
		kind: SqlConnectionKind.PostgreSql,
		host: ' localhost ',
		database: ' app ',
		username: ' user ',
		sslMode: SqlSslMode.Require
	});

	assert.equal(profile.kind, SqlConnectionKind.PostgreSql);
	assert.equal(profile.mode, SqlConnectionProfileMode.Network);
	assert.equal(profile.host, 'localhost');
	assert.equal(profile.port, 5432);
	assert.equal(profile.database, 'app');
	assert.equal(profile.username, 'user');
	assert.equal(profile.sslMode, SqlSslMode.Require);
	assert.equal(profile.label, 'PostgreSQL · localhost:5432/app');
});

test('createConnectionProfileFromInput creates mysql network profile', () => {
	const profile = createConnectionProfileFromInput({
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3307,
		database: 'app'
	});

	assert.equal(profile.kind, SqlConnectionKind.MySql);
	assert.equal(profile.mode, SqlConnectionProfileMode.Network);
	assert.equal(profile.port, 3307);
	assert.equal(profile.sslMode, SqlSslMode.Prefer);
	assert.equal(profile.label, 'MySQL · localhost:3307/app');
});

test('toConnectionInput converts profile back to input', () => {
	const profile = createConnectionProfileFromInput({
		id: 'db1',
		name: 'App DB',
		kind: SqlConnectionKind.Sqlite,
		databasePath: '/tmp/app.db',
		readOnly: true,
		createIfMissing: true
	});

	assert.deepEqual(toConnectionInput(profile), {
		id: 'db1',
		name: 'App DB',
		kind: SqlConnectionKind.Sqlite,
		databasePath: '/tmp/app.db',
		readOnly: true,
		createIfMissing: true
	});
});

test('getConnectionDisplayName returns profile label', () => {
	assert.equal(
		getConnectionDisplayName({
			kind: SqlConnectionKind.Sqlite,
			databasePath: '/tmp/app.db'
		}),
		'/tmp/app.db'
	);
});

test('maskConnectionInput removes password', () => {
	assert.deepEqual(
		maskConnectionInput({
			kind: SqlConnectionKind.PostgreSql,
			host: 'localhost',
			database: 'app',
			username: 'user',
			password: 'secret'
		}),
		{
			kind: SqlConnectionKind.PostgreSql,
			host: 'localhost',
			database: 'app',
			username: 'user'
		}
	);
});

test('createConnectionProfileFromInput rejects invalid port', () => {
	assert.throws(
		() =>
			createConnectionProfileFromInput({
				kind: SqlConnectionKind.PostgreSql,
				host: 'localhost',
				port: 999_999,
				database: 'app'
			}),
		/port/
	);
});

test('createConnectionProfileFromInput rejects empty databasePath', () => {
	assert.throws(
		() =>
			createConnectionProfileFromInput({
				kind: SqlConnectionKind.Sqlite,
				databasePath: '   '
			}),
		/databasePath/
	);
});
```

---

## 6.4 补充 `sqlServices.test.ts`

在已有 `sqlServices.test.ts` 中追加：

```ts id="uzxaja"
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
	assert.deepEqual(
		normalizeSqlConnectionInput({
			kind: SqlConnectionKind.Sqlite,
			databasePath: ' /tmp/app.db ',
			readOnly: true,
			createIfMissing: true
		}),
		{
			kind: SqlConnectionKind.Sqlite,
			databasePath: '/tmp/app.db',
			readOnly: true,
			createIfMissing: true
		}
	);
});
```

如果文件未 import 这些符号，补充：

```ts id="h1h3ds"
import { normalizeSqlConnectionInput } from '../common/sqlValidation.js';
import { SqlConnectionKind } from '../common/sqlTypes.js';
```

---

# 7. Rust 协议：替换 `types.rs`

路径：

```txt id="cbdfoo"
src-tauri/src/commands/sql/types.rs
```

下面给出 Phase 9 需要改动的顶部协议部分；后面原有 `SqlTable / SqlColumn / SqlQueryResult / SqlCellValue` 可以保持不变。

```rust id="mvvhc9"
use serde::{Deserialize, Serialize};

pub const DEFAULT_QUERY_ROW_LIMIT: usize = 1_000;
pub const MAX_QUERY_ROW_LIMIT: usize = 100_000;
pub const MAX_SQL_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SqlConnectionKind {
    Sqlite,
    PostgreSql,
    MySql,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SqlSslMode {
    Disable,
    Prefer,
    Require,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlConnectionInput {
    pub id: Option<String>,
    pub name: Option<String>,
    pub kind: SqlConnectionKind,

    pub database_path: Option<String>,

    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub ssl_mode: Option<SqlSslMode>,

    #[serde(default)]
    pub read_only: bool,

    #[serde(default)]
    pub create_if_missing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlConnection {
    pub id: String,
    pub name: String,
    pub kind: SqlConnectionKind,

    pub database_path: Option<String>,

    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub ssl_mode: Option<SqlSslMode>,

    pub read_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlSavedConnection {
    pub id: String,
    pub name: String,
    pub kind: SqlConnectionKind,

    pub database_path: Option<String>,

    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub ssl_mode: Option<SqlSslMode>,

    pub read_only: bool,
    pub create_if_missing: bool,
    pub auto_connect: bool,
}

impl SqlSavedConnection {
    pub fn to_input(&self) -> SqlConnectionInput {
        SqlConnectionInput {
            id: Some(self.id.clone()),
            name: Some(self.name.clone()),
            kind: self.kind.clone(),
            database_path: self.database_path.clone(),
            host: self.host.clone(),
            port: self.port,
            database: self.database.clone(),
            username: self.username.clone(),
            password: None,
            ssl_mode: self.ssl_mode.clone(),
            read_only: self.read_only,
            create_if_missing: self.create_if_missing,
        }
    }
}
```

同时，凡是旧代码访问：

```rust id="jzqc05"
connection.database_path
input.database_path
```

都需要改为：

```rust id="vrfsqg"
connection.database_path.as_deref().unwrap_or_default()
input.database_path.as_deref().unwrap_or_default()
```

更推荐通过下面 `driver.rs` 的 normalize helper 统一处理。

---

# 8. 新增 Rust Driver 地基：`driver.rs`

路径：

```txt id="gmpxsg"
src-tauri/src/commands/sql/driver.rs
```

```rust id="3e6xq8"
use super::types::{SqlConnection, SqlConnectionInput, SqlConnectionKind, SqlSslMode};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SqlDriverAvailability {
    Enabled,
    Planned,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlDriverDescriptor {
    pub kind: SqlConnectionKind,
    pub label: &'static str,
    pub availability: SqlDriverAvailability,
    pub default_port: Option<u16>,
    pub file_based: bool,
    pub remote: bool,
}

pub fn sql_driver_catalog() -> Vec<SqlDriverDescriptor> {
    vec![
        SqlDriverDescriptor {
            kind: SqlConnectionKind::Sqlite,
            label: "SQLite",
            availability: SqlDriverAvailability::Enabled,
            default_port: None,
            file_based: true,
            remote: false,
        },
        SqlDriverDescriptor {
            kind: SqlConnectionKind::PostgreSql,
            label: "PostgreSQL",
            availability: SqlDriverAvailability::Planned,
            default_port: Some(5432),
            file_based: false,
            remote: true,
        },
        SqlDriverDescriptor {
            kind: SqlConnectionKind::MySql,
            label: "MySQL",
            availability: SqlDriverAvailability::Planned,
            default_port: Some(3306),
            file_based: false,
            remote: true,
        },
    ]
}

pub fn get_driver_descriptor(kind: &SqlConnectionKind) -> SqlDriverDescriptor {
    sql_driver_catalog()
        .into_iter()
        .find(|driver| &driver.kind == kind)
        .expect("all SqlConnectionKind variants must be in driver catalog")
}

pub fn ensure_driver_enabled(kind: &SqlConnectionKind) -> Result<(), String> {
    let descriptor = get_driver_descriptor(kind);

    match descriptor.availability {
        SqlDriverAvailability::Enabled => Ok(()),
        SqlDriverAvailability::Planned => Err(format!(
            "SQL driver '{}' is planned and is not enabled yet",
            descriptor.label
        )),
    }
}

pub fn normalize_connection_input(input: &SqlConnectionInput) -> Result<SqlConnection, String> {
    ensure_driver_enabled(&input.kind)?;

    match input.kind {
        SqlConnectionKind::Sqlite => normalize_sqlite_connection_input(input),
        SqlConnectionKind::PostgreSql | SqlConnectionKind::MySql => {
            Err(format!("SQL driver '{:?}' is not enabled yet", input.kind))
        }
    }
}

pub fn normalize_sqlite_connection_input(input: &SqlConnectionInput) -> Result<SqlConnection, String> {
    let database_path = normalize_required(input.database_path.as_deref(), "databasePath")?;
    let id = normalize_optional(input.id.as_deref()).unwrap_or_else(|| Uuid::new_v4().to_string());
    let name = normalize_optional(input.name.as_deref()).unwrap_or_else(|| database_path.clone());

    Ok(SqlConnection {
        id,
        name,
        kind: SqlConnectionKind::Sqlite,
        database_path: Some(database_path),
        host: None,
        port: None,
        database: None,
        username: None,
        ssl_mode: None,
        read_only: input.read_only,
    })
}

#[allow(dead_code)]
pub fn normalize_network_connection_input(input: &SqlConnectionInput) -> Result<SqlConnection, String> {
    let descriptor = get_driver_descriptor(&input.kind);

    if !descriptor.remote {
        return Err(format!("SQL driver '{}' is not a network driver", descriptor.label));
    }

    let host = normalize_required(input.host.as_deref(), "host")?;
    let database = normalize_required(input.database.as_deref(), "database")?;
    let port = input
        .port
        .or(descriptor.default_port)
        .ok_or_else(|| "port is required".to_string())?;

    let id = normalize_optional(input.id.as_deref()).unwrap_or_else(|| Uuid::new_v4().to_string());
    let name = normalize_optional(input.name.as_deref())
        .unwrap_or_else(|| format!("{} · {}:{}/{}", descriptor.label, host, port, database));

    Ok(SqlConnection {
        id,
        name,
        kind: input.kind.clone(),
        database_path: None,
        host: Some(host),
        port: Some(port),
        database: Some(database),
        username: normalize_optional(input.username.as_deref()),
        ssl_mode: Some(input.ssl_mode.clone().unwrap_or(SqlSslMode::Prefer)),
        read_only: input.read_only,
    })
}

pub fn is_persistable_connection(connection: &SqlConnection) -> bool {
    match connection.kind {
        SqlConnectionKind::Sqlite => connection.database_path.as_deref() != Some(":memory:"),
        SqlConnectionKind::PostgreSql | SqlConnectionKind::MySql => true,
    }
}

fn normalize_required(value: Option<&str>, field_name: &str) -> Result<String, String> {
    let value = value.unwrap_or("").trim();

    if value.is_empty() {
        return Err(format!("{field_name} must not be empty"));
    }

    if value.contains('\0') {
        return Err(format!("{field_name} must not contain NUL bytes"));
    }

    Ok(value.to_string())
}

fn normalize_optional(value: Option<&str>) -> Option<String> {
    let value = value?.trim();

    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_driver_is_enabled() {
        assert_eq!(get_driver_descriptor(&SqlConnectionKind::Sqlite).label, "SQLite");
        assert!(ensure_driver_enabled(&SqlConnectionKind::Sqlite).is_ok());
    }

    #[test]
    fn postgresql_driver_is_planned() {
        let err = ensure_driver_enabled(&SqlConnectionKind::PostgreSql).unwrap_err();
        assert!(err.contains("planned"));
    }

    #[test]
    fn mysql_driver_is_planned() {
        let err = ensure_driver_enabled(&SqlConnectionKind::MySql).unwrap_err();
        assert!(err.contains("planned"));
    }

    #[test]
    fn normalize_sqlite_connection_input_creates_connection() {
        let input = SqlConnectionInput {
            id: Some("local".to_string()),
            name: Some("Local".to_string()),
            kind: SqlConnectionKind::Sqlite,
            database_path: Some(" /tmp/app.db ".to_string()),
            host: None,
            port: None,
            database: None,
            username: None,
            password: None,
            ssl_mode: None,
            read_only: true,
            create_if_missing: true,
        };

        let connection = normalize_connection_input(&input).unwrap();

        assert_eq!(connection.id, "local");
        assert_eq!(connection.name, "Local");
        assert_eq!(connection.database_path.as_deref(), Some("/tmp/app.db"));
        assert!(connection.read_only);
    }

    #[test]
    fn normalize_sqlite_connection_input_rejects_empty_path() {
        let input = SqlConnectionInput {
            id: None,
            name: None,
            kind: SqlConnectionKind::Sqlite,
            database_path: Some(" ".to_string()),
            host: None,
            port: None,
            database: None,
            username: None,
            password: None,
            ssl_mode: None,
            read_only: false,
            create_if_missing: true,
        };

        assert!(normalize_connection_input(&input).is_err());
    }

    #[test]
    fn normalize_network_connection_input_uses_default_port() {
        let input = SqlConnectionInput {
            id: None,
            name: None,
            kind: SqlConnectionKind::PostgreSql,
            database_path: None,
            host: Some("localhost".to_string()),
            port: None,
            database: Some("app".to_string()),
            username: Some("user".to_string()),
            password: Some("secret".to_string()),
            ssl_mode: None,
            read_only: false,
            create_if_missing: false,
        };

        let connection = normalize_network_connection_input(&input).unwrap();

        assert_eq!(connection.port, Some(5432));
        assert_eq!(connection.ssl_mode, Some(SqlSslMode::Prefer));
        assert_eq!(connection.database.as_deref(), Some("app"));
    }

    #[test]
    fn memory_sqlite_connection_is_not_persistable() {
        let connection = SqlConnection {
            id: "memory".to_string(),
            name: "memory".to_string(),
            kind: SqlConnectionKind::Sqlite,
            database_path: Some(":memory:".to_string()),
            host: None,
            port: None,
            database: None,
            username: None,
            ssl_mode: None,
            read_only: false,
        };

        assert!(!is_persistable_connection(&connection));
    }
}
```

---

# 9. 修改 Rust `mod.rs`

路径：

```txt id="q1jyo9"
src-tauri/src/commands/sql/mod.rs
```

加入：

```rust id="a19mvk"
mod driver;
```

最终结构类似：

```rust id="bsc4cc"
mod connection;
pub mod dialect;
mod driver;
mod metadata;
mod persistence;
mod query;
mod state;
mod types;

pub use connection::*;
pub use metadata::*;
pub use query::*;
pub use state::SqlConnectionStore;
pub use types::*;
```

---

# 10. 修改 Rust `state.rs`

路径：

```txt id="hd1748"
src-tauri/src/commands/sql/state.rs
```

## 10.1 替换 import

当前 `state.rs` 自己持有 `normalize_connection_input()` / `is_persistable_database_path()` 这类 SQLite 逻辑。需要改成用 `driver.rs`。

在顶部增加：

```rust id="1fwrmr"
use super::driver::{is_persistable_connection, normalize_connection_input};
```

然后从本文件里删除或不再使用旧的本地 `normalize_connection_input()`。

---

## 10.2 修改 `test_connection`

把：

```rust id="j7sxch"
match normalize_connection_input(&input)
    .and_then(|connection| open_sqlite_connection(&input).map(|conn| (connection, conn)))
```

保持即可，但这里的 `normalize_connection_input()` 已经来自 `driver.rs`。非 SQLite 会返回 planned unsupported。

---

## 10.3 修改 `open_connection`

保留：

```rust id="2uz25f"
let connection = normalize_connection_input(&input)?;
```

打开 SQLite 时使用：

```rust id="vaxx1t"
let conn = open_sqlite_connection(&input)?;
```

同时 `open_sqlite_connection()` 要读取 optional path：

```rust id="hw02a2"
let database_path = input
    .database_path
    .as_deref()
    .unwrap_or("")
    .trim();
```

---

## 10.4 修改 `save_connection`

把：

```rust id="yeytkl"
if !is_persistable_database_path(&connection.database_path) {
    return Err("in-memory SQLite connections cannot be saved".to_string());
}
```

改成：

```rust id="q6q6cr"
if !is_persistable_connection(&connection) {
    return Err("in-memory SQLite connections cannot be saved".to_string());
}
```

创建 `SqlSavedConnection` 改成：

```rust id="9q940y"
let saved = SqlSavedConnection {
    id: connection.id.clone(),
    name: connection.name.clone(),
    kind: connection.kind.clone(),
    database_path: connection.database_path.clone(),
    host: connection.host.clone(),
    port: connection.port,
    database: connection.database.clone(),
    username: connection.username.clone(),
    ssl_mode: connection.ssl_mode.clone(),
    read_only: connection.read_only,
    create_if_missing: request.input.create_if_missing,
    auto_connect: request.auto_connect,
};
```

---

## 10.5 修改 `open_sqlite_connection()`

把内部 database path 获取统一改成：

```rust id="x1uz5m"
fn open_sqlite_connection(input: &SqlConnectionInput) -> Result<Connection, String> {
    if input.kind != SqlConnectionKind::Sqlite {
        return Err("only SQLite runtime driver is enabled".to_string());
    }

    let database_path = input
        .database_path
        .as_deref()
        .unwrap_or("")
        .trim();

    if database_path.is_empty() {
        return Err("databasePath must not be empty".to_string());
    }

    let mut flags = if input.read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    };

    if input.create_if_missing && !input.read_only {
        flags |= OpenFlags::SQLITE_OPEN_CREATE;
    }

    if database_path == ":memory:" {
        return Connection::open_in_memory()
            .map_err(|err| format!("failed to open in-memory SQLite database: {err}"));
    }

    let path = Path::new(database_path);

    if !input.read_only {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| {
                format!(
                    "failed to create database directory {}: {err}",
                    parent.display()
                )
            })?;
        }
    }

    Connection::open_with_flags(path, flags)
        .map_err(|err| format!("failed to open SQLite database {database_path}: {err}"))
}
```

---

## 10.6 删除旧 helper

删除旧的：

```rust id="69kfey"
fn normalize_connection_input(...)
fn is_persistable_database_path(...)
```

避免两个 normalize 来源并存。

---

# 11. Rust 测试命令

```bash id="2yh178"
cd src-tauri
cargo test sql::driver
cargo test sql
```

---

# 12. 修改 package.json 测试脚本

把 `test:sql-services` 改成包含新增 profile 测试：

```json id="6pzzlt"
{
  "scripts": {
    "test:sql-services": "node --test --import tsx src/vs/workbench/services/sql/test/sqlServices.test.ts src/vs/workbench/services/sql/test/sqlCommandExecutor.test.ts src/vs/workbench/services/sql/test/sqlConnectionProfile.test.ts"
  }
}
```

如果当前已经有更多 service test 文件，保留原有并追加 `sqlConnectionProfile.test.ts`。

---

# 13. 验收命令

```bash id="dxrh30"
pnpm run test:sql-domain
pnpm run test:sql-services
pnpm run test

cd src-tauri
cargo test sql::driver
cargo test sql

cd ..
pnpm run lint
pnpm run build
```

---

# 14. 手动验收

```txt id="mbs26k"
1. SQLite 连接功能不受影响
2. SQLite saved connection 不受影响
3. SQLite schema tree 不受影响
4. SQLite query/result 不受影响
5. 前端 driver catalog 能看到 PostgreSQL/MySQL planned
6. 尝试通过内部调用 openConnection(PostgreSQL) 会得到 planned/unsupported 错误
7. Tauri 收到 PostgreSQL/MySQL kind 会返回 unsupported，不 panic
8. 现有 UI 不出现 PostgreSQL/MySQL 可用连接入口
```

---

# Phase 9 完成标准

```txt id="qwjg0z"
前端协议支持 sqlite/postgresql/mysql
Driver Catalog 有 enabled/planned 状态
Dialect helper 支持三类基础 quote/qualified name/preview SQL
Connection Profile 能表达 file/network 两类连接
Validation 明确拒绝 planned driver
Tauri 协议支持 enum 扩展
Tauri runtime 明确只启用 SQLite
所有 SQLite 既有功能保持可用
单元测试覆盖 TS + Rust 地基
```

---

# 后续 Phase 9.1

```txt id="753dqj"
Phase 9.1：Driver Form Abstraction

1. Connection Form 改成由 driver descriptor 渲染
2. SQLite 表单保持默认
3. PostgreSQL/MySQL 只显示 Coming Soon，不允许 submit
4. 保存连接时接入 secret placeholder，不保存 password
5. 不实现真实远程连接
```

这比直接接 PostgreSQL 更安全，因为能先把 UI 与连接协议打通，又不会破坏现在 SQLite MVP。
