#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	createBalancedBenchmarkPlan,
	EXECUTION_ORDER,
	HEADER_HEIGHT,
	isBenchmarkResultForRun,
	isValidVisibleRowIndex,
	MAX_VIRTUAL_ROW_OVERSCAN,
	maximumVirtualRenderedRows,
	MEASUREMENT_CONTRACT_VERSION,
	RESERVED_VIEWPORT_HEIGHT,
	ROW_HEIGHT,
	SCROLLBAR_THICKNESS_ESTIMATE,
	SCROLL_COMMIT_BOUNDARY,
	SCROLL_COMMIT_ATTEMPTS,
	SCROLL_OFFSET_TOLERANCE,
	SCROLL_ROW_TOLERANCE,
	SCROLL_TARGET_RATIOS,
	WORKBENCH_TABLE_CHARACTERIZATION_ID,
	WORKBENCH_TABLE_IMPLEMENTATION_ID,
	WORKBENCH_TABLE_RUNTIME_PROOF,
	waitForPresentationOpportunity
} from './sql-result-grid-benchmark-contract.mjs';
import { CdpClient } from './sql-result-grid-cdp-client.mjs';
import {
	createSqlResultGridFeasibilityProfile,
	SQL_RESULT_GRID_FEASIBILITY_PROFILE_VERSION,
	SQL_RESULT_GRID_PRESENTATION_FLOOR_SAMPLE_COUNT
} from './profile-sql-result-grid-feasibility.mjs';
import {
	createJankTraceCollector,
	createScrollOffsetSampler,
	createTraceScrollOffsets,
	createSqlResultGridJankProfile,
	isJankTraceRecord,
	requireJankTraceClose,
	SQL_RESULT_GRID_JANK_CORRELATION,
	SQL_RESULT_GRID_JANK_FRAME_MULTIPLIER,
	SQL_RESULT_GRID_JANK_INPUT_CADENCE_MS,
	SQL_RESULT_GRID_JANK_INPUT_SEGMENTS,
	SQL_RESULT_GRID_JANK_INPUT_SOURCE,
	SQL_RESULT_GRID_JANK_MINIMUM_FRAME_INTERVALS,
	SQL_RESULT_GRID_JANK_MINIMUM_HORIZONTAL_SPAN_PX,
	SQL_RESULT_GRID_JANK_MINIMUM_VERTICAL_SPAN_PX,
	SQL_RESULT_GRID_JANK_ONE_K_WORKLOAD_ID,
	SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID,
	SQL_RESULT_GRID_JANK_TRACE_DURATION_MS,
	SQL_RESULT_GRID_JANK_TRACE_VERSION,
	SQL_RESULT_GRID_JANK_VSYNC_CALIBRATION_FRAMES,
	SQL_RESULT_GRID_JANK_VSYNC_SOURCE,
	summarizeJankIntervals,
	validateJankTraceSnapshot,
	waitForJankTraceFlag
} from './sql-result-grid-jank-trace.mjs';
import {
	SQL_RESULT_GRID_RUN_MARKER_LAYOUT,
	SQL_RESULT_GRID_RUN_MARKER_MAGIC,
	SQL_RESULT_GRID_RUN_MARKER_VERSION
} from './sql-result-grid-run-marker.mjs';
import {
	createZeusDataGridDiagnosticCollector,
	validateZeusDataGridDiagnosticSnapshot,
	ZEUS_DATA_GRID_DIAGNOSTICS_CORRELATION,
	ZEUS_DATA_GRID_DIAGNOSTICS_VERSION
} from './sql-result-grid-zeus-diagnostics.mjs';
import {
	validateWorkbenchTableDiagnosticSnapshot,
	WORKBENCH_TABLE_DIAGNOSTICS_CORRELATION,
	WORKBENCH_TABLE_DIAGNOSTICS_INSTRUMENTATION,
	WORKBENCH_TABLE_DIAGNOSTICS_VERSION
} from './sql-result-grid-workbench-table-diagnostics.mjs';
import {
	runObserverFreeSegmentTrace,
	validateObserverFreeSegmentTraceSnapshot,
	SQL_RESULT_GRID_SEGMENT_TRACE_MAX_FRAMES,
	SQL_RESULT_GRID_SEGMENT_TRACE_VERSION,
	SQL_RESULT_GRID_SEGMENT_TRACE_CORRELATION,
	SQL_RESULT_GRID_SEGMENT_TRACE_INSTRUMENTATION
} from './sql-result-grid-segment-trace.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultOutput = join(repositoryRoot, 'docs/sql-mvp-phases/phase-z1-benchmark.json');
const browserRecordTimeoutMs = 120_000;
const chromeCandidates = [
	process.env.NYALA_CHROME,
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
	'google-chrome',
	'chromium'
].filter(Boolean);

const workloads = [
	{ id: '1k-x-20', rows: 1_000, columns: 20, width: 1440, height: 420, wide: false },
	{ id: '10k-x-50', rows: 10_000, columns: 50, width: 1440, height: 420, wide: false },
	{ id: 'wide-columns', rows: 1_000, columns: 20, width: 1440, height: 420, wide: true },
	{ id: 'narrow-panel', rows: 1_000, columns: 20, width: 390, height: 420, wide: false }
];

const cli = parseArgs(process.argv.slice(2));
if (cli.help) {
	process.stdout.write(
		`Usage: node scripts/benchmark-sql-result-grid.mjs [options]\n\nOptions:\n  -h, --help                    Show this help\n  --repeat <n>                  Runs per workload/renderer (default: 1)\n  --renderer <names>            native,workbench-table,zeus, or all\n  --workload <ids>              Comma-separated workload ids\n  --workbench-table-implementation <mode>\n                                characterization (default) or real\n  --zeus-bundle <path>          Zeus data-grid browser bundle (or NYALA_ZEUS_BUNDLE)\n  --require-zeus <true|false>   Fail unless Zeus produces ok records\n  --diagnostic-profile <bool>   Measure presentation floor and Zeus internals (default: false)\n  --jank-trace <true|false>     Diagnostic continuous-scroll jank traces (default: false)\n  --segment-trace <true|false>  Observer-free input/handler/range/commit/paint trace (default: false)\n  --zeus-measure-node-churn <bool>\n                                Diagnostic A/B: count DOM node churn after commit (default: true)\n  --emit-page <path>            Write the standalone benchmark page and exit\n  --output <path>               Output benchmark JSON\n`
	);
	process.exit(0);
}
const repeat = parsePositiveInteger(cli.repeat ?? '1', '--repeat');
const diagnosticProfile = parseBoolean(cli['diagnostic-profile'] ?? 'false', '--diagnostic-profile');
const traceProfile = parseBoolean(cli['trace-profile'] ?? 'false', '--trace-profile');
const jankTrace = parseBoolean(cli['jank-trace'] ?? 'false', '--jank-trace');
const segmentTrace = parseBoolean(cli['segment-trace'] ?? 'false', '--segment-trace');
const zeusMeasureNodeChurn = parseBoolean(cli['zeus-measure-node-churn'] ?? 'true', '--zeus-measure-node-churn');
const selectedRenderers =
	cli.renderer === 'all' || !cli.renderer ? ['native', 'workbench-table', 'zeus'] : cli.renderer.split(',');
const supportedRenderers = new Set(['native', 'workbench-table', 'zeus']);
if (selectedRenderers.some(renderer => !supportedRenderers.has(renderer))) {
	throw new Error(`renderer must be one of: ${[...supportedRenderers].join(', ')}`);
}
const workbenchTableImplementation = cli['workbench-table-implementation'] ?? 'characterization';
if (!['characterization', 'real'].includes(workbenchTableImplementation)) {
	throw new Error('--workbench-table-implementation must be characterization or real');
}
const selectedWorkloads = cli.workload
	? workloads.filter(workload => cli.workload.split(',').includes(workload.id))
	: workloads;
if (selectedWorkloads.length === 0) {
	throw new Error('workload did not match a known benchmark workload');
}
if (
	diagnosticProfile &&
	(repeat < 3 ||
		!selectedWorkloads.some(workload => workload.id === '10k-x-50') ||
		!selectedRenderers.includes('zeus') ||
		!selectedRenderers.some(renderer => renderer !== 'zeus'))
) {
	throw new Error(
		'--diagnostic-profile requires repeat >= 3, workload 10k-x-50, Zeus, and a non-Zeus baseline renderer'
	);
}
const missingJankTraceWorkloads = [
	SQL_RESULT_GRID_JANK_ONE_K_WORKLOAD_ID,
	SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID
].filter(workloadId => !selectedWorkloads.some(workload => workload.id === workloadId));
if (
	jankTrace &&
	(!diagnosticProfile ||
		workbenchTableImplementation !== 'real' ||
		!selectedRenderers.includes('workbench-table') ||
		!selectedRenderers.includes('zeus') ||
		missingJankTraceWorkloads.length > 0)
) {
	throw new Error(
		'--jank-trace requires --diagnostic-profile true, --workbench-table-implementation real, the workbench-table and zeus renderers, and the 1k-x-20 and 10k-x-50 workloads'
	);
}
const zeusBundle = cli['zeus-bundle'] ?? process.env.NYALA_ZEUS_BUNDLE;
if (selectedRenderers.includes('zeus')) {
	if (!zeusBundle) throw new Error('Zeus renderer requires --zeus-bundle <path> or NYALA_ZEUS_BUNDLE.');
	if (!(await exists(zeusBundle))) throw new Error(`Unable to load Zeus bundle at ${zeusBundle}`);
}
const outputPath = resolve(cli.output ?? defaultOutput);
const workbenchTableBundle =
	selectedRenderers.includes('workbench-table') && workbenchTableImplementation === 'real'
		? await import('./sql-result-grid-workbench-table-bundle.mjs').then(module =>
				module.buildSqlResultGridWorkbenchTableBundle()
			)
		: undefined;

if (cli['emit-page']) {
	const pagePath = resolve(cli['emit-page']);
	await writeFile(
		pagePath,
		await createBenchmarkPage({
			includeZeus: selectedRenderers.includes('zeus'),
			zeusBundle,
			workbenchTableBundle,
			workbenchTableImplementation
		}),
		'utf8'
	);
	process.stdout.write(`Wrote benchmark page ${pagePath}\n`);
	process.exit(0);
}

const chromePath = await findExecutable(chromeCandidates);

if (!chromePath) {
	throw new Error('Chrome or Edge is required. Set NYALA_CHROME to a browser executable.');
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'nyala-sql-result-grid-'));
let browserRunner;

try {
	const html = await createBenchmarkPage({
		includeZeus: selectedRenderers.includes('zeus'),
		zeusBundle,
		workbenchTableBundle,
		workbenchTableImplementation
	});
	await writeFile(join(temporaryRoot, 'benchmark.html'), html, 'utf8');
	browserRunner = await launchChromiumBenchmark(chromePath, temporaryRoot);
	const benchmarkUrl = pathToFileURL(join(temporaryRoot, 'benchmark.html')).href;

	const records = [];
	const benchmarkPlan = createBalancedBenchmarkPlan(selectedWorkloads, selectedRenderers, repeat);
	for (const { workload, renderer, iteration, executionOrdinal } of benchmarkPlan) {
		const record = await runBrowserBenchmark(
			browserRunner.client,
			benchmarkUrl,
			workload,
			renderer,
			iteration,
			executionOrdinal,
			diagnosticProfile,
			traceProfile,
			zeusMeasureNodeChurn,
			jankTrace,
			segmentTrace
		);
		records.push(record);
		process.stdout.write(
			`${record.workloadId}/${record.renderer} #${iteration} [${executionOrdinal}/${benchmarkPlan.length}]: ${formatRecord(record)}\n`
		);
	}
	const report = {
		version: 1,
		measurementContractVersion: MEASUREMENT_CONTRACT_VERSION,
		scrollCommitBoundary: SCROLL_COMMIT_BOUNDARY,
		executionOrder: EXECUTION_ORDER,
		generatedAt: new Date().toISOString(),
		provenance: {
			...createEvidenceProvenance(cli),
			...(selectedRenderers.includes('zeus') ? { zeusBundleSha256: await sha256File(zeusBundle) } : {}),
			...(workbenchTableBundle ? { workbenchTableBundleSha256: workbenchTableBundle.sha256 } : {})
		},
		browser: chromePath,
		userAgent: records.find(record => record.userAgent)?.userAgent,
		repeat,
		workloads: selectedWorkloads,
		renderers: selectedRenderers,
		workbenchTableImplementation,
		records,
		summary: summarize(records),
		...(diagnosticProfile
			? {
					diagnosticProfile: {
						version: SQL_RESULT_GRID_FEASIBILITY_PROFILE_VERSION,
						presentationFloorSampleCount: SQL_RESULT_GRID_PRESENTATION_FLOOR_SAMPLE_COUNT,
						zeusDataGridDiagnostics: {
							version: ZEUS_DATA_GRID_DIAGNOSTICS_VERSION,
							correlation: ZEUS_DATA_GRID_DIAGNOSTICS_CORRELATION,
							instrumented: true,
							measureNodeChurn: zeusMeasureNodeChurn
						},
						...(selectedRenderers.includes('workbench-table') && workbenchTableImplementation === 'real'
							? {
									workbenchTableDiagnostics: {
										version: WORKBENCH_TABLE_DIAGNOSTICS_VERSION,
										correlation: WORKBENCH_TABLE_DIAGNOSTICS_CORRELATION,
										instrumentation: WORKBENCH_TABLE_DIAGNOSTICS_INSTRUMENTATION,
										instrumented: true
									}
								}
							: {}),
						zeusAdapter: {
							explicitRefreshViewport: false,
							overscan: 4,
							rowShape: 'array-index'
						},
						...(jankTrace
							? {
									jankTrace: {
										version: SQL_RESULT_GRID_JANK_TRACE_VERSION,
										correlation: SQL_RESULT_GRID_JANK_CORRELATION,
										inputSource: SQL_RESULT_GRID_JANK_INPUT_SOURCE,
										durationMs: SQL_RESULT_GRID_JANK_TRACE_DURATION_MS,
										frameMultiplier: SQL_RESULT_GRID_JANK_FRAME_MULTIPLIER,
										vsyncCalibrationFrames: SQL_RESULT_GRID_JANK_VSYNC_CALIBRATION_FRAMES,
										vsyncSource: SQL_RESULT_GRID_JANK_VSYNC_SOURCE,
										inputCadenceMs: SQL_RESULT_GRID_JANK_INPUT_CADENCE_MS,
										minimumFrameIntervals: SQL_RESULT_GRID_JANK_MINIMUM_FRAME_INTERVALS,
										minimumVerticalSpanPx: SQL_RESULT_GRID_JANK_MINIMUM_VERTICAL_SPAN_PX,
										minimumHorizontalSpanPx: SQL_RESULT_GRID_JANK_MINIMUM_HORIZONTAL_SPAN_PX,
										navigation: 'separate-observer-free-navigation'
									}
								}
							: {})
					}
				}
			: {}),
		limitations: [
			'Browser runs use Chromium-compatible headless mode; they are not macOS WebKit or Windows WebView2 evidence.',
			workbenchTableImplementation === 'real'
				? 'The WorkbenchTable renderer instantiates the repository WorkbenchTable with isolated platform services; it is not a full Workbench boot.'
				: 'The WorkbenchTable renderer is a standalone fixed-row virtual-list characterization of the platform table contract, not a Workbench boot.',
			'Scroll latency uses one scroll-controller input and a post-presentation-opportunity visible-row completion contract for all renderers; aggregate timings are recomputable from 20 real-displacement samples.',
			'IPC and format timings measure the existing JSON-shaped result boundary and local cell formatting; no database or Tauri command is invoked.',
			'Data Grid model/commit diagnostics and WorkbenchTable ListView interval instrumentation are enabled only in diagnostic profiles and add observer overhead; they do not replace admission timings.',
			...(jankTrace
				? [
						'Continuous-scroll jank traces are diagnostic: they dispatch DevTools-protocol wheel input in Chromium and cannot rewrite v6 admission evidence, flip the Z1 gate, or serve as v7 admission evidence.'
					]
				: [])
		]
	};
	if (diagnosticProfile) {
		report.feasibilityProfile = createSqlResultGridFeasibilityProfile(report);
	}
	const jankTraceFailures = [];
	if (jankTrace) {
		report.jankTraceProfiles = {};
		for (const workloadId of [SQL_RESULT_GRID_JANK_ONE_K_WORKLOAD_ID, SQL_RESULT_GRID_JANK_TEN_K_WORKLOAD_ID]) {
			try {
				report.jankTraceProfiles[workloadId] = createSqlResultGridJankProfile(report, workloadId);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				jankTraceFailures.push({ workloadId, error: message });
				report.jankTraceProfiles[workloadId] = { workloadId, error: message };
			}
		}
	}
	await writeFile(outputPath, `${JSON.stringify(report, null, '\t')}\n`, 'utf8');
	process.stdout.write(`Wrote ${outputPath}\n`);
	if (jankTraceFailures.length > 0) {
		throw new Error(
			`Jank trace profile failed for ${jankTraceFailures
				.map(failure => `${failure.workloadId}: ${failure.error}`)
				.join('; ')} (report written to ${outputPath})`
		);
	}
	if (cli['require-zeus'] === 'true' && records.some(record => record.renderer === 'zeus' && record.status !== 'ok')) {
		throw new Error('Zeus renderer did not produce an ok benchmark record');
	}
} finally {
	await browserRunner?.close();
	await rm(temporaryRoot, { recursive: true, force: true });
}

function parseArgs(args) {
	const result = {};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === '-h') {
			result.help = 'true';
			continue;
		}
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

function parsePositiveInteger(value, name) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

function parseBoolean(value, name) {
	if (value === 'true') return true;
	if (value === 'false') return false;
	throw new Error(`${name} must be true or false`);
}

function createEvidenceProvenance(options) {
	const workflowRunAttempt = Number(options['workflow-run-attempt']);
	return Object.fromEntries(
		Object.entries({
			repository: options.repository,
			sourceRevision:
				options['source-revision'] ??
				execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
			sourceTreeClean: isSourceTreeClean(),
			sourceRef: options['source-ref'],
			workflowRunId: options['workflow-run-id'],
			workflowRunAttempt:
				Number.isInteger(workflowRunAttempt) && workflowRunAttempt > 0 ? workflowRunAttempt : undefined
		}).filter(([, value]) => value !== undefined && value !== '')
	);
}

function isSourceTreeClean() {
	try {
		return (
			execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
				cwd: repositoryRoot,
				encoding: 'utf8'
			}).trim() === ''
		);
	} catch {
		return false;
	}
}

async function sha256File(path) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest('hex');
}

async function findExecutable(candidates) {
	for (const candidate of candidates) {
		if (candidate.includes(sep)) {
			try {
				await readFile(candidate);
				return candidate;
			} catch {
				continue;
			}
		}
		try {
			execFileSync('sh', ['-c', `command -v ${quoteShell(candidate)}`], { stdio: 'ignore' });
			return candidate;
		} catch {
			continue;
		}
	}
	return undefined;
}

function quoteShell(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function launchChromiumBenchmark(chromePath, temporaryRoot) {
	const profileDirectory = join(temporaryRoot, 'chrome-profile');
	const browserProcess = spawn(
		chromePath,
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

async function runBrowserBenchmark(
	client,
	baseUrl,
	workload,
	renderer,
	iteration,
	executionOrdinal,
	diagnosticProfile,
	traceProfile,
	measureNodeChurn,
	jankTrace,
	segmentTrace
) {
	const runToken = randomUUID();
	const query = new URLSearchParams({
		run: runToken,
		renderer,
		executionOrder: EXECUTION_ORDER,
		executionOrdinal: String(executionOrdinal),
		diagnosticProfile: String(diagnosticProfile),
		traceProfile: String(traceProfile),
		segmentTrace: String(segmentTrace),
		measureNodeChurn: String(measureNodeChurn),
		rows: String(workload.rows),
		columns: String(workload.columns),
		wide: String(workload.wide),
		width: String(workload.width),
		height: String(workload.height)
	});
	const url = `${baseUrl}?${query}`;
	await client.send('Emulation.setDeviceMetricsOverride', {
		width: workload.width,
		height: workload.height,
		deviceScaleFactor: 1,
		mobile: false
	});
	const navigation = await client.send('Page.navigate', { url });
	if (navigation.errorText) {
		throw new Error(`Benchmark navigation failed for ${workload.id}/${renderer}: ${navigation.errorText}`);
	}
	const record = await waitForBenchmarkResult(client, Date.now() + browserRecordTimeoutMs, url, {
		runToken,
		renderer,
		executionOrder: EXECUTION_ORDER,
		executionOrdinal,
		workload,
		workbenchTableImplementation,
		workbenchTableBundleSha256: workbenchTableBundle?.sha256
	});
	const traced =
		jankTrace && record.status === 'ok'
			? await runJankTrace(client, baseUrl, workload, renderer, executionOrdinal)
			: undefined;
	if (traced) {
		record.diagnostics = { ...(record.diagnostics ?? {}), jankTrace: traced };
	}
	return { ...record, workloadId: workload.id, iteration };
}

/**
 * Runs one diagnostic continuous-scroll jank trace in its own observer-free
 * navigation. The trace is collected after the paired Primary B record, so it
 * never perturbs the admission-shaped record it is attached to.
 */
async function runJankTrace(client, baseUrl, workload, renderer, executionOrdinal) {
	const traceRunToken = randomUUID();
	const query = new URLSearchParams({
		run: traceRunToken,
		renderer,
		workloadId: workload.id,
		executionOrder: EXECUTION_ORDER,
		executionOrdinal: String(executionOrdinal),
		diagnosticProfile: 'false',
		jankTrace: 'true',
		rows: String(workload.rows),
		columns: String(workload.columns),
		wide: String(workload.wide),
		width: String(workload.width),
		height: String(workload.height)
	});
	const url = `${baseUrl}?${query}`;
	const label = `${workload.id}/${renderer}`;
	await client.send('Emulation.setDeviceMetricsOverride', {
		width: workload.width,
		height: workload.height,
		deviceScaleFactor: 1,
		mobile: false
	});
	const navigation = await client.send('Page.navigate', { url });
	if (navigation.errorText) {
		throw new Error(`Jank trace navigation failed for ${label}: ${navigation.errorText}`);
	}
	await waitForJankTraceReady(client, url, label);
	const begin = await client.send('Runtime.evaluate', {
		expression: `(() => {
			const channel = globalThis.__nyalaJankControl;
			if (!channel) throw new Error('Jank trace control channel is missing.');
			channel.begin = true;
			return true;
		})()`,
		returnByValue: true
	});
	if (begin.exceptionDetails) {
		throw new Error(begin.exceptionDetails.text ?? `Jank trace begin handshake failed for ${label}.`);
	}
	await waitForJankTraceRunning(client, url, label);
	const inputPlan = await dispatchJankTraceWheelInput(client, workload);
	const control = await client.send('Runtime.evaluate', {
		expression: `(() => {
			const channel = globalThis.__nyalaJankControl;
			if (!channel) throw new Error('Jank trace control channel is missing.');
			channel.inputPlan = ${JSON.stringify(inputPlan)};
			channel.stop = true;
			return channel.running === true;
		})()`,
		returnByValue: true
	});
	if (control.exceptionDetails) {
		throw new Error(control.exceptionDetails.text ?? `Jank trace control handshake failed for ${label}.`);
	}
	if (control.result?.value !== true) {
		throw new Error(`Jank trace collector was not running for ${label}.`);
	}
	const snapshot = await waitForJankTraceResult(client, Date.now() + browserRecordTimeoutMs, url, traceRunToken);
	validateJankTraceSnapshot(snapshot, { expectedWorkload: workload, expectedTraceRunToken: traceRunToken });
	return { ...snapshot, navigation: { separateNavigation: true, observerFree: true, renderer } };
}

async function waitForJankTraceReady(client, expectedUrl, label) {
	const deadline = Date.now() + 60_000;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const response = await client.send('Runtime.evaluate', {
				expression: `({ href: location.href, ready: globalThis.__nyalaJankControl?.ready === true, resultText: document.querySelector('#benchmark-result')?.textContent || '' })`,
				returnByValue: true
			});
			const page = response.result?.value;
			if (page?.href === expectedUrl) {
				if (page.ready) return;
				if (typeof page.resultText === 'string' && page.resultText.trim()) {
					throw new Error(`Jank trace page failed before wheel input for ${label}: ${page.resultText.slice(0, 400)}`);
				}
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith('Jank trace page failed')) throw error;
			lastError = error;
		}
		await delay(25);
	}
	const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
	throw new Error(`Jank trace did not become ready for ${label}.${detail}`);
}

async function waitForJankTraceRunning(client, expectedUrl, label) {
	const deadline = Date.now() + 30_000;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const response = await client.send('Runtime.evaluate', {
				expression: `({ href: location.href, running: globalThis.__nyalaJankControl?.running === true, resultText: document.querySelector('#benchmark-result')?.textContent || '' })`,
				returnByValue: true
			});
			const page = response.result?.value;
			if (page?.href === expectedUrl) {
				if (page.running) return;
				if (typeof page.resultText === 'string' && page.resultText.trim()) {
					throw new Error(`Jank trace page failed before wheel input for ${label}: ${page.resultText.slice(0, 400)}`);
				}
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith('Jank trace page failed')) throw error;
			lastError = error;
		}
		await delay(10);
	}
	const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
	throw new Error(`Jank trace collector did not start for ${label}.${detail}`);
}

async function dispatchJankTraceWheelInput(client, workload) {
	const segments = SQL_RESULT_GRID_JANK_INPUT_SEGMENTS;
	const segmentDurationMs = SQL_RESULT_GRID_JANK_TRACE_DURATION_MS / segments.length;
	const eventsPerSegment = Math.max(1, Math.round(segmentDurationMs / SQL_RESULT_GRID_JANK_INPUT_CADENCE_MS));
	const totalEvents = eventsPerSegment * segments.length;
	const cadenceMs = SQL_RESULT_GRID_JANK_TRACE_DURATION_MS / totalEvents;
	const x = Math.round(workload.width / 2);
	const y = Math.round(workload.height / 2);
	const start = Date.now();
	for (let index = 0; index < totalEvents; index += 1) {
		const segment = segments[Math.floor(index / eventsPerSegment)];
		const waitMs = start + index * cadenceMs - Date.now();
		if (waitMs > 0) await delay(waitMs);
		await client.send('Input.dispatchMouseEvent', {
			type: 'mouseWheel',
			x,
			y,
			deltaX: segment.deltaX,
			deltaY: segment.deltaY,
			button: 'none',
			clickCount: 0
		});
	}
	return {
		source: SQL_RESULT_GRID_JANK_INPUT_SOURCE,
		durationMs: SQL_RESULT_GRID_JANK_TRACE_DURATION_MS,
		cadenceMs: SQL_RESULT_GRID_JANK_INPUT_CADENCE_MS,
		segmentDurationMs,
		eventsPerSegment,
		eventCount: totalEvents,
		dispatchDurationMs: Date.now() - start,
		segments: segments.map(segment => ({ label: segment.label, deltaX: segment.deltaX, deltaY: segment.deltaY }))
	};
}

async function waitForJankTraceResult(client, deadline, expectedUrl, expectedTraceRunToken) {
	let lastError;
	while (Date.now() < deadline) {
		try {
			const response = await client.send('Runtime.evaluate', {
				expression: `({ href: location.href, readyState: document.readyState, resultText: document.querySelector('#benchmark-result')?.textContent || '' })`,
				returnByValue: true
			});
			const page = response.result?.value;
			if (page?.href === expectedUrl && page.readyState !== 'loading' && page.resultText.trim()) {
				const record = JSON.parse(page.resultText);
				if (record?.runToken === expectedTraceRunToken) {
					if (record.status !== 'ok') {
						throw new Error(
							`Jank trace navigation failed: ${String(record.error ?? record.reason ?? record.status).slice(0, 400)}`
						);
					}
					if (isJankTraceRecord(record.jankTrace)) return record.jankTrace;
					lastError = new Error('Jank trace result is missing its trace payload.');
				} else {
					lastError = new Error('Ignored stale or mismatched jank trace result.');
				}
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith('Jank trace navigation failed')) throw error;
			lastError = error;
		}
		await delay(25);
	}
	const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
	throw new Error(`Jank trace timed out for run ${expectedTraceRunToken}.${detail}`);
}

async function waitForBenchmarkResult(client, deadline, expectedUrl, expected) {
	let lastError;
	while (Date.now() < deadline) {
		try {
			const response = await client.send('Runtime.evaluate', {
				expression: `({ href: location.href, readyState: document.readyState, resultText: document.querySelector('#benchmark-result')?.textContent || '' })`,
				returnByValue: true
			});
			if (response.exceptionDetails) {
				throw new Error(response.exceptionDetails.text ?? 'Runtime.evaluate failed');
			}
			const page = response.result?.value;
			if (
				page?.href === expectedUrl &&
				page.readyState !== 'loading' &&
				typeof page.resultText === 'string' &&
				page.resultText.trim()
			) {
				const record = JSON.parse(page.resultText);
				if (isBenchmarkResultForRun(record, expected)) return record;
				lastError = new Error(`Ignored stale or mismatched benchmark result for run ${expected.runToken}.`);
			}
		} catch (error) {
			lastError = error;
		}
		await delay(25);
	}
	const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
	throw new Error(`Benchmark timed out for ${expected.workload.id}/${expected.renderer}.${detail}`);
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

async function createBenchmarkPage({ includeZeus, zeusBundle, workbenchTableBundle, workbenchTableImplementation }) {
	const zeusSource = includeZeus && (await exists(zeusBundle)) ? await readFile(zeusBundle, 'utf8') : '';
	const zeusTag = zeusSource ? `<script type="module">\n${zeusSource}\n</script>` : '';
	const workbenchTableCssTag = workbenchTableBundle
		? `<style data-nyala-workbench-table-benchmark>\n${workbenchTableBundle.css.replaceAll('</style>', '<\\/style>')}\n</style>`
		: '';
	const workbenchTableScriptTag = workbenchTableBundle
		? `<script type="module">\n${workbenchTableBundle.javascript.replaceAll('</script>', '<\\/script>')}\n</script>`
		: '';
	return `<!doctype html>
<meta charset="utf-8">
<title>Nyala SQL result grid benchmark</title>
<style>
html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #1e1e1e; color: #ddd; font: 12px sans-serif; }
#root { width: 100vw; height: 100vh; overflow: hidden; }
#benchmark-result { display: none; }
.bench-scroll { width: 100%; height: calc(100vh - 20px); overflow: auto; contain: strict; }
table { border-collapse: collapse; width: max-content; }
th, td { box-sizing: border-box; min-width: 112px; height: 28px; padding: 4px 8px; border: 1px solid #444; white-space: nowrap; }
th { position: sticky; top: 0; background: #2d2d2d; }
.virtual-scroll { position: relative; width: 100%; height: calc(100vh - 20px); overflow: auto; contain: strict; }
.virtual-spacer { position: relative; width: max-content; }
.virtual-header, .virtual-row { display: grid; grid-auto-flow: column; grid-auto-columns: 112px; width: max-content; }
.virtual-header { position: sticky; top: 0; z-index: 1; background: #2d2d2d; }
.virtual-cell { box-sizing: border-box; height: 28px; padding: 4px 8px; border: 1px solid #444; white-space: nowrap; overflow: hidden; }
.virtual-row { position: absolute; left: 0; }
.nyala-workbench-table-host { width: 100%; height: calc(100vh - 20px); overflow: hidden; }
.nyala-workbench-table-host .monaco-table-th { box-sizing: border-box; height: 28px; padding: 4px 8px; border: 1px solid #444; background: #2d2d2d; color: #ddd; }
.nyala-workbench-table-host .monaco-table-td { box-sizing: border-box; height: 28px; padding: 4px 8px; border: 1px solid #444; color: #ddd; }
zw-data-grid { display: block; width: 100%; height: calc(100vh - 20px); }
zw-data-grid [data-slot="data-grid-viewport"] { position: relative; box-sizing: border-box; width: 100%; height: 100%; overflow: auto; contain: strict; }
zw-data-grid [data-slot="data-grid-header"] { position: sticky; top: 0; z-index: 2; min-height: 28px; background: #2d2d2d; }
zw-data-grid [data-slot="data-grid-spacer"] { position: relative; }
zw-data-grid [data-slot="data-grid-body"] { position: absolute; top: 28px; left: 0; }
zw-data-grid [data-slot="data-grid-row"] { position: absolute; left: 0; height: 28px; }
	zw-data-grid [data-slot="data-grid-header-cell"], zw-data-grid [data-slot="data-grid-cell"] { box-sizing: border-box; min-width: 0; height: 28px; padding: 4px 8px; border: 1px solid #444; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	#benchmark-run-marker { position: fixed; z-index: 2147483647; pointer-events: none; image-rendering: pixelated; }
	</style>
${workbenchTableCssTag}
${workbenchTableScriptTag}
${zeusTag}
<div id="root"></div><pre id="benchmark-result"></pre>
<script>
const params = new URLSearchParams(location.search);
const runToken = params.get('run') || 'standalone';
const resultEndpoint = params.get('resultEndpoint');
	const renderer = params.get('renderer') || 'native';
	const executionOrder = params.get('executionOrder') || '';
	const executionOrdinal = Number(params.get('executionOrdinal') || 0);
	const segmentTrace = params.get('segmentTrace') === 'true';
	const diagnosticProfile = params.get('diagnosticProfile') === 'true' || segmentTrace;
	const traceProfile = params.get('traceProfile') === 'true';
	const jankTrace = params.get('jankTrace') === 'true';
	const jankTraceWorkloadId = params.get('workloadId') || '';
	const measureNodeChurn = params.get('measureNodeChurn');
const workbenchTableImplementation = ${JSON.stringify(workbenchTableImplementation)};
const WORKBENCH_TABLE_IMPLEMENTATION_ID = ${JSON.stringify(WORKBENCH_TABLE_IMPLEMENTATION_ID)};
const WORKBENCH_TABLE_RUNTIME_PROOF = ${JSON.stringify(WORKBENCH_TABLE_RUNTIME_PROOF)};
const WORKBENCH_TABLE_CHARACTERIZATION_ID = ${JSON.stringify(WORKBENCH_TABLE_CHARACTERIZATION_ID)};
const WORKBENCH_TABLE_BUNDLE_SHA256 = ${JSON.stringify(workbenchTableBundle?.sha256)};
const rowCount = Number(params.get('rows') || 1000);
const columnCount = Number(params.get('columns') || 20);
const wide = params.get('wide') === 'true';
	const viewportWidth = Number(params.get('width') || 1440);
	const viewportHeight = Number(params.get('height') || 420);
	const screenshotRunMarkerHex = params.get('screenshotRunMarker');
	const MEASUREMENT_CONTRACT_VERSION = ${MEASUREMENT_CONTRACT_VERSION};
	const SCROLL_COMMIT_BOUNDARY = ${JSON.stringify(SCROLL_COMMIT_BOUNDARY)};
	const RUN_MARKER_VERSION = ${SQL_RESULT_GRID_RUN_MARKER_VERSION};
	const RUN_MARKER_MAGIC = ${JSON.stringify(SQL_RESULT_GRID_RUN_MARKER_MAGIC)};
	const RUN_MARKER_LAYOUT = ${JSON.stringify(SQL_RESULT_GRID_RUN_MARKER_LAYOUT)};
const ROW_HEIGHT = ${ROW_HEIGHT};
const HEADER_HEIGHT = ${HEADER_HEIGHT};
const RESERVED_VIEWPORT_HEIGHT = ${RESERVED_VIEWPORT_HEIGHT};
const SCROLLBAR_THICKNESS_ESTIMATE = ${SCROLLBAR_THICKNESS_ESTIMATE};
const MAX_VIRTUAL_ROW_OVERSCAN = ${MAX_VIRTUAL_ROW_OVERSCAN};
const SCROLL_TARGET_RATIOS = ${JSON.stringify(SCROLL_TARGET_RATIOS)};
const SCROLL_SAMPLE_COUNT = SCROLL_TARGET_RATIOS.length;
const PRESENTATION_FLOOR_SAMPLE_COUNT = ${SQL_RESULT_GRID_PRESENTATION_FLOOR_SAMPLE_COUNT};
const PRESENTATION_OPPORTUNITY_TIMEOUT_MS = 15_000;
const SCROLL_ROW_TOLERANCE = ${SCROLL_ROW_TOLERANCE};
const SCROLL_OFFSET_TOLERANCE = ${SCROLL_OFFSET_TOLERANCE};
const SCROLL_COMMIT_ATTEMPTS = ${SCROLL_COMMIT_ATTEMPTS};
const SQL_RESULT_GRID_JANK_TRACE_VERSION = ${SQL_RESULT_GRID_JANK_TRACE_VERSION};
const SQL_RESULT_GRID_JANK_TRACE_DURATION_MS = ${SQL_RESULT_GRID_JANK_TRACE_DURATION_MS};
const SQL_RESULT_GRID_JANK_FRAME_MULTIPLIER = ${SQL_RESULT_GRID_JANK_FRAME_MULTIPLIER};
const SQL_RESULT_GRID_JANK_VSYNC_CALIBRATION_FRAMES = ${SQL_RESULT_GRID_JANK_VSYNC_CALIBRATION_FRAMES};
const SQL_RESULT_GRID_JANK_CORRELATION = ${JSON.stringify(SQL_RESULT_GRID_JANK_CORRELATION)};
const SQL_RESULT_GRID_JANK_VSYNC_SOURCE = ${JSON.stringify(SQL_RESULT_GRID_JANK_VSYNC_SOURCE)};
const SQL_RESULT_GRID_JANK_INPUT_SOURCE = ${JSON.stringify(SQL_RESULT_GRID_JANK_INPUT_SOURCE)};
const SQL_RESULT_GRID_JANK_INPUT_SEGMENTS = ${JSON.stringify(SQL_RESULT_GRID_JANK_INPUT_SEGMENTS)};
const SQL_RESULT_GRID_JANK_MINIMUM_FRAME_INTERVALS = ${SQL_RESULT_GRID_JANK_MINIMUM_FRAME_INTERVALS};
const SQL_RESULT_GRID_JANK_MINIMUM_VERTICAL_SPAN_PX = ${SQL_RESULT_GRID_JANK_MINIMUM_VERTICAL_SPAN_PX};
const SQL_RESULT_GRID_JANK_MINIMUM_HORIZONTAL_SPAN_PX = ${SQL_RESULT_GRID_JANK_MINIMUM_HORIZONTAL_SPAN_PX};
const SQL_RESULT_GRID_SEGMENT_TRACE_VERSION = ${SQL_RESULT_GRID_SEGMENT_TRACE_VERSION};
const SQL_RESULT_GRID_SEGMENT_TRACE_CORRELATION = ${JSON.stringify(SQL_RESULT_GRID_SEGMENT_TRACE_CORRELATION)};
const SQL_RESULT_GRID_SEGMENT_TRACE_INSTRUMENTATION = ${JSON.stringify(SQL_RESULT_GRID_SEGMENT_TRACE_INSTRUMENTATION)};
const JANK_TRACE_CONTROL_TIMEOUT_MS = 30_000;
${isValidVisibleRowIndex.toString()}
${maximumVirtualRenderedRows.toString()}
${waitForPresentationOpportunity.toString()}
${createZeusDataGridDiagnosticCollector.toString()}
${validateZeusDataGridDiagnosticSnapshot.toString()}
${validateWorkbenchTableDiagnosticSnapshot.toString()}
${summarizeJankIntervals.toString()}
${isJankTraceRecord.toString()}
${requireJankTraceClose.toString()}
${createJankTraceCollector.toString()}
${runObserverFreeSegmentTrace.toString()}
${validateObserverFreeSegmentTraceSnapshot.toString()}
${createScrollOffsetSampler.toString()}
${createTraceScrollOffsets.toString()}
${waitForJankTraceFlag.toString()}
${validateJankTraceSnapshot.toString()}
const workload = { rows: rowCount, columns: columnCount, wide, viewportWidth, viewportHeight };

function createFixture() {
  const columns = Array.from({ length: columnCount }, (_, index) => ({
    id: 'c' + index,
    name: wide ? 'column_' + index + '_' + 'wide_header_value'.repeat(3) : 'column_' + index,
    ordinal: index
  }));
  const rows = Array.from({ length: rowCount }, (_, rowIndex) =>
    columns.map((column, columnIndex) => {
      if (columnIndex === 0) return String(rowIndex);
      if (columnIndex === 1) return rowIndex % 7 === 0 ? null : 'value_' + rowIndex;
      if (columnIndex === 2) return rowIndex % 11 === 0 ? '2026-08-12T12:34:56.000Z' : rowIndex * 1.25;
      if (columnIndex === 3) return rowIndex % 5 === 0;
      return wide ? 'cell_' + rowIndex + '_' + columnIndex + '_' + 'x'.repeat(80) : 'cell_' + rowIndex + '_' + columnIndex;
    })
  );
  return { columns, rows };
}

function formatFixture(fixture) {
  const start = performance.now();
  const rows = fixture.rows.map(row => row.map(value => value === null ? 'NULL' : String(value)));
  return { rows, formatMs: performance.now() - start };
}

function measureHeap() {
  return typeof performance.memory === 'object' ? performance.memory.usedJSHeapSize : null;
}

function measureDomNodes() {
  return document.querySelectorAll('*').length;
}

function writeBenchmarkResult(result) {
	const payload = {
		runToken,
		renderer,
		measurementContractVersion: MEASUREMENT_CONTRACT_VERSION,
			scrollCommitBoundary: SCROLL_COMMIT_BOUNDARY,
			executionOrder,
			executionOrdinal,
		workload,
		browserViewport: {
			width: window.innerWidth,
			height: window.innerHeight,
			devicePixelRatio: window.devicePixelRatio
		},
		...result
	};
	const serialized = JSON.stringify(payload);
	document.getElementById('benchmark-result').textContent = serialized;
	if (resultEndpoint) {
		fetch(resultEndpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: serialized,
			keepalive: true
		}).catch(() => undefined);
	}
}

function renderScreenshotRunMarker() {
	if (!screenshotRunMarkerHex) return;
	if (!/^[a-f0-9]{40}$/.test(screenshotRunMarkerHex)) throw new Error('Screenshot run marker codeword is invalid.');
	const bytes = Uint8Array.from(screenshotRunMarkerHex.match(/../g), value => Number.parseInt(value, 16));
	if (!RUN_MARKER_MAGIC.every((byte, index) => bytes[index] === byte)) {
		throw new Error('Screenshot run marker magic or version is invalid.');
	}
	const expectedChecksum = crc16Ccitt(bytes.subarray(0, bytes.length - 2));
	const observedChecksum = (bytes.at(-2) << 8) | bytes.at(-1);
	if (expectedChecksum !== observedChecksum) throw new Error('Screenshot run marker CRC is invalid.');
	const tokenHex = Array.from(bytes.subarray(RUN_MARKER_MAGIC.length, 18), byte => byte.toString(16).padStart(2, '0')).join('');
	const markerRunToken = tokenHex.slice(0, 8) + '-' + tokenHex.slice(8, 12) + '-' + tokenHex.slice(12, 16) + '-' + tokenHex.slice(16, 20) + '-' + tokenHex.slice(20);
	if (markerRunToken !== runToken) throw new Error('Screenshot run marker does not match the benchmark run token.');
	const cssWidth = RUN_MARKER_LAYOUT.totalColumns * RUN_MARKER_LAYOUT.cellSize;
	const cssHeight = RUN_MARKER_LAYOUT.totalRows * RUN_MARKER_LAYOUT.cellSize;
	const ratio = window.devicePixelRatio || 1;
	const canvas = document.createElement('canvas');
	canvas.id = 'benchmark-run-marker';
	canvas.setAttribute('aria-hidden', 'true');
	canvas.width = Math.round(cssWidth * ratio);
	canvas.height = Math.round(cssHeight * ratio);
	canvas.style.left = RUN_MARKER_LAYOUT.left + 'px';
	canvas.style.bottom = RUN_MARKER_LAYOUT.bottom + 'px';
	canvas.style.width = cssWidth + 'px';
	canvas.style.height = cssHeight + 'px';
	const context = canvas.getContext('2d', { alpha: false });
	if (!context) throw new Error('Screenshot run marker canvas is unavailable.');
	context.imageSmoothingEnabled = false;
	for (let row = 0; row < RUN_MARKER_LAYOUT.totalRows; row += 1) {
		for (let column = 0; column < RUN_MARKER_LAYOUT.totalColumns; column += 1) {
			const frame = column === 0 || row === 0 || column === RUN_MARKER_LAYOUT.totalColumns - 1 || row === RUN_MARKER_LAYOUT.totalRows - 1;
			const bitIndex = (row - RUN_MARKER_LAYOUT.frame) * RUN_MARKER_LAYOUT.columns + column - RUN_MARKER_LAYOUT.frame;
			const bit = frame ? (column + row) % 2 : (bytes[Math.floor(bitIndex / 8)] >> (7 - (bitIndex % 8))) & 1;
			const x = Math.round(column * canvas.width / RUN_MARKER_LAYOUT.totalColumns);
			const y = Math.round(row * canvas.height / RUN_MARKER_LAYOUT.totalRows);
			const nextX = Math.round((column + 1) * canvas.width / RUN_MARKER_LAYOUT.totalColumns);
			const nextY = Math.round((row + 1) * canvas.height / RUN_MARKER_LAYOUT.totalRows);
			context.fillStyle = bit === 1 ? '#fff' : '#000';
			context.fillRect(x, y, nextX - x, nextY - y);
		}
	}
	document.body.append(canvas);
	return canvas;
}

function crc16Ccitt(bytes) {
	let checksum = 0xffff;
	for (const byte of bytes) {
		checksum ^= byte << 8;
		for (let bit = 0; bit < 8; bit += 1) {
			checksum = ((checksum << 1) ^ (checksum & 0x8000 ? 0x1021 : 0)) & 0xffff;
		}
	}
	return checksum;
}

function getScrollElement(root) {
  return root.querySelector('.bench-scroll, .virtual-scroll, [data-slot="data-grid-viewport"], .monaco-list > .monaco-scrollable-element') || root;
}

function getVisibleCell(rendered) {
	const viewportElement = rendered.viewport ?? rendered.scroll;
	const rect = viewportElement.getBoundingClientRect();
	const x = Math.min(rect.right - 1, rect.left + Math.max(1, Math.min(56, rect.width / 2)));
	const y = Math.min(rect.bottom - 1, rect.top + (rendered.probeHeaderHeight ?? HEADER_HEIGHT) + ROW_HEIGHT / 2);
	const cell = document.elementFromPoint(x, y)?.closest?.('td, .virtual-cell, .monaco-table-td, [role="gridcell"]');
	return cell && viewportElement.contains(cell) ? cell : null;
}

function getVisibleRowIndex(rendered) {
	const cell = getVisibleCell(rendered);
	const row = cell?.closest?.('[data-row-index], .monaco-list-row[data-index]');
	const index = Number(row?.getAttribute('data-row-index') ?? row?.getAttribute('data-index'));
	if (!Number.isInteger(index) || cell.textContent?.trim() !== String(index)) return -1;
	return index;
}

async function waitForVisibleCell(rendered) {
	for (let attempt = 0; attempt < SCROLL_COMMIT_ATTEMPTS; attempt += 1) {
		const cell = getVisibleCell(rendered);
		if (cell?.textContent?.trim()) return cell;
		await waitForPresentationOpportunity({ timeoutMs: PRESENTATION_OPPORTUNITY_TIMEOUT_MS });
	}
	return getVisibleCell(rendered);
}

function expectedVisibleRowIndex(actualOffset) {
	return Math.max(0, Math.min(rowCount - 1, Math.floor((actualOffset + ROW_HEIGHT / 2) / ROW_HEIGHT)));
}

async function commitScroll(rendered, targetOffset, sampleIndex) {
	const scrollController = rendered.scroll;
	const startOffset = scrollController.scrollTop;
	const startedAt = performance.now();
	scrollController.scrollTop = targetOffset;
	const inputMs = performance.now() - startedAt;
	let actualOffset = scrollController.scrollTop;
	let expectedRowIndex = expectedVisibleRowIndex(actualOffset);
	let visibleRowIndex = -1;
	let rowDelta = Number.POSITIVE_INFINITY;
	let attempts = 0;
	let presentationWaitMs = 0;
	let validationMs = 0;
	for (; attempts < SCROLL_COMMIT_ATTEMPTS; ) {
		const presentationStartedAt = diagnosticProfile || traceProfile ? performance.now() : 0;
		await waitForPresentationOpportunity({ timeoutMs: PRESENTATION_OPPORTUNITY_TIMEOUT_MS });
		if (diagnosticProfile || traceProfile) presentationWaitMs += performance.now() - presentationStartedAt;
		const validationStartedAt = diagnosticProfile || traceProfile ? performance.now() : 0;
		void scrollController.offsetHeight;
		actualOffset = scrollController.scrollTop;
		expectedRowIndex = expectedVisibleRowIndex(actualOffset);
		visibleRowIndex = getVisibleRowIndex(rendered);
		rowDelta = Math.abs(visibleRowIndex - expectedRowIndex);
		if (diagnosticProfile || traceProfile) validationMs += performance.now() - validationStartedAt;
		attempts += 1;
		if (
			isValidVisibleRowIndex(visibleRowIndex, rowCount) &&
			Math.abs(actualOffset - targetOffset) <= SCROLL_OFFSET_TOLERANCE &&
			rowDelta <= SCROLL_ROW_TOLERANCE
		) {
			break;
		}
	}
	const totalMs = performance.now() - startedAt;
	return {
		sampleIndex,
		startOffset,
		targetOffset,
		actualOffset,
		scrollViewportHeight: scrollController.clientHeight,
		expectedRowIndex,
		visibleRowIndex,
		rowDelta,
		attempts,
		presentationOpportunities: attempts,
		inputMs,
		settleMs: Math.max(0, totalMs - inputMs),
		...((diagnosticProfile || traceProfile) ? { presentationWaitMs, validationMs } : {}),
		totalMs,
		committed:
			isValidVisibleRowIndex(visibleRowIndex, rowCount) &&
			rowDelta <= SCROLL_ROW_TOLERANCE &&
			Math.abs(actualOffset - targetOffset) <= SCROLL_OFFSET_TOLERANCE
	};
}

async function commitScrollWithDiagnostics(rendered, targetOffset, sampleIndex, phase) {
	const diagnosticSampleIndex = phase === 'sample' ? sampleIndex : null;
	const zeusOperation = rendered.zeusDiagnostics?.beginOperation(phase, diagnosticSampleIndex);
	const workbenchTableOperation = rendered.diagnostics?.beginOperation(phase, diagnosticSampleIndex);
	const sample = await commitScroll(rendered, targetOffset, sampleIndex);
	if (zeusOperation || workbenchTableOperation) {
		// Let synchronously emitted commit callbacks (and their diagnostics
		// traversal) settle past the microtask boundary before closing the
		// operation window, so commits correlate to exactly this scroll.
		await Promise.resolve();
		if (zeusOperation) rendered.zeusDiagnostics.endOperation(zeusOperation);
		if (workbenchTableOperation) rendered.diagnostics.endOperation(workbenchTableOperation);
	}
	return sample;
}

function summarizeSamples(samples, field) {
	const values = samples.map(sample => sample[field]);
	const sorted = [...values].sort((left, right) => left - right);
	return {
		median: sorted[Math.floor(sorted.length / 2)] || 0,
		p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] || 0,
		max: Math.max(...values, 0)
	};
}

async function measurePresentationFloor() {
	const samples = [];
	for (let sampleIndex = 0; sampleIndex < PRESENTATION_FLOOR_SAMPLE_COUNT; sampleIndex += 1) {
		const startedAt = performance.now();
		await waitForPresentationOpportunity({ timeoutMs: PRESENTATION_OPPORTUNITY_TIMEOUT_MS });
		samples.push({ sampleIndex, totalMs: performance.now() - startedAt });
	}
	const total = summarizeSamples(samples, 'totalMs');
	return {
		sampleCount: samples.length,
		medianMs: total.median,
		p95Ms: total.p95,
		maxMs: total.max,
		samples
	};
}

async function measureScroll(rendered) {
	const samples = [];
	const maxOffset = Math.max(0, rendered.scroll.scrollHeight - rendered.scroll.clientHeight);
	if (maxOffset <= SCROLL_OFFSET_TOLERANCE * 2) {
		throw new Error('Scroll workload does not expose enough range for displacement samples.');
	}
	await waitForPresentationOpportunity({ timeoutMs: PRESENTATION_OPPORTUNITY_TIMEOUT_MS });
	void rendered.scroll.offsetHeight;
	const preposition = await commitScrollWithDiagnostics(rendered, maxOffset, -1, 'preposition');
	if (!preposition.committed) {
		throw new Error('Scroll workload could not preposition at its maximum offset.');
	}
	for (let sampleIndex = 0; sampleIndex < SCROLL_SAMPLE_COUNT; sampleIndex += 1) {
		const [numerator, denominator] = SCROLL_TARGET_RATIOS[sampleIndex];
		const targetOffset = maxOffset * numerator / denominator;
		const sample = await commitScrollWithDiagnostics(rendered, targetOffset, sampleIndex, 'sample');
		if (!sample.committed) {
			throw new Error(
				'Scroll sample ' + sampleIndex + ' did not commit: expected row ' + sample.expectedRowIndex +
				', observed ' + sample.visibleRowIndex + ', target ' + targetOffset + ', actual ' + sample.actualOffset
			);
		}
		if (Math.abs(sample.actualOffset - sample.startOffset) <= SCROLL_OFFSET_TOLERANCE) {
			throw new Error('Scroll sample ' + sampleIndex + ' did not produce a real displacement.');
		}
		samples.push(sample);
	}
	const total = summarizeSamples(samples, 'totalMs');
	const input = summarizeSamples(samples, 'inputMs');
	const settle = summarizeSamples(samples, 'settleMs');
	return {
		maximumOffset: maxOffset,
		scrollViewportHeight: rendered.scroll.clientHeight,
		medianMs: total.median,
		p95Ms: total.p95,
		maxMs: total.max,
		inputMedianMs: input.median,
		inputP95Ms: input.p95,
		settleMedianMs: settle.median,
		settleP95Ms: settle.p95,
		samples
	};
}

function renderNative(root, rows, columns) {
  const scroll = document.createElement('div');
  scroll.className = 'bench-scroll';
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const column of columns) { const cell = document.createElement('th'); cell.textContent = column.name; headerRow.append(cell); }
  head.append(headerRow); table.append(head);
  const body = document.createElement('tbody');
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) { const tr = document.createElement('tr'); tr.dataset.rowIndex = String(rowIndex); for (const value of rows[rowIndex]) { const td = document.createElement('td'); td.textContent = value === null ? 'NULL' : String(value); tr.append(td); } body.append(tr); }
  table.append(body); scroll.append(table); root.append(scroll);
  return { scroll, viewport: scroll, totalHeight: rows.length * 28 + 28 };
}

function renderWorkbenchTableCharacterization(root, rows, columns) {
  const scroll = document.createElement('div'); scroll.className = 'virtual-scroll';
  const header = document.createElement('div'); header.className = 'virtual-header';
  for (const column of columns) { const cell = document.createElement('div'); cell.className = 'virtual-cell'; cell.textContent = column.name; header.append(cell); }
  scroll.append(header);
  const spacer = document.createElement('div'); spacer.className = 'virtual-spacer'; spacer.style.height = rows.length * 28 + 'px'; spacer.style.width = columns.length * 112 + 'px';
  const viewport = document.createElement('div'); viewport.className = 'virtual-viewport'; spacer.append(viewport); scroll.append(spacer); root.append(scroll);
  const overscan = 8;
  const renderWindow = () => {
    const first = Math.max(0, Math.floor(scroll.scrollTop / 28) - overscan);
    const last = Math.min(rows.length, first + Math.ceil(scroll.clientHeight / 28) + overscan * 2);
    viewport.replaceChildren();
    for (let rowIndex = first; rowIndex < last; rowIndex += 1) {
      const rowElement = document.createElement('div'); rowElement.className = 'virtual-row'; rowElement.dataset.rowIndex = String(rowIndex); rowElement.style.top = rowIndex * 28 + 'px';
      for (const value of rows[rowIndex]) { const cell = document.createElement('div'); cell.className = 'virtual-cell'; cell.textContent = value === null ? 'NULL' : String(value); rowElement.append(cell); }
      viewport.append(rowElement);
    }
  };
  scroll.addEventListener('scroll', renderWindow, { passive: true }); renderWindow();
  return {
    scroll,
    viewport: scroll,
    totalHeight: rows.length * 28 + 28,
    implementation: {
      id: WORKBENCH_TABLE_CHARACTERIZATION_ID,
      runtimeProof: 'standalone-contract-v1',
      exactPrototype: false,
      domVerified: false
    }
  };
}

function waitForRealWorkbenchTableBundle() {
  if (typeof globalThis.__NYALA_CREATE_WORKBENCH_TABLE_BENCHMARK__ === 'function') return Promise.resolve();
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      globalThis.removeEventListener('nyala-workbench-table-benchmark-ready', onReady);
      rejectReady(new Error('Real WorkbenchTable benchmark bundle did not become ready.'));
    }, 5000);
    const onReady = () => {
      clearTimeout(timeout);
      if (typeof globalThis.__NYALA_CREATE_WORKBENCH_TABLE_BENCHMARK__ !== 'function') {
        rejectReady(new Error('Real WorkbenchTable benchmark bundle did not expose its factory.'));
        return;
      }
      resolveReady();
    };
    globalThis.addEventListener('nyala-workbench-table-benchmark-ready', onReady, { once: true });
  });
}

function renderWorkbenchTable(root, rows, columns) {
  if (workbenchTableImplementation !== 'real') return renderWorkbenchTableCharacterization(root, rows, columns);
  const factory = globalThis.__NYALA_CREATE_WORKBENCH_TABLE_BENCHMARK__;
  if (typeof factory !== 'function') throw new Error('Real WorkbenchTable benchmark factory is unavailable.');
  const rendered = factory(root, rows, columns, {
    width: viewportWidth,
    height: Math.max(1, viewportHeight - 20),
    rowHeight: ROW_HEIGHT,
    headerHeight: HEADER_HEIGHT
  }, diagnosticProfile);
  const implementation = rendered?.implementation;
  if (
    implementation?.id !== WORKBENCH_TABLE_IMPLEMENTATION_ID ||
    implementation?.runtimeProof !== WORKBENCH_TABLE_RUNTIME_PROOF ||
    implementation?.exactPrototype !== true ||
    implementation?.domVerified !== true ||
    (diagnosticProfile && implementation?.diagnosticsInstalled !== true) ||
    !/^[a-f0-9]{64}$/.test(WORKBENCH_TABLE_BUNDLE_SHA256 || '')
  ) {
    rendered?.dispose?.();
    throw new Error('Real WorkbenchTable renderer implementation proof is invalid.');
  }
  return {
    ...rendered,
	probeHeaderHeight: 0,
    implementation: {
      ...implementation,
      bundleSha256: WORKBENCH_TABLE_BUNDLE_SHA256
    }
  };
}

async function renderZeus(root, rows, columns) {
  if (!customElements.get('zw-data-grid')) return { unavailable: 'Zeus bundle was not provided.' };
  const grid = document.createElement('zw-data-grid');
	const zeusDiagnostics = diagnosticProfile ? createZeusDataGridDiagnosticCollector(
		segmentTrace || measureNodeChurn === 'false' ? { measureNodeChurn: false } : undefined
	) : undefined;
	if (zeusDiagnostics) grid.diagnostics = zeusDiagnostics.observer;
  grid.setAttribute('aria-label', 'SQL result benchmark');
  grid.virtual = true; grid.rowHeight = ROW_HEIGHT; grid.overscan = 4; grid.overscanColumns = 1; grid.keyboardNavigation = true; grid.selectionMode = 'single';
  grid.columns = columns.map(column => ({ id: column.id, header: column.name, field: String(column.ordinal), width: 112, minWidth: 80, maxWidth: 480, sortable: false, resizable: false }));
	grid.rows = rows;
	root.append(grid);
	if (grid.componentOnReady) await grid.componentOnReady();
	void root.offsetHeight;
	const scroll = getScrollElement(root);
	return { scroll, viewport: scroll, totalHeight: rows.length * 28 + 28, grid, zeusDiagnostics };
}

async function prepareBenchmarkRoot() {
  const root = document.getElementById('root');
	if (renderer === 'workbench-table' && workbenchTableImplementation === 'real') {
		await waitForRealWorkbenchTableBundle();
	}
  if (renderer === 'zeus' && !customElements.get('zw-data-grid')) {
    await Promise.race([
      customElements.whenDefined('zw-data-grid'),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
  }
  return root;
}

async function renderBenchmarkGrid(root) {
  const fixtureStart = performance.now();
  const fixture = createFixture();
  const fixtureBytes = new TextEncoder().encode(JSON.stringify(fixture)).byteLength;
  const parsedFixture = JSON.parse(JSON.stringify(fixture));
  const parseMs = performance.now() - fixtureStart;
  const formatted = formatFixture(parsedFixture);
  const beforeHeap = measureHeap();
  const renderStart = performance.now();
  const rendered = renderer === 'native'
    ? renderNative(root, formatted.rows, fixture.columns)
    : renderer === 'workbench-table'
      ? renderWorkbenchTable(root, formatted.rows, fixture.columns)
      : await renderZeus(root, formatted.rows, fixture.columns);
  const renderMs = performance.now() - renderStart;
  return { fixture, fixtureBytes, parseMs, formatted, beforeHeap, renderMs, rendered };
}

async function main() {
  const root = await prepareBenchmarkRoot();
  const { fixture, fixtureBytes, parseMs, formatted, beforeHeap, renderMs, rendered } = await renderBenchmarkGrid(root);
	  if (rendered.unavailable) {
	    writeBenchmarkResult({ status: 'unavailable', reason: rendered.unavailable });
	    return;
  }
	void root.offsetHeight;
	const scroll = await measureScroll(rendered);
	const presentationFloor = diagnosticProfile ? await measurePresentationFloor() : undefined;
	const reset = await commitScrollWithDiagnostics(rendered, 0, -1, 'reset');
	if (!reset.committed) throw new Error('Renderer did not reset to its first visible row.');
	await waitForPresentationOpportunity({ timeoutMs: PRESENTATION_OPPORTUNITY_TIMEOUT_MS });
	void root.offsetHeight;
  const afterHeap = measureHeap();
	const firstCell = getVisibleCell(rendered);
	const visibleFirstCell = firstCell?.textContent?.trim() ? firstCell : await waitForVisibleCell(rendered);
	const firstCellRect = visibleFirstCell?.getBoundingClientRect();
	const rootRect = root.getBoundingClientRect();
	const renderedRows = renderer === 'native' ? rowCount : root.querySelectorAll('[data-row-index], .virtual-row, tbody tr').length;
	const domNodes = measureDomNodes();
	let runMarker;
	if (screenshotRunMarkerHex) {
		runMarker = renderScreenshotRunMarker();
		await waitForPresentationOpportunity({ timeoutMs: PRESENTATION_OPPORTUNITY_TIMEOUT_MS });
		await waitForPresentationOpportunity({ timeoutMs: PRESENTATION_OPPORTUNITY_TIMEOUT_MS });
	}
	const documentElement = document.documentElement;
	const zeusDataGrid = rendered.zeusDiagnostics?.snapshot();
	if (zeusDataGrid) {
		validateZeusDataGridDiagnosticSnapshot(zeusDataGrid, {
			expectedSampleCount: SCROLL_SAMPLE_COUNT,
			workload,
			scrollSamples: scroll.samples
		});
	}
	const workbenchTableDiagnostics = rendered.diagnostics?.snapshot();
	if (workbenchTableDiagnostics) {
		validateWorkbenchTableDiagnosticSnapshot(workbenchTableDiagnostics, {
			expectedSampleCount: SCROLL_SAMPLE_COUNT,
			workload,
			scrollSamples: scroll.samples
		});
	}
	const documentViewport = {
		clientWidth: documentElement.clientWidth,
		clientHeight: documentElement.clientHeight,
		scrollWidth: documentElement.scrollWidth,
		scrollHeight: documentElement.scrollHeight
	};
	const runMarkerRect = runMarker?.getBoundingClientRect();
	const runMarkerBounds = runMarkerRect ? {
		left: runMarkerRect.left,
		top: runMarkerRect.top,
		right: runMarkerRect.right,
		bottom: runMarkerRect.bottom,
		width: runMarkerRect.width,
		height: runMarkerRect.height
	} : undefined;
	  const result = {
	    status: 'ok',
	    userAgent: navigator.userAgent, formatMs: formatted.formatMs, parseMs, renderMs,
	    scroll, domNodes, fixtureBytes,
		rendererImplementation: rendered.implementation,
		diagnostics: diagnosticProfile || traceProfile ? {
			...(diagnosticProfile ? { presentationFloor } : {}),
			measureNodeChurn: segmentTrace || (diagnosticProfile && measureNodeChurn !== 'false'),
			traceProfile,
			...(zeusDataGrid ? { zeusDataGrid } : {}),
			...(workbenchTableDiagnostics ? { workbenchTable: workbenchTableDiagnostics } : {})
		} : undefined,
    heapBytes: beforeHeap !== null && afterHeap !== null && afterHeap > beforeHeap ? afterHeap - beforeHeap : null,
	    renderedRows,
	    visualProbe: {
      rootWidth: root.getBoundingClientRect().width,
      rootHeight: root.getBoundingClientRect().height,
	      headerText: root.querySelector('th, .virtual-header .virtual-cell, .monaco-table-th, [role="columnheader"]')?.textContent || '',
		firstVisibleCellText: visibleFirstCell?.textContent || '',
		firstCellInViewport: Boolean(firstCellRect && firstCellRect.bottom > rootRect.top && firstCellRect.top < rootRect.bottom),
		virtualRowsBounded:
			renderer === 'native' || (renderedRows > 0 && renderedRows <= maximumVirtualRenderedRows(workload)),
		documentViewport,
		outerDocumentOverflowFree:
			documentViewport.scrollWidth === documentViewport.clientWidth &&
			documentViewport.scrollHeight === documentViewport.clientHeight,
		runMarkerBounds,
		runMarkerAnchored: !screenshotRunMarkerHex || Boolean(
			runMarkerBounds &&
			Math.abs(runMarkerBounds.left - RUN_MARKER_LAYOUT.left) <= 0.5 &&
			Math.abs(documentViewport.clientHeight - runMarkerBounds.bottom - RUN_MARKER_LAYOUT.bottom) <= 0.5
		),
	      visibleTextLength: (root.innerText || root.textContent || '').trim().length
	    }
	  };
		  writeBenchmarkResult(result);
	}
	async function runSegmentTrace() {
		const root = await prepareBenchmarkRoot();
		const { rendered } = await renderBenchmarkGrid(root);
		if (rendered.unavailable) throw new Error('Segment trace renderer is unavailable: ' + rendered.unavailable);
		void root.offsetHeight;
		await waitForPresentationOpportunity({ timeoutMs: PRESENTATION_OPPORTUNITY_TIMEOUT_MS });
		const trace = await runObserverFreeSegmentTrace(rendered, {
			maxFrames: ${SQL_RESULT_GRID_SEGMENT_TRACE_MAX_FRAMES},
			targetRatios: SCROLL_TARGET_RATIOS,
			scrollCommitAttempts: SCROLL_COMMIT_ATTEMPTS,
			rowHeight: ROW_HEIGHT,
			rowCount,
			rowTolerance: SCROLL_ROW_TOLERANCE,
			getVisibleRowIndex,
			expectedVisibleRowIndex
		});
		validateObserverFreeSegmentTraceSnapshot(trace, { expectedSampleCount: SCROLL_SAMPLE_COUNT + 2 });
		writeBenchmarkResult({
			status: 'ok',
			segmentTrace: trace,
			rendererImplementation: rendered.implementation,
			domNodes: measureDomNodes()
		});
	}
	async function runJankTrace() {
		const root = await prepareBenchmarkRoot();
		const { rendered } = await renderBenchmarkGrid(root);
		if (rendered.unavailable) {
			throw new Error('Jank trace renderer is unavailable: ' + rendered.unavailable);
		}
		void root.offsetHeight;
		await waitForPresentationOpportunity({ timeoutMs: PRESENTATION_OPPORTUNITY_TIMEOUT_MS });
		const collector = createJankTraceCollector({ frameMultiplier: SQL_RESULT_GRID_JANK_FRAME_MULTIPLIER });
		const calibration = await collector.calibrate(SQL_RESULT_GRID_JANK_VSYNC_CALIBRATION_FRAMES);
		const control = globalThis.__nyalaJankControl;
		if (!control) throw new Error('Jank trace control channel is missing.');
		control.vsyncMs = calibration.medianMs;
		control.ready = true;
		await waitForJankTraceFlag(control, 'begin', JANK_TRACE_CONTROL_TIMEOUT_MS);
		const sampler = createScrollOffsetSampler(createTraceScrollOffsets(rendered));
		const session = collector.begin();
		control.running = true;
		await waitForJankTraceFlag(control, 'stop', JANK_TRACE_CONTROL_TIMEOUT_MS);
		sampler.stop();
		const trace = {
			...collector.end(session, calibration),
			traceRunToken: runToken,
			workloadId: jankTraceWorkloadId,
			workload: { rows: rowCount, columns: columnCount },
			inputPlan: control.inputPlan,
			scrollOffsets: sampler.snapshot()
		};
		validateJankTraceSnapshot(trace, {
			expectedWorkload: { id: jankTraceWorkloadId, rows: rowCount, columns: columnCount },
			expectedTraceRunToken: runToken
		});
		writeBenchmarkResult({ status: 'ok', jankTrace: trace, domNodes: measureDomNodes() });
	}
	function formatBenchmarkError(error) {
		const message = String(error && error.message || error);
		const stack = String(error && error.stack || '');
		return stack && !stack.includes(message) ? message + String.fromCharCode(10) + stack : stack || message;
	}
	if (jankTrace) {
		globalThis.__nyalaJankControl = {
			ready: false,
			begin: false,
			stop: false,
			running: false,
			inputPlan: null,
			vsyncMs: null
		};
	}
	const startBenchmark = () => (segmentTrace ? runSegmentTrace() : jankTrace ? runJankTrace() : main()).catch(error => {
		writeBenchmarkResult({ status: 'error', error: formatBenchmarkError(error) });
	});
	if (params.get('deferStart') === 'true') {
		globalThis.addEventListener('nyala-benchmark-start', startBenchmark, { once: true });
	} else {
		startBenchmark();
	}
</script>`;
}

async function exists(filePath) {
	try {
		await readFile(filePath);
		return true;
	} catch {
		return false;
	}
}

function formatRecord(record) {
	if (record.status !== 'ok') {
		const detail = record.reason ?? record.error?.split(/\r?\n/, 1)[0];
		return `${record.status}${detail ? ` (${detail})` : ''}`;
	}
	if (record.segmentTrace) {
		const segments = record.segmentTrace.segments ?? [];
		const commits = segments.reduce((count, segment) => count + (segment.commitTransactionIds?.length ?? 0), 0);
		return `segment-trace=${segments.length} segments commits=${commits}`;
	}
	const trace = record.diagnostics?.jankTrace;
	const jankDetail = trace ? ` jank=${(trace.jankRate * 100).toFixed(1)}%` : '';
	return `render=${record.renderMs.toFixed(2)}ms scroll-p95=${record.scroll.p95Ms.toFixed(2)}ms dom=${record.domNodes} heap=${record.heapBytes ?? 'n/a'}${jankDetail}`;
}

function summarize(records) {
	const groups = new Map();
	for (const record of records) {
		if (record.status !== 'ok' || !record.scroll || typeof record.renderMs !== 'number') continue;
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

function summarizeMetric(values) {
	if (values.length === 0) {
		return { available: false };
	}
	const sorted = [...values].sort((a, b) => a - b);
	return {
		available: true,
		median: sorted[Math.floor(sorted.length / 2)] ?? 0,
		p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
		min: sorted[0] ?? 0,
		max: sorted.at(-1) ?? 0
	};
}
