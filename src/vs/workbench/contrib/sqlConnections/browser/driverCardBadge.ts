/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL driver status badge helpers.
 *
 * Phase 00 — Runtime Status Alignment.
 * UI surfaces must call into these helpers instead of writing the literal
 * `Stable` / `Preview` / `Planned` / `Disabled` text or the colour codes
 * themselves. The helper reads from `ISqlDriverCatalogService` so every
 * badge updates in lockstep when the runtime status table changes.
 *--------------------------------------------------------------------------------------------*/

import { ISqlDriverCatalogService, SqlRuntimeDriverId, SqlRuntimeStatus } from '../../../../workbench/services/sql/common/sqlDriverCatalog.js';

export interface SqlDriverStatusBadge {
	readonly text: string;
	readonly ariaLabel: string;
	readonly title: string;
	readonly className: string;
	readonly runnable: boolean;
}

const STATUS_TEXT: Readonly<Record<SqlRuntimeStatus, string>> = {
	[SqlRuntimeStatus.Stable]: 'Stable',
	[SqlRuntimeStatus.Preview]: 'Preview',
	[SqlRuntimeStatus.Planned]: 'Planned',
	[SqlRuntimeStatus.Disabled]: 'Disabled'
};

const STATUS_CLASS: Readonly<Record<SqlRuntimeStatus, string>> = {
	[SqlRuntimeStatus.Stable]: 'sql-driver-status-badge sql-driver-status-badge--stable',
	[SqlRuntimeStatus.Preview]: 'sql-driver-status-badge sql-driver-status-badge--preview',
	[SqlRuntimeStatus.Planned]: 'sql-driver-status-badge sql-driver-status-badge--planned',
	[SqlRuntimeStatus.Disabled]: 'sql-driver-status-badge sql-driver-status-badge--disabled'
};

export function buildSqlDriverStatusBadge(
	service: ISqlDriverCatalogService,
	id: SqlRuntimeDriverId
): SqlDriverStatusBadge {
	const entry = service.findRuntimeStatus(id);

	if (!entry) {
		return {
			text: 'Unknown',
			ariaLabel: `Driver status unknown for ${id}`,
			title: `No runtime status entry for driver ${id}`,
			className: 'sql-driver-status-badge sql-driver-status-badge--disabled',
			runnable: false
		};
	}

	const text = STATUS_TEXT[entry.status];

	return {
		text,
		ariaLabel: `${entry.displayName} runtime status: ${text}`,
		title: entry.summary,
		className: STATUS_CLASS[entry.status],
		runnable: entry.status === SqlRuntimeStatus.Stable || entry.status === SqlRuntimeStatus.Preview
	};
}

export function renderSqlDriverStatusBadge(badge: SqlDriverStatusBadge): string {
	return `<span class="${badge.className}" role="status" aria-label="${escapeAttr(badge.ariaLabel)}" title="${escapeAttr(badge.title)}">${escapeText(badge.text)}</span>`;
}

function escapeAttr(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function escapeText(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
}
