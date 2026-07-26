/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection submission orchestration.
 *--------------------------------------------------------------------------------------------*/

import {
	SqlConnection,
	SqlConnectionInput,
	SqlSavedConnection,
	SqlSaveConnectionRequest
} from '../../../services/sql/common/sqlTypes.js';

export interface SqlConnectionSubmissionService {
	openConnection(input: SqlConnectionInput): Promise<SqlConnection>;
	closeConnection(connectionId: string): Promise<void>;
	saveConnection(request: SqlSaveConnectionRequest): Promise<SqlSavedConnection>;
}

/**
 * Opens MySQL with its runtime secret, then persists only the public fields
 * under the exact id returned by the open command.
 */
export async function openAndSaveMysqlConnection(
	service: SqlConnectionSubmissionService,
	runtimeInput: SqlConnectionInput,
	persistedInput: SqlConnectionInput
): Promise<SqlConnection> {
	const connection = await service.openConnection(runtimeInput);

	try {
		await service.saveConnection({
			input: { ...persistedInput, id: connection.id },
			autoConnect: false,
			openNow: false
		});
	} catch (error) {
		try {
			await service.closeConnection(connection.id);
		} catch {
			// Preserve the save failure; cleanup is best effort.
		}
		throw error;
	}

	return connection;
}
