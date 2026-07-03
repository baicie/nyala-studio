/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL connection tree model.
 *--------------------------------------------------------------------------------------------*/

import {
	getSqlDriverDescriptor,
	SqlDriverAvailability
} from '../../../services/sql/common/sqlDrivers.js';
import { SqlColumn, SqlConnection, SqlConnectionKind, SqlTable, SqlTableType } from '../../../services/sql/common/sqlTypes.js';

export const enum SqlConnectionTreeNodeType {
	Empty = 'empty',
	Error = 'error',
	Connection = 'connection',
	Group = 'group',
	Table = 'table',
	View = 'view',
	Column = 'column'
}

export interface SqlConnectionTreeNode {
	id: string;
	type: SqlConnectionTreeNodeType;
	label: string;
	description?: string;
	connectionId?: string;
	schema?: string;
	tableName?: string;
	columnName?: string;
	children?: SqlConnectionTreeNode[];
}

export interface SqlConnectionTreeSnapshot {
	connections: SqlConnection[];
	tablesByConnectionId?: Record<string, SqlTable[]>;
	columnsByTableId?: Record<string, SqlColumn[]>;
	errorsByConnectionId?: Record<string, string>;
}

export function buildSqlConnectionTree(snapshot: SqlConnectionTreeSnapshot): SqlConnectionTreeNode[] {
	const connections = [...snapshot.connections].sort(compareConnections);

	if (connections.length === 0) {
		return [
			{
				id: 'sql.empty',
				type: SqlConnectionTreeNodeType.Empty,
				label: 'No database connections',
				description: 'Add a SQLite connection to start browsing schemas.'
			}
		];
	}

	return connections.map(connection =>
		buildConnectionNode(
			connection,
			snapshot.tablesByConnectionId?.[connection.id] ?? [],
			snapshot.columnsByTableId ?? {},
			snapshot.errorsByConnectionId?.[connection.id]
		)
	);
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

export function getConnectionColumnsKeyPrefix(connectionId: string): string {
	return `${getConnectionNodeId(connectionId)}/`;
}

function buildConnectionNode(
	connection: SqlConnection,
	tables: SqlTable[],
	columnsByTableId: Record<string, SqlColumn[]>,
	error?: string
): SqlConnectionTreeNode {
	const children: SqlConnectionTreeNode[] = [];

	if (error) {
		children.push({
			id: `${getConnectionNodeId(connection.id)}/error`,
			type: SqlConnectionTreeNodeType.Error,
			label: 'Failed to load metadata',
			description: error,
			connectionId: connection.id
		});
	}

	const tableNodes = buildTableNodes(connection.id, tables, SqlTableType.Table, columnsByTableId);
	const viewNodes = buildTableNodes(connection.id, tables, SqlTableType.View, columnsByTableId);

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

	return {
		id: getConnectionNodeId(connection.id),
		type: SqlConnectionTreeNodeType.Connection,
		label: connection.name,
		description: describeSqlConnection(connection),
		connectionId: connection.id,
		children
	};
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

export function getSqlConnectionDriverBadge(kind: SqlConnectionKind): string {
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

	if (options.includePreview !== false && connection.kind === SqlConnectionKind.MySql) {
		const descriptor = getSqlDriverDescriptor(connection.kind);
		if (descriptor.availability === SqlDriverAvailability.Enabled) {
			flags.push('Preview');
		}
	}

	if (connection.kind === SqlConnectionKind.PostgreSql) {
		const descriptor = getSqlDriverDescriptor(connection.kind);
		if (descriptor.availability === SqlDriverAvailability.Planned) {
			flags.push('Planned');
		}
	}

	if (connection.readOnly) {
		flags.push('read-only');
	}

	return flags.join(' · ');
}

function buildTableNodes(
	connectionId: string,
	tables: SqlTable[],
	tableType: SqlTableType,
	columnsByTableId: Record<string, SqlColumn[]>
): SqlConnectionTreeNode[] {
	return tables
		.filter(table => table.tableType === tableType)
		.sort(compareTables)
		.map(table => {
			const tableNodeId = getTableNodeId(connectionId, table);
			const columns = [...(columnsByTableId[tableNodeId] ?? [])].sort(compareColumns);

			return {
				id: tableNodeId,
				type: table.tableType === SqlTableType.View ? SqlConnectionTreeNodeType.View : SqlConnectionTreeNodeType.Table,
				label: table.name,
				description: table.schema,
				connectionId,
				schema: table.schema,
				tableName: table.name,
				children: columns.map(column => ({
					id: getColumnNodeId(connectionId, table, column),
					type: SqlConnectionTreeNodeType.Column,
					label: column.name,
					description: describeColumn(column),
					connectionId,
					schema: table.schema,
					tableName: table.name,
					columnName: column.name
				}))
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
