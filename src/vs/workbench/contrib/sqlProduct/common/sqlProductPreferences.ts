/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Lightweight local preferences.
 *--------------------------------------------------------------------------------------------*/

import { SQL_EDITOR_MAX_RESTORED_DRAFTS } from '../../sqlEditor/common/sqlEditor.js';
import { SQL_RESULT_MAX_RENDER_ROWS } from '../../sqlResult/common/sqlResult.js';
import {
	SQL_PRODUCT_DEFAULT_QUERY,
	SQL_PRODUCT_STORAGE_PREFIX
} from './sqlProduct.js';

export const SQL_PRODUCT_PREFERENCES_STORAGE_KEY = `${SQL_PRODUCT_STORAGE_PREFIX}.preferences`;

export const SQL_PRODUCT_MIN_RESULT_ROWS = 50;
export const SQL_PRODUCT_MAX_RESULT_ROWS = 10_000;

export const SQL_PRODUCT_MIN_RESTORED_DRAFTS = 0;
export const SQL_PRODUCT_MAX_RESTORED_DRAFTS = 50;

export interface SqlProductPreferences {
	readonly restoreSqlLayoutOnStartup: boolean;
	readonly openWelcomeQueryOnFirstLaunch: boolean;
	readonly restoreEditorDraftsOnStartup: boolean;
	readonly autoSaveEditorDrafts: boolean;
	readonly resultMaxRows: number;
	readonly maxRestoredEditorDrafts: number;
	readonly defaultQuery: string;
}

export type SqlProductPreferenceKey = keyof SqlProductPreferences;

export const DEFAULT_SQL_PRODUCT_PREFERENCES: SqlProductPreferences = {
	restoreSqlLayoutOnStartup: true,
	openWelcomeQueryOnFirstLaunch: false,
	restoreEditorDraftsOnStartup: true,
	autoSaveEditorDrafts: true,
	resultMaxRows: SQL_RESULT_MAX_RENDER_ROWS,
	maxRestoredEditorDrafts: SQL_EDITOR_MAX_RESTORED_DRAFTS,
	defaultQuery: SQL_PRODUCT_DEFAULT_QUERY
};

export interface SerializedSqlProductPreferencesDocument {
	readonly version: 1;
	readonly preferences: Partial<SqlProductPreferences>;
}

export function normalizeSqlProductPreferences(raw: unknown): SqlProductPreferences {
	if (!raw || typeof raw !== 'object') {
		return DEFAULT_SQL_PRODUCT_PREFERENCES;
	}

	const value = raw as Partial<SqlProductPreferences>;

	return {
		restoreSqlLayoutOnStartup: normalizeBoolean(
			value.restoreSqlLayoutOnStartup,
			DEFAULT_SQL_PRODUCT_PREFERENCES.restoreSqlLayoutOnStartup
		),
		openWelcomeQueryOnFirstLaunch: normalizeBoolean(
			value.openWelcomeQueryOnFirstLaunch,
			DEFAULT_SQL_PRODUCT_PREFERENCES.openWelcomeQueryOnFirstLaunch
		),
		restoreEditorDraftsOnStartup: normalizeBoolean(
			value.restoreEditorDraftsOnStartup,
			DEFAULT_SQL_PRODUCT_PREFERENCES.restoreEditorDraftsOnStartup
		),
		autoSaveEditorDrafts: normalizeBoolean(
			value.autoSaveEditorDrafts,
			DEFAULT_SQL_PRODUCT_PREFERENCES.autoSaveEditorDrafts
		),
		resultMaxRows: normalizeIntegerRange(
			value.resultMaxRows,
			SQL_PRODUCT_MIN_RESULT_ROWS,
			SQL_PRODUCT_MAX_RESULT_ROWS,
			DEFAULT_SQL_PRODUCT_PREFERENCES.resultMaxRows
		),
		maxRestoredEditorDrafts: normalizeIntegerRange(
			value.maxRestoredEditorDrafts,
			SQL_PRODUCT_MIN_RESTORED_DRAFTS,
			SQL_PRODUCT_MAX_RESTORED_DRAFTS,
			DEFAULT_SQL_PRODUCT_PREFERENCES.maxRestoredEditorDrafts
		),
		defaultQuery: normalizeDefaultQuery(
			value.defaultQuery,
			DEFAULT_SQL_PRODUCT_PREFERENCES.defaultQuery
		)
	};
}

export function serializeSqlProductPreferences(
	preferences: SqlProductPreferences
): SerializedSqlProductPreferencesDocument {
	return {
		version: 1,
		preferences: normalizeSqlProductPreferences(preferences)
	};
}

export function deserializeSqlProductPreferences(raw: unknown): SqlProductPreferences {
	if (!raw || typeof raw !== 'object') {
		return DEFAULT_SQL_PRODUCT_PREFERENCES;
	}

	const document = raw as Partial<SerializedSqlProductPreferencesDocument>;

	if (document.version !== 1 || !document.preferences || typeof document.preferences !== 'object') {
		return DEFAULT_SQL_PRODUCT_PREFERENCES;
	}

	return normalizeSqlProductPreferences(document.preferences);
}

export function updateSqlProductPreference<K extends SqlProductPreferenceKey>(
	preferences: SqlProductPreferences,
	key: K,
	value: SqlProductPreferences[K]
): SqlProductPreferences {
	return normalizeSqlProductPreferences({
		...preferences,
		[key]: value
	});
}

export function resetSqlProductPreferences(): SqlProductPreferences {
	return DEFAULT_SQL_PRODUCT_PREFERENCES;
}

export function getSqlProductPreferenceLabel(key: SqlProductPreferenceKey): string {
	switch (key) {
		case 'restoreSqlLayoutOnStartup':
			return 'Restore SQL layout on startup';

		case 'openWelcomeQueryOnFirstLaunch':
			return 'Open welcome query on first launch';

		case 'restoreEditorDraftsOnStartup':
			return 'Restore editor drafts on startup';

		case 'autoSaveEditorDrafts':
			return 'Auto save editor drafts';

		case 'resultMaxRows':
			return 'Max result rows';

		case 'maxRestoredEditorDrafts':
			return 'Max restored editor drafts';

		case 'defaultQuery':
			return 'Default query';

		default:
			return assertNever(key);
	}
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function normalizeIntegerRange(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return fallback;
	}

	const normalized = Math.floor(value);

	return Math.min(max, Math.max(min, normalized));
}

function normalizeDefaultQuery(value: unknown, fallback: string): string {
	if (typeof value !== 'string') {
		return fallback;
	}

	const normalized = value.trim();

	if (!normalized) {
		return fallback;
	}

	return value;
}

function assertNever(value: never): never {
	throw new Error(`Unexpected SQL product preference key: ${String(value)}`);
}
