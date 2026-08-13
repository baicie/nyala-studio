#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
	createEmbeddedWebdriverSession,
	identifyEmbeddedWebview,
	launchTauriEmbeddedWebdriver,
	scaleCssViewportToPhysicalWindowRect,
	unwrapWebdriverValue,
	webdriverRequest
} from './tauri-embedded-webdriver.mjs';
import { hasVisiblePngDiversity, inspectPngPixels } from './sql-result-grid-visual-png.mjs';
import {
	createAgentWorkbenchSnapshotExpression,
	validateAgentWorkbenchSnapshot
} from './sql-agent-workbench-visual-contract.mjs';
import { serveFrontendDist } from './serve-frontend-dist.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

const cli = isMain ? parseArgs(process.argv.slice(2)) : {};
if (isMain && cli.help === 'true') {
	process.stdout.write(`Usage: node scripts/capture-sql-agent-workbench-webdriver.mjs [options]
  --app-binary <path>       Webdriver-enabled Nyala debug binary
  --platform <name>         macos or windows
  --driver-url <url>        Embedded WebDriver endpoint (default: http://127.0.0.1:4445)
  --frontend-dist <path>    Built frontend directory (default: ./dist)
  --output <path>           Evidence JSON destination
  --screenshot-dir <path>   Screenshot destination
  --app-log <path>          Captured native application log
  --startup-timeout-ms <n>  Native application startup budget
  --script-timeout-ms <n>   Workbench/direct-eval budget
`);
	process.exit(0);
}

const appBinary = cli['app-binary'] ? resolve(cli['app-binary']) : undefined;
const platform =
	cli.platform ?? (process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : '');
const driverUrl = String(cli['driver-url'] ?? 'http://127.0.0.1:4445').replace(/\/$/, '');
const frontendDist = resolve(cli['frontend-dist'] ?? join(repositoryRoot, 'dist'));
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
const requestedViewports = [
	{ id: 'desktop', width: 1440, height: 900 },
	{ id: 'narrow', width: 390, height: 844 }
];
const keyboardMode = 'webdriver-actions-synthetic';
const keyboardLimitation =
	'tauri-plugin-wdio-webdriver 1.3.0 dispatches W3C /actions keys as synthetic DOM KeyboardEvent values; native system Tab traversal and screen-reader keyboard behavior are not claimed.';

if (isMain) {
	if (!appBinary) throw new Error('--app-binary is required.');
	if (!['macos', 'windows'].includes(platform)) {
		throw new Error(`--platform must be macos or windows, got ${platform || 'empty'}`);
	}
	await run();
}

async function run() {
	const artifacts = [];
	let sessionId;
	let appHost;
	let temporaryRoot;
	let frontendServer;
	let identity = {
		driverProvider: 'embedded',
		nativeWebView: false,
		nativeWebView2: false,
		engine: 'embedded-unverified',
		browser: 'unknown',
		platformName: platform
	};
	try {
		await mkdir(screenshotDir, { recursive: true });
		await mkdir(dirname(outputPath), { recursive: true });
		temporaryRoot = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'nyala-agent-webdriver-'));
		frontendServer = await serveFrontendDist(frontendDist);
		appHost = await launchTauriEmbeddedWebdriver({
			appBinary,
			driverUrl,
			dataDir: cli['app-data-dir'] ?? join(temporaryRoot, 'app-data'),
			logPath: cli['app-log'],
			timeoutMs: startupTimeoutMs
		});
		const session = await createEmbeddedWebdriverSession(driverUrl);
		sessionId = session.sessionId;
		identity = identifyEmbeddedWebview(session.capabilities, platform);
		await webdriverRequest(driverUrl, `/session/${sessionId}/timeouts`, 'POST', {
			implicit: 0,
			pageLoad: scriptTimeoutMs,
			script: scriptTimeoutMs
		});
		await webdriverRequest(driverUrl, `/session/${sessionId}/url`, 'POST', { url: frontendServer.url });
		await waitForFrontendNavigation(frontendServer.url);
		await waitForExpression(
			`Boolean(globalThis.__sidex_commandService) && Boolean(document.querySelector('.monaco-workbench')) && !document.querySelector('#nyala-splash')`,
			'Workbench boot'
		);

		for (const requestedViewport of requestedViewports) {
			const viewportSizing = await setWindowSize(requestedViewport);
			if (requestedViewport.id === 'narrow') {
				await dispatchCommand('workbench.action.closeSidebar');
			}
			await dispatchCommand('sql.agent.openPanel');
			await waitForExpression(
				`Boolean(document.querySelector('.sql-agent-view')) && document.querySelector('.sql-agent-view').getClientRects().length > 0`,
				`${requestedViewport.id} SQL Agent panel`
			);
			await delay(350);

			const tabEvidence = await collectTabOrder();
			const tabOrder = tabEvidence.order;
			const snapshot = await syncEval(createAgentWorkbenchSnapshotExpression());
			const viewport = {
				id: requestedViewport.id,
				width: snapshot.viewportWidth,
				height: snapshot.viewportHeight,
				devicePixelRatio: snapshot.devicePixelRatio
			};
			const screenshotName = `sql-agent-${platform}-${requestedViewport.id}.png`;
			const screenshot = await captureScreenshot(join(screenshotDir, screenshotName));
			const checks = [
				...validateAgentWorkbenchSnapshot(snapshot, viewport, tabOrder),
				validateRequestedViewport(requestedViewport, viewport),
				{
					id: 'native-keyboard-evidence',
					passed: tabEvidence.keyboardMode === 'native',
					reason: `${tabEvidence.keyboardMode}: ${tabEvidence.limitation}`
				},
				{
					id: 'screenshot-size',
					passed: screenshot.width >= 300 && screenshot.height >= 300,
					reason: `${screenshot.width}x${screenshot.height}`
				},
				{
					id: 'screenshot-pixel-diversity',
					passed: hasVisiblePngDiversity(screenshot),
					reason: `${screenshot.distinctColorBuckets} color bucket(s), luma range ${screenshot.lumaRange}`
				}
			];
			artifacts.push({
				requestedViewport,
				requestedCssViewport: viewportSizing.requestedCssViewport,
				requestedPhysicalRect: viewportSizing.requestedPhysicalRect,
				devicePixelRatio: viewportSizing.devicePixelRatio,
				appliedWindowRect: viewportSizing.appliedWindowRect,
				viewport,
				status: checks.every(check => check.passed) ? 'ready' : 'blocked',
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

		const ready = artifacts.length === requestedViewports.length && artifacts.every(item => item.status === 'ready');
		await writeEvidence({
			status: ready ? 'ready' : 'blocked',
			reason: ready
				? `${identity.engine} recorded desktop and narrow SQL Agent Workbench evidence.`
				: `${identity.engine} did not satisfy every SQL Agent Workbench check.`,
			identity,
			frontendSource: { kind: 'local-dist-server', url: frontendServer.url },
			artifacts
		});
		if (!ready) process.exitCode = 1;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		process.stderr.write(`SQL Agent native evidence blocked: ${reason}\n`);
		await writeEvidence({
			status: 'blocked',
			reason,
			identity,
			frontendSource: frontendServer ? { kind: 'local-dist-server', url: frontendServer.url } : undefined,
			artifacts
		});
		process.exitCode = 1;
	} finally {
		if (sessionId) {
			await webdriverRequest(driverUrl, `/session/${sessionId}`, 'DELETE').catch(() => undefined);
		}
		await appHost?.stop();
		await frontendServer?.close();
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

	async function dispatchCommand(commandId) {
		const result = await syncScript(`
			globalThis.__nyalaNativeCaptureCommandError = '';
			try {
				const commandResult = globalThis.__sidex_commandService.executeCommand(${JSON.stringify(commandId)});
				if (commandResult && typeof commandResult.then === 'function') {
					commandResult.catch(error => {
						globalThis.__nyalaNativeCaptureCommandError = String(error?.stack || error);
					});
				}
				return { started: true };
			} catch (error) {
				return { started: false, error: String(error?.stack || error) };
			}
		`);
		if (!result?.started) {
			throw new Error(`Workbench command ${commandId} failed to start: ${result?.error || 'unknown error'}`);
		}
	}

	async function commandError() {
		return syncEval('globalThis.__nyalaNativeCaptureCommandError || ""');
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

	async function waitForFrontendNavigation(expectedUrl) {
		const deadline = Date.now() + scriptTimeoutMs;
		let lastState = 'navigation has not reached the local frontend';
		while (Date.now() < deadline) {
			try {
				const [urlPayload, titlePayload, readyStatePayload] = await Promise.all([
					webdriverRequest(driverUrl, `/session/${sessionId}/url`),
					webdriverRequest(driverUrl, `/session/${sessionId}/title`),
					webdriverRequest(driverUrl, `/session/${sessionId}/execute/sync`, 'POST', {
						script: 'return document.readyState',
						args: []
					})
				]);
				const currentUrl = unwrapWebdriverValue(urlPayload);
				const title = unwrapWebdriverValue(titlePayload);
				const readyState = unwrapWebdriverValue(readyStatePayload);
				lastState = `${currentUrl || 'unknown'} title=${title || 'empty'} readyState=${readyState || 'unknown'}`;
				if (currentUrl === expectedUrl && readyState === 'complete' && title === 'Nyala Studio') {
					// Let WebKit finish the final document-to-Workbench handoff before the
					// first async direct-eval request; otherwise it can be reclaimed.
					await delay(250);
					return;
				}
			} catch (error) {
				lastState = error instanceof Error ? error.message : String(error);
			}
			await delay(100);
		}
		throw new Error(`Timed out waiting for frontend navigation: ${lastState}`);
	}

	async function setWindowSize(viewport) {
		const devicePixelRatio = Number(await syncEval('window.devicePixelRatio'));
		const requestedPhysicalRect = scaleCssViewportToPhysicalWindowRect(viewport, devicePixelRatio);
		const appliedWindowRect = unwrapWebdriverValue(
			await webdriverRequest(driverUrl, `/session/${sessionId}/window/rect`, 'POST', requestedPhysicalRect)
		);
		await delay(250);
		return {
			requestedCssViewport: { width: viewport.width, height: viewport.height },
			requestedPhysicalRect,
			devicePixelRatio,
			appliedWindowRect
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

	async function captureScreenshot(path) {
		const payload = await webdriverRequest(driverUrl, `/session/${sessionId}/screenshot`, 'GET');
		const encoded = unwrapWebdriverValue(payload);
		if (typeof encoded !== 'string' || encoded.length === 0) {
			throw new Error('Embedded WebDriver returned an empty screenshot.');
		}
		const bytes = Buffer.from(encoded, 'base64');
		await writeFile(path, bytes);
		return {
			...inspectPngPixels(bytes),
			bytes: bytes.byteLength,
			sha256: createHash('sha256').update(bytes).digest('hex')
		};
	}
}

function validateRequestedViewport(requested, actual) {
	const passed =
		requested.id === 'narrow'
			? actual.width >= 320 && actual.width <= 420 && actual.height >= 480
			: actual.width >= 1200 && actual.height >= 700;
	return {
		id: 'requested-viewport',
		passed,
		reason: `${requested.id} requested ${requested.width}x${requested.height}; inner viewport ${actual.width}x${actual.height}`
	};
}

async function writeEvidence({ status, reason, identity, frontendSource, artifacts }) {
	const report = {
		version: 1,
		generatedAt: new Date().toISOString(),
		label: identity.platformName === 'windows' ? 'Windows WebView2 SQL Agent' : 'macOS WKWebView SQL Agent',
		status,
		reason,
		...identity,
		...(frontendSource ? { frontendSource } : {}),
		artifacts,
		limitations: [
			'Native automation validates the embedded Workbench DOM, keyboard order, ARIA labels, layout, and screenshots.',
			keyboardLimitation,
			'A real VoiceOver or Narrator walkthrough remains manual and is not claimed by this evidence.'
		],
		keyboardMode
	};
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
	process.stdout.write(`Wrote ${outputPath}\n`);
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

function delay(ms) {
	return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}
