/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection navigation orchestration.
 *--------------------------------------------------------------------------------------------*/

import { SqlConnectionKind, type SqlSavedConnection } from '../../../services/sql/common/sqlTypes.js';
import {
	SQL_CONNECTIONS_REFRESH_COMMAND_ID,
	SQL_CONNECTORS_OPEN_SAVED_COMMAND_ID,
	type SqlConnectionsRefreshCommandOptions
} from './sqlConnections.js';

export interface SqlConnectionDialogNavigation {
	openNew(kind?: SqlConnectionKind): Promise<void>;
	openSaved(saved: SqlSavedConnection): Promise<void>;
}

export type ExecuteSqlConnectionCommand = (commandId: string, ...args: unknown[]) => Promise<unknown>;

export interface SqlConnectionsRefreshView {
	refresh(): Promise<void>;
	refreshAndRevealConnection(connectionId: string): Promise<void>;
}

export interface SqlConnectionsRefreshViewResolver {
	getExistingView(): SqlConnectionsRefreshView | null;
	openAndFocusView(): Promise<SqlConnectionsRefreshView | null>;
}

export async function runSqlConnectionsRefreshCommand(
	resolver: SqlConnectionsRefreshViewResolver,
	options: SqlConnectionsRefreshCommandOptions = {}
): Promise<void> {
	const view = options.existingViewOnly ? resolver.getExistingView() : await resolver.openAndFocusView();
	if (!view) {
		return;
	}

	if (options.existingViewOnly) {
		await view.refresh();
		return;
	}

	if (typeof options.revealConnectionId === 'string') {
		await view.refreshAndRevealConnection(options.revealConnectionId);
		return;
	}

	await view.refresh();
}

export async function openNewSqlDataSourceForm(
	dialog: SqlConnectionDialogNavigation,
	kind: SqlConnectionKind = SqlConnectionKind.Sqlite
): Promise<void> {
	await dialog.openNew(kind);
}

export async function openSavedSqlDataSourceForm(
	dialog: SqlConnectionDialogNavigation,
	saved: SqlSavedConnection | undefined
): Promise<void> {
	if (!saved) {
		return;
	}

	await dialog.openSaved(saved);
}

export async function refreshDataSourcesAfterConnection(
	executeCommand: ExecuteSqlConnectionCommand,
	connectionId: string
): Promise<void> {
	await executeCommand(SQL_CONNECTIONS_REFRESH_COMMAND_ID, { revealConnectionId: connectionId });
}

export async function requestSavedMysqlDataSourceForm(
	executeCommand: ExecuteSqlConnectionCommand,
	saved: SqlSavedConnection
): Promise<void> {
	await executeCommand(SQL_CONNECTORS_OPEN_SAVED_COMMAND_ID, saved);
}
