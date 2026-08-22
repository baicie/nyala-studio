#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { hasVisiblePngDiversity, inspectPngPixels } from './sql-result-grid-visual-png.mjs';
import {
	createAgentWorkbenchSnapshotExpression,
	validateAgentWorkbenchSnapshot
} from './sql-agent-workbench-visual-contract.mjs';

class CdpClient {
	static async connect(url, deadline) {
		const socket = new WebSocket(url);
		await Promise.race([
			new Promise((resolve, reject) => {
				socket.addEventListener('open', resolve, { once: true });
				socket.addEventListener('error', () => reject(new Error(`Could not connect to ${url}`)), { once: true });
			}),
			waitUntilDeadline(deadline, `connecting to ${url}`)
		]);
		return new CdpClient(socket);
	}

	constructor(socket) {
		this.socket = socket;
		this.sequence = 0;
		this.pending = new Map();
		socket.addEventListener('message', event => {
			const message = JSON.parse(String(event.data));
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
		});
	}

	send(method, params = {}) {
		return new Promise((resolve, reject) => {
			const id = ++this.sequence;
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	close() {
		this.socket.close();
		for (const pending of this.pending.values()) pending.reject(new Error('CDP connection closed.'));
		this.pending.clear();
	}
}

const cli = parseArgs(process.argv.slice(2));
if (cli.help) {
	process.stdout.write(
		`Usage: node scripts/capture-sql-agent-workbench.mjs [options]\n\nOptions:\n  --url <url>             Running Nyala Vite URL (default: http://localhost:1420/)\n  --output-dir <path>     Screenshot and manifest directory\n  --chrome <path>         Chrome executable (or set NYALA_CHROME)\n  --timeout-ms <n>        Overall timeout between 10000 and 120000\n`
	);
	process.exit(0);
}

const targetUrl = new URL(cli.url ?? 'http://localhost:1420/').href;
const outputDir = resolve(cli['output-dir'] ?? join(tmpdir(), 'nyala-sql-agent-workbench'));
const timeoutMs = parseBoundedInteger(cli['timeout-ms'] ?? '90000', '--timeout-ms', 10_000, 120_000);
const browser = cli.chrome ?? process.env.NYALA_CHROME ?? (await findChrome());
const viewports = [
	{ id: 'desktop', width: 1440, height: 900 },
	{ id: 'narrow', width: 390, height: 844 }
];

if (!browser) throw new Error('Chrome is required. Pass --chrome or set NYALA_CHROME.');
await mkdir(outputDir, { recursive: true });
const profileDir = await mkdtemp(join(tmpdir(), 'nyala-sql-agent-cdp-'));
const browserProcess = spawn(
	browser,
	[
		'--headless=new',
		'--no-sandbox',
		'--disable-gpu',
		'--disable-dev-shm-usage',
		'--disable-extensions',
		'--disable-background-networking',
		'--disable-component-update',
		'--disable-default-apps',
		'--disable-sync',
		'--no-first-run',
		'--remote-debugging-port=0',
		`--user-data-dir=${profileDir}`,
		'about:blank'
	],
	{ stdio: 'ignore' }
);

const deadline = Date.now() + timeoutMs;
let client;
try {
	const { port } = await readDevToolsEndpoint(profileDir, deadline);
	const target = await createTarget(port, targetUrl, deadline);
	client = await CdpClient.connect(target.webSocketDebuggerUrl, deadline);
	await Promise.all([client.send('Page.enable'), client.send('Runtime.enable'), client.send('Log.enable')]);
	await waitForExpression(
		client,
		`Boolean(document.querySelector('.monaco-workbench')) && !document.querySelector('#nyala-splash') && !document.body.innerText.includes('Nyala failed to start')`,
		deadline,
		'Workbench boot'
	);
	await evaluate(
		client,
		`import('/src/vs/workbench/browser/web.factory.ts').then(module => module.commands.executeCommand('sql.agent.openPanel')).then(() => true)`
	);
	await waitForExpression(client, `Boolean(document.querySelector('.sql-agent-view'))`, deadline, 'SQL Agent panel');

	const artifacts = [];
	for (const viewport of viewports) {
		if (viewport.width <= 420) {
			await evaluate(
				client,
				`import('/src/vs/workbench/browser/web.factory.ts').then(module => module.commands.executeCommand('workbench.action.closeSidebar')).then(() => true)`
			);
		}
		await client.send('Emulation.setDeviceMetricsOverride', {
			width: viewport.width,
			height: viewport.height,
			deviceScaleFactor: 1,
			mobile: false
		});
		await delay(500);
		const tabOrder = await collectTabOrder(client);
		const snapshot = await evaluate(client, createAgentWorkbenchSnapshotExpression());
		const screenshot = await client.send('Page.captureScreenshot', {
			format: 'png',
			fromSurface: true,
			captureBeyondViewport: false
		});
		const bytes = Buffer.from(screenshot.data, 'base64');
		const screenshotName = `sql-agent-workbench-${viewport.id}.png`;
		await writeFile(join(outputDir, screenshotName), bytes);
		const png = inspectPngPixels(bytes);
		const checks = [
			...validateAgentWorkbenchSnapshot(snapshot, viewport, tabOrder),
			{
				id: 'screenshot-viewport',
				passed: png.width === viewport.width && png.height === viewport.height,
				reason: `${png.width}x${png.height}; expected ${viewport.width}x${viewport.height}`
			},
			{
				id: 'screenshot-pixel-diversity',
				passed: hasVisiblePngDiversity(png),
				reason: `${png.distinctColorBuckets} color bucket(s), luma range ${png.lumaRange}`
			}
		];
		artifacts.push({
			viewport,
			status: checks.every(check => check.passed) ? 'ready' : 'blocked',
			screenshot: screenshotName,
			screenshotBytes: bytes.byteLength,
			screenshotSha256: createHash('sha256').update(bytes).digest('hex'),
			snapshot,
			tabOrder,
			checks
		});
	}
	const report = {
		version: 1,
		generatedAt: new Date().toISOString(),
		status: artifacts.every(artifact => artifact.status === 'ready') ? 'ready' : 'blocked',
		url: targetUrl,
		browser: await evaluate(client, 'navigator.userAgent'),
		artifacts,
		limitations: [
			'Chromium validates the real Workbench contribution but does not replace macOS WebKit or Windows WebView2 native evidence.',
			'The browser preview does not invoke Tauri or a database and therefore does not prove native Agent execution.'
		]
	};
	await writeFile(join(outputDir, 'workbench-evidence.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
	process.stdout.write(`Wrote ${outputDir}/workbench-evidence.json\n`);
	process.exitCode = report.status === 'ready' ? 0 : 1;
} finally {
	client?.close();
	browserProcess.kill('SIGTERM');
	await Promise.race([new Promise(resolve => browserProcess.once('exit', resolve)), delay(3_000)]);
	if (browserProcess.exitCode === null) browserProcess.kill('SIGKILL');
	await rm(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

async function collectTabOrder(client) {
	await evaluate(client, `document.querySelector('[aria-label="Agent prompt"]')?.focus(); true`);
	const order = [await activeAriaLabel(client)];
	for (let index = 0; index < 3; index += 1) {
		await client.send('Input.dispatchKeyEvent', {
			type: 'keyDown',
			key: 'Tab',
			code: 'Tab',
			windowsVirtualKeyCode: 9,
			nativeVirtualKeyCode: 9
		});
		await client.send('Input.dispatchKeyEvent', {
			type: 'keyUp',
			key: 'Tab',
			code: 'Tab',
			windowsVirtualKeyCode: 9,
			nativeVirtualKeyCode: 9
		});
		order.push(await activeAriaLabel(client));
	}
	return order;
}

async function activeAriaLabel(client) {
	return evaluate(client, `document.activeElement?.getAttribute('aria-label') || ''`);
}

async function evaluate(client, expression) {
	const response = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
	if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? 'Runtime.evaluate failed');
	return response.result?.value;
}

async function waitForExpression(client, expression, deadline, label) {
	while (Date.now() < deadline) {
		if (await evaluate(client, expression)) return;
		await delay(100);
	}
	throw new Error(`Timed out waiting for ${label}.`);
}

async function readDevToolsEndpoint(profileDir, deadline) {
	const file = join(profileDir, 'DevToolsActivePort');
	while (Date.now() < deadline) {
		try {
			const [port] = (await readFile(file, 'utf8')).trim().split(/\r?\n/);
			if (Number.isInteger(Number(port))) return { port: Number(port) };
		} catch {
			// Chrome writes the endpoint after its profile is initialized.
		}
		await delay(50);
	}
	throw new Error('Timed out waiting for Chrome DevTools endpoint.');
}

async function createTarget(port, url, deadline) {
	const browserTarget = await waitForJson(`http://127.0.0.1:${port}/json/version`, deadline);
	const client = await CdpClient.connect(browserTarget.webSocketDebuggerUrl, deadline);
	try {
		const created = await client.send('Target.createTarget', { url });
		while (Date.now() < deadline) {
			const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`, deadline);
			const target = targets.find(item => item.id === created.targetId);
			if (target?.webSocketDebuggerUrl) return target;
			await delay(50);
		}
		throw new Error('Timed out waiting for the Nyala page target.');
	} finally {
		client.close();
	}
}

async function waitForJson(url, deadline) {
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.ok) return response.json();
		} catch {
			// DevTools HTTP endpoint may not be ready yet.
		}
		await delay(50);
	}
	throw new Error(`Timed out waiting for ${url}.`);
}

async function waitUntilDeadline(deadline, action) {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new Error(`Timed out ${action}.`);
	await delay(remaining);
	throw new Error(`Timed out ${action}.`);
}

function delay(milliseconds) {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function parseArgs(args) {
	const result = {};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
		const [key, inlineValue] = argument.slice(2).split('=', 2);
		if (inlineValue !== undefined) result[key] = inlineValue;
		else if (args[index + 1]?.startsWith('--')) result[key] = 'true';
		else result[key] = args[++index] ?? 'true';
	}
	return result;
}

function parseBoundedInteger(value, name, minimum, maximum) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
	}
	return parsed;
}

async function findChrome() {
	for (const candidate of [
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/usr/bin/google-chrome-stable',
		'/usr/bin/google-chrome',
		'google-chrome-stable',
		'google-chrome',
		'chromium'
	]) {
		if (candidate.includes(sep)) {
			try {
				await stat(candidate);
				return candidate;
			} catch {
				continue;
			}
		}
		try {
			execFileSync('sh', ['-c', `command -v '${candidate}'`], { stdio: 'ignore' });
			return candidate;
		} catch {
			continue;
		}
	}
	return undefined;
}
