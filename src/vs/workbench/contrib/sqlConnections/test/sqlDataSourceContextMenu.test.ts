/*---------------------------------------------------------------------------------------------
 * Nyala Studio - Data source context menu browser boundary contract.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const viewSource = readFileSync(new URL('../browser/sqlConnectionsView.ts', import.meta.url), 'utf8');

test('data source cards and navigator rows expose mouse and keyboard context menus', () => {
	assert.match(viewSource, /addDisposableListener\(card, EventType\.CONTEXT_MENU/);
	assert.match(viewSource, /addDisposableListener\(row, EventType\.CONTEXT_MENU/);
	assert.match(viewSource, /event\.key === 'ContextMenu'/);
	assert.match(viewSource, /event\.shiftKey && event\.key === 'F10'/);
	assert.match(viewSource, /event\.preventDefault\(\)/);
	assert.match(viewSource, /event\.stopPropagation\(\)/);
});

test('navigator context menu retains query copy and refresh actions for tables', () => {
	for (const label of [
		'Generate SELECT query',
		'Generate COUNT query',
		'Generate INSERT template',
		'Generate UPDATE template',
		'Copy table name',
		'Copy qualified name',
		'Refresh columns'
	]) {
		assert.ok(viewSource.includes(`'${label}'`), `missing context menu action: ${label}`);
	}
});
