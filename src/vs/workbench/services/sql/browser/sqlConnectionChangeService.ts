/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection cache invalidation service.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISqlConnectionChangeService } from '../common/sqlConnection.js';

export class SqlConnectionChangeService extends Disposable implements ISqlConnectionChangeService {
	declare readonly _serviceBrand: undefined;

	private readonly onDidChangeConnectionsEmitter = this._register(new Emitter<void>());
	readonly onDidChangeConnections: Event<void> = this.onDidChangeConnectionsEmitter.event;

	notifyConnectionsChanged(): void {
		this.onDidChangeConnectionsEmitter.fire();
	}
}
