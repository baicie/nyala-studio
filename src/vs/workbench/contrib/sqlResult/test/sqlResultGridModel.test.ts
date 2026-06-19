import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlCellKind, SqlQueryResult } from '../../../services/sql/common/sqlTypes.js';
import {
	buildSqlResultGrid,
	clampColumnWidth,
	copyAllRows,
	copySelectedCell,
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
		copySelectedRow(
			grid,
			{ rowIndex: 0, columnIndex: 1 },
			SqlResultCopyFormat.Tsv,
			true
		),
		'id\tname\tnote\n1\tAlice\thello, "world"'
	);
});

test('copySelectedRow copies selected row as CSV without header', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(
		copySelectedRow(
			grid,
			{ rowIndex: 0, columnIndex: 1 },
			SqlResultCopyFormat.Csv,
			false
		),
		'1,Alice,"hello, ""world"""'
	);
});

test('copySelectedRow returns empty string without selection', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(copySelectedRow(grid, undefined, SqlResultCopyFormat.Tsv), '');
});

test('copyAllRows copies all rows as CSV', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(
		copyAllRows(grid, SqlResultCopyFormat.Csv),
		'id,name,note\n1,Alice,"hello, ""world"""\n2,NULL,[blob 3 bytes]'
	);
});

test('copySqlResultGrid supports cell row and all modes', () => {
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
});

test('getSqlResultGridStatus describes select result', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(getSqlResultGridStatus(sampleResult, grid), '2 row(s) · 3 column(s) · 5ms');
});

test('getSqlResultGridStatus describes panel truncation', () => {
	const grid = buildSqlResultGrid(sampleResult, 1);

	assert.equal(
		getSqlResultGridStatus(sampleResult, grid),
		'2 row(s) · 3 column(s) · 5ms · showing first 1'
	);
});

test('getSqlResultGridStatus describes backend truncation', () => {
	const result: SqlQueryResult = {
		...sampleResult,
		truncated: true
	};

	const grid = buildSqlResultGrid(result);

	assert.equal(
		getSqlResultGridStatus(result, grid),
		'2 row(s) · 3 column(s) · 5ms · backend truncated'
	);
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
