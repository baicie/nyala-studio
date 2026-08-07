/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Result pure model helpers.
 *--------------------------------------------------------------------------------------------*/

import { buildSqlResultGrid, getSqlResultGridStatus, SqlResultGrid } from './sqlResultGridModel.js';
import { SqlCellKind, SqlCellValue, SqlQueryResult, SqlResultColumn } from '../../../services/sql/common/sqlTypes.js';
import {
	SqlEditorQueryCancelledEvent,
	SqlEditorQueryCompletedEvent,
	SqlEditorQueryFailedEvent,
	SqlEditorQueryStartedEvent
} from '../../sqlEditor/common/sqlEditorEvents.js';
import { SQL_RESULT_MAX_RENDER_ROWS } from './sqlResult.js';

export const enum SqlResultStateKind {
	Idle = 'idle',
	Running = 'running',
	Success = 'success',
	Error = 'error',
	Cancelled = 'cancelled'
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
	errorCode?: string;
	errorMessage: string;
	errorDetail: string;
}

export interface SqlResultCancelledState {
	kind: SqlResultStateKind.Cancelled;
	query: SqlResultQueryInfo;
	message: string;
}

export type SqlResultState =
	SqlResultIdleState | SqlResultRunningState | SqlResultSuccessState | SqlResultErrorState | SqlResultCancelledState;

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
	const error = normalizeSqlResultError(event.error);
	return {
		kind: SqlResultStateKind.Error,
		query: {
			editorId: event.editorId,
			connectionId: event.connectionId,
			sql: event.sql,
			startedAt: event.startedAt,
			completedAt: event.completedAt
		},
		errorCode: error.code,
		errorMessage: error.message,
		errorDetail: error.detail
	};
}

export function createCancelledSqlResultState(event: SqlEditorQueryCancelledEvent): SqlResultCancelledState {
	return {
		kind: SqlResultStateKind.Cancelled,
		query: {
			editorId: event.editorId,
			connectionId: event.connectionId,
			sql: event.sql,
			startedAt: event.startedAt,
			completedAt: event.completedAt
		},
		message: event.message.trim() || 'Query was cancelled.'
	};
}

export function getSqlResultSummary(state: SqlResultState): string {
	switch (state.kind) {
		case SqlResultStateKind.Idle:
			return 'Run a SQL query to see results.';

		case SqlResultStateKind.Running:
			return `Running query on ${state.query.connectionId}...`;

		case SqlResultStateKind.Error:
			return `Query failed${state.errorCode ? ` [${state.errorCode}]` : ''}: ${state.errorMessage}`;

		case SqlResultStateKind.Cancelled:
			return `Query cancelled: ${state.message}`;

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

/*---------------------------------------------------------------------------------------------
 * Phase 04 - Unified result snapshot history.
 *
 * The runtime state above models the in-flight query (Idle / Running /
 * Success / Error). The snapshot API below records a complete terminal
 * result (success / error / cancelled) so the Result Panel can show the
 * last `SQL_RESULT_MAX_SNAPSHOTS` queries instead of dropping them on
 * the floor. The two APIs coexist on purpose: the runtime state drives
 * the live indicator and the snapshot list drives the history list.
 *--------------------------------------------------------------------------------------------*/

export const SQL_RESULT_MAX_SNAPSHOTS = 20;
export const SQL_RESULT_SQL_PREVIEW_LENGTH = 160;

export const enum SqlResultSnapshotKind {
	Success = 'success',
	Error = 'error',
	Cancelled = 'cancelled'
}

export interface SqlResultSnapshotBase {
	readonly id: string;
	readonly kind: SqlResultSnapshotKind;
	readonly editorId: string;
	readonly connectionId: string;
	readonly sql: string;
	readonly sqlPreview: string;
	readonly startedAt: number;
	readonly createdAt: number;
	readonly title: string;
}

export interface SqlResultSuccessSnapshot extends SqlResultSnapshotBase {
	readonly kind: SqlResultSnapshotKind.Success;
	readonly result: SqlQueryResult;
	readonly grid: SqlResultGrid;
	readonly status: string;
}

export interface SqlResultErrorSnapshot extends SqlResultSnapshotBase {
	readonly kind: SqlResultSnapshotKind.Error;
	readonly errorCode?: string;
	readonly errorMessage: string;
	readonly detail: string;
}

export interface SqlResultCancelledSnapshot extends SqlResultSnapshotBase {
	readonly kind: SqlResultSnapshotKind.Cancelled;
	readonly message: string;
}

export type SqlResultSnapshot = SqlResultSuccessSnapshot | SqlResultErrorSnapshot | SqlResultCancelledSnapshot;

export interface SqlResultPanelState {
	readonly snapshots: readonly SqlResultSnapshot[];
	readonly activeSnapshotId?: string;
}

export function createEmptySqlResultPanelState(): SqlResultPanelState {
	return { snapshots: [] };
}

export function createSuccessResultSnapshot(options: {
	readonly id: string;
	readonly editorId: string;
	readonly connectionId: string;
	readonly sql: string;
	readonly result: SqlQueryResult;
	readonly startedAt?: number;
	readonly createdAt: number;
}): SqlResultSuccessSnapshot {
	const grid = buildSqlResultGrid(options.result);
	return {
		id: options.id,
		kind: SqlResultSnapshotKind.Success,
		editorId: options.editorId,
		connectionId: options.connectionId,
		sql: normalizeSnapshotSql(options.sql),
		sqlPreview: createSqlResultPreview(options.sql),
		startedAt: options.startedAt ?? options.createdAt,
		createdAt: options.createdAt,
		title: options.result.columns.length > 0 ? 'Query Result' : 'Statement Result',
		result: options.result,
		grid,
		status: getSqlResultGridStatus(options.result, grid)
	};
}

export function createErrorResultSnapshot(options: {
	readonly id: string;
	readonly editorId: string;
	readonly connectionId: string;
	readonly sql: string;
	readonly error: unknown;
	readonly startedAt?: number;
	readonly createdAt: number;
}): SqlResultErrorSnapshot {
	const error = normalizeSqlResultError(options.error);
	return {
		id: options.id,
		kind: SqlResultSnapshotKind.Error,
		editorId: options.editorId,
		connectionId: options.connectionId,
		sql: normalizeSnapshotSql(options.sql),
		sqlPreview: createSqlResultPreview(options.sql),
		startedAt: options.startedAt ?? options.createdAt,
		createdAt: options.createdAt,
		title: 'Query Error',
		errorCode: error.code,
		errorMessage: error.message,
		detail: error.detail
	};
}

export function createCancelledResultSnapshot(options: {
	readonly id: string;
	readonly editorId: string;
	readonly connectionId: string;
	readonly sql: string;
	readonly message: string;
	readonly startedAt?: number;
	readonly createdAt: number;
}): SqlResultCancelledSnapshot {
	return {
		id: options.id,
		kind: SqlResultSnapshotKind.Cancelled,
		editorId: options.editorId,
		connectionId: options.connectionId,
		sql: normalizeSnapshotSql(options.sql),
		sqlPreview: createSqlResultPreview(options.sql),
		startedAt: options.startedAt ?? options.createdAt,
		createdAt: options.createdAt,
		title: 'Query Cancelled',
		message: options.message.trim() || 'Query was cancelled.'
	};
}

export function createSuccessResultSnapshotFromEvent(event: SqlEditorQueryCompletedEvent): SqlResultSuccessSnapshot {
	return createSuccessResultSnapshot({
		id: createResultSnapshotId(event.editorId, event.completedAt),
		editorId: event.editorId,
		connectionId: event.connectionId,
		sql: event.sql,
		result: event.result,
		startedAt: event.startedAt,
		createdAt: event.completedAt
	});
}

export function createErrorResultSnapshotFromEvent(event: SqlEditorQueryFailedEvent): SqlResultErrorSnapshot {
	return createErrorResultSnapshot({
		id: createResultSnapshotId(event.editorId, event.completedAt),
		editorId: event.editorId,
		connectionId: event.connectionId,
		sql: event.sql,
		error: event.error,
		startedAt: event.startedAt,
		createdAt: event.completedAt
	});
}

export function createCancelledResultSnapshotFromEvent(
	event: SqlEditorQueryCancelledEvent
): SqlResultCancelledSnapshot {
	return createCancelledResultSnapshot({
		id: createResultSnapshotId(event.editorId, event.completedAt),
		editorId: event.editorId,
		connectionId: event.connectionId,
		sql: event.sql,
		message: event.message,
		startedAt: event.startedAt,
		createdAt: event.completedAt
	});
}

export function addSqlResultSnapshot(
	state: SqlResultPanelState,
	snapshot: SqlResultSnapshot,
	maxSnapshots = SQL_RESULT_MAX_SNAPSHOTS
): SqlResultPanelState {
	if (!Number.isInteger(maxSnapshots) || maxSnapshots <= 0) {
		throw new Error('maxSnapshots must be a positive integer');
	}
	const snapshots = [snapshot, ...state.snapshots.filter(item => item.id !== snapshot.id)].slice(0, maxSnapshots);
	return { snapshots, activeSnapshotId: snapshot.id };
}

export function activateSqlResultSnapshot(state: SqlResultPanelState, snapshotId: string): SqlResultPanelState {
	const id = snapshotId.trim();
	if (!id || state.activeSnapshotId === id || !state.snapshots.some(snapshot => snapshot.id === id)) {
		return state;
	}

	return { ...state, activeSnapshotId: id };
}

export function removeSqlResultSnapshot(state: SqlResultPanelState, snapshotId: string): SqlResultPanelState {
	const id = snapshotId.trim();
	if (!id) {
		return state;
	}
	const snapshots = state.snapshots.filter(snapshot => snapshot.id !== id);
	return {
		snapshots,
		activeSnapshotId: state.activeSnapshotId === id ? snapshots[0]?.id : state.activeSnapshotId
	};
}

export function getActiveSqlResultSnapshot(state: SqlResultPanelState): SqlResultSnapshot | undefined {
	return state.snapshots.find(snapshot => snapshot.id === state.activeSnapshotId) ?? state.snapshots[0];
}

export function getSqlResultPanelContentState(state: SqlResultState, panelState: SqlResultPanelState): SqlResultState {
	if (state.kind === SqlResultStateKind.Running) {
		return state;
	}

	const snapshot = getActiveSqlResultSnapshot(panelState);
	if (!snapshot) {
		return state;
	}

	const query: SqlResultQueryInfo = {
		editorId: snapshot.editorId,
		connectionId: snapshot.connectionId,
		sql: snapshot.sql,
		startedAt: snapshot.startedAt,
		completedAt: snapshot.createdAt
	};

	switch (snapshot.kind) {
		case SqlResultSnapshotKind.Success:
			return { kind: SqlResultStateKind.Success, query, result: snapshot.result };
		case SqlResultSnapshotKind.Error:
			return {
				kind: SqlResultStateKind.Error,
				query,
				errorCode: snapshot.errorCode,
				errorMessage: snapshot.errorMessage,
				errorDetail: snapshot.detail
			};
		case SqlResultSnapshotKind.Cancelled:
			return { kind: SqlResultStateKind.Cancelled, query, message: snapshot.message };
	}
}

export function createSqlResultPreview(sql: string, maxLength = SQL_RESULT_SQL_PREVIEW_LENGTH): string {
	const normalized = normalizeSnapshotSql(sql).replace(/\s+/g, ' ');
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function createResultSnapshotId(editorId: string, createdAt: number): string {
	return `sql-result-${createdAt}-${hashEditorId(editorId)}`;
}

function normalizeSnapshotSql(sql: string): string {
	return typeof sql === 'string' ? sql.trim() : '';
}

function summarizeSnapshotMessage(message: string): string {
	return (
		message
			.split(/\r?\n/)
			.find(line => line.trim())
			?.trim() || 'Query failed.'
	);
}

function normalizeSqlResultError(error: unknown): {
	readonly code?: string;
	readonly message: string;
	readonly detail: string;
} {
	const candidate = toErrorRecord(error);
	const cause = toErrorRecord(candidate?.cause);
	const rawMessage = error instanceof Error ? error.message : (readNonEmptyString(candidate?.message) ?? String(error));
	const normalizedMessage = rawMessage.trim();
	const backendDetail = readNonEmptyString(candidate?.detail) ?? readNonEmptyString(cause?.detail);
	const detailParts = [normalizedMessage, backendDetail].filter(
		(value, index, values): value is string => Boolean(value) && values.indexOf(value) === index
	);
	const detail = detailParts.join('\n') || 'Query failed.';
	const code = readNonEmptyString(candidate?.code) ?? readNonEmptyString(cause?.code);

	return {
		code,
		message: summarizeSnapshotMessage(normalizedMessage || detail),
		detail
	};
}

function toErrorRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const normalized = value.trim();
	return normalized || undefined;
}

function hashEditorId(value: string): string {
	let hash = 0;
	for (let index = 0; index < value.length; index++) {
		hash = (hash * 31 + value.charCodeAt(index)) | 0;
	}
	return Math.abs(hash).toString(36);
}
