#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultOutput = join(repositoryRoot, 'docs/sql-mvp-phases/phase-z1-benchmark.json');
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
const repeat = parsePositiveInteger(cli.repeat ?? '1', '--repeat');
const selectedRenderers =
	cli.renderer === 'all' || !cli.renderer ? ['native', 'workbench-table', 'zeus'] : cli.renderer.split(',');
const supportedRenderers = new Set(['native', 'workbench-table', 'zeus']);
if (selectedRenderers.some(renderer => !supportedRenderers.has(renderer))) {
	throw new Error(`renderer must be one of: ${[...supportedRenderers].join(', ')}`);
}
const selectedWorkloads = cli.workload
	? workloads.filter(workload => cli.workload.split(',').includes(workload.id))
	: workloads;
if (selectedWorkloads.length === 0) {
	throw new Error('workload did not match a known benchmark workload');
}
const zeusBundle = cli['zeus-bundle'] ?? '/tmp/nyala-zeus-audit-20260810/data-grid-bundle.js';
const outputPath = resolve(cli.output ?? defaultOutput);

if (cli['emit-page']) {
	const pagePath = resolve(cli['emit-page']);
	if (selectedRenderers.includes('zeus') && cli['require-zeus'] === 'true' && !(await exists(zeusBundle))) {
		throw new Error(`Unable to load Zeus bundle at ${zeusBundle}`);
	}
	await writeFile(
		pagePath,
		await createBenchmarkPage({
			includeZeus: selectedRenderers.includes('zeus'),
			zeusBundle
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

try {
	if (selectedRenderers.includes('zeus') && cli['require-zeus'] === 'true' && !(await exists(zeusBundle))) {
		throw new Error(`Unable to load Zeus bundle at ${zeusBundle}`);
	}
	const html = await createBenchmarkPage({
		includeZeus: selectedRenderers.includes('zeus'),
		zeusBundle
	});
	await writeFile(join(temporaryRoot, 'benchmark.html'), html, 'utf8');

	const records = [];
	for (const workload of selectedWorkloads) {
		for (const renderer of selectedRenderers) {
			for (let iteration = 1; iteration <= repeat; iteration += 1) {
				const record = runBrowserBenchmark(
					chromePath,
					pathToFileURL(join(temporaryRoot, 'benchmark.html')).href,
					workload,
					renderer,
					iteration
				);
				records.push(record);
				process.stdout.write(`${record.workloadId}/${record.renderer} #${iteration}: ${formatRecord(record)}\n`);
			}
		}
	}
	if (cli['require-zeus'] === 'true' && records.some(record => record.renderer === 'zeus' && record.status !== 'ok')) {
		throw new Error('Zeus renderer did not produce an ok benchmark record');
	}

	const report = {
		version: 1,
		generatedAt: new Date().toISOString(),
		browser: chromePath,
		userAgent: records.find(record => record.userAgent)?.userAgent,
		repeat,
		workloads: selectedWorkloads,
		renderers: selectedRenderers,
		records,
		summary: summarize(records),
		limitations: [
			'Browser runs use Chromium-compatible headless mode; they are not macOS WebKit or Windows WebView2 evidence.',
			'The WorkbenchTable renderer is a standalone fixed-row virtual-list characterization of the platform table contract, not a Workbench boot.',
			'IPC and format timings measure the existing JSON-shaped result boundary and local cell formatting; no database or Tauri command is invoked.'
		]
	};
	await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
	process.stdout.write(`Wrote ${outputPath}\n`);
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
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

function parsePositiveInteger(value, name) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
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

function runBrowserBenchmark(chromePath, baseUrl, workload, renderer, iteration) {
	const query = new URLSearchParams({
		renderer,
		rows: String(workload.rows),
		columns: String(workload.columns),
		wide: String(workload.wide),
		width: String(workload.width),
		height: String(workload.height)
	});
	const url = `${baseUrl}?${query}`;
	const output = execFileSync(
		chromePath,
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
			'--timeout=20000',
			'--virtual-time-budget=20000',
			`--window-size=${workload.width},${workload.height}`,
			'--dump-dom',
			url
		],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
	);
	const match = output.match(/<pre id="benchmark-result">([\s\S]*?)<\/pre>/);
	if (!match) {
		throw new Error(`Benchmark did not produce a result for ${workload.id}/${renderer}`);
	}
	const record = JSON.parse(match[1]);
	return { ...record, workloadId: workload.id, iteration };
}

async function createBenchmarkPage({ includeZeus, zeusBundle }) {
	const zeusSource = includeZeus && (await exists(zeusBundle)) ? await readFile(zeusBundle, 'utf8') : '';
	const zeusTag = zeusSource ? `<script type="module">\n${zeusSource}\n</script>` : '';
	return `<!doctype html>
<meta charset="utf-8">
<title>Nyala SQL result grid benchmark</title>
<style>
html, body { margin: 0; background: #1e1e1e; color: #ddd; font: 12px sans-serif; }
#root { width: 100vw; height: 100vh; overflow: hidden; }
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
zw-data-grid { display: block; width: 100%; height: calc(100vh - 20px); }
zw-data-grid [data-slot="data-grid-viewport"] { position: relative; box-sizing: border-box; width: 100%; height: 100%; overflow: auto; contain: strict; }
zw-data-grid [data-slot="data-grid-header"] { position: sticky; top: 0; z-index: 2; min-height: 28px; background: #2d2d2d; }
zw-data-grid [data-slot="data-grid-spacer"] { position: relative; }
zw-data-grid [data-slot="data-grid-body"] { position: absolute; top: 28px; left: 0; }
zw-data-grid [data-slot="data-grid-row"] { position: absolute; left: 0; height: 28px; }
zw-data-grid [data-slot="data-grid-header-cell"], zw-data-grid [data-slot="data-grid-cell"] { box-sizing: border-box; min-width: 0; height: 28px; padding: 4px 8px; border: 1px solid #444; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
${zeusTag}
<div id="root"></div><pre id="benchmark-result"></pre>
<script>
const params = new URLSearchParams(location.search);
const renderer = params.get('renderer') || 'native';
const rowCount = Number(params.get('rows') || 1000);
const columnCount = Number(params.get('columns') || 20);
const wide = params.get('wide') === 'true';
const viewportWidth = Number(params.get('width') || 1440);
const viewportHeight = Number(params.get('height') || 420);
document.documentElement.style.width = viewportWidth + 'px';
document.documentElement.style.height = viewportHeight + 'px';
document.body.style.width = viewportWidth + 'px';
document.body.style.height = viewportHeight + 'px';

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

function getScrollElement(root) {
  return root.querySelector('.bench-scroll, .virtual-scroll, [data-slot="data-grid-viewport"]') || root;
}

function commitScroll(scrollElement, target) {
	const start = performance.now();
	scrollElement.scrollTop = target;
	scrollElement.dispatchEvent(new Event('scroll'));
	// Force layout synchronously; background WebViews may throttle timers and
	// animation frames, which would measure scheduler latency instead of scroll.
	void scrollElement.scrollTop;
	void scrollElement.offsetHeight;
	return performance.now() - start;
}

async function measureScroll(rendered) {
  const samples = [];
  const max = Math.max(0, rendered.totalHeight - rendered.scroll.clientHeight);
  for (let index = 0; index < 12; index += 1) {
    const target = max * index / 11;
		if (rendered.grid) {
			const start = performance.now();
			await rendered.grid.scrollToOffset(target);
			void rendered.scroll.offsetHeight;
			samples.push(performance.now() - start);
		} else {
			samples.push(commitScroll(rendered.scroll, target));
		}
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)] || 0,
    p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] || 0,
    maxMs: Math.max(...samples, 0)
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
  for (const row of rows) { const tr = document.createElement('tr'); for (const value of row) { const td = document.createElement('td'); td.textContent = value === null ? 'NULL' : String(value); tr.append(td); } body.append(tr); }
  table.append(body); scroll.append(table); root.append(scroll);
  return { scroll, totalHeight: rows.length * 28 + 28 };
}

function renderWorkbenchTable(root, rows, columns) {
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
      const rowElement = document.createElement('div'); rowElement.className = 'virtual-row'; rowElement.style.top = rowIndex * 28 + 'px';
      for (const value of rows[rowIndex]) { const cell = document.createElement('div'); cell.className = 'virtual-cell'; cell.textContent = value === null ? 'NULL' : String(value); rowElement.append(cell); }
      viewport.append(rowElement);
    }
  };
  scroll.addEventListener('scroll', renderWindow, { passive: true }); renderWindow();
  return { scroll, totalHeight: rows.length * 28 + 28 };
}

async function renderZeus(root, rows, columns) {
  if (!customElements.get('zw-data-grid')) return { unavailable: 'Zeus bundle was not provided.' };
  const grid = document.createElement('zw-data-grid');
  grid.setAttribute('aria-label', 'SQL result benchmark');
  grid.virtual = true; grid.rowHeight = 28; grid.overscan = 8; grid.keyboardNavigation = true; grid.selectionMode = 'single';
  grid.columns = columns.map(column => ({ id: column.id, header: column.name, field: column.id, width: 112, minWidth: 80, maxWidth: 480, sortable: false, resizable: false }));
  grid.rows = rows.map((row, rowIndex) => Object.fromEntries(row.map((value, columnIndex) => ['c' + columnIndex, value === null ? 'NULL' : String(value)]).concat([['key', 'row-' + rowIndex]])));
	root.append(grid);
	if (grid.componentOnReady) await grid.componentOnReady();
	void root.offsetHeight;
	return { scroll: getScrollElement(root), totalHeight: rows.length * 28 + 28, grid };
}

async function main() {
  const root = document.getElementById('root');
  root.style.width = viewportWidth + 'px'; root.style.height = viewportHeight + 'px';
  if (renderer === 'zeus' && !customElements.get('zw-data-grid')) {
    await Promise.race([
      customElements.whenDefined('zw-data-grid'),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
  }
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
  if (rendered.unavailable) {
    document.getElementById('benchmark-result').textContent = JSON.stringify({ renderer, workload: renderer, status: 'unavailable', reason: rendered.unavailable });
    return;
  }
	void root.offsetHeight;
	const scroll = await measureScroll(rendered);
	if (renderer === 'zeus') {
		await rendered.grid.scrollToOffset(0);
		await rendered.grid.refreshViewport();
	} else {
		commitScroll(rendered.scroll, 0);
	}
	await Promise.resolve();
	void root.offsetHeight;
  const afterHeap = measureHeap();
	const firstCell = root.querySelector('tbody td, .virtual-row .virtual-cell, [role="gridcell"]');
	const firstCellRect = firstCell?.getBoundingClientRect();
	const rootRect = root.getBoundingClientRect();
	const renderedRows = renderer === 'native' ? rowCount : document.querySelectorAll('[data-row-index], .virtual-row, tbody tr').length;
  const result = {
    status: 'ok', renderer, workload: { rows: rowCount, columns: columnCount, wide, viewportWidth, viewportHeight },
    userAgent: navigator.userAgent, formatMs: formatted.formatMs, parseMs, renderMs,
    scroll, domNodes: measureDomNodes(), fixtureBytes,
    heapBytes: beforeHeap !== null && afterHeap !== null && afterHeap > beforeHeap ? afterHeap - beforeHeap : null,
	    renderedRows,
	    visualProbe: {
      rootWidth: root.getBoundingClientRect().width,
      rootHeight: root.getBoundingClientRect().height,
      headerText: root.querySelector('th, .virtual-header .virtual-cell, [role="columnheader"]')?.textContent || '',
		firstVisibleCellText: firstCell?.textContent || '',
		firstCellInViewport: Boolean(firstCellRect && firstCellRect.bottom > rootRect.top && firstCellRect.top < rootRect.bottom),
		virtualRowsBounded: renderer === 'native' || renderedRows < rowCount,
      visibleTextLength: (root.innerText || root.textContent || '').trim().length
    }
  };
  document.getElementById('benchmark-result').textContent = JSON.stringify(result);
}
main().catch(error => { document.getElementById('benchmark-result').textContent = JSON.stringify({ status: 'error', renderer, error: String(error && error.stack || error) }); });
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
		return `${record.status}${record.reason ? ` (${record.reason})` : ''}`;
	}
	return `render=${record.renderMs.toFixed(2)}ms scroll-p95=${record.scroll.p95Ms.toFixed(2)}ms dom=${record.domNodes} heap=${record.heapBytes ?? 'n/a'}`;
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
