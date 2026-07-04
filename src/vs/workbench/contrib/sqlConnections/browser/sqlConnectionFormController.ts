/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection form controller (Phase 01).
 *
 * The controller is pure logic: it reads a profile + secret from the
 * widget, performs runtime status checks, then delegates to the
 * backend service. It guarantees that the widget's secret is cleared
 * even when the backend throws.
 *
 * Construction takes the dependencies directly (no DI decorators) so
 * the controller can be instantiated in `node --test` without the
 * VS Code instantiation machinery.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { ISqlConnectionServiceV2 } from '../../../services/sql/common/sqlConnection.js';
import { ISqlDriverCatalogService, SqlRuntimeDriverId, SqlRuntimeStatus } from '../../../services/sql/common/sqlDriverCatalog.js';
import { IConnectionFormWidget, ConnectionFormAction } from './sqlConnectionFormWidget.js';

export class SqlConnectionFormController extends Disposable {
	private readonly connections: ISqlConnectionServiceV2;
	private readonly catalog: ISqlDriverCatalogService;

	constructor(connections: ISqlConnectionServiceV2, catalog: ISqlDriverCatalogService) {
		super();
		this.connections = connections;
		this.catalog = catalog;
	}

	async submit(action: ConnectionFormAction, widget: IConnectionFormWidget): Promise<void> {
		const profile = widget.readProfile();
		const secret = widget.readSecret();

		try {
			// Defense in depth: never let the backend handle Planned/Disabled.
			if (profile.driver === SqlRuntimeDriverId.Postgres) {
				widget.flashError('driver_not_available', 'PostgreSQL is planned, not available yet.');
				return;
			}

			const minimum: SqlRuntimeStatus = profile.driver === SqlRuntimeDriverId.MySql
				? SqlRuntimeStatus.Preview
				: SqlRuntimeStatus.Stable;

			this.catalog.assertAtLeast(profile.driver as SqlRuntimeDriverId, minimum);

			if (action === 'test') {
				await this.connections.test(profile, secret);
				widget.flashOk('test_ok', 'Connection test passed.');
			} else {
				await this.connections.open(profile, secret);
				widget.close();
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code = (error as { code?: string })?.code ?? 'connection_error';
			widget.flashError(code, message);
		} finally {
			widget.clearSecret();
		}
	}
}