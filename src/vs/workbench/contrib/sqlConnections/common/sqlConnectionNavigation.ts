/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection navigation orchestration.
 *--------------------------------------------------------------------------------------------*/

import { SqlConnectionKind, type SqlSavedConnection } from '../../../services/sql/common/sqlTypes.js';
import { SQL_CONNECTIONS_REFRESH_COMMAND_ID, SQL_CONNECTORS_OPEN_SAVED_COMMAND_ID } from './sqlConnections.js';

export interface SqlConnectionDialogNavigation {
	openNew(kind?: SqlConnectionKind): Promise<void>;
	openSaved(saved: SqlSavedConnection): Promise<void>;
}

export type ExecuteSqlConnectionCommand = (commandId: string, ...args: unknown[]) => Promise<unknown>;

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
