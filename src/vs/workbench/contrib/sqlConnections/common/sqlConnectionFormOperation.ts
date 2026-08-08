/*---------------------------------------------------------------------------------------------
 * Nyala Studio - guarded SQL connection form operation.
 *--------------------------------------------------------------------------------------------*/

import { ISqlDriverCatalogService } from '../../../services/sql/common/sqlDriverCatalog.js';
import { requireRunnableSqlConnector } from '../../../services/sql/common/sqlConnectorRuntimeGuard.js';
import { SqlConnectionFormState } from './sqlConnectionFormModel.js';

export interface SqlConnectionFormOperationOptions {
	readonly state: SqlConnectionFormState;
	readonly catalog: ISqlDriverCatalogService;
	readonly loadCatalog: () => Promise<void>;
	readonly operation: (state: SqlConnectionFormState) => Promise<void>;
	readonly onError: (error: unknown) => void;
	readonly clearSecret: () => void;
}

export async function runSqlConnectionFormOperation(options: SqlConnectionFormOperationOptions): Promise<void> {
	try {
		await options.loadCatalog();
		await requireRunnableSqlConnector(options.state.kind, options.catalog);
		await options.operation(options.state);
	} catch (error) {
		options.onError(error);
	} finally {
		options.clearSecret();
	}
}

export function formatSqlConnectionOperationError(error: unknown): string {
	const structured = error as { readonly code?: unknown; readonly message?: unknown } | undefined;
	const message =
		error instanceof Error
			? error.message
			: typeof structured?.message === 'string'
				? structured.message
				: String(error);
	const code = typeof structured?.code === 'string' ? structured.code.trim() : '';

	return code && !message.startsWith(`${code}:`) ? `${code}: ${message}` : message;
}
