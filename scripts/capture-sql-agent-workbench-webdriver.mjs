#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
	createEmbeddedWebdriverSession,
	identifyEmbeddedWebview,
	launchTauriEmbeddedWebdriver,
	unwrapWebdriverValue,
	webdriverRequest
} from './tauri-embedded-webdriver.mjs';
import { hasVisiblePngDiversity, inspectPngPixels } from './sql-result-grid-visual-png.mjs';
import {
	createAgentWorkbenchSnapshotExpression,
	validateAgentWorkbenchSnapshot
} from './sql-agent-workbench-visual-contract.mjs';

const cli = parseArgs(process.argv.slice(2));
if (cli.help === 'true') {
	process.stdout.write(`Usage: node scripts/capture-sql-agent-workbench-webdriver.mjs [options]
  --app-binary <path>       Webdriver-enabled Nyala debug binary
  --platform <name>         macos or windows
  --driver-url <url>        Embedded WebDriver endpoint (default: http://127.0.0.1:4445)
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

if (!appBinary) throw new Error('--app-binary is required.');
if (!['macos', 'windows'].includes(platform)) {
	throw new Error(`--platform must be macos or windows, got ${platform || 'empty'}`);
}

await run();

async function run() {
	const artifacts = [];
	let sessionId;
	let appHost;
	let temporaryRoot;
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
		await waitForExpression(
			`Boolean(globalThis.__sidex_commandService) && Boolean(document.querySelector('.monaco-workbench')) && !document.querySelector('#nyala-splash')`,
			'Workbench boot'
		);

		for (const requestedViewport of requestedViewports) {
			await setWindowSize(requestedViewport);
			if (requestedViewport.id === 'narrow') {
				await directEval(
					`globalThis.__sidex_commandService.executeCommand('workbench.action.closeSidebar').then(() => true)`
				);
			}
			await directEval(`globalThis.__sidex_commandService.executeCommand('sql.agent.openPanel').then(() => true)`);
			await waitForExpression(
				`Boolean(document.querySelector('.sql-agent-view')) && document.querySelector('.sql-agent-view').getClientRects().length > 0`,
				`${requestedViewport.id} SQL Agent panel`
			);
			await directEval(`new Promise(resolve => setTimeout(() => resolve(true), 350))`);

			const tabOrder = await collectTabOrder();
			const snapshot = await directEval(createAgentWorkbenchSnapshotExpression());
			const viewport = {
				id: requestedViewport.id,
				width: snapshot.viewportWidth,
				height: snapshot.viewportHeight
			};
			const screenshotName = `sql-agent-${platform}-${requestedViewport.id}.png`;
			const screenshot = await captureScreenshot(join(screenshotDir, screenshotName));
			const checks = [
				...validateAgentWorkbenchSnapshot(snapshot, viewport, tabOrder),
				validateRequestedViewport(requestedViewport, viewport),
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
				viewport,
				status: checks.every(check => check.passed) ? 'ready' : 'blocked',
				screenshot: screenshotName,
				screenshotBytes: screenshot.bytes,
				screenshotSha256: screenshot.sha256,
				snapshot,
				tabOrder,
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
			artifacts
		});
		if (!ready) process.exitCode = 1;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		process.stderr.write(`SQL Agent native evidence blocked: ${reason}\n`);
		await writeEvidence({ status: 'blocked', reason, identity, artifacts });
		process.exitCode = 1;
	} finally {
		if (sessionId) {
			await webdriverRequest(driverUrl, `/session/${sessionId}`, 'DELETE').catch(() => undefined);
		}
		await appHost?.stop();
		if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
	}

	async function directEval(expression) {
		const done = 'arguments[arguments.length - 1]';
		const payload = await webdriverRequest(
			driverUrl,
			'/wdio/eval',
			'POST',
			{
				script: `Promise.resolve().then(() => (${expression})).then(value => ${done}({ ok: true, value, undef: value === undefined })).catch(error => ${done}({ ok: false, error: String(error?.stack || error) }));`,
				window_label: 'main',
				timeout_ms: scriptTimeoutMs
			},
			{ timeoutMs: scriptTimeoutMs + 5_000 }
		);
		if (payload.error) throw new Error(`Embedded direct eval failed: ${payload.error}`);
		return payload.value;
	}

	async function waitForExpression(expression, label) {
		const deadline = Date.now() + scriptTimeoutMs;
		while (Date.now() < deadline) {
			if (await directEval(expression)) return;
			await delay(100);
		}
		throw new Error(`Timed out waiting for ${label}.`);
	}

	async function setWindowSize(viewport) {
		await webdriverRequest(driverUrl, `/session/${sessionId}/window/rect`, 'POST', {
			width: viewport.width,
			height: viewport.height
		});
		await delay(250);
	}

	async function collectTabOrder() {
		await directEval(`document.querySelector('[aria-label="Agent prompt"]')?.focus(); true`);
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
		return order;
	}

	async function activeAriaLabel() {
		return directEval(`document.activeElement?.getAttribute('aria-label') || ''`);
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

async function writeEvidence({ status, reason, identity, artifacts }) {
	const report = {
		version: 1,
		generatedAt: new Date().toISOString(),
		label: identity.platformName === 'windows' ? 'Windows WebView2 SQL Agent' : 'macOS WKWebView SQL Agent',
		status,
		reason,
		...identity,
		artifacts,
		limitations: [
			'Native automation validates the embedded Workbench DOM, keyboard order, ARIA labels, layout, and screenshots.',
			'A real VoiceOver or Narrator walkthrough remains manual and is not claimed by this evidence.'
		]
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
