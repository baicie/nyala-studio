import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const repository = 'baicie/nyala-studio';
const sourceRevision = 'a'.repeat(40);
const sourceRef = 'refs/heads/mvp';
const expectedTabOrder = ['Agent prompt', 'Agent task', 'Agent access mode', 'Start Agent run'];

test('Checkpoint W becomes GO only with two native surfaces and complete manual attestation', async () => {
	await withEvidence(async paths => {
		await runVerifier(paths);
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.equal(report.version, 2);
		assert.equal(report.decision, 'GO');
		assert.equal(report.sourceRevision, sourceRevision);
		assert.ok(report.checks.every(check => check.passed));
		assert.deepEqual(report.evidence.macos.frontendSource, {
			kind: 'tauri-asset-protocol',
			url: 'tauri://localhost'
		});
		assert.deepEqual(report.evidence.windows.frontendSource, {
			kind: 'tauri-asset-protocol',
			url: 'https://tauri.localhost/'
		});
		assert.deepEqual(report.evidence.manual.gateEvidence, {
			macosKeyboard: 'qa://checkpoint-w/macos-keyboard',
			voiceOver: 'qa://checkpoint-w/voiceover',
			windowsKeyboard: 'qa://checkpoint-w/windows-keyboard',
			narrator: 'qa://checkpoint-w/narrator'
		});
	});
});

test('Checkpoint W remains NO-GO when manual keyboard and screen-reader evidence is absent', async () => {
	await withEvidence(async paths => {
		await assert.rejects(runVerifier({ ...paths, manual: undefined }));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.equal(report.decision, 'NO-GO');
		assert.ok(report.blockers.some(reason => reason.includes('manual attestation path was not provided')));
	});
});

test('Checkpoint W rejects a forged Windows WebView2 identity', async () => {
	await withEvidence(async paths => {
		const windows = createPlatformEvidence('windows');
		windows.nativeWebView2 = false;
		await writeFile(paths.windows, `${JSON.stringify(windows, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.equal(report.decision, 'NO-GO');
		assert.equal(report.checks.find(check => check.id === 'windows-native-identity')?.passed, false);
	});
});

test('Checkpoint W rejects legacy loopback frontend evidence', async () => {
	await withEvidence(async paths => {
		const macos = createPlatformEvidence('macos');
		macos.frontendSource = { kind: 'local-dist-server', url: 'http://127.0.0.1:54322/' };
		await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(report.checks.find(check => check.id === 'macos-native-identity')?.reason ?? '', /asset protocol/);
	});
});

test('Checkpoint W independently rejects forged and cross-platform asset frontend URLs', async () => {
	for (const frontendSource of [
		{ kind: 'tauri-asset-protocol', url: 'http://127.0.0.1:54322/' },
		{ kind: 'tauri-asset-protocol', url: 'https://tauri.localhost/' },
		{ kind: 'tauri-asset-protocol', url: 'tauri://localhost?capture=forged' },
		{ kind: 'tauri-asset-protocol', url: 'tauri://localhost/' }
	]) {
		await withEvidence(async paths => {
			const macos = createPlatformEvidence('macos');
			macos.frontendSource = frontendSource;
			await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

			await assert.rejects(runVerifier(paths));
			const report = JSON.parse(await readFile(paths.output, 'utf8'));
			assert.match(
				report.checks.find(check => check.id === 'macos-native-identity')?.reason ?? '',
				/asset protocol frontend URL/
			);
		});
	}
});

test('Checkpoint W rejects canonicalized variants of the Windows asset root', async () => {
	for (const url of ['https://tauri.localhost', 'https://tauri.localhost:443/']) {
		await withEvidence(async paths => {
			const windows = createPlatformEvidence('windows');
			windows.frontendSource.url = url;
			await writeFile(paths.windows, `${JSON.stringify(windows, null, 2)}\n`, 'utf8');

			await assert.rejects(runVerifier(paths));
			const report = JSON.parse(await readFile(paths.output, 'utf8'));
			assert.match(
				report.checks.find(check => check.id === 'windows-native-identity')?.reason ?? '',
				/asset protocol frontend URL/
			);
		});
	}
});

test('Checkpoint W requires the SQL Product bootstrap completion contract', async () => {
	await withEvidence(async paths => {
		const macos = createPlatformEvidence('macos');
		delete macos.sqlProductBootstrap;
		await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(report.checks.find(check => check.id === 'macos-native-identity')?.reason ?? '', /bootstrap/);
	});
});

test('Checkpoint W accepts every exact SQL Product bootstrap success sequence', async () => {
	for (const sqlProductBootstrap of [
		{ version: 1, status: 'succeeded', mode: 'restore', completedCommands: ['bootstrapDemo'] },
		{ version: 1, status: 'succeeded', mode: 'onboarding', completedCommands: ['bootstrapDemo'] },
		{
			version: 1,
			status: 'succeeded',
			mode: 'onboarding',
			completedCommands: ['bootstrapDemo', 'focusConnections', 'openResults']
		},
		{
			version: 1,
			status: 'succeeded',
			mode: 'onboarding',
			completedCommands: ['bootstrapDemo', 'focusWelcome', 'newQuery']
		},
		{
			version: 1,
			status: 'succeeded',
			mode: 'onboarding',
			completedCommands: ['bootstrapDemo', 'focusConnections', 'openResults', 'focusWelcome', 'newQuery']
		}
	]) {
		await withEvidence(async paths => {
			const macos = createPlatformEvidence('macos');
			macos.sqlProductBootstrap = sqlProductBootstrap;
			await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

			await runVerifier(paths);
			const report = JSON.parse(await readFile(paths.output, 'utf8'));
			assert.equal(report.decision, 'GO');
			assert.deepEqual(report.evidence.macos.sqlProductBootstrap, sqlProductBootstrap);
		});
	}
});

test('Checkpoint W rejects failed, disposed, malformed, or mode-mismatched SQL Product bootstrap outcomes', async () => {
	for (const sqlProductBootstrap of [
		{
			version: 1,
			status: 'failed',
			mode: 'onboarding',
			completedCommands: [],
			failedStep: 'bootstrapDemo',
			errorCode: 'startup-command-failed'
		},
		{ version: 1, status: 'disposed', mode: 'restore', completedCommands: [] },
		{ version: 2, status: 'succeeded', mode: 'restore', completedCommands: ['bootstrapDemo'] },
		{ version: 1, status: 'succeeded', mode: 'preview', completedCommands: ['bootstrapDemo'] },
		{ version: 1, status: 'succeeded', mode: 'restore', completedCommands: 'bootstrapDemo' },
		{ version: 1, status: 'succeeded', mode: 'restore', completedCommands: ['newQuery'] },
		{
			version: 1,
			status: 'succeeded',
			mode: 'restore',
			completedCommands: ['bootstrapDemo', 'focusWelcome', 'newQuery']
		},
		{
			version: 1,
			status: 'succeeded',
			mode: 'onboarding',
			completedCommands: ['bootstrapDemo', 'newQuery', 'focusWelcome']
		},
		{
			version: 1,
			status: 'succeeded',
			mode: 'onboarding',
			completedCommands: ['bootstrapDemo', 'unknownCommand']
		},
		{
			version: 1,
			status: 'succeeded',
			mode: 'restore',
			completedCommands: ['bootstrapDemo'],
			unexpected: 'private /Users/example/demo.db?token=secret'
		}
	]) {
		await withEvidence(async paths => {
			const macos = createPlatformEvidence('macos');
			macos.sqlProductBootstrap = sqlProductBootstrap;
			await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

			await assert.rejects(runVerifier(paths));
			const reportText = await readFile(paths.output, 'utf8');
			const report = JSON.parse(reportText);
			assert.match(report.checks.find(check => check.id === 'macos-native-identity')?.reason ?? '', /bootstrap/i);
			assert.doesNotMatch(reportText, /private|Users|demo\.db|token=secret/);
		});
	}
});

test('Checkpoint W report preserves only safe bootstrap prepare-failure fields', async () => {
	await withEvidence(async paths => {
		const macos = createPlatformEvidence('macos');
		macos.sqlProductBootstrap = {
			version: 1,
			status: 'failed',
			mode: 'onboarding',
			completedCommands: [],
			failedStep: 'prepare',
			errorCode: 'startup-prepare-failed',
			rawError: 'private /Users/example/demo.db?token=secret'
		};
		await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const reportText = await readFile(paths.output, 'utf8');
		const report = JSON.parse(reportText);
		assert.deepEqual(report.evidence.macos.sqlProductBootstrap, {
			version: 1,
			status: 'failed',
			mode: 'onboarding',
			completedCommands: [],
			failedStep: 'prepare',
			errorCode: 'startup-prepare-failed'
		});
		assert.doesNotMatch(reportText, /private|Users|demo\.db|token=secret/);
	});
});

test('Checkpoint W rejects missing or changed viewport document bindings', async () => {
	for (const mutate of [
		artifact => delete artifact.documentBinding,
		artifact => (artifact.documentBinding.beforeSnapshot.frontendSource.url = 'https://example.test/?token=secret'),
		artifact => (artifact.documentBinding.afterScreenshot.runNonceSha256 = 'f'.repeat(64))
	]) {
		await withEvidence(async paths => {
			const macos = createPlatformEvidence('macos');
			mutate(macos.artifacts[0]);
			await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

			await assert.rejects(runVerifier(paths));
			const report = JSON.parse(await readFile(paths.output, 'utf8'));
			const reason = report.checks.find(check => check.id === 'macos-automated-surface')?.reason ?? '';
			assert.match(reason, /document binding|asset protocol|nonce/i);
			assert.doesNotMatch(reason, /token=secret/);
		});
	}
});

test('Checkpoint W rejects non-keyboard automated failures', async () => {
	await withEvidence(async paths => {
		const macos = createPlatformEvidence('macos');
		macos.artifacts[0].checks.find(check => check.id === 'screenshot-size').passed = false;
		await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.equal(report.decision, 'NO-GO');
		assert.match(report.checks.find(check => check.id === 'macos-automated-surface')?.reason ?? '', /screenshot-size/);
	});
});

test('Checkpoint W rejects evidence and attestation from different revisions', async () => {
	await withEvidence(async paths => {
		const manual = createManualAttestation();
		manual.provenance.sourceRevision = 'b'.repeat(40);
		await writeFile(paths.manual, `${JSON.stringify(manual, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.equal(report.decision, 'NO-GO');
		assert.equal(report.checks.find(check => check.id === 'provenance-match')?.passed, false);
	});
});

test('Checkpoint W requires verified metadata from the exact native capture workflow', async () => {
	await withEvidence(async paths => {
		const captureRun = createCaptureRunMetadata();
		captureRun.workflow.path = '.github/workflows/forged.yml';
		await writeFile(paths.captureRun, `${JSON.stringify(captureRun, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.equal(report.decision, 'NO-GO');
		assert.match(report.checks.find(check => check.id === 'capture-run-metadata')?.reason ?? '', /workflow path/i);
	});
});

test('Checkpoint W rejects manual evidence from a different workflow run', async () => {
	await withEvidence(async paths => {
		const manual = createManualAttestation();
		manual.provenance.workflowRunId = '987654321';
		manual.provenance.workflowRunUrl = 'https://github.com/baicie/nyala-studio/actions/runs/987654321';
		await writeFile(paths.manual, `${JSON.stringify(manual, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.equal(report.checks.find(check => check.id === 'provenance-match')?.passed, false);
		assert.match(report.checks.find(check => check.id === 'provenance-match')?.reason ?? '', /workflowRunId/);
	});
});

test('Checkpoint W rejects a capture artifact whose archive download URL was rewritten or dropped', async () => {
	for (const archiveUrl of [
		'https://api.github.com/repos/attacker/nyala-studio/actions/artifacts/111/zip',
		'https://api.github.com/repos/baicie/nyala-studio/actions/artifacts/222/zip',
		'https://api.github.com/repos/baicie/nyala-studio/actions/artifacts/111/zip?forged=1',
		undefined
	]) {
		await withEvidence(async paths => {
			const captureRun = createCaptureRunMetadata();
			if (archiveUrl === undefined) delete captureRun.artifacts[0].archiveUrl;
			else captureRun.artifacts[0].archiveUrl = archiveUrl;
			await writeFile(paths.captureRun, `${JSON.stringify(captureRun, null, 2)}\n`, 'utf8');

			await assert.rejects(runVerifier(paths));
			const report = JSON.parse(await readFile(paths.output, 'utf8'));
			assert.equal(report.decision, 'NO-GO');
			assert.equal(report.checks.find(check => check.id === 'capture-run-metadata')?.passed, false);
			assert.match(
				report.checks.find(check => check.id === 'capture-run-metadata')?.reason ?? '',
				/archive download URL/i
			);
		});
	}
});

test('Checkpoint W requires attestation to occur in a later workflow run', async () => {
	await withEvidence(async paths => {
		const manual = createManualAttestation();
		manual.provenance.attestationWorkflowRunId = manual.provenance.workflowRunId;
		manual.provenance.attestationWorkflowRunUrl = manual.provenance.workflowRunUrl;
		await writeFile(paths.manual, `${JSON.stringify(manual, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(
			report.checks.find(check => check.id === 'manual-attestation')?.reason ?? '',
			/attestation workflow must run after/
		);
	});
});

test('Checkpoint W rejects an attestation workflow run id older than the capture run', async () => {
	await withEvidence(async paths => {
		const manual = createManualAttestation();
		manual.provenance.attestationWorkflowRunId = '123456788';
		manual.provenance.attestationWorkflowRunUrl = 'https://github.com/baicie/nyala-studio/actions/runs/123456788';
		await writeFile(paths.manual, `${JSON.stringify(manual, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(
			report.checks.find(check => check.id === 'manual-attestation')?.reason ?? '',
			/attestation workflow must run after/
		);
	});
});

test('Checkpoint W rejects one manual evidence reference reused across gates', async () => {
	await withEvidence(async paths => {
		const manual = createManualAttestation();
		manual.platforms.macos.screenReader.evidenceRef = manual.platforms.macos.nativeKeyboard.evidenceRef;
		await writeFile(paths.manual, `${JSON.stringify(manual, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(
			report.checks.find(check => check.id === 'manual-attestation')?.reason ?? '',
			/manual evidence references.*unique/i
		);
	});
});

test('Checkpoint W rejects legacy shared manual evidence instead of gate-local references', async () => {
	await withEvidence(async paths => {
		const manual = createManualAttestation();
		manual.version = 1;
		manual.evidenceRefs = ['qa://checkpoint-w/shared'];
		for (const platform of Object.values(manual.platforms)) {
			delete platform.nativeKeyboard.evidenceRef;
			delete platform.screenReader.evidenceRef;
		}
		await writeFile(paths.manual, `${JSON.stringify(manual, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(report.checks.find(check => check.id === 'manual-attestation')?.reason ?? '', /version 2/);
		assert.equal(report.checks.find(check => check.id === 'macos-native-keyboard')?.passed, false);
	});
});

test('Checkpoint W rejects a missing or unsafe gate-local manual evidence reference', async () => {
	await withEvidence(async paths => {
		const manual = createManualAttestation();
		delete manual.platforms.macos.nativeKeyboard.evidenceRef;
		manual.platforms.windows.screenReader.evidenceRef =
			'https://reviewer:secret@example.test/checkpoint-w?narrator=passed';
		await writeFile(paths.manual, `${JSON.stringify(manual, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		const manualReason = report.checks.find(check => check.id === 'manual-attestation')?.reason ?? '';
		assert.match(manualReason, /macOS keyboard evidence reference/);
		assert.match(manualReason, /Narrator evidence reference/);
		assert.equal(report.checks.find(check => check.id === 'macos-native-keyboard')?.passed, false);
		assert.equal(report.checks.find(check => check.id === 'windows-narrator')?.passed, false);
	});
});

test('Checkpoint W rejects a missing Workbench bounds check', async () => {
	await withEvidence(async paths => {
		const macos = createPlatformEvidence('macos');
		macos.artifacts[0].checks = macos.artifacts[0].checks.filter(check => check.id !== 'viewport-agent-prompt');
		await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(
			report.checks.find(check => check.id === 'macos-automated-surface')?.reason ?? '',
			/viewport-agent-prompt/
		);
	});
});

test('Checkpoint W requires snapshot evidence that Start is enabled and Cancel is disabled', async () => {
	await withEvidence(async paths => {
		const macos = createPlatformEvidence('macos');
		const controls = macos.artifacts[0].snapshot.controls;
		delete controls.find(control => control.ariaLabel === 'Start Agent run').disabled;
		delete controls.find(control => control.ariaLabel === 'Cancel Agent run').disabled;
		await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		const reason = report.checks.find(check => check.id === 'macos-automated-surface')?.reason ?? '';
		assert.match(reason, /Start Agent run.*explicitly enabled/);
		assert.match(reason, /Cancel Agent run.*explicitly disabled/);
	});
});

test('Checkpoint W rejects a snapshot control that overlaps the statusbar', async () => {
	await withEvidence(async paths => {
		const macos = createPlatformEvidence('macos');
		const snapshot = macos.artifacts[0].snapshot;
		snapshot.statusBar = {
			visible: true,
			rect: { left: 0, top: 20, right: 1440, bottom: 40, width: 1440, height: 20 }
		};
		await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(report.checks.find(check => check.id === 'macos-automated-surface')?.reason ?? '', /statusbar/);
	});
});

test('Checkpoint W rejects an Agent root that overlaps the statusbar', async () => {
	await withEvidence(async paths => {
		const macos = createPlatformEvidence('macos');
		const snapshot = macos.artifacts[0].snapshot;
		snapshot.agentRoot.rect = {
			left: 0,
			top: 0,
			right: 1440,
			bottom: 890,
			width: 1440,
			height: 890
		};
		await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(
			report.checks.find(check => check.id === 'macos-automated-surface')?.reason ?? '',
			/Agent root snapshot overlaps the statusbar/
		);
	});
});

test('Checkpoint W tolerates subpixel contact at the statusbar boundary', async () => {
	await withEvidence(async paths => {
		const macos = createPlatformEvidence('macos');
		const snapshot = macos.artifacts[0].snapshot;
		const statusTop = snapshot.statusBar.rect.top;
		snapshot.agentRoot.rect = {
			...snapshot.agentRoot.rect,
			bottom: statusTop + 0.05,
			height: statusTop + 0.05 - snapshot.agentRoot.rect.top
		};
		await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

		await runVerifier(paths);
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.equal(report.checks.find(check => check.id === 'macos-automated-surface')?.passed, true);
	});
});

test('Checkpoint W rejects Agent status text hidden by the statusbar', async () => {
	await withEvidence(async paths => {
		const macos = createPlatformEvidence('macos');
		const snapshot = macos.artifacts[0].snapshot;
		snapshot.statusElement.rect.bottom = snapshot.statusBar.rect.top + 0.11;
		snapshot.statusElement.rect.height = snapshot.statusElement.rect.bottom - snapshot.statusElement.rect.top;
		await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(
			report.checks.find(check => check.id === 'macos-automated-surface')?.reason ?? '',
			/Agent status snapshot overlaps the statusbar/
		);
	});
});

test('Checkpoint W rejects Agent status text that overflows its visible area', async () => {
	await withEvidence(async paths => {
		const macos = createPlatformEvidence('macos');
		macos.artifacts[0].snapshot.statusElement.contentFits = false;
		await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(
			report.checks.find(check => check.id === 'macos-automated-surface')?.reason ?? '',
			/Agent status text overflows/
		);
	});
});

test('Checkpoint W rejects a snapshot without statusbar geometry', async () => {
	await withEvidence(async paths => {
		const macos = createPlatformEvidence('macos');
		delete macos.artifacts[0].snapshot.statusBar;
		await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(
			report.checks.find(check => check.id === 'macos-automated-surface')?.reason ?? '',
			/statusbar snapshot/
		);
	});
});

test('Checkpoint W rejects statusbar geometry outside the viewport', async () => {
	await withEvidence(async paths => {
		const macos = createPlatformEvidence('macos');
		const snapshot = macos.artifacts[0].snapshot;
		snapshot.statusBar.rect = {
			left: 0,
			top: 900,
			right: 1440,
			bottom: 924,
			width: 1440,
			height: 24
		};
		await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(
			report.checks.find(check => check.id === 'macos-automated-surface')?.reason ?? '',
			/statusbar snapshot is outside the viewport/
		);
	});
});

test('Checkpoint W rejects a snapshot without notification overlay geometry', async () => {
	await withEvidence(async paths => {
		const macos = createPlatformEvidence('macos');
		delete macos.artifacts[0].snapshot.notificationOverlays;
		await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(
			report.checks.find(check => check.id === 'macos-automated-surface')?.reason ?? '',
			/notification overlay snapshot is missing/
		);
	});
});

test('Checkpoint W independently rejects a warning toast that occludes the Agent surface', async () => {
	await withEvidence(async paths => {
		const macos = createPlatformEvidence('macos');
		macos.artifacts[0].snapshot.notificationOverlays.push({
			kind: 'toast',
			severity: 'warning',
			visible: true,
			rect: { left: 10, top: 10, right: 110, bottom: 50, width: 100, height: 40 }
		});
		await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		const reason = report.checks.find(check => check.id === 'macos-automated-surface')?.reason ?? '';
		assert.match(reason, /notification toast overlaps the Agent root/);
		assert.match(reason, /notification toast overlaps Start Agent run/);
	});
});

test('Checkpoint W independently rejects a visible error notification outside the Agent surface', async () => {
	await withEvidence(async paths => {
		const macos = createPlatformEvidence('macos');
		macos.artifacts[0].snapshot.notificationOverlays.push({
			kind: 'toast',
			severity: 'error',
			visible: true,
			rect: { left: 1200, top: 100, right: 1400, bottom: 200, width: 200, height: 100 }
		});
		await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(
			report.checks.find(check => check.id === 'macos-automated-surface')?.reason ?? '',
			/visible error notification toast/
		);
	});
});

test('Checkpoint W rejects a screenshot whose artifact bytes do not match the manifest hash', async () => {
	await withEvidence(async paths => {
		await writeFile(join(paths.root, 'screenshots', 'sql-agent-macos-desktop.png'), 'tampered-png', 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(report.checks.find(check => check.id === 'macos-automated-surface')?.reason ?? '', /SHA-256/);
	});
});

test('Checkpoint W rejects screenshot bytes that hash correctly but are not a PNG', async () => {
	await withEvidence(async paths => {
		const bytes = Buffer.from('not-a-png', 'utf8');
		const macos = createPlatformEvidence('macos');
		const artifact = macos.artifacts.find(candidate => candidate.requestedViewport.id === 'desktop');
		artifact.screenshotBytes = bytes.byteLength;
		artifact.screenshotSha256 = createHash('sha256').update(bytes).digest('hex');
		await Promise.all([
			writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8'),
			writeFile(join(paths.root, 'screenshots', artifact.screenshot), bytes)
		]);

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(report.checks.find(check => check.id === 'macos-automated-surface')?.reason ?? '', /PNG/);
	});
});

test('Checkpoint W rejects parsed PNG dimensions that do not match the viewport and DPR', async () => {
	await withEvidence(async paths => {
		const bytes = createRgbPng(100, 100);
		const macos = createPlatformEvidence('macos');
		const artifact = macos.artifacts.find(candidate => candidate.requestedViewport.id === 'desktop');
		artifact.screenshotBytes = bytes.byteLength;
		artifact.screenshotSha256 = createHash('sha256').update(bytes).digest('hex');
		await Promise.all([
			writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8'),
			writeFile(join(paths.root, 'screenshots', artifact.screenshot), bytes)
		]);

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(report.checks.find(check => check.id === 'macos-automated-surface')?.reason ?? '', /PNG dimensions/);
	});
});

test('Checkpoint W rejects a forged viewport calibration that did not converge', async () => {
	await withEvidence(async paths => {
		const macos = createPlatformEvidence('macos');
		macos.artifacts[0].viewportConverged = false;
		macos.artifacts[0].convergenceStoppedReason = 'max-attempts';
		await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(
			report.checks.find(check => check.id === 'macos-automated-surface')?.reason ?? '',
			/calibration.*converge/i
		);
	});
});

test('Checkpoint W binds snapshot viewport and DPR to the calibrated artifact viewport', async () => {
	await withEvidence(async paths => {
		const windows = createPlatformEvidence('windows');
		windows.artifacts[0].snapshot.viewportWidth = 800;
		windows.artifacts[0].snapshot.viewportHeight = 600;
		windows.artifacts[0].snapshot.devicePixelRatio = 2;
		await writeFile(paths.windows, `${JSON.stringify(windows, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(
			report.checks.find(check => check.id === 'windows-automated-surface')?.reason ?? '',
			/snapshot viewport.*DPR/i
		);
	});
});

test('Checkpoint W rejects a dimensionally valid PNG with uniform pixels', async () => {
	await withEvidence(async paths => {
		const bytes = createRgbPng(1440, 900, 0, true);
		const macos = createPlatformEvidence('macos');
		const artifact = macos.artifacts.find(candidate => candidate.requestedViewport.id === 'desktop');
		artifact.screenshotBytes = bytes.byteLength;
		artifact.screenshotSha256 = createHash('sha256').update(bytes).digest('hex');
		await Promise.all([
			writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8'),
			writeFile(join(paths.root, 'screenshots', artifact.screenshot), bytes)
		]);

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.match(report.checks.find(check => check.id === 'macos-automated-surface')?.reason ?? '', /pixel diversity/);
	});
});

test('Checkpoint W rejects unknown evidence schema versions', async () => {
	await withEvidence(async paths => {
		const macos = createPlatformEvidence('macos');
		macos.version = 99;
		await writeFile(paths.macos, `${JSON.stringify(macos, null, 2)}\n`, 'utf8');

		await assert.rejects(runVerifier(paths));
		const report = JSON.parse(await readFile(paths.output, 'utf8'));
		assert.equal(report.decision, 'NO-GO');
		assert.match(report.checks.find(check => check.id === 'macos-native-identity')?.reason ?? '', /version 2/);
	});
});

async function withEvidence(run) {
	const root = await mkdtemp(join(tmpdir(), 'nyala-checkpoint-w-test-'));
	const paths = {
		root,
		macos: join(root, 'macos.json'),
		windows: join(root, 'windows.json'),
		manual: join(root, 'manual.json'),
		captureRun: join(root, 'capture-run.json'),
		output: join(root, 'checkpoint-w.json')
	};
	try {
		await mkdir(join(root, 'screenshots'));
		await Promise.all([
			writeFile(paths.macos, `${JSON.stringify(createPlatformEvidence('macos'), null, 2)}\n`, 'utf8'),
			writeFile(paths.windows, `${JSON.stringify(createPlatformEvidence('windows'), null, 2)}\n`, 'utf8'),
			writeFile(paths.manual, `${JSON.stringify(createManualAttestation(), null, 2)}\n`, 'utf8'),
			writeFile(paths.captureRun, `${JSON.stringify(createCaptureRunMetadata(), null, 2)}\n`, 'utf8'),
			...['macos', 'windows'].flatMap(platform =>
				['desktop', 'narrow'].map(id =>
					writeFile(join(root, 'screenshots', `sql-agent-${platform}-${id}.png`), screenshotBytes(platform, id))
				)
			)
		]);
		await run(paths);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function runVerifier({ macos, windows, manual, captureRun, output }) {
	const args = [
		'scripts/verify-sql-agent-checkpoint-w.mjs',
		'--macos',
		macos,
		'--windows',
		windows,
		'--capture-run',
		captureRun,
		'--output',
		output,
		'--expected-repository',
		repository,
		'--expected-revision',
		sourceRevision,
		'--expected-ref',
		sourceRef
	];
	if (manual) args.push('--manual', manual);
	return execFileAsync(process.execPath, args);
}

function createCaptureRunMetadata() {
	const provenance = {
		repository,
		sourceRevision,
		sourceRef,
		workflowRunId: '123456789',
		workflowRunAttempt: 1
	};
	return {
		version: 1,
		generatedAt: '2026-08-16T02:30:00.000Z',
		status: 'verified',
		workflow: {
			id: '987654',
			name: 'SQL Agent Native Workbench Capture',
			path: '.github/workflows/sql-agent-native.yml',
			event: 'workflow_dispatch'
		},
		run: {
			id: provenance.workflowRunId,
			attempt: provenance.workflowRunAttempt,
			status: 'completed',
			conclusion: 'success',
			headSha: sourceRevision,
			headBranch: 'mvp',
			runStartedAt: '2026-08-16T01:00:00.000Z',
			updatedAt: '2026-08-16T02:00:00.000Z',
			htmlUrl: 'https://github.com/baicie/nyala-studio/actions/runs/123456789'
		},
		provenance,
		artifacts: [
			{
				id: '111',
				name: 'sql-agent-native-macos',
				bytes: 4096,
				digest: 'd'.repeat(64),
				archiveUrl: 'https://api.github.com/repos/baicie/nyala-studio/actions/artifacts/111/zip',
				createdAt: '2026-08-16T01:30:00.000Z',
				updatedAt: '2026-08-16T01:31:00.000Z'
			},
			{
				id: '222',
				name: 'sql-agent-native-windows',
				bytes: 4096,
				digest: 'e'.repeat(64),
				archiveUrl: 'https://api.github.com/repos/baicie/nyala-studio/actions/artifacts/222/zip',
				createdAt: '2026-08-16T01:30:00.000Z',
				updatedAt: '2026-08-16T01:31:00.000Z'
			}
		],
		artifactIds: ['111', '222'],
		reasons: []
	};
}

function createPlatformEvidence(platform) {
	const windows = platform === 'windows';
	return {
		version: 2,
		generatedAt: '2026-08-16T02:00:00.000Z',
		label: windows ? 'Windows WebView2 SQL Agent' : 'macOS WKWebView SQL Agent',
		status: 'ready',
		automatedSurfaceStatus: 'ready',
		checkpointDecision: 'BLOCKED',
		reason: 'Native surface passed; manual gates remain pending.',
		driverProvider: 'embedded',
		nativeWebView: true,
		nativeWebView2: windows,
		engine: windows ? 'webview2-embedded' : 'wkwebview-embedded',
		browser: windows ? 'msedge' : 'webkit',
		platformName: platform,
		provenance: {
			repository,
			sourceRevision,
			sourceRef,
			workflowRunId: '123456789',
			workflowRunAttempt: 1,
			binarySha256: windows ? 'c'.repeat(64) : 'b'.repeat(64)
		},
		webdriverOwnership: {
			driverUrl: 'http://127.0.0.1:54321',
			portSource: 'os-assigned',
			runNonceVerified: true,
			runNonceSha256: '9'.repeat(64)
		},
		sqlProductBootstrap: {
			version: 1,
			status: 'succeeded',
			mode: 'onboarding',
			completedCommands: ['bootstrapDemo', 'focusConnections', 'openResults', 'focusWelcome', 'newQuery']
		},
		frontendSource: {
			kind: 'tauri-asset-protocol',
			url: windows ? 'https://tauri.localhost/' : 'tauri://localhost'
		},
		manualGates: {
			nativeKeyboard: 'pending',
			screenReader: 'pending'
		},
		artifacts: [
			createViewportArtifact(platform, 'desktop', 1440, 900),
			createViewportArtifact(platform, 'narrow', 390, 844)
		]
	};
}

function createViewportArtifact(platform, id, width, height) {
	const controlLabels = ['Agent prompt', 'Agent task', 'Agent access mode', 'Start Agent run', 'Cancel Agent run'];
	const rect = { left: 10, top: 10, right: 110, bottom: 50, width: 100, height: 40 };
	return {
		requestedViewport: { id, width, height },
		requestedCssViewport: { width, height },
		initialWindowRect: { width, height },
		lastAppliedRequestedWindowRect: { width, height },
		devicePixelRatio: 1,
		appliedWindowRect: { width, height },
		observedCssViewport: { width, height },
		viewportConverged: true,
		viewportTolerance: 1,
		convergenceStoppedReason: 'target-reached',
		calibrationAttempts: [
			{
				attempt: 1,
				requestedWindowRect: { width, height },
				appliedWindowRect: { width, height },
				observedCssViewport: { width, height }
			}
		],
		viewport: { id, width, height, devicePixelRatio: 1 },
		status: 'ready',
		automatedSurfaceStatus: 'ready',
		documentBinding: {
			beforeSnapshot: {
				frontendSource: {
					kind: 'tauri-asset-protocol',
					url: platform === 'windows' ? 'https://tauri.localhost/' : 'tauri://localhost'
				},
				runNonceSha256: '9'.repeat(64)
			},
			afterScreenshot: {
				frontendSource: {
					kind: 'tauri-asset-protocol',
					url: platform === 'windows' ? 'https://tauri.localhost/' : 'tauri://localhost'
				},
				runNonceSha256: '9'.repeat(64)
			}
		},
		screenshot: `sql-agent-${platform}-${id}.png`,
		screenshotBytes: screenshotBytes(platform, id).byteLength,
		screenshotSha256: createHash('sha256').update(screenshotBytes(platform, id)).digest('hex'),
		snapshot: {
			workbenchReady: true,
			viewportWidth: width,
			viewportHeight: height,
			devicePixelRatio: 1,
			primarySidebarVisible: id !== 'narrow',
			agentRoot: { visible: true, rect },
			statusElement: {
				visible: true,
				rect: { left: 10, top: height - 42, right: 110, bottom: height - 24, width: 100, height: 18 },
				contentFits: true
			},
			statusBar: {
				visible: true,
				rect: { left: 0, top: height - 24, right: width, bottom: height, width, height: 24 }
			},
			notificationOverlays: [],
			ariaLabels: [
				'Agent prompt',
				'Agent task',
				'Agent access mode',
				'Start Agent run',
				'Cancel Agent run',
				'Agent evidence',
				'Agent activity',
				'Agent warnings'
			],
			controls: controlLabels.map(ariaLabel => ({
				ariaLabel,
				disabled: ariaLabel === 'Cancel Agent run',
				visible: true,
				rect
			})),
			status: 'Ready.',
			fatalScreen: false
		},
		checks: [
			{ id: 'workbench-ready', passed: true, scope: 'automated', reason: 'ready' },
			{ id: 'statusbar-bounds', passed: true, scope: 'automated', reason: 'bounded' },
			{ id: 'notification-overlay-bounds', passed: true, scope: 'automated', reason: 'bounded' },
			{ id: 'no-visible-error-notifications', passed: true, scope: 'automated', reason: 'absent' },
			...(id === 'narrow'
				? [{ id: 'narrow-focused-layout', passed: true, scope: 'automated', reason: 'focused' }]
				: []),
			{ id: 'agent-root-visible', passed: true, scope: 'automated', reason: 'visible' },
			{ id: 'agent-root-bounds', passed: true, scope: 'automated', reason: 'bounded' },
			{ id: 'aria-agent-prompt', passed: true, scope: 'automated', reason: 'present' },
			{ id: 'aria-agent-task', passed: true, scope: 'automated', reason: 'present' },
			{ id: 'aria-agent-access-mode', passed: true, scope: 'automated', reason: 'present' },
			{ id: 'aria-start-agent-run', passed: true, scope: 'automated', reason: 'present' },
			{ id: 'aria-cancel-agent-run', passed: true, scope: 'automated', reason: 'present' },
			{ id: 'aria-agent-evidence', passed: true, scope: 'automated', reason: 'present' },
			{ id: 'aria-agent-activity', passed: true, scope: 'automated', reason: 'present' },
			{ id: 'aria-agent-warnings', passed: true, scope: 'automated', reason: 'present' },
			...controlLabels.flatMap(label => {
				const slug = label
					.toLowerCase()
					.replaceAll(/[^a-z0-9]+/g, '-')
					.replaceAll(/(^-|-$)/g, '');
				return [
					{ id: `visible-${slug}`, passed: true, scope: 'automated', reason: 'visible' },
					{ id: `viewport-${slug}`, passed: true, scope: 'automated', reason: 'bounded' }
				];
			}),
			{ id: 'start-enabled', passed: true, scope: 'automated', reason: 'enabled' },
			{ id: 'cancel-disabled', passed: true, scope: 'automated', reason: 'disabled' },
			{ id: 'ready-status', passed: true, scope: 'automated', reason: 'ready' },
			{ id: 'no-fatal-screen', passed: true, scope: 'automated', reason: 'absent' },
			{ id: 'requested-viewport', passed: true, scope: 'automated', reason: 'matched' },
			{ id: 'screenshot-size', passed: true, scope: 'automated', reason: 'matched' },
			{ id: 'screenshot-pixel-diversity', passed: true, scope: 'automated', reason: 'visible' },
			{
				id: 'keyboard-tab-order',
				passed: false,
				scope: 'manual',
				reason: 'synthetic input cannot prove native traversal'
			},
			{
				id: 'native-keyboard-evidence',
				passed: false,
				scope: 'manual',
				reason: 'manual evidence required'
			}
		]
	};
}

function screenshotBytes(platform, id) {
	const key = `${platform}:${id}`;
	let bytes = screenshotFixtureCache.get(key);
	if (!bytes) {
		const viewport = id === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 };
		bytes = createRgbPng(viewport.width, viewport.height, platform === 'windows' ? 1 : 0);
		screenshotFixtureCache.set(key, bytes);
	}
	return bytes;
}

const screenshotFixtureCache = new Map();

function createRgbPng(width, height, phase = 0, uniform = false) {
	const colors = uniform
		? [[48, 132, 196]]
		: [
				[16, 24, 32],
				[48, 132, 196],
				[214, 218, 224],
				[196, 48, 72]
			];
	const rows = [];
	for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
		const row = Buffer.alloc(width * 3 + 1);
		for (let columnIndex = 0; columnIndex < width; columnIndex += 1) {
			const color = colors[(Math.floor(columnIndex / 24) + Math.floor(rowIndex / 24) + phase) % colors.length];
			const offset = columnIndex * 3 + 1;
			row[offset] = color[0];
			row[offset + 1] = color[1];
			row[offset + 2] = color[2];
		}
		rows.push(row);
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', header),
		pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
		pngChunk('IEND', Buffer.alloc(0))
	]);
}

function pngChunk(type, data) {
	const typeBytes = Buffer.from(type, 'ascii');
	const chunk = Buffer.alloc(data.byteLength + 12);
	chunk.writeUInt32BE(data.byteLength, 0);
	typeBytes.copy(chunk, 4);
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.byteLength + 8);
	return chunk;
}

function crc32(bytes) {
	let checksum = 0xffffffff;
	for (const byte of bytes) {
		checksum ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
		}
	}
	return (checksum ^ 0xffffffff) >>> 0;
}

function createManualAttestation() {
	return {
		version: 2,
		status: 'attested',
		provenance: {
			repository,
			sourceRevision,
			sourceRef,
			workflowRunId: '123456789',
			workflowRunAttempt: 1,
			reviewer: 'nyala-qa',
			reviewedAt: '2026-08-16T03:00:00.000Z',
			workflowRunUrl: 'https://github.com/baicie/nyala-studio/actions/runs/123456789',
			attestationWorkflowRunId: '223456789',
			attestationWorkflowRunAttempt: 1,
			attestationWorkflowRunUrl: 'https://github.com/baicie/nyala-studio/actions/runs/223456789'
		},
		platforms: {
			macos: createManualPlatform('VoiceOver', 'macos'),
			windows: createManualPlatform('Narrator', 'windows')
		}
	};
}

function createManualPlatform(screenReader, platform) {
	return {
		nativeKeyboard: {
			status: 'passed',
			focusOrder: expectedTabOrder,
			startCancelReachable: true,
			noFocusTrap: true,
			evidenceRef: `qa://checkpoint-w/${platform}-keyboard`
		},
		screenReader: {
			status: 'passed',
			assistiveTechnology: screenReader,
			labelsAnnounced: true,
			stateChangesAnnounced: true,
			noFocusTrap: true,
			evidenceRef: `qa://checkpoint-w/${screenReader.toLowerCase()}`
		}
	};
}
