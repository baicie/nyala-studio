#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
	convergeWindowRectForCssViewport,
	createWebdriverRunNonce,
	createEmbeddedWebdriverSession,
	dimensionsWithinTolerance,
	identifyEmbeddedWebview,
	launchTauriEmbeddedWebdriver,
	resolveLoopbackDriverEndpoint,
	unwrapWebdriverValue,
	webdriverRequest
} from './tauri-embedded-webdriver.mjs';
import { hasVisiblePngDiversity, inspectPngPixels } from './sql-result-grid-visual-png.mjs';
import {
	createAgentWorkbenchSnapshotExpression,
	validateAgentWorkbenchSnapshot
} from './sql-agent-workbench-visual-contract.mjs';

const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
const manualGateCheckIds = new Set(['keyboard-tab-order', 'native-keyboard-evidence']);
const sqlProductAwaitBootstrapCommandId = 'sqlStudio.product.awaitBootstrap';
const sqlProductBootstrapSequences = {
	restore: [['bootstrapDemo']],
	onboarding: [
		['bootstrapDemo'],
		['bootstrapDemo', 'focusConnections', 'openResults'],
		['bootstrapDemo', 'focusWelcome', 'newQuery'],
		['bootstrapDemo', 'focusConnections', 'openResults', 'focusWelcome', 'newQuery']
	]
};
const sqlProductBootstrapCommandKinds = new Set([
	'bootstrapDemo',
	'focusConnections',
	'openResults',
	'focusWelcome',
	'newQuery'
]);
const sqlProductBootstrapFailureCodes = new Set([
	'startup-prepare-failed',
	'startup-command-failed',
	'bootstrap-persist-failed',
	'unexpected-bootstrap-rejection'
]);

const cli = isMain ? parseArgs(process.argv.slice(2)) : {};
if (isMain && cli.help === 'true') {
	process.stdout.write(`Usage: node scripts/capture-sql-agent-workbench-webdriver.mjs [options]
  --app-binary <path>       Webdriver-enabled Nyala debug binary
  --platform <name>         macos or windows
  --driver-url <url>        Embedded WebDriver endpoint (default: OS-assigned loopback port)
  --output <path>           Evidence JSON destination
  --screenshot-dir <path>   Screenshot destination
  --app-log <path>          Captured native application log
  --repository <owner/name> GitHub repository provenance
  --source-revision <sha>   Tested Git commit provenance
  --source-ref <ref>        Tested Git ref provenance
  --workflow-run-id <id>    GitHub Actions run provenance
  --workflow-run-attempt <n> GitHub Actions attempt provenance
  --startup-timeout-ms <n>  Native application startup budget
  --script-timeout-ms <n>   Workbench/direct-eval budget
  --manual-review           Keep the ready native session open until Enter (local QA only)
`);
	process.exit(0);
}

const appBinary = cli['app-binary'] ? resolve(cli['app-binary']) : undefined;
const platform =
	cli.platform ?? (process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : '');
const explicitDriverUrl = cli['driver-url'] === undefined ? undefined : String(cli['driver-url']);
const outputPath = resolve(cli.output ?? 'sql-agent-native-evidence.json');
const screenshotDir = resolve(cli['screenshot-dir'] ?? join(dirname(outputPath), 'screenshots'));
const startupTimeoutMs = parseBoundedInteger(
	cli['startup-timeout-ms'] ?? '120000',
	'--startup-timeout-ms',
	10_000,
	300_000
);
const scriptTimeoutMs = parseBoundedInteger(
	cli['script-timeout-ms'] ?? '120000',
	'--script-timeout-ms',
	10_000,
	300_000
);
const manualReview = parseBooleanFlag(cli['manual-review'], '--manual-review');
const requestedViewports = [
	{ id: 'desktop', width: 1440, height: 900 },
	{ id: 'narrow', width: 390, height: 844 }
];
const viewportCalibrationMaxAttempts = 4;
const viewportCalibrationTolerance = 1;
const screenshotDimensionTolerance = 2;
const keyboardMode = 'webdriver-actions-synthetic';
const keyboardLimitation =
	'tauri-plugin-wdio-webdriver 1.3.0 dispatches W3C /actions keys as synthetic DOM KeyboardEvent values; native system Tab traversal and screen-reader keyboard behavior are not claimed.';
const baseProvenance = createEvidenceProvenance(cli);

if (isMain) {
	if (!appBinary) throw new Error('--app-binary is required.');
	if (!['macos', 'windows'].includes(platform)) {
		throw new Error(`--platform must be macos or windows, got ${platform || 'empty'}`);
	}
	await run();
}

async function run() {
	const artifacts = [];
	const runNonce = createWebdriverRunNonce();
	let sessionId;
	let appHost;
	let temporaryRoot;
	let frontendSource;
	let sqlProductBootstrap;
	let driverUrl;
	let commandSequence = 0;
	let provenance = baseProvenance;
	let webdriverOwnership = {
		driverUrl: undefined,
		portSource: explicitDriverUrl === undefined ? 'os-assigned' : 'explicit',
		runNonceVerified: false,
		runNonceSha256: undefined
	};
	let identity = {
		driverProvider: 'embedded',
		nativeWebView: false,
		nativeWebView2: false,
		engine: 'embedded-unverified',
		browser: 'unknown',
		platformName: platform
	};
	try {
		const endpoint = await resolveLoopbackDriverEndpoint(explicitDriverUrl);
		driverUrl = endpoint.driverUrl;
		webdriverOwnership = {
			driverUrl,
			portSource: endpoint.portSource,
			runNonceVerified: false,
			runNonceSha256: undefined
		};
		await mkdir(screenshotDir, { recursive: true });
		await mkdir(dirname(outputPath), { recursive: true });
		temporaryRoot = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'nyala-agent-webdriver-'));
		provenance = { ...baseProvenance, binarySha256: await sha256File(appBinary) };
		appHost = await launchTauriEmbeddedWebdriver({
			appBinary,
			driverUrl,
			dataDir: cli['app-data-dir'] ?? join(temporaryRoot, 'app-data'),
			logPath: cli['app-log'],
			runNonce,
			timeoutMs: startupTimeoutMs
		});
		const session = await createEmbeddedWebdriverSession(driverUrl);
		sessionId = session.sessionId;
		await webdriverRequest(driverUrl, `/session/${sessionId}/timeouts`, 'POST', {
			implicit: 0,
			pageLoad: scriptTimeoutMs,
			script: scriptTimeoutMs
		});
		const initialDocumentBinding = await waitForAssetProtocolFrontend();
		frontendSource = initialDocumentBinding.frontendSource;
		webdriverOwnership = {
			...webdriverOwnership,
			runNonceVerified: true,
			runNonceSha256: initialDocumentBinding.runNonceSha256
		};
		identity = identifyEmbeddedWebview(session.capabilities, platform);
		sqlProductBootstrap = normalizeSqlProductBootstrapOutcome(
			await dispatchCommand(sqlProductAwaitBootstrapCommandId, { pollIntervalMs: 250 })
		);
		validateSqlProductBootstrapOutcome(sqlProductBootstrap);

		for (const requestedViewport of requestedViewports) {
			const viewportSizing = await setWindowSize(requestedViewport);
			if (requestedViewport.id === 'narrow') {
				await dispatchCommand('workbench.action.closeSidebar');
			}
			const agentPanelVisible = Boolean(
				await syncEval(
					`Boolean(document.querySelector('.sql-agent-view')) && document.querySelector('.sql-agent-view').getClientRects().length > 0`
				)
			);
			if (shouldOpenAgentPanel(agentPanelVisible)) {
				await dispatchCommand('sql.agent.openPanel');
			}
			await waitForExpression(
				`Boolean(document.querySelector('.sql-agent-view')) && document.querySelector('.sql-agent-view').getClientRects().length > 0`,
				`${requestedViewport.id} SQL Agent panel`
			);
			await delay(350);

			const tabEvidence = await collectTabOrder();
			const tabOrder = tabEvidence.order;
			const beforeSnapshot = await observeAssetProtocolDocument(frontendSource);
			const snapshot = await syncEval(createAgentWorkbenchSnapshotExpression());
			const viewport = {
				id: requestedViewport.id,
				width: snapshot.viewportWidth,
				height: snapshot.viewportHeight,
				devicePixelRatio: snapshot.devicePixelRatio
			};
			const screenshotName = `sql-agent-${platform}-${requestedViewport.id}.png`;
			const { content: screenshotContent, ...screenshot } = await captureScreenshot();
			const afterScreenshot = await observeAssetProtocolDocument(frontendSource);
			await writeFile(join(screenshotDir, screenshotName), screenshotContent);
			const checks = [
				...validateAgentWorkbenchSnapshot(snapshot, viewport, tabOrder).map(check => ({
					...check,
					scope: check.id === 'keyboard-tab-order' ? 'manual' : 'automated'
				})),
				{ ...validateRequestedViewport(requestedViewport, viewport, viewportSizing), scope: 'automated' },
				{
					id: 'native-keyboard-evidence',
					passed: tabEvidence.keyboardMode === 'native',
					scope: 'manual',
					reason: `${tabEvidence.keyboardMode}: ${tabEvidence.limitation}`
				},
				{ ...validateScreenshotPhysicalDimensions(screenshot, viewport), scope: 'automated' },
				{
					id: 'screenshot-pixel-diversity',
					passed: hasVisiblePngDiversity(screenshot),
					scope: 'automated',
					reason: `${screenshot.distinctColorBuckets} color bucket(s), luma range ${screenshot.lumaRange}`
				}
			];
			const automatedSurface = evaluateAutomatedSurfaceChecks(checks);
			artifacts.push({
				requestedViewport,
				requestedCssViewport: viewportSizing.requestedCssViewport,
				initialWindowRect: viewportSizing.initialWindowRect,
				lastAppliedRequestedWindowRect: viewportSizing.lastAppliedRequestedWindowRect,
				devicePixelRatio: viewportSizing.devicePixelRatio,
				appliedWindowRect: viewportSizing.appliedWindowRect,
				observedCssViewport: viewportSizing.observedCssViewport,
				viewportConverged: viewportSizing.viewportConverged,
				viewportTolerance: viewportSizing.viewportTolerance,
				convergenceStoppedReason: viewportSizing.convergenceStoppedReason,
				calibrationAttempts: viewportSizing.calibrationAttempts,
				viewport,
				status: automatedSurface.status,
				automatedSurfaceStatus: automatedSurface.status,
				failedAutomatedCheckIds: automatedSurface.failedCheckIds,
				documentBinding: { beforeSnapshot, afterScreenshot },
				screenshot: screenshotName,
				screenshotBytes: screenshot.bytes,
				screenshotSha256: screenshot.sha256,
				snapshot,
				tabOrder,
				keyboardMode: tabEvidence.keyboardMode,
				keyboardLimitation: tabEvidence.limitation,
				checks
			});
		}

		const ready =
			artifacts.length === requestedViewports.length &&
			artifacts.every(item => item.automatedSurfaceStatus === 'ready');
		await writeEvidence({
			status: ready ? 'ready' : 'blocked',
			reason: ready
				? `${identity.engine} recorded desktop and narrow automated surface evidence; real keyboard and screen-reader gates remain pending.`
				: `${identity.engine} did not satisfy every automated SQL Agent Workbench surface check.`,
			identity,
			webdriverOwnership,
			frontendSource,
			sqlProductBootstrap,
			provenance,
			artifacts
		});
		if (ready && manualReview) {
			await waitForManualReview();
		}
		if (!ready) process.exitCode = 1;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		process.stderr.write(`SQL Agent native evidence blocked: ${reason}\n`);
		await writeEvidence({
			status: 'blocked',
			reason,
			identity,
			webdriverOwnership,
			frontendSource,
			sqlProductBootstrap,
			provenance,
			artifacts
		});
		process.exitCode = 1;
	} finally {
		if (sessionId && driverUrl) {
			await webdriverRequest(driverUrl, `/session/${sessionId}`, 'DELETE').catch(() => undefined);
		}
		await appHost?.stop();
		if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
	}

	async function syncEval(expression) {
		return unwrapWebdriverValue(
			await webdriverRequest(driverUrl, `/session/${sessionId}/execute/sync`, 'POST', {
				script: `return (${expression});`,
				args: []
			})
		);
	}

	async function syncScript(script) {
		return unwrapWebdriverValue(
			await webdriverRequest(driverUrl, `/session/${sessionId}/execute/sync`, 'POST', {
				script,
				args: []
			})
		);
	}

	async function dispatchCommand(commandId, { pollIntervalMs = 25 } = {}) {
		commandSequence += 1;
		return executeWorkbenchCommandAndWait(syncScript, commandId, {
			commandToken: `${runNonce}:${commandSequence}`,
			timeoutMs: scriptTimeoutMs,
			pollIntervalMs
		});
	}

	async function waitForExpression(expression, label) {
		const deadline = Date.now() + scriptTimeoutMs;
		let lastError = '';
		while (Date.now() < deadline) {
			try {
				if (await syncEval(expression)) return;
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
			}
			await delay(100);
		}
		throw new Error(`Timed out waiting for ${label}${lastError ? ` (${lastError})` : ''}.`);
	}

	async function waitForAssetProtocolFrontend() {
		const deadline = Date.now() + scriptTimeoutMs;
		let lastState = 'the native WebView has not reached its asset protocol frontend';
		while (Date.now() < deadline) {
			try {
				const [urlPayload, titlePayload, readyStatePayload, workbenchReadyPayload] = await Promise.all([
					webdriverRequest(driverUrl, `/session/${sessionId}/url`),
					webdriverRequest(driverUrl, `/session/${sessionId}/title`),
					webdriverRequest(driverUrl, `/session/${sessionId}/execute/sync`, 'POST', {
						script: 'return document.readyState',
						args: []
					}),
					webdriverRequest(driverUrl, `/session/${sessionId}/execute/sync`, 'POST', {
						script:
							'return Boolean(globalThis.__sidex_commandService) && Boolean(document.querySelector(".monaco-workbench")) && !document.querySelector("#nyala-splash")',
						args: []
					})
				]);
				const currentUrl = unwrapWebdriverValue(urlPayload);
				const title = unwrapWebdriverValue(titlePayload);
				const readyState = unwrapWebdriverValue(readyStatePayload);
				const workbenchReady = unwrapWebdriverValue(workbenchReadyPayload) === true;
				const titleMatches = typeof title === 'string' && title.includes('Nyala Studio');
				const classifiedReadyState = ['loading', 'interactive', 'complete'].includes(readyState) ? readyState : 'other';
				lastState = `url=${describeUntrustedUrl(currentUrl)} titleMatches=${titleMatches} readyState=${classifiedReadyState} workbenchReady=${workbenchReady}`;
				const source = createTauriAssetFrontendSource(currentUrl, platform);
				if (readyState === 'complete' && titleMatches && workbenchReady) {
					// Let WebKit finish the final document-to-Workbench handoff before the
					// first async direct-eval request; otherwise it can be reclaimed.
					await delay(250);
					return observeAssetProtocolDocument(source);
				}
			} catch (error) {
				lastState = error instanceof Error ? error.message : String(error);
			}
			await delay(100);
		}
		throw new Error(`Timed out waiting for the Tauri asset protocol frontend: ${lastState}`);
	}

	async function observeAssetProtocolDocument(expectedSource) {
		const [urlPayload, observedNonce] = await Promise.all([
			webdriverRequest(driverUrl, `/session/${sessionId}/url`),
			syncEval('typeof globalThis.__nyalaWebdriverRunNonce === "string" ? globalThis.__nyalaWebdriverRunNonce : null')
		]);
		const binding = createAssetProtocolDocumentBinding(
			unwrapWebdriverValue(urlPayload),
			platform,
			runNonce,
			observedNonce
		);
		if (binding.frontendSource.url !== expectedSource?.url) {
			throw new Error(
				`Tauri asset protocol frontend changed during capture: expected ${expectedSource?.url ?? 'unknown'}`
			);
		}
		return binding;
	}

	async function setWindowSize(viewport) {
		const requestedCssViewport = { width: viewport.width, height: viewport.height };
		const calibration = await convergeWindowRectForCssViewport(
			requestedCssViewport,
			async requestedWindowRect => {
				const appliedWindowRect = unwrapWebdriverValue(
					await webdriverRequest(driverUrl, `/session/${sessionId}/window/rect`, 'POST', requestedWindowRect)
				);
				await delay(250);
				const observedCssViewport = await syncEval('({ width: window.innerWidth, height: window.innerHeight })');
				return { appliedWindowRect, observedCssViewport };
			},
			{
				maxAttempts: viewportCalibrationMaxAttempts,
				tolerance: viewportCalibrationTolerance
			}
		);
		return {
			...calibration,
			devicePixelRatio: Number(await syncEval('window.devicePixelRatio'))
		};
	}

	async function collectTabOrder() {
		await syncScript(`document.querySelector('[aria-label="Agent prompt"]')?.focus(); return true;`);
		const order = [await activeAriaLabel()];
		for (let index = 0; index < 3; index += 1) {
			await webdriverRequest(driverUrl, `/session/${sessionId}/actions`, 'POST', {
				actions: [
					{
						type: 'key',
						id: 'agent-keyboard',
						actions: [
							{ type: 'keyDown', value: '\uE004' },
							{ type: 'keyUp', value: '\uE004' }
						]
					}
				]
			});
			order.push(await activeAriaLabel());
		}
		return { order, keyboardMode, limitation: keyboardLimitation };
	}

	async function activeAriaLabel() {
		return syncEval(`document.activeElement?.getAttribute('aria-label') || ''`);
	}

	async function captureScreenshot() {
		const payload = await webdriverRequest(driverUrl, `/session/${sessionId}/screenshot`, 'GET');
		const encoded = unwrapWebdriverValue(payload);
		if (typeof encoded !== 'string' || encoded.length === 0) {
			throw new Error('Embedded WebDriver returned an empty screenshot.');
		}
		const bytes = Buffer.from(encoded, 'base64');
		return {
			content: bytes,
			...inspectPngPixels(bytes),
			bytes: bytes.byteLength,
			sha256: createHash('sha256').update(bytes).digest('hex')
		};
	}
}

export function createTauriAssetFrontendSource(value, platformName) {
	const expectedUrl =
		platformName === 'macos'
			? 'tauri://localhost'
			: platformName === 'windows'
				? 'https://tauri.localhost/'
				: undefined;
	const observedUrl = typeof value === 'string' ? value : undefined;
	if (expectedUrl === undefined || observedUrl !== expectedUrl) {
		throw new Error(
			`Embedded ${platformName || 'unknown'} asset protocol frontend URL must be ${expectedUrl ?? 'a supported native origin'}, got ${describeUntrustedUrl(value)}`
		);
	}
	return { kind: 'tauri-asset-protocol', url: observedUrl };
}

export function createAssetProtocolDocumentBinding(value, platformName, expectedNonce, observedNonce) {
	const frontendSource = createTauriAssetFrontendSource(value, platformName);
	validateWebdriverRunNonce(expectedNonce, observedNonce);
	return {
		frontendSource,
		runNonceSha256: createHash('sha256').update(observedNonce).digest('hex')
	};
}

export function describeUntrustedUrl(value) {
	if (typeof value !== 'string') return `non-string ${typeof value}`;
	try {
		const parsed = new URL(value);
		return `scheme=${parsed.protocol || 'none'} host=${parsed.hostname || 'none'}`;
	} catch {
		return 'unparseable URL';
	}
}

export function normalizeSqlProductBootstrapOutcome(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw malformedSqlProductBootstrapOutcome();
	}

	const { version, status, mode, completedCommands } = value;
	if (
		version !== 1 ||
		!['succeeded', 'failed', 'disposed'].includes(status) ||
		!['onboarding', 'restore'].includes(mode) ||
		!Array.isArray(completedCommands) ||
		completedCommands.some(command => !sqlProductBootstrapCommandKinds.has(command)) ||
		!isSqlProductBootstrapSequencePrefix(mode, completedCommands)
	) {
		throw malformedSqlProductBootstrapOutcome();
	}

	const normalized = {
		version: 1,
		status,
		mode,
		completedCommands: [...completedCommands]
	};
	if (status === 'succeeded') {
		if (
			Object.hasOwn(value, 'failedStep') ||
			Object.hasOwn(value, 'errorCode') ||
			!isCompleteSqlProductBootstrapSequence(mode, completedCommands)
		) {
			throw malformedSqlProductBootstrapOutcome();
		}
		return normalized;
	}

	if (status === 'disposed') {
		if (Object.hasOwn(value, 'failedStep') || Object.hasOwn(value, 'errorCode')) {
			throw malformedSqlProductBootstrapOutcome();
		}
		return normalized;
	}

	const { failedStep, errorCode } = value;
	if (
		!['prepare', 'persist', ...sqlProductBootstrapCommandKinds].includes(failedStep) ||
		!sqlProductBootstrapFailureCodes.has(errorCode) ||
		!isValidSqlProductBootstrapFailure(mode, completedCommands, failedStep, errorCode)
	) {
		throw malformedSqlProductBootstrapOutcome();
	}
	return { ...normalized, failedStep, errorCode };
}

export function validateSqlProductBootstrapOutcome(value) {
	const outcome = normalizeSqlProductBootstrapOutcome(value);
	if (outcome.status !== 'succeeded') {
		throw new Error(`SQL Product bootstrap did not succeed (${outcome.status}).`);
	}
	return outcome;
}

function isSqlProductBootstrapSequencePrefix(mode, commands) {
	return sqlProductBootstrapSequences[mode].some(
		sequence => commands.length <= sequence.length && commands.every((command, index) => sequence[index] === command)
	);
}

function isCompleteSqlProductBootstrapSequence(mode, commands) {
	return sqlProductBootstrapSequences[mode].some(
		sequence => sequence.length === commands.length && sequence.every((command, index) => commands[index] === command)
	);
}

function isValidSqlProductBootstrapFailure(mode, completedCommands, failedStep, errorCode) {
	if (errorCode === 'startup-prepare-failed' || errorCode === 'unexpected-bootstrap-rejection') {
		return failedStep === 'prepare' && completedCommands.length === 0;
	}
	if (errorCode === 'bootstrap-persist-failed') {
		return (
			mode === 'onboarding' &&
			failedStep === 'persist' &&
			isCompleteSqlProductBootstrapSequence(mode, completedCommands)
		);
	}
	if (errorCode !== 'startup-command-failed' || !sqlProductBootstrapCommandKinds.has(failedStep)) {
		return false;
	}
	return sqlProductBootstrapSequences[mode].some(
		sequence =>
			completedCommands.length < sequence.length &&
			completedCommands.every((command, index) => sequence[index] === command) &&
			sequence[completedCommands.length] === failedStep
	);
}

function malformedSqlProductBootstrapOutcome() {
	return new Error('SQL Product bootstrap outcome is malformed.');
}

export async function executeWorkbenchCommandAndWait(
	syncScript,
	commandId,
	{ commandToken = createWebdriverRunNonce(), timeoutMs = 30_000, pollIntervalMs = 25 } = {}
) {
	if (typeof syncScript !== 'function') throw new Error('Workbench command execution requires a script executor.');
	if (typeof commandId !== 'string' || commandId.length === 0) {
		throw new Error('Workbench command id must be a non-empty string.');
	}
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
		throw new Error(`Workbench command timeout must be a positive integer, got ${timeoutMs}`);
	}
	if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0) {
		throw new Error(`Workbench command poll interval must be a non-negative integer, got ${pollIntervalMs}`);
	}

	const encodedCommandId = JSON.stringify(commandId);
	const encodedCommandToken = JSON.stringify(String(commandToken));
	try {
		const start = await syncScript(`
			const commandToken = ${encodedCommandToken};
			const states = globalThis.__nyalaNativeCaptureCommandStates ??= Object.create(null);
			states[commandToken] = { status: 'pending' };
			const settle = state => {
				if (states[commandToken]?.status === 'pending') states[commandToken] = state;
			};
			try {
				const commandResult = globalThis.__sidex_commandService.executeCommand(${encodedCommandId});
				Promise.resolve(commandResult).then(
					result => settle({ status: 'fulfilled', result }),
					() => settle({ status: 'rejected' })
				);
				return { started: true };
			} catch {
				settle({ status: 'rejected' });
				return { started: false };
			}
		`);
		if (!start?.started) {
			throw new Error(`Workbench command ${commandId} failed to start.`);
		}

		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const state = await syncScript(`
				const states = globalThis.__nyalaNativeCaptureCommandStates;
				const commandToken = ${encodedCommandToken};
				return states?.[commandToken] ?? { status: 'missing' };
			`);
			if (state?.status === 'fulfilled') return state.result;
			if (state?.status === 'rejected') {
				throw new Error(`Workbench command ${commandId} rejected.`);
			}
			if (state?.status === 'missing') {
				throw new Error(`Workbench command ${commandId} lost its page execution state.`);
			}
			await delay(pollIntervalMs);
		}
		throw new Error(`Timed out waiting for Workbench command ${commandId}.`);
	} finally {
		await syncScript(`
			const states = globalThis.__nyalaNativeCaptureCommandStates;
			if (states) delete states[${encodedCommandToken}];
			return true;
		`).catch(() => undefined);
	}
}

export function validateRequestedViewport(requested, actual, calibration) {
	const dimensionsMatch = dimensionsWithinTolerance(requested, actual, viewportCalibrationTolerance);
	const viewportConverged = calibration?.viewportConverged === true;
	return {
		id: 'requested-viewport',
		passed: viewportConverged && dimensionsMatch,
		reason: `${requested.id} requested ${requested.width}x${requested.height}; inner viewport ${actual.width}x${actual.height}; calibration ${viewportConverged ? 'converged' : 'did not converge'}`
	};
}

export function validateScreenshotPhysicalDimensions(
	screenshot,
	cssViewport,
	tolerance = screenshotDimensionTolerance
) {
	const expectedWidth = Number(cssViewport?.width) * Number(cssViewport?.devicePixelRatio);
	const expectedHeight = Number(cssViewport?.height) * Number(cssViewport?.devicePixelRatio);
	const widthDelta = Math.abs(Number(screenshot?.width) - expectedWidth);
	const heightDelta = Math.abs(Number(screenshot?.height) - expectedHeight);
	const passed =
		Number.isFinite(expectedWidth) &&
		expectedWidth > 0 &&
		Number.isFinite(expectedHeight) &&
		expectedHeight > 0 &&
		Number.isFinite(tolerance) &&
		tolerance >= 0 &&
		widthDelta <= tolerance &&
		heightDelta <= tolerance;
	return {
		id: 'screenshot-size',
		passed,
		reason: `${screenshot?.width}x${screenshot?.height}; expected ${formatDimension(expectedWidth)}x${formatDimension(expectedHeight)} from ${cssViewport?.width}x${cssViewport?.height} CSS at DPR ${cssViewport?.devicePixelRatio}`
	};
}

export function shouldOpenAgentPanel(agentPanelVisible) {
	return !agentPanelVisible;
}

export function waitForManualReview({ input = process.stdin, output = process.stdout } = {}) {
	if (input?.isTTY !== true) {
		return Promise.reject(new Error('--manual-review requires an interactive TTY.'));
	}
	if (typeof input.on !== 'function' || typeof input.off !== 'function' || typeof output?.write !== 'function') {
		return Promise.reject(new Error('--manual-review requires readable input and writable output streams.'));
	}

	output.write(
		'\nManual review mode is local QA only; keyboard and screen-reader manual gates remain pending.\n' +
			'Use the system keyboard and VoiceOver/Narrator against the open native window. Press Enter to close it.\n'
	);
	return new Promise((resolveReview, rejectReview) => {
		const cleanup = () => {
			input.off('data', onData);
			input.off('end', onEnd);
			input.off('error', onError);
			input.pause?.();
		};
		const finish = () => {
			cleanup();
			resolveReview();
		};
		const fail = error => {
			cleanup();
			rejectReview(error);
		};
		const onData = chunk => {
			if (String(chunk).includes('\n') || String(chunk).includes('\r')) finish();
		};
		const onEnd = () => fail(new Error('--manual-review input closed before Enter.'));
		const onError = error => fail(error instanceof Error ? error : new Error(String(error)));
		input.setEncoding?.('utf8');
		input.on('data', onData);
		input.once('end', onEnd);
		input.once('error', onError);
		input.resume?.();
	});
}

export function validateWebdriverRunNonce(expectedNonce, observedNonce) {
	if (typeof expectedNonce !== 'string' || expectedNonce.length === 0) {
		throw new Error('Embedded WebDriver run nonce must be a non-empty string.');
	}
	if (observedNonce !== expectedNonce) {
		throw new Error('Embedded WebDriver page ownership nonce did not match this evidence run.');
	}
	return true;
}

export function evaluateAutomatedSurfaceChecks(checks) {
	const failedCheckIds = checks
		.filter(check => !(manualGateCheckIds.has(check?.id) && check?.scope === 'manual') && check?.passed !== true)
		.map(check => String(check?.id ?? 'unknown'));
	return {
		status: failedCheckIds.length === 0 ? 'ready' : 'blocked',
		failedCheckIds
	};
}

async function writeEvidence({
	status,
	reason,
	identity,
	webdriverOwnership,
	frontendSource,
	sqlProductBootstrap,
	provenance,
	artifacts
}) {
	const report = {
		version: 2,
		generatedAt: new Date().toISOString(),
		label: identity.platformName === 'windows' ? 'Windows WebView2 SQL Agent' : 'macOS WKWebView SQL Agent',
		status,
		automatedSurfaceStatus: status,
		checkpointDecision: 'BLOCKED',
		reason,
		...identity,
		provenance,
		webdriverOwnership,
		...(frontendSource ? { frontendSource } : {}),
		sqlProductBootstrap,
		artifacts,
		limitations: [
			'Native automation validates the embedded Workbench DOM, keyboard order, ARIA labels, layout, and screenshots.',
			keyboardLimitation,
			'A real VoiceOver or Narrator walkthrough remains manual and is not claimed by this evidence.'
		],
		manualGates: {
			nativeKeyboard: 'pending',
			screenReader: 'pending'
		},
		keyboardMode
	};
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
	process.stdout.write(`Wrote ${outputPath}\n`);
}

function createEvidenceProvenance(options) {
	const workflowRunAttempt = Number(options['workflow-run-attempt']);
	return compactObject({
		repository: options.repository,
		sourceRevision: options['source-revision'],
		sourceRef: options['source-ref'],
		workflowRunId: options['workflow-run-id'],
		workflowRunAttempt: Number.isInteger(workflowRunAttempt) && workflowRunAttempt > 0 ? workflowRunAttempt : undefined
	});
}

function compactObject(value) {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ''));
}

async function sha256File(path) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest('hex');
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
		if (args[index + 1]?.startsWith('--')) {
			result[key] = 'true';
			continue;
		}
		result[key] = args[index + 1] ?? 'true';
		index += 1;
	}
	return result;
}

function parseBoundedInteger(value, name, min, max) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
		throw new Error(`${name} must be an integer between ${min} and ${max}`);
	}
	return parsed;
}

function parseBooleanFlag(value, name) {
	if (value === undefined || value === 'false') return false;
	if (value === 'true') return true;
	throw new Error(`${name} must be a boolean flag`);
}

function delay(ms) {
	return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function formatDimension(value) {
	return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : 'invalid';
}
