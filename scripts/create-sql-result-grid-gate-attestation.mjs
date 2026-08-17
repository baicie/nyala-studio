#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const cli = parseArgs(process.argv.slice(2).filter(argument => argument !== '--'));
const outputPath = resolve(cli.output ?? 'sql-result-grid-gate-attestation.json');
let report;

try {
	const inputs = await loadInputs(cli);
	report = createAttestation(inputs, cli);
} catch (error) {
	report = {
		version: 1,
		generatedAt: new Date().toISOString(),
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

async function loadInputs(options) {
	const definitions = {
		gate: ['gate', '--gate'],
		benchmark: ['benchmark', '--benchmark'],
		platformEvidence: ['platform-evidence', '--platform-evidence'],
		zeusAudit: ['zeus-audit', '--zeus-audit'],
		platformRun: ['platform-run', '--platform-run']
	};
	const entries = await Promise.all(
		Object.entries(definitions).map(async ([key, [option, label]]) => {
			const path = resolve(required(options[option], label));
			const bytes = await readFile(path);
			const value = JSON.parse(bytes.toString('utf8'));
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				throw new Error(`${label} must contain a JSON object`);
			}
			return [key, { path, bytes, value, sha256: sha256(bytes) }];
		})
	);
	const zeusBundlePath = resolve(required(options['zeus-bundle'], '--zeus-bundle'));
	const zeusBundleBytes = await readFile(zeusBundlePath);
	return {
		...Object.fromEntries(entries),
		zeusBundle: {
			path: zeusBundlePath,
			bytes: zeusBundleBytes,
			sha256: sha256(zeusBundleBytes)
		}
	};
}

function createAttestation(inputs, options) {
	const reasons = [];
	const gate = inputs.gate.value;
	const benchmark = inputs.benchmark.value;
	const platformEvidence = inputs.platformEvidence.value;
	const zeusAudit = inputs.zeusAudit.value;
	const platformRun = inputs.platformRun.value;
	const provenance = platformRun?.provenance;
	validatePlatformRun(platformRun, reasons);
	validateGate(gate, inputs.benchmark.sha256, provenance, reasons);
	validateProvenance('Chromium benchmark', benchmark?.provenance, provenance, reasons);
	validateProvenance('macOS WebKit', platformEvidence?.macosWebKit?.provenance, provenance, reasons);
	validateProvenance('Windows WebView2', platformEvidence?.windowsWebView2?.provenance, provenance, reasons);
	validateProvenance('Zeus audit', zeusAudit?.provenance, provenance, reasons);
	validateZeusBundle(inputs.zeusBundle, zeusAudit, benchmark, platformEvidence, gate, reasons);

	const attestationWorkflowRunId = validWorkflowRunId(options['attestation-workflow-run-id'])
		? options['attestation-workflow-run-id']
		: undefined;
	const attestationWorkflowRunAttempt = positiveInteger(Number(options['attestation-workflow-run-attempt']))
		? Number(options['attestation-workflow-run-attempt'])
		: undefined;
	const expectedAttestationUrl = `https://github.com/${provenance?.repository ?? '<invalid>'}/actions/runs/${attestationWorkflowRunId ?? '<invalid>'}`;
	const attestationWorkflowRunUrl = options['attestation-workflow-run-url'];
	if (!attestationWorkflowRunId) reasons.push('attestation workflow run id is invalid');
	if (!attestationWorkflowRunAttempt) reasons.push('attestation workflow run attempt is invalid');
	if (attestationWorkflowRunUrl !== expectedAttestationUrl) reasons.push('attestation workflow run URL is invalid');
	if (
		validWorkflowRunId(provenance?.workflowRunId) &&
		attestationWorkflowRunId &&
		BigInt(attestationWorkflowRunId) <= BigInt(provenance.workflowRunId)
	) {
		reasons.push('attestation workflow must run after the platform evidence workflow');
	}
	if (reasons.length > 0) throw new Error(reasons.join('; '));

	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		status: 'recorded',
		gateDecision: gate.decision,
		gateGeneratedAt: gate.generatedAt,
		provenance: {
			repository: provenance.repository,
			sourceRevision: provenance.sourceRevision,
			sourceRef: provenance.sourceRef,
			platformWorkflowRunId: provenance.workflowRunId,
			platformWorkflowRunAttempt: provenance.workflowRunAttempt,
			attestationWorkflowRunId,
			attestationWorkflowRunAttempt,
			attestationWorkflowRunUrl
		},
		inputDigests: {
			gate: inputs.gate.sha256,
			benchmark: inputs.benchmark.sha256,
			platformEvidence: inputs.platformEvidence.sha256,
			zeusAudit: inputs.zeusAudit.sha256,
			zeusBundle: inputs.zeusBundle.sha256,
			platformRun: inputs.platformRun.sha256
		},
		platformRun: {
			workflow: platformRun.workflow,
			run: platformRun.run,
			aggregateArtifactId: platformRun.aggregateArtifactId,
			aggregateArtifactDigest: platformRun.aggregateArtifactDigest,
			aggregateArtifactUrl: platformRun.aggregateArtifactUrl
		},
		reasons: []
	};
}

function validatePlatformRun(report, reasons) {
	if (
		report?.version !== 1 ||
		report?.status !== 'verified' ||
		!Array.isArray(report?.reasons) ||
		report.reasons.length
	) {
		reasons.push('platform run metadata is not verified');
	}
	if (
		report?.workflow?.name !== 'SQL Result Grid Native WebView Evidence' ||
		report?.workflow?.path !== '.github/workflows/sql-result-grid-platform.yml' ||
		report?.workflow?.event !== 'workflow_dispatch' ||
		!validWorkflowRunId(report?.workflow?.id)
	) {
		reasons.push('platform workflow identity is invalid');
	}
	const provenance = report?.provenance;
	if (
		!validRepository(provenance?.repository) ||
		!validGitRevision(provenance?.sourceRevision) ||
		!validSourceRef(provenance?.sourceRef) ||
		!validWorkflowRunId(provenance?.workflowRunId) ||
		!positiveInteger(provenance?.workflowRunAttempt)
	) {
		reasons.push('platform workflow provenance is invalid');
	}
	if (
		report?.run?.id !== provenance?.workflowRunId ||
		report?.run?.attempt !== provenance?.workflowRunAttempt ||
		report?.run?.status !== 'completed' ||
		report?.run?.conclusion !== 'success' ||
		report?.run?.headSha !== provenance?.sourceRevision ||
		report?.run?.htmlUrl !== `https://github.com/${provenance?.repository}/actions/runs/${provenance?.workflowRunId}` ||
		!isIsoDate(report?.run?.updatedAt)
	) {
		reasons.push('platform run completion identity is invalid');
	}
	if (
		!validWorkflowRunId(report?.aggregateArtifactId) ||
		!isSha256(report?.aggregateArtifactDigest) ||
		report?.aggregateArtifactUrl !==
			`https://api.github.com/repos/${provenance?.repository}/actions/artifacts/${report?.aggregateArtifactId}/zip`
	) {
		reasons.push('platform aggregate artifact identity is invalid');
	}
}

function validateGate(gate, benchmarkSha256, expected, reasons) {
	if (
		gate?.version !== 2 ||
		!isIsoDate(gate?.generatedAt) ||
		!['GO', 'NO-GO'].includes(gate?.decision) ||
		gate?.sourceRevision !== expected?.sourceRevision
	) {
		reasons.push('Z1 gate identity is invalid');
	}
	if (gate?.benchmark?.sha256 !== benchmarkSha256) reasons.push('Z1 gate benchmark digest does not match raw evidence');
	validateProvenance('Z1 gate benchmark', gate?.benchmark?.provenance, expected, reasons);
	validateProvenance('Z1 gate dependency audit', gate?.dependencyCheck?.provenance, expected, reasons);
	validateProvenance('Z1 gate macOS WebKit', gate?.platformEvidence?.macosWebKit?.provenance, expected, reasons);
	validateProvenance(
		'Z1 gate Windows WebView2',
		gate?.platformEvidence?.windowsWebView2?.provenance,
		expected,
		reasons
	);
}

function validateProvenance(label, actual, expected, reasons) {
	for (const field of ['repository', 'sourceRevision', 'sourceRef', 'workflowRunId', 'workflowRunAttempt']) {
		if (actual?.[field] !== expected?.[field]) {
			reasons.push(`${label} provenance ${field} does not match the verified platform run`);
		}
	}
}

function validateZeusBundle(bundle, audit, benchmark, platformEvidence, gate, reasons) {
	if (
		audit?.version !== 1 ||
		audit?.status !== 'ready' ||
		audit?.bundle?.file !== basename(bundle.path) ||
		audit?.bundle?.bytes !== bundle.bytes.byteLength ||
		audit?.bundle?.sha256 !== bundle.sha256
	) {
		reasons.push('Zeus audit does not match the actual bundle bytes');
	}
	const bindings = [
		['Chromium benchmark', benchmark?.provenance?.zeusBundleSha256],
		['macOS WebKit', platformEvidence?.macosWebKit?.provenance?.zeusBundleSha256],
		['Windows WebView2', platformEvidence?.windowsWebView2?.provenance?.zeusBundleSha256],
		['Z1 gate dependency', gate?.dependencyCheck?.bundleSha256],
		['Z1 gate macOS WebKit', gate?.platformEvidence?.macosWebKit?.provenance?.zeusBundleSha256],
		['Z1 gate Windows WebView2', gate?.platformEvidence?.windowsWebView2?.provenance?.zeusBundleSha256]
	];
	for (const [label, digest] of bindings) {
		if (digest !== bundle.sha256) reasons.push(`${label} Zeus bundle digest does not match the actual bundle`);
	}
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

function required(value, name) {
	if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
	return value;
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

function validRepository(value) {
	return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function validGitRevision(value) {
	return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}

function validSourceRef(value) {
	return typeof value === 'string' && /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(value);
}

function validWorkflowRunId(value) {
	return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

function positiveInteger(value) {
	return Number.isSafeInteger(value) && value > 0;
}

function isSha256(value) {
	return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isIsoDate(value) {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
