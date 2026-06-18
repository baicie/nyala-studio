# Phase 7：迁移旧 SQL Studio 领域资产第一步 —— SQL Domain Kit

Phase 7 不建议直接做 MySQL/Postgres 真实连接。当前后端和前端的 `SqlConnectionKind` 都仍然只有 `sqlite`，前端校验也明确只允许 SQLite。

所以 Phase 7 最稳的切入点是：

```txt id="59j1cn"
迁移“领域抽象”
而不是马上迁移“多数据库驱动”
```

也就是先做一个 **SQL Domain Kit**：

```txt id="3fzll9"
SQL Dialect
SQL Identifier Quoting
SQL Qualified Name
Table Preview SQL
Driver Catalog
Capability Matrix
```

当前 `sqlConnectionQueryModel.ts` 里已经有硬编码 SQLite 的 `formatSqliteQualifiedName()` 和 `quoteSqliteIdentifier()`，这就是 Phase 7 应该抽出来的第一块领域资产。

---

# Phase 7 目标

本阶段做：

```txt id="6xr7j6"
1. 新增前端 SQL Dialect domain
2. 新增前端 SQL Driver catalog
3. 新增 Rust SQL dialect domain
4. 把 Connection Tree 生成 SELECT 的逻辑从 SQLite 专用函数迁移到 Dialect API
5. 保持当前真实连接能力仍然只支持 SQLite
6. 单元测试覆盖 SQLite / MySQL / Postgres 的 identifier quoting 和 preview SQL
```

本阶段不做：

```txt id="m08a6k"
1. 不接 MySQL 驱动
2. 不接 Postgres 驱动
3. 不保存数据库密码
4. 不改 UI 为多数据库连接表单
5. 不引入 sqlx
6. 不改 Result Panel
```

---

# 设计后的结构

新增：

```txt id="r6np8v"
src/vs/workbench/services/sql/common/sqlDialect.ts
src/vs/workbench/services/sql/common/sqlDrivers.ts
src/vs/workbench/services/sql/test/sqlDialect.test.ts
src/vs/workbench/services/sql/test/sqlDrivers.test.ts

src-tauri/src/commands/sql/dialect.rs
```

修改：

```txt id="i2k2it"
src/vs/workbench/contrib/sqlConnections/common/sqlConnectionQueryModel.ts
src/vs/workbench/contrib/sqlConnections/test/sqlConnectionQueryModel.test.ts
src-tauri/src/commands/sql/mod.rs
package.json
```

---

# 一、前端代码

## 1. 新增 `src/vs/workbench/services/sql/common/sqlDialect.ts`

```ts id="2ir3yy"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL dialect domain helpers.
 *--------------------------------------------------------------------------------------------*/

import { SqlConnectionKind } from './sqlTypes.js';

export const enum SqlDialect {
	Sqlite = 'sqlite',
	MySql = 'mysql',
	Postgres = 'postgres'
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
		default:
			return assertNever(kind);
	}
}

export function quoteSqlIdentifier(dialect: SqlDialect, value: string): string {
	const normalized = normalizeIdentifier(value);

	switch (dialect) {
		case SqlDialect.Sqlite:
		case SqlDialect.Postgres:
			return `"${normalized.replaceAll('"', '""')}"`;

		case SqlDialect.MySql:
			return `\`${normalized.replaceAll('`', '``')}\``;

		default:
			return assertNever(dialect);
	}
}

export function formatQualifiedName(dialect: SqlDialect, qualifiedName: SqlQualifiedName): string {
	const name = normalizeIdentifier(qualifiedName.name);
	const schema = normalizeOptionalIdentifier(qualifiedName.schema);

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

	return `SELECT *
FROM ${tableName}
LIMIT ${limit};
`;
}

export function normalizePreviewLimit(limit: number | undefined): number {
	return normalizeLimit(limit);
}

function shouldOmitSchema(dialect: SqlDialect, schema: string): boolean {
	if (dialect === SqlDialect.Sqlite) {
		return schema === 'main';
	}

	return false;
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

function normalizeIdentifier(value: string): string {
	if (typeof value !== 'string') {
		throw new Error('identifier must be a string');
	}

	const normalized = value.trim();

	if (!normalized) {
		throw new Error('identifier must not be empty');
	}

	if (normalized.includes('\0')) {
		throw new Error('identifier must not contain NUL bytes');
	}

	return normalized;
}

function normalizeOptionalIdentifier(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}

	const normalized = value.trim();

	if (!normalized) {
		return undefined;
	}

	if (normalized.includes('\0')) {
		throw new Error('identifier must not contain NUL bytes');
	}

	return normalized;
}

function assertNever(value: never): never {
	throw new Error(`Unsupported SQL dialect value: ${String(value)}`);
}
```

---

## 2. 新增 `src/vs/workbench/services/sql/common/sqlDrivers.ts`

```ts id="1nmsri"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL driver catalog.
 * Phase 7 only exposes domain metadata. Real MySQL/Postgres drivers are not enabled yet.
 *--------------------------------------------------------------------------------------------*/

import { SqlConnectionKind } from './sqlTypes.js';
import { SqlDialect } from './sqlDialect.js';

export const enum SqlDriverAvailability {
	Enabled = 'enabled',
	Planned = 'planned'
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

export const SQL_DRIVER_CATALOG: readonly SqlDriverDescriptor[] = [SQLITE_DRIVER];

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

export function listEnabledSqlDrivers(): SqlDriverDescriptor[] {
	return SQL_DRIVER_CATALOG.filter(driver => driver.availability === SqlDriverAvailability.Enabled);
}
```

> 这里暂时只把 SQLite 放入 catalog。MySQL/Postgres 的 descriptor 可以下一阶段加，但 **不要现在把它们加进 `SqlConnectionKind`**，否则前端类型显示支持了、后端实际又不支持，会造成产品错觉。

---

## 3. 替换 `src/vs/workbench/contrib/sqlConnections/common/sqlConnectionQueryModel.ts`

```ts id="zz3nke"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL query draft helpers for connection tree nodes.
 *--------------------------------------------------------------------------------------------*/

import {
	createTablePreviewSql,
	SqlDialect,
	SQL_DEFAULT_TABLE_PREVIEW_LIMIT,
	SQL_MAX_TABLE_PREVIEW_LIMIT
} from '../../../services/sql/common/sqlDialect.js';
import { SqlConnectionTreeNode, SqlConnectionTreeNodeType } from './sqlConnectionTreeModel.js';

export const SQL_CONNECTION_TABLE_PREVIEW_LIMIT = SQL_DEFAULT_TABLE_PREVIEW_LIMIT;

export interface SqlEditorDraft {
	connectionId: string;
	connectionName?: string;
	initialSql: string;
}

export interface SqlEditorDraftOptions {
	connectionName?: string;
	dialect?: SqlDialect;
	limit?: number;
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

	return {
		connectionId: normalizedConnectionId,
		connectionName: normalizeOptionalString(connectionName),
		initialSql: `-- SQL Studio Query
-- Connection: ${normalizeOptionalString(connectionName) ?? normalizedConnectionId}

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
 * Backward-compatible export for Phase 4.5 tests/callers.
 * New code should use quoteSqlIdentifier(SqlDialect.Sqlite, value).
 */
export function quoteSqliteIdentifier(value: string): string {
	return `"${normalizeRequiredString(value, 'identifier').replaceAll('"', '""')}"`;
}

/**
 * Backward-compatible export for Phase 4.5 tests/callers.
 * New code should use formatQualifiedName(SqlDialect.Sqlite, ...).
 */
export function formatSqliteQualifiedName(schema: string | undefined, name: string): string {
	const normalizedName = normalizeRequiredString(name, 'name');
	const normalizedSchema = normalizeOptionalString(schema);

	if (!normalizedSchema || normalizedSchema === 'main') {
		return quoteSqliteIdentifier(normalizedName);
	}

	return `${quoteSqliteIdentifier(normalizedSchema)}.${quoteSqliteIdentifier(normalizedName)}`;
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

# 二、前端单元测试

## 1. 新增 `src/vs/workbench/services/sql/test/sqlDialect.test.ts`

```ts id="iy7j94"
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

test('quoteSqlIdentifier quotes postgres identifiers with double quotes', () => {
	assert.equal(quoteSqlIdentifier(SqlDialect.Postgres, 'public'), '"public"');
	assert.equal(quoteSqlIdentifier(SqlDialect.Postgres, 'user"name'), '"user""name"');
});

test('quoteSqlIdentifier quotes mysql identifiers with backticks', () => {
	assert.equal(quoteSqlIdentifier(SqlDialect.MySql, 'users'), '`users`');
	assert.equal(quoteSqlIdentifier(SqlDialect.MySql, 'weird`name'), '`weird``name`');
});

test('quoteSqlIdentifier rejects empty and NUL identifiers', () => {
	assert.throws(() => quoteSqlIdentifier(SqlDialect.Sqlite, '  '), /identifier must not be empty/);
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

test('formatQualifiedName includes postgres schema', () => {
	assert.equal(
		formatQualifiedName(SqlDialect.Postgres, {
			schema: 'public',
			name: 'users'
		}),
		'"public"."users"'
	);
});

test('formatQualifiedName includes mysql schema', () => {
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
LIMIT ${SQL_DEFAULT_TABLE_PREVIEW_LIMIT};
`
	);
});

test('createTablePreviewSql creates postgres preview SQL', () => {
	assert.equal(
		createTablePreviewSql({
			dialect: SqlDialect.Postgres,
			schema: 'public',
			tableName: 'users',
			limit: 50
		}),
		`SELECT *
FROM "public"."users"
LIMIT 50;
`
	);
});

test('createTablePreviewSql creates mysql preview SQL', () => {
	assert.equal(
		createTablePreviewSql({
			dialect: SqlDialect.MySql,
			schema: 'app',
			tableName: 'users',
			limit: 50
		}),
		`SELECT *
FROM \`app\`.\`users\`
LIMIT 50;
`
	);
});

test('normalizePreviewLimit clamps large limit', () => {
	assert.equal(normalizePreviewLimit(999_999), SQL_MAX_TABLE_PREVIEW_LIMIT);
});

test('normalizePreviewLimit rejects invalid limit', () => {
	assert.throws(() => normalizePreviewLimit(0), /positive integer/);
	assert.throws(() => normalizePreviewLimit(1.5), /positive integer/);
});
```

---

## 2. 新增 `src/vs/workbench/services/sql/test/sqlDrivers.test.ts`

```ts id="4htjwq"
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
	assert.equal(SQLITE_DRIVER.capabilities.createIfMissing, true);
});

test('getSqlDriverDescriptor returns sqlite descriptor', () => {
	assert.equal(getSqlDriverDescriptor(SqlConnectionKind.Sqlite), SQLITE_DRIVER);
});

test('isSqlDriverEnabled returns true for sqlite', () => {
	assert.equal(isSqlDriverEnabled(SqlConnectionKind.Sqlite), true);
});

test('listEnabledSqlDrivers only includes enabled drivers', () => {
	assert.deepEqual(listEnabledSqlDrivers(), [SQLITE_DRIVER]);
});
```

---

## 3. 修改 `src/vs/workbench/contrib/sqlConnections/test/sqlConnectionQueryModel.test.ts`

保留原测试，同时追加两个测试：

```ts id="fsvjmt"
import { SqlDialect } from '../../../services/sql/common/sqlDialect.js';

test('createTablePreviewDraft can generate postgres SQL through dialect option', () => {
	const draft = createTablePreviewDraft(
		{
			type: SqlConnectionTreeNodeType.Table,
			connectionId: 'local',
			schema: 'public',
			tableName: 'users',
			label: 'users'
		},
		{
			dialect: SqlDialect.Postgres,
			limit: 25
		}
	);

	assert.equal(
		draft.initialSql,
		`SELECT *
FROM "public"."users"
LIMIT 25;
`
	);
});

test('createTablePreviewDraft can generate mysql SQL through dialect option', () => {
	const draft = createTablePreviewDraft(
		{
			type: SqlConnectionTreeNodeType.Table,
			connectionId: 'local',
			schema: 'app',
			tableName: 'users',
			label: 'users'
		},
		{
			dialect: SqlDialect.MySql,
			limit: 25
		}
	);

	assert.equal(
		draft.initialSql,
		`SELECT *
FROM \`app\`.\`users\`
LIMIT 25;
`
	);
});
```

---

# 三、Rust 代码

## 1. 新增 `src-tauri/src/commands/sql/dialect.rs`

```rust id="lx9i10"
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

        if normalized_schema
            .as_deref()
            .is_none_or(|schema| self.should_omit_schema(schema))
        {
            return self.quote_identifier(&normalized_name);
        }

        let schema = normalized_schema.expect("schema must exist after is_none_or false");

        Ok(format!(
            "{}.{}",
            self.quote_identifier(&schema)?,
            self.quote_identifier(&normalized_name)?
        ))
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

> 这里 Rust 侧只实现 SQLite，因为当前 Rust `SqlConnectionKind` 也只有 SQLite。不要在 Rust enum 里提前加 MySQL/Postgres，除非你同时接入驱动和连接校验。

---

## 2. 修改 `src-tauri/src/commands/sql/mod.rs`

```rust id="4a8jw1"
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

# 四、修改 package.json

当前测试链路已经有 `test:sql-services / test:sql-connections / test:sql-editor / test:sql-result`。

新增：

```json id="1anbks"
"test:sql-domain": "node --test --import tsx src/vs/workbench/services/sql/test/sqlDialect.test.ts src/vs/workbench/services/sql/test/sqlDrivers.test.ts"
```

把总测试改成：

```json id="5ooon5"
"test": "pnpm run test:branding && pnpm run test:rust && pnpm run test:sql-services && pnpm run test:sql-domain && pnpm run test:sql-connections && pnpm run test:sql-editor && pnpm run test:sql-result"
```

---

# 五、验收命令

```bash id="dfncv6"
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

# 六、手动验收

Phase 7 是领域层迁移，不应该大改 UI。手动验收保持现有主路径：

```txt id="4ty551"
1. pnpm tauri dev
2. 添加 SQLite 连接
3. 展开 Tables
4. 点击 SELECT
5. 生成 SQL 仍然是：
   SELECT *
   FROM "table"
   LIMIT 100;
6. 执行 SQL
7. SQL Results Panel 正常展示结果
```

---

# Phase 7 完成后的收益

Phase 7 完成后，原来散落在 `sqlConnectionQueryModel.ts` 里的 SQLite 专用逻辑会变成：

```txt id="n9x5vz"
sqlDialect.ts
  -> identifier quote
  -> qualified name
  -> table preview sql
  -> dialect mapping

sqlDrivers.ts
  -> driver metadata
  -> capability matrix
```

这样下一阶段再做 MySQL/Postgres 时，不需要到 UI 里到处写 if/else，而是走：

```txt id="76hvki"
connection.kind
  -> driver descriptor
  -> dialect
  -> SQL generation
```

---

# 下一步建议

Phase 7 后建议进入：

```txt id="498xsy"
Phase 7.1：Connection Form Driver Abstraction
```

也就是把当前 SQLite 专用表单拆成：

```txt id="tnocyu"
driver catalog
  -> SQLite form
  -> future MySQL form
  -> future Postgres form
```

但仍然只启用 SQLite。

不要马上接 MySQL/Postgres 驱动。先把连接表单、saved connection schema、secret store 边界设计好，否则后面一接密码就会返工。
