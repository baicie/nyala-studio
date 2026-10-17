import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

async function runVerifier({ gate, revision = 'f'.repeat(40) } = {}) {
	const root = await mkdtemp(join(tmpdir(), 'nyala-native-release-test-'));
	try {
		const gatePath = join(root, 'phase-a4-checkpoint-w.json');
		const outputPath = join(root, 'phase-native-release-gate.json');
		await writeFile(gatePath, `${JSON.stringify(gate ?? createGate(revision))}\n`, 'utf8');
		const result = await execFileAsync(process.execPath, ['scripts/verify-sql-native-release.mjs', outputPath], {
			cwd: new URL('..', import.meta.url),
			env: {
				...process.env,
				NYALA_EXPECTED_SOURCE_REVISION: revision,
				NYALA_A4_CHECKPOINT_W_GATE: gatePath
			}
		}).catch(error => error);
		const report = JSON.parse(await readFile(outputPath, 'utf8'));
		return { result, report };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test('native-only release gate stays fail-closed until Checkpoint W is GO', async () => {
	const { result, report } = await runVerifier({ gate: createGate('f'.repeat(40), 'NO-GO') });
	assert.equal(result.code, 1);
	assert.equal(report.decision, 'NO-GO');
	assert.equal(report.checks.find(check => check.id === 'a4-checkpoint-w')?.passed, false);
	assert.match(report.blockers.join('\n'), /Checkpoint W/);
});

test('native-only release gate requires the complete Checkpoint W check set', async () => {
	const gate = createGate('f'.repeat(40));
	gate.checks = [{ id: 'manual-attestation', passed: true, reason: 'fixture' }];
	const { result, report } = await runVerifier({ gate });
	assert.equal(result.code, 1);
	assert.equal(report.decision, 'NO-GO');
	assert.equal(report.checks.find(check => check.id === 'a4-checkpoint-w')?.passed, false);
	assert.match(report.blockers.join('\n'), /required Checkpoint W checks are missing or duplicated/);
});

test('native-only release gate does not require Zeus production dependency', async () => {
	const { report } = await runVerifier();
	assert.equal(report.checks.find(check => check.id === 'zeus-production-dependency-absent')?.passed, true);
	assert.equal(report.inputs.zeusPolicy, 'deferred');
});

test('native-only release gate checks the existing native renderer contract', async () => {
	const { report } = await runVerifier();
	assert.equal(report.checks.find(check => check.id === 'native-result-default')?.passed, true);
	assert.equal(report.checks.find(check => check.id === 'native-renderer-contract')?.passed, true);
});

function createGate(sourceRevision, decision = 'GO') {
	return {
		version: 2,
		generatedAt: '2026-10-17T00:00:00.000Z',
		decision,
		sourceRevision,
		checks: [{ id: 'manual-attestation', passed: decision === 'GO', reason: 'fixture' }],
		blockers: decision === 'GO' ? [] : ['fixture blocker']
	};
}
