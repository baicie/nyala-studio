import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
	applyWindowRectAndObserveCssViewport,
	createEmbeddedWebdriverSession,
	evaluateViaDirectEval,
	identifyEmbeddedWebview,
	parseLoopbackDriverUrl,
	wrapDirectEvalExpression,
	webdriverRequest
} from './tauri-embedded-webdriver.mjs';
import {
	EXECUTION_ORDER,
	MEASUREMENT_CONTRACT_VERSION,
	SCROLL_COMMIT_BOUNDARY
} from './sql-result-grid-benchmark-contract.mjs';
import { createSqlResultGridResultChannel } from './sql-result-grid-result-channel.mjs';

const execFileAsync = promisify(execFile);

test('WebDriver benchmark runner records platform evidence and screenshots', async () => {
	const source = await import('node:fs/promises').then(fs =>
		fs.readFile(new URL('./benchmark-sql-result-grid-webdriver.mjs', import.meta.url), 'utf8')
	);
	const resultChannelSource = await import('node:fs/promises').then(fs =>
		fs.readFile(new URL('./sql-result-grid-result-channel.mjs', import.meta.url), 'utf8')
	);
	assert.match(source, /--app-binary/);
	assert.match(source, /createEmbeddedWebdriverSession/);
	assert.match(source, /identifyEmbeddedWebview/);
	assert.match(source, /serveBenchmarkPage/);
	assert.match(source, /resultEndpoint/);
	assert.match(source, /benchmark-result/);
	assert.match(source, /resultChannel\?\.readResult/);
	assert.match(source, /segmentTraceError/);
	assert.match(source, /matching error is terminal/);
	assert.match(source, /isBenchmarkResultForRun\(result, expected\)/);
	assert.match(source, /status !== 'ok'/);
	assert.match(source, /text === undefined && \(embedded \|\| !resultChannel\)/);
	assert.match(resultChannelSource, /result payload exceeds 2 MiB/);
	assert.match(source, /server\.listen\(0, '127\.0\.0\.1'/);
	assert.doesNotMatch(source, /pathToFileURL/);
	assert.match(source, /waitForNavigation/);
	assert.match(source, /setSessionTimeouts/);
	assert.match(source, /script-timeout-ms/);
	assert.match(source, /evaluateViaDirectEval/);
	assert.match(source, /readBenchmarkResultViaDirectEval/);
	// A hung WebView must not consume one full script budget per poll
	// iteration, otherwise a single stuck run stalls the platform jobs for
	// hours instead of failing against the run deadline.
	assert.match(source, /RESULT_POLL_EVAL_TIMEOUT_MS/);
	assert.match(source, /sleepWithinDeadline/);
	assert.match(source, /run-budget-ms/);
	assert.match(source, /Platform run exceeded its/);
	// Viewport observation is a trivial evaluation and must not consume the
	// full script budget on every calibration attempt.
	assert.match(source, /OBSERVE_EVAL_TIMEOUT_MS/);
	assert.match(source, /\{ timeoutMs: OBSERVE_EVAL_TIMEOUT_MS \}/);
	// A result posted to the channel must be given time to arrive before the
	// runner falls back to a blocking embedded eval.
	assert.match(source, /RESULT_CHANNEL_GRACE_MS/);
	assert.match(source, /Date\.now\(\) < channelDeadline/);
	assert.match(source, /timeoutMs: Math\.max\(1, Math\.min\(remainingMs, RESULT_POLL_EVAL_TIMEOUT_MS\)\)/);
	assert.doesNotMatch(source, /executeSyncScript/);
	assert.match(source, /Nyala SQL result grid benchmark/);
	assert.match(source, /validateVisualProbe/);
	assert.match(source, /firstVisibleCellText/);
	assert.match(source, /firstCellInViewport/);
	assert.match(source, /virtualRowsBounded/);
	assert.match(source, /outerDocumentOverflowFree/);
	assert.match(source, /runMarkerAnchored/);
	assert.match(source, /screenshot/);
	assert.match(source, /inspectPngPixels/);
	assert.match(source, /hasVisiblePngDiversity/);
	assert.match(source, /scrollP95Ms/);
	assert.match(source, /median/);
	assert.match(source, /p95/);
	assert.match(source, /--source-revision/);
	assert.match(source, /binarySha256/);
	assert.match(source, /zeusBundleSha256/);
	assert.match(source, /provenance/);
	assert.equal(MEASUREMENT_CONTRACT_VERSION, 7);
	// v7 platform records must request the presentation floor without paying for
	// renderer observers, because observer cost would bias scrollP95Ms. That is
	// the default; --instrument-baseline opts out to capture baseline commit work.
	assert.match(source, /floorOnly:\s*String\(!instrumentBaseline\)/);
	assert.match(source, /const instrumentBaseline = String\(cli\['instrument-baseline'\]/);
	// An instrumented run must declare itself inadmissible so a diagnostic run
	// can never be mistaken for v7 admission evidence.
	assert.match(source, /admissionGrade:\s*!instrumentBaseline/);
	// The gate recomputes the summary from raw records and compares it with
	// isDeepStrictEqual, so the producer must aggregate presentationFloorP95Ms
	// with exactly the same shape or every platform run fails summary integrity.
	assert.match(
		source,
		/presentationFloorP95Ms:\s*summarizeMetric\(\s*group\.map\(record => record\.diagnostics\?\.presentationFloor\?\.p95Ms\)/
	);
	assert.equal(SCROLL_COMMIT_BOUNDARY, 'post-presentation-opportunity');
	assert.equal(EXECUTION_ORDER, 'renderer-balanced-rotation-v1');
	assert.match(source, /measurementContractVersion:\s*MEASUREMENT_CONTRACT_VERSION/);
	assert.match(source, /scrollCommitBoundary:\s*SCROLL_COMMIT_BOUNDARY/);
	assert.match(source, /executionOrder:\s*EXECUTION_ORDER/);
	assert.match(source, /createBalancedBenchmarkPlan/);
	assert.match(source, /executionOrdinal/);
	assert.match(source, /convergeWindowRectForCssViewport/);
	assert.match(source, /await resetPageForViewportCalibration\(driverUrl, sessionId, Boolean\(appBinary\)\)/);
	assert.match(
		source,
		/await waitForNavigation\(driverUrl, sessionId, url\);[\s\S]*?const viewportCalibration = await calibrateCssViewport/
	);
	assert.match(source, /deferStart: 'true'/);
	assert.match(source, /await startDeferredBenchmark\(driverUrl, sessionId, Boolean\(appBinary\)\)/);
	assert.match(source, /window\.dispatchEvent\(new Event\('nyala-benchmark-start'\)\), true/);
	assert.match(source, /hasBenchmarkResult: Boolean\(document\.querySelector\("#benchmark-result"\)\)/);
	assert.match(
		source,
		/if \(embedded\) \{\s*const urlPayload = await webdriverRequest\(baseUrl, `\/session\/\$\{sessionId\}\/url`\)/s
	);
	assert.match(source, /readCssViewport/);
	assert.match(source, /applyWindowRectAndObserveCssViewport/);
	assert.match(source, /settleMs: 250/);
	assert.match(source, /viewportCalibration/);
	assert.match(source, /devicePixelRatio/);
	assert.match(source, /randomUUID/);
	assert.match(source, /runToken/);
	assert.doesNotMatch(source, /window\/rect[^\n]*\.catch/);
	assert.match(source, /sha256: createHash\('sha256'\)/);
	assert.match(source, /screenshots\.push\(\.\.\.attemptScreenshots\)/);
	// A host that misses a presentation opportunity inside the per-sample budget
	// must not discard the other 59 records. The scheduled slot is re-run with
	// the same execution ordinal until it yields a usable record, and every
	// retry stays visible in the evidence so readers can see how much retrying a
	// platform needed.
	assert.match(source, /maxRoundAttempts/);
	assert.match(source, /--max-round-attempts/);
	assert.match(source, /enriched\.status !== 'ok' && attempt < maxRoundAttempts/);
	assert.match(source, /retriedRounds\.push\(\{/);
	assert.match(source, /roundAttempts: attempt/);
	assert.match(source, /retriedRounds/);
	// A retried slot must not leave the discarded attempt's screenshot behind:
	// the gate requires exactly 12 manifest entries and each one must match the
	// run token of the record that was actually kept.
	assert.match(source, /discardedScreenshotFiles/);
	assert.match(source, /removeStaleAttemptScreenshots/);
	assert.match(source, /delete enriched\.screenshot/);
	assert.match(source, /discarded: attemptFailures/);
	// Retries spend the same budget as first attempts, so the platform run
	// budget has to be re-checked inside the retry loop.
	assert.match(source, /budget while retrying/);
	// The extracted round helper must receive the scheduled slot explicitly. A
	// nested declaration cannot see the loop bindings, and an undefined renderer
	// reads like a flaky host instead of a runner bug.
	assert.match(source, /runBenchmarkRound\(\{ workload, renderer, iteration, executionOrdinal \}\)/);
	assert.match(source, /async function runBenchmarkRound\(\{ workload, renderer, iteration, executionOrdinal \}\)/);
});

test('benchmark page posts completed results to the runner channel', async () => {
	const source = await import('node:fs/promises').then(fs =>
		fs.readFile(new URL('./benchmark-sql-result-grid.mjs', import.meta.url), 'utf8')
	);
	assert.match(source, /const resultEndpoint = params\.get\('resultEndpoint'\)/);
	assert.match(source, /fetch\(resultEndpoint, \{/);
	assert.match(source, /method: 'POST'/);
	assert.doesNotMatch(source, /keepalive: true/);
});

test('result channel accepts, validates, and consumes one result per token', async () => {
	const channel = createSqlResultGridResultChannel();
	const server = createServer((request, response) => {
		if (!channel.handle(request, response)) response.writeHead(404).end();
	});
	await new Promise((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', rejectListen);
			resolveListen();
		});
	});
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	const url = `http://127.0.0.1:${address.port}/benchmark-result`;
	try {
		const payload = { runToken: 'run-1', status: 'ok', renderer: 'native' };
		const accepted = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload)
		});
		assert.equal(accepted.status, 204);
		assert.deepEqual(channel.readResult('run-1'), payload);
		assert.equal(channel.readResult('run-1'), undefined);

		const missingToken = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ status: 'ok' })
		});
		assert.equal(missingToken.status, 400);

		const oversized = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ runToken: 'too-large', value: 'x'.repeat(2 * 1024 * 1024) })
		});
		assert.equal(oversized.status, 400);
		assert.equal(channel.readResult('too-large'), undefined);
	} finally {
		server.closeAllConnections();
		await new Promise(resolveClose => server.close(resolveClose));
	}
});

test('CSS viewport observation waits for the native resize to settle', async () => {
	let viewport = { width: 1424, height: 412 };
	const calls = [];
	const observation = await applyWindowRectAndObserveCssViewport(
		{ width: 1456, height: 428 },
		{
			applyWindowRect: async requestedWindowRect => {
				calls.push(['apply', requestedWindowRect]);
				return requestedWindowRect;
			},
			wait: async milliseconds => {
				calls.push(['settle', milliseconds]);
				viewport = { width: 1440, height: 420 };
			},
			observeCssViewport: async () => {
				calls.push(['observe', viewport]);
				return viewport;
			},
			settleMs: 250
		}
	);

	assert.deepEqual(calls, [
		['apply', { width: 1456, height: 428 }],
		['settle', 250],
		['observe', { width: 1440, height: 420 }]
	]);
	assert.deepEqual(observation, {
		appliedWindowRect: { width: 1456, height: 428 },
		observedCssViewport: { width: 1440, height: 420 }
	});
});

test('embedded direct eval executes the deferred benchmark start as one expression', () => {
	const expression = "window.dispatchEvent(new Event('nyala-benchmark-start')), true";
	const callbacks = [];
	const dispatched = [];
	const execute = new Function('window', 'Event', wrapDirectEvalExpression(expression));
	class TestEvent {
		constructor(type) {
			this.type = type;
		}
	}

	execute({ dispatchEvent: event => dispatched.push(event.type) }, TestEvent, payload => callbacks.push(payload));

	assert.deepEqual(dispatched, ['nyala-benchmark-start']);
	assert.deepEqual(callbacks, [{ ok: true, value: true }]);
	assert.throws(
		() => wrapDirectEvalExpression("window.dispatchEvent(new Event('nyala-benchmark-start')); true"),
		/valid JavaScript expression/
	);
});

test('embedded direct eval reports expression failures through its callback', () => {
	const callbacks = [];
	const execute = new Function(wrapDirectEvalExpression('(() => { throw new Error("direct-eval-boom") })()'));
	execute(payload => callbacks.push(payload));
	assert.deepEqual(callbacks, [{ ok: false, error: 'Error: direct-eval-boom' }]);
});

test('embedded direct eval sends a bounded request to the main window', async () => {
	let requestBody;
	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		assert.equal(request.method, 'POST');
		assert.equal(request.url, '/wdio/eval');
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({ value: 'direct-eval-result' }));
	});
	await new Promise((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', rejectListen);
			resolveListen();
		});
	});
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	try {
		const result = await evaluateViaDirectEval(
			`http://127.0.0.1:${address.port}`,
			"document.querySelector('#benchmark-result')?.textContent || ''",
			{ timeoutMs: 1_234 }
		);
		assert.equal(result, 'direct-eval-result');
		assert.equal(requestBody.window_label, 'main');
		assert.equal(requestBody.timeout_ms, 1_234);
		assert.equal(
			requestBody.script,
			wrapDirectEvalExpression("document.querySelector('#benchmark-result')?.textContent || ''")
		);
	} finally {
		server.closeAllConnections();
		await new Promise(resolveClose => server.close(resolveClose));
	}
});

test('embedded WebDriver session creation waits for the native main window', async () => {
	let attempts = 0;
	const server = createServer((request, response) => {
		if (request.method !== 'POST' || request.url !== '/session') {
			response.writeHead(404).end();
			return;
		}
		attempts += 1;
		response.setHeader('content-type', 'application/json');
		if (attempts < 3) {
			response.writeHead(500).end(JSON.stringify({ value: { error: 'no such window', message: 'main is not ready' } }));
			return;
		}
		response.writeHead(200).end(
			JSON.stringify({
				value: {
					sessionId: 'session-1',
					capabilities: { platformName: 'macos', browserName: 'webkit' }
				}
			})
		);
	});
	await new Promise((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', rejectListen);
			resolveListen();
		});
	});
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	try {
		const session = await createEmbeddedWebdriverSession(`http://127.0.0.1:${address.port}`, {
			timeoutMs: 1_000,
			retryDelayMs: 5
		});
		assert.equal(session.sessionId, 'session-1');
		assert.equal(attempts, 3);
	} finally {
		server.closeAllConnections();
		await new Promise(resolveClose => server.close(resolveClose));
	}
});

test('embedded WebDriver identity accepts only the matching native WebView', () => {
	const macos = identifyEmbeddedWebview(
		{ platformName: 'macos', browserName: 'webkit', browserVersion: '620.1' },
		'macos',
		'darwin'
	);
	assert.equal(macos.engine, 'wkwebview-embedded');
	assert.equal(macos.nativeWebView, true);
	assert.equal(macos.nativeWebView2, false);

	const windows = identifyEmbeddedWebview(
		{ platformName: 'windows', browserName: 'msedge', browserVersion: '140.0' },
		'windows',
		'win32'
	);
	assert.equal(windows.engine, 'webview2-embedded');
	assert.equal(windows.nativeWebView2, true);

	assert.throws(
		() => identifyEmbeddedWebview({ platformName: 'windows', browserName: 'chrome' }, 'windows', 'win32'),
		/expected windows\/msedge/
	);
	assert.throws(
		() => identifyEmbeddedWebview({ platformName: 'macos', browserName: 'webkit' }, 'macos', 'linux'),
		/cannot run on linux/
	);
});

test('embedded WebDriver endpoint is restricted to loopback HTTP', () => {
	assert.equal(parseLoopbackDriverUrl('http://127.0.0.1:4445').port, '4445');
	assert.throws(() => parseLoopbackDriverUrl('https://127.0.0.1:4445'), /loopback/);
	assert.throws(() => parseLoopbackDriverUrl('http://example.com:4445'), /loopback/);
});

test('WebDriver requests abort within their bounded transport budget', async () => {
	const server = createServer(() => undefined);
	await new Promise((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', rejectListen);
			resolveListen();
		});
	});
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	const startedAt = Date.now();
	try {
		await assert.rejects(
			webdriverRequest(`http://127.0.0.1:${address.port}`, '/status', 'GET', undefined, { timeoutMs: 50 }),
			/GET \/status request failed \(timeout 50ms\)/
		);
		assert.ok(Date.now() - startedAt < 1_000, 'request should not outlive its bounded transport budget');
	} finally {
		server.closeAllConnections();
		await new Promise(resolveClose => server.close(resolveClose));
	}
});

test('embedded launch failure writes a blocked manifest', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-embedded-webdriver-test-'));
	try {
		const output = join(root, 'evidence.json');
		await assert.rejects(
			execFileAsync(process.execPath, [
				'scripts/benchmark-sql-result-grid-webdriver.mjs',
				'--app-binary',
				join(root, 'missing-nyala'),
				'--platform',
				process.platform === 'win32' ? 'windows' : 'macos',
				'--renderer',
				'native',
				'--workload',
				'narrow-panel',
				'--repeat',
				'1',
				'--output',
				output,
				'--screenshot-dir',
				join(root, 'screenshots')
			])
		);
		const report = JSON.parse(await readFile(output, 'utf8'));
		assert.equal(report.status, 'blocked');
		assert.equal(report.measurementContractVersion, MEASUREMENT_CONTRACT_VERSION);
		assert.equal(report.scrollCommitBoundary, SCROLL_COMMIT_BOUNDARY);
		assert.equal(report.executionOrder, EXECUTION_ORDER);
		assert.equal(report.runs, 0);
		assert.equal(report.driverProvider, 'embedded');
		assert.equal(report.nativeWebView, false);
		assert.match(report.reason, /ENOENT|spawn/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

for (const { name, expectedAttempts, navigationDelayMs, runBudgetMs } of [
	{ name: 'exhausted navigation retries', expectedAttempts: 3, navigationDelayMs: 0, runBudgetMs: 1800000 },
	{ name: 'budget-exhausted navigation retries', expectedAttempts: 1, navigationDelayMs: 400, runBudgetMs: 200 }
])
	test(`${name} remain in the blocked evidence`, async () => {
		const root = await mkdtemp(join(tmpdir(), 'nyala-webdriver-retries-test-'));
		let navigationAttempts = 0;
		const server = createServer((request, response) => {
			response.setHeader('content-type', 'application/json');
			if (request.method === 'POST' && request.url === '/session') {
				response.end(JSON.stringify({ value: { sessionId: 'stalled-session' } }));
			} else if (request.method === 'POST' && request.url === '/session/stalled-session/url') {
				navigationAttempts += 1;
				setTimeout(
					() =>
						response.writeHead(500).end(JSON.stringify({ value: { error: 'timeout', message: 'navigation stalled' } })),
					navigationDelayMs
				);
			} else {
				response.end(JSON.stringify({ value: null }));
			}
		});
		await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
		try {
			const output = join(root, 'evidence.json');
			await assert.rejects(
				execFileAsync(process.execPath, [
					'scripts/benchmark-sql-result-grid-webdriver.mjs',
					'--browser',
					'safari',
					'--driver-url',
					`http://127.0.0.1:${server.address().port}`,
					'--renderer',
					'native',
					'--workload',
					'narrow-panel',
					'--repeat',
					'1',
					'--max-round-attempts',
					'3',
					'--run-budget-ms',
					String(runBudgetMs),
					'--output',
					output,
					'--screenshot-dir',
					join(root, 'screenshots')
				])
			);
			const report = JSON.parse(await readFile(output, 'utf8'));
			assert.equal(navigationAttempts, expectedAttempts);
			assert.equal(report.status, 'blocked');
			assert.equal(report.runs, 0);
			assert.deepEqual(report.records, []);
			assert.equal(report.retriedRounds.length, 1);
			const retry = report.retriedRounds[0];
			assert.equal(retry.workloadId, 'narrow-panel');
			assert.equal(retry.renderer, 'native');
			assert.equal(retry.iteration, 1);
			assert.equal(retry.executionOrdinal, 1);
			assert.equal(retry.attempts, expectedAttempts);
			assert.equal(retry.discarded.length, expectedAttempts);
			for (const reason of retry.discarded) assert.match(reason, /navigation stalled/);
			if (navigationDelayMs > runBudgetMs) assert.match(report.reason, /budget while retrying/);
		} finally {
			server.closeAllConnections();
			await new Promise(resolveClose => server.close(resolveClose));
			await rm(root, { recursive: true, force: true });
		}
	});

test('repeated navigation timeouts recycle the WebDriver session', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-webdriver-recycle-test-'));
	const navigationTimeoutMs = 300;
	let issuedSessions = 0;
	let deletedSessions = 0;
	let currentSession = null;
	let navigationsOnCurrentSession = 0;
	const server = createServer((request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.method === 'POST' && request.url === '/session') {
			issuedSessions += 1;
			currentSession = `session-${issuedSessions}`;
			response.end(JSON.stringify({ value: { sessionId: currentSession } }));
		} else if (request.method === 'DELETE' && request.url.startsWith('/session/')) {
			deletedSessions += 1;
			response.end(JSON.stringify({ value: null }));
		} else if (request.method === 'POST' && /^\/session\/[^/]+\/url$/.test(request.url)) {
			navigationsOnCurrentSession += 1;
			// The first session stalls on every navigation, the way a WebView
			// degrades after a very large DOM. Later sessions stall once and then
			// recover, so the run can finish on the recycled session.
			if (issuedSessions === 1 || navigationsOnCurrentSession === 1) {
				// Expire the way a real stalled navigation does: hold the response
				// past the client deadline so the client aborts on its own timeout.
				setTimeout(() => {
					if (!response.writableEnded) response.writeHead(503).end();
				}, navigationTimeoutMs * 2);
				return;
			}
			response.end(JSON.stringify({ value: null }));
		} else {
			response.end(JSON.stringify({ value: null }));
		}
	});
	await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
	try {
		await assert.rejects(
			execFileAsync(process.execPath, [
				'scripts/benchmark-sql-result-grid-webdriver.mjs',
				'--browser',
				'safari',
				'--driver-url',
				`http://127.0.0.1:${server.address().port}`,
				'--renderer',
				'native',
				'--workload',
				'narrow-panel',
				'--repeat',
				'1',
				'--max-round-attempts',
				'3',
				'--navigation-timeout-ms',
				String(navigationTimeoutMs),
				'--output',
				join(root, 'evidence.json'),
				'--screenshot-dir',
				join(root, 'screenshots')
			])
		);
		// The stalled session must be deleted and a fresh one opened, otherwise
		// every remaining attempt would be spent on a WebView that no longer
		// answers.
		assert.ok(
			issuedSessions >= 2,
			`expected a new session, saw ${issuedSessions}`
		);
		assert.ok(deletedSessions >= 1, `expected the stalled session to be deleted, saw ${deletedSessions}`);
	} finally {
		server.closeAllConnections();
		await new Promise(resolveClose => server.close(resolveClose));
		await rm(root, { recursive: true, force: true });
	}
});

test('Chromium benchmark emits a reusable page without outer document scrollbars', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-benchmark-page-test-'));
	try {
		const page = join(root, 'benchmark.html');
		await execFileAsync(process.execPath, [
			'scripts/benchmark-sql-result-grid.mjs',
			'--emit-page',
			page,
			'--renderer',
			'native'
		]);
		const source = await readFile(page, 'utf8');
		assert.match(source, /html, body \{ width: 100%; height: 100%; margin: 0; overflow: hidden;/);
		assert.match(source, /#root \{ width: 100vw; height: 100vh; overflow: hidden; \}/);
		assert.doesNotMatch(source, /document\.documentElement\.style\.(?:width|height) = viewport/);
		assert.doesNotMatch(source, /root\.style\.(?:width|height) = viewport/);
		assert.match(source, /#benchmark-result \{ display: none; \}/);
		assert.match(source, /formatBenchmarkError/);
		assert.match(source, /runMarkerAnchored: !screenshotRunMarkerHex \|\| Boolean/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('Chromium benchmark emits a fail-closed real WorkbenchTable page', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-workbench-table-page-test-'));
	try {
		const page = join(root, 'benchmark.html');
		await execFileAsync(process.execPath, [
			'scripts/benchmark-sql-result-grid.mjs',
			'--emit-page',
			page,
			'--renderer',
			'workbench-table',
			'--workbench-table-implementation',
			'real'
		]);
		const source = await readFile(page, 'utf8');
		assert.match(source, /data-nyala-workbench-table-benchmark/);
		assert.match(source, /__NYALA_CREATE_WORKBENCH_TABLE_BENCHMARK__/);
		assert.match(source, /vs\.platform\.list\.browser\.WorkbenchTable/);
		assert.match(source, /Real WorkbenchTable renderer implementation proof is invalid/);
		assert.match(source, /workbenchTableImplementation = "real"/);
		assert.match(source, /WORKBENCH_TABLE_BUNDLE_SHA256/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('native platform workflow bundles the auto-registering Zeus entry', async () => {
	const source = await import('node:fs/promises').then(fs =>
		fs.readFile(new URL('../.github/workflows/sql-result-grid-platform.yml', import.meta.url), 'utf8')
	);
	assert.match(source, /dist\/wc\/auto\.js/);
	assert.doesNotMatch(source, /dist\/wc\/index\.js/);
	assert.doesNotMatch(source, /safaridriver|msedgedriver|native_webview2|windows_driver_url/i);
	assert.match(source, /--app-binary/);
	assert.match(source, /--features webdriver/);
	assert.match(source, /create-sql-result-grid-zeus-audit\.mjs/);
	assert.match(source, /phase-z1-benchmark\.json/);
	assert.match(source, /--workbench-table-implementation real/);
	assert.match(source, /NYALA_ZEUS_AUDIT_EVIDENCE/);
	// The blocked-evidence fallback must declare the same measurement contract
	// the benchmark code emits, otherwise a failed run produces evidence the gate
	// rejects for a contract mismatch instead of reporting the real failure.
	assert.equal(
		source.match(
			new RegExp(`measurementContractVersion:${MEASUREMENT_CONTRACT_VERSION}`, 'g')
		)?.length,
		2
	);
	assert.doesNotMatch(
		source,
		new RegExp(`measurementContractVersion:(?!${MEASUREMENT_CONTRACT_VERSION}\\b)\\d+`)
	);
	assert.equal(source.match(/scrollCommitBoundary:'post-presentation-opportunity'/g)?.length, 2);
	assert.equal(source.match(/executionOrder:'renderer-balanced-rotation-v1'/g)?.length, 2);
	assert.match(source, /overwrite: true/);
	assert.doesNotMatch(source, /if-no-files-found: warn/);
});
