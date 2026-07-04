/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL metadata service contract.
 *
 * Two parallel surfaces live here:
 *
 *   * Legacy flat shape (`SqlDatabase` / `SqlTable` / `SqlColumn`) used by
 *     the original `SqlConnectionStore`. Phase 01 keeps these around for
 *     backwards compatibility.
 *
 *   * Phase 02 schema-aware shape (`SchemataDto` / `SchemaObjectDto` /
 *     `ColumnDto`) consumed by the connections tree. These types are
 *     intentionally separate from the legacy ones so the v1 IPC wire
 *     format does not leak through.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SqlColumn, SqlDatabase, SqlListColumnsRequest, SqlTable } from './sqlTypes.js';

export type SchemaObjectKind = 'table' | 'view' | 'system';

export interface ColumnDto {
	name: string;
	dataType: string;
	isNullable: boolean;
	isPrimaryKey: boolean;
	defaultValue?: string | null;
	comment?: string | null;
	ordinal: number;
}

export interface SchemaObjectDto {
	kind: SchemaObjectKind;
	name: string;
	schema?: string | null;
	columns: ColumnDto[];
	primaryKey: string[];
}

export interface SchemataDto {
	schema: string;
	isDefault: boolean;
}

export const ISqlMetadataService = createDecorator<ISqlMetadataService>('sqlMetadataService');

export interface ISqlMetadataService {
	readonly _serviceBrand: undefined;

	// Legacy flat API.
	listDatabases(connectionId: string): Promise<SqlDatabase[]>;
	listTables(connectionId: string): Promise<SqlTable[]>;
	listColumns(request: SqlListColumnsRequest): Promise<SqlColumn[]>;

	// Phase 02 schema-aware API.
	listSchemas(profileId: string, opts?: { force?: boolean }): Promise<SchemataDto[]>;
	listTablesV2(profileId: string, schema: string, opts?: { force?: boolean }): Promise<SchemaObjectDto[]>;
	listColumnsV2(profileId: string, schema: string, table: string, opts?: { force?: boolean }): Promise<ColumnDto[]>;

	/** Drops cached metadata for a profile (typically after close / re-open). */
	invalidate(profileId: string): void;
}