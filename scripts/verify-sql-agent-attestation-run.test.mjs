import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyAttestationRunMetadata } from './verify-sql-agent-attestation-run.mjs';

const repository = 'baicie/nyala-studio';
const runId = '223456789';
const sourceRevision = 'a'.repeat(40);
const sourceRef = 'refs/heads/mvp';

function createRunMetadata() {
	return {
		id: Number(runId),
		name: 'SQL Agent Checkpoint W Attestation',
		workflow_id: 1234567,
		head_branch: 'mvp',
		head_sha: sourceRevision,
		path: '.github/workflows/sql-agent-checkpoint-w-attest.yml',
		event: 'workflow_dispatch',
		status: 'completed',
		conclusion: 'success',
		run_attempt: 1,
		created_at: '2026-08-16T02:45:00.000Z',
		run_started_at: '2026-08-16T03:00:00.000Z',
		updated_at: '2026-08-16T04:00:00.000Z',
		html_url: `https://github.com/${repository}/actions/runs/${runId}`,
		artifacts_url: `https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts`,
		repository: { full_name: repository },
		head_repository: { full_name: repository }
	};
}

function createArtifactMetadata() {
	return {
		total_count: 1,
		artifacts: [
			{
				id: 333,
				name: 'sql-agent-checkpoint-w',
				size_in_bytes: 8192,
				expired: false,
				digest: `sha256:${'b'.repeat(64)}`,
				created_at: '2026-08-16T03:45:00.000Z',
				updated_at: '2026-08-16T03:46:00.000Z',
				expires_at: '2026-08-30T03:45:00.000Z',
				archive_download_url: `https://api.github.com/repos/${repository}/actions/artifacts/333/zip`,
				workflow_run: {
					id: Number(runId),
					head_branch: 'mvp',
					head_sha: sourceRevision
				}
			}
		]
	};
}

function verify(overrides = {}) {
	return verifyAttestationRunMetadata({
		runMetadata: createRunMetadata(),
		artifactMetadata: createArtifactMetadata(),
		expectedRepository: repository,
		expectedRunId: runId,
		expectedRevision: sourceRevision,
		expectedRef: sourceRef,
		now: new Date('2026-08-16T05:00:00.000Z'),
		...overrides
	});
}

test('verifies the protected Checkpoint W attestation run and aggregate artifact', () => {
	const report = verify();

	assert.equal(report.status, 'verified');
	assert.deepEqual(report.provenance, {
		repository,
		sourceRevision,
		sourceRef,
		workflowRunId: runId,
		workflowRunAttempt: 1
	});
	assert.equal(report.workflow.path, '.github/workflows/sql-agent-checkpoint-w-attest.yml');
	assert.equal(report.run.createdAt, '2026-08-16T02:45:00.000Z');
	assert.deepEqual(report.artifactIds, ['333']);
	assert.equal(report.artifacts[0].expired, false);
	assert.equal(report.artifacts[0].expiresAt, '2026-08-30T03:45:00.000Z');
	assert.equal(report.artifacts[0].archiveUrl, `https://api.github.com/repos/${repository}/actions/artifacts/333/zip`);
	assert.deepEqual(report.reasons, []);
});

test('rejects another workflow, revision, or ref even when its artifact name matches', () => {
	const runMetadata = createRunMetadata();
	runMetadata.path = '.github/workflows/forged.yml';
	runMetadata.head_sha = 'c'.repeat(40);
	runMetadata.head_branch = 'feature/untrusted-gate';
	const report = verify({ runMetadata });

	assert.equal(report.status, 'blocked');
	assert.match(report.reasons.join('\n'), /workflow path/i);
	assert.match(report.reasons.join('\n'), /release revision/i);
	assert.match(report.reasons.join('\n'), /protected source ref/i);
});

test('rejects a failed run and an extra aggregate artifact', () => {
	const runMetadata = createRunMetadata();
	runMetadata.conclusion = 'failure';
	const artifactMetadata = createArtifactMetadata();
	artifactMetadata.total_count = 2;
	artifactMetadata.artifacts.push({ ...artifactMetadata.artifacts[0], id: 334 });
	const report = verify({ runMetadata, artifactMetadata });

	assert.equal(report.status, 'blocked');
	assert.match(report.reasons.join('\n'), /conclusion.*success/i);
	assert.match(report.reasons.join('\n'), /exactly 1 artifact/i);
});

test('rejects expired, digest-free, or temporally impossible aggregate artifacts', () => {
	const artifactMetadata = createArtifactMetadata();
	const artifact = artifactMetadata.artifacts[0];
	artifact.expired = true;
	delete artifact.digest;
	artifact.created_at = '2026-08-16T02:00:00.000Z';
	artifact.expires_at = '2026-08-16T04:30:00.000Z';
	const report = verify({ artifactMetadata });

	assert.equal(report.status, 'blocked');
	assert.match(report.reasons.join('\n'), /expired/i);
	assert.match(report.reasons.join('\n'), /digest/i);
	assert.match(report.reasons.join('\n'), /timestamps|created/i);
});

test('rejects an attestation run whose creation time is missing or after it started', () => {
	const runMetadata = createRunMetadata();
	runMetadata.created_at = '2026-08-16T03:00:01.000Z';
	const report = verify({ runMetadata });

	assert.equal(report.status, 'blocked');
	assert.match(report.reasons.join('\n'), /creation timestamp/i);
});

test('verifies a separately named protected attestation workflow and artifact contract', () => {
	const runMetadata = createRunMetadata();
	runMetadata.name = 'SQL Result Grid Z1 Gate Attestation';
	runMetadata.path = '.github/workflows/sql-result-grid-gate-attest.yml';
	const artifactMetadata = createArtifactMetadata();
	artifactMetadata.artifacts[0].name = 'sql-result-grid-gate-attestation';
	const report = verify({
		runMetadata,
		artifactMetadata,
		expectedWorkflow: {
			name: 'SQL Result Grid Z1 Gate Attestation',
			path: '.github/workflows/sql-result-grid-gate-attest.yml',
			event: 'workflow_dispatch'
		},
		expectedArtifactName: 'sql-result-grid-gate-attestation'
	});

	assert.equal(report.status, 'verified');
	assert.equal(report.artifacts[0].name, 'sql-result-grid-gate-attestation');
});
