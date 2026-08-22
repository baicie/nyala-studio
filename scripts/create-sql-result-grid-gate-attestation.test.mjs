import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const script = new URL('./create-sql-result-grid-gate-attestation.mjs', import.meta.url).pathname;
const repository = 'baicie/nyala-studio';
const sourceRevision = 'a'.repeat(40);
const sourceRef = 'refs/heads/mvp';
const platformRunId = '323456789';
const attestationRunId = '423456789';

test('records a revision-bound Z1 gate attestation with every raw input digest', async () => {
	const scenario = await createScenario();
	try {
		await run(scenario);
		const report = JSON.parse(await readFile(scenario.paths.output, 'utf8'));

		assert.equal(report.version, 1);
		assert.equal(report.status, 'recorded');
		assert.equal(report.gateDecision, 'GO');
		assert.deepEqual(report.provenance, {
			repository,
			sourceRevision,
			sourceRef,
			platformWorkflowRunId: platformRunId,
			platformWorkflowRunAttempt: 2,
			attestationWorkflowRunId: attestationRunId,
			attestationWorkflowRunAttempt: 1,
			attestationWorkflowRunUrl: `https://github.com/${repository}/actions/runs/${attestationRunId}`
		});
		assert.deepEqual(report.inputDigests, scenario.expectedDigests);
		assert.equal(report.gateGeneratedAt, scenario.gate.generatedAt);
		assert.deepEqual(report.reasons, []);
	} finally {
		await scenario.dispose();
	}
});

test('records an integrity-verified NO-GO without turning it into a GO', async () => {
	const scenario = await createScenario({ gateDecision: 'NO-GO' });
	try {
		await run(scenario);
		const report = JSON.parse(await readFile(scenario.paths.output, 'utf8'));
		assert.equal(report.status, 'recorded');
		assert.equal(report.gateDecision, 'NO-GO');
	} finally {
		await scenario.dispose();
	}
});

test('fails closed when raw evidence or trusted platform provenance is changed', async () => {
	const scenario = await createScenario();
	try {
		scenario.platformEvidence.windowsWebView2.provenance.sourceRevision = 'b'.repeat(40);
		await writeFile(scenario.paths.platformEvidence, serialize(scenario.platformEvidence), 'utf8');
		await assert.rejects(run(scenario));
		const report = JSON.parse(await readFile(scenario.paths.output, 'utf8'));
		assert.equal(report.status, 'blocked');
		assert.match(report.reasons.join('\n'), /Windows WebView2.*provenance/i);
	} finally {
		await scenario.dispose();
	}
});

async function createScenario({ gateDecision = 'GO' } = {}) {
	const root = await mkdtemp(join(tmpdir(), 'nyala-z1-attestation-test-'));
	const paths = Object.fromEntries(
		['gate', 'benchmark', 'platformEvidence', 'zeusAudit', 'zeusBundle', 'platformRun', 'output'].map(name => [
			name,
			join(root, `${name}.${name === 'zeusBundle' ? 'js' : 'json'}`)
		])
	);
	const commonProvenance = {
		repository,
		sourceRevision,
		sourceRef,
		workflowRunId: platformRunId,
		workflowRunAttempt: 2
	};
	const bundle = Buffer.from('trusted Zeus spike bundle\n');
	const bundleSha256 = sha256(bundle);
	const benchmark = {
		version: 1,
		provenance: { ...commonProvenance, zeusBundleSha256: bundleSha256 }
	};
	const platformEvidence = {
		version: 1,
		macosWebKit: { provenance: { ...commonProvenance, zeusBundleSha256: bundleSha256 } },
		windowsWebView2: { provenance: { ...commonProvenance, zeusBundleSha256: bundleSha256 } }
	};
	const zeusAudit = {
		version: 1,
		status: 'ready',
		provenance: commonProvenance,
		bundle: {
			file: 'zeusBundle.js',
			bytes: bundle.byteLength,
			sha256: bundleSha256
		}
	};
	const benchmarkJson = serialize(benchmark);
	const gate = {
		version: 2,
		generatedAt: '2026-08-16T04:05:00.000Z',
		sourceRevision,
		decision: gateDecision,
		benchmark: { sha256: sha256(benchmarkJson), provenance: benchmark.provenance },
		dependencyCheck: {
			passed: true,
			bundleBytes: bundle.byteLength,
			bundleSha256,
			provenance: commonProvenance
		},
		platformEvidence
	};
	const platformRun = {
		version: 1,
		generatedAt: '2026-08-16T04:01:00.000Z',
		status: 'verified',
		workflow: {
			id: '2345678',
			name: 'SQL Result Grid Native WebView Evidence',
			path: '.github/workflows/sql-result-grid-platform.yml',
			event: 'workflow_dispatch'
		},
		run: {
			id: platformRunId,
			attempt: 2,
			status: 'completed',
			conclusion: 'success',
			headSha: sourceRevision,
			headBranch: 'mvp',
			createdAt: '2026-08-16T00:45:00.000Z',
			runStartedAt: '2026-08-16T01:00:00.000Z',
			updatedAt: '2026-08-16T04:00:00.000Z',
			htmlUrl: `https://github.com/${repository}/actions/runs/${platformRunId}`
		},
		provenance: commonProvenance,
		artifacts: [],
		aggregateArtifactId: '444',
		aggregateArtifactDigest: '4'.repeat(64),
		aggregateArtifactUrl: `https://api.github.com/repos/${repository}/actions/artifacts/444/zip`,
		reasons: []
	};
	const serialized = {
		gate: serialize(gate),
		benchmark: benchmarkJson,
		platformEvidence: serialize(platformEvidence),
		zeusAudit: serialize(zeusAudit),
		platformRun: serialize(platformRun)
	};
	await Promise.all([
		...Object.entries(serialized).map(([name, value]) => writeFile(paths[name], value, 'utf8')),
		writeFile(paths.zeusBundle, bundle)
	]);
	return {
		paths,
		gate,
		platformEvidence,
		expectedDigests: {
			gate: sha256(serialized.gate),
			benchmark: sha256(serialized.benchmark),
			platformEvidence: sha256(serialized.platformEvidence),
			zeusAudit: sha256(serialized.zeusAudit),
			zeusBundle: bundleSha256,
			platformRun: sha256(serialized.platformRun)
		},
		dispose: () => rm(root, { recursive: true, force: true })
	};
}

function run(scenario) {
	return execFileAsync(process.execPath, [
		script,
		'--output',
		scenario.paths.output,
		'--gate',
		scenario.paths.gate,
		'--benchmark',
		scenario.paths.benchmark,
		'--platform-evidence',
		scenario.paths.platformEvidence,
		'--zeus-audit',
		scenario.paths.zeusAudit,
		'--zeus-bundle',
		scenario.paths.zeusBundle,
		'--platform-run',
		scenario.paths.platformRun,
		'--attestation-workflow-run-id',
		attestationRunId,
		'--attestation-workflow-run-attempt',
		'1',
		'--attestation-workflow-run-url',
		`https://github.com/${repository}/actions/runs/${attestationRunId}`
	]);
}

function serialize(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}
