/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Query History view model.
 *
 * Phase 05 builds the list-of-items shape consumed by the history view:
 * search by free-text, filter by status / connection, and produce the
 * human-facing copy / open payloads. The underlying entries still live
 * in `sqlQueryHistoryModel.ts`; this file only adapts them for the view.
 *--------------------------------------------------------------------------------------------*/

import {
	getHistoryEntryDetail,
	getHistoryEntryLabel,
	SqlQueryHistoryEntry,
	SqlQueryHistoryStatus
} from './sqlQueryHistoryModel.js';

export interface SqlQueryHistoryFilter {
	readonly query?: string;
	readonly status?: SqlQueryHistoryStatus | 'all';
	readonly connectionId?: string;
}

export interface SqlQueryHistoryListItem {
	readonly id: string;
	readonly label: string;
	readonly detail: string;
	readonly sql: string;
	readonly connectionId: string;
	readonly status: SqlQueryHistoryStatus;
	readonly timestamp: number;
}

export function buildSqlQueryHistoryView(
	entries: readonly SqlQueryHistoryEntry[],
	filter: SqlQueryHistoryFilter = {}
): SqlQueryHistoryListItem[] {
	const normalizedQuery = normalizeQuery(filter.query);
	const normalizedConnectionId = normalizeConnectionId(filter.connectionId);

	return entries
		.filter(entry => matchesStatus(entry, filter.status))
		.filter(entry => matchesConnection(entry, normalizedConnectionId))
		.filter(entry => matchesQuery(entry, normalizedQuery))
		.map(entry => ({
			id: entry.id,
			label: getHistoryEntryLabel(entry),
			detail: getHistoryEntryDetail(entry),
			sql: entry.sql,
			connectionId: entry.connectionId,
			status: entry.status,
			timestamp: entry.completedAt
		}));
}

export function createOpenHistorySqlDraft(entry: SqlQueryHistoryEntry): string {
	return entry.sql.trim();
}

export function createCopyHistorySummary(entry: SqlQueryHistoryEntry): string {
	return [
		`Status: ${entry.status}`,
		`Connection: ${entry.connectionId}`,
		`Duration: ${entry.durationMs}ms`,
		`SQL: ${entry.sql}`
	].join('\n');
}

function matchesStatus(entry: SqlQueryHistoryEntry, status: SqlQueryHistoryFilter['status']): boolean {
	return !status || status === 'all' || entry.status === status;
}

function matchesConnection(entry: SqlQueryHistoryEntry, connectionId: string | undefined): boolean {
	return !connectionId || entry.connectionId === connectionId;
}

function matchesQuery(entry: SqlQueryHistoryEntry, query: string | undefined): boolean {
	if (!query) {
		return true;
	}
	if (entry.sql.toLowerCase().includes(query)) {
		return true;
	}
	if (entry.sqlPreview.toLowerCase().includes(query)) {
		return true;
	}
	if (entry.connectionId.toLowerCase().includes(query)) {
		return true;
	}
	if (entry.errorMessage?.toLowerCase().includes(query)) {
		return true;
	}
	return false;
}

function normalizeQuery(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed ? trimmed.toLowerCase() : undefined;
}

function normalizeConnectionId(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}