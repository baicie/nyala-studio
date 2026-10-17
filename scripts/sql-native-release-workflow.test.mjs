import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../.github/workflows/sql-native-release-evidence.yml', import.meta.url), 'utf8');

test('native-only release workflow accepts only the A4 attestation run input', () => {
	const inputBlock = source.split('inputs:\n')[1]?.split('\n\npermissions:')[0] ?? '';
	assert.match(inputBlock, /^      a4_attestation_run_id:$/m);
	assert.doesNotMatch(inputBlock, /z1_attestation_run_id|zeus/i);
});

test('native-only release workflow authenticates the A4 attestation and invokes the native gate', () => {
	assert.match(source, /A4_ATTESTATION_RUN_ID: \$\{\{ inputs\.a4_attestation_run_id \}\}/);
	assert.match(source, /\$A4_ATTESTATION_RUN_ID\/artifacts\?per_page=100/);
	assert.match(source, /--expected-workflow-name 'SQL Agent Checkpoint W Attestation'/);
	assert.match(source, /--expected-artifact-name sql-agent-checkpoint-w/);
	assert.match(source, /node scripts\/verify-sql-native-release\.mjs/);
	assert.match(source, /a4\/phase-a4-checkpoint-w\.json/);
	assert.match(source, /a4-attestation-run\.json/);
	assert.match(source, /sql-native-release-evidence\/a4$/m);
	assert.doesNotMatch(
		source,
		/z1_attestation_run_id|Z1 gate|sql-result-grid-gate-attestation|@zeus-web|data-grid-bundle/i
	);
});

test('native-only release workflow is protected and publishes native-only evidence', () => {
	assert.match(
		source,
		/if: github\.ref_protected == true && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/
	);
	assert.match(source, /environment: sql-native-release/);
	assert.match(source, /name: sql-native-release-evidence/);
	assert.match(source, /name: Enforce native-only release decision/);
	assert.match(source, /test ! -L "\$EVIDENCE_ROOT\/a4\/phase-a4-checkpoint-w\.json"/);
	assert.match(source, /find "\$EVIDENCE_ROOT\/a4" -type l/);
});
