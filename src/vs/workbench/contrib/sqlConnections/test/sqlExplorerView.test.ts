/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SqlExplorerView tests.
 *
 * The view's DOM rendering is exercised manually; here we cover only
 * the contribution registration constants so a stray rename is caught
 * by CI. The view class itself is not imported because its module
 * pulls in `.css` side effects that the test runner cannot resolve.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	SQL_EXPLORER_FOCUS_COMMAND_ID,
	SQL_EXPLORER_STORAGE_ID,
	SQL_EXPLORER_VIEW_ID,
	SQL_EXPLORER_VIEWLET_ID
} from '../common/sqlExplorer.contribution.js';

test('SQL_EXPLORER_* identifiers are stable', () => {
	assert.equal(SQL_EXPLORER_VIEW_ID, 'sqlStudio.connectionsExplorer');
	assert.equal(SQL_EXPLORER_VIEWLET_ID, 'workbench.view.sqlExplorer');
	assert.equal(SQL_EXPLORER_STORAGE_ID, 'workbench.sqlExplorer.views.state');
	assert.equal(SQL_EXPLORER_FOCUS_COMMAND_ID, SQL_EXPLORER_VIEWLET_ID);
});

test('SQL_EXPLORER ids follow the sqlStudio/workbench.view/workspace convention', () => {
	assert.ok(SQL_EXPLORER_VIEW_ID.startsWith('sqlStudio.'));
	assert.ok(SQL_EXPLORER_VIEWLET_ID.startsWith('workbench.view.'));
	assert.ok(SQL_EXPLORER_STORAGE_ID.startsWith('workbench.'));
});