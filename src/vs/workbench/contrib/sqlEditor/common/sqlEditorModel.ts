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

export interface SqlEditorToolbarState {
	readonly canExecuteStatement: boolean;
	readonly canExecuteSelection: boolean;
	readonly canExecuteAll: boolean;
	readonly canFormat: boolean;
	readonly canChangeConnection: boolean;
	readonly canCancel: boolean;
}

export interface SqlEditorConnectionIdentity {
	readonly id: string;
}

export interface SqlEditorConnectionRefreshOptions {
	readonly inputConnectionId?: string;
	readonly preserveCurrentSelection?: boolean;
	readonly getCurrentSelection: () => string | undefined;
}

export type SqlEditorConnectionRefreshResult<T extends SqlEditorConnectionIdentity> =
	| {
			readonly succeeded: true;
			readonly connections: T[];
			readonly selectedConnectionId?: string;
	  }
	| {
			readonly succeeded: false;
			readonly connections: [];
			readonly error: unknown;
	  };

export class SqlEditorConnectionRefreshCoordinator<T extends SqlEditorConnectionIdentity> {
	private version = 0;

	async load(
		loadConnections: () => Promise<T[]>,
		options: SqlEditorConnectionRefreshOptions
	): Promise<SqlEditorConnectionRefreshResult<T> | undefined> {
		const version = ++this.version;

		try {
			const connections = await loadConnections();
			if (version !== this.version) {
				return undefined;
			}

			const candidates = options.preserveCurrentSelection
				? [options.getCurrentSelection(), options.inputConnectionId]
				: [options.inputConnectionId];
			const selectedConnectionId = candidates
				.map(normalizeOptionalString)
				.find(candidate => candidate && connections.some(connection => connection.id === candidate));

			return {
				succeeded: true,
				connections,
				selectedConnectionId: selectedConnectionId ?? connections[0]?.id
			};
		} catch (error) {
			if (version !== this.version) {
				return undefined;
			}

			return {
				succeeded: false,
				connections: [],
				error
			};
		}
	}

	invalidate(): void {
		this.version++;
	}
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

/** Browser previews have no native connection store to query. */
export function canLoadSqlEditorConnections(isNativeRuntime: boolean): boolean {
	return isNativeRuntime;
}

export function shouldResolveDefaultSqlConnection(isNativeRuntime: boolean, connectionId: string | undefined): boolean {
	return canLoadSqlEditorConnections(isNativeRuntime) && !connectionId;
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

	const statement = trimStatementRange(sql, start, end);
	if (statement.sql) {
		return statement;
	}

	const statements = splitSqlStatements(sql);
	return statements[statements.length - 1] ?? statement;
}

export function splitSqlStatements(sql: string): SqlStatementRange[] {
	if (typeof sql !== 'string') {
		throw new Error('sql must be a string');
	}

	const statements: SqlStatementRange[] = [];
	let start = 0;

	for (const boundary of findStatementBoundaries(sql)) {
		const statement = trimStatementRange(sql, start, boundary);
		if (statement.sql) {
			statements.push(statement);
		}
		start = boundary + 1;
	}

	const tail = trimStatementRange(sql, start, sql.length);
	if (tail.sql) {
		statements.push(tail);
	}

	return statements;
}

export function getSqlEditorStatusLabel(options: {
	readonly connectionId?: string;
	readonly connectionName?: string;
	readonly readOnly?: boolean;
	readonly dirty?: boolean;
	readonly running?: boolean;
}): string {
	const connection = options.connectionName ?? options.connectionId ?? 'No connection';
	const state = options.running ? 'Running' : options.dirty ? 'Draft saved' : 'Ready';
	const mode = options.readOnly === undefined ? undefined : options.readOnly ? 'Read-only' : 'Write mode';

	return [state, connection, mode].filter(Boolean).join(' · ');
}

export function getSqlEditorToolbarState(options: {
	readonly hasConnection: boolean;
	readonly hasConnections: boolean;
	readonly hasSelection: boolean;
	readonly running: boolean;
	readonly canCancel: boolean;
}): SqlEditorToolbarState {
	const canExecute = options.hasConnection && !options.running;

	return {
		canExecuteStatement: canExecute,
		canExecuteSelection: canExecute && options.hasSelection,
		canExecuteAll: canExecute,
		canFormat: !options.running,
		canChangeConnection: options.hasConnections && !options.running,
		canCancel: options.running && options.canCancel
	};
}

export function createFormatterPlaceholderResult(sql: string): string {
	return sql;
}

function findStatementBoundaries(sql: string): number[] {
	const boundaries: number[] = [];

	let inSingleQuote = false;
	let inDoubleQuote = false;
	let inBacktickIdentifier = false;
	let inBracketIdentifier = false;
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
			if (char === '\\') {
				index++;
				continue;
			}

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
			if (char === '\\') {
				index++;
				continue;
			}

			if (char === '"' && next === '"') {
				index++;
				continue;
			}

			if (char === '"') {
				inDoubleQuote = false;
			}

			continue;
		}

		if (inBacktickIdentifier) {
			if (char === '`' && next === '`') {
				index++;
				continue;
			}

			if (char === '`') {
				inBacktickIdentifier = false;
			}

			continue;
		}

		if (inBracketIdentifier) {
			if (char === ']' && next === ']') {
				index++;
				continue;
			}

			if (char === ']') {
				inBracketIdentifier = false;
			}

			continue;
		}

		if (char === '#' || (char === '-' && next === '-')) {
			inLineComment = true;
			if (char === '-') {
				index++;
			}
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

		if (char === '`') {
			inBacktickIdentifier = true;
			continue;
		}

		if (char === '[') {
			inBracketIdentifier = true;
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
