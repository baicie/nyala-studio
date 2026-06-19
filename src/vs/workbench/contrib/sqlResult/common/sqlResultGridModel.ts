/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Result Grid Model.
 *--------------------------------------------------------------------------------------------*/

import {
	SqlCellKind,
	SqlCellValue,
	SqlQueryResult,
	SqlResultColumn
} from '../../../services/sql/common/sqlTypes.js';
import { SQL_RESULT_MAX_RENDER_ROWS } from './sqlResult.js';

export const SQL_RESULT_DEFAULT_COLUMN_WIDTH = 160;
export const SQL_RESULT_MIN_COLUMN_WIDTH = 80;
export const SQL_RESULT_MAX_COLUMN_WIDTH = 480;

export interface SqlResultGridColumn {
	readonly id: string;
	readonly name: string;
	readonly ordinal: number;
	readonly width: number;
}

export interface SqlResultGridCell {
	readonly rowIndex: number;
	readonly columnIndex: number;
	readonly kind: SqlCellKind;
	readonly value: SqlCellValue['value'];
	readonly text: string;
	readonly className: string;
	readonly isNull: boolean;
	readonly isBlob: boolean;
}

export interface SqlResultGridRow {
	readonly index: number;
	readonly cells: SqlResultGridCell[];
}

export interface SqlResultGrid {
	readonly columns: SqlResultGridColumn[];
	readonly rows: SqlResultGridRow[];
	readonly renderedRowCount: number;
	readonly sourceRowCount: number;
	readonly totalRowCount: number;
	readonly truncatedByBackend: boolean;
	readonly truncatedByPanel: boolean;
}

export interface SqlResultCellAddress {
	readonly rowIndex: number;
	readonly columnIndex: number;
}

export const enum SqlResultCopyMode {
	Cell = 'cell',
	Row = 'row',
	All = 'all'
}

export const enum SqlResultCopyFormat {
	Csv = 'csv',
	Tsv = 'tsv'
}

export interface SqlResultCopyOptions {
	readonly mode: SqlResultCopyMode;
	readonly format: SqlResultCopyFormat;
	readonly selection?: SqlResultCellAddress;
	readonly includeHeader?: boolean;
}

export function buildSqlResultGrid(
	result: SqlQueryResult,
	maxRows = SQL_RESULT_MAX_RENDER_ROWS
): SqlResultGrid {
	const normalizedMaxRows = normalizeMaxRows(maxRows);
	const renderedRows = result.rows.slice(0, normalizedMaxRows);

	return {
		columns: result.columns.map(createGridColumn),
		rows: renderedRows.map((row, rowIndex) => ({
			index: rowIndex,
			cells: row.map((cell, columnIndex) => createGridCell(cell, rowIndex, columnIndex))
		})),
		renderedRowCount: renderedRows.length,
		sourceRowCount: result.rows.length,
		totalRowCount: result.rowCount,
		truncatedByBackend: result.truncated,
		truncatedByPanel: result.rows.length > renderedRows.length
	};
}

export function createGridColumn(column: SqlResultColumn): SqlResultGridColumn {
	const name = column.name || `Column ${column.ordinal + 1}`;

	return {
		id: `column-${column.ordinal}`,
		name,
		ordinal: column.ordinal,
		width: clampColumnWidth(estimateColumnWidth(name))
	};
}

export function createGridCell(
	cell: SqlCellValue,
	rowIndex: number,
	columnIndex: number
): SqlResultGridCell {
	const text = formatSqlResultCell(cell);
	const isNull = cell.kind === SqlCellKind.Null || cell.value === null || cell.value === undefined;
	const isBlob = cell.kind === SqlCellKind.Blob;

	return {
		rowIndex,
		columnIndex,
		kind: cell.kind,
		value: cell.value,
		text,
		className: getCellClassName(cell),
		isNull,
		isBlob
	};
}

export function formatSqlResultCell(cell: SqlCellValue): string {
	if (cell.kind === SqlCellKind.Null || cell.value === null || cell.value === undefined) {
		return 'NULL';
	}

	if (cell.kind === SqlCellKind.Blob) {
		if (isBlobJsonValue(cell.value)) {
			return `[blob ${cell.value.byteLength} bytes]`;
		}

		return '[blob]';
	}

	if (typeof cell.value === 'object') {
		return JSON.stringify(cell.value);
	}

	return String(cell.value);
}

export function getCellClassName(cell: SqlCellValue): string {
	switch (cell.kind) {
		case SqlCellKind.Null:
			return 'kind-null';

		case SqlCellKind.Integer:
		case SqlCellKind.Real:
			return 'kind-number';

		case SqlCellKind.Blob:
			return 'kind-blob';

		case SqlCellKind.Text:
		default:
			return 'kind-text';
	}
}

export function copySqlResultGrid(grid: SqlResultGrid, options: SqlResultCopyOptions): string {
	const includeHeader = options.includeHeader !== false;

	switch (options.mode) {
		case SqlResultCopyMode.Cell:
			return copySelectedCell(grid, options.selection);

		case SqlResultCopyMode.Row:
			return copySelectedRow(grid, options.selection, options.format, includeHeader);

		case SqlResultCopyMode.All:
			return copyAllRows(grid, options.format, includeHeader);

		default:
			return assertNever(options.mode);
	}
}

export function copySelectedCell(
	grid: SqlResultGrid,
	selection: SqlResultCellAddress | undefined
): string {
	if (!selection) {
		return '';
	}

	return getGridCell(grid, selection)?.text ?? '';
}

export function copySelectedRow(
	grid: SqlResultGrid,
	selection: SqlResultCellAddress | undefined,
	format: SqlResultCopyFormat,
	includeHeader = true
): string {
	if (!selection || !isValidCellAddress(selection)) {
		return '';
	}

	return serializeRows(grid, [selection.rowIndex], format, includeHeader);
}

export function copyAllRows(
	grid: SqlResultGrid,
	format: SqlResultCopyFormat,
	includeHeader = true
): string {
	return serializeRows(
		grid,
		grid.rows.map(row => row.index),
		format,
		includeHeader
	);
}

export function getGridCell(
	grid: SqlResultGrid,
	address: SqlResultCellAddress
): SqlResultGridCell | undefined {
	if (!isValidCellAddress(address)) {
		return undefined;
	}

	const row = grid.rows[address.rowIndex];

	if (!row) {
		return undefined;
	}

	return row.cells[address.columnIndex];
}

export function getSqlResultGridStatus(result: SqlQueryResult, grid: SqlResultGrid): string {
	if (result.columns.length === 0) {
		return `${result.affectedRows ?? 0} row(s) affected · ${result.elapsedMs}ms`;
	}

	const parts = [
		`${grid.totalRowCount} row(s)`,
		`${grid.columns.length} column(s)`,
		`${result.elapsedMs}ms`
	];

	if (grid.truncatedByPanel) {
		parts.push(`showing first ${grid.renderedRowCount}`);
	}

	if (grid.truncatedByBackend) {
		parts.push('backend truncated');
	}

	return parts.join(' · ');
}

export function serializeRows(
	grid: SqlResultGrid,
	rowIndexes: readonly number[],
	format: SqlResultCopyFormat,
	includeHeader = true
): string {
	const rows: string[][] = [];

	if (includeHeader) {
		rows.push(grid.columns.map(column => column.name));
	}

	for (const rowIndex of rowIndexes) {
		const row = grid.rows[rowIndex];

		if (!row) {
			continue;
		}

		rows.push(row.cells.map(cell => cell.text));
	}

	return serializeTable(rows, format);
}

export function serializeTable(
	rows: readonly (readonly string[])[],
	format: SqlResultCopyFormat
): string {
	switch (format) {
		case SqlResultCopyFormat.Csv:
			return rows.map(row => row.map(escapeCsvCell).join(',')).join('\n');

		case SqlResultCopyFormat.Tsv:
			return rows.map(row => row.map(escapeTsvCell).join('\t')).join('\n');

		default:
			return assertNever(format);
	}
}

export function escapeCsvCell(value: string): string {
	if (!/[",\n\r]/.test(value)) {
		return value;
	}

	return `"${value.replaceAll('"', '""')}"`;
}

export function escapeTsvCell(value: string): string {
	return value
		.replaceAll('\t', ' ')
		.replaceAll('\r\n', '\n')
		.replaceAll('\r', '\n')
		.replaceAll('\n', ' ');
}

export function clampColumnWidth(width: number): number {
	if (!Number.isFinite(width)) {
		return SQL_RESULT_DEFAULT_COLUMN_WIDTH;
	}

	return Math.min(SQL_RESULT_MAX_COLUMN_WIDTH, Math.max(SQL_RESULT_MIN_COLUMN_WIDTH, Math.round(width)));
}

export function estimateColumnWidth(columnName: string): number {
	return SQL_RESULT_DEFAULT_COLUMN_WIDTH + Math.max(0, columnName.length - 12) * 8;
}

function isValidCellAddress(address: SqlResultCellAddress): boolean {
	return Number.isInteger(address.rowIndex)
		&& Number.isInteger(address.columnIndex)
		&& address.rowIndex >= 0
		&& address.columnIndex >= 0;
}

function normalizeMaxRows(maxRows: number): number {
	if (!Number.isInteger(maxRows) || maxRows <= 0) {
		throw new Error('maxRows must be a positive integer');
	}

	return maxRows;
}

function isBlobJsonValue(value: SqlCellValue['value']): value is { encoding: 'base64'; data: string; byteLength: number } {
	return typeof value === 'object' && value !== null && !Array.isArray(value) && 'byteLength' in value;
}

function assertNever(value: never): never {
	throw new Error(`Unexpected SQL result grid value: ${String(value)}`);
}
