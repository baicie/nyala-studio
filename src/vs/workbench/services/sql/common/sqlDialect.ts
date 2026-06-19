/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL dialect domain helpers.
 * Phase 9 adds foundation for PostgreSQL/MySQL SQL generation.
 * Phase 9.2 enables MySQL runtime for metadata SQL generation.
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
