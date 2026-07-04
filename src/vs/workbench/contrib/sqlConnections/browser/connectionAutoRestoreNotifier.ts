/*---------------------------------------------------------------------------------------------
 * Nyala Studio - Connection auto-restore notifier (Phase 01).
 *
 * Phase 01 deliberately does NOT implement auto-reconnect. Instead, the
 * notifier surfaces a single toast when the saved connections list is
 * unreadable so the user knows they have to re-open manually.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { ISqlConnectionServiceV2 } from '../../../services/sql/common/sqlConnection.js';

export interface ConnectionRestoreHooks {
	readonly onFailure: (message: string) => void;
}

export class ConnectionAutoRestoreNotifier extends Disposable {
	private attempted = false;
	private readonly connections: ISqlConnectionServiceV2;
	private readonly hooks: ConnectionRestoreHooks;

	constructor(connections: ISqlConnectionServiceV2, hooks: ConnectionRestoreHooks) {
		super();
		this.connections = connections;
		this.hooks = hooks;
	}

	async probeOnce(): Promise<void> {
		if (this.attempted) {
			return;
		}
		this.attempted = true;

		try {
			await this.connections.list();
		} catch {
			this.hooks.onFailure('Saved connections could not be restored. Open one manually.');
		}
	}
}