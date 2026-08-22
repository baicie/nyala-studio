import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
	createBalancedBenchmarkPlan,
	EXECUTION_ORDER,
	isBenchmarkResultForRun,
	isValidWorkbenchTableRendererImplementation,
	isValidVisibleRowIndex,
	MEASUREMENT_CONTRACT_VERSION,
	SCROLL_COMMIT_BOUNDARY,
	SCROLL_TARGET_RATIOS,
	WORKBENCH_TABLE_IMPLEMENTATION_ID,
	WORKBENCH_TABLE_RUNTIME_PROOF,
	waitForPresentationOpportunity
} from './sql-result-grid-benchmark-contract.mjs';

const execFileAsync = promisify(execFile);
const benchmarkScript = new URL('./benchmark-sql-result-grid.mjs', import.meta.url);
const checkedInReport = new URL('../docs/sql-mvp-phases/phase-z1-benchmark.json', import.meta.url);

test('balanced benchmark plan gives every renderer every position for repeat three', () => {
	const plan = createBalancedBenchmarkPlan([{ id: 'alpha' }, { id: 'beta' }], ['native', 'workbench-table', 'zeus'], 3);

	assert.deepEqual(
		plan.map(entry => `${entry.workload.id}/${entry.renderer}/${entry.iteration}/${entry.executionOrdinal}`),
		[
			'alpha/native/1/1',
			'alpha/workbench-table/1/2',
			'alpha/zeus/1/3',
			'alpha/workbench-table/2/4',
			'alpha/zeus/2/5',
			'alpha/native/2/6',
			'alpha/zeus/3/7',
			'alpha/native/3/8',
			'alpha/workbench-table/3/9',
			'beta/workbench-table/1/10',
			'beta/zeus/1/11',
			'beta/native/1/12',
			'beta/zeus/2/13',
			'beta/native/2/14',
			'beta/workbench-table/2/15',
			'beta/native/3/16',
			'beta/workbench-table/3/17',
			'beta/zeus/3/18'
		]
	);
	assert.equal(new Set(plan.map(entry => entry.executionOrdinal)).size, plan.length);
	assert.deepEqual(
		plan.map(entry => entry.executionOrdinal),
		Array.from({ length: plan.length }, (_, index) => index + 1)
	);
});

test('balanced benchmark plan bounds renderer position and ordinal imbalance for repeat five', () => {
	const renderers = ['native', 'workbench-table', 'zeus'];
	const plan = createBalancedBenchmarkPlan([{ id: 'alpha' }], renderers, 5);

	for (const renderer of renderers) {
		const entries = plan.filter(entry => entry.renderer === renderer);
		const positionCounts = renderers.map(
			(_, position) => entries.filter(entry => (entry.executionOrdinal - 1) % renderers.length === position).length
		);
		assert.ok(Math.max(...positionCounts) - Math.min(...positionCounts) <= 1);
	}
	assert.equal(new Set(plan.map(entry => entry.executionOrdinal)).size, plan.length);
	assert.equal(Math.max(...plan.map(entry => entry.executionOrdinal)), plan.length);
});

test('benchmark CLI prints help without launching Chrome or rewriting evidence', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-sql-result-grid-help-test-'));
	const browserMarker = join(root, 'browser-launched');
	const fakeBrowser = join(root, 'fake-chrome');
	const reportBefore = await readFile(checkedInReport, 'utf8');
	await writeFile(fakeBrowser, '#!/bin/sh\n: > "$NYALA_TEST_BROWSER_MARKER"\nkill -TERM "$PPID"\n', 'utf8');
	await chmod(fakeBrowser, 0o755);

	try {
		let execution;
		let executionError;
		try {
			execution = await execFileAsync(process.execPath, [benchmarkScript.pathname, '--help'], {
				env: {
					...process.env,
					NYALA_CHROME: fakeBrowser,
					NYALA_TEST_BROWSER_MARKER: browserMarker
				},
				timeout: 5_000
			});
		} catch (error) {
			executionError = error;
			execution = { stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
		}

		assert.deepEqual(
			{
				exitCode: executionError ? (executionError.code ?? executionError.signal ?? 1) : 0,
				stdoutHasUsage: /Usage:/.test(execution.stdout),
				browserLaunched: await exists(browserMarker),
				reportUnchanged: (await readFile(checkedInReport, 'utf8')) === reportBefore
			},
			{
				exitCode: 0,
				stdoutHasUsage: true,
				browserLaunched: false,
				reportUnchanged: true
			}
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('benchmark CLI accepts -h as the help alias', async () => {
	const { stdout } = await execFileAsync(process.execPath, [benchmarkScript.pathname, '-h'], { timeout: 5_000 });
	assert.match(stdout, /Usage:/);
	assert.match(stdout, /--diagnostic-profile/);
});

test('benchmark CLI requires an explicit Zeus bundle before emitting a page', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-sql-result-grid-zeus-input-test-'));
	const page = join(root, 'benchmark.html');
	try {
		await assert.rejects(
			execFileAsync(process.execPath, [benchmarkScript.pathname, '--emit-page', page, '--renderer', 'zeus'], {
				env: { ...process.env, NYALA_ZEUS_BUNDLE: '' },
				timeout: 5_000
			}),
			/Zeus renderer requires --zeus-bundle <path> or NYALA_ZEUS_BUNDLE/
		);
		assert.equal(await exists(page), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('benchmark CLI reads an explicit Zeus bundle from NYALA_ZEUS_BUNDLE', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-sql-result-grid-zeus-env-test-'));
	const page = join(root, 'benchmark.html');
	const bundle = join(root, 'data-grid-bundle.js');
	try {
		await writeFile(bundle, 'globalThis.__NYALA_TEST_ZEUS_BUNDLE__ = true;\n', 'utf8');
		await execFileAsync(process.execPath, [benchmarkScript.pathname, '--emit-page', page, '--renderer', 'zeus'], {
			env: { ...process.env, NYALA_ZEUS_BUNDLE: bundle },
			timeout: 5_000
		});
		assert.match(await readFile(page, 'utf8'), /__NYALA_TEST_ZEUS_BUNDLE__/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('benchmark script exposes the required workload and renderer vocabulary', async () => {
	const source = await import('node:fs/promises').then(fs =>
		fs.readFile(new URL('./benchmark-sql-result-grid.mjs', import.meta.url), 'utf8')
	);
	assert.match(source, /1_000/);
	assert.match(source, /10_000/);
	assert.match(source, /workbench-table/);
	assert.match(source, /zw-data-grid/);
	assert.match(source, /formatMs/);
	assert.match(source, /fixtureBytes/);
	assert.match(source, /scrollP95Ms/);
	assert.match(source, /visualProbe/);
	assert.match(source, /headerText/);
	assert.match(source, /firstVisibleCellText/);
	assert.match(source, /sourceRevision/);
	assert.match(source, /sourceTreeClean:\s*isSourceTreeClean\(\)/);
	assert.match(source, /zeusBundleSha256/);
	assert.match(source, /createBalancedBenchmarkPlan\(selectedWorkloads, selectedRenderers, repeat\)/);
	assert.match(source, /executionOrder:\s*EXECUTION_ORDER/);
	assert.match(source, /executionOrdinal:\s*String\(executionOrdinal\)/);
	assert.match(source, /params\.get\('executionOrder'\)/);
	assert.match(source, /params\.get\('executionOrdinal'\)/);
});

test('package benchmark command captures a balanced three-repeat admission run', async () => {
	const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
	assert.match(manifest.scripts['benchmark:sql-result-grid'], /--repeat 3(?:\s|$)/);
	assert.match(manifest.scripts['benchmark:sql-result-grid'], /--renderer all/);
	assert.match(manifest.scripts['benchmark:sql-result-grid'], /--workbench-table-implementation real/);
	assert.match(manifest.scripts['benchmark:sql-result-grid'], /--require-zeus true/);
	assert.doesNotMatch(manifest.scripts['benchmark:sql-result-grid'], /--diagnostic-profile/);
});

test('package profiler command runs a six-repeat 10k floor characterization', async () => {
	const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
	const command = manifest.scripts['profile:sql-result-grid-feasibility'];
	assert.match(command, /--diagnostic-profile true/);
	assert.match(command, /--repeat 6/);
	assert.match(command, /--workload 10k-x-50/);
	assert.match(command, /--renderer workbench-table,zeus/);
	assert.match(command, /--workbench-table-implementation real/);
	assert.match(command, /--require-zeus true/);
});

test('real WorkbenchTable implementation proof is exact and bundle-bound', () => {
	const bundleSha256 = 'a'.repeat(64);
	const implementation = {
		id: WORKBENCH_TABLE_IMPLEMENTATION_ID,
		runtimeProof: WORKBENCH_TABLE_RUNTIME_PROOF,
		exactPrototype: true,
		domVerified: true,
		bundleSha256
	};

	assert.equal(isValidWorkbenchTableRendererImplementation(implementation, bundleSha256), true);
	assert.equal(isValidWorkbenchTableRendererImplementation(undefined, bundleSha256), false);
	assert.equal(
		isValidWorkbenchTableRendererImplementation(
			{ ...implementation, id: 'nyala.benchmark.fixed-row-virtual-list-characterization' },
			bundleSha256
		),
		false
	);
	assert.equal(
		isValidWorkbenchTableRendererImplementation({ ...implementation, exactPrototype: false }, bundleSha256),
		false
	);
	assert.equal(isValidWorkbenchTableRendererImplementation(implementation, 'b'.repeat(64)), false);
});

test('benchmark script keeps the browser outside the production workbench', async () => {
	const source = await import('node:fs/promises').then(fs =>
		fs.readFile(new URL('./benchmark-sql-result-grid.mjs', import.meta.url), 'utf8')
	);
	assert.doesNotMatch(source, /src\/vs\/workbench\/contrib\/sqlResult\/browser\/sqlResultView/);
	assert.match(source, /limitations/);
});

test('Chromium runner waits for the structured result through CDP', async () => {
	const source = await import('node:fs/promises').then(fs =>
		fs.readFile(new URL('./benchmark-sql-result-grid.mjs', import.meta.url), 'utf8')
	);
	assert.match(source, /--remote-debugging-port=0/);
	assert.match(source, /Runtime\.evaluate/);
	assert.match(source, /waitForBenchmarkResult/);
	assert.match(source, /runToken/);
	assert.doesNotMatch(source, /--dump-dom/);
	assert.doesNotMatch(source, /--virtual-time-budget/);
});

test('benchmark result identity rejects stale navigation results', () => {
	const expected = {
		runToken: '11111111-1111-4111-8111-111111111111',
		renderer: 'native',
		executionOrder: EXECUTION_ORDER,
		executionOrdinal: 7,
		workload: { rows: 1_000, columns: 20, wide: false, width: 1_440, height: 420 }
	};
	const record = {
		status: 'ok',
		runToken: expected.runToken,
		renderer: expected.renderer,
		measurementContractVersion: MEASUREMENT_CONTRACT_VERSION,
		scrollCommitBoundary: SCROLL_COMMIT_BOUNDARY,
		executionOrder: expected.executionOrder,
		executionOrdinal: expected.executionOrdinal,
		workload: {
			rows: expected.workload.rows,
			columns: expected.workload.columns,
			wide: expected.workload.wide,
			viewportWidth: expected.workload.width,
			viewportHeight: expected.workload.height
		}
	};

	assert.equal(isBenchmarkResultForRun(record, expected), true);
	assert.equal(
		isBenchmarkResultForRun({ ...record, runToken: '22222222-2222-4222-8222-222222222222' }, expected),
		false
	);
	assert.equal(isBenchmarkResultForRun({ ...record, renderer: 'zeus' }, expected), false);
	assert.equal(isBenchmarkResultForRun({ ...record, scrollCommitBoundary: 'immediate-dom-probe' }, expected), false);
	assert.equal(isBenchmarkResultForRun({ ...record, executionOrder: 'renderer-blocked-v1' }, expected), false);
	assert.equal(isBenchmarkResultForRun({ ...record, executionOrdinal: 8 }, expected), false);
	assert.equal(
		isBenchmarkResultForRun({ ...record, workload: { ...record.workload, viewportWidth: 390 } }, expected),
		false
	);
});

test('scroll metric uses one completion contract for every renderer', async () => {
	const source = await import('node:fs/promises').then(fs =>
		fs.readFile(new URL('./benchmark-sql-result-grid.mjs', import.meta.url), 'utf8')
	);
	const presentationSource = waitForPresentationOpportunity.toString();
	assert.equal(MEASUREMENT_CONTRACT_VERSION, 6);
	assert.equal(EXECUTION_ORDER, 'renderer-balanced-rotation-v1');
	assert.equal(SCROLL_COMMIT_BOUNDARY, 'post-presentation-opportunity');
	assert.match(source, /measurementContractVersion:\s*MEASUREMENT_CONTRACT_VERSION/);
	assert.match(source, /scrollCommitBoundary:\s*SCROLL_COMMIT_BOUNDARY/);
	assert.match(source, /async function commitScroll/);
	assert.match(source, /async function measureScroll/);
	assert.doesNotMatch(source, /dispatchEvent\(new Event\('scroll'\)\)/);
	assert.match(source, /document\.elementFromPoint/);
	assert.match(source, /function getVisibleCell/);
	assert.match(source, /const firstCell = getVisibleCell\(rendered\)/);
	assert.match(source, /const scrollController = rendered\.scroll/);
	assert.match(source, /const viewportElement = rendered\.viewport \?\? rendered\.scroll/);
	assert.doesNotMatch(source, /const firstCell = root\.querySelector/);
	assert.match(presentationSource, /function waitForPresentationOpportunity/);
	assert.match(presentationSource, /requestAnimationFrame/);
	assert.match(source, /waitForPresentationOpportunity\.toString\(\)/);
	assert.match(presentationSource, /afterFrameTimerId = setTimer\(finish, 0\)/);
	assert.match(
		presentationSource,
		/rejectOpportunity\(new Error\('Timed out waiting for a presentation opportunity\.'\)\)/
	);
	assert.doesNotMatch(source, /setTimeout\(settle, 50\)/);
	assert.doesNotMatch(source, /if \(attempts > 0\)/);
	assert.match(
		source,
		/for \(; attempts < SCROLL_COMMIT_ATTEMPTS; \) \{[\s\S]*?await waitForPresentationOpportunity\(\{ timeoutMs: PRESENTATION_OPPORTUNITY_TIMEOUT_MS \}\)/
	);
	assert.match(source, /expectedRowIndex/);
	assert.match(source, /visibleRowIndex/);
	assert.match(source, /committed:[\s\S]*isValidVisibleRowIndex\(visibleRowIndex, rowCount\)/);
	assert.doesNotMatch(source, /attempts:\s*attempts \+ 1/);
	assert.match(source, /presentationOpportunities:\s*attempts/);
	assert.match(source, /samples/);
	assert.match(source, /inputMs/);
	assert.match(source, /settleMs/);
	assert.match(source, /totalMs/);
	assert.match(source, /startOffset/);
	assert.match(source, /const preposition = await commitScroll/);
	assert.doesNotMatch(source, /if \(rendered\.grid\)/);
	assert.doesNotMatch(source, /await rendered\.grid\.scrollToOffset\(target\)/);
	assert.match(source, /firstCellInViewport/);
	assert.match(source, /virtualRowsBounded/);
	assert.match(source, /\[data-slot="data-grid-viewport"\]/);
	assert.match(source, /viewportElement\.contains\(cell\)/);
	assert.match(source, /cell\.textContent\?\.trim\(\) !== String\(index\)/);
	assert.match(source, /\[data-slot="data-grid-body"\].*position: absolute/);
	assert.doesNotMatch(source, /function nextFrame/);
});

test('diagnostic profile measures twenty no-op presentation opportunities after the primary scroll metric', async () => {
	const source = await import('node:fs/promises').then(fs =>
		fs.readFile(new URL('./benchmark-sql-result-grid.mjs', import.meta.url), 'utf8')
	);
	assert.match(source, /SQL_RESULT_GRID_PRESENTATION_FLOOR_SAMPLE_COUNT/);
	assert.match(source, /async function measurePresentationFloor/);
	assert.match(source, /await waitForPresentationOpportunity\(\{ timeoutMs: PRESENTATION_OPPORTUNITY_TIMEOUT_MS \}\)/);
	assert.match(source, /const scroll = await measureScroll\(rendered\);[\s\S]*measurePresentationFloor/);
	assert.match(source, /diagnostics:\s*diagnosticProfile/);
	assert.match(source, /explicitRefreshViewport:\s*false/);
	assert.match(source, /overscan:\s*4/);
	assert.match(source, /rowShape:\s*'array-index'/);
});

test('Zeus adapter reuses formatted row arrays without a redundant viewport refresh', async () => {
	const source = await import('node:fs/promises').then(fs =>
		fs.readFile(new URL('./benchmark-sql-result-grid.mjs', import.meta.url), 'utf8')
	);
	assert.match(source, /grid\.overscan = 4/);
	assert.match(source, /field: String\(column\.ordinal\)/);
	assert.match(source, /grid\.rows = rows/);
	assert.doesNotMatch(source, /mappedRows/);
	assert.doesNotMatch(source, /refreshViewport/);
});

test('presentation completion waits for the task after the animation frame', async () => {
	let frameCallback;
	let nextTimerId = 1;
	const timers = new Map();
	const promise = waitForPresentationOpportunity({
		requestFrame(callback) {
			frameCallback = callback;
			return 17;
		},
		cancelFrame() {},
		setTimer(callback, delay) {
			const id = nextTimerId++;
			timers.set(id, { callback, delay });
			return id;
		},
		clearTimer(id) {
			timers.delete(id);
		},
		timeoutMs: 1_000
	});
	let completed = false;
	void promise.then(() => {
		completed = true;
	});

	assert.equal(completed, false);
	frameCallback(0);
	await Promise.resolve();
	assert.equal(completed, false);
	const postFrameTask = [...timers.values()].find(timer => timer.delay === 0);
	assert.ok(postFrameTask);
	postFrameTask.callback();
	await promise;
	assert.equal(completed, true);
});

test('presentation completion rejects instead of treating timeout as success', async () => {
	let cancelledFrame;
	const timers = new Map();
	const promise = waitForPresentationOpportunity({
		requestFrame() {
			return 23;
		},
		cancelFrame(handle) {
			cancelledFrame = handle;
		},
		setTimer(callback, delay) {
			timers.set(delay, callback);
			return delay;
		},
		clearTimer(id) {
			timers.delete(id);
		},
		timeoutMs: 1_000
	});
	const timeout = timers.get(1_000);
	assert.ok(timeout);
	timeout();

	await assert.rejects(promise, /Timed out waiting for a presentation opportunity/);
	assert.equal(cancelledFrame, 23);
});

test('scroll completion rejects the missing visible-row sentinel', () => {
	assert.equal(isValidVisibleRowIndex(-1, 1_000), false);
	assert.equal(isValidVisibleRowIndex(0, 1_000), true);
	assert.equal(isValidVisibleRowIndex(999, 1_000), true);
	assert.equal(isValidVisibleRowIndex(1_000, 1_000), false);
});

test('scroll samples are gate-recomputable rather than producer-only aggregates', async () => {
	const source = await import('node:fs/promises').then(fs =>
		fs.readFile(new URL('./benchmark-sql-result-grid.mjs', import.meta.url), 'utf8')
	);
	assert.equal(SCROLL_TARGET_RATIOS.length, 20);
	assert.match(source, /SCROLL_SAMPLE_COUNT\s*=\s*SCROLL_TARGET_RATIOS\.length/);
	assert.match(source, /sampleIndex/);
	assert.match(source, /targetOffset/);
	assert.match(source, /actualOffset/);
	assert.match(source, /scrollViewportHeight/);
	assert.match(source, /rowDelta/);
	assert.match(source, /summarizeSamples/);
});

async function exists(path) {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}
