/*---------------------------------------------------------------------------------------------
 * Nyala Studio - cancellation boundary for Tauri search requests.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellationError } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';

export function raceTauriSearchRequest<T>(request: Promise<T>, token?: CancellationToken): Promise<T> {
	return token ? raceCancellationError(request, token) : request;
}
