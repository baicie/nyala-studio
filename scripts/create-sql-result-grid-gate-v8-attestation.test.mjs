import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const scriptPath = new URL('./create-sql-result-grid-gate-v8-attestation.mjs', import.meta.url).pathname;
const repository = 'baicie/nyala-studio';
const sourceRevision = 'a'.repeat(40);
const sourceRef = 'refs/heads/mvp';

test('v8 attestation records exact gate and platform evidence digests', async () => {
	await withFixture(async ({ root, gatePath, evidencePath, outputPath, gate, evidence, evidenceBytes }) => {
		await writeFile(gatePath, JSON.stringify(gate, null, 2));
		await writeFile(evidencePath, evidenceBytes);
		await execFileAsync(process.execPath, [
			scriptPath,
			'--gate',
			gatePath,
			'--platform-evidence',
			evidencePath,
			'--output',
			outputPath,
			'--repository',
			repository,
			'--source-revision',
			sourceRevision,
			'--source-ref',
			sourceRef,
			'--platform-workflow-run-id',
			'100',
			'--platform-workflow-run-attempt',
			'1',
			'--attestation-workflow-run-id',
			'101',
			'--attestation-workflow-run-attempt',
			'1',
			'--attestation-workflow-run-url',
			`https://github.com/${repository}/actions/runs/101`
		]);
		const report = JSON.parse(await readFile(outputPath, 'utf8'));
		assert.equal(report.status, 'recorded');
		assert.equal(report.inputDigests.platformEvidence, sha256(evidenceBytes));
		assert.equal(report.gateDecision, 'GO');
	});
});

test('v8 attestation rejects evidence from another workflow revision', async () => {
	await withFixture(async ({ root, gatePath, evidencePath, outputPath, gate, evidenceBytes }) => {
		const evidence = JSON.parse(evidenceBytes);
		evidence.windowsWebView2.provenance.sourceRevision = 'b'.repeat(40);
		await writeFile(gatePath, JSON.stringify(gate));
		await writeFile(evidencePath, JSON.stringify(evidence));
		await assert.rejects(
			execFileAsync(process.execPath, [
				scriptPath,
				'--gate',
				gatePath,
				'--platform-evidence',
				evidencePath,
				'--output',
				outputPath,
				'--repository',
				repository,
				'--source-revision',
				sourceRevision,
				'--source-ref',
				sourceRef,
				'--platform-workflow-run-id',
				'100',
				'--platform-workflow-run-attempt',
				'1',
				'--attestation-workflow-run-id',
				'101',
				'--attestation-workflow-run-attempt',
				'1',
				'--attestation-workflow-run-url',
				`https://github.com/${repository}/actions/runs/101`
			])
		);
		const report = JSON.parse(await readFile(outputPath, 'utf8'));
		assert.equal(report.status, 'blocked');
		assert.match(report.reasons.join('\n'), /sourceRevision/);
	});
});

async function withFixture(run) {
	const root = await mkdtemp(join(tmpdir(), 'nyala-z1-v8-attestation-test-'));
	try {
		const evidence = createEvidence();
		const evidenceBytes = Buffer.from(JSON.stringify(evidence, null, 2));
		const gate = {
			version: 1,
			gateContract: 'z1-v8-frame-aware',
			measurementContractVersion: 8,
			decision: 'GO',
			inputSha256: sha256(evidenceBytes)
		};
		await run({
			root,
			gatePath: join(root, 'gate.json'),
			evidencePath: join(root, 'platform-evidence.json'),
			outputPath: join(root, 'attestation.json'),
			gate,
			evidence,
			evidenceBytes
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function createEvidence() {
	const base = {
		repository,
		sourceRevision,
		sourceRef,
		workflowRunId: '100',
		workflowRunAttempt: 1,
		binarySha256: 'b'.repeat(64),
		zeusBundleSha256: 'c'.repeat(64),
		workbenchTableBundleSha256: 'd'.repeat(64)
	};
	return {
		macosWebKit: platform('macOS WebKit', base),
		windowsWebView2: platform('Windows WebView2', base)
	};
}

function platform(label, provenance) {
	return {
		version: 3,
		measurementContractVersion: 8,
		status: 'ready',
		label,
		provenance: { ...provenance }
	};
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}
