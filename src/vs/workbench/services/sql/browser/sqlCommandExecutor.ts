/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Tauri command executor.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '../../../../sidex-bridge.js';

export type SqlCommandName =
	| 'sql_test_connection'
	| 'sql_open_connection'
	| 'sql_close_connection'
	| 'sql_list_connections'
	| 'sql_list_tables'
	| 'sql_list_columns'
	| 'sql_execute_query'
	| 'sql_cancel_query';

export interface ISqlCommandExecutor {
	execute<T>(command: SqlCommandName, args?: Record<string, unknown>): Promise<T>;
}

export class SqlServiceError extends Error {
	constructor(
		message: string,
		readonly command: SqlCommandName,
		readonly cause?: unknown
	) {
		super(message);
		this.name = 'SqlServiceError';
	}
}

export class TauriSqlCommandExecutor implements ISqlCommandExecutor {
	async execute<T>(command: SqlCommandName, args: Record<string, unknown> = {}): Promise<T> {
		try {
			return await invoke<T>(command, args);
		} catch (error) {
			throw toSqlServiceError(command, error);
		}
	}
}

export function toSqlServiceError(command: SqlCommandName, error: unknown): SqlServiceError {
	if (error instanceof SqlServiceError) {
		return error;
	}

	if (error instanceof Error) {
		return new SqlServiceError(error.message, command, error);
	}

	if (typeof error === 'string') {
		return new SqlServiceError(error, command, error);
	}

	try {
		return new SqlServiceError(JSON.stringify(error), command, error);
	} catch {
		return new SqlServiceError(String(error), command, error);
	}
}
