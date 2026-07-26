/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - MySQL Preview validation controller (Phase 08 §2.5).
 *
 * Drives the opt-in MySQL Preview validation flow that
 * `docs/sql-mvp-phases/phase-08-mvp-packaging.md` describes:
 *
 *   1. The user opens the "Run MySQL Preview validation" action in
 *      the SQL Connections view (Phase 08 UI).
 *   2. They type host / port / username / password (the same form
 *      fields the connection tree already uses).
 *   3. The controller passes a transient profile + secret directly
 *      to the SQL product service and surfaces the structured report.
 *
 * The validation command never stores the profile or secret. The
 * backend creates a pool for the round-trip and drops it before the
 * command resolves.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { ISqlProductService } from 'vs/workbench/services/sql/common/sqlProduct';
import { SqlSslMode } from 'vs/workbench/services/sql/common/sqlTypes';

/** Result returned to the host view. */
export interface MysqlPreviewValidationOutcome {
	readonly ok: boolean;
	readonly warnings: readonly string[];
	readonly code?: string;
	readonly message?: string;
}

export class MysqlPreviewValidationController extends Disposable {
	declare readonly _brand: 'MysqlPreviewValidationController';

	constructor(@ISqlProductService private readonly productService: ISqlProductService) {
		super();
	}

	async validate(
		host: string,
		port: number,
		database: string,
		username: string,
		password: string,
		sslMode: SqlSslMode
	): Promise<MysqlPreviewValidationOutcome> {
		try {
			const report = await this.productService.validateMysqlPreview(
				{ host, port, database, username, sslMode },
				{ password }
			);
			return {
				ok: report.selectOk && report.ddlOk && report.droppedTable,
				warnings: report.warnings
			};
		} catch (error: unknown) {
			const err = error as { code?: string; message?: string };
			return {
				ok: false,
				warnings: [],
				code: err?.code,
				message: err?.message
			};
		}
	}
}
