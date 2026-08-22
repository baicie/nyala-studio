#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const expectedWorkflow = {
	name: 'SQL Agent Native Workbench Capture',
	path: '.github/workflows/sql-agent-native.yml',
	event: 'workflow_dispatch'
};
const expectedArtifactNames = ['sql-agent-native-macos', 'sql-agent-native-windows'];
const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (isMain) await runCli();

export function verifyCaptureRunMetadata({ runMetadata, artifactMetadata, expectedRepository, expectedRunId }) {
	const reasons = [];
	const repository = validRepository(expectedRepository) ? expectedRepository : undefined;
	const runId = normalizeId(expectedRunId);
	if (!repository) reasons.push('expected repository is invalid');
	if (!runId) reasons.push('expected capture run id is invalid');

	const actualRunId = normalizeId(runMetadata?.id);
	const workflowId = normalizeId(runMetadata?.workflow_id);
	const sourceRevision = validGitRevision(runMetadata?.head_sha) ? runMetadata.head_sha : undefined;
	const headBranch = validRefName(runMetadata?.head_branch) ? runMetadata.head_branch : undefined;
	const sourceRef = headBranch ? `refs/heads/${headBranch}` : undefined;
	const workflowRunAttempt = positiveInteger(runMetadata?.run_attempt) ? runMetadata.run_attempt : undefined;
	if (actualRunId !== runId) reasons.push('capture run id does not match the requested run');
	if (runMetadata?.repository?.full_name !== repository) reasons.push('capture run repository does not match');
	if (runMetadata?.head_repository?.full_name !== repository) reasons.push('capture head repository does not match');
	if (runMetadata?.name !== expectedWorkflow.name) reasons.push('capture workflow name does not match');
	if (runMetadata?.path !== expectedWorkflow.path) reasons.push('capture workflow path does not match');
	if (!workflowId) reasons.push('capture workflow id is invalid');
	if (runMetadata?.event !== expectedWorkflow.event) reasons.push('capture workflow event is not workflow_dispatch');
	if (runMetadata?.status !== 'completed') reasons.push('capture run status is not completed');
	if (runMetadata?.conclusion !== 'success') reasons.push('capture run conclusion is not success');
	if (!sourceRevision) reasons.push('capture run head SHA is invalid');
	if (!headBranch) reasons.push('capture run head branch is invalid');
	if (!workflowRunAttempt) reasons.push('capture run attempt is invalid');
	if (
		runMetadata?.html_url !== `https://github.com/${repository ?? '<invalid>'}/actions/runs/${runId ?? '<invalid>'}`
	) {
		reasons.push('capture run HTML URL does not match its repository and run id');
	}
	if (
		runMetadata?.artifacts_url !==
		`https://api.github.com/repos/${repository ?? '<invalid>'}/actions/runs/${runId ?? '<invalid>'}/artifacts`
	) {
		reasons.push('capture run artifacts URL does not match its repository and run id');
	}
	if (!validOrderedTimestamps(runMetadata?.run_started_at, runMetadata?.updated_at)) {
		reasons.push('capture run timestamps are invalid');
	}

	const rawArtifacts = Array.isArray(artifactMetadata?.artifacts) ? artifactMetadata.artifacts : [];
	if (artifactMetadata?.total_count !== 2 || rawArtifacts.length !== 2) {
		reasons.push(
			`capture run must expose exactly 2 artifacts, got ${String(artifactMetadata?.total_count)}/${rawArtifacts.length}`
		);
	}
	const names = rawArtifacts.map(artifact => artifact?.name);
	for (const name of expectedArtifactNames) {
		const count = names.filter(candidate => candidate === name).length;
		if (count !== 1) reasons.push(`expected exactly one ${name} artifact, got ${count}`);
	}
	if (new Set(names).size !== names.length) reasons.push('capture run contains a duplicate artifact name');

	const artifacts = rawArtifacts.map((artifact, index) =>
		normalizeArtifact(artifact, index, { repository, runId, sourceRevision, headBranch }, reasons)
	);
	const orderedArtifacts = expectedArtifactNames
		.map(name => artifacts.find(artifact => artifact.name === name))
		.filter(Boolean);
	const status = reasons.length === 0 ? 'verified' : 'blocked';
	return {
		version: 1,
		generatedAt: new Date().toISOString(),
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
		reasons
	};
}

function normalizeArtifact(artifact, index, expected, reasons) {
	const prefix = `artifact ${index}`;
	const id = normalizeId(artifact?.id);
	const digest = normalizeArtifactDigest(artifact?.digest);
	if (!id) reasons.push(`${prefix} id is invalid`);
	if (!expectedArtifactNames.includes(artifact?.name)) reasons.push(`${prefix} name is unexpected`);
	if (!positiveInteger(artifact?.size_in_bytes)) reasons.push(`${prefix} size is invalid`);
	if (artifact?.expired !== false) reasons.push(`${prefix} is expired`);
	if (!digest) reasons.push(`${prefix} SHA-256 digest is invalid or missing`);
	if (!validOrderedTimestamps(artifact?.created_at, artifact?.updated_at)) {
		reasons.push(`${prefix} timestamps are invalid`);
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
		createdAt: artifact?.created_at ?? null,
		updatedAt: artifact?.updated_at ?? null
	};
}

async function runCli() {
	const cli = parseArgs(process.argv.slice(2).filter(argument => argument !== '--'));
	const outputPath = resolve(cli.output ?? 'sql-agent-capture-run.json');
	let report;
	try {
		const [runMetadata, artifactMetadata] = await Promise.all([
			readJson(cli['run-metadata'], 'capture run metadata'),
			readJson(cli['artifact-metadata'], 'capture artifact metadata')
		]);
		report = verifyCaptureRunMetadata({
			runMetadata,
			artifactMetadata,
			expectedRepository: cli['expected-repository'],
			expectedRunId: cli['expected-run-id']
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
		await appendFile(
			resolve(cli['github-output']),
			[
				`artifact_ids=${report.artifactIds.join(',')}`,
				`source_revision=${report.provenance.sourceRevision}`,
				`source_ref=${report.provenance.sourceRef}`,
				`capture_run_attempt=${report.provenance.workflowRunAttempt}`,
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

function validOrderedTimestamps(start, end) {
	if (!isIsoDate(start) || !isIsoDate(end)) return false;
	return Date.parse(start) <= Date.parse(end);
}

function isIsoDate(value) {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
