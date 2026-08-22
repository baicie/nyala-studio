import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const requiredArgs = [
	'--repository',
	'baicie/nyala-studio',
	'--source-revision',
	'a'.repeat(40),
	'--source-ref',
	'refs/heads/mvp',
	'--workflow-run-id',
	'123456789',
	'--workflow-run-attempt',
	'2',
	'--reviewer',
	'nyala-qa',
	'--reviewed-at',
	'2026-08-16T03:00:00.000Z',
	'--workflow-run-url',
	'https://github.com/baicie/nyala-studio/actions/runs/123456789'
];
const confirmedGateArgs = [
	'--macos-keyboard',
	'true',
	'--voiceover',
	'true',
	'--windows-keyboard',
	'true',
	'--narrator',
	'true'
];
const evidenceArgs = [
	'--macos-keyboard-evidence-ref',
	'qa://checkpoint-w/macos-keyboard',
	'--voiceover-evidence-ref',
	'https://github.com/baicie/nyala-studio/actions/runs/123456789/artifacts/voiceover',
	'--windows-keyboard-evidence-ref',
	'qa://checkpoint-w/windows-keyboard',
	'--narrator-evidence-ref',
	'https://github.com/baicie/nyala-studio/actions/runs/123456789/artifacts/narrator'
];

test('creates a version 2 attestation with evidence bound to each manual gate', async () => {
	await withOutput(async output => {
		await runGenerator(output, [...requiredArgs, ...confirmedGateArgs, ...evidenceArgs]);
		const attestation = JSON.parse(await readFile(output, 'utf8'));
		assert.equal(attestation.version, 2);
		assert.equal(attestation.status, 'attested');
		assert.deepEqual(attestation.provenance, {
			repository: 'baicie/nyala-studio',
			sourceRevision: 'a'.repeat(40),
			sourceRef: 'refs/heads/mvp',
			workflowRunId: '123456789',
			workflowRunAttempt: 2,
			reviewer: 'nyala-qa',
			reviewedAt: '2026-08-16T03:00:00.000Z',
			workflowRunUrl: 'https://github.com/baicie/nyala-studio/actions/runs/123456789'
		});
		assert.equal('evidenceRefs' in attestation, false);
		assert.equal(attestation.platforms.macos.nativeKeyboard.status, 'passed');
		assert.equal(attestation.platforms.macos.nativeKeyboard.evidenceRef, 'qa://checkpoint-w/macos-keyboard');
		assert.equal(attestation.platforms.macos.screenReader.assistiveTechnology, 'VoiceOver');
		assert.equal(
			attestation.platforms.macos.screenReader.evidenceRef,
			'https://github.com/baicie/nyala-studio/actions/runs/123456789/artifacts/voiceover'
		);
		assert.equal(attestation.platforms.windows.nativeKeyboard.evidenceRef, 'qa://checkpoint-w/windows-keyboard');
		assert.equal(attestation.platforms.windows.screenReader.assistiveTechnology, 'Narrator');
		assert.equal(
			attestation.platforms.windows.screenReader.evidenceRef,
			'https://github.com/baicie/nyala-studio/actions/runs/123456789/artifacts/narrator'
		);
	});
});

test('rejects unsafe gate-local evidence references without writing an attestation', async () => {
	const invalidRefs = [
		'',
		' qa://checkpoint-w/macos-keyboard',
		'qa://checkpoint-w/macos keyboard',
		'qa://checkpoint-w/macos\u0001keyboard',
		`qa://checkpoint-w/${'a'.repeat(2049)}`,
		'https:example.test/checkpoint-w',
		'http://example.test/checkpoint-w',
		'file:///tmp/checkpoint-w',
		'https://example.test/checkpoint-w\\notes',
		'https://reviewer:secret@example.test/checkpoint-w',
		'https://example.test/checkpoint-w?gate=macos',
		'https://example.test/checkpoint-w?',
		'https://example.test/checkpoint-w#macos',
		'https://example.test/checkpoint-w#',
		'qa://reviewer:secret@checkpoint-w/macos-keyboard',
		'qa://checkpoint-w/macos-keyboard?attempt=1',
		'qa://checkpoint-w/macos-keyboard#notes'
	];
	for (const invalidRef of invalidRefs) {
		await withOutput(async output => {
			const args = [...requiredArgs, ...confirmedGateArgs, ...evidenceArgs];
			args[args.indexOf('--macos-keyboard-evidence-ref') + 1] = invalidRef;
			await assert.rejects(runGenerator(output, args), /macos-keyboard-evidence-ref.*invalid|required/i);
			await assert.rejects(readFile(output, 'utf8'), /ENOENT/);
		});
	}
	for (const flag of [
		'--macos-keyboard-evidence-ref',
		'--voiceover-evidence-ref',
		'--windows-keyboard-evidence-ref',
		'--narrator-evidence-ref'
	]) {
		await withOutput(async output => {
			const args = [...requiredArgs, ...confirmedGateArgs, ...evidenceArgs];
			args[args.indexOf(flag) + 1] = 'http://example.test/checkpoint-w';
			await assert.rejects(runGenerator(output, args), new RegExp(`${flag}.*invalid`, 'i'));
			await assert.rejects(readFile(output, 'utf8'), /ENOENT/);
		});
	}
});

test('creates a pending record when any manual gate is not confirmed', async () => {
	await withOutput(async output => {
		await runGenerator(output, [...requiredArgs, ...confirmedGateArgs, ...evidenceArgs, '--narrator', 'false']);
		const attestation = JSON.parse(await readFile(output, 'utf8'));
		assert.equal(attestation.status, 'pending');
		assert.equal(attestation.platforms.windows.screenReader.status, 'pending');
		assert.equal(
			attestation.platforms.windows.screenReader.evidenceRef,
			'https://github.com/baicie/nyala-studio/actions/runs/123456789/artifacts/narrator'
		);
	});
});

test('rejects a missing per-gate evidence reference before writing an attestation', async () => {
	for (const flag of [
		'--macos-keyboard-evidence-ref',
		'--voiceover-evidence-ref',
		'--windows-keyboard-evidence-ref',
		'--narrator-evidence-ref'
	]) {
		await withOutput(async output => {
			const args = [...requiredArgs, ...confirmedGateArgs, ...evidenceArgs];
			args.splice(args.indexOf(flag), 2);
			await assert.rejects(runGenerator(output, args), new RegExp(`${flag} is required`, 'i'));
			await assert.rejects(readFile(output, 'utf8'), /ENOENT/);
		});
	}
});

test('rejects the removed shared evidence references shortcut', async () => {
	await withOutput(async output => {
		await assert.rejects(
			runGenerator(output, [
				...requiredArgs,
				...confirmedGateArgs,
				...evidenceArgs,
				'--evidence-refs',
				'qa://checkpoint-w/shared'
			]),
			/--evidence-refs.*not supported/i
		);
		await assert.rejects(readFile(output, 'utf8'), /ENOENT/);
	});
});

test('rejects a manual evidence reference reused across distinct gates', async () => {
	await withOutput(async output => {
		const args = [...requiredArgs, ...confirmedGateArgs, ...evidenceArgs];
		args[args.indexOf('--voiceover-evidence-ref') + 1] = 'qa://checkpoint-w/macos-keyboard';
		await assert.rejects(runGenerator(output, args), /evidence references.*unique/i);
		await assert.rejects(readFile(output, 'utf8'), /ENOENT/);
	});
});

test('records optional attestation workflow provenance without replacing capture provenance', async () => {
	await withOutput(async output => {
		await runGenerator(output, [
			...requiredArgs,
			...confirmedGateArgs,
			...evidenceArgs,
			'--attestation-workflow-run-id',
			'987654321',
			'--attestation-workflow-run-attempt',
			'3',
			'--attestation-workflow-run-url',
			'https://github.com/baicie/nyala-studio/actions/runs/987654321'
		]);
		const attestation = JSON.parse(await readFile(output, 'utf8'));
		assert.equal(attestation.provenance.workflowRunId, '123456789');
		assert.equal(attestation.provenance.workflowRunAttempt, 2);
		assert.equal(attestation.provenance.attestationWorkflowRunId, '987654321');
		assert.equal(attestation.provenance.attestationWorkflowRunAttempt, 3);
		assert.equal(
			attestation.provenance.attestationWorkflowRunUrl,
			'https://github.com/baicie/nyala-studio/actions/runs/987654321'
		);
	});
});

test('rejects incomplete attestation workflow provenance before writing an attestation', async () => {
	await withOutput(async output => {
		await assert.rejects(
			runGenerator(output, [
				...requiredArgs,
				...confirmedGateArgs,
				...evidenceArgs,
				'--attestation-workflow-run-id',
				'987654321'
			]),
			/attestation workflow provenance must include/i
		);
		await assert.rejects(readFile(output, 'utf8'), /ENOENT/);
	});
});

test('rejects an attestation workflow run that predates the capture run', async () => {
	await withOutput(async output => {
		await assert.rejects(
			runGenerator(output, [
				...requiredArgs,
				...confirmedGateArgs,
				...evidenceArgs,
				'--attestation-workflow-run-id',
				'123456788',
				'--attestation-workflow-run-attempt',
				'1',
				'--attestation-workflow-run-url',
				'https://github.com/baicie/nyala-studio/actions/runs/123456788'
			]),
			/attestation workflow must run after the native capture workflow/i
		);
		await assert.rejects(readFile(output, 'utf8'), /ENOENT/);
	});
});

test('rejects malformed workflow provenance before writing an attestation', async () => {
	await withOutput(async output => {
		const args = [...requiredArgs];
		args[args.indexOf('--source-revision') + 1] = 'not-a-revision';
		await assert.rejects(runGenerator(output, args), /source revision/i);
		await assert.rejects(readFile(output, 'utf8'), /ENOENT/);
	});
});

async function withOutput(run) {
	const root = await mkdtemp(join(tmpdir(), 'nyala-checkpoint-w-attestation-test-'));
	try {
		await run(join(root, 'attestation.json'));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function runGenerator(output, args) {
	return execFileAsync(process.execPath, [
		'scripts/create-sql-agent-checkpoint-w-attestation.mjs',
		'--output',
		output,
		...args
	]);
}
