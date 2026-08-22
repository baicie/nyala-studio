#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	convergeWindowRectForCssViewport,
	createEmbeddedWebdriverSession,
	identifyEmbeddedWebview,
	launchTauriEmbeddedWebdriver,
	unwrapWebdriverValue,
	webdriverRequest
} from './tauri-embedded-webdriver.mjs';
import {
	createBalancedBenchmarkPlan,
	EXECUTION_ORDER,
	isBenchmarkResultForRun,
	MEASUREMENT_CONTRACT_VERSION,
	SCROLL_COMMIT_BOUNDARY
} from './sql-result-grid-benchmark-contract.mjs';
import {
	hasVisiblePngDiversity,
	inspectPngPixels,
	validatePngViewportDimensions
} from './sql-result-grid-visual-png.mjs';
import {
	createSqlResultGridRunMarkerBytes,
	inspectSqlResultGridRunMarker,
	SQL_RESULT_GRID_RUN_MARKER_VERSION
} from './sql-result-grid-run-marker.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultOutput = join(repositoryRoot, 'platform-evidence.json');
const cli = parseArgs(process.argv.slice(2));
if (cli.help === 'true') {
	process.stdout.write(`Usage: node scripts/benchmark-sql-result-grid-webdriver.mjs [options]
  --app-binary <path>    Start a webdriver-feature Nyala binary (embedded provider)
  --platform <name>      macos or windows for embedded evidence
  --driver-url <url>     WebDriver endpoint (embedded default: http://127.0.0.1:4445)
  --renderer <list>      native,workbench-table,zeus or all
  --workload <list>      1k-x-20,10k-x-50,wide-columns,narrow-panel or all
  --repeat <1..5>        Runs per workload and renderer
  --zeus-bundle <path>   Audited Zeus browser bundle
  --output <path>        Evidence JSON destination
  --screenshot-dir <dir> Screenshot destination
  --app-log <path>       Captured native application log
  --repository <owner/name> GitHub repository provenance
  --source-revision <sha> Tested Git commit provenance
  --source-ref <ref>     Tested Git ref provenance
  --workflow-run-id <id> GitHub Actions run provenance
  --workflow-run-attempt <n> GitHub Actions attempt provenance
  --script-timeout-ms <n> WebDriver script budget (default: 120000)
`);
	process.exit(0);
}
const appBinary = cli['app-binary'] ? resolve(cli['app-binary']) : undefined;
const platform =
	cli.platform ?? (process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : '');
const browser = cli.browser ?? 'safari';
const repeat = parseBoundedPositiveInteger(cli.repeat ?? '5', '--repeat', 5);
const driverUrl = String(cli['driver-url'] ?? (appBinary ? 'http://127.0.0.1:4445' : 'http://127.0.0.1:4444')).replace(
	/\/$/,
	''
);
const startupTimeoutMs = parseBoundedPositiveInteger(
	cli['startup-timeout-ms'] ?? '120000',
	'--startup-timeout-ms',
	300_000
);
const scriptTimeoutMs = parseBoundedPositiveInteger(
	cli['script-timeout-ms'] ?? '120000',
	'--script-timeout-ms',
	300_000
);
const outputPath = resolve(cli.output ?? defaultOutput);
const screenshotDir = resolve(cli['screenshot-dir'] ?? join(repositoryRoot, 'platform-screenshots'));
const zeusBundle = cli['zeus-bundle'] ?? '/tmp/nyala-zeus-audit/data-grid-bundle.js';
const label = cli.label ?? (platform === 'windows' || browser === 'edge' ? 'Windows WebView2' : 'macOS WebKit');
const workloads = [
	{ id: '1k-x-20', rows: 1_000, columns: 20, width: 1440, height: 420, wide: false },
	{ id: '10k-x-50', rows: 10_000, columns: 50, width: 1440, height: 420, wide: false },
	{ id: 'wide-columns', rows: 1_000, columns: 20, width: 1440, height: 420, wide: true },
	{ id: 'narrow-panel', rows: 1_000, columns: 20, width: 390, height: 420, wide: false }
];
const renderers = ['native', 'workbench-table', 'zeus'];
const selectedWorkloads = selectValues(cli.workload, workloads, 'workload');
const selectedRenderers = selectValues(cli.renderer, renderers, 'renderer');
const baseProvenance = createEvidenceProvenance(cli);

if (!appBinary && !['safari', 'edge'].includes(browser)) {
	throw new Error(`browser must be safari or edge, got ${browser}`);
}
if (appBinary && !['macos', 'windows'].includes(platform)) {
	throw new Error(`--platform must be macos or windows for embedded evidence, got ${platform || 'empty'}`);
}

await run();

async function run() {
	const records = [];
	const screenshots = [];
	let sessionId;
	let temporaryRoot;
	let appHost;
	let benchmarkServer;
	let provenance = baseProvenance;
	let identity = {
		driverProvider: appBinary ? 'embedded' : 'external',
		nativeWebView: false,
		nativeWebView2: false,
		engine: appBinary ? 'embedded-unverified' : browser === 'safari' ? 'safari-webdriver' : 'msedgedriver',
		browser,
		platformName: platform || undefined
	};
	try {
		await mkdir(screenshotDir, { recursive: true });
		await mkdir(dirname(outputPath), { recursive: true });
		if (appBinary) provenance = { ...provenance, binarySha256: await sha256File(appBinary) };
		if (selectedRenderers.includes('zeus')) {
			provenance = { ...provenance, zeusBundleSha256: await sha256File(zeusBundle) };
		}
		temporaryRoot = await mkdtemp(join(process.env.RUNNER_TEMP ?? '/tmp', 'nyala-sql-webdriver-'));
		const pagePath = join(temporaryRoot, 'benchmark.html');
		const emitArgs = [
			join(repositoryRoot, 'scripts/benchmark-sql-result-grid.mjs'),
			'--emit-page',
			pagePath,
			'--renderer',
			selectedRenderers.join(','),
			'--zeus-bundle',
			zeusBundle
		];
		if (selectedRenderers.includes('zeus')) emitArgs.push('--require-zeus', 'true');
		execFileSync(process.execPath, emitArgs, { stdio: 'inherit' });
		benchmarkServer = await serveBenchmarkPage(pagePath);

		if (appBinary) {
			appHost = await launchTauriEmbeddedWebdriver({
				appBinary,
				driverUrl,
				dataDir: cli['app-data-dir'] ?? join(temporaryRoot, 'app-data'),
				logPath: cli['app-log'],
				timeoutMs: startupTimeoutMs
			});
		}
		const session = appBinary
			? await createEmbeddedWebdriverSession(driverUrl)
			: await createExternalSession(driverUrl, browser);
		sessionId = session.sessionId;
		await setSessionTimeouts(driverUrl, sessionId, scriptTimeoutMs);
		if (appBinary) identity = identifyEmbeddedWebview(session.capabilities, platform);
		const benchmarkPlan = createBalancedBenchmarkPlan(selectedWorkloads, selectedRenderers, repeat);
		for (const { workload, renderer, iteration, executionOrdinal } of benchmarkPlan) {
			const runToken = randomUUID();
			await resetPageForViewportCalibration(driverUrl, sessionId, Boolean(appBinary));
			const query = {
				run: runToken,
				renderer,
				executionOrder: EXECUTION_ORDER,
				executionOrdinal: String(executionOrdinal),
				rows: String(workload.rows),
				columns: String(workload.columns),
				wide: String(workload.wide),
				width: String(workload.width),
				height: String(workload.height),
				deferStart: 'true'
			};
			if (iteration === 1) {
				query.screenshotRunMarker = Buffer.from(createSqlResultGridRunMarkerBytes(runToken)).toString('hex');
			}
			const url = `${benchmarkServer.url}?${new URLSearchParams(query)}`;
			await webdriverRequest(driverUrl, `/session/${sessionId}/url`, 'POST', { url });
			await waitForNavigation(driverUrl, sessionId, url);
			const viewportCalibration = await calibrateCssViewport(driverUrl, sessionId, workload, Boolean(appBinary));
			if (!viewportCalibration.viewportConverged) {
				throw new Error(
					`CSS viewport did not converge for ${workload.id}: observed ${viewportCalibration.observedCssViewport.width}x${viewportCalibration.observedCssViewport.height}`
				);
			}
			await startDeferredBenchmark(driverUrl, sessionId, Boolean(appBinary));
			const record = await waitForResult(driverUrl, sessionId, Boolean(appBinary), {
				runToken,
				renderer,
				executionOrder: EXECUTION_ORDER,
				executionOrdinal,
				workload
			});
			const enriched = {
				...record,
				workloadId: workload.id,
				renderer,
				iteration,
				executionOrder: EXECUTION_ORDER,
				executionOrdinal,
				viewportCalibration
			};
			const visualReady = validateVisualProbe(record, workload);
			if (record.status === 'ok' && !visualReady.passed) {
				enriched.status = 'error';
				enriched.reason = visualReady.reason;
			}
			if (iteration === 1 && enriched.status === 'ok') {
				const screenshotName = `${platform || browser}-${workload.id}-${renderer}-${runToken}.png`;
				const screenshotPath = join(screenshotDir, screenshotName);
				const screenshotProbe = {
					...(await saveScreenshot(driverUrl, sessionId, screenshotPath, record.browserViewport, runToken)),
					runToken,
					viewport: record.browserViewport
				};
				screenshots.push({
					file: screenshotName,
					workloadId: workload.id,
					renderer,
					iteration,
					runToken,
					viewport: record.browserViewport,
					bytes: screenshotProbe.bytes,
					sha256: screenshotProbe.sha256,
					runMarkerVersion: screenshotProbe.runMarkerVersion
				});
				enriched.screenshot = screenshotName;
				enriched.screenshotProbe = screenshotProbe;
				if (!screenshotProbe.passed) {
					enriched.status = 'error';
					enriched.reason = screenshotProbe.reason;
				}
			}
			records.push(enriched);
			process.stdout.write(
				`${workload.id}/${renderer} #${iteration} [${executionOrdinal}/${benchmarkPlan.length}]: ${formatRecord(enriched)}\n`
			);
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${label}: blocked - ${reason}\n`);
		await writeEvidence({
			status: 'blocked',
			runs: 0,
			reason,
			label,
			identity,
			provenance,
			records,
			screenshots
		});
		process.exitCode = 1;
		return;
	} finally {
		if (sessionId) {
			await webdriverRequest(driverUrl, `/session/${sessionId}`, 'DELETE').catch(() => undefined);
		}
		await appHost?.stop();
		await benchmarkServer?.close();
		if (temporaryRoot) {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	}

	const complete = records.length === selectedWorkloads.length * selectedRenderers.length * repeat;
	const allSuccessful = complete && records.every(record => record.status === 'ok');
	await writeEvidence({
		status: allSuccessful ? 'ready' : 'blocked',
		runs: allSuccessful ? repeat : 0,
		reason: allSuccessful
			? `${label} recorded ${repeat} runs per workload/renderer.`
			: `${label} did not produce ${repeat} successful runs for every workload/renderer.`,
		label,
		identity,
		provenance,
		records,
		screenshots
	});
	if (!allSuccessful) process.exitCode = 1;
}

async function serveBenchmarkPage(pagePath) {
	const html = await readFile(pagePath);
	const server = createServer((request, response) => {
		const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
		if (request.method !== 'GET' || requestUrl.pathname !== '/benchmark.html') {
			response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
			response.end('Not found');
			return;
		}
		response.writeHead(200, {
			'cache-control': 'no-store',
			'content-type': 'text/html; charset=utf-8'
		});
		response.end(html);
	});
	await new Promise((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', rejectListen);
			resolveListen();
		});
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		server.close();
		throw new Error('Benchmark server did not bind to a TCP port.');
	}
	return {
		url: `http://127.0.0.1:${address.port}/benchmark.html`,
		close: () => new Promise(resolveClose => server.close(() => resolveClose()))
	};
}

function parseArgs(args) {
	const result = {};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (!argument.startsWith('--')) {
			throw new Error(`Unexpected argument: ${argument}`);
		}
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

function parseBoundedPositiveInteger(value, name, max) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
		throw new Error(`${name} must be an integer between 1 and ${max}`);
	}
	return parsed;
}

function selectValues(raw, available, name) {
	if (!raw || raw === 'all') return [...available];
	const values = raw.split(',').filter(Boolean);
	const identifiers = available.map(value => value.id ?? value);
	if (
		values.length === 0 ||
		new Set(values).size !== values.length ||
		values.some(value => !identifiers.includes(value))
	) {
		throw new Error(`${name} must contain unique values from: ${identifiers.join(', ')}`);
	}
	return typeof available[0] === 'string'
		? values
		: values.map(value => available.find(candidate => candidate.id === value));
}

async function createExternalSession(baseUrl, browserName) {
	const capabilities =
		browserName === 'safari'
			? { browserName: 'safari' }
			: {
					browserName: 'MicrosoftEdge',
					'ms:edgeOptions': {
						args: ['--headless=new', '--disable-gpu']
					}
				};
	const payload = await webdriverRequest(baseUrl, '/session', 'POST', { capabilities: { alwaysMatch: capabilities } });
	const value = payload.value ?? {};
	const sessionId = payload.sessionId ?? value.sessionId;
	if (!sessionId) {
		throw new Error(`WebDriver did not return a session id: ${JSON.stringify(payload)}`);
	}
	return { sessionId };
}

async function calibrateCssViewport(baseUrl, sessionId, workload, embedded) {
	return convergeWindowRectForCssViewport(
		{ width: workload.width, height: workload.height },
		async requestedWindowRect => {
			const appliedPayload = await webdriverRequest(baseUrl, `/session/${sessionId}/window/rect`, 'POST', {
				width: requestedWindowRect.width,
				height: requestedWindowRect.height
			});
			let appliedWindowRect = normalizeWindowRect(unwrapWebdriverValue(appliedPayload));
			if (!appliedWindowRect) {
				const observedPayload = await webdriverRequest(baseUrl, `/session/${sessionId}/window/rect`);
				appliedWindowRect = normalizeWindowRect(unwrapWebdriverValue(observedPayload));
			}
			if (!appliedWindowRect) throw new Error('WebDriver did not return an applied window rect.');
			const observed = await readCssViewport(baseUrl, sessionId, embedded);
			return {
				appliedWindowRect,
				observedCssViewport: { width: observed.width, height: observed.height }
			};
		},
		{ maxAttempts: 4, tolerance: 1, initialWindowRect: { width: workload.width, height: workload.height } }
	);
}

async function resetPageForViewportCalibration(baseUrl, sessionId, embedded) {
	const blankUrl = 'about:blank';
	await webdriverRequest(baseUrl, `/session/${sessionId}/url`, 'POST', { url: blankUrl });
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const state = embedded
			? await evaluateViaDirectEval(
					baseUrl,
					'({ href: location.href, readyState: document.readyState, hasBenchmarkResult: Boolean(document.querySelector("#benchmark-result")) })'
				)
			: unwrapWebdriverValue(
					await webdriverRequest(baseUrl, `/session/${sessionId}/execute/sync`, 'POST', {
						script:
							'return { href: location.href, readyState: document.readyState, hasBenchmarkResult: Boolean(document.querySelector("#benchmark-result")) };',
						args: []
					})
				);
		if (state?.href === blankUrl && state.readyState === 'complete' && state.hasBenchmarkResult === false) return;
		await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
	}
	throw new Error(`Timed out waiting for viewport calibration reset: ${blankUrl}`);
}

async function startDeferredBenchmark(baseUrl, sessionId, embedded) {
	const expression = "window.dispatchEvent(new Event('nyala-benchmark-start')); true";
	if (embedded) {
		await evaluateViaDirectEval(baseUrl, expression);
		return;
	}
	await webdriverRequest(baseUrl, `/session/${sessionId}/execute/sync`, 'POST', {
		script: `return ${expression};`,
		args: []
	});
}

function normalizeWindowRect(value) {
	if (!Number.isFinite(value?.width) || value.width <= 0 || !Number.isFinite(value?.height) || value.height <= 0) {
		return undefined;
	}
	return { width: value.width, height: value.height };
}

async function readCssViewport(baseUrl, sessionId, embedded) {
	const viewport = embedded
		? await evaluateViaDirectEval(
				baseUrl,
				'({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio })'
			)
		: unwrapWebdriverValue(
				await webdriverRequest(baseUrl, `/session/${sessionId}/execute/sync`, 'POST', {
					script:
						'return { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio };',
					args: []
				})
			);
	if (
		!Number.isFinite(viewport?.width) ||
		viewport.width <= 0 ||
		!Number.isFinite(viewport?.height) ||
		viewport.height <= 0 ||
		!Number.isFinite(viewport?.devicePixelRatio) ||
		viewport.devicePixelRatio <= 0
	) {
		throw new Error(`WebDriver returned an invalid CSS viewport: ${JSON.stringify(viewport)}`);
	}
	return viewport;
}

async function waitForNavigation(baseUrl, sessionId, expectedUrl) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const urlPayload = await webdriverRequest(baseUrl, `/session/${sessionId}/url`);
		const titlePayload = await webdriverRequest(baseUrl, `/session/${sessionId}/title`);
		if (
			unwrapWebdriverValue(urlPayload) === expectedUrl &&
			unwrapWebdriverValue(titlePayload) === 'Nyala SQL result grid benchmark'
		) {
			return;
		}
		await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
	}
	throw new Error(`Timed out waiting for benchmark navigation: ${expectedUrl}`);
}

async function setSessionTimeouts(baseUrl, sessionId, scriptMs) {
	await webdriverRequest(baseUrl, `/session/${sessionId}/timeouts`, 'POST', {
		implicit: 0,
		pageLoad: scriptMs,
		script: scriptMs
	});
}

async function waitForResult(baseUrl, sessionId, embedded, expected) {
	const deadline = Date.now() + scriptTimeoutMs;
	let lastMismatch;
	while (Date.now() < deadline) {
		const text = embedded
			? await readBenchmarkResultViaDirectEval(baseUrl)
			: unwrapWebdriverValue(
					await webdriverRequest(baseUrl, `/session/${sessionId}/execute/sync`, 'POST', {
						script: "return document.querySelector('#benchmark-result')?.textContent || '';",
						args: []
					})
				);
		if (typeof text === 'string' && text.trim()) {
			const result = JSON.parse(text);
			if (
				(result.status === 'ok' || result.status === 'error' || result.status === 'unavailable') &&
				isBenchmarkResultForRun(result, expected)
			) {
				return result;
			}
			lastMismatch = `Ignored stale or mismatched result for run ${expected.runToken}.`;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for benchmark result.${lastMismatch ? ` ${lastMismatch}` : ''}`);
}

async function readBenchmarkResultViaDirectEval(baseUrl) {
	return evaluateViaDirectEval(baseUrl, "document.querySelector('#benchmark-result')?.textContent || ''");
}

async function evaluateViaDirectEval(baseUrl, expression) {
	const done = 'arguments[arguments.length - 1]';
	const payload = await webdriverRequest(
		baseUrl,
		'/wdio/eval',
		'POST',
		{
			script: `try { ${done}({ ok: true, value: (${expression}) }); } catch (error) { ${done}({ ok: false, error: String(error) }); }`,
			window_label: 'main',
			timeout_ms: scriptTimeoutMs
		},
		{ timeoutMs: scriptTimeoutMs + 5_000 }
	);
	if (payload.error) {
		throw new Error(`Embedded WebDriver direct eval failed: ${JSON.stringify(payload).slice(0, 1_000)}`);
	}
	return payload.value;
}

async function saveScreenshot(baseUrl, sessionId, path, browserViewport, runToken) {
	const payload = await webdriverRequest(baseUrl, `/session/${sessionId}/screenshot`, 'GET');
	const image = unwrapWebdriverValue(payload);
	if (typeof image !== 'string' || image.length === 0) {
		throw new Error('WebDriver returned an empty screenshot.');
	}
	const bytes = Buffer.from(image, 'base64');
	await writeFile(path, bytes);
	const runMarker = inspectSqlResultGridRunMarker(bytes, runToken, browserViewport);
	const pixels = inspectPngPixels(bytes, { excludeRegions: runMarker.bounds ? [runMarker.bounds] : [] });
	const dimensions = validatePngViewportDimensions(pixels, browserViewport);
	const diverse = hasVisiblePngDiversity(pixels);
	const passed = dimensions.passed && diverse && runMarker.passed;
	return {
		passed,
		reason: passed
			? 'screenshot dimensions, content pixels, and run marker are verified'
			: `screenshot failed viewport, pixel diversity, or run marker checks (actual ${pixels.width}x${pixels.height}, expected ${formatDimension(dimensions.expectedWidth)}x${formatDimension(dimensions.expectedHeight)}; marker: ${runMarker.reason})`,
		bytes: bytes.byteLength,
		sha256: createHash('sha256').update(bytes).digest('hex'),
		runMarkerVersion: SQL_RESULT_GRID_RUN_MARKER_VERSION,
		...pixels
	};
}

function formatDimension(value) {
	return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : 'invalid';
}

async function writeEvidence({ status, runs, reason, label, identity, provenance, records, screenshots }) {
	const report = {
		version: 2,
		measurementContractVersion: MEASUREMENT_CONTRACT_VERSION,
		scrollCommitBoundary: SCROLL_COMMIT_BOUNDARY,
		executionOrder: EXECUTION_ORDER,
		generatedAt: new Date().toISOString(),
		label,
		status,
		runs,
		reason,
		...identity,
		provenance,
		summary: summarize(records),
		records,
		screenshots
	};
	await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
	process.stdout.write(`Wrote ${outputPath}\n`);
}

function createEvidenceProvenance(options) {
	const workflowRunAttempt = Number(options['workflow-run-attempt']);
	return Object.fromEntries(
		Object.entries({
			repository: options.repository,
			sourceRevision: options['source-revision'],
			sourceRef: options['source-ref'],
			workflowRunId: options['workflow-run-id'],
			workflowRunAttempt:
				Number.isInteger(workflowRunAttempt) && workflowRunAttempt > 0 ? workflowRunAttempt : undefined
		}).filter(([, value]) => value !== undefined && value !== '')
	);
}

async function sha256File(path) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest('hex');
}

function summarize(records) {
	const groups = new Map();
	for (const record of records) {
		if (record.status !== 'ok') continue;
		const key = `${record.workloadId}/${record.renderer}`;
		const group = groups.get(key) ?? [];
		group.push(record);
		groups.set(key, group);
	}
	return Object.fromEntries(
		[...groups.entries()].map(([key, group]) => [
			key,
			{
				count: group.length,
				renderMs: summarizeMetric(group.map(record => record.renderMs)),
				scrollP95Ms: summarizeMetric(group.map(record => record.scroll.p95Ms)),
				scrollMaxMs: summarizeMetric(group.map(record => record.scroll.maxMs)),
				domNodes: summarizeMetric(group.map(record => record.domNodes)),
				heapBytes: summarizeMetric(group.map(record => record.heapBytes).filter(value => value !== null)),
				formatMs: summarizeMetric(group.map(record => record.formatMs)),
				parseMs: summarizeMetric(group.map(record => record.parseMs)),
				fixtureBytes: group[0].fixtureBytes
			}
		])
	);
}

function validateVisualProbe(record, workload) {
	const probe = record.visualProbe;
	const passed =
		probe &&
		probe.rootWidth >= Math.min(workload.width, 300) &&
		probe.rootHeight >= Math.min(workload.height, 300) &&
		typeof probe.headerText === 'string' &&
		probe.headerText.length > 0 &&
		typeof probe.firstVisibleCellText === 'string' &&
		probe.firstVisibleCellText.length > 0 &&
		probe.firstCellInViewport === true &&
		probe.virtualRowsBounded === true &&
		Number.isInteger(probe.visibleTextLength) &&
		probe.visibleTextLength > 0;
	return {
		passed: Boolean(passed),
		reason: passed ? 'visual probe passed' : 'renderer did not expose a visible header and first cell'
	};
}

function summarizeMetric(values) {
	if (values.length === 0) return { available: false };
	const sorted = [...values].sort((a, b) => a - b);
	return {
		available: true,
		median: sorted[Math.floor(sorted.length / 2)] ?? 0,
		p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
		min: sorted[0] ?? 0,
		max: sorted.at(-1) ?? 0
	};
}

function formatRecord(record) {
	if (record.status !== 'ok') return `${record.status}${record.reason ? ` (${record.reason})` : ''}`;
	return `render=${record.renderMs.toFixed(2)}ms scroll-p95=${record.scroll.p95Ms.toFixed(2)}ms dom=${record.domNodes}`;
}
