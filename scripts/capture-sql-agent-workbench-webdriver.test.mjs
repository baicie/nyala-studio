import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
	createAssetProtocolDocumentBinding,
	createTauriAssetFrontendSource,
	describeUntrustedUrl,
	evaluateAutomatedSurfaceChecks,
	executeWorkbenchCommandAndWait,
	initialWindowRectForNativeViewport,
	normalizeSqlProductBootstrapOutcome,
	shouldOpenAgentPanel,
	validateSqlProductBootstrapOutcome,
	validateRequestedViewport,
	validateScreenshotPhysicalDimensions,
	validateWebdriverRunNonce,
	waitForManualReview
} from './capture-sql-agent-workbench-webdriver.mjs';
import {
	allocateLoopbackDriverUrl,
	calibrateWindowRectForCssViewport,
	convergeWindowRectForCssViewport,
	createTauriWebdriverEnvironment,
	createWebdriverRunNonce,
	parseLoopbackDriverUrl,
	resolveLoopbackDriverEndpoint,
	unwrapWebdriverValue
} from './tauri-embedded-webdriver.mjs';

test('native Agent surface status excludes only declared manual keyboard gates', () => {
	assert.deepEqual(
		evaluateAutomatedSurfaceChecks([
			{ id: 'workbench-ready', passed: true, scope: 'automated' },
			{ id: 'keyboard-tab-order', passed: false, scope: 'manual' },
			{ id: 'native-keyboard-evidence', passed: false, scope: 'manual' }
		]),
		{ status: 'ready', failedCheckIds: [] }
	);
	assert.deepEqual(
		evaluateAutomatedSurfaceChecks([
			{ id: 'workbench-ready', passed: false, scope: 'automated' },
			{ id: 'native-keyboard-evidence', passed: false, scope: 'manual' }
		]),
		{ status: 'blocked', failedCheckIds: ['workbench-ready'] }
	);
});

test('native Agent panel command runs only when the panel is hidden', () => {
	assert.equal(shouldOpenAgentPanel(false), true);
	assert.equal(shouldOpenAgentPanel(true), false);
});

test('Windows narrow native capture compensates for the WebView2 frame inset', () => {
	assert.deepEqual(initialWindowRectForNativeViewport('windows', { id: 'narrow', width: 390, height: 844 }), {
		width: 406,
		height: 852
	});
	assert.deepEqual(initialWindowRectForNativeViewport('macos', { id: 'narrow', width: 390, height: 844 }), {
		width: 390,
		height: 844
	});
});

test('Windows narrow native capture converges to the exact CSS viewport from the frame inset', async () => {
	const result = await convergeWindowRectForCssViewport(
		{ width: 390, height: 844 },
		async requestedWindowRect => ({
			appliedWindowRect: requestedWindowRect,
			observedCssViewport: {
				width: requestedWindowRect.width - 16,
				height: requestedWindowRect.height - 8
			}
		}),
		{ initialWindowRect: initialWindowRectForNativeViewport('windows', { id: 'narrow', width: 390, height: 844 }) }
	);

	assert.equal(result.viewportConverged, true);
	assert.deepEqual(result.observedCssViewport, { width: 390, height: 844 });
	assert.deepEqual(result.lastAppliedRequestedWindowRect, { width: 406, height: 852 });
	assert.equal(result.calibrationAttempts.length, 1);
});

test('native Agent capture rejects a viewport that only matches calibration tolerance', () => {
	const calibration = { viewportConverged: true };
	assert.equal(
		validateRequestedViewport({ id: 'narrow', width: 390, height: 844 }, { width: 390, height: 844 }, calibration)
			.passed,
		true
	);
	assert.equal(
		validateRequestedViewport({ id: 'narrow', width: 390, height: 844 }, { width: 391, height: 844 }, calibration)
			.passed,
		false
	);
});

test('native Agent frontend source accepts only the configured platform asset roots', () => {
	assert.deepEqual(createTauriAssetFrontendSource('tauri://localhost', 'macos'), {
		kind: 'tauri-asset-protocol',
		url: 'tauri://localhost'
	});
	assert.deepEqual(createTauriAssetFrontendSource('https://tauri.localhost/', 'windows'), {
		kind: 'tauri-asset-protocol',
		url: 'https://tauri.localhost/'
	});
});

test('native Agent frontend source rejects transient, loopback, cross-platform, and modified URLs', () => {
	for (const [url, platform] of [
		['about:blank', 'macos'],
		['http://127.0.0.1:1420/', 'macos'],
		['https://tauri.localhost/', 'macos'],
		['tauri://localhost', 'windows'],
		['tauri://localhost/', 'macos'],
		['https://tauri.localhost', 'windows'],
		['https://tauri.localhost:443/', 'windows'],
		['https://tauri.localhost/workbench', 'windows'],
		['https://tauri.localhost/?capture=forged', 'windows'],
		['https://tauri.localhost/#capture', 'windows'],
		['https://user@tauri.localhost/', 'windows']
	]) {
		assert.throws(() => createTauriAssetFrontendSource(url, platform), /asset protocol frontend URL/);
	}
});

test('native Agent frontend errors classify unknown URLs without persisting secrets', () => {
	const secretUrl = 'https://user:password@example.test/private/query?token=secret#fragment';

	assert.equal(describeUntrustedUrl(secretUrl), 'scheme=https: host=example.test');
	assert.throws(
		() => createTauriAssetFrontendSource(secretUrl, 'windows'),
		error => {
			assert.match(error.message, /scheme=https: host=example\.test/);
			assert.doesNotMatch(error.message, /user|password|private|token|secret|fragment/);
			return true;
		}
	);
});

test('native Agent document binding requires the exact asset URL and run nonce', () => {
	const nonce = 'a'.repeat(64);
	assert.deepEqual(createAssetProtocolDocumentBinding('tauri://localhost', 'macos', nonce, nonce), {
		frontendSource: { kind: 'tauri-asset-protocol', url: 'tauri://localhost' },
		runNonceSha256: 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb'
	});
	assert.throws(
		() => createAssetProtocolDocumentBinding('tauri://localhost', 'macos', nonce, 'b'.repeat(64)),
		/ownership nonce did not match/
	);
});

test('native Agent bootstrap outcome normalization keeps only the versioned contract', () => {
	assert.deepEqual(
		normalizeSqlProductBootstrapOutcome({
			version: 1,
			status: 'succeeded',
			mode: 'onboarding',
			completedCommands: ['bootstrapDemo', 'focusConnections', 'openResults', 'focusWelcome', 'newQuery'],
			rawError: 'private /Users/example/demo.db'
		}),
		{
			version: 1,
			status: 'succeeded',
			mode: 'onboarding',
			completedCommands: ['bootstrapDemo', 'focusConnections', 'openResults', 'focusWelcome', 'newQuery']
		}
	);
	assert.deepEqual(
		normalizeSqlProductBootstrapOutcome({
			version: 1,
			status: 'failed',
			mode: 'onboarding',
			completedCommands: ['bootstrapDemo'],
			failedStep: 'focusConnections',
			errorCode: 'startup-command-failed',
			error: 'password=secret'
		}),
		{
			version: 1,
			status: 'failed',
			mode: 'onboarding',
			completedCommands: ['bootstrapDemo'],
			failedStep: 'focusConnections',
			errorCode: 'startup-command-failed'
		}
	);
	assert.deepEqual(
		normalizeSqlProductBootstrapOutcome({
			version: 1,
			status: 'disposed',
			mode: 'restore',
			completedCommands: []
		}),
		{ version: 1, status: 'disposed', mode: 'restore', completedCommands: [] }
	);
});

test('native Agent capture accepts only a valid successful bootstrap outcome', () => {
	const outcome = {
		version: 1,
		status: 'succeeded',
		mode: 'onboarding',
		completedCommands: ['bootstrapDemo', 'focusConnections', 'openResults', 'focusWelcome', 'newQuery']
	};
	assert.deepEqual(validateSqlProductBootstrapOutcome(outcome), outcome);
	for (const outcomeStatus of [
		{
			version: 1,
			status: 'failed',
			mode: 'onboarding',
			completedCommands: [],
			failedStep: 'bootstrapDemo',
			errorCode: 'startup-command-failed'
		},
		{ version: 1, status: 'disposed', mode: 'restore', completedCommands: [] }
	]) {
		assert.throws(
			() => validateSqlProductBootstrapOutcome(outcomeStatus),
			error => {
				assert.match(error.message, /did not succeed/);
				return true;
			}
		);
	}
});

test('native Agent bootstrap outcome normalization fails closed without echoing malformed values', () => {
	for (const outcome of [
		null,
		{ version: 2, status: 'succeeded', mode: 'restore', completedCommands: ['bootstrapDemo'] },
		{ version: 1, status: 'complete', mode: 'restore', completedCommands: ['bootstrapDemo'] },
		{ version: 1, status: 'succeeded', mode: 'private-mode', completedCommands: ['bootstrapDemo'] },
		{ version: 1, status: 'succeeded', mode: 'restore', completedCommands: ['newQuery'] },
		{
			version: 1,
			status: 'failed',
			mode: 'onboarding',
			completedCommands: [],
			failedStep: 'bootstrapDemo',
			errorCode: 'private /Users/example/demo.db'
		},
		{
			version: 1,
			status: 'disposed',
			mode: 'restore',
			completedCommands: [],
			errorCode: 'unexpected-bootstrap-rejection'
		}
	]) {
		assert.throws(
			() => normalizeSqlProductBootstrapOutcome(outcome),
			error => {
				assert.match(error.message, /malformed/);
				assert.doesNotMatch(error.message, /private|Users|demo\.db/);
				return true;
			}
		);
	}
});

test('manual review holds a TTY until Enter without claiming attestation', async () => {
	const input = new PassThrough();
	input.isTTY = true;
	const messages = [];
	const output = { write: message => messages.push(String(message)) };

	const review = waitForManualReview({ input, output });
	input.write('\n');
	await review;

	assert.match(messages.join(''), /manual gates remain pending/i);
	assert.match(messages.join(''), /Press Enter to close/i);
	assert.equal(input.listenerCount('data'), 0);
});

test('manual review rejects a non-interactive input instead of hanging CI', async () => {
	await assert.rejects(
		waitForManualReview({ input: new PassThrough(), output: { write: () => undefined } }),
		/interactive TTY/
	);
});

test('CSS viewport calibration derives DPR scaling from the observed viewport', () => {
	assert.deepEqual(
		calibrateWindowRectForCssViewport(
			{ width: 1440, height: 900 },
			{ width: 720, height: 450 },
			{ width: 1440, height: 900 }
		),
		{ width: 2880, height: 1800 }
	);
	assert.deepEqual(
		calibrateWindowRectForCssViewport(
			{ width: 1440, height: 900 },
			{ width: 1440, height: 900 },
			{ width: 1440, height: 900 }
		),
		{ width: 1440, height: 900 }
	);
});

test('CSS viewport calibration converges with DPR scaling and window chrome offsets', async () => {
	const target = { width: 1440, height: 900 };
	const appliedRequests = [];
	const result = await convergeWindowRectForCssViewport(target, async requestedWindowRect => {
		appliedRequests.push(requestedWindowRect);
		return {
			appliedWindowRect: requestedWindowRect,
			observedCssViewport: {
				width: (requestedWindowRect.width - 32) / 2,
				height: (requestedWindowRect.height - 48) / 2
			}
		};
	});

	assert.equal(result.viewportConverged, true);
	assert.equal(result.convergenceStoppedReason, 'target-reached');
	assert.deepEqual(result.lastAppliedRequestedWindowRect, appliedRequests.at(-1));
	assert.deepEqual(result.observedCssViewport, { width: 1440, height: 899.5 });
	assert.equal(result.calibrationAttempts.length, 3);
});

test('CSS viewport calibration reports non-convergence without recording an unapplied next rect', async () => {
	const appliedRequests = [];
	const result = await convergeWindowRectForCssViewport(
		{ width: 100, height: 100 },
		async requestedWindowRect => {
			appliedRequests.push(requestedWindowRect);
			return {
				appliedWindowRect: requestedWindowRect,
				observedCssViewport: { width: 50, height: 50 }
			};
		},
		{ maxAttempts: 2 }
	);

	assert.equal(result.viewportConverged, false);
	assert.equal(result.convergenceStoppedReason, 'max-attempts');
	assert.deepEqual(appliedRequests, [
		{ width: 100, height: 100 },
		{ width: 200, height: 200 }
	]);
	assert.deepEqual(result.lastAppliedRequestedWindowRect, { width: 200, height: 200 });
	assert.equal(
		validateRequestedViewport({ id: 'test', width: 100, height: 100 }, { width: 100, height: 100 }, result).passed,
		false
	);
});

test('CSS viewport calibration respects driver window limits and rejects invalid observations', () => {
	assert.deepEqual(
		calibrateWindowRectForCssViewport(
			{ width: 390, height: 500 },
			{ width: 400, height: 300 },
			{ width: 800, height: 600 },
			{
				minimumWindowRect: { width: 800, height: 600 },
				maximumWindowRect: { width: 1600, height: 1200 }
			}
		),
		{ width: 800, height: 1000 }
	);
	assert.throws(
		() =>
			calibrateWindowRectForCssViewport(
				{ width: 1440, height: 900 },
				{ width: 0, height: 450 },
				{ width: 1440, height: 900 }
			),
		/observed CSS viewport must have positive finite dimensions/
	);
});

test('native Agent driver endpoint preserves explicit overrides and otherwise uses an OS-assigned port', async () => {
	let allocatorCalled = false;
	const explicit = await resolveLoopbackDriverEndpoint('http://localhost:4567/', async () => {
		allocatorCalled = true;
		return 'http://127.0.0.1:1';
	});
	assert.deepEqual(explicit, {
		driverUrl: 'http://localhost:4567',
		port: '4567',
		portSource: 'explicit'
	});
	assert.equal(allocatorCalled, false);

	const automatic = await resolveLoopbackDriverEndpoint(undefined, async () => {
		allocatorCalled = true;
		return 'http://127.0.0.1:54321';
	});
	assert.equal(allocatorCalled, true);
	assert.deepEqual(automatic, {
		driverUrl: 'http://127.0.0.1:54321',
		port: '54321',
		portSource: 'os-assigned'
	});

	const allocatedUrl = await allocateLoopbackDriverUrl();
	const allocated = parseLoopbackDriverUrl(allocatedUrl);
	const server = createServer();
	await new Promise((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen(Number(allocated.port), '127.0.0.1', resolveListen);
	});
	await new Promise(resolveClose => server.close(resolveClose));
});

test('native Agent launch environment carries isolated app data and a unique run nonce', () => {
	const firstNonce = createWebdriverRunNonce();
	const secondNonce = createWebdriverRunNonce();
	assert.match(firstNonce, /^[a-f0-9]{64}$/);
	assert.match(secondNonce, /^[a-f0-9]{64}$/);
	assert.notEqual(firstNonce, secondNonce);

	const dataDir = join(tmpdir(), 'nyala-agent-app-data');
	const environment = createTauriWebdriverEnvironment({
		driverUrl: 'http://127.0.0.1:4567',
		dataDir,
		runNonce: firstNonce,
		baseEnvironment: { PRESERVED: 'yes' }
	});
	assert.equal(environment.PRESERVED, 'yes');
	assert.equal(environment.TAURI_WEBDRIVER_PORT, '4567');
	assert.equal(environment.NYALA_DATA_DIR, dataDir);
	assert.equal(environment.NYALA_WEBDRIVER_APP_DATA_DIR, dataDir);
	assert.equal(environment.NYALA_WEBDRIVER_RUN_NONCE, firstNonce);
	assert.equal(environment.NYALA_WEBDRIVER_DATA_DIR, undefined);
	assert.equal(validateWebdriverRunNonce(firstNonce, firstNonce), true);
	assert.throws(() => validateWebdriverRunNonce(firstNonce, secondNonce), /ownership nonce did not match/);
});

test('native Agent command execution waits for fulfillment and surfaces rejection', async () => {
	let fulfillCommand;
	const commandValue = { version: 1, status: 'succeeded' };
	const fulfilledContext = {
		__sidex_commandService: {
			executeCommand: () => new Promise(resolveCommand => (fulfillCommand = resolveCommand))
		}
	};
	setTimeout(() => fulfillCommand(commandValue), 5);
	const fulfilledResult = await executeWorkbenchCommandAndWait(
		async script => runInNewContext(`(() => { ${script} })()`, fulfilledContext),
		'sql.agent.openPanel',
		{ commandToken: 'fulfilled-command', timeoutMs: 100, pollIntervalMs: 1 }
	);
	assert.deepEqual(fulfilledResult, commandValue);
	assert.deepEqual(Object.keys(fulfilledContext.__nyalaNativeCaptureCommandStates), []);

	const rejectedContext = {
		__sidex_commandService: {
			executeCommand: async () => {
				throw new Error('panel failed');
			}
		}
	};
	await assert.rejects(
		executeWorkbenchCommandAndWait(
			async script => runInNewContext(`(() => { ${script} })()`, rejectedContext),
			'sql.agent.openPanel',
			{ commandToken: 'rejected-command', timeoutMs: 100, pollIntervalMs: 1 }
		),
		error => {
			assert.match(error.message, /Workbench command sql\.agent\.openPanel rejected/);
			assert.doesNotMatch(error.message, /panel failed/);
			return true;
		}
	);
	assert.deepEqual(Object.keys(rejectedContext.__nyalaNativeCaptureCommandStates), []);
});

test('native Agent command execution preserves fulfilled values through WebDriver envelopes', async () => {
	const commandValue = { version: 1, status: 'succeeded', value: 'nested-result' };
	const context = {
		__sidex_commandService: {
			executeCommand: () => Promise.resolve(commandValue)
		}
	};

	const result = await executeWorkbenchCommandAndWait(
		async script =>
			unwrapWebdriverValue({
				value: runInNewContext(`(() => { ${script} })()`, context)
			}),
		'sqlStudio.product.awaitBootstrap',
		{ commandToken: 'webdriver-envelope-command', timeoutMs: 100, pollIntervalMs: 1 }
	);

	assert.deepEqual(result, commandValue);
});

test('native Agent command execution deletes timed-out page state', async () => {
	const context = {
		__sidex_commandService: {
			executeCommand: () => new Promise(() => undefined)
		}
	};

	await assert.rejects(
		executeWorkbenchCommandAndWait(
			async script => runInNewContext(`(() => { ${script} })()`, context),
			'sqlStudio.product.awaitBootstrap',
			{ commandToken: 'timed-out-command', timeoutMs: 5, pollIntervalMs: 1 }
		),
		/Timed out waiting for Workbench command sqlStudio\.product\.awaitBootstrap/
	);
	assert.deepEqual(Object.keys(context.__nyalaNativeCaptureCommandStates), []);
});

test('native Agent screenshot dimensions are tied to CSS viewport and DPR', () => {
	assert.equal(
		validateScreenshotPhysicalDimensions({ width: 780, height: 1688 }, { width: 390, height: 844, devicePixelRatio: 2 })
			.passed,
		true
	);
	assert.equal(
		validateScreenshotPhysicalDimensions({ width: 800, height: 1688 }, { width: 390, height: 844, devicePixelRatio: 2 })
			.passed,
		false
	);
});

const execFileAsync = promisify(execFile);

test('native Agent evidence runner writes a blocked manifest when the binary cannot start', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-agent-native-test-'));
	try {
		const output = join(root, 'evidence.json');
		await assert.rejects(
			execFileAsync(process.execPath, [
				'scripts/capture-sql-agent-workbench-webdriver.mjs',
				'--app-binary',
				join(root, 'missing-nyala'),
				'--platform',
				process.platform === 'win32' ? 'windows' : 'macos',
				'--output',
				output,
				'--screenshot-dir',
				join(root, 'screenshots'),
				'--repository',
				'baicie/nyala-studio',
				'--source-revision',
				'a'.repeat(40),
				'--source-ref',
				'refs/heads/mvp',
				'--workflow-run-id',
				'123456789',
				'--workflow-run-attempt',
				'1',
				'--startup-timeout-ms',
				'10000'
			])
		);
		const report = JSON.parse(await readFile(output, 'utf8'));
		assert.equal(report.version, 2);
		assert.equal(report.status, 'blocked');
		assert.equal(report.automatedSurfaceStatus, 'blocked');
		assert.equal(report.checkpointDecision, 'BLOCKED');
		assert.equal(report.driverProvider, 'embedded');
		assert.equal(report.nativeWebView, false);
		assert.equal('frontendSource' in report, false);
		assert.deepEqual(report.artifacts, []);
		assert.equal(report.webdriverOwnership.portSource, 'os-assigned');
		assert.match(report.webdriverOwnership.driverUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
		assert.equal(report.webdriverOwnership.runNonceVerified, false);
		assert.equal(report.keyboardMode, 'webdriver-actions-synthetic');
		assert.deepEqual(report.manualGates, { nativeKeyboard: 'pending', screenReader: 'pending' });
		assert.deepEqual(report.provenance, {
			repository: 'baicie/nyala-studio',
			sourceRevision: 'a'.repeat(40),
			sourceRef: 'refs/heads/mvp',
			workflowRunId: '123456789',
			workflowRunAttempt: 1
		});
		assert.match(report.limitations.join(' '), /native system Tab traversal/);
		assert.match(report.reason, /ENOENT|spawn|timed out/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('native Agent evidence runner rejects non-native platforms before starting a binary', async () => {
	await assert.rejects(
		execFileAsync(process.execPath, [
			'scripts/capture-sql-agent-workbench-webdriver.mjs',
			'--app-binary',
			'/tmp/does-not-start',
			'--platform',
			'linux'
		]),
		/platform must be macos or windows/
	);
});
