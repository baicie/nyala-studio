import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('R0 verifier is fail-closed on the current Z1 No-Go state', async () => {
	const source = await readFile(new URL('./verify-sql-mvp-vnext-release.mjs', import.meta.url), 'utf8');
	const report = JSON.parse(
		await readFile(new URL('../docs/sql-mvp-phases/phase-vnext-release-gate.json', import.meta.url), 'utf8')
	);
	assert.match(source, /NO-GO/);
	assert.equal(report.decision, 'NO-GO');
	assert.ok(report.blockers.some(reason => reason.includes('Z1 gate decision')));
});

test('R0 verifier keeps Zeus production imports inside SQL Result', async () => {
	const source = await readFile(new URL('./verify-sql-mvp-vnext-release.mjs', import.meta.url), 'utf8');
	assert.match(source, /contrib\/sqlResult/);
	assert.match(source, /@zeus-web|@zeus-js|zw-data-grid/);
});
