import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [platformWorkflow, attestationWorkflow] = await Promise.all([
	readFile(new URL('../.github/workflows/sql-result-grid-platform-v8.yml', import.meta.url), 'utf8'),
	readFile(new URL('../.github/workflows/sql-result-grid-gate-v8-attest.yml', import.meta.url), 'utf8')
]);

test('v8 platform workflow is independent and collects only paired renderers', () => {
	assert.match(platformWorkflow, /^name: SQL Result Grid Frame-Aware v8 Platform Evidence$/m);
	assert.match(platformWorkflow, /--frame-aware true/);
	assert.match(platformWorkflow, /--renderer workbench-table,zeus/);
	assert.match(platformWorkflow, /--trace-profile false/);
	assert.match(platformWorkflow, /verify-sql-result-grid-gate-v8\.mjs/);
	assert.match(platformWorkflow, /name: sql-result-grid-v8-platform-gate/);
	assert.match(platformWorkflow, /name: sql-result-grid-v8-macos-webkit/);
	assert.match(platformWorkflow, /name: sql-result-grid-v8-windows-webview2/);
	assert.doesNotMatch(platformWorkflow, /verify-sql-result-grid-gate\.mjs/);
	assert.doesNotMatch(platformWorkflow, /sql-result-grid-platform-gate[^v]/);
});

test('v8 attestation verifies the v8 workflow contract and records the v8 manifest', () => {
	assert.match(attestationWorkflow, /^name: SQL Result Grid v8 Gate Attestation$/m);
	assert.match(attestationWorkflow, /--contract v8/);
	assert.match(attestationWorkflow, /sql-result-grid-platform-v8\.yml/);
	assert.match(attestationWorkflow, /verify-sql-result-grid-gate-v8\.mjs/);
	assert.match(attestationWorkflow, /create-sql-result-grid-gate-v8-attestation\.mjs/);
	assert.match(attestationWorkflow, /name: sql-result-grid-gate-v8-attestation/);
	assert.match(attestationWorkflow, /sha256sum --check --strict/);
	assert.match(attestationWorkflow, /unzip -Z1/);
	assert.match(attestationWorkflow, /entry\.includes\('\\\\'\)/);
	assert.match(attestationWorkflow, /test ! -L/);
	assert.match(attestationWorkflow, /platform-evidence-v8\.json/);
	assert.doesNotMatch(attestationWorkflow, /verify-sql-result-grid-gate\.mjs(?!-v8)/);
});
