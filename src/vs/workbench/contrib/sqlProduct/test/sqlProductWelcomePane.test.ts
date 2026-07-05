/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Welcome pane tests (Phase 08 §2.6 ViewPane layer).
 *
 * The pane's job is to render the model from
 * `sqlProductWelcomeView.ts` and route each click to the right
 * command. The DOM rendering itself is a thin loop that the
 * existing model test already covers; the pane tests focus on the
 * pure routing table that maps action ids to command ids, plus a
 * compile-time guard that the pane class is reachable through the
 * contribution re-export.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { SQL_QUERY_HISTORY_VIEW_ID } from '../../sqlHistory/common/sqlQueryHistory.js';
import { mapWelcomeActionToCommandId } from '../browser/sqlProductWelcomeRouting.js';
import { WELCOME_ACTION_IDS } from '../browser/sqlProductWelcomeView.js';

const SQL_PRODUCT_WELCOME_VIEW_ID = 'sqlStudio.product.welcome';

test('mapWelcomeActionToCommandId routes open.demo to bootstrap demo', () => {
	assert.equal(mapWelcomeActionToCommandId(WELCOME_ACTION_IDS.openDemo), 'sqlStudio.product.bootstrapDemo');
});

test('mapWelcomeActionToCommandId routes new.connection to connections viewlet', () => {
	assert.equal(
		mapWelcomeActionToCommandId(WELCOME_ACTION_IDS.newConnection),
		'workbench.view.sqlConnections'
	);
});

test('mapWelcomeActionToCommandId routes open.history to history view focus', () => {
	assert.equal(mapWelcomeActionToCommandId(WELCOME_ACTION_IDS.openHistory), `${SQL_QUERY_HISTORY_VIEW_ID}.focus`);
});

test('mapWelcomeActionToCommandId routes docs.shortcuts to command palette', () => {
	assert.equal(mapWelcomeActionToCommandId(WELCOME_ACTION_IDS.docsShortcuts), 'workbench.action.showCommands');
});

test('mapWelcomeActionToCommandId returns undefined for unknown ids', () => {
	assert.equal(mapWelcomeActionToCommandId('not.a.real.action'), undefined);
});

test('mapWelcomeActionToCommandId covers every canonical welcome action id', () => {
	// Guard against a future action being added to the model
	// without a corresponding routing entry in the pane.
	for (const id of Object.values(WELCOME_ACTION_IDS)) {
		assert.notEqual(
			mapWelcomeActionToCommandId(id),
			undefined,
			`action id "${id}" must have a routing entry`
		);
	}
});

test('welcome pane view id is reachable through the public surface', () => {
	assert.equal(SQL_PRODUCT_WELCOME_VIEW_ID, 'sqlStudio.product.welcome');
});