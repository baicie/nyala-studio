import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, constants, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { CdpClient } from './sql-result-grid-cdp-client.mjs';
import {
	SQL_RESULT_GRID_JANK_MINIMUM_HORIZONTAL_SPAN_PX,
	SQL_RESULT_GRID_JANK_MINIMUM_VERTICAL_SPAN_PX
} from './sql-result-grid-jank-trace.mjs';

const execFileAsync = promisify(execFile);

async function launchBrowser(t, directory) {
	let browser;
	let browserClient;
	let client;
	t.after(async () => {
		client?.close();
		browserClient?.close();
		if (browser?.pid && browser.exitCode === null && browser.signalCode === null) {
			await new Promise(resolve => {
				let forceStopTimeout;
				const finish = () => {
					clearTimeout(timeout);
					clearTimeout(forceStopTimeout);
					browser.off('exit', finish);
					resolve();
				};
				const timeout = setTimeout(() => {
					browser.kill('SIGKILL');
					forceStopTimeout = setTimeout(finish, 1_000);
				}, 3_000);
				browser.once('exit', finish);
				if (browser.exitCode !== null || browser.signalCode !== null) finish();
				else browser.kill('SIGTERM');
			});
		}
		await rm(directory, { recursive: true, force: true });
	});
	const candidates = process.env.NYALA_CHROME
		? [process.env.NYALA_CHROME]
		: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'google-chrome', 'chromium'];
	let executable;
	for (const candidate of candidates) {
		try {
			if (candidate.includes('/') || candidate.includes('\\')) await access(candidate, constants.X_OK);
			else await execFileAsync(candidate, ['--version'], { timeout: 5_000 });
			executable = candidate;
			break;
		} catch {
			/* Try the next installed browser. */
		}
	}
	assert.ok(executable, 'Chrome is required for this integration test; set NYALA_CHROME to its executable.');
	browser = spawn(
		executable,
		[
			'--headless=new',
			'--no-sandbox',
			'--disable-gpu',
			'--no-first-run',
			'--disable-background-networking',
			'--disable-background-timer-throttling',
			'--disable-renderer-backgrounding',
			'--remote-debugging-port=0',
			`--user-data-dir=${join(directory, 'profile')}`,
			'about:blank'
		],
		{ stdio: ['ignore', 'ignore', 'pipe'] }
	);
	const endpoint = await new Promise((resolve, reject) => {
		let output = '';
		const timeout = setTimeout(() => reject(new Error('Chrome did not expose a DevTools endpoint.')), 15_000);
		browser.once('error', error => {
			clearTimeout(timeout);
			reject(error);
		});
		const onData = chunk => {
			output = (output + chunk).slice(-4_096);
			const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
			if (match) {
				clearTimeout(timeout);
				browser.stderr.off('data', onData);
				browser.stderr.resume();
				resolve(match[1]);
			}
		};
		browser.stderr.on('data', onData);
	});
	browserClient = await CdpClient.connect(endpoint, Date.now() + 10_000);
	const { targetId } = await browserClient.send('Target.createTarget', { url: 'about:blank' });
	const response = await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`);
	const target = (await response.json()).find(item => item.id === targetId);
	assert.ok(target?.webSocketDebuggerUrl);
	client = await CdpClient.connect(target.webSocketDebuggerUrl, Date.now() + 10_000);
	await client.send('Page.enable');
	await client.send('Emulation.setDeviceMetricsOverride', {
		width: 1440,
		height: 420,
		deviceScaleFactor: 1,
		mobile: false
	});
	return client;
}

async function evaluate(client, expression) {
	const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
	assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
	return result.result.value;
}

async function waitFor(client, expression) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (await evaluate(client, expression)) return;
		await delay(25);
	}
	const state = await evaluate(client, `typeof readScrollState === 'function' ? readScrollState() : null`);
	assert.fail(`Browser condition timed out: ${expression}; state=${JSON.stringify(state)}`);
}

test('real WorkbenchTable wheel input matches both sampled axes and visible cells', { timeout: 60_000 }, async t => {
	const directory = await mkdtemp(join(tmpdir(), 'nyala-grid-scroll-test-'));
	const page = join(directory, 'benchmark.html');
	try {
		await execFileAsync(
			process.execPath,
			[
				fileURLToPath(new URL('./benchmark-sql-result-grid.mjs', import.meta.url)),
				'--emit-page',
				page,
				'--renderer',
				'workbench-table',
				'--workbench-table-implementation',
				'real'
			],
			{ timeout: 20_000 }
		);
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
	const client = await launchBrowser(t, directory);
	for (const [rows, columns] of [
		[1_000, 20],
		[10_000, 50]
	]) {
		await t.test(`${rows} rows / ${columns} columns`, async () => {
			const url = pathToFileURL(page);
			url.search = new URLSearchParams({ renderer: 'workbench-table', rows, columns, deferStart: 'true' }).toString();
			await client.send('Page.navigate', { url: url.href });
			await waitFor(
				client,
				`location.href === ${JSON.stringify(url.href)} && typeof renderBenchmarkGrid === 'function'`
			);
			await evaluate(
				client,
				`(async () => {
				const root = await prepareBenchmarkRoot();
				globalThis.testRendered = (await renderBenchmarkGrid(root)).rendered;
				globalThis.testOffsets = createTraceScrollOffsets(testRendered);
				globalThis.testSampler = createScrollOffsetSampler(testOffsets);
				globalThis.readScrollState = () => {
					const row = root.querySelector('.monaco-list-row');
					const cell = row.querySelector('.monaco-table-td');
					return {
						x: cell.getBoundingClientRect().x,
						rowIndex: Number(row.dataset.rowIndex), text: cell.textContent,
						top: testOffsets.scrollTop, left: testOffsets.scrollLeft,
						controllerLeft: testRendered.scroll.scrollLeft ?? null,
						nativeLeft: testRendered.viewport.scrollLeft,
						rowsLeft: parseFloat(root.querySelector('.monaco-list-rows').style.left) || 0
					};
				};
				await waitForPresentationOpportunity();
			})()`
			);
			try {
				const before = await evaluate(client, 'readScrollState()');
				// Bound the input loop by actual movement: Chromium may drop a wheel
				// event during navigation, and WBT normalizes device deltas itself.
				const wheelUntil = async (deltaX, deltaY, condition) => {
					await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 500, y: 180 });
					for (let index = 0; index < 80; index++) {
						await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 180, deltaX, deltaY });
						await evaluate(client, 'waitForPresentationOpportunity()');
						if (await evaluate(client, condition)) return;
					}
					assert.fail(
						`Wheel input did not reach ${condition}: ${JSON.stringify(await evaluate(client, 'readScrollState()'))}`
					);
				};
				await wheelUntil(60, 0, `readScrollState().x <= ${before.x - 600}`);
				const right = await evaluate(client, 'readScrollState()');
				await wheelUntil(-60, 0, `Math.abs(readScrollState().x - ${before.x}) < 1`);
				const left = await evaluate(client, 'readScrollState()');
				await wheelUntil(0, 120, 'readScrollState().top >= 2400 && readScrollState().rowIndex > 0');
				const down = await evaluate(client, 'readScrollState()');
				await wheelUntil(0, -120, 'readScrollState().top < 1 && readScrollState().rowIndex === 0');
				const up = await evaluate(client, 'readScrollState()');
				const offsets = await evaluate(
					client,
					`new Promise(resolve => requestAnimationFrame(() => {
					testSampler.stop(); resolve(testSampler.snapshot());
				}))`
				);
				t.diagnostic(JSON.stringify({ rows, right, down, offsets }));
				assert.equal(right.nativeLeft, 0, 'native viewport does not represent WorkbenchTable horizontal state');
				assert.ok(
					Math.abs(right.left - (before.x - right.x)) < 1,
					'sampled horizontal offset must match actual cell displacement'
				);
				assert.equal(right.controllerLeft, right.left);
				assert.equal(right.rowsLeft, -right.left);
				assert.equal(right.text, before.text);
				assert.equal(left.left, 0, 'reverse wheel must restore the horizontal offset');
				assert.equal(
					down.text,
					String(down.rowIndex),
					'visible row identity and cell content must agree after vertical wheel'
				);
				assert.ok(
					Math.abs(Math.floor(down.top / 28) - down.rowIndex) <= 1,
					'vertical offset must identify the visible row'
				);
				assert.equal(up.text, before.text);
				assert.ok(offsets.horizontalSpanPx >= SQL_RESULT_GRID_JANK_MINIMUM_HORIZONTAL_SPAN_PX);
				assert.ok(offsets.verticalSpanPx >= SQL_RESULT_GRID_JANK_MINIMUM_VERTICAL_SPAN_PX);
			} finally {
				await evaluate(client, 'testSampler.stop(); testRendered.dispose();');
			}
		});
	}
});
