/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL metadata service contract.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SqlColumn, SqlListColumnsRequest, SqlTable } from './sqlTypes.js';

export const ISqlMetadataService = createDecorator<ISqlMetadataService>('sqlMetadataService');

export interface ISqlMetadataService {
	readonly _serviceBrand: undefined;

	listTables(connectionId: string): Promise<SqlTable[]>;

	listColumns(request: SqlListColumnsRequest): Promise<SqlColumn[]>;
}
