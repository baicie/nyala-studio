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
