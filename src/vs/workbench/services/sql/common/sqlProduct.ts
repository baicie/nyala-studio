/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL product bootstrap and preview validation contracts.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ConnectionSecret } from './sqlConnection.js';
import { MysqlPreviewValidationInput, MysqlPreviewValidationReport, SqlDemoBootstrapResult } from './sqlTypes.js';

export const ISqlProductService = createDecorator<ISqlProductService>('sqlProductService');

export interface ISqlProductService {
	readonly _serviceBrand: undefined;

	bootstrapDemo(): Promise<SqlDemoBootstrapResult>;

	validateMysqlPreview(
		input: MysqlPreviewValidationInput,
		secret: ConnectionSecret
	): Promise<MysqlPreviewValidationReport>;
}
