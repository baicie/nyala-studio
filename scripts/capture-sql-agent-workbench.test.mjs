import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import {
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
	assert.match(stdout, /--screenshot-dir/);
});

function createSnapshot() {
	const labels = ['Agent prompt', 'Agent task', 'Agent access mode', 'Start Agent run', 'Cancel Agent run'];
	return {
		workbenchReady: true,
		primarySidebarVisible: false,
		agentRoot: { visible: true, rect: rect(0, 500, 390, 344) },
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
