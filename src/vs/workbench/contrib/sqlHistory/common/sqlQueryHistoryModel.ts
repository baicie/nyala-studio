/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Query History model.
 *--------------------------------------------------------------------------------------------*/

import {
	SqlEditorQueryCompletedEvent,
	SqlEditorQueryFailedEvent
} from '../../sqlEditor/common/sqlEditorEvents.js';
import {
	SQL_QUERY_HISTORY_MAX_ENTRIES,
	SQL_QUERY_HISTORY_SQL_PREVIEW_LENGTH
} from './sqlQueryHistory.js';

export const enum SqlQueryHistoryStatus {
	Success = 'success',
	Error = 'error'
}

export interface SqlQueryHistoryEntry {
	readonly id: string;
	readonly editorId: string;
	readonly connectionId: string;
	readonly sql: string;
	readonly sqlPreview: string;
	readonly status: SqlQueryHistoryStatus;
	readonly startedAt: number;
	readonly completedAt: number;
	readonly durationMs: number;
	readonly rowCount?: number;
	readonly affectedRows?: number;
	readonly elapsedMs?: number;
	readonly errorMessage?: string;
}

export interface SerializedSqlQueryHistoryDocument {
	readonly version: 1;
	readonly entries: SqlQueryHistoryEntry[];
}

export function createCompletedQueryHistoryEntry(event: SqlEditorQueryCompletedEvent): SqlQueryHistoryEntry {
	const sql = normalizeSql(event.sql);
	const completedAt = normalizeTimestamp(event.completedAt);
	const startedAt = normalizeTimestamp(event.startedAt);

	return {
		id: createHistoryEntryId(event.editorId, event.connectionId, completedAt, sql),
		editorId: event.editorId,
		connectionId: event.connectionId,
		sql,
		sqlPreview: createSqlPreview(sql),
		status: SqlQueryHistoryStatus.Success,
		startedAt,
		completedAt,
		durationMs: Math.max(0, completedAt - startedAt),
		rowCount: event.result.rowCount,
		affectedRows: event.result.affectedRows,
		elapsedMs: event.result.elapsedMs
	};
}

export function createFailedQueryHistoryEntry(event: SqlEditorQueryFailedEvent): SqlQueryHistoryEntry {
	const sql = normalizeSql(event.sql);
	const completedAt = normalizeTimestamp(event.completedAt);
	const startedAt = normalizeTimestamp(event.startedAt);

	return {
		id: createHistoryEntryId(event.editorId, event.connectionId, completedAt, sql),
		editorId: event.editorId,
		connectionId: event.connectionId,
		sql,
		sqlPreview: createSqlPreview(sql),
		status: SqlQueryHistoryStatus.Error,
		startedAt,
		completedAt,
		durationMs: Math.max(0, completedAt - startedAt),
		errorMessage: event.error.message || String(event.error)
	};
}

export function normalizeHistoryEntries(
	entries: readonly SqlQueryHistoryEntry[],
	maxEntries = SQL_QUERY_HISTORY_MAX_ENTRIES
): SqlQueryHistoryEntry[] {
	if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
		throw new Error('maxEntries must be a positive integer');
	}

	const seen = new Set<string>();
	const normalized: SqlQueryHistoryEntry[] = [];

	for (const entry of entries) {
		const valid = normalizeHistoryEntry(entry);

		if (!valid) {
			continue;
		}

		if (seen.has(valid.id)) {
			continue;
		}

		seen.add(valid.id);
		normalized.push(valid);

		if (normalized.length >= maxEntries) {
			break;
		}
	}

	return normalized;
}

export function serializeHistory(entries: readonly SqlQueryHistoryEntry[]): SerializedSqlQueryHistoryDocument {
	return {
		version: 1,
		entries: normalizeHistoryEntries(entries)
	};
}

export function deserializeHistory(raw: unknown): SqlQueryHistoryEntry[] {
	if (!raw || typeof raw !== 'object') {
		return [];
	}

	const document = raw as Partial<SerializedSqlQueryHistoryDocument>;

	if (document.version !== 1 || !Array.isArray(document.entries)) {
		return [];
	}

	return normalizeHistoryEntries(document.entries);
}

export function addHistoryEntry(
	entries: readonly SqlQueryHistoryEntry[],
	entry: SqlQueryHistoryEntry,
	maxEntries = SQL_QUERY_HISTORY_MAX_ENTRIES
): SqlQueryHistoryEntry[] {
	const normalized = normalizeHistoryEntry(entry);

	if (!normalized) {
		return normalizeHistoryEntries(entries, maxEntries);
	}

	return normalizeHistoryEntries([normalized, ...entries], maxEntries);
}

export function removeHistoryEntry(
	entries: readonly SqlQueryHistoryEntry[],
	entryId: string
): SqlQueryHistoryEntry[] {
	const normalizedId = entryId.trim();

	if (!normalizedId) {
		return [...entries];
	}

	return entries.filter(entry => entry.id !== normalizedId);
}

export function createSqlPreview(sql: string, maxLength = SQL_QUERY_HISTORY_SQL_PREVIEW_LENGTH): string {
	const normalized = normalizeSql(sql).replace(/\s+/g, ' ');

	if (normalized.length <= maxLength) {
		return normalized;
	}

	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function getHistoryEntryLabel(entry: SqlQueryHistoryEntry): string {
	const status = entry.status === SqlQueryHistoryStatus.Success ? 'OK' : 'ERR';
	return `${status} · ${entry.connectionId} · ${entry.sqlPreview}`;
}

export function getHistoryEntryDetail(entry: SqlQueryHistoryEntry): string {
	if (entry.status === SqlQueryHistoryStatus.Error) {
		return `${entry.durationMs}ms · ${entry.errorMessage ?? 'Query failed'}`;
	}

	const rowText = entry.rowCount === 1 ? '1 row' : `${entry.rowCount ?? 0} rows`;
	const elapsed = entry.elapsedMs ?? entry.durationMs;

	return `${rowText} · ${elapsed}ms`;
}

export function normalizeSql(sql: string): string {
	if (typeof sql !== 'string') {
		return '';
	}

	return sql.trim();
}

function normalizeHistoryEntry(entry: SqlQueryHistoryEntry): SqlQueryHistoryEntry | undefined {
	if (!entry || typeof entry !== 'object') {
		return undefined;
	}

	const id = entry.id?.trim();
	const editorId = entry.editorId?.trim();
	const connectionId = entry.connectionId?.trim();
	const sql = normalizeSql(entry.sql);

	if (!id || !editorId || !connectionId || !sql) {
		return undefined;
	}

	const completedAt = normalizeTimestamp(entry.completedAt);
	const startedAt = normalizeTimestamp(entry.startedAt);

	return {
		id,
		editorId,
		connectionId,
		sql,
		sqlPreview: createSqlPreview(sql),
		status: entry.status === SqlQueryHistoryStatus.Error
			? SqlQueryHistoryStatus.Error
			: SqlQueryHistoryStatus.Success,
		startedAt,
		completedAt,
		durationMs: Math.max(0, entry.durationMs ?? completedAt - startedAt),
		rowCount: normalizeOptionalNumber(entry.rowCount),
		affectedRows: normalizeOptionalNumber(entry.affectedRows),
		elapsedMs: normalizeOptionalNumber(entry.elapsedMs),
		errorMessage: normalizeOptionalString(entry.errorMessage)
	};
}

function normalizeOptionalNumber(value: number | undefined): number | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}

	return Number.isFinite(value) ? value : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function normalizeTimestamp(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : Date.now();
}

function createHistoryEntryId(editorId: string, connectionId: string, completedAt: number, sql: string): string {
	return `${completedAt}-${hashString(`${editorId}:${connectionId}:${sql}`)}`;
}

function hashString(value: string): string {
	let hash = 0;

	for (let index = 0; index < value.length; index++) {
		hash = (hash * 31 + value.charCodeAt(index)) | 0;
	}

	return Math.abs(hash).toString(36);
}
