import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { SqlCellKind, SqlQueryResult } from '../../../services/sql/common/sqlTypes.js';
import {
	buildSqlResultGrid,
	clampColumnWidth,
	copyAllRows,
	copySelectedCell,
	copySelectedColumn,
	copySelectedRow,
	copySqlResultGrid,
	escapeCsvCell,
	escapeTsvCell,
	formatSqlResultCell,
	getGridCell,
	getSqlResultGridStatus,
	serializeTable,
	SqlResultCopyFormat,
	SqlResultCopyMode
} from '../common/sqlResultGridModel.js';

const resultGridStyles = readFileSync(new URL('../browser/media/sqlResult.css', import.meta.url), 'utf8');
const resultViewSource = readFileSync(new URL('../browser/sqlResultView.ts', import.meta.url), 'utf8');
const advancedActionsSource = readFileSync(
	new URL('../../sqlAdvanced/browser/sqlAdvancedActions.ts', import.meta.url),
	'utf8'
);

const sampleResult: SqlQueryResult = {
	columns: [
		{ name: 'id', ordinal: 0 },
		{ name: 'name', ordinal: 1 },
		{ name: 'note', ordinal: 2 }
	],
	rows: [
		[
			{ kind: SqlCellKind.Integer, value: 1 },
			{ kind: SqlCellKind.Text, value: 'Alice' },
			{ kind: SqlCellKind.Text, value: 'hello, "world"' }
		],
		[
			{ kind: SqlCellKind.Integer, value: 2 },
			{ kind: SqlCellKind.Null, value: null },
			{ kind: SqlCellKind.Blob, value: { encoding: 'base64', data: 'AQID', byteLength: 3 } }
		]
	],
	rowCount: 2,
	elapsedMs: 5,
	truncated: false
};

test('result table keeps sparse numeric columns near their headers', () => {
	const tableRule = resultGridStyles.match(/\.sql-result-table\s*\{(?<declarations>[^}]*)\}/s)?.groups?.declarations;

	assert.ok(tableRule);
	assert.match(tableRule, /width:\s*max-content/);
	assert.doesNotMatch(tableRule, /min-width:\s*100%/);
});

test('result grid owns both scroll axes so sticky headers remain anchored', () => {
	const contentRule = resultGridStyles.match(/\.sql-result-content\s*\{(?<declarations>[^}]*)\}/s)?.groups
		?.declarations;
	const wrapperRule = resultGridStyles.match(/\.sql-result-table-wrapper\s*\{(?<declarations>[^}]*)\}/s)?.groups
		?.declarations;

	assert.ok(contentRule);
	assert.match(contentRule, /display:\s*flex/);
	assert.match(contentRule, /overflow:\s*hidden/);
	assert.ok(wrapperRule);
	assert.match(wrapperRule, /flex:\s*1 1 auto/);
	assert.match(wrapperRule, /overflow:\s*auto/);
});

test('result toolbar keeps every action reachable in a narrow pane without horizontal scrolling', () => {
	const toolbarRule = resultGridStyles.match(/\.sql-result-toolbar\s*\{(?<declarations>[^}]*)\}/s)?.groups
		?.declarations;
	const buttonRule = resultGridStyles.match(/\.sql-result-button\s*\{(?<declarations>[^}]*)\}/s)?.groups?.declarations;

	assert.ok(toolbarRule);
	assert.match(toolbarRule, /flex-wrap:\s*nowrap/);
	assert.doesNotMatch(toolbarRule, /overflow-x:\s*(?:auto|scroll)/);
	assert.ok(buttonRule);
	assert.match(buttonRule, /width:\s*26px/);
});

test('result history renders compact horizontal result tabs', () => {
	const historyListRule = resultGridStyles.match(/\.sql-result-history-list\s*\{(?<declarations>[^}]*)\}/s)?.groups
		?.declarations;
	const historyItemRule = resultGridStyles.match(/\.sql-result-history-item\s*\{(?<declarations>[^}]*)\}/s)?.groups
		?.declarations;

	assert.ok(historyListRule);
	assert.match(historyListRule, /display:\s*flex/);
	assert.match(historyListRule, /overflow-x:\s*auto/);
	assert.ok(historyItemRule);
	assert.match(historyItemRule, /display:\s*flex/);
	assert.match(historyItemRule, /max-width:\s*220px/);
	assert.doesNotMatch(historyItemRule, /grid-template-columns/);
});

test('result history uses roving focus and supports listbox navigation keys', () => {
	const renderPanelStateSource = resultViewSource.match(
		/private renderPanelState\([\s\S]*?(?=\n\tprivate renderRunning)/
	)?.[0];

	assert.ok(renderPanelStateSource);

	const missingBehaviors: string[] = [];
	if (!/tabIndex:\s*isActive\s*\?\s*0\s*:\s*-1/.test(renderPanelStateSource)) {
		missingBehaviors.push('only the active option participates in the tab order');
	}
	if (!/'aria-selected':\s*String\(isActive\)/.test(renderPanelStateSource)) {
		missingBehaviors.push('exactly the active option is exposed as selected');
	}
	for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
		if (!renderPanelStateSource.includes(`'${key}'`) && !renderPanelStateSource.includes(`"${key}"`)) {
			missingBehaviors.push(`handles ${key}`);
		}
	}
	if (!/\.focus\(\)/.test(renderPanelStateSource)) {
		missingBehaviors.push('moves DOM focus to the navigated option');
	}

	assert.deepEqual(missingBehaviors, []);
});

test('result toolbar, tabs, and status expose their interaction semantics', () => {
	assert.match(resultViewSource, /role: 'toolbar', 'aria-label': 'Result actions'/);
	assert.match(resultViewSource, /'aria-orientation': 'horizontal'/);
	assert.match(resultViewSource, /role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true'/);
});

test('result error surface exposes the Fix with Agent command affordance', () => {
	assert.match(resultViewSource, /Fix with Agent/);
	assert.match(resultViewSource, /SQL_AI_FIX_ERROR_COMMAND_ID/);
	assert.match(resultViewSource, /'aria-label': 'Fix with Agent'/);
	assert.match(
		advancedActionsSource,
		/getSqlResultPanelContentState\(resultService\.state,\s*resultService\.panelState\)/
	);
});

test('buildSqlResultGrid keeps column and cell metadata', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.deepEqual(
		grid.columns.map(column => column.name),
		['id', 'name', 'note']
	);

	assert.equal(grid.rows.length, 2);
	assert.equal(grid.renderedRowCount, 2);
	assert.equal(grid.sourceRowCount, 2);
	assert.equal(grid.totalRowCount, 2);

	assert.equal(grid.rows[0].cells[0].text, '1');
	assert.equal(grid.rows[0].cells[0].className, 'kind-number');

	assert.equal(grid.rows[1].cells[1].text, 'NULL');
	assert.equal(grid.rows[1].cells[1].isNull, true);
	assert.equal(grid.rows[1].cells[1].className, 'kind-null');

	assert.equal(grid.rows[1].cells[2].text, '[blob 3 bytes]');
	assert.equal(grid.rows[1].cells[2].isBlob, true);
	assert.equal(grid.rows[1].cells[2].className, 'kind-blob');
});

test('buildSqlResultGrid marks panel truncation', () => {
	const grid = buildSqlResultGrid(sampleResult, 1);

	assert.equal(grid.renderedRowCount, 1);
	assert.equal(grid.sourceRowCount, 2);
	assert.equal(grid.totalRowCount, 2);
	assert.equal(grid.truncatedByPanel, true);
	assert.equal(grid.truncatedByBackend, false);
});

test('buildSqlResultGrid identifies an empty rowset', () => {
	const grid = buildSqlResultGrid({
		...sampleResult,
		rows: [],
		rowCount: 0
	});

	assert.equal(grid.isEmpty, true);
});

test('buildSqlResultGrid rejects invalid maxRows', () => {
	assert.throws(() => buildSqlResultGrid(sampleResult, 0), /maxRows must be a positive integer/);
	assert.throws(() => buildSqlResultGrid(sampleResult, -1), /maxRows must be a positive integer/);
	assert.throws(() => buildSqlResultGrid(sampleResult, 1.5), /maxRows must be a positive integer/);
});

test('formatSqlResultCell formats supported cell kinds', () => {
	assert.equal(formatSqlResultCell({ kind: SqlCellKind.Null, value: null }), 'NULL');
	assert.equal(formatSqlResultCell({ kind: SqlCellKind.Integer, value: 1 }), '1');
	assert.equal(formatSqlResultCell({ kind: SqlCellKind.Real, value: 1.25 }), '1.25');
	assert.equal(formatSqlResultCell({ kind: SqlCellKind.Text, value: 'hello' }), 'hello');
	assert.equal(
		formatSqlResultCell({
			kind: SqlCellKind.Blob,
			value: { encoding: 'base64', data: 'AQID', byteLength: 3 }
		}),
		'[blob 3 bytes]'
	);
});

test('formatSqlResultCell stringifies object fallback', () => {
	assert.equal(
		formatSqlResultCell({
			kind: SqlCellKind.Text,
			value: { nested: true }
		}),
		'{"nested":true}'
	);
});

test('getGridCell returns selected cell', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(getGridCell(grid, { rowIndex: 0, columnIndex: 1 })?.text, 'Alice');
	assert.equal(getGridCell(grid, { rowIndex: 99, columnIndex: 1 }), undefined);
	assert.equal(getGridCell(grid, { rowIndex: 0, columnIndex: 99 }), undefined);
	assert.equal(getGridCell(grid, { rowIndex: -1, columnIndex: 0 }), undefined);
});

test('copySelectedCell copies only selected cell text', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(copySelectedCell(grid, { rowIndex: 0, columnIndex: 1 }), 'Alice');
	assert.equal(copySelectedCell(grid, undefined), '');
	assert.equal(copySelectedCell(grid, { rowIndex: 99, columnIndex: 1 }), '');
});

test('copySelectedRow copies selected row as TSV with header', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(
		copySelectedRow(grid, { rowIndex: 0, columnIndex: 1 }, SqlResultCopyFormat.Tsv, true),
		'id\tname\tnote\n1\tAlice\thello, "world"'
	);
});

test('copySelectedRow copies selected row as CSV without header', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(
		copySelectedRow(grid, { rowIndex: 0, columnIndex: 1 }, SqlResultCopyFormat.Csv, false),
		'1,Alice,"hello, ""world"""'
	);
});

test('copySelectedRow returns empty string without selection', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(copySelectedRow(grid, undefined, SqlResultCopyFormat.Tsv), '');
});

test('copySelectedRow returns empty string for out-of-range row', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(copySelectedRow(grid, { rowIndex: 99, columnIndex: 0 }, SqlResultCopyFormat.Tsv, true), '');
});

test('copySelectedRow returns empty string for negative row', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(copySelectedRow(grid, { rowIndex: -1, columnIndex: 0 }, SqlResultCopyFormat.Tsv, true), '');
});

test('copySelectedColumn copies the selected column as TSV with header', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(
		copySelectedColumn(grid, { rowIndex: 0, columnIndex: 1 }, SqlResultCopyFormat.Tsv, true),
		'name\nAlice\nNULL'
	);
});

test('copySelectedColumn copies the selected column as CSV without header', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(
		copySelectedColumn(grid, { rowIndex: 0, columnIndex: 2 }, SqlResultCopyFormat.Csv, false),
		'"hello, ""world"""\n[blob 3 bytes]'
	);
});

test('copySelectedColumn returns empty string without a valid selection', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(copySelectedColumn(grid, { rowIndex: 0, columnIndex: 99 }, SqlResultCopyFormat.Tsv), '');
});

test('copyAllRows copies all rows as CSV', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(
		copyAllRows(grid, SqlResultCopyFormat.Csv),
		'id,name,note\n1,Alice,"hello, ""world"""\n2,NULL,[blob 3 bytes]'
	);
});

test('copySqlResultGrid supports cell row column and all modes', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(
		copySqlResultGrid(grid, {
			mode: SqlResultCopyMode.Cell,
			format: SqlResultCopyFormat.Tsv,
			selection: { rowIndex: 0, columnIndex: 2 }
		}),
		'hello, "world"'
	);

	assert.equal(
		copySqlResultGrid(grid, {
			mode: SqlResultCopyMode.Row,
			format: SqlResultCopyFormat.Tsv,
			selection: { rowIndex: 0, columnIndex: 0 }
		}),
		'id\tname\tnote\n1\tAlice\thello, "world"'
	);

	assert.equal(
		copySqlResultGrid(grid, {
			mode: SqlResultCopyMode.Column,
			format: SqlResultCopyFormat.Tsv,
			selection: { rowIndex: 0, columnIndex: 0 }
		}),
		'id\n1\n2'
	);

	assert.equal(
		copySqlResultGrid(grid, {
			mode: SqlResultCopyMode.All,
			format: SqlResultCopyFormat.Csv
		}),
		'id,name,note\n1,Alice,"hello, ""world"""\n2,NULL,[blob 3 bytes]'
	);
});

test('serializeTable supports TSV', () => {
	assert.equal(
		serializeTable(
			[
				['a', 'b'],
				['1', 'hello\tworld']
			],
			SqlResultCopyFormat.Tsv
		),
		'a\tb\n1\thello world'
	);
});

test('escapeCsvCell escapes comma quote and newline', () => {
	assert.equal(escapeCsvCell('hello'), 'hello');
	assert.equal(escapeCsvCell('hello, world'), '"hello, world"');
	assert.equal(escapeCsvCell('hello "world"'), '"hello ""world"""');
	assert.equal(escapeCsvCell('hello\nworld'), '"hello\nworld"');
});

test('escapeTsvCell removes tabs and normalizes newlines', () => {
	assert.equal(escapeTsvCell('hello\tworld'), 'hello world');
	assert.equal(escapeTsvCell('hello\r\nworld'), 'hello world');
	assert.equal(escapeTsvCell('hello\rworld'), 'hello world');
	assert.equal(escapeTsvCell('hello\nworld'), 'hello world');
});

test('getSqlResultGridStatus describes select result', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(getSqlResultGridStatus(sampleResult, grid), '2 row(s) · 3 column(s) · 5ms');
});

test('getSqlResultGridStatus describes panel truncation', () => {
	const grid = buildSqlResultGrid(sampleResult, 1);

	assert.equal(getSqlResultGridStatus(sampleResult, grid), '2 row(s) · 3 column(s) · 5ms · showing first 1');
});

test('getSqlResultGridStatus describes backend truncation', () => {
	const result: SqlQueryResult = {
		...sampleResult,
		truncated: true
	};

	const grid = buildSqlResultGrid(result);

	assert.equal(getSqlResultGridStatus(result, grid), '2 row(s) · 3 column(s) · 5ms · backend truncated');
});

test('getSqlResultGridStatus describes affected rows result', () => {
	const result: SqlQueryResult = {
		columns: [],
		rows: [],
		affectedRows: 3,
		rowCount: 0,
		elapsedMs: 8,
		truncated: false
	};

	const grid = buildSqlResultGrid(result);

	assert.equal(getSqlResultGridStatus(result, grid), '3 row(s) affected · 8ms');
});

test('clampColumnWidth clamps invalid and out-of-range width', () => {
	assert.equal(clampColumnWidth(Number.NaN), 160);
	assert.equal(clampColumnWidth(10), 80);
	assert.equal(clampColumnWidth(999), 480);
	assert.equal(clampColumnWidth(200), 200);
});
