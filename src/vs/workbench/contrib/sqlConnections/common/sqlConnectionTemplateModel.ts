/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL connection tree SQL template model.
 * Phase 7.4 intentionally supports SQLite only through SqlDialect helpers.
 *--------------------------------------------------------------------------------------------*/

import { SqlColumn } from '../../../services/sql/common/sqlTypes.js';
import {
	createTablePreviewSql,
	formatQualifiedName,
	quoteSqlIdentifier,
	SqlDialect,
	SQL_DEFAULT_TABLE_PREVIEW_LIMIT
} from '../../../services/sql/common/sqlDialect.js';

export interface SqlTableTemplateTarget {
	readonly schema?: string;
	readonly tableName: string;
	readonly columns?: readonly SqlColumn[];
	readonly dialect?: SqlDialect;
}

export interface SqlGeneratedTemplate {
	readonly title: string;
	readonly sql: string;
}

export const SQL_CONNECTION_COUNT_ALIAS = 'count';

export function createSelectTemplate(target: SqlTableTemplateTarget, limit = SQL_DEFAULT_TABLE_PREVIEW_LIMIT): SqlGeneratedTemplate {
	return {
		title: 'SELECT',
		sql: createTablePreviewSql({
			dialect: target.dialect ?? SqlDialect.Sqlite,
			schema: target.schema,
			tableName: target.tableName,
			limit
		})
	};
}

export function createCountTemplate(target: SqlTableTemplateTarget): SqlGeneratedTemplate {
	const dialect = target.dialect ?? SqlDialect.Sqlite;
	const tableName = createQualifiedTableName(target);

	return {
		title: 'COUNT',
		sql: `SELECT COUNT(*) AS ${quoteSqlIdentifier(dialect, SQL_CONNECTION_COUNT_ALIAS)}
FROM ${tableName};
`
	};
}

export function createInsertTemplate(target: SqlTableTemplateTarget): SqlGeneratedTemplate {
	const dialect = target.dialect ?? SqlDialect.Sqlite;
	const tableName = createQualifiedTableName(target);
	const columns = normalizeTemplateColumns(target.columns);

	if (columns.length === 0) {
		return {
			title: 'INSERT',
			sql: `INSERT INTO ${tableName}
DEFAULT VALUES;
`
		};
	}

	const columnList = columns
		.map(column => quoteSqlIdentifier(dialect, column.name))
		.join(', ');

	const valueList = columns
		.map((column, index) => createSqlParameterName(column.name, index))
		.join(', ');

	return {
		title: 'INSERT',
		sql: `INSERT INTO ${tableName} (${columnList})
VALUES (${valueList});
`
	};
}

export function createUpdateTemplate(target: SqlTableTemplateTarget): SqlGeneratedTemplate {
	const dialect = target.dialect ?? SqlDialect.Sqlite;
	const tableName = createQualifiedTableName(target);
	const columns = normalizeTemplateColumns(target.columns ?? []);

	if (columns.length === 0) {
		return {
			title: 'UPDATE',
			sql: `UPDATE ${tableName}
SET -- column = value
WHERE -- condition;
`
		};
	}

	const whereColumn = pickWhereColumn(columns);
	const setColumns = columns.filter(column => column.name !== whereColumn.name);

	const effectiveSetColumns = setColumns.length > 0 ? setColumns : [whereColumn];

	const setClause = effectiveSetColumns
		.map((column, index) => {
			const prefix = index === 0 ? 'SET ' : '    ';
			return `${prefix}${quoteSqlIdentifier(dialect, column.name)} = ${createSqlParameterName(column.name, index)}`;
		})
		.join(',\n');

	return {
		title: 'UPDATE',
		sql: `UPDATE ${tableName}
${setClause}
WHERE ${quoteSqlIdentifier(dialect, whereColumn.name)} = ${createSqlParameterName(whereColumn.name, effectiveSetColumns.length)};
`
	};
}

export function createCopyTableNameText(target: SqlTableTemplateTarget): string {
	return normalizeTableName(target.tableName);
}

export function createCopyQualifiedNameText(target: SqlTableTemplateTarget): string {
	return createQualifiedTableName(target);
}

export function createQualifiedTableName(target: SqlTableTemplateTarget): string {
	return formatQualifiedName(target.dialect ?? SqlDialect.Sqlite, {
		schema: normalizeOptionalIdentifier(target.schema),
		name: normalizeTableName(target.tableName)
	});
}

export function normalizeTemplateColumns(columns: readonly SqlColumn[] | undefined): SqlColumn[] {
	if (!columns) {
		return [];
	}

	const seen = new Set<string>();
	const result: SqlColumn[] = [];

	for (const column of [...columns].sort((left, right) => left.ordinal - right.ordinal || left.name.localeCompare(right.name))) {
		const normalizedName = normalizeOptionalIdentifier(column.name);

		if (!normalizedName || seen.has(normalizedName)) {
			continue;
		}

		seen.add(normalizedName);
		result.push({
			...column,
			name: normalizedName
		});
	}

	return result;
}

export function createSqlParameterName(columnName: string, index: number): string {
	const normalized = normalizeOptionalIdentifier(columnName) ?? `value${index + 1}`;
	const safe = normalized
		.replace(/[^A-Za-z0-9_]+/g, '_')
		.replace(/^([0-9])/, '_$1')
		.replace(/^_+$/, '');

	if (!safe) {
		return `:value${index + 1}`;
	}

	return `:${safe}`;
}

function pickWhereColumn(columns: readonly SqlColumn[]): SqlColumn {
	return columns.find(column => column.primaryKey) ?? columns[0];
}

function normalizeTableName(tableName: string): string {
	const normalized = normalizeOptionalIdentifier(tableName);

	if (!normalized) {
		throw new Error('tableName must not be empty');
	}

	return normalized;
}

function normalizeOptionalIdentifier(value: string | undefined): string | undefined {
	const normalized = value?.trim();

	if (!normalized) {
		return undefined;
	}

	if (normalized.includes('\0')) {
		throw new Error('identifier must not contain NUL bytes');
	}

	return normalized;
}
