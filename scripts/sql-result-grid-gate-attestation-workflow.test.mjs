import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [platformWorkflow, attestationWorkflow] = await Promise.all([
	readFile(new URL('../.github/workflows/sql-result-grid-platform.yml', import.meta.url), 'utf8'),
	readFile(new URL('../.github/workflows/sql-result-grid-gate-attest.yml', import.meta.url), 'utf8')
]);

test('platform workflow publishes one aggregate artifact before Z1 attestation', () => {
	assert.match(platformWorkflow, /^name: SQL Result Grid Native WebView Evidence$/m);
	assert.equal(platformWorkflow.match(/name: sql-result-grid-platform-gate/g)?.length, 1);
	assert.doesNotMatch(platformWorkflow, /create-sql-result-grid-gate-attestation/);
});

test('Z1 attestation runs trusted verification on one digest-bound aggregate artifact', () => {
	assert.match(attestationWorkflow, /^name: SQL Result Grid Z1 Gate Attestation$/m);
	const dispatchInputs = attestationWorkflow.slice(
		attestationWorkflow.indexOf('inputs:'),
		attestationWorkflow.indexOf('\npermissions:')
	);
	assert.equal(dispatchInputs.match(/^\s+type:/gm)?.length, 1);
	assert.match(dispatchInputs, /platform_run_id:/);
	assert.match(attestationWorkflow, /actions: read/);
	assert.match(
		attestationWorkflow,
		/if: github\.ref_protected == true && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/
	);
	assert.match(attestationWorkflow, /^\s+environment: sql-result-grid-z1-gate$/m);
	assert.match(attestationWorkflow, /test "\$GITHUB_REF_PROTECTED" = "true"/);
	assert.equal(attestationWorkflow.match(/actions\/checkout@/g)?.length, 1);
	assert.match(attestationWorkflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
	assert.match(attestationWorkflow, /actions\/runs\/\$PLATFORM_RUN_ID/);
	assert.match(attestationWorkflow, /actions\/runs\/\$PLATFORM_RUN_ID\/artifacts/);
	assert.match(attestationWorkflow, /verify-sql-result-grid-platform-run\.mjs/);
	assert.match(attestationWorkflow, /--expected-revision "\$GITHUB_SHA"/);
	assert.match(attestationWorkflow, /--expected-ref "\$GITHUB_REF"/);
	assert.match(attestationWorkflow, /AGGREGATE_ARTIFACT_URL: \$\{\{ steps\.platform-run\.outputs\.artifact_url \}\}/);
	assert.match(
		attestationWorkflow,
		/AGGREGATE_ARTIFACT_DIGEST: \$\{\{ steps\.platform-run\.outputs\.artifact_digest \}\}/
	);
	assert.match(attestationWorkflow, /sha256sum --check --strict/);
	assert.match(attestationWorkflow, /unzip -Z1/);
	assert.match(attestationWorkflow, /entry\.includes\('\\\\'\)/);
	assert.match(attestationWorkflow, /verify-sql-result-grid-gate\.mjs/);
	assert.match(attestationWorkflow, /create-sql-result-grid-gate-attestation\.mjs/);
	assert.match(attestationWorkflow, /name: sql-result-grid-gate-attestation/);
	assert.doesNotMatch(attestationWorkflow, /pattern: sql-result-grid-\*/);

	const checkoutIndex = attestationWorkflow.indexOf('actions/checkout@');
	const metadataIndex = attestationWorkflow.indexOf('Verify immutable platform run metadata');
	const archiveIndex = attestationWorkflow.indexOf('Download and verify aggregate artifact archive');
	const gateIndex = attestationWorkflow.indexOf('Recompute fail-closed Z1 gate');
	const manifestIndex = attestationWorkflow.indexOf('Record Z1 gate attestation');
	const uploadIndex = attestationWorkflow.indexOf('Upload Z1 gate attestation');
	assert.ok(
		checkoutIndex >= 0 &&
			checkoutIndex < metadataIndex &&
			metadataIndex < archiveIndex &&
			archiveIndex < gateIndex &&
			gateIndex < manifestIndex &&
			manifestIndex < uploadIndex
	);
});
