/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Result pure model helpers.
 *--------------------------------------------------------------------------------------------*/

import { SqlCellKind, SqlCellValue, SqlQueryResult, SqlResultColumn } from '../../../services/sql/common/sqlTypes.js';
import {
	SqlEditorQueryCompletedEvent,
	SqlEditorQueryFailedEvent,
	SqlEditorQueryStartedEvent
} from '../../sqlEditor/common/sqlEditorEvents.js';
import { SQL_RESULT_MAX_RENDER_ROWS } from './sqlResult.js';

export const enum SqlResultStateKind {
	Idle = 'idle',
	Running = 'running',
	Success = 'success',
	Error = 'error'
}

export interface SqlResultQueryInfo {
	editorId: string;
	connectionId: string;
	sql: string;
	startedAt: number;
	completedAt?: number;
}

export interface SqlResultIdleState {
	kind: SqlResultStateKind.Idle;
}

export interface SqlResultRunningState {
	kind: SqlResultStateKind.Running;
	query: SqlResultQueryInfo;
}

export interface SqlResultSuccessState {
	kind: SqlResultStateKind.Success;
	query: SqlResultQueryInfo;
	result: SqlQueryResult;
}

export interface SqlResultErrorState {
	kind: SqlResultStateKind.Error;
	query: SqlResultQueryInfo;
	errorMessage: string;
}

export type SqlResultState = SqlResultIdleState | SqlResultRunningState | SqlResultSuccessState | SqlResultErrorState;

export interface SqlResultDisplayGrid {
	columns: string[];
	rows: string[][];
	renderedRowCount: number;
	totalRowCount: number;
	truncatedByBackend: boolean;
	truncatedByPanel: boolean;
}

export function createIdleSqlResultState(): SqlResultIdleState {
	return {
		kind: SqlResultStateKind.Idle
	};
}

export function createRunningSqlResultState(event: SqlEditorQueryStartedEvent): SqlResultRunningState {
	return {
		kind: SqlResultStateKind.Running,
		query: {
			editorId: event.editorId,
			connectionId: event.connectionId,
			sql: event.sql,
			startedAt: event.startedAt
		}
	};
}

export function createSuccessSqlResultState(event: SqlEditorQueryCompletedEvent): SqlResultSuccessState {
	return {
		kind: SqlResultStateKind.Success,
		query: {
			editorId: event.editorId,
			connectionId: event.connectionId,
			sql: event.sql,
			startedAt: event.startedAt,
			completedAt: event.completedAt
		},
		result: event.result
	};
}

export function createErrorSqlResultState(event: SqlEditorQueryFailedEvent): SqlResultErrorState {
	return {
		kind: SqlResultStateKind.Error,
		query: {
			editorId: event.editorId,
			connectionId: event.connectionId,
			sql: event.sql,
			startedAt: event.startedAt,
			completedAt: event.completedAt
		},
		errorMessage: event.error.message
	};
}

export function getSqlResultSummary(state: SqlResultState): string {
	switch (state.kind) {
		case SqlResultStateKind.Idle:
			return 'Run a SQL query to see results.';

		case SqlResultStateKind.Running:
			return `Running query on ${state.query.connectionId}...`;

		case SqlResultStateKind.Error:
			return `Query failed: ${state.errorMessage}`;

		case SqlResultStateKind.Success:
			if (state.result.columns.length === 0) {
				const affectedRows = state.result.affectedRows ?? 0;
				return `Query completed: ${affectedRows} row(s) affected in ${state.result.elapsedMs}ms.`;
			}

			return `Query completed: ${state.result.rowCount} row(s) in ${state.result.elapsedMs}ms${
				state.result.truncated ? ' \xb7 truncated' : ''
			}.`;
	}
}

export function buildSqlResultDisplayGrid(
	result: SqlQueryResult,
	maxRows = SQL_RESULT_MAX_RENDER_ROWS
): SqlResultDisplayGrid {
	const normalizedMaxRows = normalizeMaxRows(maxRows);
	const renderedRows = result.rows.slice(0, normalizedMaxRows);

	return {
		columns: result.columns.map(formatColumnLabel),
		rows: renderedRows.map(row => row.map(formatSqlCellValue)),
		renderedRowCount: renderedRows.length,
		totalRowCount: result.rowCount,
		truncatedByBackend: result.truncated,
		truncatedByPanel: result.rows.length > renderedRows.length
	};
}

export function formatColumnLabel(column: SqlResultColumn): string {
	return column.name || `Column ${column.ordinal + 1}`;
}

export function formatSqlCellValue(cell: SqlCellValue): string {
	if (cell.kind === SqlCellKind.Null || cell.value === null || cell.value === undefined) {
		return 'NULL';
	}

	if (cell.kind === SqlCellKind.Blob) {
		if (typeof cell.value === 'object' && !Array.isArray(cell.value) && 'byteLength' in cell.value) {
			return `[blob ${cell.value.byteLength} bytes]`;
		}

		return '[blob]';
	}

	if (typeof cell.value === 'object') {
		return JSON.stringify(cell.value);
	}

	return String(cell.value);
}

export function sqlResultToCsv(result: SqlQueryResult, maxRows = SQL_RESULT_MAX_RENDER_ROWS): string {
	const grid = buildSqlResultDisplayGrid(result, maxRows);
	const lines = [grid.columns.map(escapeCsvCell).join(','), ...grid.rows.map(row => row.map(escapeCsvCell).join(','))];

	return lines.join('\n');
}

function escapeCsvCell(value: string): string {
	if (!/[",\n\r]/.test(value)) {
		return value;
	}

	return `"${value.replaceAll('"', '""')}"`;
}

function normalizeMaxRows(maxRows: number): number {
	if (!Number.isInteger(maxRows) || maxRows <= 0) {
		throw new Error('maxRows must be a positive integer');
	}

	return maxRows;
}
