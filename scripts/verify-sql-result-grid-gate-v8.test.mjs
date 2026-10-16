import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
	FRAME_AWARE_BOUNDARY_VERSION,
	FRAME_AWARE_CORRELATION,
	FRAME_AWARE_MEASUREMENT_CONTRACT_VERSION,
	createFrameAwareContractMetadata
} from './sql-result-grid-frame-aware-contract.mjs';

const execFileAsync = promisify(execFile);
const verifierPath = new URL('./verify-sql-result-grid-gate-v8.mjs', import.meta.url).pathname;
const repository = 'baicie/nyala-studio';
const sourceRevision = 'a'.repeat(40);
const sourceRef = 'refs/heads/mvp';
const workflowRunId = '123456789';
const provenanceEnv = {
	NYALA_EXPECTED_REPOSITORY: repository,
	NYALA_EXPECTED_SOURCE_REVISION: sourceRevision,
	NYALA_EXPECTED_SOURCE_REF: sourceRef,
	NYALA_EXPECTED_WORKFLOW_RUN_ID: workflowRunId,
	NYALA_EXPECTED_WORKFLOW_RUN_ATTEMPT: '1'
};

test('v8 verifier accepts revision-bound same-execution evidence', async () => {
	await withScenario(async ({ root, evidencePath, outputPath, evidence }) => {
		await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`);
		const { stdout } = await execFileAsync(process.execPath, [verifierPath, evidencePath, outputPath], {
			env: { ...process.env, ...provenanceEnv }
		});
		assert.match(stdout, /GO:/);
		const report = JSON.parse(await readFile(outputPath, 'utf8'));
		assert.equal(report.decision, 'GO');
		assert.equal(report.measurementContractVersion, FRAME_AWARE_MEASUREMENT_CONTRACT_VERSION);
		assert.ok(report.checks.every(check => check.passed));
	});
});

test('v8 verifier fails closed for diagnostic or recovered evidence even when grade is forged true', async () => {
	await withScenario(async ({ evidencePath, outputPath, evidence }) => {
		evidence.windowsWebView2.appRestarts = [{ previousGeneration: 1, nextGeneration: 2 }];
		evidence.windowsWebView2.admissionGrade = true;
		evidence.windowsWebView2.admission.grade = true;
		await runRejected(evidencePath, outputPath, evidence);
		const report = JSON.parse(await readFile(outputPath, 'utf8'));
		assert.match(report.reasons.join('\n'), /appRestarts.*empty/i);
	});
});

test('v8 verifier rejects retried rounds as non-admission evidence', async () => {
	await withScenario(async ({ evidencePath, outputPath, evidence }) => {
		evidence.windowsWebView2.retriedRounds = [{ workloadId: '10k-x-50', attempt: 2 }];
		await runRejected(evidencePath, outputPath, evidence);
		const report = JSON.parse(await readFile(outputPath, 'utf8'));
		assert.match(report.reasons.join('\n'), /retriedRounds.*empty/i);
	});
});

test('v8 verifier rejects top-level diagnostic and recovery markers', async () => {
	await withScenario(async ({ evidencePath, outputPath, evidence }) => {
		evidence.macosWebKit.diagnostic = true;
		evidence.macosWebKit.recoveryProbe = true;
		await runRejected(evidencePath, outputPath, evidence);
		const report = JSON.parse(await readFile(outputPath, 'utf8'));
		assert.match(report.reasons.join('\n'), /diagnostic-only|recoveryProbe/i);
	});
});

test('v8 verifier rejects the frozen v7 contract instead of dispatching by shape', async () => {
	await withScenario(async ({ evidencePath, outputPath, evidence }) => {
		evidence.macosWebKit.measurementContractVersion = 7;
		await runRejected(evidencePath, outputPath, evidence);
		const report = JSON.parse(await readFile(outputPath, 'utf8'));
		assert.match(report.reasons.join('\n'), /measurement contract 8/i);
	});
});

test('v8 verifier recomputes raw renderer work and rejects a forged summary', async () => {
	await withScenario(async ({ evidencePath, outputPath, evidence }) => {
		evidence.macosWebKit.summary['10k-x-50/zeus'].rendererWorkP50Ms.median = 0;
		await runRejected(evidencePath, outputPath, evidence);
		const report = JSON.parse(await readFile(outputPath, 'utf8'));
		assert.match(report.reasons.join('\n'), /summary.*does not match raw samples/i);
	});
});

test('v8 verifier rejects asymmetric renderer operation boundaries and provenance drift', async () => {
	await withScenario(async ({ evidencePath, outputPath, evidence }) => {
		const record = evidence.macosWebKit.records.find(
			candidate => candidate.workloadId === '10k-x-50' && candidate.renderer === 'zeus'
		);
		record.scroll.samples[0].sameExecution.rendererOperation.boundaryVersion = 'commit-only-v1';
		evidence.windowsWebView2.provenance.sourceRevision = 'b'.repeat(40);
		await runRejected(evidencePath, outputPath, evidence);
		const report = JSON.parse(await readFile(outputPath, 'utf8'));
		assert.match(report.reasons.join('\n'), /symmetric boundary|provenance mismatch/i);
	});
});

test('v8 verifier aggregates repeated records while preserving renderer pairing', async () => {
	await withScenario(
		async ({ evidencePath, outputPath, evidence }) => {
			await runAccepted(evidencePath, outputPath, evidence);
			const report = JSON.parse(await readFile(outputPath, 'utf8'));
			assert.equal(report.decision, 'GO');
			assert.equal(report.platformEvidence.macosWebKit.summary['10k-x-50/zeus'].count, 40);
		},
		{ repeat: 2 }
	);
});

async function runRejected(evidencePath, outputPath, evidence) {
	await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`);
	await assert.rejects(
		execFileAsync(process.execPath, [verifierPath, evidencePath, outputPath], {
			env: { ...process.env, ...provenanceEnv }
		})
	);
}

async function runAccepted(evidencePath, outputPath, evidence) {
	await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`);
	await execFileAsync(process.execPath, [verifierPath, evidencePath, outputPath], {
		env: { ...process.env, ...provenanceEnv }
	});
}

async function withScenario(run, options = {}) {
	const root = await mkdtemp(join(tmpdir(), 'nyala-z1-v8-gate-test-'));
	try {
		const evidencePath = join(root, 'platform-evidence-v8.json');
		const outputPath = join(root, 'phase-z1-gate-v8.json');
		await run({ root, evidencePath, outputPath, evidence: createEvidence(options) });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function createEvidence(options = {}) {
	const bundle = 'c'.repeat(64);
	const common = {
		repository,
		sourceRevision,
		sourceRef,
		workflowRunId,
		workflowRunAttempt: 1,
		binarySha256: 'b'.repeat(64),
		zeusBundleSha256: bundle,
		workbenchTableBundleSha256: 'd'.repeat(64)
	};
	return {
		version: 1,
		macosWebKit: createPlatformEvidence('macos', 'macOS WebKit', common, bundle, options.repeat ?? 1),
		windowsWebView2: createPlatformEvidence('windows', 'Windows WebView2', common, bundle, options.repeat ?? 1)
	};
}

function createPlatformEvidence(platformName, label, provenance, bundle, repeat = 1) {
	const records = [];
	for (const workloadId of ['1k-x-20', '10k-x-50']) {
		for (const renderer of ['workbench-table', 'zeus']) {
			for (let iteration = 1; iteration <= repeat; iteration += 1) {
				const workMs = workloadId === '10k-x-50' ? (renderer === 'zeus' ? 7 : 10) : renderer === 'zeus' ? 4.1 : 4;
				const totalMs = 20;
				const pairId = `${platformName}-${workloadId}-pair-${iteration}`;
				const samples = Array.from({ length: 20 }, (_, sampleIndex) => ({
					sampleIndex,
					committed: true,
					totalMs,
					sameExecution: {
						phase: 'sample',
						pairSampleId: `${pairId}-sample-${sampleIndex}`,
						rendererOperation: {
							phase: 'sample',
							sampleIndex,
							boundaryVersion: FRAME_AWARE_BOUNDARY_VERSION,
							startTime: sampleIndex * 100,
							endTime: sampleIndex * 100 + workMs,
							durationMs: workMs,
							commitTransactionIds: [sampleIndex + 1]
						}
					}
				}));
				records.push({
					status: 'ok',
					measurementContractVersion: FRAME_AWARE_MEASUREMENT_CONTRACT_VERSION,
					workloadId,
					renderer,
					pairId,
					iteration: 1,
					runToken: fixtureRunToken(platformName, workloadId, renderer, iteration),
					sessionGeneration: 1,
					bundleSha256: renderer === 'zeus' ? provenance.zeusBundleSha256 : provenance.workbenchTableBundleSha256,
					provenance: { ...provenance },
					scroll: { samples }
				});
			}
		}
	}
	const summaryGroups = new Map();
	for (const record of records) {
		const key = `${record.workloadId}/${record.renderer}`;
		const group = summaryGroups.get(key) ?? { work: [], totals: [] };
		group.work.push(...record.scroll.samples.map(sample => sample.sameExecution.rendererOperation.durationMs));
		group.totals.push(...record.scroll.samples.map(sample => sample.totalMs));
		summaryGroups.set(key, group);
	}
	const summary = Object.fromEntries(
		[...summaryGroups.entries()].map(([key, group]) => [
			key,
			{
				count: group.work.length,
				rendererWorkP50Ms: summarize(group.work),
				rendererWorkP95Ms: summarize(group.work),
				scrollP95Ms: summarize(group.totals)
			}
		])
	);
	return {
		version: 3,
		measurementContractVersion: FRAME_AWARE_MEASUREMENT_CONTRACT_VERSION,
		label,
		status: 'ready',
		runs: 5,
		platformName,
		admissionGrade: true,
		admission: {
			grade: true,
			mode: 'same-execution',
			correlation: FRAME_AWARE_CORRELATION,
			reasons: []
		},
		frameAwareContract: createFrameAwareContractMetadata(),
		frameAwareCalibration: {
			version: 1,
			passed: true,
			rendererWorkRelativeChange: 0.05,
			rendererWorkAbsoluteChangeMs: 0.25,
			totalRelativeChange: 0.03
		},
		provenance,
		records,
		summary
	};
}

function summarize(values) {
	const sorted = [...values].sort((left, right) => left - right);
	return {
		available: true,
		count: values.length,
		median: sorted[Math.floor(sorted.length / 2)],
		p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
		min: sorted[0],
		max: sorted.at(-1)
	};
}

function fixtureRunToken(platform, workloadId, renderer, iteration = 1) {
	const seed = `${platform}/${workloadId}/${renderer}/${iteration}`;
	const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
