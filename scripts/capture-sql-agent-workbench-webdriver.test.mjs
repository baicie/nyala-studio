import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { shouldOpenAgentPanel } from './capture-sql-agent-workbench-webdriver.mjs';
import { scaleCssViewportToPhysicalWindowRect } from './tauri-embedded-webdriver.mjs';

test('native Agent panel command runs only when the panel is hidden', () => {
	assert.equal(shouldOpenAgentPanel(false), true);
	assert.equal(shouldOpenAgentPanel(true), false);
});

test('CSS viewport dimensions are converted to physical embedded window pixels', () => {
	assert.deepEqual(scaleCssViewportToPhysicalWindowRect({ width: 1440, height: 900 }, 2), {
		width: 2880,
		height: 1800
	});
	assert.deepEqual(scaleCssViewportToPhysicalWindowRect({ width: 390, height: 844 }, 1.25), {
		width: 488,
		height: 1055
	});
	assert.deepEqual(scaleCssViewportToPhysicalWindowRect({ width: 390, height: 844 }, 1), { width: 390, height: 844 });
});

test('CSS viewport conversion rejects invalid dimensions and DPR', () => {
	assert.throws(
		() => scaleCssViewportToPhysicalWindowRect({ width: 0, height: 844 }, 2),
		/CSS viewport must have positive finite dimensions/
	);
	assert.throws(
		() => scaleCssViewportToPhysicalWindowRect({ width: 390, height: 844 }, 0),
		/devicePixelRatio must be a positive finite number/
	);
});

const execFileAsync = promisify(execFile);

test('native Agent evidence runner writes a blocked manifest when the binary cannot start', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-agent-native-test-'));
	try {
		const output = join(root, 'evidence.json');
		const frontendDist = join(root, 'dist');
		await mkdir(frontendDist);
		await writeFile(join(frontendDist, 'index.html'), '<!doctype html><title>Nyala</title>');
		await assert.rejects(
			execFileAsync(process.execPath, [
				'scripts/capture-sql-agent-workbench-webdriver.mjs',
				'--app-binary',
				join(root, 'missing-nyala'),
				'--platform',
				process.platform === 'win32' ? 'windows' : 'macos',
				'--frontend-dist',
				frontendDist,
				'--output',
				output,
				'--screenshot-dir',
				join(root, 'screenshots'),
				'--startup-timeout-ms',
				'10000'
			])
		);
		const report = JSON.parse(await readFile(output, 'utf8'));
		assert.equal(report.status, 'blocked');
		assert.equal(report.driverProvider, 'embedded');
		assert.equal(report.nativeWebView, false);
		assert.equal(report.frontendSource.kind, 'local-dist-server');
		assert.deepEqual(report.artifacts, []);
		assert.match(report.reason, /ENOENT|spawn|timed out/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('native Agent evidence runner rejects non-native platforms before starting a binary', async () => {
	await assert.rejects(
		execFileAsync(process.execPath, [
			'scripts/capture-sql-agent-workbench-webdriver.mjs',
			'--app-binary',
			'/tmp/does-not-start',
			'--platform',
			'linux'
		]),
		/platform must be macos or windows/
	);
});

test('native Agent evidence records physical viewport and fail-closed keyboard mode', async () => {
	const source = await readFile(new URL('./capture-sql-agent-workbench-webdriver.mjs', import.meta.url), 'utf8');
	assert.match(source, /scaleCssViewportToPhysicalWindowRect/);
	assert.match(source, /window\.devicePixelRatio/);
	assert.match(source, /requestedPhysicalRect/);
	assert.match(source, /requestedCssViewport/);
	assert.match(source, /keyboardMode/);
	assert.match(source, /webdriver-actions-synthetic/);
	assert.match(source, /native-keyboard-evidence/);
	assert.match(source, /native system Tab traversal/);
});
