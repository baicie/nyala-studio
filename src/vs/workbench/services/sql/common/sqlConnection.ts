/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL connection service contract.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	SqlConnection,
	SqlConnectionInput,
	SqlConnectionTestResult,
	SqlRemoveSavedConnectionRequest,
	SqlRestoreSavedConnectionsResult,
	SqlSaveConnectionRequest,
	SqlSavedConnection
} from './sqlTypes.js';

export const ISqlConnectionService = createDecorator<ISqlConnectionService>('sqlConnectionService');

export interface ISqlConnectionService {
	readonly _serviceBrand: undefined;

	testConnection(input: SqlConnectionInput): Promise<SqlConnectionTestResult>;

	openConnection(input: SqlConnectionInput): Promise<SqlConnection>;

	closeConnection(connectionId: string): Promise<void>;

	listConnections(): Promise<SqlConnection[]>;

	saveConnection(request: SqlSaveConnectionRequest): Promise<SqlSavedConnection>;

	listSavedConnections(): Promise<SqlSavedConnection[]>;

	removeSavedConnection(request: SqlRemoveSavedConnectionRequest): Promise<void>;

	restoreSavedConnections(): Promise<SqlRestoreSavedConnectionsResult>;
}
