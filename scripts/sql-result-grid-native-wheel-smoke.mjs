#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	createEmbeddedWebdriverSession,
	evaluateViaDirectEval,
	identifyEmbeddedWebview,
	launchTauriEmbeddedWebdriver,
	resolveLoopbackDriverEndpoint,
	webdriverRequest
} from './tauri-embedded-webdriver.mjs';
import { evaluateNativeWheelSmoke } from './sql-result-grid-native-wheel-contract.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = parseArgs(process.argv.slice(2));

if (cli.help === 'true') {
	process.stdout.write(
		'Usage: node scripts/sql-result-grid-native-wheel-smoke.mjs --app-binary <path> --zeus-bundle <path> [--platform macos|windows] [--output <path>]\n'
	);
	process.exit(0);
}

const platform =
	cli.platform ?? (process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : '');
if (!['macos', 'windows'].includes(platform))
	throw new Error(`Unsupported native platform: ${platform || process.platform}`);
if (!cli['app-binary']) throw new Error('--app-binary is required.');
if (!cli['zeus-bundle']) throw new Error('--zeus-bundle is required.');

const appBinary = resolve(cli['app-binary']);
const zeusBundle = resolve(cli['zeus-bundle']);
const outputPath = resolve(cli.output ?? join(repositoryRoot, 'native-wheel-smoke.json'));
const temporaryRoot = await mkdtemp(join(tmpdir(), 'nyala-native-wheel-smoke-'));
const appDataDir = join(temporaryRoot, 'app-data');
const pagePath = join(temporaryRoot, 'benchmark.html');
const helperPath = join(temporaryRoot, platform === 'macos' ? 'post-wheel.swift' : 'post-wheel.ps1');
const helperBinaryPath = join(temporaryRoot, 'post-wheel');
const runToken = randomUUID();
const workload = { rows: 1_000, columns: 20, width: 1440, height: 420, wide: false };
const report = {
	version: 1,
	kind: 'native-wheel-smoke-v1',
	status: 'blocked',
	diagnostic: true,
	admissionGrade: false,
	platform,
	runToken,
	workload,
	checks: {},
	limitations: [
		'This smoke verifies trusted wheel delivery and viewport behavior only; it is not a performance measurement.',
		'The page is the standalone Zeus benchmark fixture, not the Nyala SQL Result panel.'
	]
};

let appHost;
let sessionId;
let benchmarkServer;
let driverUrl;

try {
	execFileSync(
		process.execPath,
		[
			join(repositoryRoot, 'scripts/benchmark-sql-result-grid.mjs'),
			'--emit-page',
			pagePath,
			'--renderer',
			'zeus',
			'--workbench-table-implementation',
			'real',
			'--zeus-bundle',
			zeusBundle,
			'--require-zeus',
			'true'
		],
		{ cwd: repositoryRoot, stdio: 'inherit' }
	);
	benchmarkServer = await servePage(pagePath);
	const endpoint = await resolveLoopbackDriverEndpoint(cli['driver-url']);
	driverUrl = endpoint.driverUrl;
	appHost = await launchTauriEmbeddedWebdriver({
		appBinary,
		driverUrl: endpoint.driverUrl,
		dataDir: appDataDir,
		logPath: cli['app-log']
	});
	const session = await createEmbeddedWebdriverSession(endpoint.driverUrl);
	sessionId = session.sessionId;
	report.application = {
		binary: appBinary,
		pid: appHost.child.pid,
		...identifyEmbeddedWebview(session.capabilities, platform)
	};

	const url = new URL(benchmarkServer.url);
	url.search = new URLSearchParams({
		run: runToken,
		renderer: 'zeus',
		rows: String(workload.rows),
		columns: String(workload.columns),
		width: String(workload.width),
		height: String(workload.height),
		nativeWheelSmoke: 'true'
	}).toString();
	await webdriverRequest(endpoint.driverUrl, `/session/${sessionId}/url`, 'POST', { url: url.toString() });
	await waitForPage(endpoint.driverUrl, sessionId, url.toString());
	await prepareGrid(endpoint.driverUrl, sessionId);
	const before = await readProbe(endpoint.driverUrl);
	if (before.status !== 'ready') throw new Error(`Benchmark fixture was not ready: ${before.error ?? before.status}`);
	report.before = before;

	await writeFile(helperPath, platform === 'macos' ? macHelperSource() : windowsHelperSource(), 'utf8');
	let helperResult;
	if (platform === 'macos') {
		execFileSync(
			'swiftc',
			[helperPath, '-framework', 'AppKit', '-framework', 'ApplicationServices', '-o', helperBinaryPath],
			{
				stdio: 'inherit'
			}
		);
		const windowRect = await readWindowRect(endpoint.driverUrl, sessionId);
		report.windowRect = windowRect;
		helperResult = runHelper(helperBinaryPath, [
			String(appHost.child.pid),
			String((windowRect.x + before.viewportRect.left + before.viewportRect.width / 2) / before.devicePixelRatio),
			String(
				(windowRect.y + before.viewportRect.top + Math.min(before.viewportRect.height / 2, 64)) /
					before.devicePixelRatio
			),
			'-3'
		]);
	} else {
		helperResult = runHelper('pwsh', [
			'-NoProfile',
			'-ExecutionPolicy',
			'Bypass',
			'-File',
			helperPath,
			'-ProcessId',
			String(appHost.child.pid),
			'-ClientX',
			String(before.viewportRect.left + before.viewportRect.width / 2),
			'-ClientY',
			String(before.viewportRect.top + Math.min(before.viewportRect.height / 2, 64)),
			'-DevicePixelRatio',
			String(before.devicePixelRatio),
			'-Delta',
			'120'
		]);
	}
	report.nativeInput = helperResult;
	await waitForScroll(endpoint.driverUrl, sessionId);
	const after = await readProbe(endpoint.driverUrl);
	report.after = after;
	report.checks = evaluateNativeWheelSmoke({ nativeInput: helperResult, before, after });
	report.status = Object.values(report.checks).every(Boolean) ? 'passed' : 'failed';
} catch (error) {
	report.error = error instanceof Error ? error.message : String(error);
} finally {
	if (sessionId) {
		await webdriverRequest(
			driverUrl ?? cli['driver-url'] ?? 'http://127.0.0.1:4444',
			`/session/${sessionId}`,
			'DELETE'
		).catch(() => undefined);
	}
	if (appHost) await appHost.stop().catch(() => undefined);
	if (benchmarkServer) await closeServer(benchmarkServer.server).catch(() => undefined);
	try {
		await mkdir(join(outputPath, '..'), { recursive: true });
		await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

process.stdout.write(`Native wheel smoke ${report.status}: ${outputPath}\n`);
if (report.status !== 'passed') process.exitCode = 1;

function parseArgs(args) {
	const parsed = {};
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
		const key = token.slice(2);
		const value = args[index + 1];
		if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
		parsed[key] = value;
		index += 1;
	}
	return parsed;
}

async function servePage(path) {
	const html = await readFile(path);
	const server = createServer((request, response) => {
		if (request.url?.split('?', 1)[0] !== '/') {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
	});
	await new Promise((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen(0, '127.0.0.1', resolveListen);
	});
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Unable to start the benchmark page server.');
	return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function waitForPage(baseUrl, id, expectedUrl) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const [current, title] = await Promise.all([
			webdriverRequest(baseUrl, `/session/${id}/url`),
			webdriverRequest(baseUrl, `/session/${id}/title`)
		]);
		if (current.value === expectedUrl && title.value === 'Nyala SQL result grid benchmark') return;
		await delay(50);
	}
	throw new Error('Timed out waiting for the benchmark page to load.');
}

async function prepareGrid(baseUrl, id) {
	await evaluateViaDirectEval(baseUrl, 'globalThis.__nyalaNativeWheelSmokeStart()');
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		const state = await readProbe(baseUrl);
		if (state.status === 'ready' || state.status === 'error') return;
		await delay(100);
	}
	throw new Error('Timed out rendering the Zeus fixture.');
}

async function readProbe(baseUrl) {
	return evaluateViaDirectEval(baseUrl, 'globalThis.__nyalaNativeWheelSmokeRead()');
}

async function readWindowRect(baseUrl, id) {
	const payload = await webdriverRequest(baseUrl, `/session/${id}/window/rect`);
	const value = payload.value ?? payload;
	if (![value.x, value.y, value.width, value.height].every(Number.isFinite)) {
		throw new Error(`WebDriver returned an invalid native window rect: ${JSON.stringify(value)}`);
	}
	return value;
}

async function waitForScroll(baseUrl, id) {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const state = await readProbe(baseUrl);
		if (state.wheelEvents?.length > 0 && state.scrollTop !== state.initialScrollTop) return;
		await delay(75);
	}
}

function runHelper(command, args) {
	const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true });
	let payload;
	try {
		payload = JSON.parse(result.stdout.trim());
	} catch {
		payload = {
			posted: false,
			error:
				result.stderr.trim() || result.stdout.trim() || result.error?.message || 'Native input helper returned no JSON.'
		};
	}
	if (result.error) payload.error = result.error.message;
	if (result.status !== 0 && payload.posted !== false) payload.posted = false;
	return payload;
}

function closeServer(server) {
	return new Promise((resolveClose, rejectClose) =>
		server.close(error => (error ? rejectClose(error) : resolveClose()))
	);
}

function delay(milliseconds) {
	return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

function macHelperSource() {
	return `import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func emit(_ value: [String: Any], status: Int32) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
    exit(status)
}

guard CommandLine.arguments.count == 5,
      let pidValue = Int32(CommandLine.arguments[1]),
      let x = Double(CommandLine.arguments[2]),
      let y = Double(CommandLine.arguments[3]),
      let delta = Int32(CommandLine.arguments[4]) else {
    emit(["posted": false, "reason": "invalid-arguments"], status: 2)
}

guard CGPreflightPostEventAccess() else {
    emit(["posted": false, "reason": "post-event-access-denied"], status: 2)
}

let app = NSRunningApplication(processIdentifier: pid_t(pidValue))
let frontmostBefore = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
if let app, !app.isActive {
    _ = app.activate(options: [])
    Thread.sleep(forTimeInterval: 0.2)
}
let frontmostAfter = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
guard frontmostAfter == pidValue else {
    emit(["posted": false, "reason": "target-app-not-frontmost", "frontmostBefore": frontmostBefore, "frontmostAfter": frontmostAfter, "pid": pidValue], status: 3)
}

let point = CGPoint(x: x, y: y)
guard let source = CGEventSource(stateID: .combinedSessionState),
      let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
      let wheel = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0) else {
    emit(["posted": false, "reason": "event-construction-failed", "pid": pidValue], status: 3)
}
move.post(tap: .cghidEventTap)
Thread.sleep(forTimeInterval: 0.1)
wheel.location = point
wheel.post(tap: .cghidEventTap)
emit(["posted": true, "pid": pidValue, "frontmostBefore": frontmostBefore, "frontmostAfter": frontmostAfter, "point": ["x": x, "y": y], "deltaLines": delta, "preflightPostEventAccess": true], status: 0)
`;
}

function windowsHelperSource() {
	return `param(
    [Parameter(Mandatory=$true)][int]$ProcessId,
    [Parameter(Mandatory=$true)][double]$ClientX,
    [Parameter(Mandatory=$true)][double]$ClientY,
    [Parameter(Mandatory=$true)][double]$DevicePixelRatio,
    [int]$Delta = 120
)

$signature = @'
using System;
using System.Runtime.InteropServices;
public static class NyalaWheelNative {
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", SetLastError=true)] public static extern uint GetDpiForWindow(IntPtr hwnd);
}
'@
Add-Type -TypeDefinition $signature
$dpiContext = [NyalaWheelNative]::SetThreadDpiAwarenessContext([IntPtr](-4))
if ($dpiContext -eq [IntPtr]::Zero) {
    [ordered]@{ posted = $false; reason = 'dpi-awareness-context-failed'; win32Error = [Runtime.InteropServices.Marshal]::GetLastWin32Error() } | ConvertTo-Json -Compress
    exit 2
}
$desktop = [NyalaWheelNative]::OpenInputDesktop(0, $false, 0x0101)
if ($desktop -eq [IntPtr]::Zero) {
    [ordered]@{ posted = $false; reason = 'input-desktop-unavailable'; win32Error = [Runtime.InteropServices.Marshal]::GetLastWin32Error() } | ConvertTo-Json -Compress
    exit 2
}
[void][NyalaWheelNative]::CloseDesktop($desktop)

$script:targetWindow = [IntPtr]::Zero
[NyalaWheelNative]::EnumWindows({ param($hwnd, $unused)
    [uint32]$pid = 0
    [void][NyalaWheelNative]::GetWindowThreadProcessId($hwnd, [ref]$pid)
    if ($pid -eq $ProcessId -and [NyalaWheelNative]::IsWindowVisible($hwnd)) { $script:targetWindow = $hwnd; return $false }
    return $true
}, [IntPtr]::Zero) | Out-Null
if ($script:targetWindow -eq [IntPtr]::Zero) {
    [ordered]@{ posted = $false; reason = 'target-window-not-found'; processId = $ProcessId } | ConvertTo-Json -Compress
    exit 3
}

[void][NyalaWheelNative]::ShowWindow($script:targetWindow, 9)
[void][NyalaWheelNative]::SetForegroundWindow($script:targetWindow)
Start-Sleep -Milliseconds 150
$foreground = [NyalaWheelNative]::GetForegroundWindow()
[uint32]$foregroundPid = 0
[void][NyalaWheelNative]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
if ($foregroundPid -ne $ProcessId) {
    [ordered]@{ posted = $false; reason = 'target-app-not-foreground'; processId = $ProcessId; foregroundPid = $foregroundPid } | ConvertTo-Json -Compress
    exit 3
}

$point = New-Object NyalaWheelNative+POINT
$point.X = [int][Math]::Round($ClientX * $DevicePixelRatio)
$point.Y = [int][Math]::Round($ClientY * $DevicePixelRatio)
if (-not [NyalaWheelNative]::ClientToScreen($script:targetWindow, [ref]$point)) {
    [ordered]@{ posted = $false; reason = 'client-to-screen-failed'; win32Error = [Runtime.InteropServices.Marshal]::GetLastWin32Error() } | ConvertTo-Json -Compress
    exit 3
}
if (-not [NyalaWheelNative]::SetCursorPos($point.X, $point.Y)) {
    [ordered]@{ posted = $false; reason = 'cursor-position-failed'; win32Error = [Runtime.InteropServices.Marshal]::GetLastWin32Error() } | ConvertTo-Json -Compress
    exit 3
}
$input = New-Object NyalaWheelNative+INPUT
$input.type = 0
$input.U.mi.mouseData = [uint32]$Delta
$input.U.mi.dwFlags = 0x0800
$inputs = @($input)
$inserted = [NyalaWheelNative]::SendInput(1, $inputs, [Runtime.InteropServices.Marshal]::SizeOf([type][NyalaWheelNative+INPUT]))
$lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
[ordered]@{
    posted = ($inserted -eq 1)
    reason = if ($inserted -eq 1) { 'posted' } else { 'send-input-failed' }
    processId = $ProcessId
    foregroundPid = $foregroundPid
    windowDpi = [NyalaWheelNative]::GetDpiForWindow($script:targetWindow)
    screenPoint = @{ x = $point.X; y = $point.Y }
    delta = $Delta
    inserted = $inserted
    win32Error = $lastError
} | ConvertTo-Json -Compress
if ($inserted -ne 1) { exit 3 }
`;
}
