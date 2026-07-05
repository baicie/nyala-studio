/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Welcome pane routing table (Phase 08 §2.6).
 *
 * Pure mapping from a welcome action id to the command id the
 * pane should execute. Lives in its own file (no DOM / no CSS) so
 * unit tests can import it without dragging in `paneviewlet.css`.
 *--------------------------------------------------------------------------------------------*/

import { SQL_CONNECTIONS_FOCUS_COMMAND_ID } from '../../sqlConnections/common/sqlConnections.js';
import { SQL_QUERY_HISTORY_VIEW_ID } from '../../sqlHistory/common/sqlQueryHistory.js';
import { WELCOME_ACTION_IDS } from './sqlProductWelcomeView.js';

/**
 * Maps a welcome action id to the command id the pane should
 * execute. Returning `undefined` means the action id is unknown;
 * the caller silently no-ops in that case so a stale tile cannot
 * break the pane.
 */
export function mapWelcomeActionToCommandId(actionId: string): string | undefined {
	switch (actionId) {
		case WELCOME_ACTION_IDS.openDemo:
			return 'sqlStudio.product.bootstrapDemo';
		case WELCOME_ACTION_IDS.newConnection:
			return SQL_CONNECTIONS_FOCUS_COMMAND_ID;
		case WELCOME_ACTION_IDS.openHistory:
			return `${SQL_QUERY_HISTORY_VIEW_ID}.focus`;
		case WELCOME_ACTION_IDS.docsShortcuts:
			return 'workbench.action.showCommands';
		default:
			return undefined;
	}
}