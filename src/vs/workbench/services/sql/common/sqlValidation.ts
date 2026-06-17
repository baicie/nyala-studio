/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL service input validation helpers.
 *--------------------------------------------------------------------------------------------*/

import {
	SqlCancelQueryRequest,
	SqlConnectionInput,
	SqlConnectionKind,
	SqlExecuteQueryRequest,
	SqlListColumnsRequest
} from './sqlTypes.js';

export const SQL_DEFAULT_QUERY_LIMIT = 1_000;
export const SQL_MAX_QUERY_LIMIT = 100_000;
export const SQL_MAX_SQL_BYTES = 1_048_576;

export function assertNonEmptyString(value: unknown, fieldName: string): string {
	if (typeof value !== 'string') {
		throw new Error(`${fieldName} must be a string`);
	}

	const trimmed = value.trim();

	if (!trimmed) {
		throw new Error(`${fieldName} must not be empty`);
	}

	return trimmed;
}

export function normalizeSqlConnectionInput(input: SqlConnectionInput): SqlConnectionInput {
	if (!input || typeof input !== 'object') {
		throw new Error('connection input must be an object');
	}

	if (input.kind !== SqlConnectionKind.Sqlite) {
		throw new Error('only sqlite connections are supported in phase 3');
	}

	const databasePath = assertNonEmptyString(input.databasePath, 'databasePath');

	const normalized: SqlConnectionInput = {
		kind: SqlConnectionKind.Sqlite,
		databasePath,
		readOnly: input.readOnly === true,
		createIfMissing: input.createIfMissing === true
	};

	const id = typeof input.id === 'string' ? input.id.trim() : '';
	if (id) {
		normalized.id = id;
	}

	const name = typeof input.name === 'string' ? input.name.trim() : '';
	if (name) {
		normalized.name = name;
	}

	return normalized;
}

export function normalizeConnectionId(connectionId: unknown): string {
	return assertNonEmptyString(connectionId, 'connectionId');
}

export function normalizeSqlListColumnsRequest(request: SqlListColumnsRequest): SqlListColumnsRequest {
	if (!request || typeof request !== 'object') {
		throw new Error('list columns request must be an object');
	}

	const normalized: SqlListColumnsRequest = {
		connectionId: normalizeConnectionId(request.connectionId),
		tableName: assertNonEmptyString(request.tableName, 'tableName')
	};

	const schema = typeof request.schema === 'string' ? request.schema.trim() : '';
	if (schema) {
		normalized.schema = schema;
	}

	return normalized;
}

export function normalizeSqlExecuteQueryRequest(request: SqlExecuteQueryRequest): SqlExecuteQueryRequest {
	if (!request || typeof request !== 'object') {
		throw new Error('execute query request must be an object');
	}

	const sql = assertNonEmptyString(request.sql, 'sql');

	if (new TextEncoder().encode(sql).byteLength > SQL_MAX_SQL_BYTES) {
		throw new Error(`sql length exceeds maximum of ${SQL_MAX_SQL_BYTES} bytes`);
	}

	const normalized: SqlExecuteQueryRequest = {
		connectionId: normalizeConnectionId(request.connectionId),
		sql
	};

	if (request.limit !== undefined) {
		if (!Number.isInteger(request.limit) || request.limit <= 0) {
			throw new Error('limit must be a positive integer');
		}

		normalized.limit = Math.min(request.limit, SQL_MAX_QUERY_LIMIT);
	}

	return normalized;
}

export function normalizeSqlCancelQueryRequest(request: SqlCancelQueryRequest): SqlCancelQueryRequest {
	if (!request || typeof request !== 'object') {
		throw new Error('cancel query request must be an object');
	}

	const normalized: SqlCancelQueryRequest = {
		connectionId: normalizeConnectionId(request.connectionId)
	};

	const queryId = typeof request.queryId === 'string' ? request.queryId.trim() : '';
	if (queryId) {
		normalized.queryId = queryId;
	}

	return normalized;
}
