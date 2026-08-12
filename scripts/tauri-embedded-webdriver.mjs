import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const defaultTimeoutMs = 60_000;
const defaultRequestTimeoutMs = 30_000;
const maxCapturedLogCharacters = 500_000;

export async function launchTauriEmbeddedWebdriver({
	appBinary,
	driverUrl,
	dataDir,
	logPath,
	timeoutMs = defaultTimeoutMs
}) {
	const endpoint = parseLoopbackDriverUrl(driverUrl);
	const application = resolve(appBinary);
	if (dataDir) {
		await mkdir(resolve(dataDir), { recursive: true });
	}

	const child = spawn(application, [], {
		env: {
			...process.env,
			TAURI_WEBDRIVER_PORT: endpoint.port,
			...(dataDir
				? {
						NYALA_DATA_DIR: resolve(dataDir),
						NYALA_WEBDRIVER_DATA_DIR: resolve(dataDir)
					}
				: {})
		},
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

export async function createEmbeddedWebdriverSession(driverUrl) {
	const payload = await webdriverRequest(driverUrl, '/session', 'POST', {
		capabilities: {
			alwaysMatch: {
				browserName: 'tauri',
				'wdio:tauriServiceOptions': { windowLabel: 'main' }
			}
		}
	});
	const value = payload.value ?? {};
	const sessionId = payload.sessionId ?? value.sessionId;
	const capabilities = value.capabilities ?? payload.capabilities;
	if (!sessionId || !capabilities || typeof capabilities !== 'object') {
		throw new Error(`Embedded WebDriver returned an invalid session: ${JSON.stringify(payload).slice(0, 1_000)}`);
	}
	return { sessionId, capabilities };
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

export function unwrapWebdriverValue(payload) {
	return payload?.value?.value ?? payload?.value;
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
