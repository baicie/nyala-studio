#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const expectedArtifactNames = [
	'sql-result-grid-zeus-audit',
	'sql-result-grid-macos-webkit',
	'sql-result-grid-windows-webview2',
	'sql-result-grid-platform-gate'
];
const aggregateArtifactName = 'sql-result-grid-platform-gate';
const expectedWorkflow = {
	name: 'SQL Result Grid Native WebView Evidence',
	path: '.github/workflows/sql-result-grid-platform.yml',
	event: 'workflow_dispatch'
};
const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (isMain) await runCli();

export function verifySqlResultGridPlatformRunMetadata({
	runMetadata,
	artifactMetadata,
	expectedRepository,
	expectedRunId,
	expectedRevision,
	expectedRef,
	now = new Date()
}) {
	const reasons = [];
	const repository = validRepository(expectedRepository) ? expectedRepository : undefined;
	const requestedRunId = normalizeId(expectedRunId);
	const releaseRevision = validGitRevision(expectedRevision) ? expectedRevision : undefined;
	const protectedRef = validSourceRef(expectedRef) ? expectedRef : undefined;
	const nowMs = normalizeNow(now);
	if (!repository) reasons.push('expected repository is invalid');
	if (!requestedRunId) reasons.push('expected platform run id is invalid');
	if (!releaseRevision) reasons.push('expected release revision is invalid');
	if (!protectedRef) reasons.push('expected source ref is invalid');
	if (!Number.isFinite(nowMs)) reasons.push('verification time is invalid');

	const actualRunId = normalizeId(runMetadata?.id);
	const workflowId = normalizeId(runMetadata?.workflow_id);
	const sourceRevision = validGitRevision(runMetadata?.head_sha) ? runMetadata.head_sha : undefined;
	const headBranch = validRefName(runMetadata?.head_branch) ? runMetadata.head_branch : undefined;
	const sourceRef = headBranch ? `refs/heads/${headBranch}` : undefined;
	const workflowRunAttempt = positiveInteger(runMetadata?.run_attempt) ? runMetadata.run_attempt : undefined;
	const runCreatedAt = parseIsoDate(runMetadata?.created_at);
	const runStartedAt = parseIsoDate(runMetadata?.run_started_at);
	const runUpdatedAt = parseIsoDate(runMetadata?.updated_at);
	if (actualRunId !== requestedRunId) reasons.push('platform run id does not match the requested run');
	if (runMetadata?.repository?.full_name !== repository) reasons.push('platform run repository does not match');
	if (runMetadata?.head_repository?.full_name !== repository) reasons.push('platform head repository does not match');
	if (runMetadata?.name !== expectedWorkflow.name) reasons.push('platform workflow name does not match');
	if (runMetadata?.path !== expectedWorkflow.path) reasons.push('platform workflow path does not match');
	if (runMetadata?.event !== expectedWorkflow.event) reasons.push('platform workflow event is not workflow_dispatch');
	if (!workflowId) reasons.push('platform workflow id is invalid');
	if (runMetadata?.status !== 'completed') reasons.push('platform run status is not completed');
	if (runMetadata?.conclusion !== 'success') reasons.push('platform run conclusion is not success');
	if (!sourceRevision || sourceRevision !== releaseRevision) {
		reasons.push('platform run does not target the expected release revision');
	}
	if (!headBranch || sourceRef !== protectedRef) reasons.push('platform run source ref does not match');
	if (!workflowRunAttempt) reasons.push('platform run attempt is invalid');
	if (!runCreatedAt || !runStartedAt || !runUpdatedAt || runCreatedAt > runStartedAt || runStartedAt > runUpdatedAt) {
		reasons.push('platform run timestamps are invalid');
	}
	if (
		runMetadata?.html_url !==
		`https://github.com/${repository ?? '<invalid>'}/actions/runs/${requestedRunId ?? '<invalid>'}`
	) {
		reasons.push('platform run HTML URL does not match its repository and run id');
	}
	if (
		runMetadata?.artifacts_url !==
		`https://api.github.com/repos/${repository ?? '<invalid>'}/actions/runs/${requestedRunId ?? '<invalid>'}/artifacts`
	) {
		reasons.push('platform run artifacts URL does not match its repository and run id');
	}

	const rawArtifacts = Array.isArray(artifactMetadata?.artifacts) ? artifactMetadata.artifacts : [];
	if (
		artifactMetadata?.total_count !== expectedArtifactNames.length ||
		rawArtifacts.length !== expectedArtifactNames.length
	) {
		reasons.push(
			`platform run must expose exactly 4 artifacts, got ${String(artifactMetadata?.total_count)}/${rawArtifacts.length}`
		);
	}
	const names = rawArtifacts.map(artifact => artifact?.name);
	for (const name of expectedArtifactNames) {
		const count = names.filter(candidate => candidate === name).length;
		if (count !== 1) reasons.push(`expected exactly one ${name} artifact, got ${count}`);
	}
	if (new Set(names).size !== names.length) reasons.push('platform run contains a duplicate artifact name');

	const artifacts = rawArtifacts.map((artifact, index) =>
		normalizeArtifact(
			artifact,
			index,
			{
				repository,
				runId: requestedRunId,
				sourceRevision,
				headBranch,
				runStartedAt,
				runUpdatedAt,
				nowMs
			},
			reasons
		)
	);
	const orderedArtifacts = expectedArtifactNames
		.map(name => artifacts.find(artifact => artifact.name === name))
		.filter(Boolean);
	const aggregateArtifact = orderedArtifacts.find(artifact => artifact.name === aggregateArtifactName);
	const status = reasons.length === 0 ? 'verified' : 'blocked';
	return {
		version: 1,
		generatedAt: new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString(),
		status,
		workflow: {
			id: workflowId ?? null,
			name: runMetadata?.name ?? null,
			path: runMetadata?.path ?? null,
			event: runMetadata?.event ?? null
		},
		run: {
			id: actualRunId ?? null,
			attempt: workflowRunAttempt ?? null,
			status: runMetadata?.status ?? null,
			conclusion: runMetadata?.conclusion ?? null,
			headSha: sourceRevision ?? null,
			headBranch: headBranch ?? null,
			createdAt: runMetadata?.created_at ?? null,
			runStartedAt: runMetadata?.run_started_at ?? null,
			updatedAt: runMetadata?.updated_at ?? null,
			htmlUrl: runMetadata?.html_url ?? null
		},
		provenance: {
			repository: repository ?? null,
			sourceRevision: sourceRevision ?? null,
			sourceRef: sourceRef ?? null,
			workflowRunId: actualRunId ?? null,
			workflowRunAttempt: workflowRunAttempt ?? null
		},
		artifacts: orderedArtifacts,
		artifactIds: orderedArtifacts.map(artifact => artifact.id),
		aggregateArtifactId: aggregateArtifact?.id ?? null,
		aggregateArtifactDigest: aggregateArtifact?.digest ?? null,
		aggregateArtifactUrl: aggregateArtifact?.archiveUrl ?? null,
		reasons
	};
}

function normalizeArtifact(artifact, index, expected, reasons) {
	const prefix = `artifact ${index}`;
	const id = normalizeId(artifact?.id);
	const digest = normalizeArtifactDigest(artifact?.digest);
	const createdAt = parseIsoDate(artifact?.created_at);
	const updatedAt = parseIsoDate(artifact?.updated_at);
	const expiresAt = parseIsoDate(artifact?.expires_at);
	if (!id) reasons.push(`${prefix} id is invalid`);
	if (!expectedArtifactNames.includes(artifact?.name)) reasons.push(`${prefix} name is unexpected`);
	if (!positiveInteger(artifact?.size_in_bytes)) reasons.push(`${prefix} size is invalid`);
	if (artifact?.expired !== false) reasons.push(`${prefix} is expired`);
	if (!digest) reasons.push(`${prefix} SHA-256 digest is invalid or missing`);
	if (!createdAt || !updatedAt || createdAt > updatedAt) reasons.push(`${prefix} timestamps are invalid`);
	if (
		createdAt &&
		updatedAt &&
		expected.runStartedAt &&
		expected.runUpdatedAt &&
		(createdAt < expected.runStartedAt || updatedAt > expected.runUpdatedAt)
	) {
		reasons.push(`${prefix} timestamps fall outside the platform run`);
	}
	if (
		!expiresAt ||
		(updatedAt && expiresAt <= updatedAt) ||
		(Number.isFinite(expected.nowMs) && expiresAt <= expected.nowMs)
	) {
		reasons.push(`${prefix} retention timestamp is expired or invalid`);
	}
	const archiveUrl = `https://api.github.com/repos/${expected.repository ?? '<invalid>'}/actions/artifacts/${id ?? '<invalid>'}/zip`;
	if (artifact?.archive_download_url !== archiveUrl) reasons.push(`${prefix} archive URL is invalid`);
	if (normalizeId(artifact?.workflow_run?.id) !== expected.runId) {
		reasons.push(`${prefix} workflow run id does not match`);
	}
	if (artifact?.workflow_run?.head_sha !== expected.sourceRevision) {
		reasons.push(`${prefix} workflow run head SHA does not match`);
	}
	if (artifact?.workflow_run?.head_branch !== expected.headBranch) {
		reasons.push(`${prefix} workflow run head branch does not match`);
	}
	return {
		id: id ?? null,
		name: artifact?.name ?? null,
		bytes: positiveInteger(artifact?.size_in_bytes) ? artifact.size_in_bytes : null,
		digest: digest ?? null,
		expired: artifact?.expired ?? null,
		createdAt: artifact?.created_at ?? null,
		updatedAt: artifact?.updated_at ?? null,
		expiresAt: artifact?.expires_at ?? null,
		archiveUrl: id ? archiveUrl : null
	};
}

async function runCli() {
	const cli = parseArgs(process.argv.slice(2).filter(argument => argument !== '--'));
	const outputPath = resolve(cli.output ?? 'sql-result-grid-platform-run.json');
	let report;
	try {
		const [runMetadata, artifactMetadata] = await Promise.all([
			readJson(cli['run-metadata'], 'platform run metadata'),
			readJson(cli['artifact-metadata'], 'platform artifact metadata')
		]);
		report = verifySqlResultGridPlatformRunMetadata({
			runMetadata,
			artifactMetadata,
			expectedRepository: cli['expected-repository'],
			expectedRunId: cli['expected-run-id'],
			expectedRevision: cli['expected-revision'],
			expectedRef: cli['expected-ref']
		});
	} catch (error) {
		report = {
			version: 1,
			generatedAt: new Date().toISOString(),
			status: 'blocked',
			reasons: [error instanceof Error ? error.message : String(error)],
			artifacts: [],
			artifactIds: [],
			aggregateArtifactId: null,
			aggregateArtifactDigest: null,
			aggregateArtifactUrl: null
		};
	}
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
	if (report.status === 'verified' && cli['github-output']) {
		await appendFile(
			resolve(cli['github-output']),
			[
				`artifact_id=${report.aggregateArtifactId}`,
				`artifact_digest=${report.aggregateArtifactDigest}`,
				`artifact_url=${report.aggregateArtifactUrl}`,
				`source_revision=${report.provenance.sourceRevision}`,
				`source_ref=${report.provenance.sourceRef}`,
				`platform_run_attempt=${report.provenance.workflowRunAttempt}`,
				''
			].join('\n'),
			'utf8'
		);
	}
	process.stdout.write(`${report.status}: ${outputPath}\n`);
	for (const reason of report.reasons) process.stdout.write(`- ${reason}\n`);
	process.exitCode = report.status === 'verified' ? 0 : 1;
}

async function readJson(path, label) {
	if (!path) throw new Error(`${label} path is required`);
	const value = JSON.parse(await readFile(resolve(path), 'utf8'));
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
	return value;
}

function parseArgs(args) {
	const result = {};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
		const [key, inlineValue] = argument.slice(2).split('=', 2);
		if (inlineValue !== undefined) {
			result[key] = inlineValue;
			continue;
		}
		const value = args[index + 1];
		if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
		result[key] = value;
		index += 1;
	}
	return result;
}

function normalizeId(value) {
	if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
	return typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : undefined;
}

function normalizeArtifactDigest(value) {
	const match = typeof value === 'string' ? /^sha256:([a-f0-9]{64})$/.exec(value) : undefined;
	return match?.[1];
}

function validRepository(value) {
	return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function validGitRevision(value) {
	return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}

function validSourceRef(value) {
	return typeof value === 'string' && /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(value) && validRefName(value.slice(11));
}

function validRefName(value) {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 255 &&
		/^[A-Za-z0-9._/-]+$/.test(value) &&
		!value.startsWith('/') &&
		!value.endsWith('/') &&
		!value.includes('..') &&
		!value.includes('//')
	);
}

function positiveInteger(value) {
	return Number.isSafeInteger(value) && value > 0;
}

function parseIsoDate(value) {
	if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
		return undefined;
	}
	return Date.parse(value);
}

function normalizeNow(value) {
	if (value instanceof Date) return value.getTime();
	if (typeof value === 'number') return value;
	return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}
