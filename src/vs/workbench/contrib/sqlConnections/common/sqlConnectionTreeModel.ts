/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL connection tree model.
 *--------------------------------------------------------------------------------------------*/

import { getSqlDriverDescriptor, SqlDriverAvailability } from '../../../services/sql/common/sqlDrivers.js';
import {
	SqlColumn,
	SqlConnection,
	SqlConnectionKind,
	SqlDatabase,
	SqlTable,
	SqlTableType
} from '../../../services/sql/common/sqlTypes.js';

export const enum SqlConnectionTreeNodeType {
	Empty = 'empty',
	Error = 'error',
	Connection = 'connection',
	Database = 'database',
	Group = 'group',
	Table = 'table',
	View = 'view',
	Column = 'column'
}

export const enum SqlConnectionTreeInlineAction {
	OpenQuery = 'openQuery',
	RefreshConnection = 'refreshConnection',
	CloseConnection = 'closeConnection',
	RetryMetadata = 'retryMetadata'
}

export interface SqlConnectionTreeNode {
	id: string;
	type: SqlConnectionTreeNodeType;
	label: string;
	description?: string;
	connectionId?: string;
	databaseName?: string;
	schema?: string;
	tableName?: string;
	columnName?: string;
	tableType?: SqlTableType;
	children?: SqlConnectionTreeNode[];
}

export interface SqlConnectionTreeSnapshot {
	connections: SqlConnection[];
	databasesByConnectionId?: Record<string, SqlDatabase[]>;
	tablesByConnectionId?: Record<string, SqlTable[]>;
	columnsByTableId?: Record<string, SqlColumn[]>;
	errorsByConnectionId?: Record<string, string>;
	errorsByTableId?: Record<string, string>;
}

const NO_INLINE_ACTIONS: readonly SqlConnectionTreeInlineAction[] = [];
const CONNECTION_INLINE_ACTIONS: readonly SqlConnectionTreeInlineAction[] = [
	SqlConnectionTreeInlineAction.OpenQuery,
	SqlConnectionTreeInlineAction.RefreshConnection,
	SqlConnectionTreeInlineAction.CloseConnection
];
const ERROR_INLINE_ACTIONS: readonly SqlConnectionTreeInlineAction[] = [SqlConnectionTreeInlineAction.RetryMetadata];

export function getSqlConnectionTreeInlineActions(
	node: Pick<SqlConnectionTreeNode, 'type' | 'connectionId'>
): readonly SqlConnectionTreeInlineAction[] {
	if (!node.connectionId) {
		return NO_INLINE_ACTIONS;
	}

	switch (node.type) {
		case SqlConnectionTreeNodeType.Connection:
			return CONNECTION_INLINE_ACTIONS;
		case SqlConnectionTreeNodeType.Error:
			return ERROR_INLINE_ACTIONS;
		default:
			return NO_INLINE_ACTIONS;
	}
}

export function buildSqlConnectionTree(snapshot: SqlConnectionTreeSnapshot): SqlConnectionTreeNode[] {
	const connections = [...snapshot.connections].sort(compareConnections);

	if (connections.length === 0) {
		return [
			{
				id: 'sql.empty',
				type: SqlConnectionTreeNodeType.Empty,
				label: 'No database connections',
				description: 'Add a SQLite or MySQL Preview connection to start browsing schemas.'
			}
		];
	}

	return connections.map(connection => buildConnectionNode(connection, snapshot));
}

export function getTableNodeId(connectionId: string, table: Pick<SqlTable, 'schema' | 'name' | 'tableType'>): string {
	return [
		'sql',
		'connection',
		escapeNodeId(connectionId),
		table.tableType,
		escapeNodeId(table.schema ?? 'main'),
		escapeNodeId(table.name)
	].join('/');
}

export function getColumnNodeId(
	connectionId: string,
	table: Pick<SqlTable, 'schema' | 'name' | 'tableType'>,
	column: Pick<SqlColumn, 'name'>
): string {
	return [getTableNodeId(connectionId, table), 'column', escapeNodeId(column.name)].join('/');
}

export function getColumnsKey(connectionId: string, table: Pick<SqlTable, 'schema' | 'name' | 'tableType'>): string {
	return getTableNodeId(connectionId, table);
}

export function getConnectionNodeId(connectionId: string): string {
	return `sql/connection/${escapeNodeId(connectionId)}`;
}

export function getDatabaseNodeId(connectionId: string, databaseName: string): string {
	return `${getConnectionNodeId(connectionId)}/database/${escapeNodeId(databaseName)}`;
}

export function getConnectionColumnsKeyPrefix(connectionId: string): string {
	return `${getConnectionNodeId(connectionId)}/`;
}

export interface SqlConnectionDescriptionOptions {
	readonly includePreview?: boolean;
}

export function describeSqlConnectionKind(kind: SqlConnectionKind): string {
	switch (kind) {
		case SqlConnectionKind.Sqlite:
			return 'SQLite';
		case SqlConnectionKind.MySql:
			return 'MySQL';
		case SqlConnectionKind.PostgreSql:
			return 'PostgreSQL';
		default:
			return String(kind);
	}
}

/**
 * Product-facing driver badge.
 *
 * Runtime availability (SqlDriverDescriptor.availability) describes the
 * SQL backend status, but the product-facing badge is what the user sees:
 * SQLite is stable, MySQL is preview-enabled, PostgreSQL is planned.
 * Do not collapse MySQL into Stable just because its runtime is enabled.
 */
export function getSqlConnectionDriverBadge(kind: SqlConnectionKind): string {
	if (kind === SqlConnectionKind.Sqlite) {
		return 'Stable';
	}

	if (kind === SqlConnectionKind.MySql) {
		return 'Preview';
	}

	if (kind === SqlConnectionKind.PostgreSql) {
		return 'Planned';
	}

	const descriptor = getSqlDriverDescriptor(kind);
	switch (descriptor.availability) {
		case SqlDriverAvailability.Enabled:
			return 'Stable';

		case SqlDriverAvailability.Planned:
			return 'Planned';

		case SqlDriverAvailability.Disabled:
			return 'Disabled';

		default:
			return descriptor.availability;
	}
}

export function describeSqlConnection(
	connection: SqlConnection,
	options: SqlConnectionDescriptionOptions = {}
): string {
	const flags: string[] = [describeSqlConnectionKind(connection.kind)];
	const badge = getSqlConnectionDriverBadge(connection.kind);
	const includePreview = options.includePreview !== false;

	if (badge !== 'Stable' && (includePreview || badge !== 'Preview')) {
		flags.push(badge);
	}

	if (connection.readOnly) {
		flags.push('read-only');
	}

	return flags.join(' · ');
}

function buildConnectionNode(connection: SqlConnection, snapshot: SqlConnectionTreeSnapshot): SqlConnectionTreeNode {
	const children: SqlConnectionTreeNode[] = [];
	const connectionError = snapshot.errorsByConnectionId?.[connection.id];
	const tables = snapshot.tablesByConnectionId?.[connection.id] ?? [];
	const columnsByTableId = snapshot.columnsByTableId ?? {};
	const errorsByTableId = snapshot.errorsByTableId ?? {};
	const databases = resolveDatabases(connection, snapshot.databasesByConnectionId?.[connection.id], tables);

	if (connectionError) {
		children.push({
			id: `${getConnectionNodeId(connection.id)}/error`,
			type: SqlConnectionTreeNodeType.Error,
			label: 'Failed to load metadata',
			description: connectionError,
			connectionId: connection.id
		});
	}

	/**
	 * Phase 02 metadata explorer: when databases are present in the
	 * snapshot, render connection → database → tables/views → table → column.
	 * Otherwise fall back to the legacy connection → tables/views shape so
	 * older callers (and the existing test suite) keep working.
	 */
	if (databases !== null) {
		if (databases.length === 0) {
			children.push({
				id: `${getConnectionNodeId(connection.id)}/empty`,
				type: SqlConnectionTreeNodeType.Empty,
				label: 'No metadata loaded',
				description: 'Refresh this connection to load databases and tables.',
				connectionId: connection.id
			});
		}

		for (const database of databases) {
			children.push(buildDatabaseNode(connection, database, tables, columnsByTableId, errorsByTableId));
		}
	} else {
		const tableNodes = buildTableNodes(connection.id, tables, SqlTableType.Table, columnsByTableId, errorsByTableId);
		const viewNodes = buildTableNodes(connection.id, tables, SqlTableType.View, columnsByTableId, errorsByTableId);

		if (tableNodes.length > 0) {
			children.push({
				id: `${getConnectionNodeId(connection.id)}/tables`,
				type: SqlConnectionTreeNodeType.Group,
				label: 'Tables',
				description: String(tableNodes.length),
				connectionId: connection.id,
				children: tableNodes
			});
		}

		if (viewNodes.length > 0) {
			children.push({
				id: `${getConnectionNodeId(connection.id)}/views`,
				type: SqlConnectionTreeNodeType.Group,
				label: 'Views',
				description: String(viewNodes.length),
				connectionId: connection.id,
				children: viewNodes
			});
		}

		if (children.length === 0) {
			children.push({
				id: `${getConnectionNodeId(connection.id)}/empty`,
				type: SqlConnectionTreeNodeType.Empty,
				label: 'No tables or views',
				description: 'The database is empty or metadata has not been loaded.',
				connectionId: connection.id
			});
		}
	}

	return {
		id: getConnectionNodeId(connection.id),
		type: SqlConnectionTreeNodeType.Connection,
		label: connection.name,
		description: describeSqlConnection(connection),
		connectionId: connection.id,
		children
	};
}

function buildDatabaseNode(
	connection: SqlConnection,
	database: SqlDatabase,
	tables: SqlTable[],
	columnsByTableId: Record<string, SqlColumn[]>,
	errorsByTableId: Record<string, string>
): SqlConnectionTreeNode {
	const databaseTables = tables.filter(table => (table.schema ?? 'main') === database.name);
	const children: SqlConnectionTreeNode[] = [];
	const tableNodes = buildTableNodes(
		connection.id,
		databaseTables,
		SqlTableType.Table,
		columnsByTableId,
		errorsByTableId
	);
	const viewNodes = buildTableNodes(
		connection.id,
		databaseTables,
		SqlTableType.View,
		columnsByTableId,
		errorsByTableId
	);

	if (tableNodes.length > 0) {
		children.push({
			id: `${getDatabaseNodeId(connection.id, database.name)}/tables`,
			type: SqlConnectionTreeNodeType.Group,
			label: 'Tables',
			description: String(tableNodes.length),
			connectionId: connection.id,
			databaseName: database.name,
			children: tableNodes
		});
	}

	if (viewNodes.length > 0) {
		children.push({
			id: `${getDatabaseNodeId(connection.id, database.name)}/views`,
			type: SqlConnectionTreeNodeType.Group,
			label: 'Views',
			description: String(viewNodes.length),
			connectionId: connection.id,
			databaseName: database.name,
			children: viewNodes
		});
	}

	if (children.length === 0) {
		children.push({
			id: `${getDatabaseNodeId(connection.id, database.name)}/empty`,
			type: SqlConnectionTreeNodeType.Empty,
			label: 'No tables or views',
			description: 'The database is empty or metadata has not been loaded.',
			connectionId: connection.id,
			databaseName: database.name
		});
	}

	return {
		id: getDatabaseNodeId(connection.id, database.name),
		type: SqlConnectionTreeNodeType.Database,
		label: database.name,
		description: connection.kind === SqlConnectionKind.Sqlite ? 'database' : 'schema',
		connectionId: connection.id,
		databaseName: database.name,
		children
	};
}

function buildTableNodes(
	connectionId: string,
	tables: SqlTable[],
	tableType: SqlTableType,
	columnsByTableId: Record<string, SqlColumn[]>,
	errorsByTableId: Record<string, string>
): SqlConnectionTreeNode[] {
	return tables
		.filter(table => table.tableType === tableType)
		.sort(compareTables)
		.map(table => {
			const tableNodeId = getTableNodeId(connectionId, table);
			const error = errorsByTableId[tableNodeId];
			const columns = [...(columnsByTableId[tableNodeId] ?? [])].sort(compareColumns);
			const children: SqlConnectionTreeNode[] = [];

			if (error) {
				children.push({
					id: `${tableNodeId}/error`,
					type: SqlConnectionTreeNodeType.Error,
					label: 'Failed to load columns',
					description: error,
					connectionId,
					databaseName: table.schema ?? 'main',
					schema: table.schema,
					tableName: table.name,
					tableType
				});
			}

			children.push(
				...columns.map(column => ({
					id: getColumnNodeId(connectionId, table, column),
					type: SqlConnectionTreeNodeType.Column,
					label: column.name,
					description: describeColumn(column),
					connectionId,
					databaseName: table.schema ?? 'main',
					schema: table.schema,
					tableName: table.name,
					columnName: column.name
				}))
			);

			return {
				id: tableNodeId,
				type: table.tableType === SqlTableType.View ? SqlConnectionTreeNodeType.View : SqlConnectionTreeNodeType.Table,
				label: table.name,
				description: table.schema,
				connectionId,
				databaseName: table.schema ?? 'main',
				schema: table.schema,
				tableName: table.name,
				tableType: table.tableType,
				children
			};
		});
}

function describeColumn(column: SqlColumn): string {
	const parts: string[] = [];

	if (column.dataType) {
		parts.push(column.dataType);
	}

	if (column.primaryKey) {
		parts.push('PK');
	}

	if (column.notNull) {
		parts.push('NOT NULL');
	}

	if (column.defaultValue) {
		parts.push(`DEFAULT ${column.defaultValue}`);
	}

	return parts.join(' · ');
}

function normalizeDatabases(
	connection: SqlConnection,
	databases: SqlDatabase[] | undefined,
	tables: readonly SqlTable[]
): SqlDatabase[] {
	const names = new Set<string>();

	for (const database of databases ?? []) {
		const name = database.name.trim();
		if (name) {
			names.add(name);
		}
	}

	/**
	 * listDatabases is intentionally non-fatal. When it fails or returns an
	 * empty list, keep the metadata explorer useful by deriving schemas from
	 * the table metadata already returned by listTables.
	 */
	if (names.size === 0) {
		for (const table of tables) {
			const schema = table.schema?.trim();
			if (schema) {
				names.add(schema);
			}
		}
	}

	if (names.size === 0 && connection.kind === SqlConnectionKind.Sqlite) {
		names.add('main');
	}

	if (names.size === 0 && connection.database?.trim()) {
		names.add(connection.database.trim());
	}

	return [...names].sort((a, b) => a.localeCompare(b)).map(name => ({ name }));
}

/**
 * Returns the database list to render for a connection, or null when the
 * snapshot does not provide one at all. Returning null signals the legacy
 * `connection → tables/views` shape so existing callers (and the existing
 * test suite) keep working without modification.
 */
function resolveDatabases(
	connection: SqlConnection,
	databases: SqlDatabase[] | undefined,
	tables: readonly SqlTable[]
): SqlDatabase[] | null {
	if (databases === undefined) {
		return null;
	}
	return normalizeDatabases(connection, databases, tables);
}

function compareConnections(left: SqlConnection, right: SqlConnection): number {
	return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function compareTables(left: SqlTable, right: SqlTable): number {
	return (left.schema ?? '').localeCompare(right.schema ?? '') || left.name.localeCompare(right.name);
}

function compareColumns(left: SqlColumn, right: SqlColumn): number {
	return left.ordinal - right.ordinal || left.name.localeCompare(right.name);
}

function escapeNodeId(value: string): string {
	return encodeURIComponent(value);
}
