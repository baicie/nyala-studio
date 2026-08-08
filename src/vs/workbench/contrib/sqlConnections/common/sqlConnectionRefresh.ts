/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection refresh orchestration.
 *--------------------------------------------------------------------------------------------*/

import type { SqlRestoreSavedConnectionError } from '../../../services/sql/common/sqlTypes.js';

export interface SqlConnectionRefreshOptions {
	readonly throwOnError?: boolean;
}

export function indexSqlRestoreSavedConnectionErrors(
	errors: readonly SqlRestoreSavedConnectionError[]
): Record<string, string> {
	const indexed: Record<string, string> = Object.create(null);

	for (const error of errors) {
		if (error.connectionId && error.error) {
			indexed[error.connectionId] = error.error;
		}
	}

	return indexed;
}

export async function restoreSavedConnectionsForRefresh(
	alreadyRestored: boolean,
	restoreSavedConnections: () => Promise<void>,
	reportError: (error: unknown) => void,
	options: SqlConnectionRefreshOptions = {}
): Promise<boolean> {
	if (alreadyRestored) {
		return true;
	}

	try {
		await restoreSavedConnections();
		return true;
	} catch (error) {
		if (options.throwOnError) {
			throw error;
		}

		reportError(error);
		return false;
	}
}

export async function refreshAndRequireSqlConnection(
	connectionId: string,
	refresh: (options: SqlConnectionRefreshOptions) => Promise<void>,
	hasConnection: (connectionId: string) => boolean
): Promise<void> {
	await refresh({ throwOnError: true });

	if (!hasConnection(connectionId)) {
		throw new Error(`Connection ${connectionId} was not returned after refresh.`);
	}
}
