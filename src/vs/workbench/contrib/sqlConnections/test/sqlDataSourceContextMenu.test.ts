/*---------------------------------------------------------------------------------------------
 * Nyala Studio - Data source context menu browser boundary contract.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const viewSource = readFileSync(new URL('../browser/sqlConnectionsView.ts', import.meta.url), 'utf8');
const styleSource = readFileSync(new URL('../browser/media/sqlConnections.css', import.meta.url), 'utf8');

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

test('navigator renderer applies the inline action policy before creating a toolbar', () => {
	const renderActionsStart = viewSource.indexOf('private renderNodeActions');
	const renderActionsEnd = viewSource.indexOf('private appendActionButton');

	assert.ok(renderActionsStart >= 0, 'missing renderNodeActions implementation');
	assert.ok(renderActionsEnd > renderActionsStart, 'invalid renderNodeActions source boundary');

	const renderActionsSource = viewSource.slice(renderActionsStart, renderActionsEnd);
	assert.match(
		renderActionsSource,
		/private renderNodeActions\([^)]*\): void \{\s*const inlineActions = getSqlConnectionTreeInlineActions\(node\);\s*if \(inlineActions\.length === 0\) \{\s*return;\s*\}\s*const actions = append\(row, \$\('\.sql-connection-node-actions'\)\);/
	);
	assert.doesNotMatch(renderActionsSource, /SqlConnectionTreeNodeType\.(?:Table|View)|isSqlTableLikeNode/);
	assert.equal(viewSource.match(/\.sql-connection-node-actions/g)?.length, 1);
});

test('table and view action toolbars cannot consume label width', () => {
	assert.match(
		styleSource,
		/\.sql-connection-node\.type-table > \.sql-connection-node-actions,\s*\.sql-connection-node\.type-view > \.sql-connection-node-actions \{\s*display: none;\s*\}/
	);
});
