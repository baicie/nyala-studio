import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('merges platform evidence and preserves fail-closed entries', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-platform-evidence-test-'));
	try {
		const macos = join(root, 'macos.json');
		const output = join(root, 'merged.json');
		await writeFile(macos, JSON.stringify({ status: 'ready', runs: 5, summary: {} }), 'utf8');
		await execFileAsync(process.execPath, [
			'scripts/merge-sql-result-grid-platform-evidence.mjs',
			'--macos',
			macos,
			'--output',
			output
		]);
		const report = JSON.parse(await readFile(output, 'utf8'));
		assert.equal(report.macosWebKit.status, 'ready');
		assert.equal(report.macosWebKit.label, 'macOS WebKit');
		assert.equal(report.macosWebKit.artifactDirectory, '.');
		assert.equal(report.windowsWebView2.status, 'blocked');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
