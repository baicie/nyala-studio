/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL connection service implementation.
 *--------------------------------------------------------------------------------------------*/

import { ISqlConnectionService } from '../common/sqlConnection.js';
import { SqlConnection, SqlConnectionInput, SqlConnectionTestResult } from '../common/sqlTypes.js';
import { normalizeConnectionId, normalizeSqlConnectionInput } from '../common/sqlValidation.js';
import { ISqlCommandExecutor, TauriSqlCommandExecutor, toSqlServiceError } from './sqlCommandExecutor.js';

export class SqlConnectionService implements ISqlConnectionService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly executor: ISqlCommandExecutor = new TauriSqlCommandExecutor()) {}

	async testConnection(input: SqlConnectionInput): Promise<SqlConnectionTestResult> {
		const normalized = normalizeSqlConnectionInput(input);

		try {
			return await this.executor.execute<SqlConnectionTestResult>('sql_test_connection', {
				input: normalized
			});
		} catch (error) {
			throw toSqlServiceError('sql_test_connection', error);
		}
	}

	async openConnection(input: SqlConnectionInput): Promise<SqlConnection> {
		const normalized = normalizeSqlConnectionInput(input);

		try {
			return await this.executor.execute<SqlConnection>('sql_open_connection', {
				input: normalized
			});
		} catch (error) {
			throw toSqlServiceError('sql_open_connection', error);
		}
	}

	async closeConnection(connectionId: string): Promise<void> {
		const normalizedConnectionId = normalizeConnectionId(connectionId);

		try {
			await this.executor.execute<void>('sql_close_connection', {
				connectionId: normalizedConnectionId
			});
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
}
