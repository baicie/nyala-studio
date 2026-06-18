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

export interface SqlEditorExecutePayload {
	connectionId: string;
	sql: string;
	source: 'all' | 'selection';
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
	return connectionName ? `SQL Query \xb7 ${connectionName}` : 'SQL Query';
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
	source: 'all' | 'selection'
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

function normalizeOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}
