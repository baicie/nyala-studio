/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Tauri command executor.
 *--------------------------------------------------------------------------------------------*/

import { invoke, isTauri } from '../../../../sidex-bridge.js';

export type SqlCommandName =
	| 'sql_test_connection'
	| 'sql_open_connection'
	| 'sql_replace_connection'
	| 'sql_close_connection'
	| 'sql_list_connections'
	| 'sql_save_connection'
	| 'sql_save_and_open_connection'
	| 'sql_list_saved_connections'
	| 'sql_remove_saved_connection'
	| 'sql_restore_saved_connections'
	| 'sql_list_databases'
	| 'sql_list_tables'
	| 'sql_list_columns'
	| 'sql_execute_query'
	| 'sql_cancel_query'
	| 'sql_list_driver_runtime_status'
	| 'sql_assert_driver_runtime_status'
	| 'sql_list_driver_packages'
	| 'sql_download_driver'
	| 'sql_bootstrap_demo'
	| 'sql_validate_mysql_preview'
	// Phase 01 - Connection MVP commands.
	| 'sql_test_connection_v2'
	| 'sql_open_connection_v2'
	| 'sql_close_connection_v2'
	| 'sql_list_connections_v2'
	| 'sql_upsert_connection_v2'
	| 'sql_forget_secrets'
	// Phase 02 - Metadata Explorer commands.
	| 'sql_list_schemas'
	| 'sql_list_tables_v2'
	| 'sql_list_columns_v2';

export interface SqlCommandExecutorOptions {
	readonly allowVoid?: boolean;
}

export interface ISqlCommandExecutor {
	execute<T>(command: SqlCommandName, args?: Record<string, unknown>, options?: SqlCommandExecutorOptions): Promise<T>;
}

export class SqlServiceError extends Error {
	constructor(
		message: string,
		readonly command: SqlCommandName,
		readonly cause?: unknown,
		readonly code: string = 'sql_service_error'
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
			throw new SqlServiceError(`Tauri runtime is not available for SQL command '${command}'`, command);
		}

		try {
			const result = await invoke<T | null | undefined>(command, args);

			if ((result === null || result === undefined) && !options.allowVoid) {
				throw new SqlServiceError(`SQL command '${command}' returned no result`, command);
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

	if (typeof error === 'object' && error !== null) {
		const candidate = error as { code?: unknown; message?: unknown };
		const code = typeof candidate.code === 'string' ? candidate.code : 'sql_service_error';
		const message = typeof candidate.message === 'string' ? candidate.message : `SQL command '${command}' failed`;
		return new SqlServiceError(message, command, error, code);
	}

	return new SqlServiceError(`SQL command '${command}' failed`, command, error);
}
