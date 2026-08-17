#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const cli = parseArgs(process.argv.slice(2).filter(argument => argument !== '--'));
if (Object.hasOwn(cli, 'evidence-refs')) {
	throw new Error('--evidence-refs is not supported; provide one evidence reference for each manual gate.');
}
const outputPath = resolve(cli.output ?? 'sql-agent-checkpoint-w-manual.json');
const provenance = validateProvenance(cli);
const MAX_EVIDENCE_REF_LENGTH = 2048;
const confirmations = {
	macosKeyboard: parseBoolean(cli['macos-keyboard'], '--macos-keyboard'),
	voiceOver: parseBoolean(cli.voiceover, '--voiceover'),
	windowsKeyboard: parseBoolean(cli['windows-keyboard'], '--windows-keyboard'),
	narrator: parseBoolean(cli.narrator, '--narrator')
};
const evidenceRefs = {
	macosKeyboard: validateEvidenceRef(cli['macos-keyboard-evidence-ref'], '--macos-keyboard-evidence-ref'),
	voiceOver: validateEvidenceRef(cli['voiceover-evidence-ref'], '--voiceover-evidence-ref'),
	windowsKeyboard: validateEvidenceRef(cli['windows-keyboard-evidence-ref'], '--windows-keyboard-evidence-ref'),
	narrator: validateEvidenceRef(cli['narrator-evidence-ref'], '--narrator-evidence-ref')
};
if (new Set(Object.values(evidenceRefs)).size !== Object.keys(evidenceRefs).length) {
	throw new Error('Manual gate evidence references must be unique.');
}
const attested = Object.values(confirmations).every(Boolean);
const report = {
	version: 2,
	status: attested ? 'attested' : 'pending',
	provenance,
	platforms: {
		macos: createPlatformAttestation(
			confirmations.macosKeyboard,
			confirmations.voiceOver,
			'VoiceOver',
			evidenceRefs.macosKeyboard,
			evidenceRefs.voiceOver
		),
		windows: createPlatformAttestation(
			confirmations.windowsKeyboard,
			confirmations.narrator,
			'Narrator',
			evidenceRefs.windowsKeyboard,
			evidenceRefs.narrator
		)
	}
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${report.status}: ${outputPath}\n`);

function createPlatformAttestation(
	keyboardPassed,
	screenReaderPassed,
	assistiveTechnology,
	keyboardEvidenceRef,
	screenReaderEvidenceRef
) {
	return {
		nativeKeyboard: {
			status: keyboardPassed ? 'passed' : 'pending',
			focusOrder: ['Agent prompt', 'Agent task', 'Agent access mode', 'Start Agent run'],
			startCancelReachable: keyboardPassed,
			noFocusTrap: keyboardPassed,
			evidenceRef: keyboardEvidenceRef
		},
		screenReader: {
			status: screenReaderPassed ? 'passed' : 'pending',
			assistiveTechnology,
			labelsAnnounced: screenReaderPassed,
			stateChangesAnnounced: screenReaderPassed,
			noFocusTrap: screenReaderPassed,
			evidenceRef: screenReaderEvidenceRef
		}
	};
}

function validateProvenance(options) {
	const repository = required(options.repository, '--repository');
	const sourceRevision = required(options['source-revision'], '--source-revision');
	const sourceRef = required(options['source-ref'], '--source-ref');
	const workflowRunId = required(options['workflow-run-id'], '--workflow-run-id');
	const workflowRunAttempt = Number(required(options['workflow-run-attempt'], '--workflow-run-attempt'));
	const reviewer = required(options.reviewer, '--reviewer');
	const reviewedAt = options['reviewed-at'] ?? new Date().toISOString();
	const workflowRunUrl = required(options['workflow-run-url'], '--workflow-run-url');
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Repository provenance is invalid.');
	if (!/^[a-f0-9]{40}$/.test(sourceRevision))
		throw new Error('Source revision provenance must be a 40-character Git SHA.');
	if (!/^refs\/(heads|tags|pull)\//.test(sourceRef)) throw new Error('Source ref provenance is invalid.');
	if (!/^[1-9][0-9]*$/.test(workflowRunId)) throw new Error('Workflow run id provenance is invalid.');
	if (!Number.isInteger(workflowRunAttempt) || workflowRunAttempt < 1) {
		throw new Error('Workflow run attempt provenance is invalid.');
	}
	if (reviewer.trim().length < 2) throw new Error('Reviewer provenance is missing.');
	if (!Number.isFinite(Date.parse(reviewedAt)) || new Date(reviewedAt).toISOString() !== reviewedAt) {
		throw new Error('Reviewed-at provenance must be an ISO timestamp.');
	}
	if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/[1-9][0-9]*$/.test(workflowRunUrl)) {
		throw new Error('Workflow run URL provenance is invalid.');
	}
	const attestationWorkflowProvenance = validateAttestationWorkflowProvenance(options, repository, workflowRunId);
	return {
		repository,
		sourceRevision,
		sourceRef,
		workflowRunId,
		workflowRunAttempt,
		reviewer: reviewer.trim(),
		reviewedAt,
		workflowRunUrl,
		...attestationWorkflowProvenance
	};
}

function validateAttestationWorkflowProvenance(options, repository, captureWorkflowRunId) {
	const values = [
		options['attestation-workflow-run-id'],
		options['attestation-workflow-run-attempt'],
		options['attestation-workflow-run-url']
	];
	if (values.every(value => value === undefined)) return {};
	if (values.some(value => value === undefined)) {
		throw new Error('Attestation workflow provenance must include run id, run attempt, and run URL.');
	}
	const attestationWorkflowRunId = required(values[0], '--attestation-workflow-run-id');
	const attestationWorkflowRunAttempt = Number(required(values[1], '--attestation-workflow-run-attempt'));
	const attestationWorkflowRunUrl = required(values[2], '--attestation-workflow-run-url');
	if (!/^[1-9][0-9]*$/.test(attestationWorkflowRunId)) {
		throw new Error('Attestation workflow run id provenance is invalid.');
	}
	if (!Number.isInteger(attestationWorkflowRunAttempt) || attestationWorkflowRunAttempt < 1) {
		throw new Error('Attestation workflow run attempt provenance is invalid.');
	}
	if (attestationWorkflowRunUrl !== `https://github.com/${repository}/actions/runs/${attestationWorkflowRunId}`) {
		throw new Error('Attestation workflow run URL provenance is invalid.');
	}
	if (BigInt(attestationWorkflowRunId) <= BigInt(captureWorkflowRunId)) {
		throw new Error('Attestation workflow must run after the native capture workflow.');
	}
	return {
		attestationWorkflowRunId,
		attestationWorkflowRunAttempt,
		attestationWorkflowRunUrl
	};
}

function parseBoolean(value, label) {
	if (value === undefined) return false;
	if (value === 'true') return true;
	if (value === 'false') return false;
	throw new Error(`${label} must be true or false.`);
}

function validateEvidenceRef(value, label) {
	if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required.`);
	if (
		value.length > MAX_EVIDENCE_REF_LENGTH ||
		value.trim() !== value ||
		!/^(?:https|qa):\/\//iu.test(value) ||
		value.includes('\\') ||
		value.includes('?') ||
		value.includes('#') ||
		/[\s\u0000-\u001f\u007f]/u.test(value) ||
		/%(?:0[0-9a-f]|1[0-9a-f]|20|7f)/iu.test(value)
	) {
		throw new Error(`${label} is invalid.`);
	}
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`${label} is invalid.`);
	}
	if (
		(parsed.protocol !== 'https:' && parsed.protocol !== 'qa:') ||
		parsed.username !== '' ||
		parsed.password !== '' ||
		parsed.search !== '' ||
		parsed.hash !== '' ||
		parsed.hostname === ''
	) {
		throw new Error(`${label} is invalid.`);
	}
	return parsed.href;
}

function required(value, label) {
	if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required.`);
	return value.trim();
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
		if (index + 1 >= args.length || args[index + 1].startsWith('--')) {
			throw new Error(`Missing value for --${key}`);
		}
		result[key] = args[index + 1];
		index += 1;
	}
	return result;
}
