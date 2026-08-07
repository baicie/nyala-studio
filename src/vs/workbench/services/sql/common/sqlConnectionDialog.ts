/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection editor contract.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SqlConnectionKind, SqlSavedConnection } from './sqlTypes.js';

/**
 * The two supported entry points for the connection editor.
 *
 * Keep this contract deliberately smaller than `SqlConnectionInput`: a dialog
 * request is navigation state, not a transport object, and must never carry a
 * password or a connection string.
 */
export const enum SqlConnectionDialogMode {
	New = 'new',
	Saved = 'saved'
}

export interface SqlNewConnectionDialogRequest {
	readonly mode: SqlConnectionDialogMode.New;
	readonly initialKind: SqlConnectionKind;
}

export interface SqlSavedConnectionDialogRequest {
	readonly mode: SqlConnectionDialogMode.Saved;
	readonly saved: Readonly<SqlSavedConnection>;
}

export type SqlConnectionDialogRequest = SqlNewConnectionDialogRequest | SqlSavedConnectionDialogRequest;

export const ISqlConnectionDialogService = createDecorator<ISqlConnectionDialogService>('sqlConnectionDialogService');

export interface ISqlConnectionDialogService {
	readonly _serviceBrand: undefined;

	/** Open a connection editor and resolve when its input is disposed. */
	open(request: SqlConnectionDialogRequest): Promise<void>;

	/** Open a blank connection editor for a connector kind. */
	openNew(kind?: SqlConnectionKind): Promise<void>;

	/** Open an existing saved profile for editing/connecting. */
	openSaved(saved: SqlSavedConnection): Promise<void>;
}

/**
 * Build a new-profile request with a stable, immutable shape.
 */
export function createNewSqlConnectionDialogRequest(
	kind: SqlConnectionKind = SqlConnectionKind.Sqlite
): SqlNewConnectionDialogRequest {
	return Object.freeze({
		mode: SqlConnectionDialogMode.New,
		initialKind: kind
	});
}

/**
 * Build an edit-profile request from the non-secret saved-profile fields.
 *
 * `SqlSavedConnection` intentionally has no password property. The explicit
 * copy here is still important: callers can pass a structurally-typed object
 * with extra runtime fields, and those fields must not leak into editor state.
 */
export function createSavedSqlConnectionDialogRequest(saved: SqlSavedConnection): SqlSavedConnectionDialogRequest {
	const safeSaved: SqlSavedConnection = {
		id: saved.id,
		name: saved.name,
		kind: saved.kind,
		databasePath: saved.databasePath,
		host: saved.host,
		port: saved.port,
		database: saved.database,
		username: saved.username,
		sslMode: saved.sslMode,
		readOnly: saved.readOnly,
		createIfMissing: saved.createIfMissing,
		autoConnect: saved.autoConnect
	};

	return Object.freeze({
		mode: SqlConnectionDialogMode.Saved,
		saved: Object.freeze(safeSaved)
	});
}

/**
 * Normalize a request at the service boundary so mutable caller objects and
 * accidental extra properties cannot become editor state.
 */
export function normalizeSqlConnectionDialogRequest(request: SqlConnectionDialogRequest): SqlConnectionDialogRequest {
	return request.mode === SqlConnectionDialogMode.Saved
		? createSavedSqlConnectionDialogRequest(request.saved)
		: createNewSqlConnectionDialogRequest(request.initialKind);
}

export function isSavedSqlConnectionDialogRequest(
	request: SqlConnectionDialogRequest
): request is SqlSavedConnectionDialogRequest {
	return request.mode === SqlConnectionDialogMode.Saved;
}

/**
 * Serializes one in-flight operation at a time. This is needed because the
 * workbench reuses a single modal editor part; a second command while the
 * editor is open should wait for the first editor to close instead of creating
 * a second wizard.
 */
export class SqlConnectionDialogGate<T> {
	private active: Promise<T> | undefined;

	run(factory: () => Promise<T>): Promise<T> {
		if (this.active) {
			return this.active;
		}

		let result: Promise<T>;
		try {
			result = factory();
		} catch (error) {
			result = Promise.reject(error);
		}

		const active = Promise.resolve(result).finally(() => {
			if (this.active === active) {
				this.active = undefined;
			}
		});
		this.active = active;
		return active;
	}
}
