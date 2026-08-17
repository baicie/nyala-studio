#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXECUTION_ORDER, isBenchmarkResultForRun } from './sql-result-grid-benchmark-contract.mjs';
import { CdpClient } from './sql-result-grid-cdp-client.mjs';
import { hasVisiblePngDiversity, inspectPngPixels } from './sql-result-grid-visual-png.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workloads = [
	{ id: '1k-x-20', rows: 1_000, columns: 20, width: 1440, height: 420, wide: false },
	{ id: '10k-x-50', rows: 10_000, columns: 50, width: 1440, height: 420, wide: false },
	{ id: 'wide-columns', rows: 1_000, columns: 20, width: 1440, height: 420, wide: true },
	{ id: 'narrow-panel', rows: 1_000, columns: 20, width: 390, height: 420, wide: false }
];
const renderers = ['native', 'workbench-table'];
const maxRepeat = 5;
const browserTimeoutMs = 45_000;
const cli = parseArgs(process.argv.slice(2));
if (cli.help) {
	process.stdout.write(
		`Usage: node scripts/capture-sql-result-grid-visual.mjs [options]\n\nOptions:\n  --repeat <n>                 Captures per workload/renderer (default: 1, max: 5)\n  --renderer <names>           native,workbench-table (comma-separated)\n  --workload <ids>             Comma-separated workload ids\n  --screenshot-dir <path>      Output directory for PNG screenshots\n  --output <path>              Output visual evidence JSON\n`
	);
	process.exit(0);
}
const repeat = parsePositiveInteger(cli.repeat ?? '1', '--repeat');
const selectedRenderers = selectValues(cli.renderer, renderers, '--renderer');
const selectedWorkloads = selectWorkloads(cli.workload);
const outputPath = resolve(cli.output ?? join(repositoryRoot, 'visual-evidence.json'));
const screenshotDir = resolve(cli['screenshot-dir'] ?? join(dirname(outputPath), 'screenshots'));
const chromeCandidates = [
	process.env.NYALA_CHROME,
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/google-chrome',
	'google-chrome-stable',
	'google-chrome',
	'chromium'
].filter(Boolean);

const browser = await findExecutable(chromeCandidates);
const browserVersion = browser ? getBrowserVersion(browser) : undefined;
const temporaryRoot = await mkdtemp(join(process.env.RUNNER_TEMP ?? '/tmp', 'nyala-sql-result-visual-'));
const artifacts = [];
const artifactPaths = new Set();
let browserRunner;
let reason;

try {
	await mkdir(screenshotDir, { recursive: true });
	if (!browser) {
		reason = 'Chrome or Chromium was not found; set NYALA_CHROME to a browser executable.';
	} else {
		const pagePath = join(temporaryRoot, 'benchmark.html');
		execFileSync(
			process.execPath,
			[
				join(repositoryRoot, 'scripts/benchmark-sql-result-grid.mjs'),
				'--emit-page',
				pagePath,
				'--renderer',
				selectedRenderers.join(',')
			],
			{ stdio: 'inherit' }
		);
		const pageUrl = pathToFileURL(pagePath).href;
		browserRunner = await launchChromiumCapture(browser, join(temporaryRoot, 'chrome-profile'));
		let executionOrdinal = 0;
		for (const workload of selectedWorkloads) {
			for (const renderer of selectedRenderers) {
				for (let iteration = 1; iteration <= repeat; iteration += 1) {
					executionOrdinal += 1;
					const screenshotName = `${workload.id}-${renderer}-${iteration}.png`;
					const screenshotPath = join(screenshotDir, screenshotName);
					if (artifactPaths.has(screenshotPath)) throw new Error(`Duplicate screenshot path: ${screenshotPath}`);
					artifactPaths.add(screenshotPath);
					const artifact = await captureArtifact({
						client: browserRunner.client,
						pageUrl,
						workload,
						renderer,
						iteration,
						executionOrdinal,
						screenshotPath
					});
					artifacts.push(artifact);
					process.stdout.write(
						`${workload.id}/${renderer} #${iteration}: ${artifact.status} ${artifact.screenshotBytes} bytes\n`
					);
				}
			}
		}
	}
} catch (error) {
	reason = error instanceof Error ? error.message : String(error);
} finally {
	await browserRunner?.close();
	await rm(temporaryRoot, { recursive: true, force: true });
}

const expectedArtifactCount = selectedWorkloads.length * selectedRenderers.length * repeat;
const ready =
	!reason &&
	artifacts.length === expectedArtifactCount &&
	artifacts.every(artifact => artifact.status === 'ok' && artifact.visualChecks.every(check => check.passed));
const report = {
	version: 1,
	generatedAt: new Date().toISOString(),
	status: ready ? 'ready' : 'blocked',
	...(reason ? { reason } : {}),
	browser: browser ?? null,
	browserVersion: browserVersion ?? null,
	repeat,
	workloads: selectedWorkloads,
	renderers: selectedRenderers,
	expectedArtifactCount,
	artifactCount: artifacts.length,
	screenshotDirectory: relative(dirname(outputPath), screenshotDir) || '.',
	artifacts,
	limitations: [
		'Chromium headless screenshots are visual review evidence, not macOS WebKit or Windows WebView2 evidence.',
		'The page is a standalone result-grid characterization and does not boot the Workbench or invoke Tauri.',
		'Zeus screenshots require the separate platform evidence workflow and are not enabled by the synthetic CI job.'
	]
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`Wrote ${outputPath}\n`);
process.exitCode = ready ? 0 : 1;

async function captureArtifact({ client, pageUrl, workload, renderer, iteration, executionOrdinal, screenshotPath }) {
	const runToken = randomUUID();
	const url = `${pageUrl}?${new URLSearchParams({
		run: runToken,
		renderer,
		executionOrder: EXECUTION_ORDER,
		executionOrdinal: String(executionOrdinal),
		rows: String(workload.rows),
		columns: String(workload.columns),
		wide: String(workload.wide),
		width: String(workload.width),
		height: String(workload.height)
	})}`;
	try {
		await client.send('Emulation.setDeviceMetricsOverride', {
			width: workload.width,
			height: workload.height,
			deviceScaleFactor: 1,
			mobile: false
		});
		const navigation = await client.send('Page.navigate', { url });
		if (navigation.errorText) {
			throw new Error(`Visual capture navigation failed for ${workload.id}/${renderer}: ${navigation.errorText}`);
		}
		const record = await waitForBenchmarkRecord(client, Date.now() + browserTimeoutMs, url, {
			runToken,
			renderer,
			executionOrder: EXECUTION_ORDER,
			executionOrdinal,
			workload
		});
		const screenshot = await client.send('Page.captureScreenshot', {
			format: 'png',
			fromSurface: true,
			captureBeyondViewport: false
		});
		const screenshotBytes = Buffer.from(screenshot.data, 'base64');
		await writeFile(screenshotPath, screenshotBytes);
		const visual = await inspectVisualEvidence(screenshotPath, workload, renderer, record);
		return {
			workloadId: workload.id,
			renderer,
			iteration,
			status: record.status === 'ok' && visual.every(check => check.passed) ? 'ok' : 'blocked',
			record,
			screenshot: relative(dirname(outputPath), screenshotPath).split(sep).join('/'),
			screenshotBytes: screenshotBytes.byteLength,
			screenshotSha256: createHash('sha256').update(screenshotBytes).digest('hex'),
			visualChecks: [
				{
					id: 'benchmark-status',
					passed: record.status === 'ok',
					reason: record.status === 'ok' ? 'benchmark completed' : `benchmark status was ${record.status}`
				},
				...visual
			]
		};
	} catch (error) {
		return {
			workloadId: workload.id,
			renderer,
			iteration,
			status: 'blocked',
			reason: error instanceof Error ? error.message : String(error),
			visualChecks: [{ id: 'capture', passed: false, reason: error instanceof Error ? error.message : String(error) }]
		};
	}
}

async function launchChromiumCapture(browser, profileDirectory) {
	const browserProcess = spawn(
		browser,
		[
			'--headless=new',
			'--disable-gpu',
			'--no-sandbox',
			'--disable-dev-shm-usage',
			'--disable-background-networking',
			'--disable-background-timer-throttling',
			'--disable-backgrounding-occluded-windows',
			'--disable-component-update',
			'--disable-default-apps',
			'--disable-renderer-backgrounding',
			'--no-first-run',
			'--enable-precise-memory-info',
			'--remote-debugging-port=0',
			`--user-data-dir=${profileDirectory}`,
			'about:blank'
		],
		{ stdio: 'ignore' }
	);
	const deadline = Date.now() + 20_000;
	let client;
	try {
		const port = await readDevToolsPort(profileDirectory, deadline);
		const target = await createPageTarget(port, deadline);
		client = await CdpClient.connect(target.webSocketDebuggerUrl, deadline);
		await Promise.all([client.send('Page.enable'), client.send('Runtime.enable')]);
		return {
			client,
			async close() {
				client.close();
				await stopBrowser(browserProcess);
			}
		};
	} catch (error) {
		client?.close();
		await stopBrowser(browserProcess);
		throw error;
	}
}

async function waitForBenchmarkRecord(client, deadline, expectedUrl, expected) {
	let lastError;
	while (Date.now() < deadline) {
		try {
			const response = await client.send('Runtime.evaluate', {
				expression: `({ href: location.href, readyState: document.readyState, resultText: document.querySelector('#benchmark-result')?.textContent || '' })`,
				returnByValue: true
			});
			if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? 'Runtime.evaluate failed');
			const page = response.result?.value;
			if (
				page?.href === expectedUrl &&
				page.readyState !== 'loading' &&
				typeof page.resultText === 'string' &&
				page.resultText.trim()
			) {
				const record = JSON.parse(page.resultText);
				if (isBenchmarkResultForRun(record, expected)) return record;
				lastError = new Error(`Ignored stale or mismatched visual result for run ${expected.runToken}.`);
			}
		} catch (error) {
			lastError = error;
		}
		await delay(25);
	}
	const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
	throw new Error(`Visual capture timed out for ${expected.workload.id}/${expected.renderer}.${detail}`);
}

async function readDevToolsPort(profileDirectory, deadline) {
	const endpointFile = join(profileDirectory, 'DevToolsActivePort');
	while (Date.now() < deadline) {
		try {
			const [port] = (await readFile(endpointFile, 'utf8')).trim().split(/\r?\n/);
			if (Number.isInteger(Number(port))) return Number(port);
		} catch {
			// Chrome writes the endpoint after initializing its temporary profile.
		}
		await delay(25);
	}
	throw new Error('Timed out waiting for the Chromium DevTools endpoint.');
}

async function createPageTarget(port, deadline) {
	const browserTarget = await waitForJson(`http://127.0.0.1:${port}/json/version`, deadline);
	const browserClient = await CdpClient.connect(browserTarget.webSocketDebuggerUrl, deadline);
	try {
		const created = await browserClient.send('Target.createTarget', { url: 'about:blank' });
		while (Date.now() < deadline) {
			const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`, deadline);
			const target = targets.find(item => item.id === created.targetId);
			if (target?.webSocketDebuggerUrl) return target;
			await delay(25);
		}
		throw new Error('Timed out waiting for the Chromium page target.');
	} finally {
		browserClient.close();
	}
}

async function waitForJson(url, deadline) {
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.ok) return response.json();
		} catch {
			// The loopback DevTools endpoint may not be ready yet.
		}
		await delay(25);
	}
	throw new Error(`Timed out waiting for ${url}.`);
}

async function stopBrowser(browserProcess) {
	if (browserProcess.exitCode !== null) return;
	browserProcess.kill('SIGTERM');
	await Promise.race([new Promise(resolveExit => browserProcess.once('exit', resolveExit)), delay(3_000)]);
	if (browserProcess.exitCode === null) browserProcess.kill('SIGKILL');
}

function delay(milliseconds) {
	return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

async function inspectVisualEvidence(filePath, workload, renderer, record) {
	const checks = [];
	let bytes;
	try {
		bytes = await readFile(filePath);
	} catch (error) {
		return [{ id: 'screenshot-file', passed: false, reason: error instanceof Error ? error.message : String(error) }];
	}
	checks.push({ id: 'screenshot-non-empty', passed: bytes.byteLength > 0, reason: `${bytes.byteLength} bytes` });
	let png;
	let pngError;
	try {
		png = inspectPngPixels(bytes);
	} catch (error) {
		pngError = error instanceof Error ? error.message : String(error);
	}
	checks.push({
		id: 'screenshot-png',
		passed: png !== undefined,
		reason: png ? `${png.width}x${png.height}, color type ${png.colorType}` : (pngError ?? 'unsupported PNG')
	});
	if (png) {
		checks.push({
			id: 'screenshot-viewport',
			passed: png.width === workload.width && png.height === workload.height,
			reason: `${png.width}x${png.height}; expected ${workload.width}x${workload.height}`
		});
		checks.push({
			id: 'screenshot-pixel-diversity',
			passed: hasVisiblePngDiversity(png),
			reason: `${png.distinctColorBuckets} color bucket(s), luma range ${png.lumaRange}, ${(png.visiblePixelRatio * 100).toFixed(1)}% visible`
		});
	}
	const probe = record.visualProbe;
	checks.push({
		id: 'renderer-identity',
		passed: record.renderer === renderer,
		reason: `recorded ${record.renderer ?? 'unknown'}; expected ${renderer}`
	});
	checks.push({
		id: 'rendered-rows',
		passed: Number.isInteger(record.renderedRows) && record.renderedRows > 0,
		reason: `${record.renderedRows ?? 0} visible/rendered row(s)`
	});
	checks.push({
		id: 'root-bounds',
		passed:
			Number.isFinite(probe?.rootWidth) &&
			Number.isFinite(probe?.rootHeight) &&
			probe.rootWidth >= workload.width &&
			probe.rootHeight >= workload.height,
		reason: `${probe?.rootWidth ?? 0}x${probe?.rootHeight ?? 0}; expected at least ${workload.width}x${workload.height}`
	});
	checks.push({
		id: 'header-sentinel',
		passed: probe?.headerText === 'column_0',
		reason: `header sentinel was ${JSON.stringify(probe?.headerText ?? '')}`
	});
	checks.push({
		id: 'cell-sentinel',
		passed: typeof probe?.firstVisibleCellText === 'string' && probe.firstVisibleCellText.length > 0,
		reason: `first visible cell was ${JSON.stringify(probe?.firstVisibleCellText ?? '')}`
	});
	checks.push({
		id: 'visible-text',
		passed: Number.isInteger(probe?.visibleTextLength) && probe.visibleTextLength >= 20,
		reason: `${probe?.visibleTextLength ?? 0} visible text character(s)`
	});
	return checks;
}

function selectValues(value, allowed, name) {
	const selected = value ? value.split(',').filter(Boolean) : allowed;
	if (selected.length === 0 || selected.some(item => !allowed.includes(item))) {
		throw new Error(`${name} must contain only ${allowed.join(', ')}`);
	}
	if (new Set(selected).size !== selected.length) throw new Error(`${name} must not contain duplicate values`);
	return selected;
}

function selectWorkloads(value) {
	const selected = value ? value.split(',').filter(Boolean) : workloads.map(workload => workload.id);
	const known = new Set(workloads.map(workload => workload.id));
	if (selected.length === 0 || selected.some(item => !known.has(item))) {
		throw new Error(`--workload must contain only ${[...known].join(', ')}`);
	}
	if (new Set(selected).size !== selected.length) throw new Error('--workload must not contain duplicate values');
	return workloads.filter(workload => selected.includes(workload.id));
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

function parsePositiveInteger(value, name) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxRepeat) {
		throw new Error(`${name} must be an integer between 1 and ${maxRepeat}`);
	}
	return parsed;
}

async function findExecutable(candidates) {
	for (const candidate of candidates) {
		if (candidate.includes(sep)) {
			try {
				await stat(candidate);
				return candidate;
			} catch {
				continue;
			}
		}
		try {
			execFileSync('sh', ['-c', `command -v '${candidate.replaceAll("'", "'\\''")}'`], { stdio: 'ignore' });
			return candidate;
		} catch {
			continue;
		}
	}
	return undefined;
}

function getBrowserVersion(browser) {
	try {
		return execFileSync(browser, ['--version'], { encoding: 'utf8', timeout: 5_000 }).trim();
	} catch {
		return undefined;
	}
}
