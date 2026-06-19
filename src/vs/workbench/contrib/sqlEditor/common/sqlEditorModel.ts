/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor pure model helpers.
 *--------------------------------------------------------------------------------------------*/

export interface SqlEditorOptions {
	id?: string;
	connectionId?: string;
	connectionName?: string;
	initialSql?: string;
}

export interface NormalizedSqlEditorOptions {
	id: string;
	connectionId?: string;
	connectionName?: string;
	initialSql: string;
}

export const enum SqlEditorExecutionSource {
	All = 'all',
	Selection = 'selection',
	Statement = 'statement'
}

export interface SqlEditorExecutePayload {
	connectionId: string;
	sql: string;
	source: SqlEditorExecutionSource;
}

export interface SqlStatementRange {
	readonly start: number;
	readonly end: number;
	readonly sql: string;
}

export function normalizeSqlEditorOptions(
	options: SqlEditorOptions,
	defaultSql: string,
	createId: () => string
): NormalizedSqlEditorOptions {
	const id = normalizeOptionalString(options.id) ?? createId();
	const connectionId = normalizeOptionalString(options.connectionId);
	const connectionName = normalizeOptionalString(options.connectionName);
	const initialSql = options.initialSql ?? defaultSql;

	return {
		id,
		connectionId,
		connectionName,
		initialSql
	};
}

export function getSqlEditorName(connectionName?: string): string {
	return connectionName ? `SQL Query · ${connectionName}` : 'SQL Query';
}

export function getSqlEditorDescription(connectionId?: string): string | undefined {
	return connectionId ? `Connection: ${connectionId}` : 'No connection selected';
}

export function normalizeExecutableSql(sql: string): string {
	return sql.trim();
}

export function createExecutePayload(
	connectionId: string | undefined,
	sql: string,
	source: SqlEditorExecutionSource
): SqlEditorExecutePayload {
	const normalizedConnectionId = normalizeOptionalString(connectionId);
	if (!normalizedConnectionId) {
		throw new Error('No SQL connection selected.');
	}

	const normalizedSql = normalizeExecutableSql(sql);
	if (!normalizedSql) {
		throw new Error('SQL is empty.');
	}

	return {
		connectionId: normalizedConnectionId,
		sql: normalizedSql,
		source
	};
}

export function findSqlStatementAtOffset(sql: string, offset: number): SqlStatementRange {
	if (typeof sql !== 'string') {
		throw new Error('sql must be a string');
	}

	const clampedOffset = clampOffset(offset, sql.length);
	const boundaries = findStatementBoundaries(sql);

	let start = 0;
	let end = sql.length;

	for (const boundary of boundaries) {
		if (boundary < clampedOffset) {
			start = boundary + 1;
			continue;
		}

		end = boundary;
		break;
	}

	return trimStatementRange(sql, start, end);
}

export function getSqlEditorStatusLabel(options: {
	readonly connectionId?: string;
	readonly connectionName?: string;
	readonly dirty?: boolean;
	readonly running?: boolean;
}): string {
	const connection = options.connectionName ?? options.connectionId ?? 'No connection';
	const state = options.running ? 'Running' : options.dirty ? 'Draft saved' : 'Ready';

	return `${state} · ${connection}`;
}

export function createFormatterPlaceholderResult(sql: string): string {
	return sql;
}

function findStatementBoundaries(sql: string): number[] {
	const boundaries: number[] = [];

	let inSingleQuote = false;
	let inDoubleQuote = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let index = 0; index < sql.length; index++) {
		const char = sql[index];
		const next = sql[index + 1];

		if (inLineComment) {
			if (char === '\n') {
				inLineComment = false;
			}
			continue;
		}

		if (inBlockComment) {
			if (char === '*' && next === '/') {
				inBlockComment = false;
				index++;
			}
			continue;
		}

		if (inSingleQuote) {
			if (char === "'" && next === "'") {
				index++;
				continue;
			}

			if (char === "'") {
				inSingleQuote = false;
			}

			continue;
		}

		if (inDoubleQuote) {
			if (char === '"' && next === '"') {
				index++;
				continue;
			}

			if (char === '"') {
				inDoubleQuote = false;
			}

			continue;
		}

		if (char === '-' && next === '-') {
			inLineComment = true;
			index++;
			continue;
		}

		if (char === '/' && next === '*') {
			inBlockComment = true;
			index++;
			continue;
		}

		if (char === "'") {
			inSingleQuote = true;
			continue;
		}

		if (char === '"') {
			inDoubleQuote = true;
			continue;
		}

		if (char === ';') {
			boundaries.push(index);
		}
	}

	return boundaries;
}

function trimStatementRange(sql: string, start: number, end: number): SqlStatementRange {
	let trimmedStart = start;
	let trimmedEnd = end;

	while (trimmedStart < trimmedEnd && /\s/.test(sql[trimmedStart])) {
		trimmedStart++;
	}

	while (trimmedEnd > trimmedStart && /\s/.test(sql[trimmedEnd - 1])) {
		trimmedEnd--;
	}

	return {
		start: trimmedStart,
		end: trimmedEnd,
		sql: sql.slice(trimmedStart, trimmedEnd)
	};
}

function clampOffset(offset: number, max: number): number {
	if (!Number.isFinite(offset)) {
		return 0;
	}

	return Math.max(0, Math.min(max, Math.floor(offset)));
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}
