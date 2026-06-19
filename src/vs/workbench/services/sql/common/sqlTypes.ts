/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL service protocol types.
 * Phase 9 introduces multi-database-capable protocol fields.
 * SQLite remains the only enabled runtime driver.
 *--------------------------------------------------------------------------------------------*/

export const enum SqlConnectionKind {
	Sqlite = 'sqlite',
	PostgreSql = 'postgresql',
	MySql = 'mysql'
}

export const enum SqlSslMode {
	Disable = 'disable',
	Prefer = 'prefer',
	Require = 'require'
}

export interface SqlConnectionInput {
	id?: string;
	name?: string;
	kind: SqlConnectionKind;

	/**
	 * SQLite-only.
	 */
	databasePath?: string;

	/**
	 * Network database fields.
	 * Reserved for PostgreSQL/MySQL foundation in Phase 9.
	 */
	host?: string;
	port?: number;
	database?: string;
	username?: string;
	password?: string;
	sslMode?: SqlSslMode;

	readOnly?: boolean;
	createIfMissing?: boolean;
}

export interface SqlConnection {
	id: string;
	name: string;
	kind: SqlConnectionKind;

	/**
	 * SQLite-only display/runtime path.
	 */
	databasePath?: string;

	/**
	 * Network database display fields.
	 * Password is intentionally never returned.
	 */
	host?: string;
	port?: number;
	database?: string;
	username?: string;
	sslMode?: SqlSslMode;

	readOnly: boolean;
}

export interface SqlConnectionTestResult {
	ok: boolean;
	connection?: SqlConnection;
	error?: string;
}

export interface SqlDatabase {
	name: string;
}

export const enum SqlTableType {
	Table = 'table',
	View = 'view'
}

export interface SqlTable {
	schema?: string;
	name: string;
	tableType: SqlTableType;
}

export interface SqlListColumnsRequest {
	connectionId: string;
	tableName: string;
	schema?: string;
}

export interface SqlColumn {
	name: string;
	ordinal: number;
	dataType?: string;
	notNull: boolean;
	primaryKey: boolean;
	defaultValue?: string;
}

export interface SqlExecuteQueryRequest {
	connectionId: string;
	sql: string;
	limit?: number;
}

export interface SqlCancelQueryRequest {
	connectionId: string;
	queryId?: string;
}

export interface SqlCancelQueryResult {
	cancelled: boolean;
	connectionId: string;
	queryId?: string;
	message: string;
}

export const enum SqlCellKind {
	Null = 'null',
	Integer = 'integer',
	Real = 'real',
	Text = 'text',
	Blob = 'blob'
}

export type SqlCellJsonValue =
	| null
	| boolean
	| number
	| string
	| {
			encoding: 'base64';
			data: string;
			byteLength: number;
	  };

export interface SqlCellValue {
	kind: SqlCellKind;
	value?: SqlCellJsonValue;
}

export interface SqlResultColumn {
	name: string;
	ordinal: number;
}

export interface SqlQueryResult {
	columns: SqlResultColumn[];
	rows: SqlCellValue[][];
	affectedRows?: number;
	rowCount: number;
	elapsedMs: number;
	truncated: boolean;
}

export interface SqlSavedConnection {
	id: string;
	name: string;
	kind: SqlConnectionKind;

	databasePath?: string;

	host?: string;
	port?: number;
	database?: string;
	username?: string;
	sslMode?: SqlSslMode;

	readOnly: boolean;
	createIfMissing: boolean;
	autoConnect: boolean;
}

export interface SqlSaveConnectionRequest {
	input: SqlConnectionInput;
	autoConnect?: boolean;
	openNow?: boolean;
}

export interface SqlRemoveSavedConnectionRequest {
	connectionId: string;
	closeIfOpen?: boolean;
}

export interface SqlRestoreSavedConnectionError {
	connectionId: string;
	name: string;
	error: string;
}

export interface SqlRestoreSavedConnectionsResult {
	opened: SqlConnection[];
	errors: SqlRestoreSavedConnectionError[];
}
