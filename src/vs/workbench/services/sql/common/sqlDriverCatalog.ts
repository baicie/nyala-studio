/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL driver catalog contract.
 *
 * Phase 00 — Runtime Status Alignment.
 * This file mirrors the Rust-side `runtime_status::RUNTIME_STATUS_TABLE`.
 * The `id` / `status` literal strings must match the Rust enum tokens
 * exactly; the `verify-sql-runtime-status.mjs` script enforces this.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const enum SqlRuntimeDriverId {
	Sqlite = 'sqlite',
	MySql = 'mysql',
	Postgres = 'postgres'
}

export const enum SqlRuntimeStatus {
	Stable = 'stable',
	Preview = 'preview',
	Planned = 'planned',
	Disabled = 'disabled'
}

export interface SqlRuntimeDriverEntry {
	readonly id: SqlRuntimeDriverId;
	readonly displayName: string;
	readonly status: SqlRuntimeStatus;
	readonly summary: string;
	readonly notes: readonly string[];
}

export const ISqlDriverCatalogService = createDecorator<ISqlDriverCatalogService>('sqlDriverCatalogService');

export interface ISqlDriverCatalogService {
	readonly _serviceBrand: undefined;

	/**
	 * Returns the runtime status table. The list is ordered and stable.
	 * The first call resolves from the Rust backend and is cached for the
	 * session; subsequent calls return the cached snapshot.
	 */
	getRuntimeStatus(): Promise<SqlRuntimeDriverEntry[]>;

	/**
	 * Synchronous accessor for the cached status table. Throws if the
	 * catalog has not been initialised yet. Use `getRuntimeStatus()` if
	 * you are not sure whether initialisation has run.
	 */
	getCachedRuntimeStatus(): SqlRuntimeDriverEntry[];

	/**
	 * Resolve the status for a single driver id. Returns `undefined` if the
	 * id is not in the runtime status table.
	 */
	findRuntimeStatus(id: SqlRuntimeDriverId): SqlRuntimeDriverEntry | undefined;

	/**
	 * Returns true when the driver is allowed to open real runtime
	 * connections (Stable or Preview).
	 */
	isDriverRunnable(id: SqlRuntimeDriverId): boolean;
}
