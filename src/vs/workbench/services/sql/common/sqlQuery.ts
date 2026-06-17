/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL query service contract.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SqlCancelQueryRequest, SqlCancelQueryResult, SqlExecuteQueryRequest, SqlQueryResult } from './sqlTypes.js';

export const ISqlQueryService = createDecorator<ISqlQueryService>('sqlQueryService');

export interface ISqlQueryService {
	readonly _serviceBrand: undefined;

	executeQuery(request: SqlExecuteQueryRequest): Promise<SqlQueryResult>;

	cancelQuery(request: SqlCancelQueryRequest): Promise<SqlCancelQueryResult>;
}
