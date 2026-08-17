#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultExpectedWorkflow = {
	name: 'SQL Agent Checkpoint W Attestation',
	path: '.github/workflows/sql-agent-checkpoint-w-attest.yml',
	event: 'workflow_dispatch'
};
const defaultExpectedArtifactName = 'sql-agent-checkpoint-w';
const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (isMain) await runCli();

export function verifyAttestationRunMetadata({
	runMetadata,
	artifactMetadata,
	expectedRepository,
	expectedRunId,
	expectedRevision,
	expectedRef,
	expectedWorkflow = defaultExpectedWorkflow,
	expectedArtifactName = defaultExpectedArtifactName,
	now = new Date()
}) {
	const reasons = [];
	const repository = validRepository(expectedRepository) ? expectedRepository : undefined;
	const runId = normalizeId(expectedRunId);
	const releaseRevision = validGitRevision(expectedRevision) ? expectedRevision : undefined;
	const protectedRef = validSourceRef(expectedRef) ? expectedRef : undefined;
	const nowMs = normalizeNow(now);
	if (!repository) reasons.push('expected repository is invalid');
	if (!runId) reasons.push('expected attestation run id is invalid');
	if (!releaseRevision) reasons.push('expected release revision is invalid');
	if (!protectedRef) reasons.push('expected protected source ref is invalid');
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
	if (actualRunId !== runId) reasons.push('attestation run id does not match the requested run');
	if (runMetadata?.repository?.full_name !== repository) reasons.push('attestation run repository does not match');
	if (runMetadata?.head_repository?.full_name !== repository) {
		reasons.push('attestation head repository does not match');
	}
	if (runMetadata?.name !== expectedWorkflow.name) reasons.push('attestation workflow name does not match');
	if (runMetadata?.path !== expectedWorkflow.path) reasons.push('attestation workflow path does not match');
	if (!workflowId) reasons.push('attestation workflow id is invalid');
	if (runMetadata?.event !== expectedWorkflow.event) {
		reasons.push('attestation workflow event is not workflow_dispatch');
	}
	if (runMetadata?.status !== 'completed') reasons.push('attestation run status is not completed');
	if (runMetadata?.conclusion !== 'success') reasons.push('attestation run conclusion is not success');
	if (!sourceRevision) reasons.push('attestation run head SHA is invalid');
	if (sourceRevision !== releaseRevision) reasons.push('attestation run does not target the expected release revision');
	if (!headBranch) reasons.push('attestation run head branch is invalid');
	if (sourceRef !== protectedRef) reasons.push('attestation run does not target the expected protected source ref');
	if (!workflowRunAttempt) reasons.push('attestation run attempt is invalid');
	if (
		runMetadata?.html_url !== `https://github.com/${repository ?? '<invalid>'}/actions/runs/${runId ?? '<invalid>'}`
	) {
		reasons.push('attestation run HTML URL does not match its repository and run id');
	}
	if (
		runMetadata?.artifacts_url !==
		`https://api.github.com/repos/${repository ?? '<invalid>'}/actions/runs/${runId ?? '<invalid>'}/artifacts`
	) {
		reasons.push('attestation run artifacts URL does not match its repository and run id');
	}
	if (!runCreatedAt || !runStartedAt || runCreatedAt > runStartedAt) {
		reasons.push('attestation run creation timestamp is invalid');
	}
	if (!runStartedAt || !runUpdatedAt || runStartedAt > runUpdatedAt) {
		reasons.push('attestation run timestamps are invalid');
	}

	const rawArtifacts = Array.isArray(artifactMetadata?.artifacts) ? artifactMetadata.artifacts : [];
	if (artifactMetadata?.total_count !== 1 || rawArtifacts.length !== 1) {
		reasons.push(
			`attestation run must expose exactly 1 artifact, got ${String(artifactMetadata?.total_count)}/${rawArtifacts.length}`
		);
	}
	const artifacts = rawArtifacts.map((artifact, index) =>
		normalizeArtifact(
			artifact,
			index,
			{ repository, runId, sourceRevision, headBranch, runStartedAt, runUpdatedAt, nowMs, expectedArtifactName },
			reasons
		)
	);
	const matchingArtifacts = artifacts.filter(artifact => artifact.name === expectedArtifactName);
	if (matchingArtifacts.length !== 1) {
		reasons.push(`expected exactly one ${expectedArtifactName} artifact, got ${matchingArtifacts.length}`);
	}
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
		artifacts: matchingArtifacts,
		artifactIds: matchingArtifacts.map(artifact => artifact.id),
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
	if (artifact?.name !== expected.expectedArtifactName) reasons.push(`${prefix} name is unexpected`);
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
		reasons.push(`${prefix} timestamps fall outside the attestation run`);
	}
	if (
		!expiresAt ||
		(updatedAt && expiresAt <= updatedAt) ||
		(Number.isFinite(expected.nowMs) && expiresAt <= expected.nowMs)
	) {
		reasons.push(`${prefix} retention timestamp is expired or invalid`);
	}
	if (
		artifact?.archive_download_url !==
		`https://api.github.com/repos/${expected.repository ?? '<invalid>'}/actions/artifacts/${id ?? '<invalid>'}/zip`
	) {
		reasons.push(`${prefix} archive URL is invalid`);
	}
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
		archiveUrl: artifact?.archive_download_url ?? null
	};
}

async function runCli() {
	const cli = parseArgs(process.argv.slice(2).filter(argument => argument !== '--'));
	const outputPath = resolve(cli.output ?? 'sql-agent-attestation-run.json');
	let report;
	try {
		const [runMetadata, artifactMetadata] = await Promise.all([
			readJson(cli['run-metadata'], 'attestation run metadata'),
			readJson(cli['artifact-metadata'], 'attestation artifact metadata')
		]);
		report = verifyAttestationRunMetadata({
			runMetadata,
			artifactMetadata,
			expectedRepository: cli['expected-repository'],
			expectedRunId: cli['expected-run-id'],
			expectedRevision: cli['expected-revision'],
			expectedRef: cli['expected-ref'],
			expectedWorkflow: cli['expected-workflow-name']
				? {
						name: cli['expected-workflow-name'],
						path: cli['expected-workflow-path'],
						event: cli['expected-workflow-event']
					}
				: undefined,
			expectedArtifactName: cli['expected-artifact-name']
		});
	} catch (error) {
		report = {
			version: 1,
			generatedAt: new Date().toISOString(),
			status: 'blocked',
			reasons: [error instanceof Error ? error.message : String(error)],
			artifacts: [],
			artifactIds: []
		};
	}
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
	if (report.status === 'verified' && cli['github-output']) {
		const artifact = report.artifacts[0];
		await appendFile(
			resolve(cli['github-output']),
			[
				`artifact_ids=${report.artifactIds.join(',')}`,
				`artifact_id=${artifact.id}`,
				`artifact_digest=${artifact.digest}`,
				`artifact_url=${artifact.archiveUrl}`,
				`source_revision=${report.provenance.sourceRevision}`,
				`source_ref=${report.provenance.sourceRef}`,
				`attestation_run_attempt=${report.provenance.workflowRunAttempt}`,
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
