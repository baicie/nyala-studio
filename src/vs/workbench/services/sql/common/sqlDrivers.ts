/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL driver catalog.
 * Phase 9 introduces multi-database foundations.
 * SQLite and MySQL are enabled. PostgreSQL is planned.
 *--------------------------------------------------------------------------------------------*/

import { SqlConnectionKind } from './sqlTypes.js';
import { SqlDialect } from './sqlDialect.js';

export const enum SqlDriverAvailability {
	Enabled = 'enabled',
	Planned = 'planned',
	Disabled = 'disabled'
}

export interface SqlDriverCapabilities {
	readonly fileBased: boolean;
	readonly remote: boolean;
	readonly schemas: boolean;
	readonly readOnly: boolean;
	readonly createIfMissing: boolean;
	readonly transactions: boolean;
	readonly explain: boolean;
	readonly ssl: boolean;
	readonly credentials: boolean;
}

export interface SqlDriverDefaultPorts {
	readonly default?: number;
	readonly alternatives: readonly number[];
}

export interface SqlDriverDescriptor {
	readonly id: SqlConnectionKind;
	readonly label: string;
	readonly dialect: SqlDialect;
	readonly availability: SqlDriverAvailability;
	readonly capabilities: SqlDriverCapabilities;
	readonly defaultPorts?: SqlDriverDefaultPorts;
	readonly reason?: string;
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
		explain: true,
		ssl: false,
		credentials: false
	}
};

export const POSTGRESQL_DRIVER: SqlDriverDescriptor = {
	id: SqlConnectionKind.PostgreSql,
	label: 'PostgreSQL',
	dialect: SqlDialect.PostgreSql,
	availability: SqlDriverAvailability.Planned,
	defaultPorts: {
		default: 5432,
		alternatives: []
	},
	reason: 'PostgreSQL runtime driver is planned after the SQLite MVP is stable.',
	capabilities: {
		fileBased: false,
		remote: true,
		schemas: true,
		readOnly: false,
		createIfMissing: false,
		transactions: true,
		explain: true,
		ssl: true,
		credentials: true
	}
};

export const MYSQL_DRIVER: SqlDriverDescriptor = {
	id: SqlConnectionKind.MySql,
	label: 'MySQL',
	dialect: SqlDialect.MySql,
	availability: SqlDriverAvailability.Enabled,
	defaultPorts: {
		default: 3306,
		alternatives: []
	},
	capabilities: {
		fileBased: false,
		remote: true,
		schemas: true,
		readOnly: false,
		createIfMissing: false,
		transactions: true,
		explain: true,
		ssl: true,
		credentials: true
	}
};

export const SQL_DRIVER_CATALOG: readonly SqlDriverDescriptor[] = [
	SQLITE_DRIVER,
	POSTGRESQL_DRIVER,
	MYSQL_DRIVER
];

export function listSqlDriverDescriptors(): SqlDriverDescriptor[] {
	return [...SQL_DRIVER_CATALOG];
}

export function listEnabledSqlDrivers(): SqlDriverDescriptor[] {
	return SQL_DRIVER_CATALOG.filter(driver => driver.availability === SqlDriverAvailability.Enabled);
}

export function listPlannedSqlDrivers(): SqlDriverDescriptor[] {
	return SQL_DRIVER_CATALOG.filter(driver => driver.availability === SqlDriverAvailability.Planned);
}

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

export function assertSqlDriverEnabled(kind: SqlConnectionKind): void {
	const descriptor = getSqlDriverDescriptor(kind);

	if (descriptor.availability !== SqlDriverAvailability.Enabled) {
		throw new Error(
			`SQL driver '${descriptor.label}' is ${descriptor.availability} and cannot be used yet.`
		);
	}
}
