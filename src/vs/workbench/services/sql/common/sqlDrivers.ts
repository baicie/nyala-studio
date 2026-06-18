/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL driver catalog.
 * Phase 7 only exposes domain metadata. Real MySQL/Postgres drivers are not enabled yet.
 *--------------------------------------------------------------------------------------------*/

import { SqlConnectionKind } from './sqlTypes.js';
import { SqlDialect } from './sqlDialect.js';

export const enum SqlDriverAvailability {
	Enabled = 'enabled',
	Planned = 'planned'
}

export interface SqlDriverCapabilities {
	readonly fileBased: boolean;
	readonly remote: boolean;
	readonly schemas: boolean;
	readonly readOnly: boolean;
	readonly createIfMissing: boolean;
	readonly transactions: boolean;
	readonly explain: boolean;
}

export interface SqlDriverDescriptor {
	readonly id: SqlConnectionKind;
	readonly label: string;
	readonly dialect: SqlDialect;
	readonly availability: SqlDriverAvailability;
	readonly capabilities: SqlDriverCapabilities;
}

export const SQLITE_DRIVER: SqlDriverDescriptor = {
	id: SqlConnectionKind.Sqlite,
	label: 'SQLite',
	dialect: SqlDialect.Sqlite,
	availability: SqlDriverAvailability.Enabled,
	capabilities: {
		fileBased: true,
		remote: false,
		schemas: true,
		readOnly: true,
		createIfMissing: true,
		transactions: true,
		explain: true
	}
};

export const SQL_DRIVER_CATALOG: readonly SqlDriverDescriptor[] = [SQLITE_DRIVER];

export function getSqlDriverDescriptor(kind: SqlConnectionKind): SqlDriverDescriptor {
	const descriptor = SQL_DRIVER_CATALOG.find(driver => driver.id === kind);

	if (!descriptor) {
		throw new Error(`Unsupported SQL driver: ${kind}`);
	}

	return descriptor;
}

export function isSqlDriverEnabled(kind: SqlConnectionKind): boolean {
	return getSqlDriverDescriptor(kind).availability === SqlDriverAvailability.Enabled;
}

export function listEnabledSqlDrivers(): SqlDriverDescriptor[] {
	return SQL_DRIVER_CATALOG.filter(driver => driver.availability === SqlDriverAvailability.Enabled);
}
