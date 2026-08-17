import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
	evaluateAutomatedSurfaceChecks,
	executeWorkbenchCommandAndWait,
	shouldOpenAgentPanel,
	validateRequestedViewport,
	validateScreenshotPhysicalDimensions,
	validateWebdriverRunNonce
} from './capture-sql-agent-workbench-webdriver.mjs';
import {
	allocateLoopbackDriverUrl,
	calibrateWindowRectForCssViewport,
	convergeWindowRectForCssViewport,
	createTauriWebdriverEnvironment,
	createWebdriverRunNonce,
	parseLoopbackDriverUrl,
	resolveLoopbackDriverEndpoint
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
	const fulfilledContext = {
		__sidex_commandService: {
			executeCommand: () => new Promise(resolveCommand => (fulfillCommand = resolveCommand))
		}
	};
	setTimeout(() => fulfillCommand(), 5);
	await executeWorkbenchCommandAndWait(
		async script => runInNewContext(`(() => { ${script} })()`, fulfilledContext),
		'sql.agent.openPanel',
		{ commandToken: 'fulfilled-command', timeoutMs: 100, pollIntervalMs: 1 }
	);
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
		/Workbench command sql\.agent\.openPanel rejected: Error: panel failed/
	);
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
		const frontendDist = join(root, 'dist');
		await mkdir(frontendDist);
		await writeFile(join(frontendDist, 'index.html'), '<!doctype html><title>Nyala</title>');
		await assert.rejects(
			execFileAsync(process.execPath, [
				'scripts/capture-sql-agent-workbench-webdriver.mjs',
				'--app-binary',
				join(root, 'missing-nyala'),
				'--platform',
				process.platform === 'win32' ? 'windows' : 'macos',
				'--frontend-dist',
				frontendDist,
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
		assert.equal(report.frontendSource.kind, 'local-dist-server');
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
