#!/usr/bin/env node

/**
 * Record the v8 gate inputs without reusing the frozen v7 attestation schema.
 * This manifest binds the gate decision to the exact platform evidence bytes
 * and to the two workflow identities that produced and recorded them.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const cli = parseArgs(process.argv.slice(2).filter(argument => argument !== '--'));
const outputPath = resolve(cli.output ?? 'sql-result-grid-gate-v8-attestation.json');
let report;

try {
	const gateDocument = await readDocument(cli.gate, '--gate');
	const platformDocument = await readDocument(cli['platform-evidence'], '--platform-evidence');
	report = createAttestation(
		gateDocument.value,
		platformDocument.value,
		cli,
		gateDocument.bytes,
		platformDocument.bytes
	);
} catch (error) {
	report = {
		version: 1,
		contract: 'z1-v8-frame-aware-attestation',
		status: 'blocked',
		gateDecision: null,
		inputDigests: {},
		reasons: [error instanceof Error ? error.message : String(error)]
	};
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${report.status}: ${outputPath}\n`);
for (const reason of report.reasons) process.stdout.write(`- ${reason}\n`);
process.exitCode = report.status === 'recorded' ? 0 : 1;

function createAttestation(gate, platformEvidence, options, gateBytes, platformBytes) {
	const reasons = [];
	const platformDigest = sha256(platformBytes);
	const expectedRepository = options.repository;
	const expectedRevision = options['source-revision'];
	const expectedRef = options['source-ref'];
	const expectedPlatformRunId = options['platform-workflow-run-id'];
	const expectedPlatformAttempt = Number(options['platform-workflow-run-attempt']);
	const attestationRunId = options['attestation-workflow-run-id'];
	const attestationAttempt = Number(options['attestation-workflow-run-attempt']);
	const attestationUrl = options['attestation-workflow-run-url'];

	if (gate?.version !== 1 || gate?.gateContract !== 'z1-v8-frame-aware') {
		reasons.push('v8 gate report identity is invalid');
	}
	if (gate?.measurementContractVersion !== 8 || !['GO', 'NO-GO'].includes(gate?.decision)) {
		reasons.push('v8 gate decision or measurement contract is invalid');
	}
	if (gate?.inputSha256 !== platformDigest) reasons.push('v8 gate input digest does not match platform evidence');
	if (!isRepository(expectedRepository)) reasons.push('repository is invalid');
	if (!isGitRevision(expectedRevision)) reasons.push('source revision is invalid');
	if (!isSourceRef(expectedRef)) reasons.push('source ref is invalid');
	if (
		!isWorkflowId(expectedPlatformRunId) ||
		!Number.isInteger(expectedPlatformAttempt) ||
		expectedPlatformAttempt < 1
	) {
		reasons.push('platform workflow identity is invalid');
	}
	if (!isWorkflowId(attestationRunId) || !Number.isInteger(attestationAttempt) || attestationAttempt < 1) {
		reasons.push('attestation workflow identity is invalid');
	}
	if (
		attestationUrl !==
		`https://github.com/${expectedRepository ?? '<invalid>'}/actions/runs/${attestationRunId ?? '<invalid>'}`
	) {
		reasons.push('attestation workflow URL is invalid');
	}
	if (
		isWorkflowId(expectedPlatformRunId) &&
		isWorkflowId(attestationRunId) &&
		BigInt(attestationRunId) <= BigInt(expectedPlatformRunId)
	) {
		reasons.push('attestation workflow must run after the platform workflow');
	}

	const platforms = {};
	for (const key of ['macosWebKit', 'windowsWebView2']) {
		const evidence = platformEvidence?.[key];
		platforms[key] = {
			status: evidence?.status ?? null,
			workflowRunId: evidence?.provenance?.workflowRunId ?? null,
			workflowRunAttempt: evidence?.provenance?.workflowRunAttempt ?? null,
			bundleSha256: evidence?.provenance?.zeusBundleSha256 ?? null
		};
		if (evidence?.version !== 3 || evidence?.measurementContractVersion !== 8 || evidence?.status !== 'ready') {
			reasons.push(`${key} is not ready v8 evidence`);
		}
		const provenance = evidence?.provenance;
		for (const [field, expected] of Object.entries({
			repository: expectedRepository,
			sourceRevision: expectedRevision,
			sourceRef: expectedRef,
			workflowRunId: expectedPlatformRunId,
			workflowRunAttempt: expectedPlatformAttempt
		})) {
			if (provenance?.[field] !== expected) reasons.push(`${key} provenance ${field} does not match`);
		}
		if (
			!isSha256(provenance?.binarySha256) ||
			!isSha256(provenance?.zeusBundleSha256) ||
			!isSha256(provenance?.workbenchTableBundleSha256)
		) {
			reasons.push(`${key} bundle provenance is incomplete`);
		}
	}
	if (reasons.length > 0) throw new Error(reasons.join('; '));

	return {
		version: 1,
		contract: 'z1-v8-frame-aware-attestation',
		generatedAt: new Date().toISOString(),
		status: 'recorded',
		gateDecision: gate.decision,
		measurementContractVersion: 8,
		provenance: {
			repository: expectedRepository,
			sourceRevision: expectedRevision,
			sourceRef: expectedRef,
			platformWorkflowRunId: expectedPlatformRunId,
			platformWorkflowRunAttempt: expectedPlatformAttempt,
			attestationWorkflowRunId: attestationRunId,
			attestationWorkflowRunAttempt: attestationAttempt,
			attestationWorkflowRunUrl: attestationUrl
		},
		inputDigests: {
			gate: sha256(gateBytes),
			platformEvidence: platformDigest
		},
		platforms,
		reasons: []
	};
}

async function readDocument(value, label) {
	if (!value) throw new Error(`${label} is required`);
	const bytes = await readFile(resolve(value));
	return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}

function parseArgs(args) {
	const result = {};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
		const [key, inline] = argument.slice(2).split('=', 2);
		if (inline !== undefined) result[key] = inline;
		else {
			result[key] = args[index + 1] ?? 'true';
			index += 1;
		}
	}
	return result;
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function isRepository(value) {
	return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function isGitRevision(value) {
	return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}

function isSourceRef(value) {
	return typeof value === 'string' && /^refs\/[A-Za-z0-9._/-]+$/.test(value);
}

function isWorkflowId(value) {
	return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

function isSha256(value) {
	return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
