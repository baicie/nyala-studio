/*---------------------------------------------------------------------------------------------
 * Nyala Studio - Settings search integration contract tests.
 *
 * SettingsEditor2 has browser-only dependencies that cannot be loaded by the Node test runner.
 * These checks guard the small SideX adapter surface that previously failed at runtime.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const suggestInputSource = readFileSync(
	new URL('../../codeEditor/browser/suggestEnabledInput/suggestEnabledInput.ts', import.meta.url),
	'utf8'
);
const settingsEditorSource = readFileSync(new URL('../browser/settingsEditor2.ts', import.meta.url), 'utf8');

test('settings search input implements the aria update contract used during result navigation', () => {
	assert.match(suggestInputSource, /updateAriaLabel\(label: string\): void/);
	assert.match(settingsEditorSource, /this\.searchWidget\.updateAriaLabel\(label\)/);
	assert.doesNotMatch(settingsEditorSource, /searchWidget as any\)\.updateAriaLabel/);
});

test('settings search exposes a stop action and always completes its progress runner', () => {
	assert.match(settingsEditorSource, /SETTINGS_EDITOR_COMMAND_CANCEL_SEARCH/);
	assert.match(settingsEditorSource, /cancelSearchInProgress\(announce: boolean\)/);
	assert.match(settingsEditorSource, /finally\s*\{[\s\S]*finishSearchProgress/);
});

test('cancelled advanced-filter refreshes cannot commit stale settings trees', () => {
	assert.match(
		settingsEditorSource,
		/onConfigUpdate\(undefined, false, false, searchInProgress\.token\)/
	);
	assert.match(
		settingsEditorSource,
		/createTocTreeForExtensionSettings[\s\S]*token\.isCancellationRequested[\s\S]*setAdditionalGroups/
	);
});
