/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL metadata service implementation.
 *
 * Phase 02 adds:
 *   * v2 schema-aware methods (`listSchemas` / `listTablesV2` / `listColumnsV2`)
 *     backed by `ConnectionManager.with_conn`.
 *   * An in-process TTL cache (30s by default) to keep rapid tree
 *     expansions snappy without hammering the backend.
 *   * A profile-keyed `invalidate()` so connection close / re-open
 *     paths drop stale entries.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import {
	ColumnDto,
	ISqlMetadataService,
	SchemataDto,
	SchemaObjectDto,
} from '../common/sqlMetadata.js';
import { SqlColumn, SqlDatabase, SqlListColumnsRequest, SqlTable } from '../common/sqlTypes.js';
import { normalizeConnectionId, normalizeSqlListColumnsRequest } from '../common/sqlValidation.js';
import { ISqlCommandExecutor, TauriSqlCommandExecutor, toSqlServiceError } from './sqlCommandExecutor.js';

const DEFAULT_TTL_MS = 30_000;

interface CacheEntry<T> {
	value: T;
	ts: number;
}

export interface SqlMetadataServiceOptions {
	readonly ttlMs?: number;
}

export class SqlMetadataService extends Disposable implements ISqlMetadataService {
	declare readonly _serviceBrand: undefined;

	private readonly ttlMs: number;
	private readonly schemaCache = new Map<string, CacheEntry<SchemataDto[]>>();
	private readonly tablesCache = new Map<string, CacheEntry<SchemaObjectDto[]>>();
	private readonly columnsCache = new Map<string, CacheEntry<ColumnDto[]>>();

	constructor(
		private readonly executor: ISqlCommandExecutor = new TauriSqlCommandExecutor(),
		options: SqlMetadataServiceOptions = {}
	) {
		super();
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	}

	async listDatabases(connectionId: string): Promise<SqlDatabase[]> {
		const normalizedConnectionId = normalizeConnectionId(connectionId);

		try {
			const databases = await this.executor.execute<SqlDatabase[]>('sql_list_databases', {
				connectionId: normalizedConnectionId
			});

			return Array.isArray(databases) ? databases : [];
		} catch (error) {
			throw toSqlServiceError('sql_list_databases', error);
		}
	}

	async listTables(connectionId: string): Promise<SqlTable[]> {
		const normalizedConnectionId = normalizeConnectionId(connectionId);

		try {
			const tables = await this.executor.execute<SqlTable[]>('sql_list_tables', {
				connectionId: normalizedConnectionId
			});

			return Array.isArray(tables) ? tables : [];
		} catch (error) {
			throw toSqlServiceError('sql_list_tables', error);
		}
	}

	async listColumns(request: SqlListColumnsRequest): Promise<SqlColumn[]> {
		const normalized = normalizeSqlListColumnsRequest(request);

		try {
			const columns = await this.executor.execute<SqlColumn[]>('sql_list_columns', {
				request: normalized
			});

			return Array.isArray(columns) ? columns : [];
		} catch (error) {
			throw toSqlServiceError('sql_list_columns', error);
		}
	}

	async listSchemas(profileId: string, opts?: { force?: boolean }): Promise<SchemataDto[]> {
		const normalized = this.normalizeProfileId(profileId);
		const key = normalized;
		return this.cached(this.schemaCache, key, opts?.force, () =>
			this.executor.execute<SchemataDto[]>('sql_list_schemas', { profileId: normalized })
		).catch((err) => {
			throw toSqlServiceError('sql_list_schemas', err);
		});
	}

	async listTablesV2(
		profileId: string,
		schema: string,
		opts?: { force?: boolean }
	): Promise<SchemaObjectDto[]> {
		const profile = this.normalizeProfileId(profileId);
		const schemaName = this.normalizeSchema(schema);
		const key = `${profile}|${schemaName}`;
		return this.cached(this.tablesCache, key, opts?.force, () =>
			this.executor.execute<SchemaObjectDto[]>('sql_list_tables_v2', {
				profileId: profile,
				schema: schemaName
			})
		).catch((err) => {
			throw toSqlServiceError('sql_list_tables_v2', err);
		});
	}

	async listColumnsV2(
		profileId: string,
		schema: string,
		table: string,
		opts?: { force?: boolean }
	): Promise<ColumnDto[]> {
		const profile = this.normalizeProfileId(profileId);
		const schemaName = this.normalizeSchema(schema);
		const tableName = this.normalizeSchema(table);
		const key = `${profile}|${schemaName}|${tableName}`;
		return this.cached(this.columnsCache, key, opts?.force, () =>
			this.executor.execute<ColumnDto[]>('sql_list_columns_v2', {
				profileId: profile,
				schema: schemaName,
				table: tableName
			})
		).catch((err) => {
			throw toSqlServiceError('sql_list_columns_v2', err);
		});
	}

	invalidate(profileId: string): void {
		const prefix = `${profileId}|`;
		for (const map of [this.schemaCache, this.tablesCache, this.columnsCache]) {
			for (const k of [...map.keys()]) {
				if (k === profileId || k.startsWith(prefix)) {
					map.delete(k);
				}
			}
		}
	}

	private async cached<T>(
		map: Map<string, CacheEntry<T>>,
		key: string,
		force: boolean | undefined,
		invoke: () => Promise<T>
	): Promise<T> {
		const now = Date.now();
		const hit = map.get(key);
		if (!force && hit && now - hit.ts < this.ttlMs) {
			return hit.value;
		}
		const value = await invoke();
		map.set(key, { value, ts: now });
		return value;
	}

	private normalizeProfileId(profileId: string): string {
		if (typeof profileId !== 'string' || profileId.length === 0) {
			throw toSqlServiceError('sql_list_schemas', new Error('profileId is required'));
		}
		return profileId;
	}

	private normalizeSchema(schema: string): string {
		if (typeof schema !== 'string' || schema.length === 0) {
			throw toSqlServiceError('sql_list_schemas', new Error('schema is required'));
		}
		return schema;
	}
}