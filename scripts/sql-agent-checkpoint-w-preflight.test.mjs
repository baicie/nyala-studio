import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
	buildManualAttestationArgs,
	buildManualAttestationOptions,
	classifyPreflightReport,
	evaluateRevisionBinding,
	expectedManualFailureCheckIds,
	resolveRevisionBinding,
	validatePreflightOptions
} from './sql-agent-checkpoint-w-preflight.mjs';

const execFileAsync = promisify(execFile);

test('preflight accepts a machine-side green / manual-side red gate report', () => {
	const classification = classifyPreflightReport(
		createGateReport({
			failed: [...expectedManualFailureCheckIds]
		})
	);
	assert.equal(classification.verdict, 'expected-diagnostic');
	assert.equal(classification.exitCode, 0);
	assert.equal(classification.decision, 'NO-GO');
	assert.deepEqual(
		classification.expectedManualFailures.map(failure => failure.id),
		expectedManualFailureCheckIds
	);
	assert.deepEqual(classification.unexpectedFailures, []);
	assert.equal(classification.machineSideChecksPassed, 6);
});

test('preflight blocks when any machine-side check fails', () => {
	const classification = classifyPreflightReport(
		createGateReport({
			failed: [...expectedManualFailureCheckIds, 'macos-automated-surface']
		})
	);
	assert.equal(classification.verdict, 'machine-side-blocked');
	assert.equal(classification.exitCode, 1);
	assert.deepEqual(
		classification.unexpectedFailures.map(failure => failure.id),
		['macos-automated-surface']
	);
});

test('preflight refuses a GO produced from all-false manual input', () => {
	const classification = classifyPreflightReport(createGateReport({ failed: [], decision: 'GO' }));
	assert.equal(classification.verdict, 'unexpected-go');
	assert.equal(classification.exitCode, 1);
});

test('preflight refuses unexpected manual passes and missing manual gates', () => {
	const passedManual = classifyPreflightReport(
		createGateReport({
			failed: ['manual-attestation', 'macos-native-keyboard', 'windows-native-keyboard', 'windows-narrator']
		})
	);
	assert.equal(passedManual.verdict, 'unexpected-manual-result');
	assert.equal(passedManual.exitCode, 1);
	assert.deepEqual(passedManual.manualChecksPassed, ['macos-voiceover']);

	const missingManual = classifyPreflightReport(
		createGateReport({
			failed: ['manual-attestation', 'macos-native-keyboard', 'macos-voiceover', 'windows-native-keyboard'],
			omit: ['windows-narrator']
		})
	);
	assert.equal(missingManual.verdict, 'unexpected-manual-result');
	assert.deepEqual(missingManual.missingManualChecks, ['windows-narrator']);
});

test('preflight options require a positive run id and stay outside the repository', () => {
	assert.deepEqual(validatePreflightOptions({ 'run-id': '32260211154' }).reasons, []);
	assert.match(validatePreflightOptions({}).reasons.join('; '), /--run-id/);
	assert.match(validatePreflightOptions({ 'run-id': '0' }).reasons.join('; '), /--run-id/);
	assert.match(validatePreflightOptions({ 'run-id': '1.5' }).reasons.join('; '), /--run-id/);
	assert.match(
		validatePreflightOptions({ 'run-id': '123', repository: 'not-a-repository' }).reasons.join('; '),
		/--repository/
	);
	assert.match(validatePreflightOptions({ 'run-id': '123', ref: '..' }).reasons.join('; '), /--ref/);
	const insideRepository = validatePreflightOptions(
		{ 'run-id': '123', dir: join(process.cwd(), 'docs', 'sql-mvp-phases', 'preflight') },
		process.cwd()
	);
	assert.match(insideRepository.reasons.join('; '), /--dir/);
});

test('preflight refuses optional artifact and API paths inside the repository', () => {
	const root = process.cwd();
	for (const flag of ['--artifacts-dir', '--run-json', '--artifacts-json']) {
		const reasons = validatePreflightOptions(
			{ 'run-id': '123', [flag.slice(2)]: join(root, 'tmp', 'nyala-preflight') },
			root
		).reasons;
		assert.ok(reasons.join('; ').includes(flag), `${flag} must be rejected inside the repository`);
	}
	for (const flag of ['--artifacts-dir', '--run-json', '--artifacts-json']) {
		const reasons = validatePreflightOptions(
			{ 'run-id': '123', [flag.slice(2)]: join(tmpdir(), 'nyala-preflight') },
			root
		).reasons;
		assert.deepEqual(reasons, [], `${flag} outside the repository must be accepted`);
	}
});

test('preflight binds the capture revision to the default branch tip', () => {
	const revision = 'a'.repeat(40);
	assert.deepEqual(
		evaluateRevisionBinding({
			ref: 'mvp',
			captureRevision: revision,
			defaultBranch: 'mvp',
			tipRevision: revision
		}),
		{ status: 'match', reason: 'mvp 当前 tip 与 capture revision 一致' }
	);
	assert.equal(
		evaluateRevisionBinding({
			ref: 'mvp',
			captureRevision: revision,
			defaultBranch: 'mvp',
			tipRevision: revision.toUpperCase()
		}).status,
		'match'
	);

	const stale = evaluateRevisionBinding({
		ref: 'mvp',
		captureRevision: revision,
		defaultBranch: 'mvp',
		tipRevision: 'b'.repeat(40)
	});
	assert.equal(stale.status, 'stale');
	assert.match(stale.reason, /不一致/);

	const wrongBranch = evaluateRevisionBinding({
		ref: 'feature/sql-result-grid',
		captureRevision: revision,
		defaultBranch: 'mvp',
		tipRevision: revision
	});
	assert.equal(wrongBranch.status, 'wrong-branch');
	assert.match(wrongBranch.reason, /不是仓库默认分支/);

	assert.equal(evaluateRevisionBinding({ ref: 'mvp', captureRevision: revision }).status, 'unverified');

	const classification = classifyPreflightReport(
		createGateReport({ failed: [...expectedManualFailureCheckIds] }),
		expectedManualFailureCheckIds,
		stale
	);
	assert.equal(classification.verdict, 'stale-revision');
	assert.equal(classification.exitCode, 1);
	assert.equal(classification.revisionBinding.status, 'stale');

	const reasons = validatePreflightOptions({ 'run-id': '123', 'default-branch': 'mvp' }).reasons.join('; ');
	assert.match(reasons, /--default-branch 与 --tip-revision 必须同时提供/);
	assert.match(
		validatePreflightOptions({ 'run-id': '123', 'tip-revision': revision }).reasons.join('; '),
		/--default-branch 与 --tip-revision 必须同时提供/
	);
	assert.match(
		validatePreflightOptions({ 'run-id': '123', 'default-branch': 'bad..name', 'tip-revision': revision }).reasons.join(
			'; '
		),
		/--default-branch 必须是合法分支名/
	);
	assert.match(
		validatePreflightOptions({ 'run-id': '123', 'default-branch': 'mvp', 'tip-revision': 'not-a-sha' }).reasons.join(
			'; '
		),
		/--tip-revision 必须是 40 位 Git SHA/
	);
	assert.deepEqual(
		validatePreflightOptions({ 'run-id': '123', 'default-branch': 'mvp', 'tip-revision': revision.toUpperCase() })
			.reasons,
		[]
	);
});

test('preflight resolves the default branch tip through gh and degrades to unverified', async () => {
	const revision = 'a'.repeat(40);
	const calls = [];
	const ghQuery = async args => {
		calls.push(args);
		if (args[1] === 'repos/baicie/nyala-studio') return 'mvp\n';
		return `${revision}\n`;
	};
	const resolved = await resolveRevisionBinding({
		cli: {},
		repository: 'baicie/nyala-studio',
		ref: 'mvp',
		captureRevision: revision,
		ghQuery
	});
	assert.equal(resolved.status, 'match');
	assert.equal(resolved.source, 'gh-api');
	assert.deepEqual(calls, [
		['api', 'repos/baicie/nyala-studio', '--jq', '.default_branch'],
		['api', 'repos/baicie/nyala-studio/commits/mvp', '--jq', '.sha']
	]);

	const declared = await resolveRevisionBinding({
		cli: { 'default-branch': 'mvp', 'tip-revision': revision },
		repository: 'baicie/nyala-studio',
		ref: 'mvp',
		captureRevision: revision,
		ghQuery: async () => {
			throw new Error('declared mode must not query gh');
		}
	});
	assert.equal(declared.status, 'match');
	assert.equal(declared.source, 'declared');

	const unavailable = await resolveRevisionBinding({
		cli: {},
		repository: 'baicie/nyala-studio',
		ref: 'mvp',
		captureRevision: revision,
		ghQuery: async () => {
			throw new Error('gh unavailable');
		}
	});
	assert.equal(unavailable.status, 'unverified');
	assert.equal(unavailable.source, 'unavailable');
	assert.match(unavailable.reason, /gh api 查询默认分支 tip 失败/);
});

test('preflight diagnostic attestation keeps all four gates false and unique', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'nyala-preflight-attestation-'));
	try {
		const options = buildManualAttestationOptions({
			directory,
			captureRun: {
				provenance: {
					repository: 'baicie/nyala-studio',
					sourceRevision: 'a'.repeat(40),
					sourceRef: 'refs/heads/mvp',
					workflowRunId: '123456789',
					workflowRunAttempt: 1
				}
			}
		});
		assert.deepEqual(Object.values(options.confirmations), ['false', 'false', 'false', 'false']);
		const evidenceRefs = Object.values(options.evidenceRefs);
		assert.equal(new Set(evidenceRefs).size, 4);
		for (const evidenceRef of evidenceRefs)
			assert.match(evidenceRef, /^qa:\/\/local-preflight-not-admission-evidence\//);
		assert.match(options.reviewer, /not-a-signoff/);

		await execFileAsync(process.execPath, buildManualAttestationArgs(options));
		const attestation = JSON.parse(await readFile(options.output, 'utf8'));
		assert.equal(attestation.status, 'pending');
		assert.equal(attestation.provenance.sourceRevision, 'a'.repeat(40));
		assert.equal(attestation.provenance.sourceRef, 'refs/heads/mvp');
		for (const platform of ['macos', 'windows']) {
			assert.equal(attestation.platforms[platform].nativeKeyboard.status, 'pending');
			assert.equal(attestation.platforms[platform].screenReader.status, 'pending');
			assert.equal(attestation.platforms[platform].nativeKeyboard.startCancelReachable, false);
			assert.equal(attestation.platforms[platform].screenReader.labelsAnnounced, false);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

function createGateReport({ failed, omit = [], decision = 'NO-GO' }) {
	const failedIds = new Set(failed);
	const omittedIds = new Set(omit);
	const checkIds = [
		'capture-run-metadata',
		'macos-native-identity',
		'windows-native-identity',
		'macos-automated-surface',
		'windows-automated-surface',
		'provenance-match',
		...expectedManualFailureCheckIds
	].filter(id => !omittedIds.has(id));
	return {
		version: 2,
		decision,
		checks: checkIds.map(id => ({
			id,
			passed: !failedIds.has(id),
			reason: failedIds.has(id) ? `${id} is expected to fail in the diagnostic run` : undefined
		}))
	};
}
