/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Tauri command executor.
 *--------------------------------------------------------------------------------------------*/

import { invoke, isTauri } from '../../../../sidex-bridge.js';

export type SqlCommandName =
	| 'sql_test_connection'
	| 'sql_open_connection'
	| 'sql_close_connection'
	| 'sql_list_connections'
	| 'sql_save_connection'
	| 'sql_list_saved_connections'
	| 'sql_remove_saved_connection'
	| 'sql_restore_saved_connections'
	| 'sql_list_databases'
	| 'sql_list_tables'
	| 'sql_list_columns'
	| 'sql_execute_query'
	| 'sql_cancel_query'
	| 'sql_list_driver_runtime_status'
	| 'sql_assert_driver_runtime_status';

export interface SqlCommandExecutorOptions {
	readonly allowVoid?: boolean;
}

export interface ISqlCommandExecutor {
	execute<T>(
		command: SqlCommandName,
		args?: Record<string, unknown>,
		options?: SqlCommandExecutorOptions
	): Promise<T>;
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
	async execute<T>(
		command: SqlCommandName,
		args: Record<string, unknown> = {},
		options: SqlCommandExecutorOptions = {}
	): Promise<T> {
		if (!isTauri()) {
			throw new SqlServiceError(
				`Tauri runtime is not available for SQL command '${command}'`,
				command
			);
		}

		try {
			const result = await invoke<T | null | undefined>(command, args);

			if ((result === null || result === undefined) && !options.allowVoid) {
				throw new SqlServiceError(
					`SQL command '${command}' returned no result`,
					command
				);
			}

			return result as T;
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
