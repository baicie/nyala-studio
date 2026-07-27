/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection navigation orchestration.
 *--------------------------------------------------------------------------------------------*/

import type { SqlSavedConnection } from '../../../services/sql/common/sqlTypes.js';
import {
	SQL_CONNECTIONS_REFRESH_COMMAND_ID,
	SQL_CONNECTORS_OPEN_SAVED_COMMAND_ID,
	SQL_CONNECTORS_VIEW_ID
} from './sqlConnections.js';

export interface SqlConnectionFormView {
	openConnectionForm(): void;
	openSavedConnectionForm(saved: SqlSavedConnection): void;
}

export type OpenSqlConnectionView = (viewId: string, focus: boolean) => Promise<SqlConnectionFormView | null>;

export type ExecuteSqlConnectionCommand = (commandId: string, ...args: unknown[]) => Promise<unknown>;

export async function openNewSqlDataSourceForm(openView: OpenSqlConnectionView): Promise<void> {
	const view = await openView(SQL_CONNECTORS_VIEW_ID, true);
	view?.openConnectionForm();
}

export async function openSavedSqlDataSourceForm(
	openView: OpenSqlConnectionView,
	saved: SqlSavedConnection | undefined
): Promise<void> {
	if (!saved) {
		return;
	}

	const view = await openView(SQL_CONNECTORS_VIEW_ID, true);
	view?.openSavedConnectionForm(saved);
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
