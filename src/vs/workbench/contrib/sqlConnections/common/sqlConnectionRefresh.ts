/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection refresh orchestration.
 *--------------------------------------------------------------------------------------------*/

export interface SqlConnectionRefreshOptions {
	readonly throwOnError?: boolean;
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
