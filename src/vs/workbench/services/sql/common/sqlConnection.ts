/*---------------------------------------------------------------------------------------------
 * Nyala Studio - Connection profile / secret contract (Phase 01).
 *
 * The ConnectionProfile is the *durable* model that lives on disk. The
 * ConnectionSecret is the *in-memory* material that is never persisted.
 * The frontend keeps both shapes strictly separate so that:
 *
 *   * No code path can accidentally serialize a secret to disk.
 *   * UI widgets are forced to handle secrets as separate state.
 *
 * This file lives next to the existing Phase 00 SQL contracts. The
 * legacy `ISqlConnectionService` (operating on `SqlConnection` /
 * `SqlSavedConnection`) continues to work for the existing UI; the new
 * `ISqlConnectionServiceV2` operates on the cleaner profile model.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from 'vs/platform/instantiation/common/instantiation';

import { SqlRuntimeDriverId, SqlRuntimeStatus } from 'vs/workbench/services/sql/common/sqlDriverCatalog';
import { SqlSslMode } from 'vs/workbench/services/sql/common/sqlTypes';

export type ConnectionProfileDriver = SqlRuntimeDriverId;
export type ConnectionProfileStatus = SqlRuntimeStatus;

export interface ConnectionProfile {
	readonly id: string;
	readonly label: string;
	readonly driver: ConnectionProfileDriver;
	readonly readOnly: boolean;
	readonly host?: string;
	readonly port?: number;
	readonly database?: string;
	readonly username?: string;
	readonly sslMode?: SqlSslMode;
	readonly filePath?: string;
	readonly rememberInMemory?: boolean;
	readonly createdAtMs: number;
}

/**
 * Secret material that never round-trips through persistence. The
 * shape is intentionally tiny so any JSON.stringify call on a profile
 * is obviously missing the secret.
 */
export interface ConnectionSecret {
	readonly password?: string;
}

export type ConnectionStatus =
	| { readonly kind: 'idle' }
	| { readonly kind: 'testing' }
	| { readonly kind: 'opening' }
	| { readonly kind: 'open' }
	| { readonly kind: 'error'; readonly code: string; readonly message: string };

export interface IConnectionWithStatus {
	readonly profile: ConnectionProfile;
	readonly status: ConnectionStatus;
}

export const ISqlConnectionServiceV2 = createDecorator<ISqlConnectionServiceV2>('sqlConnectionServiceV2');

export interface ISqlConnectionServiceV2 {
	readonly _serviceBrand: undefined;

	/**
	 * Returns saved profiles with a default `idle` status. Callers may
	 * overwrite the `status` field locally to reflect runtime state.
	 */
	list(): Promise<IConnectionWithStatus[]>;

	/**
	 * Test a profile without persisting the secret. The backend must
	 * drop the secret after the probe completes.
	 */
	test(profile: ConnectionProfile, secret: ConnectionSecret): Promise<void>;

	/**
	 * Open a real connection. The secret is retained in memory until
	 * `close()` or `forgetAllSecrets()` is called.
	 */
	open(profile: ConnectionProfile, secret: ConnectionSecret): Promise<string>;

	close(profileId: string): Promise<void>;

	/**
	 * Clear all in-memory secrets and close every open driver. Saved
	 * profiles remain intact on disk.
	 */
	forgetAllSecrets(): Promise<void>;

	readonly onChange: import('vs/base/common/event').Event<void>;
}

/*---------------------------------------------------------------------------------------------
 * Legacy `ISqlConnectionService` (v1) compatibility shim.
 *
 * The connection form, saved-connection list, and connections UI still
 * operate on the older `SqlConnection` / `SqlConnectionInput` shapes
 * modeled in `sqlTypes.ts`. The cleaner profile-based `V2` service is
 * added on top. Both decorators coexist and bind to their respective
 * singleton implementations in `sqlService.contribution.ts`.
 *
 * Removal of the v1 surface is intentionally deferred until the
 * connections UI uses the new profile model end-to-end.
 *--------------------------------------------------------------------------------------------*/

import type {
	SqlConnection,
	SqlConnectionInput,
	SqlConnectionTestResult,
	SqlRemoveSavedConnectionRequest,
	SqlRestoreSavedConnectionsResult,
	SqlSaveConnectionRequest,
	SqlSavedConnection
} from 'vs/workbench/services/sql/common/sqlTypes';

export const ISqlConnectionService = createDecorator<ISqlConnectionService>('sqlConnectionService');

export const ISqlConnectionChangeService = createDecorator<ISqlConnectionChangeService>('sqlConnectionChangeService');

export interface ISqlConnectionChangeService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeConnections: import('vs/base/common/event').Event<void>;
	notifyConnectionsChanged(): void;
}

export interface ISqlConnectionService {
	readonly _serviceBrand: undefined;

	testConnection(input: SqlConnectionInput): Promise<SqlConnectionTestResult>;
	openConnection(input: SqlConnectionInput): Promise<SqlConnection>;
	replaceConnection(input: SqlConnectionInput): Promise<SqlConnection>;
	closeConnection(connectionId: string): Promise<void>;
	listConnections(): Promise<SqlConnection[]>;
	saveConnection(request: SqlSaveConnectionRequest): Promise<SqlSavedConnection>;
	saveAndOpenConnection(input: SqlConnectionInput, autoConnect: boolean, persist: boolean): Promise<SqlConnection>;
	listSavedConnections(): Promise<SqlSavedConnection[]>;
	removeSavedConnection(request: SqlRemoveSavedConnectionRequest): Promise<void>;
	restoreSavedConnections(): Promise<SqlRestoreSavedConnectionsResult>;
}
