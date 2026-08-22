import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [captureWorkflow, attestationWorkflow] = await Promise.all([
	readFile(new URL('../.github/workflows/sql-agent-native.yml', import.meta.url), 'utf8'),
	readFile(new URL('../.github/workflows/sql-agent-checkpoint-w-attest.yml', import.meta.url), 'utf8')
]);

test('native capture workflow produces evidence before any manual attestation', () => {
	assert.match(captureWorkflow, /^name: SQL Agent Native Workbench Capture$/m);
	assert.equal(captureWorkflow.match(/capture:sql-agent-workbench-native/g)?.length, 2);
	assert.match(captureWorkflow, /name: sql-agent-native-macos/);
	assert.match(captureWorkflow, /name: sql-agent-native-windows/);
	assert.doesNotMatch(captureWorkflow, /attest_|manual_evidence|create-sql-agent-checkpoint-w-attestation/);
});

test('Checkpoint W attestation verifies one prior capture run without executing its revision', () => {
	const dispatchInputs = attestationWorkflow.slice(
		attestationWorkflow.indexOf('inputs:'),
		attestationWorkflow.indexOf('\npermissions:')
	);
	assert.equal(dispatchInputs.match(/^\s+type:/gm)?.length, 9);
	assert.doesNotMatch(dispatchInputs, /capture_run_attempt|source_revision|source_ref/);
	assert.match(attestationWorkflow, /actions: read/);
	assert.match(
		attestationWorkflow,
		/if: github\.ref_protected == true && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/
	);
	assert.match(attestationWorkflow, /^\s+environment: sql-agent-checkpoint-w$/m);
	assert.match(attestationWorkflow, /test "\$GITHUB_REF_PROTECTED" = "true"/);
	assert.equal(attestationWorkflow.match(/actions\/checkout@/g)?.length, 1);
	assert.match(attestationWorkflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
	assert.doesNotMatch(attestationWorkflow, /ref: \$\{\{ steps\.capture-provenance\.outputs\.source_revision \}\}/);
	assert.match(attestationWorkflow, /run-id: \$\{\{ inputs\.capture_run_id \}\}/);
	assert.match(attestationWorkflow, /artifact-ids: \$\{\{ steps\.capture-run\.outputs\.artifact_ids \}\}/);
	assert.match(attestationWorkflow, /github-token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
	assert.doesNotMatch(attestationWorkflow, /pattern: sql-agent-native-\*/);
	assert.match(attestationWorkflow, /actions\/runs\/\$CAPTURE_RUN_ID/);
	assert.match(attestationWorkflow, /actions\/runs\/\$CAPTURE_RUN_ID\/artifacts/);
	assert.match(attestationWorkflow, /verify-sql-agent-capture-run\.mjs/);
	assert.match(attestationWorkflow, /--github-output "\$GITHUB_OUTPUT"/);
	assert.match(attestationWorkflow, /Native capture provenance mismatch/);
	assert.match(attestationWorkflow, /Downloaded artifacts do not belong to the requested capture run/);
	assert.match(attestationWorkflow, /Capture source revision does not match the protected attestation revision/);
	assert.match(attestationWorkflow, /Capture source ref does not match the protected default branch/);
	assert.match(attestationWorkflow, /--workflow-run-id "\$CAPTURE_RUN_ID"/);
	assert.match(attestationWorkflow, /--attestation-workflow-run-id "\$GITHUB_RUN_ID"/);
	assert.match(attestationWorkflow, /--attestation-workflow-run-attempt "\$GITHUB_RUN_ATTEMPT"/);
	assert.match(attestationWorkflow, /--expected-revision "\$SOURCE_REVISION"/);
	assert.match(attestationWorkflow, /--expected-ref "\$SOURCE_REF"/);
	assert.match(attestationWorkflow, /--capture-run "\$RUNNER_TEMP\/sql-agent-checkpoint-w\/capture-run\.json"/);

	const checkoutIndex = attestationWorkflow.indexOf('actions/checkout@');
	const metadataIndex = attestationWorkflow.indexOf('Verify immutable capture run metadata');
	const downloadIndex = attestationWorkflow.indexOf('Download native evidence from the reviewed capture run');
	const provenanceIndex = attestationWorkflow.indexOf('Resolve immutable capture provenance');
	const attestIndex = attestationWorkflow.indexOf('Record revision-bound manual attestation');
	const verifyIndex = attestationWorkflow.indexOf('Run fail-closed Checkpoint W gate');
	assert.ok(
		checkoutIndex >= 0 &&
			checkoutIndex < metadataIndex &&
			metadataIndex < downloadIndex &&
			downloadIndex < provenanceIndex &&
			provenanceIndex < attestIndex &&
			attestIndex < verifyIndex
	);
});

test('Checkpoint W workflow binds a separate evidence reference to each manual gate', () => {
	for (const argument of [
		'--macos-keyboard-evidence-ref',
		'--voiceover-evidence-ref',
		'--windows-keyboard-evidence-ref',
		'--narrator-evidence-ref'
	]) {
		assert.equal(attestationWorkflow.match(new RegExp(argument, 'g'))?.length, 1);
	}
	assert.doesNotMatch(attestationWorkflow, /--evidence-refs\b|manual_evidence_refs/);
});
