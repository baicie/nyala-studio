/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL service input validation helpers.
 *--------------------------------------------------------------------------------------------*/

import { assertSqlDriverEnabled } from './sqlDrivers.js';
import { createConnectionProfileFromInput, toConnectionInput } from './sqlConnectionProfile.js';
import {
	SqlCancelQueryRequest,
	SqlConnectionInput,
	SqlConnectionKind,
	SqlExecuteQueryRequest,
	SqlListColumnsRequest,
	SqlRemoveSavedConnectionRequest,
	SqlSaveConnectionRequest
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

	assertSqlDriverEnabled(input.kind);

	const profile = createConnectionProfileFromInput(input);
	const normalized = toConnectionInput(profile);

	/**
	 * Phase 9 still enables SQLite only.
	 * assertSqlDriverEnabled() already rejects planned drivers, but keep this
	 * explicit guard to prevent accidental remote driver activation by changing
	 * catalog metadata only.
	 */
	if (normalized.kind !== SqlConnectionKind.Sqlite) {
		throw new Error(`SQL driver '${normalized.kind}' is not enabled yet.`);
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

export function normalizeSqlSaveConnectionRequest(request: SqlSaveConnectionRequest): SqlSaveConnectionRequest {
	if (!request || typeof request !== 'object') {
		throw new Error('save connection request must be an object');
	}

	const input = normalizeSqlConnectionInput(request.input);

	if (input.kind === SqlConnectionKind.Sqlite && input.databasePath?.trim() === ':memory:') {
		throw new Error('in-memory SQLite connections cannot be saved');
	}

	return {
		input,
		autoConnect: request.autoConnect === true,
		openNow: request.openNow === true
	};
}

export function normalizeSqlRemoveSavedConnectionRequest(
	request: SqlRemoveSavedConnectionRequest
): SqlRemoveSavedConnectionRequest {
	if (!request || typeof request !== 'object') {
		throw new Error('remove saved connection request must be an object');
	}

	return {
		connectionId: normalizeConnectionId(request.connectionId),
		closeIfOpen: request.closeIfOpen === true
	};
}
