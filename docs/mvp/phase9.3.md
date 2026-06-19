下面给出 **Phase 9.2：MySQL Preview** 的完整设计与代码。

这次按你补充的范围处理：**MySQL Preview 不再只是 UI Preview，而是 MySQL runtime preview**，包含：

```txt id="xgvsqv"
MySQL connection
list databases
list tables
list columns
execute query
dialect SQL generation
```

当前项目已经有 `SqlConnectionKind.MySql` 和网络连接字段，但 MySQL 在 driver catalog 里还是 `Planned`。
当前 metadata service 只有 `listTables / listColumns`，还没有 `listDatabases`。
Tauri runtime 目前还是 SQLite-only，连接 handle 里只保存 `rusqlite::Connection` 和 SQLite interrupt handle。

所以 Phase 9.2 要做的是：**只启用 MySQL runtime，PostgreSQL 继续 planned**。

---

# Phase 9.2：MySQL Preview

## 目标

```txt id="cga3yd"
1. MySQL driver 从 planned 改为 enabled
2. Connection Form 支持 MySQL 可连接
3. Tauri 增加 mysql crate
4. Tauri runtime 支持 SQLite / MySQL 两种连接 handle
5. MySQL 支持 list databases
6. MySQL 支持 list tables
7. MySQL 支持 list columns
8. MySQL 支持 execute query
9. TS dialect 增加 MySQL metadata SQL generation helper
10. 测试覆盖 TS driver/form/dialect/validation，Rust 覆盖 driver/url/value conversion
```

## 不做

```txt id="ievw59"
1. 不启用 PostgreSQL runtime
2. 不保存 MySQL password 到 saved connection
3. 不做 Secret Store
4. 不做连接池配置 UI
5. 不做 MySQL explain plan
6. 不做高级 MySQL 权限/SSL 证书管理
```

---

# 1. 修改 `src-tauri/Cargo.toml`

新增依赖：

```toml id="szdyxd"
mysql = "26"
```

放在当前 `rusqlite` 附近即可。当前已有 `rusqlite` 和 `tokio`。

```toml id="djv2jj"
rusqlite = { version = "0.31", features = ["bundled"] }
mysql = "26"
tokio = { version = "1", features = ["full"] }
```

---

# 2. 修改前端协议 `sqlTypes.ts`

路径：

```txt id="11rmun"
src/vs/workbench/services/sql/common/sqlTypes.ts
```

新增 `SqlDatabase`，并保持已有字段不变：

```ts id="nl24km"
export interface SqlDatabase {
	name: string;
}
```

放在 `SqlTableType` 前后都可以，推荐放在 `SqlTableType` 前：

```ts id="pn2jia"
export interface SqlDatabase {
	name: string;
}

export const enum SqlTableType {
	Table = 'table',
	View = 'view'
}
```

---

# 3. 修改 Driver Catalog：启用 MySQL

路径：

```txt id="681enj"
src/vs/workbench/services/sql/common/sqlDrivers.ts
```

把 MySQL driver 改为 enabled：

```ts id="u0l5d0"
export const MYSQL_DRIVER: SqlDriverDescriptor = {
	id: SqlConnectionKind.MySql,
	label: 'MySQL',
	dialect: SqlDialect.MySql,
	availability: SqlDriverAvailability.Enabled,
	defaultPorts: {
		default: 3306,
		alternatives: []
	},
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
```

PostgreSQL 保持 planned，不要动。

---

# 4. 修改 SQL Validation：允许 MySQL

路径：

```txt id="74e3sj"
src/vs/workbench/services/sql/common/sqlValidation.ts
```

当前这里有一个 Phase 9 的硬 guard：

```ts id="eyv43w"
if (normalized.kind !== SqlConnectionKind.Sqlite) {
	throw new Error(`SQL driver '${normalized.kind}' is not enabled yet.`);
}
```

Phase 9.2 需要改为允许 SQLite 和 MySQL：

```ts id="c29ieo"
if (normalized.kind !== SqlConnectionKind.Sqlite && normalized.kind !== SqlConnectionKind.MySql) {
	throw new Error(`SQL driver '${normalized.kind}' is not enabled yet.`);
}
```

完整函数：

```ts id="2bfddi"
export function normalizeSqlConnectionInput(input: SqlConnectionInput): SqlConnectionInput {
	if (!input || typeof input !== 'object') {
		throw new Error('connection input must be an object');
	}

	assertSqlDriverEnabled(input.kind);

	const profile = createConnectionProfileFromInput(input);
	const normalized = toConnectionInput(profile);

	if (normalized.kind !== SqlConnectionKind.Sqlite && normalized.kind !== SqlConnectionKind.MySql) {
		throw new Error(`SQL driver '${normalized.kind}' is not enabled yet.`);
	}

	return normalized;
}
```

---

# 5. 修改 Metadata Contract：增加 listDatabases

路径：

```txt id="w2h7to"
src/vs/workbench/services/sql/common/sqlMetadata.ts
```

替换为：

```ts id="v1rgkb"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL metadata service contract.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SqlColumn, SqlDatabase, SqlListColumnsRequest, SqlTable } from './sqlTypes.js';

export const ISqlMetadataService = createDecorator<ISqlMetadataService>('sqlMetadataService');

export interface ISqlMetadataService {
	readonly _serviceBrand: undefined;

	listDatabases(connectionId: string): Promise<SqlDatabase[]>;

	listTables(connectionId: string): Promise<SqlTable[]>;

	listColumns(request: SqlListColumnsRequest): Promise<SqlColumn[]>;
}
```

---

# 6. 修改 Metadata Service：调用 Tauri `sql_list_databases`

路径：

```txt id="ajkuy6"
src/vs/workbench/services/sql/browser/sqlMetadataService.ts
```

替换为：

```ts id="75n28x"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL metadata service implementation.
 *--------------------------------------------------------------------------------------------*/

import { ISqlMetadataService } from '../common/sqlMetadata.js';
import { SqlColumn, SqlDatabase, SqlListColumnsRequest, SqlTable } from '../common/sqlTypes.js';
import { normalizeConnectionId, normalizeSqlListColumnsRequest } from '../common/sqlValidation.js';
import { ISqlCommandExecutor, TauriSqlCommandExecutor, toSqlServiceError } from './sqlCommandExecutor.js';

export class SqlMetadataService implements ISqlMetadataService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly executor: ISqlCommandExecutor = new TauriSqlCommandExecutor()) {}

	async listDatabases(connectionId: string): Promise<SqlDatabase[]> {
		const normalizedConnectionId = normalizeConnectionId(connectionId);

		try {
			const databases = await this.executor.execute<SqlDatabase[]>('sql_list_databases', {
				connectionId: normalizedConnectionId
			});

			return Array.isArray(databases) ? databases : [];
		} catch (error) {
			throw toSqlServiceError('sql_list_databases', error);
		}
	}

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

# 7. 替换 Connection Form Model：MySQL 可连接

路径：

```txt id="w8n1mb"
src/vs/workbench/contrib/sqlConnections/common/sqlConnectionFormModel.ts
```

替换为：

```ts id="bg0g91"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL connection form model.
 * Phase 9.2 enables MySQL runtime preview.
 * PostgreSQL remains preview-only.
 *--------------------------------------------------------------------------------------------*/

import {
	getSqlDriverDescriptor,
	SqlDriverAvailability
} from '../../../services/sql/common/sqlDrivers.js';
import {
	SqlConnectionInput,
	SqlConnectionKind,
	SqlSslMode
} from '../../../services/sql/common/sqlTypes.js';

export const SQL_CONNECTION_PREVIEW_KINDS: readonly SqlConnectionKind[] = [
	SqlConnectionKind.Sqlite,
	SqlConnectionKind.PostgreSql,
	SqlConnectionKind.MySql
];

export interface SqlConnectionFormState {
	readonly kind: SqlConnectionKind;
	readonly name?: string;

	readonly databasePath?: string;

	readonly host?: string;
	readonly port?: number;
	readonly database?: string;
	readonly username?: string;
	readonly password?: string;
	readonly sslMode?: SqlSslMode;

	readonly readOnly: boolean;
	readonly createIfMissing: boolean;
	readonly saveConnection: boolean;
	readonly autoConnect: boolean;
}

export interface SqlConnectionFormPreview {
	readonly kind: SqlConnectionKind;
	readonly label: string;
	readonly availability: SqlDriverAvailability;
	readonly canConnect: boolean;
	readonly canSave: boolean;
	readonly message: string;
	readonly summary: string;
	readonly input: SqlConnectionInput;
	readonly maskedInput: SqlConnectionInput;
}

export function createDefaultSqlConnectionFormState(
	kind: SqlConnectionKind = SqlConnectionKind.Sqlite
): SqlConnectionFormState {
	switch (kind) {
		case SqlConnectionKind.Sqlite:
			return {
				kind,
				name: undefined,
				databasePath: ':memory:',
				readOnly: false,
				createIfMissing: true,
				saveConnection: false,
				autoConnect: false
			};

		case SqlConnectionKind.PostgreSql:
			return createNetworkDefaults(kind, 5432, 'postgres');

		case SqlConnectionKind.MySql:
			return createNetworkDefaults(kind, 3306, 'mysql');

		default:
			return createDefaultSqlConnectionFormState(SqlConnectionKind.Sqlite);
	}
}

export function normalizeSqlConnectionFormState(input: Partial<SqlConnectionFormState>): SqlConnectionFormState {
	const kind = normalizePreviewKind(input.kind);
	const defaults = createDefaultSqlConnectionFormState(kind);

	if (kind === SqlConnectionKind.Sqlite) {
		const databasePath = input.databasePath === undefined
			? defaults.databasePath
			: normalizeOptionalString(input.databasePath) ?? '';

		return {
			...defaults,
			name: normalizeOptionalString(input.name),
			databasePath,
			readOnly: input.readOnly === true,
			createIfMissing: input.createIfMissing !== false,
			saveConnection: input.saveConnection === true,
			autoConnect: input.saveConnection === true && input.autoConnect === true
		};
	}

	const host = input.host === undefined
		? defaults.host
		: normalizeOptionalString(input.host) ?? '';

	const database = input.database === undefined
		? defaults.database
		: normalizeOptionalString(input.database) ?? '';

	const port = normalizePort(input.port, defaults.port);

	const saveConnection = kind === SqlConnectionKind.MySql && input.saveConnection === true;

	return {
		...defaults,
		name: normalizeOptionalString(input.name),
		host,
		port,
		database,
		username: normalizeOptionalString(input.username),
		password: normalizeOptionalString(input.password),
		sslMode: normalizeSslMode(input.sslMode),
		readOnly: false,
		createIfMissing: false,
		saveConnection,
		/**
		 * Phase 9.2 intentionally disallows auto-connect for MySQL because
		 * password is not persisted until Secret Store arrives.
		 */
		autoConnect: false
	};
}

export function createSqlConnectionInputFromFormState(state: Partial<SqlConnectionFormState>): SqlConnectionInput {
	const normalized = normalizeSqlConnectionFormState(state);

	if (normalized.kind === SqlConnectionKind.Sqlite) {
		return {
			name: normalized.name,
			kind: SqlConnectionKind.Sqlite,
			databasePath: normalized.databasePath,
			readOnly: normalized.readOnly,
			createIfMissing: normalized.createIfMissing
		};
	}

	return {
		name: normalized.name,
		kind: normalized.kind,
		host: normalized.host,
		port: normalized.port,
		database: normalized.database,
		username: normalized.username,
		password: normalized.password,
		sslMode: normalized.sslMode,
		readOnly: false,
		createIfMissing: false
	};
}

export function createSafeSqlConnectionInputFromFormState(state: Partial<SqlConnectionFormState>): SqlConnectionInput {
	return maskSqlConnectionInput(createSqlConnectionInputFromFormState(state));
}

export function maskSqlConnectionInput(input: SqlConnectionInput): SqlConnectionInput {
	const { password: _password, ...rest } = input;
	return rest;
}

export function createSqlConnectionFormPreview(state: Partial<SqlConnectionFormState>): SqlConnectionFormPreview {
	const normalized = normalizeSqlConnectionFormState(state);
	const rawInput = createSqlConnectionInputFromFormState(normalized);
	const descriptor = getSqlDriverDescriptor(normalized.kind);
	const maskedInput = maskSqlConnectionInput(rawInput);

	if (normalized.kind === SqlConnectionKind.Sqlite) {
		const databasePath = normalized.databasePath?.trim() ?? '';
		const canConnect = Boolean(databasePath);
		const canSave = canConnect && databasePath !== ':memory:' && normalized.saveConnection;

		return {
			kind: normalized.kind,
			label: descriptor.label,
			availability: descriptor.availability,
			canConnect,
			canSave,
			message: canConnect
				? 'SQLite is ready.'
				: 'SQLite database path is required.',
			summary: databasePath ? `SQLite · ${databasePath}` : 'SQLite · missing database path',
			input: maskedInput,
			maskedInput
		};
	}

	const host = normalized.host?.trim() ?? '';
	const database = normalized.database?.trim() ?? '';
	const port = normalized.port;

	const missingFields = [
		host ? undefined : 'host',
		port ? undefined : 'port',
		database ? undefined : 'database'
	].filter((value): value is string => Boolean(value));

	if (normalized.kind === SqlConnectionKind.PostgreSql) {
		return {
			kind: normalized.kind,
			label: descriptor.label,
			availability: descriptor.availability,
			canConnect: false,
			canSave: false,
			message: missingFields.length > 0
				? `PostgreSQL Preview is missing ${missingFields.join(', ')}. Runtime connection is not enabled yet.`
				: 'PostgreSQL is preview-only. Runtime connection is not enabled yet.',
			summary: missingFields.length > 0
				? `PostgreSQL Preview · missing ${missingFields.join(', ')}`
				: `PostgreSQL Preview · ${host}:${port}/${database}`,
			input: maskedInput,
			maskedInput
		};
	}

	const canConnect = missingFields.length === 0;
	const canSave = canConnect && normalized.saveConnection;

	return {
		kind: normalized.kind,
		label: descriptor.label,
		availability: descriptor.availability,
		canConnect,
		canSave,
		message: canConnect
			? 'MySQL runtime preview is ready.'
			: `MySQL connection is missing ${missingFields.join(', ')}.`,
		summary: canConnect
			? `MySQL · ${host}:${port}/${database}`
			: `MySQL · missing ${missingFields.join(', ')}`,
		input: maskedInput,
		maskedInput
	};
}

export function canSubmitSqlConnectionForm(state: Partial<SqlConnectionFormState>): boolean {
	return createSqlConnectionFormPreview(state).canConnect;
}

export function canSaveSqlConnectionForm(state: Partial<SqlConnectionFormState>): boolean {
	return createSqlConnectionFormPreview(state).canSave;
}

export function getSqlConnectionFormStatus(state: Partial<SqlConnectionFormState>): string {
	const preview = createSqlConnectionFormPreview(state);
	return `${preview.summary} · ${preview.message}`;
}

function createNetworkDefaults(
	kind: SqlConnectionKind.PostgreSql | SqlConnectionKind.MySql,
	port: number,
	database: string
): SqlConnectionFormState {
	return {
		kind,
		name: undefined,
		host: 'localhost',
		port,
		database,
		username: undefined,
		password: undefined,
		sslMode: SqlSslMode.Prefer,
		readOnly: false,
		createIfMissing: false,
		saveConnection: false,
		autoConnect: false
	};
}

function normalizePreviewKind(kind: SqlConnectionKind | undefined): SqlConnectionKind {
	switch (kind) {
		case SqlConnectionKind.Sqlite:
		case SqlConnectionKind.PostgreSql:
		case SqlConnectionKind.MySql:
			return kind;

		default:
			return SqlConnectionKind.Sqlite;
	}
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function normalizePort(value: number | undefined, fallback: number | undefined): number | undefined {
	if (value === undefined) {
		return fallback;
	}

	if (!Number.isFinite(value)) {
		return fallback;
	}

	const normalized = Math.floor(value);

	if (normalized <= 0 || normalized > 65_535) {
		return fallback;
	}

	return normalized;
}

function normalizeSslMode(value: SqlSslMode | undefined): SqlSslMode {
	switch (value) {
		case SqlSslMode.Disable:
		case SqlSslMode.Prefer:
		case SqlSslMode.Require:
			return value;

		default:
			return SqlSslMode.Prefer;
	}
}
```

---

# 8. 修改 Connections View：支持 MySQL Driver

路径：

```txt id="4cl9ip"
src/vs/workbench/contrib/sqlConnections/browser/sqlConnectionsView.ts
```

你已有 driver select 和 PostgreSQL fields。需要把“postgres preview”泛化成 network fields。

## 8.1 字段改名

把：

```ts id="ecr8lo"
private postgresPreviewElement!: HTMLElement;
```

改成：

```ts id="3w9vej"
private networkFieldsElement!: HTMLElement;
```

---

## 8.2 Driver option 文案

把 option 文案逻辑改成：

```ts id="j14siu"
for (const kind of SQL_CONNECTION_PREVIEW_KINDS) {
	const option = document.createElement('option');
	option.value = kind;

	switch (kind) {
		case SqlConnectionKind.Sqlite:
			option.textContent = 'SQLite';
			break;
		case SqlConnectionKind.PostgreSql:
			option.textContent = 'PostgreSQL Preview';
			break;
		case SqlConnectionKind.MySql:
			option.textContent = 'MySQL Preview';
			break;
	}

	this.driverSelect.appendChild(option);
}
```

---

## 8.3 network fields

把：

```ts id="544gdy"
this.postgresPreviewElement = append(this.form, $('.sql-connections-driver-fields.postgres'));
```

改成：

```ts id="ul074o"
this.networkFieldsElement = append(this.form, $('.sql-connections-driver-fields.network'));
```

后面所有：

```ts id="9xum7c"
this.postgresPreviewElement
```

替换成：

```ts id="w7ngse"
this.networkFieldsElement
```

---

## 8.4 driver change

把 driver change 逻辑改成：

```ts id="pr4y04"
this.formDisposables.add(
	addDisposableListener(this.driverSelect, EventType.CHANGE, () => {
		switch (this.driverSelect.value) {
			case SqlConnectionKind.PostgreSql:
				this.currentFormKind = SqlConnectionKind.PostgreSql;
				break;
			case SqlConnectionKind.MySql:
				this.currentFormKind = SqlConnectionKind.MySql;
				break;
			case SqlConnectionKind.Sqlite:
			default:
				this.currentFormKind = SqlConnectionKind.Sqlite;
				break;
		}

		this.applyFormState(createDefaultSqlConnectionFormState(this.currentFormKind));
		this.refreshDriverPreview();
	})
);
```

---

## 8.5 `addConnectionFromForm()` 允许 MySQL

把：

```ts id="c8y3v2"
if (preview.kind !== SqlConnectionKind.Sqlite) {
	this.showInfo(preview.message);
	return;
}
```

改成：

```ts id="euvmgf"
if (preview.kind === SqlConnectionKind.PostgreSql) {
	this.showInfo(preview.message);
	return;
}
```

然后：

```ts id="rdzajs"
this.showInfo('Opening SQLite connection...');
```

改成：

```ts id="12nh4y"
this.showInfo(preview.kind === SqlConnectionKind.MySql ? 'Opening MySQL connection...' : 'Opening SQLite connection...');
```

---

## 8.6 保存策略

MySQL 可以 `Connect`，但 Phase 9.2 不保存 password。建议：允许 Save，但保存的是 masked input，且强制 `autoConnect=false`。

在 `addConnectionFromForm()` 中构造 input 改成：

```ts id="n9v5re"
const rawInput: SqlConnectionInput = createSqlConnectionInputFromFormState(formState);
const safeInput: SqlConnectionInput = createSafeSqlConnectionInputFromFormState(formState);
const input = preview.kind === SqlConnectionKind.MySql ? rawInput : safeInput;
```

保存时：

```ts id="w01b2b"
const saved = await this.sqlConnectionService.saveConnection({
	input: preview.kind === SqlConnectionKind.MySql ? safeInput : input,
	autoConnect: preview.kind === SqlConnectionKind.MySql ? false : formState.autoConnect,
	openNow: preview.kind !== SqlConnectionKind.MySql
});
```

MySQL 若用户点 Save + Connect，可以先 `openConnection(rawInput)`，再 `saveConnection(safeInput, openNow:false)`：

```ts id="kb7z8c"
if (shouldSave && preview.kind === SqlConnectionKind.MySql) {
	const connection = await this.sqlConnectionService.openConnection(rawInput);

	await this.sqlConnectionService.saveConnection({
		input: safeInput,
		autoConnect: false,
		openNow: false
	});

	connectionId = connection.id;
	connectionName = connection.name;
} else if (shouldSave) {
	const saved = await this.sqlConnectionService.saveConnection({
		input,
		autoConnect: formState.autoConnect,
		openNow: true
	});

	connectionId = saved.id;
	connectionName = saved.name;
} else {
	const connection = await this.sqlConnectionService.openConnection(input);

	connectionId = connection.id;
	connectionName = connection.name;
}
```

---

## 8.7 `refreshDriverPreview()`

替换核心逻辑：

```ts id="klqivg"
private refreshDriverPreview(): void {
	const formState = this.getFormState();
	const preview = createSqlConnectionFormPreview(formState);
	const isSqlite = preview.kind === SqlConnectionKind.Sqlite;
	const isPostgres = preview.kind === SqlConnectionKind.PostgreSql;
	const isMysql = preview.kind === SqlConnectionKind.MySql;

	this.sqliteFieldsElement.classList.toggle('hidden', !isSqlite);
	this.networkFieldsElement.classList.toggle('hidden', isSqlite);

	this.readOnlyInput.disabled = !isSqlite;
	this.createIfMissingInput.disabled = !isSqlite;
	this.saveConnectionInput.disabled = isPostgres;
	this.autoConnectInput.disabled = !isSqlite || !this.saveConnectionInput.checked;

	if (!isSqlite) {
		this.readOnlyInput.checked = false;
		this.createIfMissingInput.checked = false;
		this.autoConnectInput.checked = false;
	}

	if (isPostgres) {
		this.saveConnectionInput.checked = false;
	}

	this.connectButton.disabled = !preview.canConnect;

	clearNode(this.driverPreviewElement);

	const title = append(this.driverPreviewElement, $('.sql-connection-driver-preview-title'));
	title.textContent = preview.summary;

	const message = append(this.driverPreviewElement, $('.sql-connection-driver-preview-message'));
	message.textContent = preview.message;

	if (isMysql) {
		const note = append(this.driverPreviewElement, $('.sql-connection-driver-preview-note'));
		note.textContent = 'MySQL runtime preview is enabled. Password is only used for the current connection and is not saved.';
	}

	if (isPostgres) {
		const note = append(this.driverPreviewElement, $('.sql-connection-driver-preview-note'));
		note.textContent = 'PostgreSQL remains preview-only. Runtime connection is not enabled in this phase.';
	}
}
```

---

# 9. Dialect SQL generation：补 MySQL metadata SQL helpers

路径：

```txt id="149z7r"
src/vs/workbench/services/sql/common/sqlDialect.ts
```

追加：

```ts id="4hctoq"
export function createListDatabasesSql(dialect: SqlDialect): string {
	switch (dialect) {
		case SqlDialect.MySql:
			return 'SHOW DATABASES;';

		case SqlDialect.Sqlite:
			return 'PRAGMA database_list;';

		case SqlDialect.PostgreSql:
			return `SELECT datname AS name
FROM pg_database
WHERE datistemplate = false
ORDER BY datname;
`;

		default:
			return assertNever(dialect);
	}
}

export function createListTablesSql(dialect: SqlDialect, database?: string): string {
	switch (dialect) {
		case SqlDialect.MySql:
			return `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = ${mysqlStringLiteral(database ?? '')}
ORDER BY TABLE_TYPE, TABLE_NAME;
`;

		case SqlDialect.Sqlite:
			return `SELECT name, type
FROM sqlite_master
WHERE type IN ('table', 'view')
  AND name NOT LIKE 'sqlite_%'
ORDER BY type, name;
`;

		case SqlDialect.PostgreSql:
			return `SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_type, table_name;
`;

		default:
			return assertNever(dialect);
	}
}

export function createListColumnsSql(dialect: SqlDialect, schema: string | undefined, tableName: string): string {
	switch (dialect) {
		case SqlDialect.MySql:
			return `SELECT ORDINAL_POSITION, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ${mysqlStringLiteral(schema ?? '')}
  AND TABLE_NAME = ${mysqlStringLiteral(tableName)}
ORDER BY ORDINAL_POSITION;
`;

		case SqlDialect.Sqlite:
			return `PRAGMA table_info(${quoteSqlIdentifier(SqlDialect.Sqlite, tableName)});`;

		case SqlDialect.PostgreSql:
			return `SELECT ordinal_position, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = ${postgresStringLiteral(schema ?? 'public')}
  AND table_name = ${postgresStringLiteral(tableName)}
ORDER BY ordinal_position;
`;

		default:
			return assertNever(dialect);
	}
}

function mysqlStringLiteral(value: string): string {
	return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}

function postgresStringLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}
```

---

# 10. Rust：新增 MySQL runtime module

路径：

```txt id="r0sn6a"
src-tauri/src/commands/sql/mysql_runtime.rs
```

```rust id="focxvo"
use super::types::{
    SqlCellValue, SqlColumn, SqlConnection, SqlConnectionInput, SqlDatabase, SqlQueryResult,
    SqlResultColumn, SqlSslMode, SqlTable, SqlTableType, MAX_QUERY_ROW_LIMIT,
};
use mysql::prelude::Queryable;
use mysql::{OptsBuilder, Pool, PooledConn, Row, SslOpts, Value};
use std::time::Instant;

pub fn open_mysql_pool(input: &SqlConnectionInput) -> Result<Pool, String> {
    let host = required(input.host.as_deref(), "host")?;
    let database = required(input.database.as_deref(), "database")?;
    let port = input.port.unwrap_or(3306);
    let username = optional(input.username.as_deref());
    let password = optional(input.password.as_deref());

    let mut builder = OptsBuilder::new()
        .ip_or_hostname(Some(host))
        .tcp_port(port)
        .db_name(Some(database));

    if let Some(username) = username {
        builder = builder.user(Some(username));
    }

    if let Some(password) = password {
        builder = builder.pass(Some(password));
    }

    if matches!(input.ssl_mode, Some(SqlSslMode::Require)) {
        builder = builder.ssl_opts(Some(SslOpts::default()));
    }

    Pool::new(builder).map_err(|err| format!("failed to create MySQL pool: {err}"))
}

pub fn test_mysql_connection(pool: &Pool) -> Result<(), String> {
    let mut conn = pool
        .get_conn()
        .map_err(|err| format!("failed to get MySQL connection: {err}"))?;

    conn.query_drop("SELECT 1")
        .map_err(|err| format!("failed to validate MySQL connection: {err}"))
}

pub fn list_mysql_databases(pool: &Pool) -> Result<Vec<SqlDatabase>, String> {
    let mut conn = pooled(pool)?;

    conn.query_map("SHOW DATABASES", |name: String| SqlDatabase { name })
        .map_err(|err| format!("failed to list MySQL databases: {err}"))
}

pub fn list_mysql_tables(pool: &Pool, database: Option<&str>) -> Result<Vec<SqlTable>, String> {
    let mut conn = pooled(pool)?;
    let database = match database {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => conn
            .query_first::<String, _>("SELECT DATABASE()")
            .map_err(|err| format!("failed to read current MySQL database: {err}"))?
            .ok_or_else(|| "MySQL connection has no selected database".to_string())?,
    };

    let rows: Vec<(String, String, String)> = conn
        .exec(
            "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
             FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = ?
             ORDER BY TABLE_TYPE, TABLE_NAME",
            (database,),
        )
        .map_err(|err| format!("failed to list MySQL tables: {err}"))?;

    Ok(rows
        .into_iter()
        .map(|(schema, name, raw_type)| SqlTable {
            schema: Some(schema),
            name,
            table_type: if raw_type.eq_ignore_ascii_case("VIEW") {
                SqlTableType::View
            } else {
                SqlTableType::Table
            },
        })
        .collect())
}

pub fn list_mysql_columns(
    pool: &Pool,
    schema: Option<&str>,
    table_name: &str,
) -> Result<Vec<SqlColumn>, String> {
    let mut conn = pooled(pool)?;
    let schema = match schema {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => conn
            .query_first::<String, _>("SELECT DATABASE()")
            .map_err(|err| format!("failed to read current MySQL database: {err}"))?
            .ok_or_else(|| "MySQL connection has no selected database".to_string())?,
    };

    let rows: Vec<(u64, String, Option<String>, String, Option<String>, Option<String>)> = conn
        .exec(
            "SELECT ORDINAL_POSITION, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT
             FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = ?
               AND TABLE_NAME = ?
             ORDER BY ORDINAL_POSITION",
            (schema, table_name.trim()),
        )
        .map_err(|err| format!("failed to list MySQL columns: {err}"))?;

    Ok(rows
        .into_iter()
        .map(|(ordinal, name, data_type, nullable, column_key, default_value)| SqlColumn {
            name,
            ordinal: i64::try_from(ordinal.saturating_sub(1)).unwrap_or(i64::MAX),
            data_type,
            not_null: nullable.eq_ignore_ascii_case("NO"),
            primary_key: column_key.as_deref() == Some("PRI"),
            default_value,
        })
        .collect())
}

pub fn execute_mysql_query(pool: &Pool, sql: &str, limit: usize) -> Result<SqlQueryResult, String> {
    let mut conn = pooled(pool)?;
    let sql = sql.trim();

    if is_mysql_select_like(sql) {
        execute_mysql_select(&mut conn, sql, limit)
    } else {
        let started_at = Instant::now();

        conn.query_drop(sql)
            .map_err(|err| format!("failed to execute MySQL statement: {err}"))?;

        Ok(SqlQueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows: Some(usize::try_from(conn.affected_rows()).unwrap_or(usize::MAX)),
            row_count: 0,
            elapsed_ms: elapsed_ms(started_at),
            truncated: false,
        })
    }
}

fn execute_mysql_select(conn: &mut PooledConn, sql: &str, limit: usize) -> Result<SqlQueryResult, String> {
    let started_at = Instant::now();
    let limit = limit.min(MAX_QUERY_ROW_LIMIT);
    let mut result = conn
        .query_iter(sql)
        .map_err(|err| format!("failed to execute MySQL query: {err}"))?;

    let columns = result
        .columns()
        .as_ref()
        .iter()
        .enumerate()
        .map(|(index, column)| SqlResultColumn {
            name: column.name_str().into_owned(),
            ordinal: index,
        })
        .collect::<Vec<_>>();

    let mut rows = Vec::new();
    let mut truncated = false;

    while let Some(row) = result.next() {
        let row = row.map_err(|err| format!("failed to read MySQL row: {err}"))?;

        if rows.len() >= limit {
            truncated = true;
            break;
        }

        rows.push(row_to_cells(row));
    }

    Ok(SqlQueryResult {
        columns,
        row_count: rows.len(),
        rows,
        affected_rows: None,
        elapsed_ms: elapsed_ms(started_at),
        truncated,
    })
}

fn row_to_cells(row: Row) -> Vec<SqlCellValue> {
    row.unwrap()
        .into_iter()
        .map(mysql_value_to_cell)
        .collect()
}

pub fn mysql_value_to_cell(value: Value) -> SqlCellValue {
    match value {
        Value::NULL => SqlCellValue::null(),
        Value::Bytes(bytes) => match String::from_utf8(bytes.clone()) {
            Ok(text) => SqlCellValue::text(text),
            Err(_) => {
                use base64::{engine::general_purpose, Engine as _};
                SqlCellValue::blob(general_purpose::STANDARD.encode(bytes), bytes.len())
            }
        },
        Value::Int(value) => SqlCellValue::integer(value),
        Value::UInt(value) => {
            let signed = i64::try_from(value).unwrap_or(i64::MAX);
            SqlCellValue::integer(signed)
        }
        Value::Float(value) => SqlCellValue::real(f64::from(value)),
        Value::Double(value) => SqlCellValue::real(value),
        Value::Date(year, month, day, hour, minute, second, micros) => {
            SqlCellValue::text(format!(
                "{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}.{micros:06}"
            ))
        }
        Value::Time(is_negative, days, hours, minutes, seconds, micros) => {
            let sign = if is_negative { "-" } else { "" };
            SqlCellValue::text(format!(
                "{sign}{days} {hours:02}:{minutes:02}:{seconds:02}.{micros:06}"
            ))
        }
    }
}

fn pooled(pool: &Pool) -> Result<PooledConn, String> {
    pool.get_conn()
        .map_err(|err| format!("failed to get MySQL connection: {err}"))
}

fn is_mysql_select_like(sql: &str) -> bool {
    matches!(
        first_sql_keyword(sql).as_deref(),
        Some("select" | "show" | "describe" | "desc" | "explain" | "with")
    )
}

fn first_sql_keyword(sql: &str) -> Option<String> {
    let trimmed = sql.trim_start();
    let keyword = trimmed
        .split(|ch: char| !ch.is_ascii_alphabetic() && ch != '_')
        .next()?
        .to_ascii_lowercase();

    if keyword.is_empty() {
        None
    } else {
        Some(keyword)
    }
}

fn required(value: Option<&str>, field: &str) -> Result<String, String> {
    let value = value.unwrap_or("").trim();

    if value.is_empty() {
        return Err(format!("{field} must not be empty"));
    }

    Ok(value.to_string())
}

fn optional(value: Option<&str>) -> Option<String> {
    let value = value?.trim();

    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn elapsed_ms(started_at: Instant) -> u64 {
    u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mysql::Value;

    #[test]
    fn mysql_value_to_cell_handles_null() {
        assert_eq!(mysql_value_to_cell(Value::NULL), SqlCellValue::null());
    }

    #[test]
    fn mysql_value_to_cell_handles_text() {
        assert_eq!(mysql_value_to_cell(Value::Bytes(b"hello".to_vec())), SqlCellValue::text("hello"));
    }

    #[test]
    fn mysql_value_to_cell_handles_int() {
        assert_eq!(mysql_value_to_cell(Value::Int(42)), SqlCellValue::integer(42));
    }

    #[test]
    fn mysql_value_to_cell_handles_uint_overflow() {
        assert_eq!(mysql_value_to_cell(Value::UInt(u64::MAX)), SqlCellValue::integer(i64::MAX));
    }

    #[test]
    fn mysql_select_like_detects_show() {
        assert!(is_mysql_select_like("SHOW DATABASES"));
        assert!(is_mysql_select_like("describe users"));
        assert!(!is_mysql_select_like("insert into users values (1)"));
    }
}
```

---

# 11. 修改 Rust `mod.rs`

路径：

```txt id="t3zktv"
src-tauri/src/commands/sql/mod.rs
```

加入：

```rust id="a2v5zq"
mod mysql_runtime;
```

最终：

```rust id="nfko3c"
mod connection;
pub mod dialect;
mod driver;
mod metadata;
mod mysql_runtime;
mod persistence;
mod query;
pub mod state;
pub mod types;

pub use connection::*;
pub use metadata::*;
pub use query::*;
pub use state::SqlConnectionStore;
#[allow(unused_imports)]
pub use types::*;
```

---

# 12. 修改 Rust `types.rs`：新增 SqlDatabase

路径：

```txt id="nwphid"
src-tauri/src/commands/sql/types.rs
```

在 `SqlConnectionTestResult` 后、`SqlTableType` 前新增：

```rust id="52r9i4"
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlDatabase {
    pub name: String,
}
```

---

# 13. 修改 Rust Driver：启用 MySQL

路径：

```txt id="pvt3ek"
src-tauri/src/commands/sql/driver.rs
```

把 MySQL descriptor 改为 enabled。

```rust id="942qwd"
SqlDriverDescriptor {
    kind: SqlConnectionKind::MySql,
    label: "MySQL",
    availability: SqlDriverAvailability::Enabled,
    default_port: Some(3306),
    file_based: false,
    remote: true,
},
```

同时 `normalize_connection_input()` 改成支持 MySQL：

```rust id="jm1dxo"
pub fn normalize_connection_input(input: &SqlConnectionInput) -> Result<SqlConnection, String> {
    ensure_driver_enabled(&input.kind)?;

    match input.kind {
        SqlConnectionKind::Sqlite => normalize_sqlite_connection_input(input),
        SqlConnectionKind::MySql => normalize_network_connection_input(input),
        SqlConnectionKind::PostgreSql => {
            Err("SQL driver 'PostgreSQL' is not enabled yet".to_string())
        }
    }
}
```

---

# 14. 修改 Rust State：runtime handle 支持 SQLite/MySQL

路径：

```txt id="mzg9g9"
src-tauri/src/commands/sql/state.rs
```

## 14.1 imports

增加：

```rust id="5p1lq4"
use super::mysql_runtime::{
    execute_mysql_query, list_mysql_columns, list_mysql_databases, list_mysql_tables,
    open_mysql_pool, test_mysql_connection,
};
use mysql::Pool;
```

types import 增加：

```rust id="4573fp"
SqlDatabase
```

---

## 14.2 替换 handle

把：

```rust id="7jixse"
struct SqlConnectionHandle {
    info: SqlConnection,
    conn: Mutex<Connection>,
    interrupt: InterruptHandle,
}
```

替换成：

```rust id="l70xe4"
enum SqlRuntimeConnection {
    Sqlite {
        conn: Mutex<Connection>,
        interrupt: InterruptHandle,
    },
    MySql {
        pool: Pool,
    },
}

struct SqlConnectionHandle {
    info: SqlConnection,
    runtime: SqlRuntimeConnection,
}
```

---

## 14.3 `test_connection()`

替换为：

```rust id="kjh7ff"
#[allow(clippy::unused_self, clippy::needless_pass_by_value)]
pub fn test_connection(&self, input: SqlConnectionInput) -> SqlConnectionTestResult {
    match normalize_connection_input(&input) {
        Ok(connection) => {
            let result = match connection.kind {
                SqlConnectionKind::Sqlite => open_sqlite_connection(&input)
                    .and_then(|conn| conn.query_row("SELECT 1", [], |_| Ok(())).map_err(|err| err.to_string())),
                SqlConnectionKind::MySql => open_mysql_pool(&input)
                    .and_then(|pool| test_mysql_connection(&pool)),
                SqlConnectionKind::PostgreSql => Err("SQL driver 'PostgreSQL' is not enabled yet".to_string()),
            };

            match result {
                Ok(()) => SqlConnectionTestResult::ok(connection),
                Err(error) => SqlConnectionTestResult::error(error),
            }
        }
        Err(error) => SqlConnectionTestResult::error(error),
    }
}
```

---

## 14.4 `open_connection()`

替换打开 runtime 部分：

```rust id="vvt08k"
let runtime = match connection.kind {
    SqlConnectionKind::Sqlite => {
        let conn = open_sqlite_connection(&input)?;
        let interrupt = conn.get_interrupt_handle();

        SqlRuntimeConnection::Sqlite {
            conn: Mutex::new(conn),
            interrupt,
        }
    }
    SqlConnectionKind::MySql => {
        let pool = open_mysql_pool(&input)?;
        test_mysql_connection(&pool)?;

        SqlRuntimeConnection::MySql { pool }
    }
    SqlConnectionKind::PostgreSql => {
        return Err("SQL driver 'PostgreSQL' is not enabled yet".to_string());
    }
};

let handle = Arc::new(SqlConnectionHandle {
    info: connection.clone(),
    runtime,
});
```

---

## 14.5 新增 `list_databases()`

放在 `list_connections()` 后：

```rust id="e3fd76"
pub fn list_databases(&self, connection_id: &str) -> Result<Vec<SqlDatabase>, String> {
    let handle = self.connection(connection_id)?;

    match &handle.runtime {
        SqlRuntimeConnection::Sqlite { .. } => Ok(vec![SqlDatabase {
            name: "main".to_string(),
        }]),
        SqlRuntimeConnection::MySql { pool } => list_mysql_databases(pool),
    }
}
```

---

## 14.6 替换 `list_tables()`

当前 `list_tables()` 是 SQLite-only。

改成：

```rust id="b6pkn6"
pub fn list_tables(&self, connection_id: &str) -> Result<Vec<SqlTable>, String> {
    let handle = self.connection(connection_id)?;

    match &handle.runtime {
        SqlRuntimeConnection::Sqlite { conn, .. } => {
            let conn = conn.lock().map_err(|err| err.to_string())?;

            let mut stmt = conn
                .prepare(
                    "SELECT name, type
                     FROM sqlite_master
                     WHERE type IN ('table', 'view')
                       AND name NOT LIKE 'sqlite_%'
                     ORDER BY type, name",
                )
                .map_err(|err| format!("failed to prepare table metadata query: {err}"))?;

            let rows = stmt
                .query_map([], |row| {
                    let name = row.get::<_, String>(0)?;
                    let raw_type = row.get::<_, String>(1)?;
                    let table_type = if raw_type.eq_ignore_ascii_case("view") {
                        SqlTableType::View
                    } else {
                        SqlTableType::Table
                    };

                    Ok(SqlTable {
                        schema: Some("main".to_string()),
                        name,
                        table_type,
                    })
                })
                .map_err(|err| format!("failed to query table metadata: {err}"))?;

            collect_rows(rows, "failed to read table metadata row")
        }
        SqlRuntimeConnection::MySql { pool } => list_mysql_tables(pool, handle.info.database.as_deref()),
    }
}
```

---

## 14.7 替换 `list_columns()`

当前 `list_columns()` 也是 SQLite-only。

改成：

```rust id="9f5pbv"
#[allow(clippy::needless_pass_by_value)]
pub fn list_columns(&self, request: SqlListColumnsRequest) -> Result<Vec<SqlColumn>, String> {
    let handle = self.connection(&request.connection_id)?;

    match &handle.runtime {
        SqlRuntimeConnection::Sqlite { conn, .. } => {
            let conn = conn.lock().map_err(|err| err.to_string())?;

            let table_name = quote_sqlite_identifier(&request.table_name)?;
            let sql = format!("PRAGMA table_info({table_name})");

            let mut stmt = conn
                .prepare(&sql)
                .map_err(|err| format!("failed to prepare column metadata query: {err}"))?;

            let rows = stmt
                .query_map([], |row| {
                    let data_type = row.get::<_, Option<String>>(2)?;

                    Ok(SqlColumn {
                        ordinal: row.get::<_, i64>(0)?,
                        name: row.get::<_, String>(1)?,
                        data_type: data_type.filter(|value| !value.trim().is_empty()),
                        not_null: row.get::<_, i64>(3)? != 0,
                        default_value: row.get::<_, Option<String>>(4)?,
                        primary_key: row.get::<_, i64>(5)? != 0,
                    })
                })
                .map_err(|err| format!("failed to query column metadata: {err}"))?;

            collect_rows(rows, "failed to read column metadata row")
        }
        SqlRuntimeConnection::MySql { pool } => {
            list_mysql_columns(pool, request.schema.as_deref().or(handle.info.database.as_deref()), &request.table_name)
        }
    }
}
```

---

## 14.8 修改 `execute_query()`

在拿到 handle 后分支：

```rust id="d7gwbw"
let handle = self.connection(&request.connection_id)?;

match &handle.runtime {
    SqlRuntimeConnection::Sqlite { conn, .. } => {
        // 保留原 SQLite execute_query 主体，把原来的 handle.conn 改成 conn
    }
    SqlRuntimeConnection::MySql { pool } => execute_mysql_query(pool, sql, limit),
}
```

也就是原 SQLite 逻辑只包进 `SqlRuntimeConnection::Sqlite` 分支；MySQL 分支调用 `execute_mysql_query()`。

---

## 14.9 修改 `cancel_query()`

```rust id="hctf5h"
pub fn cancel_query(
    &self,
    request: SqlCancelQueryRequest,
) -> Result<SqlCancelQueryResult, String> {
    let handle = self.connection(&request.connection_id)?;

    match &handle.runtime {
        SqlRuntimeConnection::Sqlite { interrupt, .. } => {
            interrupt.interrupt();

            Ok(SqlCancelQueryResult {
                cancelled: true,
                connection_id: request.connection_id,
                query_id: request.query_id,
                message: "interrupt signal sent to SQLite connection".to_string(),
            })
        }
        SqlRuntimeConnection::MySql { .. } => Ok(SqlCancelQueryResult {
            cancelled: false,
            connection_id: request.connection_id,
            query_id: request.query_id,
            message: "MySQL query cancellation is not supported in Phase 9.2".to_string(),
        }),
    }
}
```

---

# 15. 修改 Rust metadata commands

路径：

```txt id="vr2gkr"
src-tauri/src/commands/sql/metadata.rs
```

替换为：

```rust id="tq0ywd"
use super::state::SqlConnectionStore;
use super::types::{SqlColumn, SqlDatabase, SqlListColumnsRequest, SqlTable};
use std::sync::Arc;
use tauri::State;

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn sql_list_databases(
    state: State<'_, Arc<SqlConnectionStore>>,
    connection_id: String,
) -> Result<Vec<SqlDatabase>, String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.list_databases(&connection_id))
        .await
        .map_err(|err| format!("sql_list_databases task failed: {err}"))?
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn sql_list_tables(
    state: State<'_, Arc<SqlConnectionStore>>,
    connection_id: String,
) -> Result<Vec<SqlTable>, String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.list_tables(&connection_id))
        .await
        .map_err(|err| format!("sql_list_tables task failed: {err}"))?
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn sql_list_columns(
    state: State<'_, Arc<SqlConnectionStore>>,
    request: SqlListColumnsRequest,
) -> Result<Vec<SqlColumn>, String> {
    let store = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || store.list_columns(request))
        .await
        .map_err(|err| format!("sql_list_columns task failed: {err}"))?
}
```

---

# 16. 注册 Tauri command

在 Tauri `invoke_handler` 所在文件里追加：

```rust id="y65yrx"
sql_list_databases,
```

通常类似：

```rust id="cwvlfr"
tauri::generate_handler![
    sql_open_connection,
    sql_close_connection,
    sql_list_connections,
    sql_list_databases,
    sql_list_tables,
    sql_list_columns,
    sql_execute_query,
    ...
]
```

---

# 17. 单元测试：前端 form model

路径：

```txt id="nhhodx"
src/vs/workbench/contrib/sqlConnections/test/sqlConnectionFormModel.test.ts
```

追加：

```ts id="i3e16o"
test('SQL_CONNECTION_PREVIEW_KINDS exposes SQLite PostgreSQL and MySQL', () => {
	assert.deepEqual(SQL_CONNECTION_PREVIEW_KINDS, [
		SqlConnectionKind.Sqlite,
		SqlConnectionKind.PostgreSql,
		SqlConnectionKind.MySql
	]);
});

test('createDefaultSqlConnectionFormState creates MySQL defaults', () => {
	assert.deepEqual(createDefaultSqlConnectionFormState(SqlConnectionKind.MySql), {
		kind: SqlConnectionKind.MySql,
		name: undefined,
		host: 'localhost',
		port: 3306,
		database: 'mysql',
		username: undefined,
		password: undefined,
		sslMode: SqlSslMode.Prefer,
		readOnly: false,
		createIfMissing: false,
		saveConnection: false,
		autoConnect: false
	});
});

test('createSqlConnectionFormPreview allows MySQL connect', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: 'app',
		username: 'root',
		password: 'secret'
	});

	assert.equal(preview.label, 'MySQL');
	assert.equal(preview.availability, SqlDriverAvailability.Enabled);
	assert.equal(preview.canConnect, true);
	assert.equal(preview.canSave, false);
	assert.equal(preview.summary, 'MySQL · localhost:3306/app');
	assert.equal(preview.input.password, undefined);
});

test('canSaveSqlConnectionForm allows MySQL public profile save without auto connect', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: 'app',
		saveConnection: true,
		autoConnect: true
	});

	assert.equal(preview.canConnect, true);
	assert.equal(preview.canSave, true);

	const state = normalizeSqlConnectionFormState({
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: 'app',
		saveConnection: true,
		autoConnect: true
	});

	assert.equal(state.saveConnection, true);
	assert.equal(state.autoConnect, false);
});

test('MySQL preview reports missing database', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: ''
	});

	assert.equal(preview.canConnect, false);
	assert.equal(preview.summary, 'MySQL · missing database');
	assert.equal(preview.message, 'MySQL connection is missing database.');
});
```

---

# 18. 单元测试：前端 Driver / Validation / Dialect

## `sqlDrivers.test.ts`

把 MySQL 断言从 planned 改为 enabled：

```ts id="hwoovr"
test('MySQL driver is enabled', () => {
	const mysql = getSqlDriverDescriptor(SqlConnectionKind.MySql);

	assert.equal(mysql.label, 'MySQL');
	assert.equal(mysql.dialect, SqlDialect.MySql);
	assert.equal(mysql.availability, SqlDriverAvailability.Enabled);
	assert.equal(mysql.defaultPorts?.default, 3306);
	assert.equal(mysql.capabilities.remote, true);
	assert.equal(mysql.capabilities.credentials, true);
	assert.equal(isSqlDriverEnabled(SqlConnectionKind.MySql), true);
	assert.doesNotThrow(() => assertSqlDriverEnabled(SqlConnectionKind.MySql));
});
```

`listEnabledSqlDrivers` 改成：

```ts id="q1qtr8"
assert.deepEqual(
	listEnabledSqlDrivers().map(driver => driver.id),
	[SqlConnectionKind.Sqlite, SqlConnectionKind.MySql]
);
```

`listPlannedSqlDrivers` 改成只剩 PostgreSQL：

```ts id="y2663b"
assert.deepEqual(
	listPlannedSqlDrivers().map(driver => driver.id),
	[SqlConnectionKind.PostgreSql]
);
```

---

## `sqlServices.test.ts`

把旧的 “rejects planned MySQL driver” 删除，改成：

```ts id="6rz2ti"
test('normalizeSqlConnectionInput accepts enabled MySQL driver', () => {
	assert.deepEqual(
		normalizeSqlConnectionInput({
			kind: SqlConnectionKind.MySql,
			host: ' localhost ',
			port: 3306,
			database: ' app ',
			username: ' root ',
			password: ' secret ',
			sslMode: SqlSslMode.Prefer
		}),
		{
			kind: SqlConnectionKind.MySql,
			host: 'localhost',
			port: 3306,
			database: 'app',
			username: 'root',
			sslMode: SqlSslMode.Prefer,
			readOnly: false
		}
	);
});
```

注意：`toConnectionInput(profile)` 不返回 password，这是对的，因为 password 不能保存/日志化；真实连接由 form 的 raw input 传入 Tauri。

---

## `sqlDialect.test.ts`

追加 metadata SQL generation 测试：

```ts id="bnis1n"
test('createListDatabasesSql creates MySQL SQL', () => {
	assert.equal(createListDatabasesSql(SqlDialect.MySql), 'SHOW DATABASES;');
});

test('createListTablesSql creates MySQL SQL', () => {
	assert.equal(
		createListTablesSql(SqlDialect.MySql, 'app'),
		`SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'app'
ORDER BY TABLE_TYPE, TABLE_NAME;
`
	);
});

test('createListColumnsSql creates MySQL SQL', () => {
	assert.equal(
		createListColumnsSql(SqlDialect.MySql, 'app', 'users'),
		`SELECT ORDINAL_POSITION, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'app'
  AND TABLE_NAME = 'users'
ORDER BY ORDINAL_POSITION;
`
	);
});
```

并补 import：

```ts id="u1cbw7"
createListDatabasesSql,
createListTablesSql,
createListColumnsSql
```

---

# 19. Rust 单元测试

`mysql_runtime.rs` 已经包含 value conversion 测试。

再在 `driver.rs` 测试里把 MySQL planned 改为 enabled：

```rust id="80z6o3"
#[test]
fn mysql_driver_is_enabled() {
    assert_eq!(get_driver_descriptor(&SqlConnectionKind::MySql).label, "MySQL");
    assert!(ensure_driver_enabled(&SqlConnectionKind::MySql).is_ok());
}
```

新增 normalize MySQL input 测试：

```rust id="pz5hfy"
#[test]
fn normalize_mysql_connection_input_creates_network_connection() {
    let input = SqlConnectionInput {
        id: Some("mysql-local".to_string()),
        name: Some("Local MySQL".to_string()),
        kind: SqlConnectionKind::MySql,
        database_path: None,
        host: Some(" localhost ".to_string()),
        port: None,
        database: Some(" app ".to_string()),
        username: Some(" root ".to_string()),
        password: Some(" secret ".to_string()),
        ssl_mode: None,
        read_only: false,
        create_if_missing: false,
    };

    let connection = normalize_connection_input(&input).unwrap();

    assert_eq!(connection.id, "mysql-local");
    assert_eq!(connection.name, "Local MySQL");
    assert_eq!(connection.kind, SqlConnectionKind::MySql);
    assert_eq!(connection.host.as_deref(), Some("localhost"));
    assert_eq!(connection.port, Some(3306));
    assert_eq!(connection.database.as_deref(), Some("app"));
    assert_eq!(connection.username.as_deref(), Some("root"));
}
```

---

# 20. 可选 MySQL 集成测试

不建议默认跑真实 MySQL。可以加一个 `#[ignore]` 测试，手动跑：

```rust id="qbdpmm"
#[test]
#[ignore]
fn mysql_runtime_smoke_test() {
    let input = SqlConnectionInput {
        id: Some("mysql-smoke".to_string()),
        name: Some("MySQL Smoke".to_string()),
        kind: SqlConnectionKind::MySql,
        database_path: None,
        host: Some(std::env::var("SQL_STUDIO_MYSQL_HOST").unwrap_or_else(|_| "127.0.0.1".to_string())),
        port: Some(
            std::env::var("SQL_STUDIO_MYSQL_PORT")
                .ok()
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(3306),
        ),
        database: Some(std::env::var("SQL_STUDIO_MYSQL_DATABASE").unwrap_or_else(|_| "mysql".to_string())),
        username: std::env::var("SQL_STUDIO_MYSQL_USER").ok(),
        password: std::env::var("SQL_STUDIO_MYSQL_PASSWORD").ok(),
        ssl_mode: None,
        read_only: false,
        create_if_missing: false,
    };

    let pool = open_mysql_pool(&input).unwrap();
    test_mysql_connection(&pool).unwrap();

    let databases = list_mysql_databases(&pool).unwrap();
    assert!(!databases.is_empty());
}
```

手动执行：

```bash id="kvpzi3"
SQL_STUDIO_MYSQL_HOST=127.0.0.1 \
SQL_STUDIO_MYSQL_PORT=3306 \
SQL_STUDIO_MYSQL_DATABASE=mysql \
SQL_STUDIO_MYSQL_USER=root \
SQL_STUDIO_MYSQL_PASSWORD=xxx \
cargo test mysql_runtime_smoke_test -- --ignored
```

---

# 21. 验收命令

```bash id="lh0kez"
pnpm run test:sql-connections
pnpm run test:sql-domain
pnpm run test:sql-services
pnpm run test
pnpm run lint
pnpm run build

cd src-tauri
cargo test sql::mysql_runtime
cargo test sql::driver
cargo test sql
cargo check
```

---

# 22. 手动验收

```txt id="2f8n9j"
1. 启动应用
2. SQL Connections Driver 选择 MySQL Preview
3. 输入 host / port / database / username / password
4. Connect 可点击
5. 连接成功后出现在 Connections Tree
6. list databases 能返回 MySQL databases
7. list tables 能返回当前 database 的 tables/views
8. 展开表能 list columns
9. 执行 SELECT 1 能返回结果
10. 执行 SHOW DATABASES 能返回结果
11. Save MySQL 连接不会保存 password
12. MySQL saved connection 不会 autoConnect
13. PostgreSQL 仍然 Connect 置灰
14. SQLite 原流程不受影响
```

---

# Phase 9.2 完成标准

```txt id="rxfs7b"
MySQL driver enabled
MySQL connection runtime 可用
MySQL list databases 可用
MySQL list tables 可用
MySQL list columns 可用
MySQL execute query 可用
MySQL dialect metadata SQL generation 可测
password 不落盘
PostgreSQL 仍 planned
SQLite 不回退
```

---

# 后续 Phase 9.3

```txt id="5h3v04"
Phase 9.3：Secret Store

1. 抽 ISqlSecretStore
2. 保存 MySQL password 到 OS keychain 或本地加密 store
3. Saved MySQL connection 只保存 secretRef
4. autoConnect 才能支持 MySQL
5. 删除所有 raw password 日志路径
```
