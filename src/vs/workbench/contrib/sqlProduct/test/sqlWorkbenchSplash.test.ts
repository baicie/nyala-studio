import assert from 'node:assert/strict';
import test from 'node:test';

import { NYALA_SPLASH_ELEMENT_ID } from '../browser/sqlWorkbenchSplash.js';

test('NYALA_SPLASH_ELEMENT_ID matches the static markup rendered by index.html', () => {
	assert.strictEqual(
		NYALA_SPLASH_ELEMENT_ID,
		'nyala-splash',
		'changing the splash element id requires updating the index.html markup in lockstep'
	);
});

test('SqlWorkbenchSplashContribution.ID is stable for the registry', async () => {
	const { SqlWorkbenchSplashContribution } = await import('../browser/sqlWorkbenchSplash.js');
	assert.strictEqual(
		SqlWorkbenchSplashContribution.ID,
		'workbench.contrib.sqlWorkbenchSplash',
		'changing the contribution id would invalidate any contribution registry caches; keep it stable'
	);
});