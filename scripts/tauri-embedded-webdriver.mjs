import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';

const defaultTimeoutMs = 60_000;
const defaultRequestTimeoutMs = 30_000;
const maxCapturedLogCharacters = 500_000;

export async function launchTauriEmbeddedWebdriver({
	appBinary,
	driverUrl,
	dataDir,
	logPath,
	runNonce,
	timeoutMs = defaultTimeoutMs
}) {
	const application = resolve(appBinary);
	if (dataDir) {
		await mkdir(resolve(dataDir), { recursive: true });
	}

	const child = spawn(application, [], {
		env: createTauriWebdriverEnvironment({ driverUrl, dataDir, runNonce }),
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: false
	});
	const childClosed = new Promise(resolveClose => child.once('close', resolveClose));
	let stdout = '';
	let stderr = '';
	let stopped = false;
	let spawnError;
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', chunk => {
		stdout = appendBounded(stdout, chunk);
	});
	child.stderr.on('data', chunk => {
		stderr = appendBounded(stderr, chunk);
	});
	child.once('error', error => {
		spawnError = error;
	});

	async function writeLog() {
		if (!logPath) return;
		const resolved = resolve(logPath);
		await mkdir(dirname(resolved), { recursive: true });
		await writeFile(resolved, `[stdout]\n${stdout}\n[stderr]\n${stderr}\n`, 'utf8');
	}

	async function stop() {
		if (stopped) return;
		stopped = true;
		if (child.pid && child.exitCode === null && child.signalCode === null && child.kill('SIGTERM')) {
			const closed = await waitForChildClose(childClosed, 5_000);
			if (!closed && child.exitCode === null && child.signalCode === null && child.kill('SIGKILL')) {
				await waitForChildClose(childClosed, 2_000);
			}
		}
		await writeLog();
	}

	try {
		await waitForWebdriverStatus(driverUrl, timeoutMs, () => {
			if (spawnError) throw spawnError;
			if (child.exitCode !== null) {
				throw new Error(`Nyala exited with code ${child.exitCode}. ${stderr.slice(-1_000)}`.trim());
			}
		});
		return { child, stop, writeLog };
	} catch (error) {
		await stop();
		throw error;
	}
}

export function createTauriWebdriverEnvironment({ driverUrl, dataDir, runNonce, baseEnvironment = process.env }) {
	const endpoint = parseLoopbackDriverUrl(driverUrl);
	const resolvedDataDir = dataDir ? resolve(dataDir) : undefined;
	return {
		...baseEnvironment,
		TAURI_WEBDRIVER_PORT: endpoint.port,
		...(resolvedDataDir
			? {
					NYALA_DATA_DIR: resolvedDataDir,
					NYALA_WEBDRIVER_APP_DATA_DIR: resolvedDataDir
				}
			: {}),
		...(runNonce === undefined ? {} : { NYALA_WEBDRIVER_RUN_NONCE: String(runNonce) })
	};
}

export function createWebdriverRunNonce() {
	return randomBytes(32).toString('hex');
}

export async function resolveLoopbackDriverEndpoint(explicitDriverUrl, allocate = allocateLoopbackDriverUrl) {
	const portSource = explicitDriverUrl === undefined ? 'os-assigned' : 'explicit';
	const candidate = portSource === 'explicit' ? explicitDriverUrl : await allocate();
	const endpoint = parseLoopbackDriverUrl(candidate);
	return { driverUrl: endpoint.url, port: endpoint.port, portSource };
}

export async function allocateLoopbackDriverUrl() {
	const server = createServer();
	await new Promise((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', rejectListen);
			resolveListen();
		});
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		await closeServer(server);
		throw new Error('Unable to allocate a loopback WebDriver port.');
	}
	await closeServer(server);
	return `http://127.0.0.1:${address.port}`;
}

export async function createEmbeddedWebdriverSession(
	driverUrl,
	{ timeoutMs = defaultTimeoutMs, retryDelayMs = 100 } = {}
) {
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
		throw new Error(`Embedded WebDriver session timeout must be a positive integer, got ${timeoutMs}`);
	}
	if (!Number.isInteger(retryDelayMs) || retryDelayMs < 1) {
		throw new Error(`Embedded WebDriver session retry delay must be a positive integer, got ${retryDelayMs}`);
	}
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const payload = await webdriverRequest(
				driverUrl,
				'/session',
				'POST',
				{
					capabilities: {
						alwaysMatch: {
							browserName: 'tauri',
							'wdio:tauriServiceOptions': { windowLabel: 'main' }
						}
					}
				},
				{ timeoutMs: Math.max(1, Math.min(defaultRequestTimeoutMs, deadline - Date.now())) }
			);
			const value = payload.value ?? {};
			const sessionId = payload.sessionId ?? value.sessionId;
			const capabilities = value.capabilities ?? payload.capabilities;
			if (!sessionId || !capabilities || typeof capabilities !== 'object') {
				throw new Error(`Embedded WebDriver returned an invalid session: ${JSON.stringify(payload).slice(0, 1_000)}`);
			}
			return { sessionId, capabilities };
		} catch (error) {
			lastError = error;
			const reason = error instanceof Error ? error.message : String(error);
			if (!/no such window/i.test(reason)) throw error;
			await delay(Math.min(retryDelayMs, Math.max(1, deadline - Date.now())));
		}
	}
	throw new Error(
		`Timed out waiting for embedded WebDriver main window${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ''}`
	);
}

export function identifyEmbeddedWebview(capabilities, expectedPlatform, hostPlatform = process.platform) {
	const normalizedHost = hostPlatform === 'darwin' ? 'macos' : hostPlatform === 'win32' ? 'windows' : hostPlatform;
	if (!['macos', 'windows'].includes(expectedPlatform)) {
		throw new Error(`embedded platform must be macos or windows, got ${expectedPlatform}`);
	}
	if (normalizedHost !== expectedPlatform) {
		throw new Error(`embedded ${expectedPlatform} evidence cannot run on ${normalizedHost}`);
	}
	const platformName = String(capabilities.platformName ?? '').toLowerCase();
	const browserName = String(capabilities.browserName ?? '').toLowerCase();
	const expectedBrowserName = expectedPlatform === 'macos' ? 'webkit' : 'msedge';
	if (platformName !== expectedPlatform || browserName !== expectedBrowserName) {
		throw new Error(
			`embedded session identified ${platformName || 'unknown'}/${browserName || 'unknown'}; expected ${expectedPlatform}/${expectedBrowserName}`
		);
	}
	return {
		driverProvider: 'embedded',
		nativeWebView: true,
		nativeWebView2: expectedPlatform === 'windows',
		engine: expectedPlatform === 'macos' ? 'wkwebview-embedded' : 'webview2-embedded',
		browser: browserName,
		browserVersion: String(capabilities.browserVersion ?? 'unknown'),
		platformName,
		sessionCapabilities: capabilities
	};
}

export async function webdriverRequest(
	baseUrl,
	path,
	method = 'GET',
	body,
	{ timeoutMs = defaultRequestTimeoutMs } = {}
) {
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
		throw new Error(`WebDriver request timeout must be a positive integer, got ${timeoutMs}`);
	}
	let response;
	try {
		response = await fetch(`${String(baseUrl).replace(/\/$/, '')}${path}`, {
			method,
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs)
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`WebDriver ${method} ${path} request failed (timeout ${timeoutMs}ms): ${reason}`, {
			cause: error
		});
	}
	const text = await response.text();
	let payload;
	try {
		payload = text ? JSON.parse(text) : {};
	} catch {
		throw new Error(`WebDriver returned non-JSON ${response.status}: ${text.slice(0, 240)}`);
	}
	if (!response.ok || payload.value?.error) {
		throw new Error(`WebDriver ${method} ${path} failed: ${JSON.stringify(payload).slice(0, 1_000)}`);
	}
	return payload;
}

export function wrapDirectEvalExpression(expression) {
	if (typeof expression !== 'string' || expression.trim().length === 0) {
		throw new Error('Embedded WebDriver direct eval requires a non-empty JavaScript expression');
	}
	try {
		new Function(`return (${expression});`);
	} catch (error) {
		throw new Error('Embedded WebDriver direct eval requires a valid JavaScript expression', { cause: error });
	}
	const done = 'arguments[arguments.length - 1]';
	return `try { ${done}({ ok: true, value: (${expression}) }); } catch (error) { ${done}({ ok: false, error: String(error) }); }`;
}

export async function evaluateViaDirectEval(
	baseUrl,
	expression,
	{ timeoutMs = defaultTimeoutMs, windowLabel = 'main' } = {}
) {
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
		throw new Error(`Embedded WebDriver direct eval timeout must be a positive integer, got ${timeoutMs}`);
	}
	if (typeof windowLabel !== 'string' || windowLabel.length === 0) {
		throw new Error('Embedded WebDriver direct eval requires a window label');
	}
	const payload = await webdriverRequest(
		baseUrl,
		'/wdio/eval',
		'POST',
		{
			script: wrapDirectEvalExpression(expression),
			window_label: windowLabel,
			timeout_ms: timeoutMs
		},
		{ timeoutMs: timeoutMs + 5_000 }
	);
	if (payload.error) {
		throw new Error(`Embedded WebDriver direct eval failed: ${JSON.stringify(payload).slice(0, 1_000)}`);
	}
	return payload.value;
}

export function unwrapWebdriverValue(payload) {
	return payload?.value?.value ?? payload?.value;
}

/**
 * Derive the next outer window rect from WebDriver's applied rect and the
 * viewport observed inside the WebView. This avoids assuming whether a driver
 * reports physical or logical pixels and converges across window chrome.
 */
export function calibrateWindowRectForCssViewport(
	requestedCssViewport,
	observedCssViewport,
	appliedWindowRect,
	{
		minimumWindowRect = { width: 1, height: 1 },
		maximumWindowRect = { width: 16_384, height: 16_384 },
		maximumScaleStep = 4
	} = {}
) {
	const requested = positiveDimensions(requestedCssViewport, 'requested CSS viewport');
	const observed = positiveDimensions(observedCssViewport, 'observed CSS viewport');
	const applied = positiveDimensions(appliedWindowRect, 'applied window rect');
	const minimum = positiveDimensions(minimumWindowRect, 'minimum window rect');
	const maximum = positiveDimensions(maximumWindowRect, 'maximum window rect');
	const scaleStep = Number(maximumScaleStep);
	if (minimum.width > maximum.width || minimum.height > maximum.height) {
		throw new Error('minimum window rect must not exceed maximum window rect');
	}
	if (!Number.isFinite(scaleStep) || scaleStep < 1) {
		throw new Error(`maximumScaleStep must be a finite number at least 1, got ${maximumScaleStep}`);
	}

	return {
		width: calibratedDimension(requested.width, observed.width, applied.width, minimum.width, maximum.width, scaleStep),
		height: calibratedDimension(
			requested.height,
			observed.height,
			applied.height,
			minimum.height,
			maximum.height,
			scaleStep
		)
	};
}

export async function applyWindowRectAndObserveCssViewport(
	requestedWindowRect,
	{ applyWindowRect, observeCssViewport, settleMs = 250, wait = delay } = {}
) {
	if (typeof applyWindowRect !== 'function' || typeof observeCssViewport !== 'function') {
		throw new Error('CSS viewport observation requires window apply and viewport observe functions');
	}
	if (!Number.isInteger(settleMs) || settleMs < 0) {
		throw new Error(`CSS viewport settle time must be a non-negative integer, got ${settleMs}`);
	}
	if (typeof wait !== 'function') {
		throw new Error('CSS viewport observation requires a wait function');
	}
	const appliedWindowRect = await applyWindowRect(requestedWindowRect);
	await wait(settleMs);
	const observedCssViewport = await observeCssViewport();
	return { appliedWindowRect, observedCssViewport };
}

export async function convergeWindowRectForCssViewport(
	requestedCssViewport,
	applyAndObserve,
	{ maxAttempts = 4, tolerance = 1, initialWindowRect = requestedCssViewport } = {}
) {
	const requested = positiveDimensions(requestedCssViewport, 'requested CSS viewport');
	let requestedWindowRect = positiveDimensions(initialWindowRect, 'initial window rect');
	if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
		throw new Error(`viewport calibration maxAttempts must be a positive integer, got ${maxAttempts}`);
	}
	validateDimensionTolerance(tolerance);
	if (typeof applyAndObserve !== 'function') {
		throw new Error('viewport calibration requires an applyAndObserve function');
	}

	const calibrationAttempts = [];
	let viewportConverged = false;
	let convergenceStoppedReason = 'max-attempts';
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const appliedRequest = { ...requestedWindowRect };
		const observation = await applyAndObserve(appliedRequest, attempt);
		positiveDimensions(observation?.appliedWindowRect, 'applied window rect');
		positiveDimensions(observation?.observedCssViewport, 'observed CSS viewport');
		calibrationAttempts.push({
			attempt,
			requestedWindowRect: appliedRequest,
			appliedWindowRect: { ...observation.appliedWindowRect },
			observedCssViewport: { ...observation.observedCssViewport }
		});

		viewportConverged = dimensionsWithinTolerance(requested, observation.observedCssViewport, tolerance);
		if (viewportConverged) {
			convergenceStoppedReason = 'target-reached';
			break;
		}
		if (attempt === maxAttempts) break;

		const nextWindowRect = calibrateWindowRectForCssViewport(
			requested,
			observation.observedCssViewport,
			observation.appliedWindowRect
		);
		if (windowDimensionsEqual(nextWindowRect, appliedRequest)) {
			convergenceStoppedReason = 'no-adjustment';
			break;
		}
		requestedWindowRect = nextWindowRect;
	}

	const lastAttempt = calibrationAttempts.at(-1);
	return {
		requestedCssViewport: requested,
		initialWindowRect: positiveDimensions(initialWindowRect, 'initial window rect'),
		lastAppliedRequestedWindowRect: lastAttempt.requestedWindowRect,
		appliedWindowRect: lastAttempt.appliedWindowRect,
		observedCssViewport: lastAttempt.observedCssViewport,
		viewportConverged,
		viewportTolerance: tolerance,
		convergenceStoppedReason,
		calibrationAttempts
	};
}

export function dimensionsWithinTolerance(requestedDimensions, observedDimensions, tolerance = 1) {
	const requested = positiveDimensions(requestedDimensions, 'requested dimensions');
	const observed = positiveDimensions(observedDimensions, 'observed dimensions');
	validateDimensionTolerance(tolerance);
	return (
		Math.abs(requested.width - observed.width) <= tolerance && Math.abs(requested.height - observed.height) <= tolerance
	);
}

function calibratedDimension(requested, observed, applied, minimum, maximum, maximumScaleStep) {
	const scale = Math.min(maximumScaleStep, Math.max(1 / maximumScaleStep, requested / observed));
	return Math.min(maximum, Math.max(minimum, Math.round(applied * scale)));
}

function positiveDimensions(value, label) {
	const width = Number(value?.width);
	const height = Number(value?.height);
	if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
		throw new Error(`${label} must have positive finite dimensions, got ${JSON.stringify(value)}`);
	}
	return { width, height };
}

function validateDimensionTolerance(tolerance) {
	if (!Number.isFinite(tolerance) || tolerance < 0) {
		throw new Error(`dimension tolerance must be a finite non-negative number, got ${tolerance}`);
	}
}

function windowDimensionsEqual(left, right) {
	return Number(left?.width) === Number(right?.width) && Number(left?.height) === Number(right?.height);
}

export function parseLoopbackDriverUrl(value) {
	const endpoint = new URL(value);
	if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(endpoint.hostname)) {
		throw new Error('embedded WebDriver URL must use HTTP on a loopback host');
	}
	const port = endpoint.port || '80';
	if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65_535) {
		throw new Error(`embedded WebDriver URL has an invalid port: ${port}`);
	}
	return { url: endpoint.toString().replace(/\/$/, ''), port };
}

async function waitForWebdriverStatus(driverUrl, timeoutMs, inspectProcess) {
	const deadline = Date.now() + timeoutMs;
	let lastReason = 'server did not respond';
	while (Date.now() < deadline) {
		inspectProcess();
		try {
			await webdriverRequest(driverUrl, '/status', 'GET', undefined, {
				timeoutMs: Math.max(1, Math.min(defaultRequestTimeoutMs, deadline - Date.now()))
			});
			return;
		} catch (error) {
			lastReason = error instanceof Error ? error.message : String(error);
		}
		await delay(100);
	}
	throw new Error(`Timed out waiting for embedded WebDriver: ${lastReason}`);
}

function appendBounded(current, chunk) {
	return `${current}${chunk}`.slice(-maxCapturedLogCharacters);
}

function delay(ms) {
	return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

async function waitForChildClose(childClosed, timeoutMs) {
	let timer;
	try {
		return await Promise.race([
			childClosed.then(() => true),
			new Promise(resolveTimeout => {
				timer = setTimeout(() => resolveTimeout(false), timeoutMs);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

function closeServer(server) {
	return new Promise((resolveClose, rejectClose) => {
		server.close(error => (error ? rejectClose(error) : resolveClose()));
	});
}
