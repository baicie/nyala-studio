/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product profile and workbench trim list.
 *--------------------------------------------------------------------------------------------*/

import { SQL_CONNECTIONS_VIEWLET_ID, SQL_CONNECTIONS_VIEW_ID } from '../../sqlConnections/common/sqlConnections.js';
import { SQL_RESULT_VIEWLET_ID, SQL_RESULT_VIEW_ID } from '../../sqlResult/common/sqlResult.js';
import { SQL_QUERY_HISTORY_VIEW_ID } from '../../sqlHistory/common/sqlQueryHistory.js';

export const enum SqlProductWorkbenchSurfaceKind {
	ViewContainer = 'viewContainer',
	View = 'view',
	Command = 'command'
}

export interface SqlProductWorkbenchSurface {
	readonly id: string;
	readonly kind: SqlProductWorkbenchSurfaceKind;
	readonly label: string;
	readonly required: boolean;
}

export const SQL_PRODUCT_REQUIRED_SURFACES: readonly SqlProductWorkbenchSurface[] = [
	{
		id: SQL_CONNECTIONS_VIEWLET_ID,
		kind: SqlProductWorkbenchSurfaceKind.ViewContainer,
		label: 'SQL Connections Container',
		required: true
	},
	{
		id: SQL_CONNECTIONS_VIEW_ID,
		kind: SqlProductWorkbenchSurfaceKind.View,
		label: 'SQL Connections View',
		required: true
	},
	{
		id: SQL_RESULT_VIEWLET_ID,
		kind: SqlProductWorkbenchSurfaceKind.ViewContainer,
		label: 'SQL Results Container',
		required: true
	},
	{
		id: SQL_RESULT_VIEW_ID,
		kind: SqlProductWorkbenchSurfaceKind.View,
		label: 'SQL Results View',
		required: true
	},
	{
		id: SQL_QUERY_HISTORY_VIEW_ID,
		kind: SqlProductWorkbenchSurfaceKind.View,
		label: 'Query History View',
		required: true
	}
];

export const SQL_PRODUCT_LEGACY_WORKBENCH_VIEWLETS: readonly string[] = [
	'workbench.view.explorer',
	'workbench.view.search',
	'workbench.view.scm',
	'workbench.view.debug',
	'workbench.view.extensions',
	'workbench.view.remote',
	'workbench.panel.terminal',
	'workbench.panel.output',
	'workbench.panel.markers',
	'workbench.panel.comments'
];

export interface SqlProductProfile {
	readonly name: string;
	readonly primaryViewContainers: readonly string[];
	readonly requiredSurfaces: readonly SqlProductWorkbenchSurface[];
	readonly legacyWorkbenchViewlets: readonly string[];
}

export const SQL_STUDIO_PRODUCT_PROFILE: SqlProductProfile = {
	name: 'SQL Studio Next',
	primaryViewContainers: [
		SQL_CONNECTIONS_VIEWLET_ID,
		SQL_RESULT_VIEWLET_ID
	],
	requiredSurfaces: SQL_PRODUCT_REQUIRED_SURFACES,
	legacyWorkbenchViewlets: SQL_PRODUCT_LEGACY_WORKBENCH_VIEWLETS
};

export function isSqlProductPrimaryViewContainer(id: string): boolean {
	return SQL_STUDIO_PRODUCT_PROFILE.primaryViewContainers.includes(id);
}

export function isLegacyWorkbenchViewlet(id: string): boolean {
	return SQL_STUDIO_PRODUCT_PROFILE.legacyWorkbenchViewlets.includes(id);
}

export function assertNoLegacyWorkbenchSurface(ids: readonly string[]): void {
	const legacy = ids.filter(isLegacyWorkbenchViewlet);

	if (legacy.length > 0) {
		throw new Error(`Legacy workbench surface should not be exposed in SQL Studio MVP: ${legacy.join(', ')}`);
	}
}

export function getSqlProductRequiredSurfaceIds(): string[] {
	return SQL_STUDIO_PRODUCT_PROFILE.requiredSurfaces.map(surface => surface.id);
}

export function getSqlProductTrimReport(ids: readonly string[]): {
	readonly allowed: string[];
	readonly legacy: string[];
	readonly unknown: string[];
} {
	const required = new Set(getSqlProductRequiredSurfaceIds());
	const legacy = new Set(SQL_STUDIO_PRODUCT_PROFILE.legacyWorkbenchViewlets);

	const allowedIds: string[] = [];
	const legacyIds: string[] = [];
	const unknownIds: string[] = [];

	for (const id of ids) {
		if (required.has(id)) {
			allowedIds.push(id);
			continue;
		}

		if (legacy.has(id)) {
			legacyIds.push(id);
			continue;
		}

		unknownIds.push(id);
	}

	return {
		allowed: allowedIds,
		legacy: legacyIds,
		unknown: unknownIds
	};
}
