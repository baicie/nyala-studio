#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync as exists } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	applyWindowRectAndObserveCssViewport,
	convergeWindowRectForCssViewport,
	createEmbeddedWebdriverSession,
	evaluateViaDirectEval,
	identifyEmbeddedWebview,
	launchTauriEmbeddedWebdriver,
	unwrapWebdriverValue,
	webdriverRequest
} from './tauri-embedded-webdriver.mjs';
import {
	createBalancedBenchmarkPlan,
	EXECUTION_ORDER,
	isBenchmarkResultForRun,
	isValidWorkbenchTableRendererImplementation,
	maximumVirtualRenderedRows,
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
import { createSqlResultGridResultChannel } from './sql-result-grid-result-channel.mjs';
import { validateObserverFreeSegmentTraceSnapshot } from './sql-result-grid-segment-trace.mjs';
import {
	createInterleavedVariantBenchmarkPlan,
	INTERLEAVED_EXECUTION_ORDER
} from './sql-result-grid-interleaved-plan.mjs';

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
  --run-budget-ms <n> Whole-platform-run budget (default: 1800000)
  --navigation-timeout-ms <n>  Per-navigation WebDriver deadline (default: 30000)
  --text-churn <true|false>    Count text mutations in trace navigation only (diagnostic, default false)
  --trace-profile <true|false>  Record observer-free scroll timing segments
  --instrument-baseline <true|false>  Instrument the baseline renderer so commit
    work is recorded. Disables floorOnly, which means the presentation floor and
    the renderer commit cost are measured in the same run and the recorded
    scrollP95Ms carries observer overhead. Diagnostic evidence only: such a run
    must not be used for v7 admission.
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
// Result polling must stay responsive: a hung WebView must surface as a
// timeout against the run deadline instead of blocking one full script budget
// per poll iteration.
const RESULT_POLL_EVAL_TIMEOUT_MS = 10_000;
// How long a posted result may still be in flight before the runner is allowed
// to fall back to reading it out of the WebView.
const RESULT_CHANNEL_GRACE_MS = 15_000;
const OBSERVE_EVAL_TIMEOUT_MS = 15_000;
const runBudgetMs = parseBoundedPositiveInteger(cli['run-budget-ms'] ?? '1800000', '--run-budget-ms', 5_400_000);
// A navigation that cannot complete inside this budget has lost the host WebView,
// not merely been slow. Keeping it explicit lets a degraded platform fail fast
// and lets session recycling start well before the round budget is gone.
const navigationTimeoutMs = parseBoundedPositiveInteger(
	cli['navigation-timeout-ms'] ?? '30000',
	'--navigation-timeout-ms',
	300_000
);
// A round can fail for reasons that are not renderer behaviour: the host can
// miss a presentation opportunity inside the fixed per-sample budget, or a
// degraded WebView can drop a navigation. Those failures are real but they are
// not measurements of the renderer, and the v7 contract still requires five
// successful records per workload/renderer. Re-running the same scheduled slot
// keeps the balanced execution plan intact while giving an intermittent host
// hiccup a second chance. Only a round that succeeds replaces its failed
// predecessor; every attempt stays in `retriedRounds` so the evidence file
// shows exactly how much retrying a platform needed.
const maxRoundAttempts = parseBoundedPositiveInteger(cli['max-round-attempts'] ?? '3', '--max-round-attempts', 10);
const traceProfile = String(cli['trace-profile'] ?? 'false') === 'true';
const textChurn = String(cli['text-churn'] ?? 'false') === 'true';
if (textChurn && !traceProfile) throw new Error('--text-churn requires --trace-profile true (diagnostic only).');
// The baseline renderer is only instrumented when the caller asks for commit
// work. floorOnly exists so the presentation floor is sampled without observer
// overhead inside scrollP95Ms; that same guarantee is why an instrumented run
// cannot produce admission-grade scrollP95Ms.
const instrumentBaseline = String(cli['instrument-baseline'] ?? 'false') === 'true';
const outputPath = resolve(cli.output ?? defaultOutput);
const screenshotDir = resolve(cli['screenshot-dir'] ?? join(repositoryRoot, 'platform-screenshots'));
const zeusBundle = cli['zeus-bundle'] ?? '/tmp/nyala-zeus-audit/data-grid-bundle.js';
// --zeus-css <path> loads the real zeus-ui stylesheet into the benchmark page.
// The published data-grid bundle ships no CSS, so without this the page's inline
// block is the only styling under test and any CSS candidate stays unmeasurable.
// Omitting it keeps the historical inline-CSS page byte-for-byte reproducible.
const zeusCss = cli['zeus-css'] ?? process.env.NYALA_ZEUS_CSS ?? null;
// 交错采集模式：--zeus-variant <id>=<path>[,<id>=<path>] 让同一次 WebView 会话在同一段
// 宿主状态下交替测量多个 Zeus bundle 变体。这是对抗 GitHub-hosted runner 之间数十
// 个百分点宿主漂移的唯一可靠手段，因为漂移会同时作用于两个变体。
const zeusVariants = parseZeusVariants(cli['zeus-variant']);
const interleaved = zeusVariants.length > 0;
const effectiveExecutionOrder = interleaved ? INTERLEAVED_EXECUTION_ORDER : EXECUTION_ORDER;
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
if (zeusCss && !(await exists(resolve(zeusCss)))) {
	throw new Error(`Unable to load Zeus product CSS at ${zeusCss}`);
}

await run();

async function run() {
	const records = [];
	const screenshots = [];
	// Keep failures for slots that retried, including those whose next attempt
	// was prevented by the run budget. Readers must see the actual attempt count
	// even when the slot never produced a usable record.
	const retriedRounds = [];
	let sessionId;
	// Session recycling replaces the id, so every navigation must read it live
	// rather than close over one value for the whole run.
	const liveSession = {
		get sessionId() {
			return sessionId;
		},
		set sessionId(value) {
			sessionId = value;
		}
	};
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
			// Record which stylesheet the page actually carried. A reader must be able
			// to tell inline-CSS evidence from product-CSS evidence without trusting
			// the run that produced it.
			provenance = {
				...provenance,
				zeusCss: zeusCss
					? {
							mode: 'product',
							path: resolve(zeusCss),
							sha256: await sha256File(zeusCss)
						}
					: { mode: 'inline' }
			};
		}
		if (interleaved) {
			provenance = {
				...provenance,
				interleavedVariants: await Promise.all(
					zeusVariants.map(async variant => ({
						id: variant.id,
						bundlePath: variant.bundlePath,
						bundleSha256: await sha256File(variant.bundlePath)
					}))
				)
			};
		}
		temporaryRoot = await mkdtemp(join(process.env.RUNNER_TEMP ?? '/tmp', 'nyala-sql-webdriver-'));
		// 每个变体需要一份独立页面：benchmark 页面把 bundle 内联进 HTML，所以同一
		// WebView 会话里切换变体只能靠切换文档。
		const pages = new Map();
		const emitPage = async (name, bundle) => {
			const pagePath = join(temporaryRoot, `${name}.html`);
			const emitArgs = [
				join(repositoryRoot, 'scripts/benchmark-sql-result-grid.mjs'),
				'--emit-page',
				pagePath,
				'--renderer',
				selectedRenderers.join(','),
				'--workbench-table-implementation',
				'real',
				'--zeus-bundle',
				bundle
			];
			if (zeusCss) emitArgs.push('--zeus-css', zeusCss);
			if (selectedRenderers.includes('zeus')) emitArgs.push('--require-zeus', 'true');
			execFileSync(process.execPath, emitArgs, { stdio: 'inherit' });
			pages.set(name, pagePath);
		};
		if (interleaved) {
			for (const variant of zeusVariants) {
				await emitPage(sanitizePageName(variant.id), variant.bundlePath);
			}
		} else {
			await emitPage('benchmark', zeusBundle);
		}
		benchmarkServer = await serveBenchmarkPages(pages);

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
			? await createEmbeddedWebdriverSession(driverUrl, { timeoutMs: startupTimeoutMs })
			: await createExternalSession(driverUrl, browser);
		liveSession.sessionId = session.sessionId;
		await setSessionTimeouts(driverUrl, liveSession.sessionId, scriptTimeoutMs);
		if (appBinary) identity = identifyEmbeddedWebview(session.capabilities, platform);
		const benchmarkPlan = interleaved
			? createInterleavedVariantBenchmarkPlan(zeusVariants, selectedWorkloads, selectedRenderers, repeat)
			: createBalancedBenchmarkPlan(selectedWorkloads, selectedRenderers, repeat);
		const benchmarkStartedAt = Date.now();
		for (const { workload, renderer, iteration, executionOrdinal, variant } of benchmarkPlan) {
			// Each round carries its own navigation, viewport calibration, segment
			// trace, and result budgets. Without a whole-run budget a degraded
			// WebView can stretch a platform job far past the point where the
			// remaining rounds can still produce usable evidence.
			if (Date.now() - benchmarkStartedAt > runBudgetMs) {
				throw new Error(
					`Platform run exceeded its ${Math.round(runBudgetMs / 1000)}s budget after ${records.length}/${benchmarkPlan.length} benchmark rounds.`
				);
			}
			// Re-run the same scheduled slot until it produces a usable record.
			// The execution ordinal, renderer rotation and sample budgets stay
			// exactly as planned; only the attempt behind that slot changes.
			let attempt = 0;
			let enriched;
			let timings;
			let attemptScreenshots = [];
			const discardedScreenshotFiles = [];
			const attemptFailures = [];
			for (;;) {
				attempt += 1;
				// A retry is another full navigation plus the whole scroll sample
				// budget, so it has to be charged against the platform run budget
				// exactly like a first attempt. Without this a degraded WebView could
				// spend hours on retries long after the run should have stopped.
				if (Date.now() - benchmarkStartedAt > runBudgetMs) {
					if (attemptFailures.length > 0) recordRoundRetryHistory(attempt - 1);
					throw new Error(
						`Platform run exceeded its ${Math.round(runBudgetMs / 1000)}s budget while retrying ${workload.id}/${renderer} #${iteration} (attempt ${attempt}).`
					);
				}
				try {
					const outcome = await runBenchmarkRound({ workload, renderer, iteration, executionOrdinal, variant });
					enriched = outcome.record;
					timings = outcome.timings;
					attemptScreenshots = outcome.screenshots;
				} catch (error) {
					discardedScreenshotFiles.push(...attemptScreenshots.map(entry => entry.file));
					attemptScreenshots = [];
					attemptFailures.push(error instanceof Error ? error.message : String(error));
					if (attempt >= maxRoundAttempts) {
						if (attempt > 1) recordRoundRetryHistory(attempt);
						throw error;
					}
					// One navigation failure can be a slow page, but two in a row on
					// the same session mean the WebView stopped servicing requests,
					// which re-navigating cannot fix. Start a fresh WebView before the
					// remaining attempts are spent on a dead one.
					if (
						isNavigationFailure(error) &&
						attempt >= 2 &&
						!(await recycleSessionAfterNavigationFailures(liveSession))
					) {
						if (attempt > 1) recordRoundRetryHistory(attempt);
						throw error;
					}
					process.stderr.write(
						`${label}: retrying ${workload.id}/${renderer} #${iteration} (attempt ${attempt + 1}/${maxRoundAttempts}) after ${error instanceof Error ? error.message : String(error)}\n`
					);
					continue;
				}
				// A record that reports its own error (for example a sample that
				// never reached a presentation opportunity) is the same kind of
				// host failure as a thrown navigation error, so it also earns a
				// fresh attempt instead of poisoning the whole platform run.
				if (enriched.status !== 'ok' && attempt < maxRoundAttempts) {
					discardedScreenshotFiles.push(...attemptScreenshots.map(entry => entry.file));
					attemptScreenshots = [];
					attemptFailures.push(`${enriched.status}: ${enriched.reason ?? 'unknown reason'}`);
					process.stderr.write(
						`${label}: retrying ${workload.id}/${renderer} #${iteration} (attempt ${attempt + 1}/${maxRoundAttempts}) after ${enriched.status}: ${enriched.reason ?? 'unknown reason'}\n`
					);
					continue;
				}
				// The slot exhausted its attempts. Keep the failing record so the
				// platform stays fail-closed with 5 records per workload/renderer,
				// and record why the last attempt did not pass.
				if (enriched.status !== 'ok') {
					attemptFailures.push(`${enriched.status}: ${enriched.reason ?? 'unknown reason'}`);
				}
				break;
			}
			if (attempt > 1) {
				recordRoundRetryHistory(attempt);
				enriched = { ...enriched, roundAttempts: attempt };
			}
			// Only the attempt that produced the retained record may contribute
			// screenshots, and a retried slot's stale PNGs must not reach the
			// artifact directory the gate reads.
			if (enriched.status !== 'ok') {
				discardedScreenshotFiles.push(...attemptScreenshots.map(entry => entry.file));
				attemptScreenshots = [];
				// The manifest entry is gone, so the record must not keep pointing at
				// a screenshot the gate can no longer resolve.
				delete enriched.screenshot;
				delete enriched.screenshotProbe;
			}
			if (attempt > 1 || enriched.status !== 'ok') await removeStaleAttemptScreenshots();
			screenshots.push(...attemptScreenshots);
			records.push(enriched);
			process.stdout.write(
				`${workload.id}/${renderer} #${iteration} [${executionOrdinal}/${benchmarkPlan.length}] navigate=${timings.navigateMs}ms calibrate=${timings.calibrateMs}ms total=${timings.roundMs}ms stage=${timings.stage}: ${formatRecord(enriched)}\n`
			);

			function recordRoundRetryHistory(attempts) {
				retriedRounds.push({
					workloadId: workload.id,
					renderer,
					iteration,
					executionOrdinal,
					attempts,
					discarded: attemptFailures
				});
			}

			async function removeStaleAttemptScreenshots() {
				for (const file of discardedScreenshotFiles) {
					// Best effort: a leftover PNG from a discarded attempt would be
					// uploaded as an untracked artifact, but failing to remove it must
					// not discard an otherwise valid measurement.
					await rm(join(screenshotDir, file), { force: true }).catch(() => undefined);
				}
			}
		}

		// The scheduled slot is passed in explicitly rather than captured from the
		// loop: a nested function declaration would not see the loop bindings, and
		// a silently undefined renderer would look like a flaky host instead of a
		// bug in this runner.
		async function runBenchmarkRound({ workload, renderer, iteration, executionOrdinal, variant }) {
			const runToken = randomUUID();
			const attemptScreenshots = [];
			await resetPageForViewportCalibration(driverUrl, sessionId, Boolean(appBinary));
			const query = {
				run: runToken,
				renderer,
				executionOrder: effectiveExecutionOrder,
				executionOrdinal: String(executionOrdinal),
				rows: String(workload.rows),
				columns: String(workload.columns),
				wide: String(workload.wide),
				width: String(workload.width),
				height: String(workload.height),
				deferStart: 'true',
				// v7 admission decisions are floor-aware, so every platform record
				// must carry the empty-loop presentation floor for its platform and
				// workload. floorOnly samples that floor without installing any
				// renderer observer, because observer overhead would land inside
				// scrollP95Ms and bias the comparison the floor exists to inform.
				// An instrumented-baseline run trades that guarantee for baseline
				// commit work, so it is diagnostic evidence and never admission-grade.
				diagnosticProfile: 'true',
				floorOnly: String(!instrumentBaseline)
			};
			// 交错模式下，页面按变体选择；同一会话内换变体必须换文档。
			const pageName = interleaved
				? sanitizePageName(renderer === 'zeus' ? variant.id : zeusVariants[0].id)
				: 'benchmark';
			if (interleaved && renderer === 'zeus') query.zeusVariant = variant.id;
			query.resultEndpoint = benchmarkServer.resultUrl;
			if (traceProfile) query.traceProfile = 'true';
			if (iteration === 1) {
				query.screenshotRunMarker = Buffer.from(createSqlResultGridRunMarkerBytes(runToken)).toString('hex');
			}
			const url = `${benchmarkServer.pageUrl(pageName)}?${new URLSearchParams(query)}`;
			const stageStartedAt = Date.now();
			let stage = 'navigate';
			await webdriverRequest(
				driverUrl,
				`/session/${sessionId}/url`,
				'POST',
				{ url },
				{ timeoutMs: navigationTimeoutMs }
			);
			await waitForNavigation(driverUrl, sessionId, url);
			const afterNavigateMs = Date.now() - stageStartedAt;
			stage = 'calibrate';
			const viewportCalibration = await calibrateCssViewport(driverUrl, sessionId, workload, Boolean(appBinary));
			const afterCalibrateMs = Date.now() - stageStartedAt;
			if (!viewportCalibration.viewportConverged) {
				throw new Error(
					`CSS viewport did not converge for ${workload.id}: observed ${viewportCalibration.observedCssViewport.width}x${viewportCalibration.observedCssViewport.height}`
				);
			}
			await startDeferredBenchmark(driverUrl, sessionId, Boolean(appBinary));
			stage = 'await-result';
			const record = await waitForResult(
				driverUrl,
				sessionId,
				Boolean(appBinary),
				{
					runToken,
					renderer,
					executionOrder: effectiveExecutionOrder,
					executionOrdinal,
					zeusVariant: variant ? variant.id : null,
					workload,
					workbenchTableImplementation: 'real',
					workbenchTableBundleSha256: provenance.workbenchTableBundleSha256
				},
				benchmarkServer
			);
			if (renderer === 'workbench-table') {
				const bundleSha256 = record.rendererImplementation?.bundleSha256;
				if (
					!isValidWorkbenchTableRendererImplementation(record.rendererImplementation, bundleSha256) ||
					(provenance.workbenchTableBundleSha256 !== undefined &&
						provenance.workbenchTableBundleSha256 !== bundleSha256)
				) {
					throw new Error('WorkbenchTable bundle identity changed within the platform run.');
				}
				provenance = { ...provenance, workbenchTableBundleSha256: bundleSha256 };
			}
			const enriched = {
				...record,
				workloadId: workload.id,
				renderer,
				iteration,
				executionOrder: effectiveExecutionOrder,
				executionOrdinal,
				viewportCalibration
			};
			const visualReady = validateVisualProbe(record, workload);
			if (record.status === 'ok' && !visualReady.passed) {
				enriched.status = 'error';
				enriched.reason = visualReady.reason;
			}
			if (iteration === 1 && enriched.status === 'ok') {
				stage = 'screenshot';
				const screenshotName = `${platform || browser}-${workload.id}-${renderer}-${runToken}.png`;
				const screenshotPath = join(screenshotDir, screenshotName);
				const screenshotProbe = {
					...(await saveScreenshot(driverUrl, sessionId, screenshotPath, record.browserViewport, runToken)),
					runToken,
					viewport: record.browserViewport
				};
				// The manifest entry belongs to this attempt only. A failed attempt
				// must not leave a screenshot behind, because the manifest has to
				// describe exactly the run tokens that ended up in the final records.
				attemptScreenshots.push({
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
			if (traceProfile && enriched.status === 'ok') {
				try {
					stage = 'segment-trace';
					const traced = await runObserverFreeSegmentTraceNavigation(
						driverUrl,
						sessionId,
						Boolean(appBinary),
						interleaved ? benchmarkServer.pageUrl(pageName) : benchmarkServer.url,
						benchmarkServer,
						{
							renderer,
							executionOrder: effectiveExecutionOrder,
							executionOrdinal,
							zeusVariant: variant ? variant.id : null,
							workload,
							textChurn,
							workbenchTableBundleSha256: provenance.workbenchTableBundleSha256
						}
					);
					enriched.segmentTrace = traced.segmentTrace;
					if (traced.textChurn) enriched.textChurn = traced.textChurn;
				} catch (error) {
					// Segment traces are diagnostic evidence. A broken trace channel must
					// not discard the completed v7 performance record for this workload.
					enriched.segmentTraceError = error instanceof Error ? error.message : String(error);
				}
			}
			return {
				record: enriched,
				timings: {
					navigateMs: afterNavigateMs,
					calibrateMs: afterCalibrateMs,
					roundMs: Date.now() - stageStartedAt,
					stage
				},
				screenshots: attemptScreenshots
			};
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
			screenshots,
			retriedRounds
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

	// Each Zeus variant is a separate measured series, so the expected record
	// count scales with the variant count. Without this an interleaved run collects
	// every record correctly and is still reported as blocked.
	const expectedRecords =
		selectedWorkloads.length *
		(selectedRenderers.filter(renderer => renderer !== 'zeus').length +
			(selectedRenderers.includes('zeus') ? zeusVariants.length || 1 : 0)) *
		repeat;
	const complete = records.length === expectedRecords;
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
		screenshots,
		retriedRounds
	});
	if (!allSuccessful) process.exitCode = 1;
}

async function serveBenchmarkPages(pagePaths) {
	const pages = new Map();
	for (const [name, pagePath] of pagePaths) {
		pages.set(name, await readFile(pagePath));
	}
	const resultChannel = createSqlResultGridResultChannel();
	const server = createServer((request, response) => {
		const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
		if (resultChannel.handle(request, response)) {
			return;
		}
		const pageName = requestUrl.pathname.startsWith('/page/')
			? decodeURIComponent(requestUrl.pathname.slice('/page/'.length))
			: 'benchmark';
		const html = pages.get(pageName);
		if (request.method !== 'GET' || !html) {
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
		pageUrl: name => `http://127.0.0.1:${address.port}/page/${encodeURIComponent(name)}`,
		resultUrl: `http://127.0.0.1:${address.port}/benchmark-result`,
		readResult: resultChannel.readResult,
		close: () => new Promise(resolveClose => server.close(() => resolveClose()))
	};
}

function parseZeusVariants(value) {
	if (!value) return [];
	const variants = String(value)
		.split(',')
		.map(entry => entry.trim())
		.filter(Boolean)
		.map(entry => {
			const separator = entry.indexOf('=');
			if (separator <= 0) {
				throw new Error(`--zeus-variant expects <id>=<path>, got ${entry}`);
			}
			return { id: entry.slice(0, separator).trim(), bundlePath: entry.slice(separator + 1).trim() };
		});
	for (const variant of variants) {
		if (!variant.id || !variant.bundlePath) {
			throw new Error(`--zeus-variant entry is incomplete: ${variant.id}=${variant.bundlePath}`);
		}
	}
	return variants;
}

function sanitizePageName(name) {
	const safe = String(name).replace(/[^a-zA-Z0-9._-]+/g, '-');
	if (!safe) throw new Error(`Zeus variant id does not produce a usable page name: ${name}`);
	return safe;
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

async function openBenchmarkSession() {
	return appBinary
		? await createEmbeddedWebdriverSession(driverUrl, { timeoutMs: startupTimeoutMs })
		: await createExternalSession(driverUrl, browser);
}

/**
 * Whether a navigation failed on the session URL, either by exceeding its
 * deadline or by returning an error response. One failure can be a slow page,
 * so this only justifies recycling once the same session has already failed
 * once; two failures in a row mean the WebView is not worth another attempt.
 */
function isNavigationFailure(error) {
	if (!(error instanceof Error)) return false;
	return /WebDriver POST \S+\/url (?:request failed \(timeout \d+ms\)|failed:)/.test(error.message);
}

/**
 * Navigation failures are not always transient. A renderer that leaves a very
 * large DOM behind (the 10k native table builds roughly 510k nodes) can drive
 * the host WebView into a state where every later navigation in the same
 * session fails. Re-navigating that session cannot recover it, so the run has
 * to start a fresh WebView rather than spend its remaining attempts on a dead
 * one.
 *
 * @param {{sessionId?: string}} session the run's live session state; updated in place.
 * @returns {Promise<boolean>} whether a fresh session is now in use.
 */
async function recycleSessionAfterNavigationFailures(session) {
	const staleSessionId = session.sessionId;
	session.sessionId = undefined;
	try {
		if (staleSessionId) {
			await webdriverRequest(driverUrl, `/session/${staleSessionId}`, 'DELETE').catch(() => undefined);
		}
		const fresh = await openBenchmarkSession();
		session.sessionId = fresh.sessionId;
		await setSessionTimeouts(driverUrl, fresh.sessionId, scriptTimeoutMs);
		process.stderr.write(`${label}: recycled the WebDriver session after repeated navigation failures.\n`);
		return true;
	} catch (error) {
		process.stderr.write(
			`${label}: could not recycle the WebDriver session after navigation failures: ${error instanceof Error ? error.message : String(error)}\n`
		);
		return false;
	}
}

async function calibrateCssViewport(baseUrl, sessionId, workload, embedded) {
	return convergeWindowRectForCssViewport(
		{ width: workload.width, height: workload.height },
		requestedWindowRect =>
			applyWindowRectAndObserveCssViewport(requestedWindowRect, {
				applyWindowRect: async appliedRequest => {
					const appliedPayload = await webdriverRequest(baseUrl, `/session/${sessionId}/window/rect`, 'POST', {
						width: appliedRequest.width,
						height: appliedRequest.height
					});
					let appliedWindowRect = normalizeWindowRect(unwrapWebdriverValue(appliedPayload));
					if (!appliedWindowRect) {
						const observedPayload = await webdriverRequest(baseUrl, `/session/${sessionId}/window/rect`);
						appliedWindowRect = normalizeWindowRect(unwrapWebdriverValue(observedPayload));
					}
					if (!appliedWindowRect) throw new Error('WebDriver did not return an applied window rect.');
					return appliedWindowRect;
				},
				observeCssViewport: async () => {
					const observed = await readCssViewport(baseUrl, sessionId, embedded);
					return { width: observed.width, height: observed.height };
				},
				settleMs: 250
			}),
		{ maxAttempts: 4, tolerance: 1, initialWindowRect: { width: workload.width, height: workload.height } }
	);
}

async function resetPageForViewportCalibration(baseUrl, sessionId, embedded) {
	const blankUrl = 'about:blank';
	await webdriverRequest(baseUrl, `/session/${sessionId}/url`, 'POST', { url: blankUrl });
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (embedded) {
			const urlPayload = await webdriverRequest(baseUrl, `/session/${sessionId}/url`);
			if (unwrapWebdriverValue(urlPayload) === blankUrl) return;
		} else {
			const state = unwrapWebdriverValue(
				await webdriverRequest(baseUrl, `/session/${sessionId}/execute/sync`, 'POST', {
					script:
						'return { href: location.href, readyState: document.readyState, hasBenchmarkResult: Boolean(document.querySelector("#benchmark-result")) };',
					args: []
				})
			);
			if (state?.href === blankUrl && state.readyState === 'complete' && state.hasBenchmarkResult === false) return;
		}
		await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
	}
	throw new Error(`Timed out waiting for viewport calibration reset: ${blankUrl}`);
}

async function startDeferredBenchmark(baseUrl, sessionId, embedded) {
	const expression = "window.dispatchEvent(new Event('nyala-benchmark-start')), true";
	if (embedded) {
		await evaluateViaDirectEval(baseUrl, expression, { timeoutMs: scriptTimeoutMs });
		return;
	}
	await webdriverRequest(baseUrl, `/session/${sessionId}/execute/sync`, 'POST', {
		script: `return (${expression});`,
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
				'({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio })',
				// Reading window.innerWidth is a trivial evaluation. Budgeting it at
				// the full script timeout let a slow embedded eval stall every
				// calibration attempt for two minutes each.
				{ timeoutMs: OBSERVE_EVAL_TIMEOUT_MS }
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

async function runObserverFreeSegmentTraceNavigation(
	baseUrl,
	sessionId,
	embedded,
	benchmarkBaseUrl,
	resultChannel,
	expected
) {
	const traceRunToken = randomUUID();
	const query = new URLSearchParams({
		run: traceRunToken,
		renderer: expected.renderer,
		executionOrder: expected.executionOrder ?? EXECUTION_ORDER,
		executionOrdinal: String(expected.executionOrdinal),
		segmentTrace: 'true',
		diagnosticProfile: 'true',
		measureNodeChurn: 'false',
		textChurn: String(expected.textChurn === true),
		rows: String(expected.workload.rows),
		columns: String(expected.workload.columns),
		wide: String(expected.workload.wide),
		width: String(expected.workload.width),
		height: String(expected.workload.height)
	});
	query.set('resultEndpoint', resultChannel.resultUrl);
	if (expected.zeusVariant) query.set('zeusVariant', expected.zeusVariant);
	const url = `${benchmarkBaseUrl}?${query}`;
	await webdriverRequest(baseUrl, `/session/${sessionId}/url`, 'POST', { url });
	await waitForNavigation(baseUrl, sessionId, url);
	const record = await waitForResult(
		baseUrl,
		sessionId,
		embedded,
		{
			runToken: traceRunToken,
			renderer: expected.renderer,
			executionOrder: expected.executionOrder ?? EXECUTION_ORDER,
			executionOrdinal: expected.executionOrdinal,
			zeusVariant: expected.zeusVariant ?? null,
			workload: expected.workload,
			workbenchTableImplementation: 'real',
			workbenchTableBundleSha256: expected.workbenchTableBundleSha256
		},
		resultChannel
	);
	if (record.status !== 'ok' || !record.segmentTrace) {
		// Naming the failing condition matters: an earlier build reported only
		// "Missing segment trace." for every renderer whose trace never arrived,
		// which hid whether the navigation failed or the trace was simply absent.
		const reason =
			record.error ??
			record.reason ??
			(record.status === 'ok'
				? 'the run reported ok but carried no segmentTrace.'
				: `the run reported status "${record.status}" and carried no segmentTrace.`);
		throw new Error(
			`Observer-free segment trace failed for ${expected.workload.id}/${expected.renderer}: ${String(reason).split('\n')[0]}`
		);
	}
	if (expected.textChurn) {
		if (
			record.segmentTrace.observerFree !== false ||
			record.segmentTrace.domObserverFree !== false ||
			record.segmentTrace.instrumentation !== 'text-churn-observer-v1' ||
			!record.textChurn
		) {
			throw new Error('Text churn diagnostic must declare its observer and carry counters.');
		}
	} else validateObserverFreeSegmentTraceSnapshot(record.segmentTrace, { expectedSampleCount: 22 });
	// `textChurn` is diagnostic-only evidence collected during the same measured
	// scroll. It travels with the trace so a caller can attribute host frame cost
	// to renderer text rewrites instead of guessing from timing alone.
	return { segmentTrace: record.segmentTrace, textChurn: record.textChurn };
}

async function waitForResult(baseUrl, sessionId, embedded, expected, resultChannel) {
	const deadline = Date.now() + scriptTimeoutMs;
	const channelDeadline = Date.now() + RESULT_CHANNEL_GRACE_MS;
	let lastMismatch;
	while (Date.now() < deadline) {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) break;
		const postedResult = resultChannel?.readResult(expected.runToken);
		let text = postedResult;
		// The page POSTs its result to the local result channel. Falling back to
		// an embedded direct eval the instant the channel is empty races the
		// in-flight fetch and blocks the WebView main thread for the whole eval
		// budget, which serialised the run into ~120s stalls. Give the channel a
		// short grace window first and only fall back once it has been exhausted.
		if (text === undefined && resultChannel && Date.now() < channelDeadline) {
			await sleepWithinDeadline(deadline, 50);
			continue;
		}
		if (text === undefined && (embedded || !resultChannel)) {
			try {
				text = embedded
					? await readBenchmarkResultViaDirectEval(baseUrl, remainingMs)
					: unwrapWebdriverValue(
							await webdriverRequest(baseUrl, `/session/${sessionId}/execute/sync`, 'POST', {
								script: "return document.querySelector('#benchmark-result')?.textContent || '';",
								args: []
							})
						);
			} catch (error) {
				lastMismatch = error instanceof Error ? error.message : String(error);
				await sleepWithinDeadline(deadline, 100);
				continue;
			}
		}
		if ((typeof text === 'string' && text.trim()) || (text && typeof text === 'object')) {
			let result;
			try {
				result = typeof text === 'string' ? JSON.parse(text) : text;
			} catch (error) {
				lastMismatch = error instanceof Error ? error.message : String(error);
				await sleepWithinDeadline(deadline, 100);
				continue;
			}
			if (
				(result.status === 'ok' || result.status === 'error' || result.status === 'unavailable') &&
				isBenchmarkResultForRun(result, expected)
			) {
				// A matching error is terminal for this run. Renderer provenance is
				// required for successful evidence, but must not turn a page error
				// into a 120-second stale-result timeout that hides the real cause.
				return result;
			}
			lastMismatch = `Ignored stale or mismatched result for run ${expected.runToken}.`;
		}
		await sleepWithinDeadline(deadline, 100);
	}
	throw new Error(`Timed out waiting for benchmark result.${lastMismatch ? ` ${lastMismatch}` : ''}`);
}

async function readBenchmarkResultViaDirectEval(baseUrl, remainingMs) {
	return evaluateViaDirectEval(baseUrl, "document.querySelector('#benchmark-result')?.textContent || ''", {
		timeoutMs: Math.max(1, Math.min(remainingMs, RESULT_POLL_EVAL_TIMEOUT_MS))
	});
}

function sleepWithinDeadline(deadline, delayMs) {
	const remainingMs = deadline - Date.now();
	if (remainingMs <= 0) return Promise.resolve();
	return new Promise(resolve => setTimeout(resolve, Math.min(delayMs, remainingMs)));
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

async function writeEvidence({
	status,
	runs,
	reason,
	label,
	identity,
	provenance,
	records,
	screenshots,
	retriedRounds = []
}) {
	const report = {
		version: 2,
		measurementContractVersion: MEASUREMENT_CONTRACT_VERSION,
		scrollCommitBoundary: SCROLL_COMMIT_BOUNDARY,
		executionOrder: interleaved ? INTERLEAVED_EXECUTION_ORDER : EXECUTION_ORDER,
		pageInstrumentation: 'no-global-dom-observer-v2',
		traceInstrumentation: textChurn ? 'text-churn-observer-v1' : 'no-global-dom-observer-v2',
		generatedAt: new Date().toISOString(),
		label,
		status,
		runs,
		reason,
		...identity,
		provenance,
		// An instrumented-baseline run installs renderer observers, so its
		// scrollP95Ms carries observer overhead and its presentation floor is not
		// sampled cleanly. Such evidence may answer diagnostic questions about
		// commit work, but it must never be scored for v7 admission.
		admissionGrade: !instrumentBaseline && !interleaved && !textChurn && !zeusCss,
		...(interleaved
			? {
					interleavedVariants: zeusVariants.map(variant => variant.id),
					variantBundleSha256: Object.fromEntries(
						zeusVariants.map(variant => [
							variant.id,
							provenance?.interleavedVariants?.find?.(entry => entry.id === variant.id)?.bundleSha256
						])
					)
				}
			: {}),
		...(instrumentBaseline || interleaved || textChurn || zeusCss
			? {
					limitations: [
						...(textChurn
							? [
									'Text-churn diagnostics install a DOM observer in the trace navigation and must not be scored for admission.'
								]
							: []),
						...(zeusCss
							? ['Product CSS evidence uses a diagnostic page layout and must not be scored for admission.']
							: []),
						...(instrumentBaseline
							? [
									'This run instrumented the baseline renderer, so scrollP95Ms carries observer overhead and the presentation floor was not sampled without instrumentation.',
									'It is diagnostic evidence about renderer commit work and must not be scored for v7 admission.'
								]
							: []),
						...(interleaved
							? [
									'This run interleaved multiple Zeus bundle variants inside one WebView session, so the Zeus renderer is measured once per variant per workload instead of once per workload.',
									'It is paired variant evidence and must not be scored for single-version v7 admission.'
								]
							: [])
					]
				}
			: {}),
		summary: summarize(records),
		records,
		screenshots,
		retriedRounds
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
		const key = summaryKey(record);
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
				// v7 admission reads the shared presentation floor from the summary,
				// so the per-record empty-loop p95 must survive aggregation here too.
				presentationFloorP95Ms: summarizeMetric(
					group.map(record => record.diagnostics?.presentationFloor?.p95Ms).filter(value => Number.isFinite(value))
				),
				domNodes: summarizeMetric(group.map(record => record.domNodes)),
				heapBytes: summarizeMetric(group.map(record => record.heapBytes).filter(value => value !== null)),
				formatMs: summarizeMetric(group.map(record => record.formatMs)),
				parseMs: summarizeMetric(group.map(record => record.parseMs)),
				fixtureBytes: group[0].fixtureBytes
			}
		])
	);
}

/**
 * An interleaved run measures the same workload/renderer once per bundle variant,
 * so collapsing them into one summary key would average the very difference the
 * run exists to measure. Variant records therefore get their own summary key.
 * Single-version runs are unaffected and keep the plain `workload/renderer` key
 * the gate and the audit tooling already read.
 */
function summaryKey(record) {
	const base = `${record.workloadId}/${record.renderer}`;
	return record.zeusVariant ? `${base}@${record.zeusVariant}` : base;
}

function validateVisualProbe(record, workload) {
	const probe = record.visualProbe;
	const renderedRowsValid =
		record.renderer === 'native'
			? record.renderedRows === workload.rows
			: Number.isInteger(record.renderedRows) &&
				record.renderedRows > 0 &&
				record.renderedRows <= maximumVirtualRenderedRows(workload);
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
		renderedRowsValid &&
		probe.outerDocumentOverflowFree === true &&
		probe.runMarkerAnchored === true &&
		probe.documentViewport?.clientWidth === record.browserViewport?.width &&
		probe.documentViewport?.clientHeight === record.browserViewport?.height &&
		probe.documentViewport?.scrollWidth === record.browserViewport?.width &&
		probe.documentViewport?.scrollHeight === record.browserViewport?.height &&
		Number.isInteger(probe.visibleTextLength) &&
		probe.visibleTextLength > 0;
	return {
		passed: Boolean(passed),
		reason: passed
			? 'visual probe passed'
			: 'renderer did not expose contained document geometry, a visible header, and a first cell'
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
