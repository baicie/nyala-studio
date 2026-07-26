/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL product command service.
 *--------------------------------------------------------------------------------------------*/

import { ConnectionSecret } from '../common/sqlConnection.js';
import { ISqlProductService } from '../common/sqlProduct.js';
import {
	MysqlPreviewValidationInput,
	MysqlPreviewValidationReport,
	SqlDemoBootstrapResult
} from '../common/sqlTypes.js';
import { ISqlCommandExecutor, TauriSqlCommandExecutor } from './sqlCommandExecutor.js';

export class SqlProductService implements ISqlProductService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly executor: ISqlCommandExecutor = new TauriSqlCommandExecutor()) {}

	bootstrapDemo(): Promise<SqlDemoBootstrapResult> {
		return this.executor.execute<SqlDemoBootstrapResult>('sql_bootstrap_demo');
	}

	validateMysqlPreview(
		input: MysqlPreviewValidationInput,
		secret: ConnectionSecret
	): Promise<MysqlPreviewValidationReport> {
		return this.executor.execute<MysqlPreviewValidationReport>('sql_validate_mysql_preview', {
			input,
			secret
		});
	}
}
