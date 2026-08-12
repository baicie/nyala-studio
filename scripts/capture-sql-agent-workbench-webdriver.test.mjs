import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('native Agent evidence runner writes a blocked manifest when the binary cannot start', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-agent-native-test-'));
	try {
		const output = join(root, 'evidence.json');
		await assert.rejects(
			execFileAsync(process.execPath, [
				'scripts/capture-sql-agent-workbench-webdriver.mjs',
				'--app-binary',
				join(root, 'missing-nyala'),
				'--platform',
				process.platform === 'win32' ? 'windows' : 'macos',
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
