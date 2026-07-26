import assert from 'node:assert/strict';
import test from 'node:test';

import {
	DEFAULT_SQL_PRODUCT_PREFERENCES,
	deserializeSqlProductPreferences,
	getSqlProductPreferenceLabel,
	normalizeSqlProductPreferences,
	resetSqlProductPreferences,
	serializeSqlProductPreferences,
	SqlProductPreferences,
	updateSqlProductPreference
} from '../common/sqlProductPreferences.js';

test('default preferences show the first-launch Welcome flow', () => {
	assert.equal(DEFAULT_SQL_PRODUCT_PREFERENCES.openWelcomeQueryOnFirstLaunch, true);
});

test('normalizeSqlProductPreferences returns defaults for invalid input', () => {
	assert.deepEqual(normalizeSqlProductPreferences(undefined), DEFAULT_SQL_PRODUCT_PREFERENCES);

	assert.deepEqual(normalizeSqlProductPreferences(null), DEFAULT_SQL_PRODUCT_PREFERENCES);
});

test('normalizeSqlProductPreferences normalizes booleans and numbers', () => {
	const preferences = normalizeSqlProductPreferences({
		restoreSqlLayoutOnStartup: false,
		openWelcomeQueryOnFirstLaunch: true,
		restoreEditorDraftsOnStartup: false,
		autoSaveEditorDrafts: false,
		resultMaxRows: 20_000,
		maxRestoredEditorDrafts: 100,
		defaultQuery: 'SELECT 2;'
	});

	assert.equal(preferences.restoreSqlLayoutOnStartup, false);
	assert.equal(preferences.openWelcomeQueryOnFirstLaunch, true);
	assert.equal(preferences.restoreEditorDraftsOnStartup, false);
	assert.equal(preferences.autoSaveEditorDrafts, false);
	assert.equal(preferences.resultMaxRows, 10_000);
	assert.equal(preferences.maxRestoredEditorDrafts, 50);
	assert.equal(preferences.defaultQuery, 'SELECT 2;');
});

test('normalizeSqlProductPreferences clamps too small values', () => {
	const preferences = normalizeSqlProductPreferences({
		resultMaxRows: 1,
		maxRestoredEditorDrafts: -1
	});

	assert.equal(preferences.resultMaxRows, 50);
	assert.equal(preferences.maxRestoredEditorDrafts, 0);
});

test('normalizeSqlProductPreferences keeps fallback for invalid values', () => {
	const preferences = normalizeSqlProductPreferences({
		restoreSqlLayoutOnStartup: 'bad',
		resultMaxRows: Number.NaN,
		maxRestoredEditorDrafts: Number.POSITIVE_INFINITY,
		defaultQuery: '   '
	});

	assert.equal(preferences.restoreSqlLayoutOnStartup, DEFAULT_SQL_PRODUCT_PREFERENCES.restoreSqlLayoutOnStartup);
	assert.equal(preferences.resultMaxRows, DEFAULT_SQL_PRODUCT_PREFERENCES.resultMaxRows);
	assert.equal(preferences.maxRestoredEditorDrafts, DEFAULT_SQL_PRODUCT_PREFERENCES.maxRestoredEditorDrafts);
	assert.equal(preferences.defaultQuery, DEFAULT_SQL_PRODUCT_PREFERENCES.defaultQuery);
});

test('serializeSqlProductPreferences and deserializeSqlProductPreferences round trip', () => {
	const preferences: SqlProductPreferences = {
		...DEFAULT_SQL_PRODUCT_PREFERENCES,
		restoreSqlLayoutOnStartup: false,
		resultMaxRows: 500
	};

	const document = serializeSqlProductPreferences(preferences);

	assert.equal(document.version, 1);

	const restored = deserializeSqlProductPreferences(document);

	assert.equal(restored.restoreSqlLayoutOnStartup, false);
	assert.equal(restored.resultMaxRows, 500);
});

test('deserializeSqlProductPreferences rejects unknown document', () => {
	assert.deepEqual(deserializeSqlProductPreferences(undefined), DEFAULT_SQL_PRODUCT_PREFERENCES);
	assert.deepEqual(deserializeSqlProductPreferences({ version: 2, preferences: {} }), DEFAULT_SQL_PRODUCT_PREFERENCES);
	assert.deepEqual(
		deserializeSqlProductPreferences({ version: 1, preferences: 'bad' }),
		DEFAULT_SQL_PRODUCT_PREFERENCES
	);
});

test('updateSqlProductPreference updates one preference', () => {
	const next = updateSqlProductPreference(DEFAULT_SQL_PRODUCT_PREFERENCES, 'restoreSqlLayoutOnStartup', false);

	assert.equal(next.restoreSqlLayoutOnStartup, false);
	assert.equal(next.openWelcomeQueryOnFirstLaunch, DEFAULT_SQL_PRODUCT_PREFERENCES.openWelcomeQueryOnFirstLaunch);
});

test('resetSqlProductPreferences returns defaults', () => {
	assert.deepEqual(resetSqlProductPreferences(), DEFAULT_SQL_PRODUCT_PREFERENCES);
});

test('getSqlProductPreferenceLabel returns labels', () => {
	assert.equal(getSqlProductPreferenceLabel('restoreSqlLayoutOnStartup'), 'Restore SQL layout on startup');
	assert.equal(getSqlProductPreferenceLabel('openWelcomeQueryOnFirstLaunch'), 'Open welcome query on first launch');
	assert.equal(getSqlProductPreferenceLabel('restoreEditorDraftsOnStartup'), 'Restore editor drafts on startup');
	assert.equal(getSqlProductPreferenceLabel('autoSaveEditorDrafts'), 'Auto save editor drafts');
	assert.equal(getSqlProductPreferenceLabel('resultMaxRows'), 'Max result rows');
	assert.equal(getSqlProductPreferenceLabel('maxRestoredEditorDrafts'), 'Max restored editor drafts');
	assert.equal(getSqlProductPreferenceLabel('defaultQuery'), 'Default query');
});
