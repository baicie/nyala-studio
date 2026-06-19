/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL connection form model.
 * Phase 9.1 exposes PostgreSQL as preview only.
 *--------------------------------------------------------------------------------------------*/

import {
	getSqlDriverDescriptor,
	SqlDriverAvailability
} from '../../../services/sql/common/sqlDrivers.js';
import {
	SqlConnectionInput,
	SqlConnectionKind,
	SqlSslMode
} from '../../../services/sql/common/sqlTypes.js';

export const SQL_CONNECTION_PREVIEW_KINDS: readonly SqlConnectionKind[] = [
	SqlConnectionKind.Sqlite,
	SqlConnectionKind.PostgreSql
];

export interface SqlConnectionFormState {
	readonly kind: SqlConnectionKind;
	readonly name?: string;

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

export interface SqlConnectionFormPreview {
	readonly kind: SqlConnectionKind;
	readonly label: string;
	readonly availability: SqlDriverAvailability;
	readonly canConnect: boolean;
	readonly canSave: boolean;
	readonly message: string;
	readonly summary: string;

	/**
	 * Safe input for preview/display usage.
	 * Password is never exposed from preview.
	 */
	readonly input: SqlConnectionInput;

	/**
	 * Backward-compatible alias for callers/tests that explicitly inspect masking.
	 */
	readonly maskedInput: SqlConnectionInput;
}

export function createDefaultSqlConnectionFormState(
	kind: SqlConnectionKind = SqlConnectionKind.Sqlite
): SqlConnectionFormState {
	switch (kind) {
		case SqlConnectionKind.Sqlite:
			return {
				kind,
				name: undefined,
				databasePath: ':memory:',
				readOnly: false,
				createIfMissing: true,
				saveConnection: false,
				autoConnect: false
			};

		case SqlConnectionKind.PostgreSql:
			return {
				kind,
				name: undefined,
				host: 'localhost',
				port: 5432,
				database: 'postgres',
				username: undefined,
				password: undefined,
				sslMode: SqlSslMode.Prefer,
				readOnly: false,
				createIfMissing: false,
				saveConnection: false,
				autoConnect: false
			};

		default:
			return createDefaultSqlConnectionFormState(SqlConnectionKind.Sqlite);
	}
}

export function normalizeSqlConnectionFormState(input: Partial<SqlConnectionFormState>): SqlConnectionFormState {
	const kind = normalizePreviewKind(input.kind);
	const defaults = createDefaultSqlConnectionFormState(kind);

	if (kind === SqlConnectionKind.Sqlite) {
		const databasePath = input.databasePath === undefined
			? defaults.databasePath
			: normalizeOptionalString(input.databasePath) ?? '';

		return {
			...defaults,
			name: normalizeOptionalString(input.name),
			databasePath,
			readOnly: input.readOnly === true,
			createIfMissing: input.createIfMissing !== false,
			saveConnection: input.saveConnection === true,
			autoConnect: input.saveConnection === true && input.autoConnect === true
		};
	}

	const host = input.host === undefined
		? defaults.host
		: normalizeOptionalString(input.host) ?? '';

	const database = input.database === undefined
		? defaults.database
		: normalizeOptionalString(input.database) ?? '';

	const port = normalizePort(input.port, defaults.port);

	return {
		...defaults,
		name: normalizeOptionalString(input.name),
		host,
		port,
		database,
		username: normalizeOptionalString(input.username),
		password: normalizeOptionalString(input.password),
		sslMode: normalizeSslMode(input.sslMode),
		readOnly: false,
		createIfMissing: false,
		saveConnection: false,
		autoConnect: false
	};
}

/**
 * Creates the raw connection input represented by the form.
 * For PostgreSQL preview this may contain password in memory only.
 * It must not be persisted or logged.
 */
export function createSqlConnectionInputFromFormState(state: Partial<SqlConnectionFormState>): SqlConnectionInput {
	const normalized = normalizeSqlConnectionFormState(state);

	if (normalized.kind === SqlConnectionKind.Sqlite) {
		return {
			name: normalized.name,
			kind: SqlConnectionKind.Sqlite,
			databasePath: normalized.databasePath,
			readOnly: normalized.readOnly,
			createIfMissing: normalized.createIfMissing
		};
	}

	return {
		name: normalized.name,
		kind: SqlConnectionKind.PostgreSql,
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

		return {
			kind: normalized.kind,
			label: descriptor.label,
			availability: descriptor.availability,
			canConnect,
			canSave,
			message: canConnect
				? 'SQLite is ready.'
				: 'SQLite database path is required.',
			summary: databasePath ? `SQLite · ${databasePath}` : 'SQLite · missing database path',
			input: maskedInput,
			maskedInput
		};
	}

	const host = normalized.host?.trim() ?? '';
	const database = normalized.database?.trim() ?? '';
	const port = normalized.port;

	const missingFields = [
		host ? undefined : 'host',
		port ? undefined : 'port',
		database ? undefined : 'database'
	].filter((value): value is string => Boolean(value));

	const summary = missingFields.length > 0
		? `PostgreSQL Preview · missing ${missingFields.join(', ')}`
		: `PostgreSQL Preview · ${host}:${port}/${database}`;

	const message = missingFields.length > 0
		? `PostgreSQL Preview is missing ${missingFields.join(', ')}. Runtime connection is not enabled yet.`
		: 'PostgreSQL is preview-only in Phase 9.1. Runtime connection is not enabled yet.';

	return {
		kind: normalized.kind,
		label: descriptor.label,
		availability: descriptor.availability,
		canConnect: false,
		canSave: false,
		message,
		summary,
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

function normalizePreviewKind(kind: SqlConnectionKind | undefined): SqlConnectionKind {
	switch (kind) {
		case SqlConnectionKind.Sqlite:
		case SqlConnectionKind.PostgreSql:
			return kind;

		default:
			return SqlConnectionKind.Sqlite;
	}
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function normalizePort(value: number | undefined, fallback: number | undefined): number | undefined {
	if (value === undefined) {
		return fallback;
	}

	if (!Number.isFinite(value)) {
		return fallback;
	}

	const normalized = Math.floor(value);

	if (normalized <= 0 || normalized > 65_535) {
		return fallback;
	}

	return normalized;
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
