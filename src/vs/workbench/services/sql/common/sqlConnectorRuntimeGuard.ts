/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connector runtime guard.
 *--------------------------------------------------------------------------------------------*/

import { ISqlDriverCatalogService, SqlRuntimeDriverId, SqlRuntimeStatus } from './sqlDriverCatalog.js';
import { SqlConnectionKind } from './sqlTypes.js';

export function getSqlConnectorRuntimeDriverId(kind: SqlConnectionKind): SqlRuntimeDriverId {
	switch (kind) {
		case SqlConnectionKind.Sqlite:
			return SqlRuntimeDriverId.Sqlite;
		case SqlConnectionKind.MySql:
			return SqlRuntimeDriverId.MySql;
		case SqlConnectionKind.PostgreSql:
			return SqlRuntimeDriverId.Postgres;
		default:
			throw new Error(`Unknown SQL connector kind: ${String(kind)}`);
	}
}

export async function requireRunnableSqlConnector(
	kind: SqlConnectionKind,
	catalog: ISqlDriverCatalogService
): Promise<SqlRuntimeDriverId> {
	const driverId = getSqlConnectorRuntimeDriverId(kind);
	await catalog.getRuntimeStatus();
	catalog.assertAtLeast(driverId, SqlRuntimeStatus.Preview);
	return driverId;
}
