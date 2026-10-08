import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { verifyCaptureRunMetadata } from './verify-sql-agent-capture-run.mjs';

const execFileAsync = promisify(execFile);
const repository = 'baicie/nyala-studio';
const runId = '123456789';
const sourceRevision = 'a'.repeat(40);

function createRunMetadata() {
	return {
		id: Number(runId),
		name: 'SQL Agent Native Workbench Capture',
		workflow_id: 987654,
		head_branch: 'mvp',
		head_sha: sourceRevision,
		path: '.github/workflows/sql-agent-native.yml',
		event: 'workflow_dispatch',
		status: 'completed',
		conclusion: 'success',
		run_attempt: 2,
		run_started_at: '2026-08-16T01:00:00.000Z',
		updated_at: '2026-08-16T02:00:00.000Z',
		html_url: `https://github.com/${repository}/actions/runs/${runId}`,
		artifacts_url: `https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts`,
		repository: { full_name: repository },
		head_repository: { full_name: repository }
	};
}

function createArtifactMetadata() {
	return {
		total_count: 2,
		artifacts: [
			createArtifact(111, 'sql-agent-native-macos', 'b'.repeat(64)),
			createArtifact(222, 'sql-agent-native-windows', 'c'.repeat(64))
		]
	};
}

function createArtifact(id, name, digest) {
	return {
		id,
		name,
		size_in_bytes: 4096,
		expired: false,
		digest: `sha256:${digest}`,
		created_at: '2026-08-16T01:30:00.000Z',
		updated_at: '2026-08-16T01:31:00.000Z',
		archive_download_url: `https://api.github.com/repos/${repository}/actions/artifacts/${id}/zip`,
		workflow_run: {
			id: Number(runId),
			head_branch: 'mvp',
			head_sha: sourceRevision
		}
	};
}

test('verifies an immutable SQL Agent native capture run and its exact artifacts', () => {
	const report = verifyCaptureRunMetadata({
		runMetadata: createRunMetadata(),
		artifactMetadata: createArtifactMetadata(),
		expectedRepository: repository,
		expectedRunId: runId
	});

	assert.equal(report.status, 'verified');
	assert.deepEqual(report.provenance, {
		repository,
		sourceRevision,
		sourceRef: 'refs/heads/mvp',
		workflowRunId: runId,
		workflowRunAttempt: 2
	});
	assert.equal(report.workflow.path, '.github/workflows/sql-agent-native.yml');
	assert.equal(report.artifacts.length, 2);
	assert.deepEqual(
		report.artifacts.map(artifact => artifact.id),
		['111', '222']
	);
	assert.deepEqual(
		report.artifacts.map(artifact => artifact.archiveUrl),
		[
			`https://api.github.com/repos/${repository}/actions/artifacts/111/zip`,
			`https://api.github.com/repos/${repository}/actions/artifacts/222/zip`
		]
	);
	assert.deepEqual(report.artifactIds, ['111', '222']);
	assert.deepEqual(report.reasons, []);
});

test('accepts GitHub API UTC timestamps without milliseconds', () => {
	const runMetadata = createRunMetadata();
	runMetadata.run_started_at = '2026-08-16T01:00:00Z';
	runMetadata.updated_at = '2026-08-16T02:00:00Z';
	const artifactMetadata = createArtifactMetadata();
	for (const artifact of artifactMetadata.artifacts) {
		artifact.created_at = '2026-08-16T01:30:00Z';
		artifact.updated_at = '2026-08-16T01:31:00Z';
	}
	const report = verifyCaptureRunMetadata({
		runMetadata,
		artifactMetadata,
		expectedRepository: repository,
		expectedRunId: runId
	});
	assert.equal(report.status, 'verified');
});

test('rejects non-UTC or non-canonical capture timestamps', () => {
	const runMetadata = createRunMetadata();
	runMetadata.run_started_at = '2026-08-16T01:00:00+00:00';
	const report = verifyCaptureRunMetadata({
		runMetadata,
		artifactMetadata: createArtifactMetadata(),
		expectedRepository: repository,
		expectedRunId: runId
	});
	assert.equal(report.status, 'blocked');
	assert.match(report.reasons.join('\n'), /capture run timestamps are invalid/i);
});

test('rejects a run from another workflow even when its artifact names match', () => {
	const runMetadata = createRunMetadata();
	runMetadata.path = '.github/workflows/forged.yml';
	const report = verifyCaptureRunMetadata({
		runMetadata,
		artifactMetadata: createArtifactMetadata(),
		expectedRepository: repository,
		expectedRunId: runId
	});
	assert.equal(report.status, 'blocked');
	assert.match(report.reasons.join('\n'), /workflow path/i);
});

test('rejects failed capture runs and head revision mismatches', () => {
	const runMetadata = createRunMetadata();
	runMetadata.conclusion = 'failure';
	const artifactMetadata = createArtifactMetadata();
	artifactMetadata.artifacts[0].workflow_run.head_sha = 'd'.repeat(40);
	const report = verifyCaptureRunMetadata({
		runMetadata,
		artifactMetadata,
		expectedRepository: repository,
		expectedRunId: runId
	});
	assert.equal(report.status, 'blocked');
	assert.match(report.reasons.join('\n'), /conclusion.*success/i);
	assert.match(report.reasons.join('\n'), /head SHA/i);
});

test('rejects extra, duplicate, expired, or digest-free native artifacts', () => {
	const artifactMetadata = createArtifactMetadata();
	artifactMetadata.total_count = 3;
	artifactMetadata.artifacts.push(createArtifact(333, 'sql-agent-native-macos', 'd'.repeat(64)));
	artifactMetadata.artifacts[0].expired = true;
	delete artifactMetadata.artifacts[1].digest;
	const report = verifyCaptureRunMetadata({
		runMetadata: createRunMetadata(),
		artifactMetadata,
		expectedRepository: repository,
		expectedRunId: runId
	});
	assert.equal(report.status, 'blocked');
	assert.match(report.reasons.join('\n'), /exactly 2 artifacts/i);
	assert.match(report.reasons.join('\n'), /duplicate artifact name/i);
	assert.match(report.reasons.join('\n'), /expired/i);
	assert.match(report.reasons.join('\n'), /digest/i);
});

test('rejects artifacts whose archive download URL is forged or retargeted', () => {
	for (const archive_download_url of [
		`https://api.github.com/repos/attacker/nyala-studio/actions/artifacts/111/zip`,
		`https://api.github.com/repos/${repository}/actions/artifacts/222/zip`,
		`https://api.github.com/repos/${repository}/actions/artifacts/111/zip?forged=1`,
		'https://example.com/repos/baicie/nyala-studio/actions/artifacts/111/zip'
	]) {
		const artifactMetadata = createArtifactMetadata();
		artifactMetadata.artifacts[0].archive_download_url = archive_download_url;
		const report = verifyCaptureRunMetadata({
			runMetadata: createRunMetadata(),
			artifactMetadata,
			expectedRepository: repository,
			expectedRunId: runId
		});
		assert.equal(report.status, 'blocked');
		assert.match(report.reasons.join('\n'), /artifact 0 archive URL is invalid/i);
		assert.equal(report.artifacts.find(artifact => artifact.id === '111')?.archiveUrl, null);
	}
});

test('publishes verified platform archive URLs and digests to the workflow output', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-capture-run-output-'));
	try {
		const runMetadataPath = join(root, 'capture-run-api.json');
		const artifactMetadataPath = join(root, 'capture-artifacts-api.json');
		const outputPath = join(root, 'capture-run.json');
		const githubOutputPath = join(root, 'github-output.txt');
		await Promise.all([
			writeFile(runMetadataPath, `${JSON.stringify(createRunMetadata(), null, 2)}\n`, 'utf8'),
			writeFile(artifactMetadataPath, `${JSON.stringify(createArtifactMetadata(), null, 2)}\n`, 'utf8')
		]);
		await execFileAsync(process.execPath, [
			'scripts/verify-sql-agent-capture-run.mjs',
			'--run-metadata',
			runMetadataPath,
			'--artifact-metadata',
			artifactMetadataPath,
			'--output',
			outputPath,
			'--expected-repository',
			repository,
			'--expected-run-id',
			runId,
			'--github-output',
			githubOutputPath
		]);
		const githubOutput = await readFile(githubOutputPath, 'utf8');
		const expectedLines = [
			'artifact_ids=111,222',
			`source_revision=${sourceRevision}`,
			'source_ref=refs/heads/mvp',
			'capture_run_attempt=2',
			`macos_archive_url=https://api.github.com/repos/${repository}/actions/artifacts/111/zip`,
			`macos_archive_digest=${'b'.repeat(64)}`,
			`windows_archive_url=https://api.github.com/repos/${repository}/actions/artifacts/222/zip`,
			`windows_archive_digest=${'c'.repeat(64)}`
		];
		for (const line of expectedLines) {
			assert.ok(githubOutput.split('\n').includes(line), `expected workflow output line: ${line}`);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
