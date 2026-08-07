/*---------------------------------------------------------------------------------------------
 * Nyala Studio - Data Sources management presentation model.
 *--------------------------------------------------------------------------------------------*/

import {
	SqlConnection,
	SqlConnectionKind,
	SqlRemoveSavedConnectionRequest,
	SqlSavedConnection
} from '../../../services/sql/common/sqlTypes.js';

export const enum SqlDataSourceManagementState {
	Saved = 'saved',
	Connected = 'connected'
}

export const enum SqlDataSourceManagementAction {
	Connect = 'connect',
	Reveal = 'reveal',
	OpenQuery = 'openQuery',
	Refresh = 'refresh',
	Edit = 'edit',
	Test = 'test',
	Disconnect = 'disconnect',
	Delete = 'delete'
}

export interface SqlDataSourceManagementItem {
	readonly id: string;
	readonly name: string;
	readonly kind: SqlConnectionKind;
	readonly driverLabel: string;
	readonly target: string;
	readonly state: SqlDataSourceManagementState;
	readonly isSaved: boolean;
	readonly saved?: SqlSavedConnection;
	readonly connection?: SqlConnection;
}

export function buildSqlDataSourceManagementItems(
	savedConnections: readonly SqlSavedConnection[],
	connections: readonly SqlConnection[]
): SqlDataSourceManagementItem[] {
	const connectionById = new Map(connections.map(connection => [connection.id, connection]));
	const items: SqlDataSourceManagementItem[] = [];
	const includedIds = new Set<string>();

	for (const saved of savedConnections) {
		if (includedIds.has(saved.id)) {
			continue;
		}

		const connection = connectionById.get(saved.id);
		items.push(createManagementItem(saved, connection));
		includedIds.add(saved.id);
	}

	for (const connection of connections) {
		if (includedIds.has(connection.id)) {
			continue;
		}

		items.push(createManagementItem(undefined, connection));
		includedIds.add(connection.id);
	}

	return items;
}

export function matchesSqlDataSourceManagementItem(item: SqlDataSourceManagementItem, query: string): boolean {
	const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);

	if (terms.length === 0) {
		return true;
	}

	const searchableText = [item.name, item.driverLabel, item.target, item.state].join(' ').toLocaleLowerCase();
	return terms.every(term => searchableText.includes(term));
}

export function getSqlDataSourceManagementActions(
	item: SqlDataSourceManagementItem
): readonly SqlDataSourceManagementAction[] {
	if (item.state === SqlDataSourceManagementState.Connected) {
		return item.isSaved
			? [
					SqlDataSourceManagementAction.Reveal,
					SqlDataSourceManagementAction.OpenQuery,
					SqlDataSourceManagementAction.Refresh,
					SqlDataSourceManagementAction.Edit,
					SqlDataSourceManagementAction.Disconnect,
					SqlDataSourceManagementAction.Delete
				]
			: [
					SqlDataSourceManagementAction.Reveal,
					SqlDataSourceManagementAction.OpenQuery,
					SqlDataSourceManagementAction.Refresh,
					SqlDataSourceManagementAction.Disconnect
				];
	}

	if (!item.isSaved) {
		return [];
	}

	return [
		SqlDataSourceManagementAction.Connect,
		SqlDataSourceManagementAction.Edit,
		SqlDataSourceManagementAction.Test,
		SqlDataSourceManagementAction.Delete
	];
}

export function createSqlDataSourceRemovalRequest(
	item: SqlDataSourceManagementItem
): SqlRemoveSavedConnectionRequest | undefined {
	if (!item.isSaved) {
		return undefined;
	}

	return {
		connectionId: item.id,
		closeIfOpen: item.state === SqlDataSourceManagementState.Connected
	};
}

function createManagementItem(
	saved: SqlSavedConnection | undefined,
	connection: SqlConnection | undefined
): SqlDataSourceManagementItem {
	const source = saved ?? connection;
	if (!source) {
		throw new Error('A data source management item requires a saved profile or an open connection.');
	}

	return {
		id: source.id,
		name: source.name,
		kind: source.kind,
		driverLabel: getDriverLabel(source.kind),
		target: getSafeTarget(saved ?? connection),
		state: connection ? SqlDataSourceManagementState.Connected : SqlDataSourceManagementState.Saved,
		isSaved: Boolean(saved),
		saved,
		connection
	};
}

function getDriverLabel(kind: SqlConnectionKind): string {
	switch (kind) {
		case SqlConnectionKind.Sqlite:
			return 'SQLite';
		case SqlConnectionKind.MySql:
			return 'MySQL';
		case SqlConnectionKind.PostgreSql:
			return 'PostgreSQL';
	}
}

function getSafeTarget(source: SqlSavedConnection | SqlConnection | undefined): string {
	if (!source) {
		return '';
	}

	if (source.kind === SqlConnectionKind.Sqlite) {
		return source.databasePath ?? ':memory:';
	}

	const host = source.host ?? '';
	const address = source.port ? `${host}:${source.port}` : host;
	return source.database ? `${address}/${source.database}` : address;
}
