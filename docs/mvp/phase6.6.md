# Phase 6.6：SQL Domain Cleanup

## 定位

Phase 6.6 是 **内部清理阶段**，不是新的产品功能阶段。

目标：

```txt
把 SQLite SQL 生成逻辑从 UI 层抽出来
形成最小 SQL Domain Kit
为后续 Result Grid / Query UX 继续推进做准备
```

不做：

```txt
不做 MySQL
不做 Postgres
不做 Driver Form
不做 Secret Store
不改连接表单
不改 Result Panel
不改变当前只支持 SQLite 的事实
```

---

# 交付内容

新增：

```txt
src/vs/workbench/services/sql/common/sqlDialect.ts
src/vs/workbench/services/sql/common/sqlDrivers.ts
src/vs/workbench/services/sql/test/sqlDialect.test.ts
src/vs/workbench/services/sql/test/sqlDrivers.test.ts
src-tauri/src/commands/sql/dialect.rs
```

修改：

```txt
src/vs/workbench/contrib/sqlConnections/common/sqlConnectionQueryModel.ts
src/vs/workbench/contrib/sqlConnections/test/sqlConnectionQueryModel.test.ts
src-tauri/src/commands/sql/mod.rs
package.json
```

---

# 1. 新增前端 SQL Dialect

## `src/vs/workbench/services/sql/common/sqlDialect.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL dialect helpers.
 * Phase 6.6 intentionally supports SQLite only.
 *--------------------------------------------------------------------------------------------*/

import { SqlConnectionKind } from './sqlTypes.js';

export const enum SqlDialect {
	Sqlite = 'sqlite'
}

export interface SqlQualifiedName {
	readonly schema?: string;
	readonly name: string;
}

export interface SqlTablePreviewOptions {
	readonly dialect: SqlDialect;
	readonly schema?: string;
	readonly tableName: string;
	readonly limit?: number;
}

export const SQL_DEFAULT_TABLE_PREVIEW_LIMIT = 100;
export const SQL_MAX_TABLE_PREVIEW_LIMIT = 10_000;

export function getDialectForConnectionKind(kind: SqlConnectionKind): SqlDialect {
	switch (kind) {
		case SqlConnectionKind.Sqlite:
			return SqlDialect.Sqlite;
		default:
			return assertNever(kind);
	}
}

export function quoteSqlIdentifier(dialect: SqlDialect, value: string): string {
	const normalized = normalizeIdentifier(value, 'identifier');

	switch (dialect) {
		case SqlDialect.Sqlite:
			return `"${normalized.replaceAll('"', '""')}"`;

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
	const limit = normalizePreviewLimit(options.limit);
	const tableName = formatQualifiedName(options.dialect, {
		schema: options.schema,
		name: options.tableName
	});

	return `SELECT *
FROM ${tableName}
LIMIT ${limit};
`;
}

export function normalizePreviewLimit(limit: number | undefined): number {
	if (limit === undefined) {
		return SQL_DEFAULT_TABLE_PREVIEW_LIMIT;
	}

	if (!Number.isInteger(limit) || limit <= 0) {
		throw new Error('limit must be a positive integer');
	}

	return Math.min(limit, SQL_MAX_TABLE_PREVIEW_LIMIT);
}

function shouldOmitSchema(dialect: SqlDialect, schema: string): boolean {
	switch (dialect) {
		case SqlDialect.Sqlite:
			return schema === 'main';

		default:
			return assertNever(dialect);
	}
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

# 2. 新增前端 Driver Catalog

## `src/vs/workbench/services/sql/common/sqlDrivers.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL driver catalog.
 * Phase 6.6 exposes metadata only. SQLite remains the only enabled driver.
 *--------------------------------------------------------------------------------------------*/

import { SqlConnectionKind } from './sqlTypes.js';
import { SqlDialect } from './sqlDialect.js';

export const enum SqlDriverAvailability {
	Enabled = 'enabled'
}

export interface SqlDriverCapabilities {
	readonly fileBased: boolean;
	readonly remote: boolean;
	readonly schemas: boolean;
	readonly readOnly: boolean;
	readonly createIfMissing: boolean;
	readonly transactions: boolean;
	readonly explain: boolean;
}

export interface SqlDriverDescriptor {
	readonly id: SqlConnectionKind;
	readonly label: string;
	readonly dialect: SqlDialect;
	readonly availability: SqlDriverAvailability;
	readonly capabilities: SqlDriverCapabilities;
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
		explain: true
	}
};

export const SQL_DRIVER_CATALOG: readonly SqlDriverDescriptor[] = [
	SQLITE_DRIVER
];

export function getSqlDriverDescriptor(kind: SqlConnectionKind): SqlDriverDescriptor {
	const driver = SQL_DRIVER_CATALOG.find(item => item.id === kind);

	if (!driver) {
		throw new Error(`Unsupported SQL driver: ${kind}`);
	}

	return driver;
}

export function isSqlDriverEnabled(kind: SqlConnectionKind): boolean {
	return getSqlDriverDescriptor(kind).availability === SqlDriverAvailability.Enabled;
}

export function listEnabledSqlDrivers(): SqlDriverDescriptor[] {
	return SQL_DRIVER_CATALOG.filter(driver => driver.availability === SqlDriverAvailability.Enabled);
}
```

---

# 3. 改造 Connection Query Model

## `src/vs/workbench/contrib/sqlConnections/common/sqlConnectionQueryModel.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL query draft helpers for connection tree nodes.
 *--------------------------------------------------------------------------------------------*/

import {
	createTablePreviewSql,
	formatQualifiedName,
	quoteSqlIdentifier,
	SqlDialect,
	SQL_DEFAULT_TABLE_PREVIEW_LIMIT,
	SQL_MAX_TABLE_PREVIEW_LIMIT
} from '../../../services/sql/common/sqlDialect.js';
import { SqlConnectionTreeNode, SqlConnectionTreeNodeType } from './sqlConnectionTreeModel.js';

export const SQL_CONNECTION_TABLE_PREVIEW_LIMIT = SQL_DEFAULT_TABLE_PREVIEW_LIMIT;

export interface SqlEditorDraft {
	readonly connectionId: string;
	readonly connectionName?: string;
	readonly initialSql: string;
}

export interface SqlEditorDraftOptions {
	readonly connectionName?: string;
	readonly dialect?: SqlDialect;
	readonly limit?: number;
}

export function createSqlEditorDraftFromTreeNode(
	node: SqlConnectionTreeNode,
	options: SqlEditorDraftOptions = {}
): SqlEditorDraft {
	if (!node.connectionId) {
		throw new Error('Cannot open SQL query because the tree node has no connection id.');
	}

	switch (node.type) {
		case SqlConnectionTreeNodeType.Connection:
			return createConnectionQueryDraft(node.connectionId, options.connectionName ?? node.label);

		case SqlConnectionTreeNodeType.Table:
		case SqlConnectionTreeNodeType.View:
			return createTablePreviewDraft(node, options);

		default:
			throw new Error(`Cannot open SQL query from node type: ${node.type}`);
	}
}

export function createConnectionQueryDraft(connectionId: string, connectionName?: string): SqlEditorDraft {
	const normalizedConnectionId = normalizeRequiredString(connectionId, 'connectionId');
	const normalizedConnectionName = normalizeOptionalString(connectionName);

	return {
		connectionId: normalizedConnectionId,
		connectionName: normalizedConnectionName,
		initialSql: `-- SQL Studio Query
-- Connection: ${normalizedConnectionName ?? normalizedConnectionId}

SELECT 1 AS value;
`
	};
}

export function createTablePreviewDraft(
	node: Pick<SqlConnectionTreeNode, 'connectionId' | 'schema' | 'tableName' | 'label' | 'type'>,
	options: SqlEditorDraftOptions = {}
): SqlEditorDraft {
	const connectionId = normalizeRequiredString(node.connectionId, 'connectionId');
	const tableName = normalizeRequiredString(node.tableName ?? node.label, 'tableName');

	return {
		connectionId,
		connectionName: normalizeOptionalString(options.connectionName),
		initialSql: createTablePreviewSql({
			dialect: options.dialect ?? SqlDialect.Sqlite,
			schema: normalizeOptionalString(node.schema),
			tableName,
			limit: options.limit
		})
	};
}

/**
 * Backward-compatible helper for old Phase 4.5 callers/tests.
 * New code should use quoteSqlIdentifier(SqlDialect.Sqlite, value).
 */
export function quoteSqliteIdentifier(value: string): string {
	return quoteSqlIdentifier(SqlDialect.Sqlite, value);
}

/**
 * Backward-compatible helper for old Phase 4.5 callers/tests.
 * New code should use formatQualifiedName(SqlDialect.Sqlite, ...).
 */
export function formatSqliteQualifiedName(schema: string | undefined, name: string): string {
	return formatQualifiedName(SqlDialect.Sqlite, {
		schema,
		name
	});
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

export { SQL_MAX_TABLE_PREVIEW_LIMIT };
```

---

# 4. 新增 Rust Dialect Cleanup

## `src-tauri/src/commands/sql/dialect.rs`

```rust
use super::types::SqlConnectionKind;

pub const SQL_DEFAULT_TABLE_PREVIEW_LIMIT: usize = 100;
pub const SQL_MAX_TABLE_PREVIEW_LIMIT: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqlDialect {
    Sqlite,
}

impl SqlDialect {
    pub fn from_connection_kind(kind: &SqlConnectionKind) -> Self {
        match kind {
            SqlConnectionKind::Sqlite => Self::Sqlite,
        }
    }

    pub fn quote_identifier(self, value: &str) -> Result<String, String> {
        let normalized = normalize_identifier(value, "identifier")?;

        match self {
            Self::Sqlite => Ok(format!("\"{}\"", normalized.replace('"', "\"\""))),
        }
    }

    pub fn format_qualified_name(
        self,
        schema: Option<&str>,
        name: &str,
    ) -> Result<String, String> {
        let normalized_name = normalize_identifier(name, "name")?;
        let normalized_schema = normalize_optional_identifier(schema, "schema")?;

        match normalized_schema {
            None => self.quote_identifier(&normalized_name),
            Some(schema) if self.should_omit_schema(&schema) => {
                self.quote_identifier(&normalized_name)
            }
            Some(schema) => Ok(format!(
                "{}.{}",
                self.quote_identifier(&schema)?,
                self.quote_identifier(&normalized_name)?
            )),
        }
    }

    pub fn create_table_preview_sql(
        self,
        schema: Option<&str>,
        table_name: &str,
        limit: Option<usize>,
    ) -> Result<String, String> {
        let limit = normalize_preview_limit(limit)?;
        let table_name = self.format_qualified_name(schema, table_name)?;

        Ok(format!("SELECT *\nFROM {table_name}\nLIMIT {limit};\n"))
    }

    fn should_omit_schema(self, schema: &str) -> bool {
        match self {
            Self::Sqlite => schema == "main",
        }
    }
}

pub fn normalize_preview_limit(limit: Option<usize>) -> Result<usize, String> {
    match limit {
        None => Ok(SQL_DEFAULT_TABLE_PREVIEW_LIMIT),
        Some(0) => Err("limit must be a positive integer".to_string()),
        Some(value) => Ok(value.min(SQL_MAX_TABLE_PREVIEW_LIMIT)),
    }
}

fn normalize_identifier(value: &str, field_name: &str) -> Result<String, String> {
    let normalized = value.trim();

    if normalized.is_empty() {
        return Err(format!("{field_name} must not be empty"));
    }

    if normalized.contains('\0') {
        return Err(format!("{field_name} must not contain NUL bytes"));
    }

    Ok(normalized.to_string())
}

fn normalize_optional_identifier(
    value: Option<&str>,
    field_name: &str,
) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };

    let normalized = value.trim();

    if normalized.is_empty() {
        return Ok(None);
    }

    if normalized.contains('\0') {
        return Err(format!("{field_name} must not contain NUL bytes"));
    }

    Ok(Some(normalized.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_quotes_identifier_with_double_quotes() {
        assert_eq!(
            SqlDialect::Sqlite.quote_identifier("users").unwrap(),
            "\"users\""
        );
    }

    #[test]
    fn sqlite_escapes_double_quotes() {
        assert_eq!(
            SqlDialect::Sqlite
                .quote_identifier("weird\"name")
                .unwrap(),
            "\"weird\"\"name\""
        );
    }

    #[test]
    fn sqlite_rejects_empty_identifier() {
        let err = SqlDialect::Sqlite.quote_identifier("  ").unwrap_err();
        assert!(err.contains("identifier must not be empty"));
    }

    #[test]
    fn sqlite_rejects_nul_identifier() {
        let err = SqlDialect::Sqlite.quote_identifier("bad\0name").unwrap_err();
        assert!(err.contains("NUL"));
    }

    #[test]
    fn sqlite_omits_main_schema() {
        assert_eq!(
            SqlDialect::Sqlite
                .format_qualified_name(Some("main"), "users")
                .unwrap(),
            "\"users\""
        );
    }

    #[test]
    fn sqlite_includes_attached_schema() {
        assert_eq!(
            SqlDialect::Sqlite
                .format_qualified_name(Some("analytics"), "events")
                .unwrap(),
            "\"analytics\".\"events\""
        );
    }

    #[test]
    fn sqlite_create_table_preview_sql() {
        assert_eq!(
            SqlDialect::Sqlite
                .create_table_preview_sql(Some("main"), "users", None)
                .unwrap(),
            "SELECT *\nFROM \"users\"\nLIMIT 100;\n"
        );
    }

    #[test]
    fn normalize_preview_limit_uses_default() {
        assert_eq!(
            normalize_preview_limit(None).unwrap(),
            SQL_DEFAULT_TABLE_PREVIEW_LIMIT
        );
    }

    #[test]
    fn normalize_preview_limit_clamps_large_limit() {
        assert_eq!(
            normalize_preview_limit(Some(usize::MAX)).unwrap(),
            SQL_MAX_TABLE_PREVIEW_LIMIT
        );
    }

    #[test]
    fn normalize_preview_limit_rejects_zero() {
        let err = normalize_preview_limit(Some(0)).unwrap_err();
        assert!(err.contains("positive integer"));
    }

    #[test]
    fn dialect_maps_from_connection_kind() {
        assert_eq!(
            SqlDialect::from_connection_kind(&SqlConnectionKind::Sqlite),
            SqlDialect::Sqlite
        );
    }
}
```

---

# 5. 修改 Rust SQL mod

## `src-tauri/src/commands/sql/mod.rs`

```rust
mod connection;
pub mod dialect;
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

# 6. 前端单元测试

## `src/vs/workbench/services/sql/test/sqlDialect.test.ts`

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createTablePreviewSql,
	formatQualifiedName,
	getDialectForConnectionKind,
	normalizePreviewLimit,
	quoteSqlIdentifier,
	SqlDialect,
	SQL_DEFAULT_TABLE_PREVIEW_LIMIT,
	SQL_MAX_TABLE_PREVIEW_LIMIT
} from '../common/sqlDialect.js';
import { SqlConnectionKind } from '../common/sqlTypes.js';

test('getDialectForConnectionKind maps sqlite to sqlite dialect', () => {
	assert.equal(getDialectForConnectionKind(SqlConnectionKind.Sqlite), SqlDialect.Sqlite);
});

test('quoteSqlIdentifier quotes sqlite identifiers with double quotes', () => {
	assert.equal(quoteSqlIdentifier(SqlDialect.Sqlite, 'users'), '"users"');
	assert.equal(quoteSqlIdentifier(SqlDialect.Sqlite, 'weird"name'), '"weird""name"');
});

test('quoteSqlIdentifier trims identifiers', () => {
	assert.equal(quoteSqlIdentifier(SqlDialect.Sqlite, ' users '), '"users"');
});

test('quoteSqlIdentifier rejects empty identifiers', () => {
	assert.throws(() => quoteSqlIdentifier(SqlDialect.Sqlite, '  '), /identifier must not be empty/);
});

test('quoteSqlIdentifier rejects NUL identifiers', () => {
	assert.throws(() => quoteSqlIdentifier(SqlDialect.Sqlite, 'bad\0name'), /NUL/);
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

test('formatQualifiedName includes sqlite attached schema', () => {
	assert.equal(
		formatQualifiedName(SqlDialect.Sqlite, {
			schema: 'analytics',
			name: 'events'
		}),
		'"analytics"."events"'
	);
});

test('formatQualifiedName ignores empty schema', () => {
	assert.equal(
		formatQualifiedName(SqlDialect.Sqlite, {
			schema: '   ',
			name: 'users'
		}),
		'"users"'
	);
});

test('createTablePreviewSql creates sqlite preview SQL with default limit', () => {
	assert.equal(
		createTablePreviewSql({
			dialect: SqlDialect.Sqlite,
			schema: 'main',
			tableName: 'users'
		}),
		`SELECT *
FROM "users"
LIMIT ${SQL_DEFAULT_TABLE_PREVIEW_LIMIT};
`
	);
});

test('createTablePreviewSql creates sqlite preview SQL with custom limit', () => {
	assert.equal(
		createTablePreviewSql({
			dialect: SqlDialect.Sqlite,
			schema: 'analytics',
			tableName: 'events',
			limit: 50
		}),
		`SELECT *
FROM "analytics"."events"
LIMIT 50;
`
	);
});

test('normalizePreviewLimit clamps large limit', () => {
	assert.equal(normalizePreviewLimit(999_999), SQL_MAX_TABLE_PREVIEW_LIMIT);
});

test('normalizePreviewLimit rejects invalid limit', () => {
	assert.throws(() => normalizePreviewLimit(0), /positive integer/);
	assert.throws(() => normalizePreviewLimit(-1), /positive integer/);
	assert.throws(() => normalizePreviewLimit(1.5), /positive integer/);
});
```

---

## `src/vs/workbench/services/sql/test/sqlDrivers.test.ts`

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	getSqlDriverDescriptor,
	isSqlDriverEnabled,
	listEnabledSqlDrivers,
	SQLITE_DRIVER,
	SqlDriverAvailability
} from '../common/sqlDrivers.js';
import { SqlDialect } from '../common/sqlDialect.js';
import { SqlConnectionKind } from '../common/sqlTypes.js';

test('SQLITE_DRIVER describes sqlite capabilities', () => {
	assert.equal(SQLITE_DRIVER.id, SqlConnectionKind.Sqlite);
	assert.equal(SQLITE_DRIVER.label, 'SQLite');
	assert.equal(SQLITE_DRIVER.dialect, SqlDialect.Sqlite);
	assert.equal(SQLITE_DRIVER.availability, SqlDriverAvailability.Enabled);

	assert.equal(SQLITE_DRIVER.capabilities.fileBased, true);
	assert.equal(SQLITE_DRIVER.capabilities.remote, false);
	assert.equal(SQLITE_DRIVER.capabilities.schemas, true);
	assert.equal(SQLITE_DRIVER.capabilities.readOnly, true);
	assert.equal(SQLITE_DRIVER.capabilities.createIfMissing, true);
	assert.equal(SQLITE_DRIVER.capabilities.transactions, true);
	assert.equal(SQLITE_DRIVER.capabilities.explain, true);
});

test('getSqlDriverDescriptor returns sqlite descriptor', () => {
	assert.equal(getSqlDriverDescriptor(SqlConnectionKind.Sqlite), SQLITE_DRIVER);
});

test('isSqlDriverEnabled returns true for sqlite', () => {
	assert.equal(isSqlDriverEnabled(SqlConnectionKind.Sqlite), true);
});

test('listEnabledSqlDrivers only exposes currently supported sqlite driver', () => {
	const enabledDrivers = listEnabledSqlDrivers();

	assert.deepEqual(
		enabledDrivers.map(driver => driver.id),
		[SqlConnectionKind.Sqlite]
	);

	for (const driver of enabledDrivers) {
		assert.equal(driver.availability, SqlDriverAvailability.Enabled);
	}
});
```

---

# 7. 修改 Connection Query Model 测试

## `src/vs/workbench/contrib/sqlConnections/test/sqlConnectionQueryModel.test.ts`

如果已有测试，不要删；只追加这些用例：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlDialect } from '../../../services/sql/common/sqlDialect.js';
import {
	createConnectionQueryDraft,
	createTablePreviewDraft,
	formatSqliteQualifiedName,
	quoteSqliteIdentifier
} from '../common/sqlConnectionQueryModel.js';
import { SqlConnectionTreeNodeType } from '../common/sqlConnectionTreeModel.js';

test('createConnectionQueryDraft creates default query', () => {
	const draft = createConnectionQueryDraft('local', 'Local SQLite');

	assert.equal(draft.connectionId, 'local');
	assert.equal(draft.connectionName, 'Local SQLite');
	assert.equal(
		draft.initialSql,
		`-- SQL Studio Query
-- Connection: Local SQLite

SELECT 1 AS value;
`
	);
});

test('createTablePreviewDraft creates sqlite preview SQL', () => {
	const draft = createTablePreviewDraft({
		type: SqlConnectionTreeNodeType.Table,
		connectionId: 'local',
		schema: 'main',
		tableName: 'users',
		label: 'users'
	});

	assert.equal(draft.connectionId, 'local');
	assert.equal(
		draft.initialSql,
		`SELECT *
FROM "users"
LIMIT 100;
`
	);
});

test('createTablePreviewDraft supports attached sqlite schema', () => {
	const draft = createTablePreviewDraft({
		type: SqlConnectionTreeNodeType.Table,
		connectionId: 'local',
		schema: 'analytics',
		tableName: 'events',
		label: 'events'
	});

	assert.equal(
		draft.initialSql,
		`SELECT *
FROM "analytics"."events"
LIMIT 100;
`
	);
});

test('createTablePreviewDraft supports custom limit', () => {
	const draft = createTablePreviewDraft(
		{
			type: SqlConnectionTreeNodeType.View,
			connectionId: 'local',
			schema: 'main',
			tableName: 'active_users',
			label: 'active_users'
		},
		{
			dialect: SqlDialect.Sqlite,
			limit: 25
		}
	);

	assert.equal(
		draft.initialSql,
		`SELECT *
FROM "active_users"
LIMIT 25;
`
	);
});

test('createTablePreviewDraft rejects missing connection id', () => {
	assert.throws(
		() =>
			createTablePreviewDraft({
				type: SqlConnectionTreeNodeType.Table,
				connectionId: '',
				schema: 'main',
				tableName: 'users',
				label: 'users'
			}),
		/connectionId must not be empty/
	);
});

test('createTablePreviewDraft rejects missing table name', () => {
	assert.throws(
		() =>
			createTablePreviewDraft({
				type: SqlConnectionTreeNodeType.Table,
				connectionId: 'local',
				schema: 'main',
				tableName: '',
				label: ''
			}),
		/tableName must not be empty/
	);
});

test('quoteSqliteIdentifier remains backward-compatible', () => {
	assert.equal(quoteSqliteIdentifier('users'), '"users"');
	assert.equal(quoteSqliteIdentifier('weird"name'), '"weird""name"');
});

test('formatSqliteQualifiedName remains backward-compatible', () => {
	assert.equal(formatSqliteQualifiedName('main', 'users'), '"users"');
	assert.equal(formatSqliteQualifiedName('analytics', 'events'), '"analytics"."events"');
});
```

> 如果当前这个测试文件已经有同名测试，合并即可，不要重复定义。

---

# 8. 修改 `package.json`

新增：

```json
"test:sql-domain": "node --test --import tsx src/vs/workbench/services/sql/test/sqlDialect.test.ts src/vs/workbench/services/sql/test/sqlDrivers.test.ts"
```

把总测试链路改成：

```json
"test": "pnpm run test:branding && pnpm run test:rust && pnpm run test:sql-services && pnpm run test:sql-domain && pnpm run test:sql-connections && pnpm run test:sql-editor && pnpm run test:sql-result"
```

如果当前还没有 `test:sql-editor / test:sql-result`，就不要强行加不存在的脚本，按当前仓库实际已有脚本拼接。

---

# 9. 验收命令

```bash
pnpm run test:sql-domain
pnpm run test:sql-connections
pnpm run test

cd src-tauri
cargo test sql::dialect
cargo test sql

cd ..
pnpm run lint
pnpm run build
```

---

# 10. 手动验收

Phase 6.6 不应该改变用户可见功能。

只验收现有主路径：

```txt
1. 启动应用
2. 添加 SQLite 连接
3. 展开 Tables
4. 点击 Table 的 SELECT Top 100
5. SQL Editor 生成：
   SELECT *
   FROM "table_name"
   LIMIT 100;
6. attached schema 表生成：
   SELECT *
   FROM "schema"."table_name"
   LIMIT 100;
7. 执行 SQL
8. Result Panel 正常展示
```

---

# 11. 完成后的效果

Phase 6.6 完成后：

```txt
UI 不再自己拼 SQLite identifier
Connection Tree 只负责业务行为
SQL quote / qualified name / preview SQL 统一在 sqlDialect
SQLite driver 元信息统一在 sqlDrivers
Rust 侧也有对应 dialect helper
```

这一步只是内部清理。

下一步仍然是：

```txt
Phase 7：Result Grid & Query UX Migration
```

不要继续往多数据库 UI、Driver Form、Secret Store 走。
