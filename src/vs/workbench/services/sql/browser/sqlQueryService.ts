/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL query service implementation.
 *--------------------------------------------------------------------------------------------*/

import { ISqlQueryService } from '../common/sqlQuery.js';
import {
	SqlCancelQueryRequest,
	SqlCancelQueryResult,
	SqlExecuteQueryRequest,
	SqlQueryResult
} from '../common/sqlTypes.js';
import { normalizeSqlCancelQueryRequest, normalizeSqlExecuteQueryRequest } from '../common/sqlValidation.js';
import { ISqlCommandExecutor, TauriSqlCommandExecutor, toSqlServiceError } from './sqlCommandExecutor.js';

export class SqlQueryService implements ISqlQueryService {
	declare readonly _serviceBrand: undefined;

	constructor();
	constructor(executor: ISqlCommandExecutor);
	constructor(private readonly executor: ISqlCommandExecutor = new TauriSqlCommandExecutor()) {}

	async executeQuery(request: SqlExecuteQueryRequest): Promise<SqlQueryResult> {
		const normalized = normalizeSqlExecuteQueryRequest(request);

		try {
			return await this.executor.execute<SqlQueryResult>('sql_execute_query', {
				request: normalized
			});
		} catch (error) {
			throw toSqlServiceError('sql_execute_query', error);
		}
	}

	async cancelQuery(request: SqlCancelQueryRequest): Promise<SqlCancelQueryResult> {
		const normalized = normalizeSqlCancelQueryRequest(request);

		try {
			return await this.executor.execute<SqlCancelQueryResult>('sql_cancel_query', {
				request: normalized
			});
		} catch (error) {
			throw toSqlServiceError('sql_cancel_query', error);
		}
	}
}
