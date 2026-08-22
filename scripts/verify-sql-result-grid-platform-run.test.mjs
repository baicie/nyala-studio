import assert from 'node:assert/strict';
import test from 'node:test';
import { verifySqlResultGridPlatformRunMetadata } from './verify-sql-result-grid-platform-run.mjs';

const repository = 'baicie/nyala-studio';
const runId = '323456789';
const sourceRevision = 'a'.repeat(40);
const sourceRef = 'refs/heads/mvp';
const now = new Date('2026-08-16T05:00:00.000Z');
const artifactNames = [
	'sql-result-grid-zeus-audit',
	'sql-result-grid-macos-webkit',
	'sql-result-grid-windows-webview2',
	'sql-result-grid-platform-gate'
];

function createRunMetadata() {
	return {
		id: Number(runId),
		name: 'SQL Result Grid Native WebView Evidence',
		workflow_id: 2345678,
		head_branch: 'mvp',
		head_sha: sourceRevision,
		path: '.github/workflows/sql-result-grid-platform.yml',
		event: 'workflow_dispatch',
		status: 'completed',
		conclusion: 'success',
		run_attempt: 2,
		created_at: '2026-08-16T00:45:00.000Z',
		run_started_at: '2026-08-16T01:00:00.000Z',
		updated_at: '2026-08-16T04:00:00.000Z',
		html_url: `https://github.com/${repository}/actions/runs/${runId}`,
		artifacts_url: `https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts`,
		repository: { full_name: repository },
		head_repository: { full_name: repository }
	};
}

function createArtifactMetadata() {
	return {
		total_count: 4,
		artifacts: artifactNames.map((name, index) => createArtifact(111 + index * 111, name, index))
	};
}

function createArtifact(id, name, digestIndex) {
	const aggregate = name === 'sql-result-grid-platform-gate';
	return {
		id,
		name,
		size_in_bytes: 4096 + digestIndex,
		expired: false,
		digest: `sha256:${String(digestIndex + 1).repeat(64)}`,
		created_at: aggregate ? '2026-08-16T03:45:00.000Z' : '2026-08-16T02:00:00.000Z',
		updated_at: aggregate ? '2026-08-16T03:46:00.000Z' : '2026-08-16T02:01:00.000Z',
		expires_at: '2026-08-30T03:45:00.000Z',
		archive_download_url: `https://api.github.com/repos/${repository}/actions/artifacts/${id}/zip`,
		workflow_run: {
			id: Number(runId),
			head_branch: 'mvp',
			head_sha: sourceRevision
		}
	};
}

function verify(overrides = {}) {
	return verifySqlResultGridPlatformRunMetadata({
		runMetadata: createRunMetadata(),
		artifactMetadata: createArtifactMetadata(),
		expectedRepository: repository,
		expectedRunId: runId,
		expectedRevision: sourceRevision,
		expectedRef: sourceRef,
		now,
		...overrides
	});
}

test('verifies one immutable result-grid platform run and its four exact artifacts', () => {
	const report = verify();

	assert.equal(report.status, 'verified');
	assert.equal(report.generatedAt, now.toISOString());
	assert.deepEqual(report.provenance, {
		repository,
		sourceRevision,
		sourceRef,
		workflowRunId: runId,
		workflowRunAttempt: 2
	});
	assert.equal(report.workflow.path, '.github/workflows/sql-result-grid-platform.yml');
	assert.deepEqual(
		report.artifacts.map(artifact => artifact.name),
		artifactNames
	);
	assert.equal(report.aggregateArtifactId, '444');
	assert.equal(report.aggregateArtifactDigest, '4'.repeat(64));
	assert.equal(report.aggregateArtifactUrl, `https://api.github.com/repos/${repository}/actions/artifacts/444/zip`);
	assert.deepEqual(report.reasons, []);
});

test('rejects a different repository, run, or workflow even when artifact names match', () => {
	const runMetadata = createRunMetadata();
	runMetadata.id += 1;
	runMetadata.repository.full_name = 'other/nyala-studio';
	runMetadata.head_repository.full_name = 'fork/nyala-studio';
	runMetadata.name = 'Forged Result Grid Evidence';
	runMetadata.path = '.github/workflows/forged.yml';
	runMetadata.event = 'push';
	const report = verify({ runMetadata });

	assert.equal(report.status, 'blocked');
	assert.match(report.reasons.join('\n'), /run id/i);
	assert.match(report.reasons.join('\n'), /run repository/i);
	assert.match(report.reasons.join('\n'), /head repository/i);
	assert.match(report.reasons.join('\n'), /workflow name/i);
	assert.match(report.reasons.join('\n'), /workflow path/i);
	assert.match(report.reasons.join('\n'), /workflow event/i);
});

test('rejects an incomplete run or provenance outside the requested revision and ref', () => {
	const runMetadata = createRunMetadata();
	runMetadata.workflow_id = 0;
	runMetadata.status = 'in_progress';
	runMetadata.conclusion = 'failure';
	runMetadata.head_sha = 'b'.repeat(40);
	runMetadata.head_branch = 'feature/untrusted-grid';
	runMetadata.run_attempt = 0;
	runMetadata.run_started_at = '2026-08-16T04:00:00.000Z';
	runMetadata.updated_at = '2026-08-16T03:00:00.000Z';
	runMetadata.html_url = 'https://example.test/forged';
	runMetadata.artifacts_url = 'https://example.test/forged-artifacts';
	const report = verify({ runMetadata });

	assert.equal(report.status, 'blocked');
	assert.match(report.reasons.join('\n'), /workflow id/i);
	assert.match(report.reasons.join('\n'), /status.*completed/i);
	assert.match(report.reasons.join('\n'), /conclusion.*success/i);
	assert.match(report.reasons.join('\n'), /release revision/i);
	assert.match(report.reasons.join('\n'), /source ref/i);
	assert.match(report.reasons.join('\n'), /attempt/i);
	assert.match(report.reasons.join('\n'), /timestamps/i);
	assert.match(report.reasons.join('\n'), /HTML URL/i);
	assert.match(report.reasons.join('\n'), /artifacts URL/i);
});

test('rejects missing, duplicate, expired, digest-free, or temporally impossible artifacts', () => {
	const artifactMetadata = createArtifactMetadata();
	artifactMetadata.total_count = 5;
	artifactMetadata.artifacts.push(createArtifact(555, 'sql-result-grid-platform-gate', 4));
	artifactMetadata.artifacts[0].expired = true;
	delete artifactMetadata.artifacts[1].digest;
	artifactMetadata.artifacts[2].created_at = '2026-08-16T00:30:00.000Z';
	artifactMetadata.artifacts[3].expires_at = '2026-08-16T04:30:00.000Z';
	const report = verify({ artifactMetadata });

	assert.equal(report.status, 'blocked');
	assert.match(report.reasons.join('\n'), /exactly 4 artifacts/i);
	assert.match(report.reasons.join('\n'), /duplicate artifact name/i);
	assert.match(report.reasons.join('\n'), /expired/i);
	assert.match(report.reasons.join('\n'), /digest/i);
	assert.match(report.reasons.join('\n'), /timestamps|retention/i);
});
