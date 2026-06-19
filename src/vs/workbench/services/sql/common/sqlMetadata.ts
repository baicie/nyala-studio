/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL metadata service contract.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SqlColumn, SqlDatabase, SqlListColumnsRequest, SqlTable } from './sqlTypes.js';

export const ISqlMetadataService = createDecorator<ISqlMetadataService>('sqlMetadataService');

export interface ISqlMetadataService {
	readonly _serviceBrand: undefined;

	listDatabases(connectionId: string): Promise<SqlDatabase[]>;

	listTables(connectionId: string): Promise<SqlTable[]>;

	listColumns(request: SqlListColumnsRequest): Promise<SqlColumn[]>;
}
