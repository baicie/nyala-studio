/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL connection tree context actions.
 *
 * Phase 02 metadata explorer.
 * Pure helpers that build SQL drafts and clipboard text for table nodes.
 * They never call into the SQL service or Tauri runtime.
 *--------------------------------------------------------------------------------------------*/

import {
	SqlConnectionKind,
	SqlTable,
	SqlTableType
} from '../../../services/sql/common/sqlTypes.js';

export const enum SqlConnectionTreeActionKind {
	CopyName = 'copyName',
	CopySelect = 'copySelect',
	PreviewRows = 'previewRows',
	CountRows = 'countRows',
	OpenQuery = 'openQuery'
}

export interface SqlConnectionTreeSqlAction {
	readonly kind: SqlConnectionTreeActionKind;
	readonly title: string;
	readonly sql?: string;
	readonly clipboardText?: string;
}

export const SQL_CONNECTION_TREE_PREVIEW_DEFAULT_LIMIT = 100;
export const SQL_CONNECTION_TREE_PREVIEW_MAX_LIMIT = 1_000;

export interface SqlConnectionTreeSqlActionsOptions {
	readonly connectionKind: SqlConnectionKind;
	readonly table: Pick<SqlTable, 'schema' | 'name' | 'tableType'>;
	readonly limit?: number;
}

export function createTableSqlActions(
	options: SqlConnectionTreeSqlActionsOptions
): SqlConnectionTreeSqlAction[] {
	const name = formatQualifiedTableName(options.connectionKind, options.table);
	const limit = normalizeLimit(options.limit ?? SQL_CONNECTION_TREE_PREVIEW_DEFAULT_LIMIT);
	const selectSql = `SELECT *\nFROM ${name}\nLIMIT ${limit};`;
	const countSql = `SELECT COUNT(*) AS count\nFROM ${name};`;

	return [
		{ kind: SqlConnectionTreeActionKind.CopyName, title: 'Copy Name', clipboardText: name },
		{ kind: SqlConnectionTreeActionKind.CopySelect, title: 'Copy SELECT', clipboardText: selectSql },
		{ kind: SqlConnectionTreeActionKind.PreviewRows, title: 'Preview Rows', sql: selectSql },
		{ kind: SqlConnectionTreeActionKind.CountRows, title: 'Count Rows', sql: countSql },
		{ kind: SqlConnectionTreeActionKind.OpenQuery, title: 'Open Query', sql: selectSql }
	];
}

export function formatQualifiedTableName(
	connectionKind: SqlConnectionKind,
	table: Pick<SqlTable, 'schema' | 'name' | 'tableType'>
): string {
	const schema = normalizeOptionalIdentifier(table.schema, 'schema');
	const name = normalizeIdentifier(table.name, 'name');

	if (connectionKind === SqlConnectionKind.MySql) {
		return schema ? `${quoteMysqlIdentifier(schema)}.${quoteMysqlIdentifier(name)}` : quoteMysqlIdentifier(name);
	}

	if (connectionKind === SqlConnectionKind.Sqlite) {
		if (!schema || schema === 'main') {
			return quoteSqliteIdentifier(name);
		}
		return `${quoteSqliteIdentifier(schema)}.${quoteSqliteIdentifier(name)}`;
	}

	// PostgreSQL is reserved: keep the same double-quote style as SQLite so
	// drafts do not require a runtime that is not yet enabled.
	if (!schema || schema === 'public') {
		return quoteSqliteIdentifier(name);
	}
	return `${quoteSqliteIdentifier(schema)}.${quoteSqliteIdentifier(name)}`;
}

export function getObjectTypeLabel(table: Pick<SqlTable, 'tableType'>): string {
	return table.tableType === SqlTableType.View ? 'view' : 'table';
}

function quoteSqliteIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function quoteMysqlIdentifier(value: string): string {
	return `\`${value.replaceAll('`', '``')}\``;
}

function normalizeLimit(limit: number): number {
	return Number.isInteger(limit) && limit > 0
		? Math.min(limit, SQL_CONNECTION_TREE_PREVIEW_MAX_LIMIT)
		: SQL_CONNECTION_TREE_PREVIEW_DEFAULT_LIMIT;
}

function normalizeIdentifier(value: string, fieldName: string): string {
	if (typeof value !== 'string') {
		throw new Error(`${fieldName} must be a string`);
	}
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error(`${fieldName} must not be empty`);
	}
	if (trimmed.includes('\0')) {
		throw new Error(`${fieldName} must not contain NUL bytes`);
	}
	return trimmed;
}

function normalizeOptionalIdentifier(value: string | undefined, fieldName: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	return normalizeIdentifier(value, fieldName);
}