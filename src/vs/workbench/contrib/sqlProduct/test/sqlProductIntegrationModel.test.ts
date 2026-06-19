import assert from 'node:assert/strict';
import test from 'node:test';

import {
	getPreferredResultMaxRows,
	limitRestoredDrafts,
	shouldAutoSaveSqlEditorDraft,
	shouldRestoreSqlEditorDrafts
} from '../common/sqlProductIntegrationModel.js';
import { DEFAULT_SQL_PRODUCT_PREFERENCES } from '../common/sqlProductPreferences.js';

test('shouldRestoreSqlEditorDrafts respects restore flag', () => {
	assert.equal(
		shouldRestoreSqlEditorDrafts({
			...DEFAULT_SQL_PRODUCT_PREFERENCES,
			restoreEditorDraftsOnStartup: true,
			maxRestoredEditorDrafts: 10
		}),
		true
	);

	assert.equal(
		shouldRestoreSqlEditorDrafts({
			...DEFAULT_SQL_PRODUCT_PREFERENCES,
			restoreEditorDraftsOnStartup: false,
			maxRestoredEditorDrafts: 10
		}),
		false
	);
});

test('shouldRestoreSqlEditorDrafts respects maxRestoredEditorDrafts', () => {
	assert.equal(
		shouldRestoreSqlEditorDrafts({
			...DEFAULT_SQL_PRODUCT_PREFERENCES,
			restoreEditorDraftsOnStartup: true,
			maxRestoredEditorDrafts: 0
		}),
		false
	);
});

test('limitRestoredDrafts returns empty when restore disabled', () => {
	const drafts = ['a', 'b', 'c'];

	assert.deepEqual(
		limitRestoredDrafts(drafts, {
			...DEFAULT_SQL_PRODUCT_PREFERENCES,
			restoreEditorDraftsOnStartup: false,
			maxRestoredEditorDrafts: 10
		}),
		[]
	);
});

test('limitRestoredDrafts caps draft count', () => {
	const drafts = ['a', 'b', 'c'];

	assert.deepEqual(
		limitRestoredDrafts(drafts, {
			...DEFAULT_SQL_PRODUCT_PREFERENCES,
			restoreEditorDraftsOnStartup: true,
			maxRestoredEditorDrafts: 2
		}),
		['a', 'b']
	);
});

test('shouldAutoSaveSqlEditorDraft returns preference value', () => {
	assert.equal(
		shouldAutoSaveSqlEditorDraft({
			...DEFAULT_SQL_PRODUCT_PREFERENCES,
			autoSaveEditorDrafts: true
		}),
		true
	);

	assert.equal(
		shouldAutoSaveSqlEditorDraft({
			...DEFAULT_SQL_PRODUCT_PREFERENCES,
			autoSaveEditorDrafts: false
		}),
		false
	);
});

test('getPreferredResultMaxRows returns resultMaxRows', () => {
	assert.equal(
		getPreferredResultMaxRows({
			...DEFAULT_SQL_PRODUCT_PREFERENCES,
			resultMaxRows: 500
		}),
		500
	);
});
