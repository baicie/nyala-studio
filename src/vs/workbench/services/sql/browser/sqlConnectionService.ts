/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL connection service implementation.
 *--------------------------------------------------------------------------------------------*/

import { ISqlConnectionService } from '../common/sqlConnection.js';
import {
	SqlConnection,
	SqlConnectionInput,
	SqlConnectionTestResult,
	SqlRemoveSavedConnectionRequest,
	SqlRestoreSavedConnectionsResult,
	SqlSaveConnectionRequest,
	SqlSavedConnection
} from '../common/sqlTypes.js';
import {
	normalizeConnectionId,
	normalizeSqlConnectionInput,
	normalizeSqlRemoveSavedConnectionRequest,
	normalizeSqlSaveConnectionRequest
} from '../common/sqlValidation.js';
import { ISqlCommandExecutor, TauriSqlCommandExecutor, toSqlServiceError } from './sqlCommandExecutor.js';

export class SqlConnectionService implements ISqlConnectionService {
	declare readonly _serviceBrand: undefined;

	constructor();
	constructor(executor: ISqlCommandExecutor);
	constructor(private readonly executor: ISqlCommandExecutor = new TauriSqlCommandExecutor()) {}

	async testConnection(input: SqlConnectionInput): Promise<SqlConnectionTestResult> {
		const normalized = normalizeSqlConnectionInput(input, {
			preserveSecrets: true
		});

		try {
			return await this.executor.execute<SqlConnectionTestResult>('sql_test_connection', {
				input: normalized
			});
		} catch (error) {
			throw toSqlServiceError('sql_test_connection', error);
		}
	}

	async openConnection(input: SqlConnectionInput): Promise<SqlConnection> {
		const normalized = normalizeSqlConnectionInput(input, {
			preserveSecrets: true
		});

		try {
			return await this.executor.execute<SqlConnection>('sql_open_connection', {
				input: normalized
			});
		} catch (error) {
			throw toSqlServiceError('sql_open_connection', error);
		}
	}

	async replaceConnection(input: SqlConnectionInput): Promise<SqlConnection> {
		const normalized = normalizeSqlConnectionInput(input, {
			preserveSecrets: true
		});

		try {
			return await this.executor.execute<SqlConnection>('sql_replace_connection', {
				input: normalized
			});
		} catch (error) {
			throw toSqlServiceError('sql_replace_connection', error);
		}
	}

	async closeConnection(connectionId: string): Promise<void> {
		const normalizedConnectionId = normalizeConnectionId(connectionId);

		try {
			await this.executor.execute<void>(
				'sql_close_connection',
				{
					connectionId: normalizedConnectionId
				},
				{
					allowVoid: true
				}
			);
		} catch (error) {
			throw toSqlServiceError('sql_close_connection', error);
		}
	}

	async listConnections(): Promise<SqlConnection[]> {
		try {
			const connections = await this.executor.execute<SqlConnection[]>('sql_list_connections');
			return Array.isArray(connections) ? connections : [];
		} catch (error) {
			throw toSqlServiceError('sql_list_connections', error);
		}
	}

	async saveConnection(request: SqlSaveConnectionRequest): Promise<SqlSavedConnection> {
		const normalized = normalizeSqlSaveConnectionRequest(request);

		try {
			return await this.executor.execute<SqlSavedConnection>('sql_save_connection', {
				request: normalized
			});
		} catch (error) {
			throw toSqlServiceError('sql_save_connection', error);
		}
	}

	async saveAndOpenConnection(
		input: SqlConnectionInput,
		autoConnect: boolean,
		persist: boolean
	): Promise<SqlConnection> {
		const normalized = normalizeSqlConnectionInput(input, {
			preserveSecrets: true
		});

		try {
			return await this.executor.execute<SqlConnection>('sql_save_and_open_connection', {
				input: normalized,
				autoConnect,
				persist
			});
		} catch (error) {
			throw toSqlServiceError('sql_save_and_open_connection', error);
		}
	}

	async listSavedConnections(): Promise<SqlSavedConnection[]> {
		try {
			const connections = await this.executor.execute<SqlSavedConnection[]>('sql_list_saved_connections');
			return Array.isArray(connections) ? connections : [];
		} catch (error) {
			throw toSqlServiceError('sql_list_saved_connections', error);
		}
	}

	async removeSavedConnection(request: SqlRemoveSavedConnectionRequest): Promise<void> {
		const normalized = normalizeSqlRemoveSavedConnectionRequest(request);

		try {
			await this.executor.execute<void>(
				'sql_remove_saved_connection',
				{
					request: normalized
				},
				{
					allowVoid: true
				}
			);
		} catch (error) {
			throw toSqlServiceError('sql_remove_saved_connection', error);
		}
	}

	async restoreSavedConnections(): Promise<SqlRestoreSavedConnectionsResult> {
		try {
			return await this.executor.execute<SqlRestoreSavedConnectionsResult>('sql_restore_saved_connections');
		} catch (error) {
			throw toSqlServiceError('sql_restore_saved_connections', error);
		}
	}
}
