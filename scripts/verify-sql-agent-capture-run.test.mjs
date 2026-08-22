import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyCaptureRunMetadata } from './verify-sql-agent-capture-run.mjs';

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
	assert.deepEqual(report.artifactIds, ['111', '222']);
	assert.deepEqual(report.reasons, []);
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
