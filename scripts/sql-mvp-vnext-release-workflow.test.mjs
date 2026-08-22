import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(
	new URL('../.github/workflows/sql-mvp-vnext-release-evidence.yml', import.meta.url),
	'utf8'
);

test('vNext release evidence workflow authenticates A4 and Z1 artifacts before R0', () => {
	assert.match(workflow, /^name: SQL MVP vNext Release Evidence$/m);
	const dispatchInputs = workflow.slice(workflow.indexOf('inputs:'), workflow.indexOf('\npermissions:'));
	assert.equal(dispatchInputs.match(/^\s+type:/gm)?.length, 2);
	assert.match(dispatchInputs, /a4_attestation_run_id:/);
	assert.match(dispatchInputs, /z1_attestation_run_id:/);
	assert.match(workflow, /actions: read/);
	assert.match(
		workflow,
		/if: github\.ref_protected == true && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/
	);
	assert.match(workflow, /^\s+environment: sql-mvp-vnext-release$/m);
	assert.match(workflow, /test "\$GITHUB_REF_PROTECTED" = "true"/);
	assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
	assert.match(workflow, /actions\/runs\/\$A4_ATTESTATION_RUN_ID/);
	assert.match(workflow, /actions\/runs\/\$Z1_ATTESTATION_RUN_ID/);
	assert.match(workflow, /verify-sql-agent-attestation-run\.mjs/);
	assert.match(workflow, /SQL Result Grid Z1 Gate Attestation/);
	assert.match(workflow, /sql-result-grid-gate-attestation/);
	assert.match(workflow, /A4_ARTIFACT_URL: \$\{\{ steps\.a4-run\.outputs\.artifact_url \}\}/);
	assert.match(workflow, /Z1_ARTIFACT_URL: \$\{\{ steps\.z1-run\.outputs\.artifact_url \}\}/);
	assert.match(workflow, /A4_ARTIFACT_DIGEST: \$\{\{ steps\.a4-run\.outputs\.artifact_digest \}\}/);
	assert.match(workflow, /Z1_ARTIFACT_DIGEST: \$\{\{ steps\.z1-run\.outputs\.artifact_digest \}\}/);
	assert.equal(workflow.match(/sha256sum --check --strict/g)?.length, 1);
	assert.match(workflow, /download_verified_artifact "A4"/);
	assert.match(workflow, /download_verified_artifact "Z1"/);
	assert.doesNotMatch(workflow, /actions\/download-artifact@/);
	for (const environmentName of [
		'NYALA_A4_CHECKPOINT_W_GATE',
		'NYALA_A4_CHECKPOINT_W_ATTESTATION_RUN_METADATA',
		'NYALA_Z1_GATE',
		'NYALA_Z1_ATTESTATION',
		'NYALA_Z1_ZEUS_BUNDLE',
		'NYALA_Z1_ATTESTATION_RUN_METADATA',
		'NYALA_EXPECTED_REPOSITORY',
		'NYALA_EXPECTED_SOURCE_REF'
	]) {
		assert.match(workflow, new RegExp(`${environmentName}:`));
	}
	assert.match(workflow, /verify-sql-mvp-vnext-release\.mjs/);
	assert.match(workflow, /name: sql-mvp-vnext-release-evidence/);

	const checkoutIndex = workflow.indexOf('actions/checkout@');
	const metadataIndex = workflow.indexOf('Fetch attestation run metadata');
	const verifyIndex = workflow.indexOf('Verify A4 attestation run metadata');
	const downloadIndex = workflow.indexOf('Download, digest-check, and extract attestation artifacts');
	const releaseIndex = workflow.indexOf('Run authenticated R0 release gate');
	assert.ok(
		checkoutIndex >= 0 &&
			checkoutIndex < metadataIndex &&
			metadataIndex < verifyIndex &&
			verifyIndex < downloadIndex &&
			downloadIndex < releaseIndex
	);
});
