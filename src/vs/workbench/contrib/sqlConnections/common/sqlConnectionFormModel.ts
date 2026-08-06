/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL connection form model.
 *
 * Runtime status:
 * - SQLite is MVP stable.
 * - MySQL is preview-enabled.
 * - PostgreSQL is planned and runtime-disabled.
 *--------------------------------------------------------------------------------------------*/

import { getSqlDriverDescriptor, SqlDriverAvailability } from '../../../services/sql/common/sqlDrivers.js';
import {
	SqlConnectionInput,
	SqlConnectionKind,
	SqlSavedConnection,
	SqlSslMode
} from '../../../services/sql/common/sqlTypes.js';

export const SQL_CONNECTION_PREVIEW_KINDS: readonly SqlConnectionKind[] = [
	SqlConnectionKind.Sqlite,
	SqlConnectionKind.MySql,
	SqlConnectionKind.PostgreSql
];

export const enum SqliteConnectionMode {
	File = 'file',
	Memory = 'memory'
}

export type SqlConnectionFormMissingField = 'databasePath' | 'host' | 'port' | 'database' | 'username';

export type SqlConnectionFormFieldRequirements = Readonly<Record<SqlConnectionFormMissingField, boolean>>;

export interface SqlConnectionFormState {
	readonly id?: string;
	readonly kind: SqlConnectionKind;
	readonly name?: string;

	readonly sqliteMode?: SqliteConnectionMode;
	readonly databasePath?: string;

	readonly host?: string;
	readonly port?: number;
	readonly database?: string;
	readonly username?: string;
	readonly password?: string;
	readonly sslMode?: SqlSslMode;

	readonly readOnly: boolean;
	readonly createIfMissing: boolean;
	readonly saveConnection: boolean;
	readonly autoConnect: boolean;
}

export type SafeSqlConnectionFormDraft = Omit<SqlConnectionFormState, 'password'>;

export interface SqlConnectionFormPreview {
	readonly kind: SqlConnectionKind;
	readonly label: string;
	readonly availability: SqlDriverAvailability;
	readonly canConnect: boolean;
	readonly canSave: boolean;
	readonly missingFields: readonly SqlConnectionFormMissingField[];
	readonly message: string;
	readonly summary: string;
	readonly input: SqlConnectionInput;
	readonly maskedInput: SqlConnectionInput;
}

export function createDefaultSqlConnectionFormState(
	kind: SqlConnectionKind = SqlConnectionKind.Sqlite,
	sqliteMode: SqliteConnectionMode = SqliteConnectionMode.File
): SqlConnectionFormState {
	switch (kind) {
		case SqlConnectionKind.Sqlite:
			return {
				kind,
				name: undefined,
				sqliteMode,
				databasePath: sqliteMode === SqliteConnectionMode.Memory ? ':memory:' : '',
				readOnly: false,
				createIfMissing: false,
				saveConnection: false,
				autoConnect: false
			};

		case SqlConnectionKind.PostgreSql:
			return createNetworkDefaults(kind, 5432, 'postgres');

		case SqlConnectionKind.MySql:
			return createNetworkDefaults(kind, 3306, 'mysql');

		default:
			return createDefaultSqlConnectionFormState(SqlConnectionKind.Sqlite);
	}
}

export function normalizeSqlConnectionFormState(input: Partial<SqlConnectionFormState>): SqlConnectionFormState {
	const kind = normalizePreviewKind(input.kind);
	const defaults = createDefaultSqlConnectionFormState(kind);
	const id = normalizeOptionalString(input.id);

	if (kind === SqlConnectionKind.Sqlite) {
		const sqliteMode = getSqliteConnectionMode(input);
		const databasePath =
			sqliteMode === SqliteConnectionMode.Memory
				? ':memory:'
				: input.databasePath === undefined
					? defaults.databasePath
					: (normalizeOptionalString(input.databasePath) ?? '');
		const saveConnection = sqliteMode === SqliteConnectionMode.File && input.saveConnection === true;

		return {
			...defaults,
			...(id ? { id } : {}),
			name: normalizeOptionalString(input.name),
			sqliteMode,
			databasePath,
			readOnly: input.readOnly === true,
			createIfMissing: sqliteMode === SqliteConnectionMode.File && input.createIfMissing === true,
			saveConnection,
			autoConnect: saveConnection && input.autoConnect === true
		};
	}

	const host = input.host === undefined ? defaults.host : (normalizeOptionalString(input.host) ?? '');

	const database = input.database === undefined ? defaults.database : (normalizeOptionalString(input.database) ?? '');

	const port = Object.prototype.hasOwnProperty.call(input, 'port') ? normalizePort(input.port) : defaults.port;

	const saveConnection = kind === SqlConnectionKind.MySql && input.saveConnection === true;

	return {
		...defaults,
		...(id ? { id } : {}),
		name: normalizeOptionalString(input.name),
		host,
		port,
		database,
		username: normalizeOptionalString(input.username),
		password: normalizePassword(input.password),
		sslMode: normalizeSslMode(input.sslMode),
		readOnly: false,
		createIfMissing: false,
		saveConnection,
		/**
		 * Runtime availability of a saved MySQL connection does not yet
		 * include a persisted secret store, so auto-connect is intentionally
		 * disabled until Secret Store lands.
		 */
		autoConnect: false
	};
}

export function getSqliteConnectionMode(
	state: Pick<Partial<SqlConnectionFormState>, 'sqliteMode' | 'databasePath'>
): SqliteConnectionMode {
	if (state.sqliteMode === SqliteConnectionMode.File || state.sqliteMode === SqliteConnectionMode.Memory) {
		return state.sqliteMode;
	}

	return state.databasePath?.trim() === ':memory:' ? SqliteConnectionMode.Memory : SqliteConnectionMode.File;
}

export function setSqliteConnectionMode(
	state: Partial<SqlConnectionFormState>,
	mode: SqliteConnectionMode
): SqlConnectionFormState {
	const databasePath =
		mode === SqliteConnectionMode.Memory
			? ':memory:'
			: state.databasePath?.trim() === ':memory:'
				? ''
				: state.databasePath;

	return normalizeSqlConnectionFormState({
		...state,
		kind: SqlConnectionKind.Sqlite,
		sqliteMode: mode,
		databasePath,
		createIfMissing: mode === SqliteConnectionMode.File && state.createIfMissing === true,
		saveConnection: mode === SqliteConnectionMode.File && state.saveConnection === true,
		autoConnect: mode === SqliteConnectionMode.File && state.autoConnect === true
	});
}

export function getSqlConnectionFormFieldRequirements(
	state: Pick<Partial<SqlConnectionFormState>, 'kind' | 'sqliteMode' | 'databasePath'>
): SqlConnectionFormFieldRequirements {
	const kind = state.kind ?? SqlConnectionKind.Sqlite;
	const isSqlite = kind === SqlConnectionKind.Sqlite;
	const isSqliteFile = isSqlite && getSqliteConnectionMode(state) === SqliteConnectionMode.File;

	return {
		databasePath: isSqliteFile,
		host: !isSqlite,
		port: !isSqlite,
		database: !isSqlite,
		username: kind === SqlConnectionKind.MySql
	};
}

export function createSafeSqlConnectionFormDraft(state: Partial<SqlConnectionFormState>): SafeSqlConnectionFormDraft {
	const { password: _password, ...safeDraft } = normalizeSqlConnectionFormState(state);
	return safeDraft;
}

export function createSqlConnectionFormStateFromSavedConnection(saved: SqlSavedConnection): SqlConnectionFormState {
	return createSafeSqlConnectionFormDraft({
		id: saved.id,
		kind: saved.kind,
		name: saved.name,
		sqliteMode: saved.databasePath === ':memory:' ? SqliteConnectionMode.Memory : SqliteConnectionMode.File,
		databasePath: saved.databasePath,
		host: saved.host,
		port: saved.port,
		database: saved.database,
		username: saved.username,
		sslMode: saved.sslMode,
		readOnly: saved.readOnly,
		createIfMissing: saved.createIfMissing,
		saveConnection: true,
		autoConnect: saved.autoConnect
	});
}

export function createSqlConnectionInputFromFormState(state: Partial<SqlConnectionFormState>): SqlConnectionInput {
	const normalized = normalizeSqlConnectionFormState(state);

	if (normalized.kind === SqlConnectionKind.Sqlite) {
		return {
			...(normalized.id ? { id: normalized.id } : {}),
			name: normalized.name,
			kind: SqlConnectionKind.Sqlite,
			databasePath: normalized.databasePath,
			readOnly: normalized.readOnly,
			createIfMissing: normalized.createIfMissing
		};
	}

	return {
		...(normalized.id ? { id: normalized.id } : {}),
		name: normalized.name,
		kind: normalized.kind,
		host: normalized.host,
		port: normalized.port,
		database: normalized.database,
		username: normalized.username,
		password: normalized.password,
		sslMode: normalized.sslMode,
		readOnly: false,
		createIfMissing: false
	};
}

export function createSafeSqlConnectionInputFromFormState(state: Partial<SqlConnectionFormState>): SqlConnectionInput {
	return maskSqlConnectionInput(createSqlConnectionInputFromFormState(state));
}

export function maskSqlConnectionInput(input: SqlConnectionInput): SqlConnectionInput {
	const { password: _password, ...rest } = input;
	return rest;
}

export function createSqlConnectionFormPreview(state: Partial<SqlConnectionFormState>): SqlConnectionFormPreview {
	const normalized = normalizeSqlConnectionFormState(state);
	const rawInput = createSqlConnectionInputFromFormState(normalized);
	const descriptor = getSqlDriverDescriptor(normalized.kind);
	const maskedInput = maskSqlConnectionInput(rawInput);

	if (normalized.kind === SqlConnectionKind.Sqlite) {
		const databasePath = normalized.databasePath?.trim() ?? '';
		const canConnect = Boolean(databasePath);
		const canSave = canConnect && databasePath !== ':memory:' && normalized.saveConnection;
		const missingFields: SqlConnectionFormMissingField[] = databasePath ? [] : ['databasePath'];

		return {
			kind: normalized.kind,
			label: descriptor.label,
			availability: descriptor.availability,
			canConnect,
			canSave,
			missingFields,
			message: canConnect ? 'SQLite is ready.' : 'SQLite database path is required.',
			summary: databasePath ? `SQLite · ${databasePath}` : 'SQLite · missing database path',
			input: maskedInput,
			maskedInput
		};
	}

	const host = normalized.host?.trim() ?? '';
	const database = normalized.database?.trim() ?? '';
	const port = normalized.port;

	const missingFields: SqlConnectionFormMissingField[] = [
		host ? undefined : 'host',
		port === undefined ? 'port' : undefined,
		database ? undefined : 'database',
		normalized.kind === SqlConnectionKind.MySql && !normalized.username ? 'username' : undefined
	].filter((value): value is SqlConnectionFormMissingField => Boolean(value));

	if (normalized.kind === SqlConnectionKind.PostgreSql) {
		return {
			kind: normalized.kind,
			label: descriptor.label,
			availability: descriptor.availability,
			canConnect: false,
			canSave: false,
			missingFields,
			message:
				missingFields.length > 0
					? `PostgreSQL Planned is missing ${missingFields.join(', ')}. Runtime connection is not enabled yet.`
					: 'PostgreSQL is planned. Runtime connection is not enabled yet.',
			summary:
				missingFields.length > 0
					? `PostgreSQL Planned · missing ${missingFields.join(', ')}`
					: `PostgreSQL Planned · ${host}:${port}/${database}`,
			input: maskedInput,
			maskedInput
		};
	}

	const canConnect = missingFields.length === 0;
	const canSave = canConnect && normalized.saveConnection;
	const cancellationWarning = 'Query cancellation is not supported yet.';

	return {
		kind: normalized.kind,
		label: descriptor.label,
		availability: descriptor.availability,
		canConnect,
		canSave,
		missingFields,
		message: canConnect
			? `MySQL Preview runtime is ready. ${cancellationWarning}`
			: `MySQL connection is missing ${missingFields.join(', ')}. ${cancellationWarning}`,
		summary: canConnect
			? `MySQL Preview · ${host}:${port}/${database}`
			: `MySQL Preview · missing ${missingFields.join(', ')}`,
		input: maskedInput,
		maskedInput
	};
}

export function canSubmitSqlConnectionForm(state: Partial<SqlConnectionFormState>): boolean {
	return createSqlConnectionFormPreview(state).canConnect;
}

export function canSaveSqlConnectionForm(state: Partial<SqlConnectionFormState>): boolean {
	return createSqlConnectionFormPreview(state).canSave;
}

export function getSqlConnectionFormStatus(state: Partial<SqlConnectionFormState>): string {
	const preview = createSqlConnectionFormPreview(state);
	return `${preview.summary} · ${preview.message}`;
}

function createNetworkDefaults(
	kind: SqlConnectionKind.PostgreSql | SqlConnectionKind.MySql,
	port: number,
	database: string
): SqlConnectionFormState {
	return {
		kind,
		name: undefined,
		host: 'localhost',
		port,
		database,
		username: undefined,
		password: undefined,
		sslMode: SqlSslMode.Prefer,
		readOnly: false,
		createIfMissing: false,
		saveConnection: false,
		autoConnect: false
	};
}

function normalizePreviewKind(kind: SqlConnectionKind | undefined): SqlConnectionKind {
	switch (kind) {
		case SqlConnectionKind.Sqlite:
		case SqlConnectionKind.PostgreSql:
		case SqlConnectionKind.MySql:
			return kind;

		default:
			return SqlConnectionKind.Sqlite;
	}
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function normalizePassword(value: string | undefined): string | undefined {
	return value === '' ? undefined : value;
}

function normalizePort(value: number | undefined): number | undefined {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 65_535) {
		return undefined;
	}

	return value;
}

function normalizeSslMode(value: SqlSslMode | undefined): SqlSslMode {
	switch (value) {
		case SqlSslMode.Disable:
		case SqlSslMode.Prefer:
		case SqlSslMode.Require:
			return value;

		default:
			return SqlSslMode.Prefer;
	}
}
