#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
		for (const workload of selectedWorkloads) {
			for (const renderer of selectedRenderers) {
				for (let iteration = 1; iteration <= repeat; iteration += 1) {
					const screenshotName = `${workload.id}-${renderer}-${iteration}.png`;
					const screenshotPath = join(screenshotDir, screenshotName);
					if (artifactPaths.has(screenshotPath)) throw new Error(`Duplicate screenshot path: ${screenshotPath}`);
					artifactPaths.add(screenshotPath);
					const artifact = await captureArtifact({
						browser,
						pageUrl,
						workload,
						renderer,
						iteration,
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

async function captureArtifact({ browser, pageUrl, workload, renderer, iteration, screenshotPath }) {
	const url = `${pageUrl}?${new URLSearchParams({
		renderer,
		rows: String(workload.rows),
		columns: String(workload.columns),
		wide: String(workload.wide),
		width: String(workload.width),
		height: String(workload.height)
	})}`;
	try {
		const output = execFileSync(
			browser,
			[
				'--headless=new',
				'--single-process',
				'--disable-gpu',
				'--no-sandbox',
				'--disable-dev-shm-usage',
				'--disable-background-networking',
				'--disable-component-update',
				'--disable-default-apps',
				'--no-first-run',
				'--enable-precise-memory-info',
				'--run-all-compositor-stages-before-draw',
				'--hide-scrollbars',
				'--timeout=20000',
				'--virtual-time-budget=20000',
				`--window-size=${workload.width},${workload.height}`,
				`--screenshot=${screenshotPath}`,
				'--dump-dom',
				url
			],
			{
				encoding: 'utf8',
				maxBuffer: 64 * 1024 * 1024,
				stdio: ['ignore', 'pipe', 'ignore'],
				timeout: browserTimeoutMs,
				killSignal: 'SIGKILL'
			}
		);
		const record = parseBenchmarkRecord(output);
		const visual = await inspectVisualEvidence(screenshotPath, workload, renderer, record);
		const screenshotBytes = await readFile(screenshotPath);
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

function parseBenchmarkRecord(output) {
	const match = output.match(/<pre id="benchmark-result">([\s\S]*?)<\/pre>/);
	if (!match) throw new Error('Benchmark did not produce a result record.');
	return JSON.parse(match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
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
