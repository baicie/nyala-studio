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

const execFileAsync = promisify(execFile);

test('WebDriver benchmark runner records platform evidence and screenshots', async () => {
	const source = await import('node:fs/promises').then(fs =>
		fs.readFile(new URL('./benchmark-sql-result-grid-webdriver.mjs', import.meta.url), 'utf8')
	);
	assert.match(source, /--app-binary/);
	assert.match(source, /createEmbeddedWebdriverSession/);
	assert.match(source, /identifyEmbeddedWebview/);
	assert.match(source, /serveBenchmarkPage/);
	assert.match(source, /server\.listen\(0, '127\.0\.0\.1'/);
	assert.doesNotMatch(source, /pathToFileURL/);
	assert.match(source, /waitForNavigation/);
	assert.match(source, /setSessionTimeouts/);
	assert.match(source, /script-timeout-ms/);
	assert.match(source, /evaluateViaDirectEval/);
	assert.match(source, /readBenchmarkResultViaDirectEval/);
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
	assert.equal(MEASUREMENT_CONTRACT_VERSION, 6);
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
		/await waitForNavigation\(driverUrl, sessionId, url\);\s*const viewportCalibration = await calibrateCssViewport/
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
	assert.match(source, /screenshots\.push\(\{/);
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
	assert.equal(source.match(/measurementContractVersion:6/g)?.length, 2);
	assert.equal(source.match(/scrollCommitBoundary:'post-presentation-opportunity'/g)?.length, 2);
	assert.equal(source.match(/executionOrder:'renderer-balanced-rotation-v1'/g)?.length, 2);
	assert.match(source, /overwrite: true/);
	assert.doesNotMatch(source, /if-no-files-found: warn/);
});
