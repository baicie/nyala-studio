/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - normalized SQL connection profile.
 * This is UI/domain foundation only. It does not enable non-SQLite runtimes.
 *--------------------------------------------------------------------------------------------*/

import { getSqlDriverDescriptor } from './sqlDrivers.js';
import {
	SqlConnection,
	SqlConnectionInput,
	SqlConnectionKind,
	SqlSavedConnection,
	SqlSslMode
} from './sqlTypes.js';

export const enum SqlConnectionProfileMode {
	File = 'file',
	Network = 'network'
}

export interface SqlConnectionProfile {
	readonly id?: string;
	readonly name?: string;
	readonly kind: SqlConnectionKind;
	readonly mode: SqlConnectionProfileMode;
	readonly label: string;

	readonly databasePath?: string;

	readonly host?: string;
	readonly port?: number;
	readonly database?: string;
	readonly username?: string;
	readonly sslMode?: SqlSslMode;

	readonly readOnly: boolean;
	readonly createIfMissing: boolean;
}

export function createConnectionProfileFromInput(input: SqlConnectionInput): SqlConnectionProfile {
	const kind = normalizeConnectionKind(input.kind);
	const descriptor = getSqlDriverDescriptor(kind);
	const id = normalizeOptionalString(input.id);
	const name = normalizeOptionalString(input.name);

	if (descriptor.capabilities.fileBased) {
		const databasePath = normalizeRequiredString(input.databasePath, 'databasePath');

		return {
			id,
			name,
			kind,
			mode: SqlConnectionProfileMode.File,
			label: name ?? databasePath,
			databasePath,
			readOnly: input.readOnly === true,
			createIfMissing: input.createIfMissing === true
		};
	}

	const host = normalizeRequiredString(input.host, 'host');
	const database = normalizeRequiredString(input.database, 'database');
	const port = normalizePort(input.port, descriptor.defaultPorts?.default);
	const username = normalizeOptionalString(input.username);

	return {
		id,
		name,
		kind,
		mode: SqlConnectionProfileMode.Network,
		label: name ?? `${descriptor.label} · ${host}:${port}/${database}`,
		host,
		port,
		database,
		username,
		sslMode: normalizeSslMode(input.sslMode),
		readOnly: input.readOnly === true,
		createIfMissing: false
	};
}

export function createConnectionProfileFromConnection(connection: SqlConnection): SqlConnectionProfile {
	return createConnectionProfileFromInput({
		id: connection.id,
		name: connection.name,
		kind: connection.kind,
		databasePath: connection.databasePath,
		host: connection.host,
		port: connection.port,
		database: connection.database,
		username: connection.username,
		sslMode: connection.sslMode,
		readOnly: connection.readOnly
	});
}

export function createConnectionProfileFromSavedConnection(connection: SqlSavedConnection): SqlConnectionProfile {
	return createConnectionProfileFromInput({
		id: connection.id,
		name: connection.name,
		kind: connection.kind,
		databasePath: connection.databasePath,
		host: connection.host,
		port: connection.port,
		database: connection.database,
		username: connection.username,
		sslMode: connection.sslMode,
		readOnly: connection.readOnly,
		createIfMissing: connection.createIfMissing
	});
}

export function toConnectionInput(profile: SqlConnectionProfile): SqlConnectionInput {
	if (profile.mode === SqlConnectionProfileMode.File) {
		return {
			id: profile.id,
			name: profile.name,
			kind: profile.kind,
			databasePath: profile.databasePath,
			readOnly: profile.readOnly,
			createIfMissing: profile.createIfMissing
		};
	}

	return {
		id: profile.id,
		name: profile.name,
		kind: profile.kind,
		host: profile.host,
		port: profile.port,
		database: profile.database,
		username: profile.username,
		sslMode: profile.sslMode,
		readOnly: profile.readOnly
	};
}

export function getConnectionDisplayName(input: SqlConnectionInput): string {
	return createConnectionProfileFromInput(input).label;
}

export function maskConnectionInput(input: SqlConnectionInput): SqlConnectionInput {
	const { password: _password, ...rest } = input;
	return rest;
}

function normalizeConnectionKind(kind: SqlConnectionKind): SqlConnectionKind {
	switch (kind) {
		case SqlConnectionKind.Sqlite:
		case SqlConnectionKind.PostgreSql:
		case SqlConnectionKind.MySql:
			return kind;

		default:
			throw new Error(`Unsupported SQL connection kind: ${String(kind)}`);
	}
}

function normalizeRequiredString(value: string | undefined, fieldName: string): string {
	const normalized = normalizeOptionalString(value);

	if (!normalized) {
		throw new Error(`${fieldName} must not be empty`);
	}

	if (normalized.includes('\0')) {
		throw new Error(`${fieldName} must not contain NUL bytes`);
	}

	return normalized;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function normalizePort(value: number | undefined, fallback: number | undefined): number {
	const port = value ?? fallback;

	if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
		throw new Error('port must be an integer between 1 and 65535');
	}

	return port;
}

function normalizeSslMode(value: SqlSslMode | undefined): SqlSslMode {
	switch (value) {
		case undefined:
			return SqlSslMode.Prefer;

		case SqlSslMode.Disable:
		case SqlSslMode.Prefer:
		case SqlSslMode.Require:
			return value;

		default:
			throw new Error(`Unsupported SQL ssl mode: ${String(value)}`);
	}
}
