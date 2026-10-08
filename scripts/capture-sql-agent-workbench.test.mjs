import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
	createAgentWorkbenchSnapshotExpression,
	expectedAgentTabOrder,
	requiredAgentAriaLabels,
	validateAgentWorkbenchSnapshot
} from './sql-agent-workbench-visual-contract.mjs';

const execFileAsync = promisify(execFile);
const viewport = { id: 'narrow', width: 390, height: 844 };

test('SQL Agent Workbench contract accepts the complete idle surface', () => {
	const snapshot = createSnapshot();
	const checks = validateAgentWorkbenchSnapshot(snapshot, viewport, expectedAgentTabOrder);
	assert.ok(checks.every(check => check.passed));
});

test('SQL Agent Workbench contract rejects missing ARIA and viewport overflow', () => {
	const snapshot = createSnapshot();
	snapshot.ariaLabels = snapshot.ariaLabels.filter(label => label !== 'Agent warnings');
	snapshot.controls[0].rect.right = 410;
	const checks = validateAgentWorkbenchSnapshot(snapshot, viewport, expectedAgentTabOrder);
	assert.equal(checks.find(check => check.id === 'aria-agent-warnings')?.passed, false);
	assert.equal(checks.find(check => check.id === 'viewport-agent-prompt')?.passed, false);
});

test('SQL Agent Workbench contract rejects controls that overlap the statusbar', () => {
	const snapshot = createSnapshot();
	snapshot.controls.find(control => control.ariaLabel === 'Start Agent run').rect.bottom = 830;
	const checks = validateAgentWorkbenchSnapshot(snapshot, viewport, expectedAgentTabOrder);
	assert.equal(checks.find(check => check.id === 'viewport-start-agent-run')?.passed, false);
});

test('SQL Agent Workbench contract rejects an Agent root that overlaps the statusbar', () => {
	const snapshot = createSnapshot();
	snapshot.agentRoot.rect.bottom = 830;
	snapshot.agentRoot.rect.height = 330;
	const checks = validateAgentWorkbenchSnapshot(snapshot, viewport, expectedAgentTabOrder);
	assert.equal(checks.find(check => check.id === 'agent-root-bounds')?.passed, false);
});

test('SQL Agent Workbench contract tolerates subpixel contact at the statusbar boundary', () => {
	const snapshot = createSnapshot();
	snapshot.agentRoot.rect.bottom = snapshot.statusBar.rect.top + 0.05;
	snapshot.agentRoot.rect.height = snapshot.agentRoot.rect.bottom - snapshot.agentRoot.rect.top;
	const checks = validateAgentWorkbenchSnapshot(snapshot, viewport, expectedAgentTabOrder);
	assert.equal(checks.find(check => check.id === 'agent-root-bounds')?.passed, true);
});

test('SQL Agent Workbench contract rejects statusbar overlap beyond subpixel tolerance', () => {
	const snapshot = createSnapshot();
	snapshot.agentRoot.rect.bottom = snapshot.statusBar.rect.top + 0.11;
	snapshot.agentRoot.rect.height = snapshot.agentRoot.rect.bottom - snapshot.agentRoot.rect.top;
	const checks = validateAgentWorkbenchSnapshot(snapshot, viewport, expectedAgentTabOrder);
	assert.equal(checks.find(check => check.id === 'agent-root-bounds')?.passed, false);
});

test('SQL Agent Workbench contract requires the status text to remain visible above the statusbar', () => {
	const snapshot = createSnapshot();
	snapshot.statusElement.rect.bottom = snapshot.statusBar.rect.top + 0.11;
	snapshot.statusElement.rect.height = snapshot.statusElement.rect.bottom - snapshot.statusElement.rect.top;
	const checks = validateAgentWorkbenchSnapshot(snapshot, viewport, expectedAgentTabOrder);
	assert.equal(checks.find(check => check.id === 'status-element-bounds')?.passed, false);
});

test('SQL Agent Workbench contract requires visible statusbar geometry', () => {
	const snapshot = createSnapshot();
	delete snapshot.statusBar;
	const checks = validateAgentWorkbenchSnapshot(snapshot, viewport, expectedAgentTabOrder);
	assert.equal(checks.find(check => check.id === 'statusbar-bounds')?.passed, false);
});

test('SQL Agent Workbench contract rejects statusbar geometry outside the viewport', () => {
	const snapshot = createSnapshot();
	snapshot.statusBar.rect = rect(0, 844, 390, 24);
	const checks = validateAgentWorkbenchSnapshot(snapshot, viewport, expectedAgentTabOrder);
	assert.equal(checks.find(check => check.id === 'statusbar-bounds')?.passed, false);
});

test('SQL Agent Workbench snapshot records visible notification overlays without message text', () => {
	const toast = createElement(rect(250, 600, 130, 120), ['notification-toast'], 'warning');
	const center = createElement(rect(220, 100, 160, 300), ['notifications-center'], 'info');
	const root = createElement(rect(0, 500, 390, 310), ['sql-agent-view']);
	const statusBar = createElement(rect(0, 820, 390, 24), ['statusbar']);
	const workbench = createElement(rect(0, 0, 390, 844), ['monaco-workbench']);
	const snapshot = runInNewContext(createAgentWorkbenchSnapshotExpression(), {
		document: {
			body: { innerText: '' },
			querySelector: selector =>
				new Map([
					['.sql-agent-view', root],
					['.monaco-workbench', workbench],
					['.part.sidebar', undefined],
					['.monaco-workbench .part.statusbar', statusBar],
					[
						'.sql-agent-status',
						Object.assign(createElement(rect(0, 792, 390, 18), ['sql-agent-status']), { textContent: 'Ready.' })
					]
				]).get(selector),
			querySelectorAll: selector => {
				if (selector.includes('notifications-toasts')) return [toast];
				if (selector.includes('notifications-center')) return [center];
				return [];
			}
		},
		getComputedStyle: () => ({ display: 'block', opacity: '1', visibility: 'visible' }),
		navigator: { userAgent: 'test-webview' },
		window: { devicePixelRatio: 1, innerHeight: 844, innerWidth: 390 }
	});

	assert.deepEqual(JSON.parse(JSON.stringify(snapshot.notificationOverlays)), [
		{ kind: 'toast', severity: 'warning', visible: true, rect: rect(250, 600, 130, 120) },
		{ kind: 'center', severity: 'info', visible: true, rect: rect(220, 100, 160, 300) }
	]);
	assert.equal('message' in snapshot.notificationOverlays[0], false);
});

test('SQL Agent Workbench contract requires notification overlay geometry', () => {
	const snapshot = createSnapshot();
	delete snapshot.notificationOverlays;
	const checks = validateAgentWorkbenchSnapshot(snapshot, viewport, expectedAgentTabOrder);
	assert.equal(checks.find(check => check.id === 'notification-overlay-bounds')?.passed, false);
});

test('SQL Agent Workbench contract rejects a warning toast that occludes the Agent surface', () => {
	const snapshot = createSnapshot();
	snapshot.notificationOverlays.push({
		kind: 'toast',
		severity: 'warning',
		visible: true,
		rect: rect(0, 630, 390, 100)
	});
	const checks = validateAgentWorkbenchSnapshot(snapshot, viewport, expectedAgentTabOrder);
	assert.equal(checks.find(check => check.id === 'agent-root-bounds')?.passed, false);
	assert.equal(checks.find(check => check.id === 'viewport-start-agent-run')?.passed, false);
	assert.equal(checks.find(check => check.id === 'no-visible-error-notifications')?.passed, true);
});

test('SQL Agent Workbench contract rejects a visible error notification outside the Agent surface', () => {
	const snapshot = createSnapshot();
	snapshot.notificationOverlays.push({
		kind: 'toast',
		severity: 'error',
		visible: true,
		rect: rect(250, 20, 130, 100)
	});
	const checks = validateAgentWorkbenchSnapshot(snapshot, viewport, expectedAgentTabOrder);
	assert.equal(checks.find(check => check.id === 'agent-root-bounds')?.passed, true);
	assert.equal(checks.find(check => check.id === 'no-visible-error-notifications')?.passed, false);
});

test('SQL Agent Workbench capture exposes help without launching Chrome', async () => {
	const { stdout } = await execFileAsync(process.execPath, ['scripts/capture-sql-agent-workbench.mjs', '--help']);
	assert.match(stdout, /Running Nyala Vite URL/);
	assert.match(stdout, /--output-dir/);
});

test('native SQL Agent capture is embedded-only and fail-closed', async () => {
	const source = await import('node:fs/promises').then(fs =>
		fs.readFile(new URL('./capture-sql-agent-workbench-webdriver.mjs', import.meta.url), 'utf8')
	);
	assert.match(source, /--app-binary/);
	assert.match(source, /createEmbeddedWebdriverSession/);
	assert.match(source, /identifyEmbeddedWebview/);
	assert.match(source, /identifyEmbeddedWebview\(session\.capabilities, platform\)/);
	assert.doesNotMatch(source, /serveFrontendDist/);
	assert.doesNotMatch(source, /`\/session\/\$\{sessionId\}\/url`, 'POST'/);
	assert.match(source, /waitForAssetProtocolFrontend/);
	assert.match(source, /document\.readyState/);
	assert.match(source, /title\.includes\('Nyala Studio'\)/);
	assert.match(source, /sqlProductAwaitBootstrapCommandId = 'sqlStudio\.product\.awaitBootstrap'/);
	assert.match(
		source,
		/await dispatchCommand\(\s*sqlProductAwaitBootstrapCommandId,\s*\{\s*pollIntervalMs:\s*250\s*\}\s*\)/
	);
	assert.ok(
		source.indexOf('await dispatchCommand(sqlProductAwaitBootstrapCommandId') <
			source.indexOf('for (const requestedViewport of requestedViewports)')
	);
	assert.match(source, /execute\/sync/);
	assert.match(source, /syncEval\(expression\)/);
	assert.match(source, /syncScript\(script\)/);
	assert.match(source, /dispatchCommand\('sql\.agent\.openPanel'\)/);
	assert.doesNotMatch(source, /\/wdio\/eval/);
	assert.match(source, /kind: 'tauri-asset-protocol'/);
	assert.match(source, /beforeSnapshot/);
	assert.match(source, /afterScreenshot/);
	assert.match(source, /runNonceSha256/);
	assert.match(source, /engine: 'embedded-unverified'/);
	assert.match(source, /sql\.agent\.openPanel/);
	assert.match(source, /\/session\/\$\{sessionId\}\/actions/);
	assert.match(source, /createAgentWorkbenchSnapshotExpression/);
	assert.match(source, /hasVisiblePngDiversity/);
	assert.match(source, /status: 'blocked'/);
	assert.doesNotMatch(source, /safaridriver|msedgedriver|browserName: 'safari'/i);
});

test('native SQL Agent capture help is available without launching a binary', async () => {
	const { stdout } = await execFileAsync(process.execPath, [
		'scripts/capture-sql-agent-workbench-webdriver.mjs',
		'--help'
	]);
	assert.match(stdout, /Webdriver-enabled Nyala debug binary/);
	assert.match(stdout, /--platform/);
	assert.doesNotMatch(stdout, /--frontend-dist/);
	assert.match(stdout, /--screenshot-dir/);
	assert.match(stdout, /--manual-review/);
});

function createSnapshot() {
	const labels = ['Agent prompt', 'Agent task', 'Agent access mode', 'Start Agent run', 'Cancel Agent run'];
	return {
		workbenchReady: true,
		primarySidebarVisible: false,
		statusBar: { visible: true, rect: rect(0, 820, 390, 24) },
		agentRoot: { visible: true, rect: rect(0, 500, 390, 310) },
		statusElement: { visible: true, rect: rect(8, 792, 180, 18) },
		notificationOverlays: [],
		ariaLabels: [...requiredAgentAriaLabels],
		controls: labels.map((ariaLabel, index) => ({
			ariaLabel,
			disabled: ariaLabel === 'Cancel Agent run',
			visible: true,
			rect: rect(8, 520 + index * 40, 180, 32)
		})),
		status: 'Ready.',
		fatalScreen: false
	};
}

function rect(left, top, width, height) {
	return { left, top, right: left + width, bottom: top + height, width, height };
}

function createElement(elementRect, classes, severity) {
	return {
		classList: { contains: value => classes.includes(value) },
		disabled: false,
		getAttribute: () => null,
		getBoundingClientRect: () => elementRect,
		getClientRects: () => [elementRect],
		querySelector: selector => (severity && selector.includes(`codicon-${severity}`) ? {} : undefined),
		tagName: 'DIV'
	};
}
