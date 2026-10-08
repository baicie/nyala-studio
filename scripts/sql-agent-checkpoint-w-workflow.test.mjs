import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [captureWorkflow, attestationWorkflow, tauriConfig, captureScript] = await Promise.all([
	readFile(new URL('../.github/workflows/sql-agent-native.yml', import.meta.url), 'utf8'),
	readFile(new URL('../.github/workflows/sql-agent-checkpoint-w-attest.yml', import.meta.url), 'utf8'),
	readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8').then(JSON.parse),
	readFile(new URL('./capture-sql-agent-workbench-webdriver.mjs', import.meta.url), 'utf8')
]);

test('native capture workflow produces evidence before any manual attestation', () => {
	assert.match(captureWorkflow, /^name: SQL Agent Native Workbench Capture$/m);
	assert.equal(captureWorkflow.match(/capture:sql-agent-workbench-native/g)?.length, 2);
	assert.match(captureWorkflow, /name: sql-agent-native-macos/);
	assert.match(captureWorkflow, /name: sql-agent-native-windows/);
	assert.doesNotMatch(captureWorkflow, /attest_|manual_evidence|create-sql-agent-checkpoint-w-attestation/);
});

test('native capture embeds the built frontend and does not supply an external page source', () => {
	for (const [start, end] of [
		['  macos-agent:', '  windows-agent:'],
		['  windows-agent:', undefined]
	]) {
		const startIndex = captureWorkflow.indexOf(start);
		const job = captureWorkflow.slice(startIndex, end ? captureWorkflow.indexOf(end) : undefined);
		const frontendBuildIndex = job.indexOf('pnpm run build');
		const binaryBuildIndex = job.indexOf('pnpm exec tauri build');
		const captureIndex = job.indexOf('capture:sql-agent-workbench-native');
		assert.ok(frontendBuildIndex >= 0 && frontendBuildIndex < binaryBuildIndex && binaryBuildIndex < captureIndex);
	}
	assert.doesNotMatch(captureWorkflow, /--frontend-dist|--url/);
	assert.equal(tauriConfig.build.frontendDist, '../dist');
	assert.equal(tauriConfig.app.windows[0].useHttpsScheme, true);
});

test('native capture clears transient notifications without hiding errors', () => {
	assert.match(captureScript, /clearTransientNotifications/);
	assert.match(captureScript, /notifications\.hideToasts/);
	assert.match(captureScript, /visible error notification blocks native Agent capture/);
});

test('Windows native capture passes Tauri JSON config through a file', () => {
	const windowsJob = captureWorkflow.slice(captureWorkflow.indexOf('  windows-agent:'));
	assert.match(windowsJob, /Set-Content -LiteralPath \$buildConfig/);
	assert.match(windowsJob, /--config \$buildConfig/);
	assert.doesNotMatch(windowsJob, /--config '\{\"build\"/);
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
	assert.doesNotMatch(attestationWorkflow, /actions\/download-artifact@/);
	assert.doesNotMatch(attestationWorkflow, /run-id: \$\{\{ inputs\.capture_run_id \}\}/);
	assert.doesNotMatch(attestationWorkflow, /artifact-ids: \$\{\{ steps\.capture-run\.outputs\.artifact_ids \}\}/);
	const downloadStep = attestationWorkflow.slice(
		attestationWorkflow.indexOf('Download and verify native evidence archives'),
		attestationWorkflow.indexOf('Resolve immutable capture provenance')
	);
	assert.match(downloadStep, /GH_API_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
	assert.match(downloadStep, /MACOS_ARCHIVE_URL: \$\{\{ steps\.capture-run\.outputs\.macos_archive_url \}\}/);
	assert.match(downloadStep, /MACOS_ARCHIVE_DIGEST: \$\{\{ steps\.capture-run\.outputs\.macos_archive_digest \}\}/);
	assert.match(downloadStep, /WINDOWS_ARCHIVE_URL: \$\{\{ steps\.capture-run\.outputs\.windows_archive_url \}\}/);
	assert.match(downloadStep, /WINDOWS_ARCHIVE_DIGEST: \$\{\{ steps\.capture-run\.outputs\.windows_archive_digest \}\}/);
	assert.match(downloadStep, /sha256sum --check --strict -/);
	assert.match(downloadStep, /unzip -Z1 "\$archive"/);
	assert.match(downloadStep, /Unsafe native evidence archive entry/);
	assert.match(downloadStep, /https:\/\/api\.github\.com\/repos\/"\$GITHUB_REPOSITORY"\/actions\/artifacts\/\*\/zip/);
	assert.doesNotMatch(downloadStep, /https:\/\/api\.github\.com\/repos\/\*\/actions\/artifacts/);
	assert.match(downloadStep, /test ! -e "\$root\/\$name"/);
	assert.match(downloadStep, /test ! -L "\$root\/\$name\/workbench-evidence\.json"/);
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
	const downloadIndex = attestationWorkflow.indexOf('Download and verify native evidence archives');
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
	const digestIndex = attestationWorkflow.indexOf('sha256sum --check --strict -');
	const extractIndex = attestationWorkflow.indexOf('unzip -q "$archive" -d');
	assert.ok(digestIndex >= 0 && extractIndex >= 0 && digestIndex < extractIndex);
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
