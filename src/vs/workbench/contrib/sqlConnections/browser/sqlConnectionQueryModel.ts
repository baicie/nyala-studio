/*---------------------------------------------------------------------------------------------
 * Nyala Studio - Connection query model (Phase 01).
 *
 * Pure data filtering: takes saved profiles and applies a query
 * (text, driver, onlyEnabled). Used by the SQL connections view's
 * filter input box.
 *--------------------------------------------------------------------------------------------*/

import { IConnectionWithStatus } from '../../../services/sql/common/sqlConnection.js';
import { ISqlDriverCatalogService, SqlRuntimeDriverId, SqlRuntimeStatus } from '../../../services/sql/common/sqlDriverCatalog.js';

export interface ConnectionQuery {
	readonly text?: string;
	readonly driver?: SqlRuntimeDriverId;
	readonly onlyEnabled?: boolean;
}

export class SqlConnectionQueryModel {
	private readonly source: readonly IConnectionWithStatus[];
	private readonly options: { onlyEnabled?: boolean };
	private readonly catalog: ISqlDriverCatalogService;

	constructor(
		source: readonly IConnectionWithStatus[],
		options: { onlyEnabled?: boolean } = {},
		catalog: ISqlDriverCatalogService,
	) {
		this.source = source;
		this.options = options;
		this.catalog = catalog;
	}

	list(): readonly IConnectionWithStatus[] {
		return this.source;
	}

	query(query: ConnectionQuery): readonly IConnectionWithStatus[] {
		return this.source.filter((entry) => this.matches(entry, query));
	}

	private matches(entry: IConnectionWithStatus, query: ConnectionQuery): boolean {
		if (query.driver !== undefined && entry.profile.driver !== query.driver) {
			return false;
		}

		if (query.text !== undefined && query.text.trim().length > 0) {
			const needle = query.text.trim().toLowerCase();
			const label = (entry.profile.label ?? '').toLowerCase();
			if (!label.includes(needle)) {
				return false;
			}
		}

		if (query.onlyEnabled || this.options.onlyEnabled) {
			try {
				const status = this.catalog.findRuntimeStatus(entry.profile.driver)?.status;
				if (status === undefined) {
					return false;
				}
				if (status === SqlRuntimeStatus.Planned || status === SqlRuntimeStatus.Disabled) {
					return false;
				}
			} catch {
				return false;
			}
		}

		return true;
	}
}