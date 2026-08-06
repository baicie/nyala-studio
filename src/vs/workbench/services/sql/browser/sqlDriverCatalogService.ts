/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL driver catalog service implementation.
 *
 * Phase 00 — Runtime Status Alignment.
 * The service is the single frontend accessor for the Rust runtime status
 * table. UI surfaces (driver card, command palette, AI context) must
 * derive their status from this service instead of hardcoding strings.
 *
 * Phase 01 adds `assertAtLeast()` so the connection form can perform
 * a UI-side runtime guard before calling the backend.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from 'vs/base/common/event';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { SqlServiceError, TauriSqlCommandExecutor } from './sqlCommandExecutor.js';
import {
	ISqlDriverCatalogService,
	SqlRuntimeDriverEntry,
	SqlRuntimeDriverId,
	SqlRuntimeStatus
} from '../common/sqlDriverCatalog.js';

interface RawDriverRuntimeEntry {
	id: string;
	displayName: string;
	status: string;
	summary: string;
	notes: string[];
}

function normalizeId(id: string): SqlRuntimeDriverId | undefined {
	switch (id) {
		case 'sqlite':
			return SqlRuntimeDriverId.Sqlite;
		case 'mysql':
			return SqlRuntimeDriverId.MySql;
		case 'postgres':
		case 'postgresql':
			return SqlRuntimeDriverId.Postgres;
		default:
			return undefined;
	}
}

function normalizeStatus(status: string): SqlRuntimeStatus | undefined {
	switch (status) {
		case 'stable':
			return SqlRuntimeStatus.Stable;
		case 'preview':
			return SqlRuntimeStatus.Preview;
		case 'planned':
			return SqlRuntimeStatus.Planned;
		case 'disabled':
			return SqlRuntimeStatus.Disabled;
		default:
			return undefined;
	}
}

function toEntry(raw: RawDriverRuntimeEntry): SqlRuntimeDriverEntry {
	const id = normalizeId(raw.id);
	const status = normalizeStatus(raw.status);

	if (id === undefined) {
		throw new Error(`Unknown driver id from runtime status table: ${raw.id}`);
	}

	if (status === undefined) {
		throw new Error(`Unknown status from runtime status table: ${raw.status}`);
	}

	return {
		id,
		displayName: raw.displayName,
		status,
		summary: raw.summary,
		notes: Object.freeze([...raw.notes])
	};
}

export class SqlDriverCatalogService extends Disposable implements ISqlDriverCatalogService {
	declare readonly _serviceBrand: undefined;

	private cache: SqlRuntimeDriverEntry[] | undefined;
	private runtimeStatusLoad: Promise<SqlRuntimeDriverEntry[]> | undefined;
	private readonly executor: TauriSqlCommandExecutor;
	private readonly onDidChangeEmitter = this._register(new Emitter<void>());

	constructor(executor: TauriSqlCommandExecutor = new TauriSqlCommandExecutor()) {
		super();
		this.executor = executor;
	}

	onChange(listener: () => void): IDisposable {
		return this.onDidChangeEmitter.event(listener);
	}

	getRuntimeStatus(): Promise<SqlRuntimeDriverEntry[]> {
		if (this.cache !== undefined) {
			return Promise.resolve(this.cache);
		}

		return this.runtimeStatusLoad ?? this.loadRuntimeStatus();
	}

	refreshRuntimeStatus(): Promise<SqlRuntimeDriverEntry[]> {
		if (this.runtimeStatusLoad) {
			return this.runtimeStatusLoad;
		}

		this.cache = undefined;
		return this.loadRuntimeStatus();
	}

	private loadRuntimeStatus(): Promise<SqlRuntimeDriverEntry[]> {
		const load = this.fetchRuntimeStatus().finally(() => {
			if (this.runtimeStatusLoad === load) {
				this.runtimeStatusLoad = undefined;
			}
		});
		this.runtimeStatusLoad = load;
		return load;
	}

	private async fetchRuntimeStatus(): Promise<SqlRuntimeDriverEntry[]> {
		try {
			const raw = await this.executor.execute<RawDriverRuntimeEntry[]>(
				'sql_list_driver_runtime_status',
				{},
				{ allowVoid: true }
			);

			const entries = Array.isArray(raw) ? raw.map(toEntry) : [];
			this.cache = Object.freeze(entries);
			this.onDidChangeEmitter.fire();
			return this.cache;
		} catch (error) {
			// Phase 00: if the backend is unavailable (dev environment without
			// Tauri runtime), fall back to the documented truth-of-record so
			// UI still renders meaningful labels.
			if (error instanceof SqlServiceError) {
				this.cache = Object.freeze(buildOfflineFallback());
				this.onDidChangeEmitter.fire();
				return this.cache;
			}

			throw error;
		}
	}

	getCachedRuntimeStatus(): SqlRuntimeDriverEntry[] {
		if (this.cache === undefined) {
			throw new Error('SqlDriverCatalogService has not been initialised yet');
		}

		return this.cache;
	}

	findRuntimeStatus(id: SqlRuntimeDriverId): SqlRuntimeDriverEntry | undefined {
		return this.getCachedRuntimeStatus().find(entry => entry.id === id);
	}

	isDriverRunnable(id: SqlRuntimeDriverId): boolean {
		const entry = this.findRuntimeStatus(id);

		if (!entry) {
			return false;
		}

		return entry.status === SqlRuntimeStatus.Stable || entry.status === SqlRuntimeStatus.Preview;
	}

	assertAtLeast(id: SqlRuntimeDriverId, minimum: SqlRuntimeStatus): void {
		const entry = this.findRuntimeStatus(id);

		if (!entry) {
			throw new Error(`driver ${id} is not in the runtime status table`);
		}

		if (entry.status === SqlRuntimeStatus.Disabled) {
			throw new Error(`driver ${id} is disabled`);
		}

		if (!isAllowedWhenCurrentIs(minimum, entry.status)) {
			throw new Error(
				`driver ${id} does not meet required runtime status: ` + `current=${entry.status}, minimum=${minimum}`
			);
		}
	}

	labelFor(id: SqlRuntimeDriverId): string {
		const entry = this.findRuntimeStatus(id);
		if (!entry) {
			return id;
		}
		return `${entry.displayName} · ${entry.status.toUpperCase()}`;
	}
}

function isAllowedWhenCurrentIs(minimum: SqlRuntimeStatus, current: SqlRuntimeStatus): boolean {
	const matrix: Record<SqlRuntimeStatus, ReadonlySet<SqlRuntimeStatus>> = {
		[SqlRuntimeStatus.Stable]: new Set([
			SqlRuntimeStatus.Stable,
			SqlRuntimeStatus.Preview,
			SqlRuntimeStatus.Planned,
			SqlRuntimeStatus.Disabled
		]),
		[SqlRuntimeStatus.Preview]: new Set([
			SqlRuntimeStatus.Preview,
			SqlRuntimeStatus.Planned,
			SqlRuntimeStatus.Disabled
		]),
		[SqlRuntimeStatus.Planned]: new Set([SqlRuntimeStatus.Planned, SqlRuntimeStatus.Disabled]),
		[SqlRuntimeStatus.Disabled]: new Set([SqlRuntimeStatus.Disabled])
	};
	return matrix[current].has(minimum);
}

function buildOfflineFallback(): SqlRuntimeDriverEntry[] {
	return [
		{
			id: SqlRuntimeDriverId.Sqlite,
			displayName: 'SQLite',
			status: SqlRuntimeStatus.Stable,
			summary: 'File / in-memory database for MVP stable usage.',
			notes: Object.freeze([
				'supports file path',
				'supports :memory:',
				'metadata, query execution, cancellation, read-only mode enabled'
			])
		},
		{
			id: SqlRuntimeDriverId.MySql,
			displayName: 'MySQL',
			status: SqlRuntimeStatus.Preview,
			summary: 'Local/dev validation only; cancellation not enabled yet.',
			notes: Object.freeze([
				'connection, metadata, query execution enabled',
				'query cancellation is not supported yet',
				'intended for local/dev validation first'
			])
		},
		{
			id: SqlRuntimeDriverId.Postgres,
			displayName: 'PostgreSQL',
			status: SqlRuntimeStatus.Planned,
			summary: 'Protocol fields exist, runtime not enabled yet.',
			notes: Object.freeze([
				'do not show as available in any product UI',
				'runtime driver will be enabled in a later phase'
			])
		}
	];
}
