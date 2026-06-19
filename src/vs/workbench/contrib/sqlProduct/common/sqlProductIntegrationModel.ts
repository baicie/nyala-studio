/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product preference integration helpers.
 *--------------------------------------------------------------------------------------------*/

import { SqlProductPreferences } from './sqlProductPreferences.js';

export function shouldRestoreSqlEditorDrafts(preferences: SqlProductPreferences): boolean {
	return preferences.restoreEditorDraftsOnStartup && preferences.maxRestoredEditorDrafts > 0;
}

export function limitRestoredDrafts<T>(drafts: readonly T[], preferences: SqlProductPreferences): T[] {
	if (!shouldRestoreSqlEditorDrafts(preferences)) {
		return [];
	}

	return drafts.slice(0, preferences.maxRestoredEditorDrafts);
}

export function shouldAutoSaveSqlEditorDraft(preferences: SqlProductPreferences): boolean {
	return preferences.autoSaveEditorDrafts;
}

export function getPreferredResultMaxRows(preferences: SqlProductPreferences): number {
	return preferences.resultMaxRows;
}
