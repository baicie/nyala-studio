/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL metadata service implementation.
 *--------------------------------------------------------------------------------------------*/

import { ISqlMetadataService } from '../common/sqlMetadata.js';
import { SqlColumn, SqlListColumnsRequest, SqlTable } from '../common/sqlTypes.js';
import { normalizeConnectionId, normalizeSqlListColumnsRequest } from '../common/sqlValidation.js';
import { ISqlCommandExecutor, TauriSqlCommandExecutor, toSqlServiceError } from './sqlCommandExecutor.js';

export class SqlMetadataService implements ISqlMetadataService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly executor: ISqlCommandExecutor = new TauriSqlCommandExecutor()) {}

	async listTables(connectionId: string): Promise<SqlTable[]> {
		const normalizedConnectionId = normalizeConnectionId(connectionId);

		try {
			const tables = await this.executor.execute<SqlTable[]>('sql_list_tables', {
				connectionId: normalizedConnectionId
			});

			return Array.isArray(tables) ? tables : [];
		} catch (error) {
			throw toSqlServiceError('sql_list_tables', error);
		}
	}

	async listColumns(request: SqlListColumnsRequest): Promise<SqlColumn[]> {
		const normalized = normalizeSqlListColumnsRequest(request);

		try {
			const columns = await this.executor.execute<SqlColumn[]>('sql_list_columns', {
				request: normalized
			});

			return Array.isArray(columns) ? columns : [];
		} catch (error) {
			throw toSqlServiceError('sql_list_columns', error);
		}
	}
}
