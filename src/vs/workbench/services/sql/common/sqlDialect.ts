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
