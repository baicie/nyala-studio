/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - explain plan helpers.
 *--------------------------------------------------------------------------------------------*/

import { SqlDialect } from '../../../services/sql/common/sqlDialect.js';
import { SqlCellKind, SqlQueryResult } from '../../../services/sql/common/sqlTypes.js';

export interface SqlExplainPlanRequest {
	readonly dialect: SqlDialect;
	readonly sql: string;
}

export interface SqlExplainPlanRow {
	readonly ordinal: number;
	readonly detail: string;
	readonly raw: Record<string, unknown>;
}

export interface SqlExplainPlanSummary {
	readonly dialect: SqlDialect;
	readonly sql: string;
	readonly explainSql: string;
	readonly rows: readonly SqlExplainPlanRow[];
}

export function createExplainSql(request: SqlExplainPlanRequest): string {
	const sql = normalizeStatement(request.sql);

	switch (request.dialect) {
		case SqlDialect.Sqlite:
			return `EXPLAIN QUERY PLAN ${sql}`;

		case SqlDialect.MySql:
			return `EXPLAIN ${sql}`;

		case SqlDialect.PostgreSql:
			return `EXPLAIN (FORMAT JSON) ${sql}`;

		default:
			return assertNever(request.dialect);
	}
}

export function parseExplainQueryResult(dialect: SqlDialect, sql: string, result: SqlQueryResult): SqlExplainPlanSummary {
	const rows = result.rows.map((row, index) => {
		const raw: Record<string, unknown> = {};

		for (const column of result.columns) {
			const cell = row[column.ordinal];
			raw[column.name] = cell?.kind === SqlCellKind.Null ? null : cell?.value;
		}

		return {
			ordinal: index,
			detail: getExplainRowDetail(raw),
			raw
		};
	});

	return {
		dialect,
		sql,
		explainSql: createExplainSql({ dialect, sql }),
		rows
	};
}

export function getExplainRowDetail(raw: Record<string, unknown>): string {
	const preferredKeys = ['detail', 'Extra', 'rows', 'select_type', 'table', 'type', 'key', 'possible_keys'];

	const values = preferredKeys
		.map(key => raw[key])
		.filter(value => value !== undefined && value !== null && String(value).trim().length > 0)
		.map(value => String(value));

	if (values.length > 0) {
		return values.join(' · ');
	}

	const fallback = Object.values(raw)
		.filter(value => value !== undefined && value !== null && String(value).trim().length > 0)
		.map(value => String(value));

	return fallback.join(' · ') || 'No explain details';
}

function normalizeStatement(sql: string): string {
	const normalized = sql.trim();

	if (!normalized) {
		throw new Error('sql must not be empty');
	}

	return normalized.endsWith(';') ? normalized.slice(0, -1).trim() : normalized;
}

function assertNever(value: never): never {
	throw new Error(`Unsupported explain dialect: ${String(value)}`);
}
