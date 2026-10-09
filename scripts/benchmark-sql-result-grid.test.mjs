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
import {
	createZeusDataGridDiagnosticCollector,
	validateZeusDataGridDiagnosticSnapshot,
	ZEUS_DATA_GRID_DIAGNOSTICS_CORRELATION,
	ZEUS_DATA_GRID_DIAGNOSTICS_VERSION
} from './sql-result-grid-zeus-diagnostics.mjs';
import {
	createWorkbenchTableDiagnosticCollector,
	validateWorkbenchTableDiagnosticSnapshot,
	WORKBENCH_TABLE_DIAGNOSTICS_CORRELATION,
	WORKBENCH_TABLE_DIAGNOSTICS_INSTRUMENTATION,
	WORKBENCH_TABLE_DIAGNOSTICS_VERSION
} from './sql-result-grid-workbench-table-diagnostics.mjs';
import {
	createSqlResultGridFloorHeadroomProfile,
	createSqlResultGridWorkloadCpuRatioProfile
} from './sql-result-grid-floor-headroom.mjs';

const execFileAsync = promisify(execFile);
const benchmarkScript = new URL('./benchmark-sql-result-grid.mjs', import.meta.url);
const floorHeadroomAnalyzerScript = new URL('./analyze-sql-result-grid-floor-headroom.mjs', import.meta.url);
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
	assert.match(source, /validateWorkbenchTableDiagnosticSnapshot\.toString\(\)/);
	assert.match(source, /workbenchTableOperation/);
	assert.match(source, /workbenchTableDiagnostics/);
	assert.match(source, /explicitRefreshViewport:\s*false/);
	assert.match(source, /overscan:\s*4/);
	assert.match(source, /rowShape:\s*'array-index'/);
});

test('Zeus diagnostic collector snapshots callback values and correlates every scroll commit in order', () => {
	const collector = createZeusDataGridDiagnosticCollector();
	const modelBuild = createModelBuildTiming();
	collector.observer.onModelBuild(modelBuild);
	collector.observer.onCommit(createCommitTiming(1, 'mount'));
	const operation = collector.beginOperation('sample', 0);
	const firstScrollCommit = createCommitTiming(2, 'scroll');
	const secondScrollCommit = createCommitTiming(3, 'scroll');
	collector.observer.onCommit(firstScrollCommit);
	collector.observer.onCommit(secondScrollCommit);
	collector.endOperation(operation);

	modelBuild.rowCount = 0;
	firstScrollCommit.layoutReadIntervals[0][0] = 999;
	const snapshot = collector.snapshot();

	assert.equal(snapshot.version, ZEUS_DATA_GRID_DIAGNOSTICS_VERSION);
	assert.equal(snapshot.correlation, ZEUS_DATA_GRID_DIAGNOSTICS_CORRELATION);
	assert.equal(snapshot.modelBuilds[0].rowCount, 10_000);
	assert.equal(snapshot.commits[1].layoutReadIntervals[0][0], 22);
	assert.deepEqual(snapshot.scrollOperations, [
		{
			phase: 'sample',
			sampleIndex: 0,
			commitTransactionIds: [2, 3],
			primaryCommitTransactionId: 3
		}
	]);
});

test('Zeus diagnostic validator accepts a complete operation sidecar and rejects corrupt timing or reused commits', () => {
	const snapshot = createValidZeusDiagnosticSnapshot(2);
	assert.equal(validateZeusDataGridDiagnosticSnapshot(snapshot, createDiagnosticValidationOptions(2)), snapshot);

	const corruptTiming = structuredClone(snapshot);
	corruptTiming.commits[1].commitEndTime = corruptTiming.commits[1].commitStartTime - 1;
	assert.throws(
		() => validateZeusDataGridDiagnosticSnapshot(corruptTiming, createDiagnosticValidationOptions(2)),
		/commit timing/i
	);

	const reusedCommit = structuredClone(snapshot);
	reusedCommit.scrollOperations[2].commitTransactionIds = [1];
	reusedCommit.scrollOperations[2].primaryCommitTransactionId = 1;
	assert.throws(
		() => validateZeusDataGridDiagnosticSnapshot(reusedCommit, createDiagnosticValidationOptions(2)),
		/reused/i
	);
});

test('Zeus diagnostic validator treats diagnosticsEndTime as optional split timing', () => {
	const snapshot = createValidZeusDiagnosticSnapshot(2);
	assert.equal(snapshot.commits[0].diagnosticsEndTime, undefined);
	assert.equal(validateZeusDataGridDiagnosticSnapshot(snapshot, createDiagnosticValidationOptions(2)), snapshot);

	const splitTiming = structuredClone(snapshot);
	splitTiming.commits[0].diagnosticsEndTime = splitTiming.commits[0].commitEndTime + 1;
	splitTiming.commits[1].diagnosticsEndTime = splitTiming.commits[1].commitEndTime;
	assert.equal(validateZeusDataGridDiagnosticSnapshot(splitTiming, createDiagnosticValidationOptions(2)), splitTiming);

	const reversedDiagnostics = structuredClone(snapshot);
	reversedDiagnostics.commits[0].diagnosticsEndTime = reversedDiagnostics.commits[0].commitEndTime - 1;
	assert.throws(
		() => validateZeusDataGridDiagnosticSnapshot(reversedDiagnostics, createDiagnosticValidationOptions(2)),
		/diagnosticsEndTime precedes commitEndTime/i
	);

	const nonFiniteDiagnostics = structuredClone(snapshot);
	nonFiniteDiagnostics.commits[1].diagnosticsEndTime = Number.NaN;
	assert.throws(
		() => validateZeusDataGridDiagnosticSnapshot(nonFiniteDiagnostics, createDiagnosticValidationOptions(2)),
		/must be finite/i
	);
});

test('Zeus diagnostic collector copies finite diagnosticsEndTime and omits beta.4 samples without it', () => {
	const collector = createZeusDataGridDiagnosticCollector();
	collector.observer.onModelBuild(createModelBuildTiming());
	collector.observer.onCommit(createCommitTiming(1, 'mount'));
	const splitCommit = createCommitTiming(2, 'scroll');
	splitCommit.diagnosticsEndTime = splitCommit.commitEndTime + 2;
	collector.observer.onCommit(splitCommit);

	const snapshot = collector.snapshot();
	assert.equal(snapshot.commits[0].diagnosticsEndTime, undefined);
	assert.equal(snapshot.commits[1].diagnosticsEndTime, splitCommit.commitEndTime + 2);
});

test('Zeus diagnostic collector omits measureNodeChurn by default and can disable node-churn A/B', () => {
	const defaultCollector = createZeusDataGridDiagnosticCollector();
	assert.equal(defaultCollector.observer.measureNodeChurn, undefined);

	const disabledCollector = createZeusDataGridDiagnosticCollector({ measureNodeChurn: false });
	assert.equal(disabledCollector.observer.measureNodeChurn, false);
});

test('Zeus diagnostic collector validates the churn-disabled arm end to end', () => {
	const collector = createZeusDataGridDiagnosticCollector({ measureNodeChurn: false });
	collector.observer.onModelBuild(createModelBuildTiming());
	collector.observer.onCommit(createCommitTiming(1, 'mount'));
	const preposition = collector.beginOperation('preposition', null);
	collector.endOperation(preposition);
	const disabledScrollCommit = createCommitTiming(2, 'scroll');
	disabledScrollCommit.createdNodeCount = 0;
	disabledScrollCommit.removedNodeCount = 0;
	disabledScrollCommit.diagnosticsEndTime = disabledScrollCommit.commitEndTime;
	const sampleOperation = collector.beginOperation('sample', 0);
	collector.observer.onCommit(disabledScrollCommit);
	collector.endOperation(sampleOperation);
	const reset = collector.beginOperation('reset', null);
	collector.endOperation(reset);

	const snapshot = collector.snapshot();
	assert.equal(snapshot.commits[1].createdNodeCount, 0);
	assert.equal(snapshot.commits[1].removedNodeCount, 0);
	assert.equal(snapshot.commits[1].diagnosticsEndTime, snapshot.commits[1].commitEndTime);
	assert.equal(
		validateZeusDataGridDiagnosticSnapshot(snapshot, {
			expectedSampleCount: 1,
			workload: { rows: 10_000, columns: 50 },
			scrollSamples: [{ sampleIndex: 0, visibleRowIndex: 25, expectedRowIndex: 25 }]
		}),
		snapshot
	);

	const corrupt = structuredClone(snapshot);
	corrupt.commits[1].createdNodeCount = -1;
	assert.throws(
		() =>
			validateZeusDataGridDiagnosticSnapshot(corrupt, {
				expectedSampleCount: 1,
				workload: { rows: 10_000, columns: 50 },
				scrollSamples: [{ sampleIndex: 0, visibleRowIndex: 25, expectedRowIndex: 25 }]
			}),
		/non-negative safe integer/i
	);
});

test('Zeus diagnostic validator binds ordered internal commits to every external scroll sample', () => {
	const swappedTransactions = createValidZeusDiagnosticSnapshot(2);
	swappedTransactions.scrollOperations[1].commitTransactionIds = [2];
	swappedTransactions.scrollOperations[1].primaryCommitTransactionId = 2;
	swappedTransactions.scrollOperations[2].commitTransactionIds = [1];
	swappedTransactions.scrollOperations[2].primaryCommitTransactionId = 1;
	const swappedOptions = createDiagnosticValidationOptions(2);
	swappedOptions.scrollSamples[0].visibleRowIndex = 20;
	swappedOptions.scrollSamples[0].expectedRowIndex = 20;
	swappedOptions.scrollSamples[1].visibleRowIndex = 10;
	swappedOptions.scrollSamples[1].expectedRowIndex = 10;
	assert.throws(() => validateZeusDataGridDiagnosticSnapshot(swappedTransactions, swappedOptions), /out of order/i);

	const unclaimedTransaction = createValidZeusDiagnosticSnapshot(2);
	unclaimedTransaction.commits.push(createCommitTiming(3));
	assert.throws(
		() => validateZeusDataGridDiagnosticSnapshot(unclaimedTransaction, createDiagnosticValidationOptions(2)),
		/unclaimed/i
	);

	const mismatchedRange = createDiagnosticValidationOptions(2);
	mismatchedRange.scrollSamples[0].visibleRowIndex = 999;
	assert.throws(
		() => validateZeusDataGridDiagnosticSnapshot(createValidZeusDiagnosticSnapshot(2), mismatchedRange),
		/outside.*commit range/i
	);
});

test('Zeus diagnostic validator rejects incomplete or malformed raw sidecars', () => {
	const cases = [
		{
			name: 'missing operation',
			mutate(snapshot) {
				snapshot.scrollOperations.pop();
			},
			expected: /operation count/i
		},
		{
			name: 'unknown transaction',
			mutate(snapshot) {
				snapshot.scrollOperations[1].commitTransactionIds = [99];
				snapshot.scrollOperations[1].primaryCommitTransactionId = 99;
			},
			expected: /missing or not scroll/i
		},
		{
			name: 'layout interval outside range',
			mutate(snapshot) {
				snapshot.commits[0].layoutReadIntervals = [[0, 1]];
			},
			expected: /layout interval/i
		},
		{
			name: 'negative wrapper allocation',
			mutate(snapshot) {
				snapshot.commits[0].rowWrapperAllocationCount = -1;
			},
			expected: /non-negative safe integer/i
		},
		{
			name: 'non-finite model timing',
			mutate(snapshot) {
				snapshot.modelBuilds[0].endTime = Number.NaN;
			},
			expected: /must be finite/i
		}
	];

	for (const testCase of cases) {
		const snapshot = createValidZeusDiagnosticSnapshot(2);
		testCase.mutate(snapshot);
		assert.throws(
			() => validateZeusDataGridDiagnosticSnapshot(snapshot, createDiagnosticValidationOptions(2)),
			testCase.expected,
			testCase.name
		);
	}
});

test('WorkbenchTable diagnostic collector instruments only inside an open operation window', () => {
	const originalOnScroll = function () {
		this.getRenderRange(0, 420);
		this.render({}, 0, 420, 0, 5600, undefined, true);
	};
	const prototype = {
		onScroll: originalOnScroll,
		getRenderRange() {
			return { start: 4, end: 24 };
		},
		render() {
			this.measureItemWidth({});
		},
		measureItemWidth() {}
	};
	const collector = createWorkbenchTableDiagnosticCollector({ ListViewPrototype: prototype });
	const target = Object.create(prototype);

	target.onScroll();
	assert.equal(collector.snapshot().commits.length, 0);

	const operation = collector.beginOperation('sample', 0);
	assert.throws(() => collector.beginOperation('sample', 1), /cannot be nested/);
	target.onScroll();
	const correlation = collector.endOperation(operation);
	const snapshot = collector.snapshot();
	const commit = snapshot.commits[0];

	assert.equal(snapshot.version, WORKBENCH_TABLE_DIAGNOSTICS_VERSION);
	assert.equal(snapshot.timingClock, 'performance-now');
	assert.equal(snapshot.correlation, WORKBENCH_TABLE_DIAGNOSTICS_CORRELATION);
	assert.equal(snapshot.instrumentation, WORKBENCH_TABLE_DIAGNOSTICS_INSTRUMENTATION);
	assert.equal(snapshot.commits.length, 1);
	assert.deepEqual(correlation, {
		phase: 'sample',
		sampleIndex: 0,
		commitTransactionIds: [1],
		primaryCommitTransactionId: 1
	});
	assert.equal(commit.source, 'scroll');
	assert.equal(commit.rangeIntervals.length, 1);
	assert.equal(commit.commitIntervals.length, 1);
	assert.equal(commit.layoutReadIntervals.length, 1);
	assert.equal(commit.firstRowIndex, 4);
	assert.equal(commit.lastRowIndex, 23);
	assert.ok(commit.handlerStartTime <= commit.rangeIntervals[0][0]);
	assert.ok(commit.rangeIntervals[0][1] <= commit.handlerEndTime);
	assert.ok(commit.layoutReadIntervals[0][0] >= commit.commitIntervals[0][0]);
	assert.equal(collector.isInstalledOn(target), true);

	collector.dispose();
	assert.equal(prototype.onScroll, originalOnScroll);
	assert.equal(collector.isInstalledOn(target), false);
});

test('WorkbenchTable diagnostic collector requires every wrapped ListView method', () => {
	assert.throws(
		() =>
			createWorkbenchTableDiagnosticCollector({
				ListViewPrototype: { onScroll() {}, getRenderRange() {}, render() {} }
			}),
		/measureItemWidth/
	);
});

test('WorkbenchTable diagnostic validator accepts a complete sidecar and rejects corrupt intervals or reused commits', () => {
	const snapshot = createValidWorkbenchTableDiagnosticSnapshot(2);
	const options = createDiagnosticValidationOptions(2);
	assert.equal(validateWorkbenchTableDiagnosticSnapshot(snapshot, options), snapshot);

	const outsideHandler = structuredClone(snapshot);
	outsideHandler.commits[0].handlerEndTime = outsideHandler.commits[0].rangeIntervals[0][1] - 1;
	assert.throws(
		() => validateWorkbenchTableDiagnosticSnapshot(outsideHandler, options),
		/outside the scroll handler window/
	);

	const outsideCommit = structuredClone(snapshot);
	outsideCommit.commits[0].commitIntervals[0] = [
		outsideCommit.commits[0].handlerStartTime + 9,
		outsideCommit.commits[0].handlerEndTime
	];
	assert.throws(
		() => validateWorkbenchTableDiagnosticSnapshot(outsideCommit, options),
		/outside every commit interval/
	);

	const reused = structuredClone(snapshot);
	reused.scrollOperations[2].commitTransactionIds = [1];
	reused.scrollOperations[2].primaryCommitTransactionId = 1;
	assert.throws(() => validateWorkbenchTableDiagnosticSnapshot(reused, options), /is reused/);

	const unclaimed = structuredClone(snapshot);
	unclaimed.commits.push(createWorkbenchTableCommitTiming(3, 300));
	assert.throws(() => validateWorkbenchTableDiagnosticSnapshot(unclaimed, options), /is unclaimed/);

	const missingRange = structuredClone(snapshot);
	missingRange.commits[0].rangeIntervals = [];
	assert.throws(() => validateWorkbenchTableDiagnosticSnapshot(missingRange, options), /range are missing/);

	const reversed = structuredClone(snapshot);
	reversed.commits[1].commitIntervals[0] = [
		reversed.commits[1].handlerStartTime + 8,
		reversed.commits[1].handlerStartTime + 3
	];
	assert.throws(() => validateWorkbenchTableDiagnosticSnapshot(reversed, options), /timing is reversed/);
});

test('floor headroom profile separates the shared presentation floor from Zeus renderer work', () => {
	const profile = createSqlResultGridFloorHeadroomProfile(createFloorHeadroomReport());

	assert.equal(profile.version, 1);
	assert.equal(profile.measurementContractVersion, MEASUREMENT_CONTRACT_VERSION);
	assert.equal(profile.baselineRenderer, 'workbench-table');
	assert.equal(profile.baselineP95Ms, 20.5);
	assert.ok(Math.abs(profile.requiredZeusP95Ms - 16.4) < 1e-9);
	assert.equal(profile.sharedPresentationFloorP95Ms, 16.8);
	assert.equal(profile.mostOptimisticFloorP95Ms, 16.8);
	assert.equal(profile.floorExceedsRequiredTargetWithinTolerance, true);
	assert.equal(profile.feasibilityConclusion, 'PRESENTATION_FLOOR_LIMITED');
	assert.equal(profile.floorBoundedSuperiorityReachable, false);
	assert.ok(Math.abs(profile.maximumFloorBoundedImprovementAtMostOptimisticFloor - 0.1804878048780488) < 1e-9);
	assert.equal(profile.recordFloorP95.length, 6);
	assert.equal(profile.scrollSamples.zeus.sampleCount, 60);
	assert.equal(profile.scrollSamples.zeus.oneFrameSampleRate, 1);
	assert.deepEqual(profile.scrollSamples.zeus.presentationOpportunityHistogram, { 1: 60 });
	assert.equal(profile.zeusRendererIntervals.available, true);
	assert.equal(profile.zeusRendererIntervals.commitCount, 60);
	assert.equal(profile.zeusRendererIntervals.unionMs.p95, 6);
	assert.equal(profile.zeusRendererIntervals.componentsMs.commitPatch.p95, 3);
});

test('floor headroom profile unions nested renderer intervals instead of summing them', () => {
	const profile = createSqlResultGridFloorHeadroomProfile(createFloorHeadroomReport({ layoutInsideRange: true }));
	const intervals = profile.zeusRendererIntervals;
	const naiveSum =
		intervals.componentsMs.handler.p95 +
		intervals.componentsMs.range.p95 +
		intervals.componentsMs.layoutRead.p95 +
		intervals.componentsMs.commitPatch.p95;

	assert.equal(intervals.unionMs.p95, 6);
	assert.ok(intervals.unionMs.p95 < naiveSum);
});

test('floor headroom profile rejects partially instrumented Zeus records', () => {
	const report = createFloorHeadroomReport();
	delete report.records.find(record => record.renderer === 'zeus').diagnostics.zeusDataGrid;

	assert.throws(() => createSqlResultGridFloorHeadroomProfile(report), /cover every Zeus record or none/i);
});

test('floor headroom profile keeps floor math when Zeus internals are absent', () => {
	const profile = createSqlResultGridFloorHeadroomProfile(createFloorHeadroomReport({ withZeusDiagnostics: false }));

	assert.equal(profile.zeusRendererIntervals.available, false);
	assert.match(profile.zeusRendererIntervals.reason, /renderer interval union is unavailable/i);
	assert.equal(profile.baselineP95Ms, 20.5);
	assert.equal(profile.sharedPresentationFloorP95Ms, 16.8);
	assert.equal(profile.floorBoundedSuperiorityReachable, false);
	assert.equal(profile.scrollSamples.zeus.oneFrameSampleRate, 1);
	assert.equal(profile.rendererCpuRatio.available, false);
	assert.match(profile.rendererCpuRatio.reason, /Zeus data grid diagnostics/);
});

test('floor headroom profile computes the Zeus over WorkbenchTable CPU interval ratio from both sidecars', () => {
	const profile = createSqlResultGridFloorHeadroomProfile(createFloorHeadroomReport());

	assert.equal(profile.workbenchTableRendererIntervals.available, true);
	assert.equal(profile.workbenchTableRendererIntervals.unit, 'scroll-commit');
	assert.equal(profile.workbenchTableRendererIntervals.commitCount, 60);
	assert.equal(profile.workbenchTableRendererIntervals.unionMs.p95, 10);
	assert.equal(profile.workbenchTableRendererIntervals.componentsMs.handler.p95, 10);
	assert.equal(profile.diagnosticProfile.workbenchTableInstrumentation, WORKBENCH_TABLE_DIAGNOSTICS_INSTRUMENTATION);
	assert.equal(profile.rendererCpuRatio.available, true);
	assert.equal(profile.rendererCpuRatio.zeusUnionP95Ms, 6);
	assert.equal(profile.rendererCpuRatio.workbenchTableUnionP95Ms, 10);
	assert.equal(profile.rendererCpuRatio.ratio, 0.6);
	assert.match(profile.rendererCpuRatio.definition, /Q95\(Zeus per-scroll-commit interval union\)/);
});

test('floor headroom profile excludes preposition scroll commits from the CPU ratio', () => {
	const report = createFloorHeadroomReport({ withWorkbenchTablePrepositionCommit: true });
	for (const record of report.records.filter(record => record.renderer === 'workbench-table')) {
		const snapshot = record.diagnostics.workbenchTable;
		const prepositionTransactionId = snapshot.scrollOperations[0].commitTransactionIds[0];
		const prepositionCommit = snapshot.commits.find(commit => commit.transactionId === prepositionTransactionId);
		const start = prepositionCommit.handlerStartTime;
		prepositionCommit.handlerEndTime = start + 200;
		prepositionCommit.rangeIntervals = [[start + 1, start + 2]];
		prepositionCommit.commitIntervals = [[start + 3, start + 198]];
		prepositionCommit.layoutReadIntervals = [[start + 4, start + 5]];
	}

	const profile = createSqlResultGridFloorHeadroomProfile(report);

	assert.equal(profile.workbenchTableRendererIntervals.commitCount, 60);
	assert.equal(profile.workbenchTableRendererIntervals.unionMs.max, 10);
	assert.equal(profile.workbenchTableRendererIntervals.unionMs.p95, 10);
	assert.equal(profile.rendererCpuRatio.ratio, 0.6);
});

test('floor headroom profile rejects partially instrumented WorkbenchTable records', () => {
	const report = createFloorHeadroomReport();
	delete report.records.find(record => record.renderer === 'workbench-table').diagnostics.workbenchTable;

	assert.throws(() => createSqlResultGridFloorHeadroomProfile(report), /cover every WorkbenchTable record or none/i);
});

test('floor headroom profile keeps floor math when WorkbenchTable internals are absent', () => {
	const profile = createSqlResultGridFloorHeadroomProfile(
		createFloorHeadroomReport({ withWorkbenchTableDiagnostics: false })
	);

	assert.equal(profile.workbenchTableRendererIntervals.available, false);
	assert.match(profile.workbenchTableRendererIntervals.reason, /renderer interval union is unavailable/i);
	assert.equal(profile.rendererCpuRatio.available, false);
	assert.equal(profile.rendererCpuRatio.ratio, null);
	assert.match(profile.rendererCpuRatio.reason, /WorkbenchTable ListView diagnostics/);
	assert.equal(profile.baselineP95Ms, 20.5);
	assert.equal(profile.sharedPresentationFloorP95Ms, 16.8);
	assert.equal(profile.floorBoundedSuperiorityReachable, false);
});

test('workload CPU ratio profile computes the 1k x 20 ratio from the symmetric sidecars', () => {
	const report = createFloorHeadroomReport({ workload: FLOOR_HEADROOM_ONE_K_WORKLOAD });
	const profile = createSqlResultGridWorkloadCpuRatioProfile(report, '1k-x-20');

	assert.equal(profile.version, 1);
	assert.equal(profile.workloadId, '1k-x-20');
	assert.equal(profile.measurementContractVersion, MEASUREMENT_CONTRACT_VERSION);
	assert.deepEqual(profile.recordCounts, { total: 6, zeus: 3, workbenchTable: 3 });
	assert.equal(profile.zeusRendererIntervals.available, true);
	assert.equal(profile.zeusRendererIntervals.unionMs.p95, 6);
	assert.equal(profile.workbenchTableRendererIntervals.available, true);
	assert.equal(profile.workbenchTableRendererIntervals.unionMs.p95, 10);
	assert.equal(profile.rendererCpuRatio.available, true);
	assert.equal(profile.rendererCpuRatio.ratio, 0.6);
	assert.match(profile.limitations.join(' '), /single-run diagnostic point estimate/);
	assert.match(profile.limitations.join(' '), /not macOS WKWebView or Windows WebView2 evidence/);
});

test('workload CPU ratio profile fails closed when the workload is absent', () => {
	const report = createFloorHeadroomReport();

	assert.throws(
		() => createSqlResultGridWorkloadCpuRatioProfile(report, '1k-x-20'),
		/1k-x-20 benchmark records are missing/
	);
	assert.throws(() => createSqlResultGridWorkloadCpuRatioProfile(report, ''), /workload id is required/);
});

test('workload CPU ratio profile fails closed when a sidecar is missing', () => {
	const report = createFloorHeadroomReport({
		workload: FLOOR_HEADROOM_ONE_K_WORKLOAD,
		withZeusDiagnostics: false
	});
	const profile = createSqlResultGridWorkloadCpuRatioProfile(report, '1k-x-20');

	assert.equal(profile.rendererCpuRatio.available, false);
	assert.equal(profile.rendererCpuRatio.ratio, null);
	assert.match(profile.rendererCpuRatio.reason, /Zeus data grid diagnostics/);
});

test('workload CPU ratio profile rejects reports without diagnostic metadata or ok records', () => {
	const withoutDiagnostics = createFloorHeadroomReport({ workload: FLOOR_HEADROOM_ONE_K_WORKLOAD });
	delete withoutDiagnostics.diagnosticProfile;
	assert.throws(
		() => createSqlResultGridWorkloadCpuRatioProfile(withoutDiagnostics, '1k-x-20'),
		/diagnostic profile metadata is missing/
	);

	const withFailedRecord = createFloorHeadroomReport({ workload: FLOOR_HEADROOM_ONE_K_WORKLOAD });
	withFailedRecord.records.find(record => record.renderer === 'zeus').status = 'error';
	assert.throws(
		() => createSqlResultGridWorkloadCpuRatioProfile(withFailedRecord, '1k-x-20'),
		/benchmark record is not ok/
	);
});

test('floor headroom analyzer prints the workload-scoped CPU ratio for 1k x 20', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-floor-headroom-cli-'));
	const reportPath = join(root, 'report.json');
	try {
		await writeFile(
			reportPath,
			JSON.stringify(createFloorHeadroomReport({ workload: FLOOR_HEADROOM_ONE_K_WORKLOAD })),
			'utf8'
		);
		const { stdout } = await execFileAsync(process.execPath, [
			floorHeadroomAnalyzerScript.pathname,
			'--report',
			reportPath,
			'--workload',
			'1k-x-20'
		]);

		assert.match(stdout, /\| report\s+\| workload\s+\| Zeus union p95 \| WBT union p95 \| CPU ratio Z\/W \|/);
		assert.match(stdout, /1k-x-20/);
		assert.match(stdout, /0\.600/);
		assert.match(stdout, /6\.00ms/);
		assert.match(stdout, /10\.00ms/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('diagnostic benchmark page assigns the beta.4 observer before data and DOM connection', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-zeus-diagnostics-page-test-'));
	const page = join(root, 'benchmark.html');
	const bundle = join(root, 'data-grid-bundle.js');
	try {
		await writeFile(bundle, 'globalThis.__NYALA_TEST_ZEUS_BUNDLE__ = true;\n', 'utf8');
		await execFileAsync(
			process.execPath,
			[
				benchmarkScript.pathname,
				'--diagnostic-profile',
				'true',
				'--repeat',
				'3',
				'--workload',
				'10k-x-50',
				'--renderer',
				'workbench-table,zeus',
				'--zeus-bundle',
				bundle,
				'--emit-page',
				page
			],
			{ timeout: 5_000 }
		);
		const source = await readFile(page, 'utf8');
		const diagnosticsAssignment = source.indexOf('grid.diagnostics = zeusDiagnostics.observer');
		assert.ok(diagnosticsAssignment > 0);
		assert.ok(diagnosticsAssignment < source.indexOf('grid.columns ='));
		assert.ok(diagnosticsAssignment < source.indexOf('grid.rows ='));
		assert.ok(diagnosticsAssignment < source.indexOf('root.append(grid)'));
		assert.match(source, /validateZeusDataGridDiagnosticSnapshot/);
		assert.match(source, /zeusDataGrid/);
		assert.match(source, /const measureNodeChurn = params\.get\('measureNodeChurn'\)/);
		assert.match(source, /measureNodeChurn === 'false' \? \{ measureNodeChurn: false \} : undefined/);
		assert.match(source, /measureNodeChurn: segmentTrace \|\| \(diagnosticProfile && measureNodeChurn !== 'false'\)/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('benchmark CLI records the Zeus node-churn A/B arm in diagnostic metadata', async () => {
	const source = await import('node:fs/promises').then(fs =>
		fs.readFile(new URL('./benchmark-sql-result-grid.mjs', import.meta.url), 'utf8')
	);
	assert.match(source, /--zeus-measure-node-churn <bool>/);
	assert.match(source, /zeusMeasureNodeChurn = parseBoolean\(cli\['zeus-measure-node-churn'\]/);
	assert.match(source, /measureNodeChurn: zeusMeasureNodeChurn/);
	assert.match(source, /measureNodeChurn: String\(measureNodeChurn\)/);
	assert.match(source, /traceProfile = parseBoolean\(cli\['trace-profile'\]/);
	assert.match(source, /traceProfile: String\(traceProfile\)/);
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

function createModelBuildTiming(rowCount = 10_000, columnCount = 50) {
	return {
		sequence: 1,
		modelVersion: 1,
		startTime: 1,
		endTime: 2,
		rowCount,
		columnCount,
		visibleColumnCount: columnCount,
		sortActive: false,
		rowModelReused: true,
		rowIndexEntryCount: rowCount,
		eagerRowWrapperAllocationCount: 0
	};
}

function createCommitTiming(transactionId, source = 'scroll') {
	const start = transactionId * 10;
	return {
		transactionId,
		source,
		inputTime: start - 1,
		handlerStartTime: start,
		handlerEndTime: start + 1,
		rangeStartTime: start + 2,
		rangeCalculatedTime: start + 4,
		commitStartTime: start + 5,
		commitEndTime: start + 8,
		layoutReadIntervals: [[start + 2, start + 3]],
		firstRowIndex: transactionId * 10,
		lastRowIndex: transactionId * 10 + 15,
		firstColumnIndex: 0,
		lastColumnIndex: 12,
		createdNodeCount: 16,
		removedNodeCount: 16,
		rowWrapperAllocationCount: 16
	};
}

function createValidZeusDiagnosticSnapshot(sampleCount) {
	const commits = Array.from({ length: sampleCount }, (_, index) => createCommitTiming(index + 1));
	return {
		version: ZEUS_DATA_GRID_DIAGNOSTICS_VERSION,
		timingClock: 'performance-now',
		inputTimeClock: 'raw-event-timestamp',
		correlation: ZEUS_DATA_GRID_DIAGNOSTICS_CORRELATION,
		modelBuilds: [createModelBuildTiming()],
		commits,
		scrollOperations: [
			{
				phase: 'preposition',
				sampleIndex: null,
				commitTransactionIds: [],
				primaryCommitTransactionId: null
			},
			...Array.from({ length: sampleCount }, (_, sampleIndex) => ({
				phase: 'sample',
				sampleIndex,
				commitTransactionIds: [sampleIndex + 1],
				primaryCommitTransactionId: sampleIndex + 1
			})),
			{
				phase: 'reset',
				sampleIndex: null,
				commitTransactionIds: [],
				primaryCommitTransactionId: null
			}
		]
	};
}

function createDiagnosticValidationOptions(sampleCount) {
	return {
		expectedSampleCount: sampleCount,
		workload: { rows: 10_000, columns: 50 },
		scrollSamples: Array.from({ length: sampleCount }, (_, sampleIndex) => ({
			sampleIndex,
			visibleRowIndex: (sampleIndex + 1) * 10,
			expectedRowIndex: (sampleIndex + 1) * 10
		}))
	};
}

function createWorkbenchTableCommitTiming(transactionId, firstRowIndex) {
	const handlerStartTime = transactionId * 100;
	return {
		transactionId,
		source: 'scroll',
		handlerStartTime,
		handlerEndTime: handlerStartTime + 10,
		rangeIntervals: [[handlerStartTime + 1, handlerStartTime + 2]],
		commitIntervals: [[handlerStartTime + 3, handlerStartTime + 8]],
		layoutReadIntervals: [[handlerStartTime + 4, handlerStartTime + 5]],
		firstRowIndex,
		lastRowIndex: firstRowIndex + 200
	};
}

function createValidWorkbenchTableDiagnosticSnapshot(sampleCount, options = {}) {
	const firstRowIndexAt = options.firstRowIndexAt ?? (sampleIndex => (sampleIndex + 1) * 10);
	const withPrepositionCommit = options.withPrepositionCommit === true;
	const transactionOffset = withPrepositionCommit ? 1 : 0;
	return {
		version: WORKBENCH_TABLE_DIAGNOSTICS_VERSION,
		timingClock: 'performance-now',
		correlation: WORKBENCH_TABLE_DIAGNOSTICS_CORRELATION,
		instrumentation: WORKBENCH_TABLE_DIAGNOSTICS_INSTRUMENTATION,
		commits: [
			...(withPrepositionCommit ? [createWorkbenchTableCommitTiming(1, firstRowIndexAt(0))] : []),
			...Array.from({ length: sampleCount }, (_, sampleIndex) =>
				createWorkbenchTableCommitTiming(sampleIndex + 1 + transactionOffset, firstRowIndexAt(sampleIndex))
			)
		],
		scrollOperations: [
			{
				phase: 'preposition',
				sampleIndex: null,
				commitTransactionIds: withPrepositionCommit ? [1] : [],
				primaryCommitTransactionId: withPrepositionCommit ? 1 : null
			},
			...Array.from({ length: sampleCount }, (_, sampleIndex) => ({
				phase: 'sample',
				sampleIndex,
				commitTransactionIds: [sampleIndex + 1 + transactionOffset],
				primaryCommitTransactionId: sampleIndex + 1 + transactionOffset
			})),
			{
				phase: 'reset',
				sampleIndex: null,
				commitTransactionIds: [],
				primaryCommitTransactionId: null
			}
		]
	};
}

const FLOOR_HEADROOM_WORKLOAD = Object.freeze({
	id: '10k-x-50',
	rows: 10_000,
	columns: 50,
	width: 1_440,
	height: 420,
	wide: false
});

const FLOOR_HEADROOM_ONE_K_WORKLOAD = Object.freeze({
	id: '1k-x-20',
	rows: 1_000,
	columns: 20,
	width: 1_440,
	height: 420,
	wide: false
});

function floorHeadroomRowIndexAt(sampleIndex, rowCount) {
	return Math.min(rowCount - 11, Math.floor(((sampleIndex + 1) * rowCount) / 21) + 5);
}

function createFloorHeadroomReport(options = {}) {
	const repeat = options.repeat ?? 3;
	const workload = options.workload ?? FLOOR_HEADROOM_WORKLOAD;
	const renderers = ['workbench-table', 'zeus'];
	const plan = createBalancedBenchmarkPlan([workload], renderers, repeat);
	const records = plan.map(entry =>
		createFloorHeadroomRecord({
			entry,
			floorP95Ms: options.floorP95Ms ?? 16.8,
			scrollP95Ms: entry.renderer === 'zeus' ? (options.zeusP95Ms ?? 18.2) : (options.baselineP95Ms ?? 20.5),
			withZeusDiagnostics: options.withZeusDiagnostics !== false,
			withWorkbenchTableDiagnostics: options.withWorkbenchTableDiagnostics !== false,
			withWorkbenchTablePrepositionCommit: options.withWorkbenchTablePrepositionCommit === true,
			layoutInsideRange: options.layoutInsideRange === true
		})
	);
	return {
		version: 1,
		measurementContractVersion: MEASUREMENT_CONTRACT_VERSION,
		scrollCommitBoundary: SCROLL_COMMIT_BOUNDARY,
		executionOrder: EXECUTION_ORDER,
		generatedAt: '2026-09-17T00:00:00.000Z',
		repeat,
		workloads: [workload],
		renderers,
		records,
		diagnosticProfile: {
			version: 1,
			presentationFloorSampleCount: 20,
			zeusDataGridDiagnostics: {
				version: ZEUS_DATA_GRID_DIAGNOSTICS_VERSION,
				correlation: ZEUS_DATA_GRID_DIAGNOSTICS_CORRELATION,
				instrumented: true,
				measureNodeChurn: true
			},
			workbenchTableDiagnostics: {
				version: WORKBENCH_TABLE_DIAGNOSTICS_VERSION,
				correlation: WORKBENCH_TABLE_DIAGNOSTICS_CORRELATION,
				instrumentation: WORKBENCH_TABLE_DIAGNOSTICS_INSTRUMENTATION,
				instrumented: true
			}
		},
		limitations: []
	};
}

function createFloorHeadroomRecord({
	entry,
	floorP95Ms,
	scrollP95Ms,
	withZeusDiagnostics,
	withWorkbenchTableDiagnostics,
	withWorkbenchTablePrepositionCommit,
	layoutInsideRange
}) {
	const sampleCount = 20;
	const samples = Array.from({ length: sampleCount }, (_, sampleIndex) => {
		const rowIndex = floorHeadroomRowIndexAt(sampleIndex, entry.workload.rows);
		return {
			sampleIndex,
			visibleRowIndex: rowIndex,
			expectedRowIndex: rowIndex,
			presentationOpportunities: 1,
			presentationWaitMs: Math.max(0, floorP95Ms - 0.4)
		};
	});
	const record = {
		runToken: `${entry.renderer}-${entry.iteration}`,
		renderer: entry.renderer,
		measurementContractVersion: MEASUREMENT_CONTRACT_VERSION,
		scrollCommitBoundary: SCROLL_COMMIT_BOUNDARY,
		executionOrder: EXECUTION_ORDER,
		executionOrdinal: entry.executionOrdinal,
		workload: { rows: entry.workload.rows, columns: entry.workload.columns },
		workloadId: entry.workload.id,
		iteration: entry.iteration,
		status: 'ok',
		scroll: { p95Ms: scrollP95Ms, maxMs: scrollP95Ms + 0.5, samples },
		diagnostics: {
			presentationFloor: {
				sampleCount,
				medianMs: floorP95Ms,
				p95Ms: floorP95Ms,
				maxMs: floorP95Ms,
				samples: Array.from({ length: sampleCount }, (_, sampleIndex) => ({ sampleIndex, totalMs: floorP95Ms }))
			}
		}
	};
	if (entry.renderer === 'zeus' && withZeusDiagnostics) {
		record.diagnostics.zeusDataGrid = createFloorHeadroomSnapshot(sampleCount, {
			layoutInsideRange,
			workload: entry.workload
		});
	}
	if (entry.renderer === 'workbench-table' && withWorkbenchTableDiagnostics) {
		record.diagnostics.workbenchTable = createValidWorkbenchTableDiagnosticSnapshot(sampleCount, {
			withPrepositionCommit: withWorkbenchTablePrepositionCommit,
			firstRowIndexAt: sampleIndex =>
				Math.max(0, Math.min(floorHeadroomRowIndexAt(sampleIndex, entry.workload.rows) - 5, entry.workload.rows - 201))
		});
	}
	return record;
}

function createFloorHeadroomSnapshot(sampleCount, options = {}) {
	const workload = options.workload ?? FLOOR_HEADROOM_WORKLOAD;
	const modelBuild = createModelBuildTiming(workload.rows, workload.columns);
	const commits = [
		{
			transactionId: 1,
			source: 'mount',
			handlerStartTime: 0,
			handlerEndTime: 0.5,
			rangeStartTime: 1,
			rangeCalculatedTime: 2,
			commitStartTime: 3,
			commitEndTime: 4,
			layoutReadIntervals: [[1, 1.5]],
			firstRowIndex: 0,
			lastRowIndex: 20,
			firstColumnIndex: 0,
			lastColumnIndex: 12,
			createdNodeCount: 20,
			removedNodeCount: 0,
			rowWrapperAllocationCount: 20
		},
		...Array.from({ length: sampleCount }, (_, index) => createFloorHeadroomScrollCommit(index + 2, options))
	];
	return {
		version: ZEUS_DATA_GRID_DIAGNOSTICS_VERSION,
		timingClock: 'performance-now',
		inputTimeClock: 'raw-event-timestamp',
		correlation: ZEUS_DATA_GRID_DIAGNOSTICS_CORRELATION,
		modelBuilds: [modelBuild],
		commits,
		scrollOperations: [
			{
				phase: 'preposition',
				sampleIndex: null,
				commitTransactionIds: [],
				primaryCommitTransactionId: null
			},
			...Array.from({ length: sampleCount }, (_, sampleIndex) => ({
				phase: 'sample',
				sampleIndex,
				commitTransactionIds: [sampleIndex + 2],
				primaryCommitTransactionId: sampleIndex + 2
			})),
			{
				phase: 'reset',
				sampleIndex: null,
				commitTransactionIds: [],
				primaryCommitTransactionId: null
			}
		]
	};
}

function createFloorHeadroomScrollCommit(transactionId, options) {
	const base = transactionId * 1_000;
	const workload = options.workload ?? FLOOR_HEADROOM_WORKLOAD;
	const rowIndex = floorHeadroomRowIndexAt(transactionId - 2, workload.rows);
	return {
		transactionId,
		source: 'scroll',
		inputTime: base,
		handlerStartTime: base + 1,
		handlerEndTime: base + 2,
		rangeStartTime: base + 2,
		rangeCalculatedTime: base + 4,
		commitStartTime: base + 5,
		commitEndTime: base + 8,
		layoutReadIntervals: options.layoutInsideRange ? [[base + 2, base + 3]] : [[base + 3.5, base + 4]],
		firstRowIndex: rowIndex - 5,
		lastRowIndex: rowIndex + 5,
		firstColumnIndex: 0,
		lastColumnIndex: 12,
		createdNodeCount: 16,
		removedNodeCount: 16,
		rowWrapperAllocationCount: 16
	};
}
