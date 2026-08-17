import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import {
	hasVisiblePngDiversity,
	inspectPngPixels,
	validatePngViewportDimensions
} from './sql-result-grid-visual-png.mjs';

const execFileAsync = promisify(execFile);

test('visual capture harness exposes bounded workload and renderer controls', async () => {
	const source = await import('node:fs/promises').then(fs =>
		fs.readFile(new URL('./capture-sql-result-grid-visual.mjs', import.meta.url), 'utf8')
	);
	assert.match(source, /--screenshot-dir/);
	assert.match(source, /screenshotSha256/);
	assert.match(source, /screenshot-viewport/);
	assert.match(source, /screenshot-pixel-diversity/);
	assert.match(source, /renderer-identity/);
	assert.match(source, /header-sentinel/);
	assert.match(source, /visible-text/);
	assert.match(source, /browserTimeoutMs/);
	assert.match(source, /--remote-debugging-port=0/);
	assert.match(source, /Page\.captureScreenshot/);
	assert.match(source, /isBenchmarkResultForRun/);
	assert.doesNotMatch(source, /--dump-dom/);
	assert.doesNotMatch(source, /--virtual-time-budget/);
	assert.match(source, /Chromium headless screenshots/);
	assert.match(source, /separate platform evidence workflow/);
	assert.match(source, /1_000/);
	assert.match(source, /10_000/);
});

test('pixel analysis rejects a correctly-sized solid PNG', () => {
	const png = createSolidRgbPng(390, 420, [32, 32, 32]);
	const analysis = inspectPngPixels(png);
	assert.equal(analysis.width, 390);
	assert.equal(analysis.height, 420);
	assert.equal(analysis.distinctColorBuckets, 1);
	assert.equal(hasVisiblePngDiversity(analysis), false);
});

test('PNG viewport dimensions bind CSS pixels to device pixels with a bounded tolerance', () => {
	assert.deepEqual(
		validatePngViewportDimensions({ width: 2880, height: 840 }, { width: 1440, height: 420, devicePixelRatio: 2 }),
		{ passed: true, expectedWidth: 2880, expectedHeight: 840 }
	);
	assert.deepEqual(
		validatePngViewportDimensions({ width: 390, height: 420 }, { width: 1440, height: 420, devicePixelRatio: 1 }),
		{ passed: false, expectedWidth: 1440, expectedHeight: 420 }
	);
	assert.equal(
		validatePngViewportDimensions({ width: 1442, height: 418 }, { width: 1440, height: 420, devicePixelRatio: 1 })
			.passed,
		true
	);
	assert.equal(
		validatePngViewportDimensions({ width: 1443, height: 420 }, { width: 1440, height: 420, devicePixelRatio: 1 })
			.passed,
		false
	);
});

test('visual capture harness supports help without launching a browser', async () => {
	const { stdout } = await execFileAsync(process.execPath, ['scripts/capture-sql-result-grid-visual.mjs', '--help']);
	assert.match(stdout, /Usage:/);
	assert.match(stdout, /--repeat/);
	assert.match(stdout, /--screenshot-dir/);
});

function createSolidRgbPng(width, height, [red, green, blue]) {
	const row = Buffer.alloc(width * 3 + 1);
	for (let offset = 1; offset < row.byteLength; offset += 3) {
		row[offset] = red;
		row[offset + 1] = green;
		row[offset + 2] = blue;
	}
	const raw = Buffer.concat(Array.from({ length: height }, () => row));
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', header),
		pngChunk('IDAT', deflateSync(raw)),
		pngChunk('IEND', Buffer.alloc(0))
	]);
}

function pngChunk(type, data) {
	const chunk = Buffer.alloc(data.byteLength + 12);
	chunk.writeUInt32BE(data.byteLength, 0);
	chunk.write(type, 4, 4, 'ascii');
	data.copy(chunk, 8);
	return chunk;
}

test('visual capture harness rejects duplicate renderers and excessive repeats', async () => {
	await assert.rejects(
		execFileAsync(process.execPath, [
			'scripts/capture-sql-result-grid-visual.mjs',
			'--renderer',
			'native,native',
			'--workload',
			'narrow-panel'
		]),
		/duplicate values/
	);
	await assert.rejects(
		execFileAsync(process.execPath, [
			'scripts/capture-sql-result-grid-visual.mjs',
			'--renderer',
			'native',
			'--workload',
			'narrow-panel',
			'--repeat',
			'6'
		]),
		/between 1 and 5/
	);
});

test('native narrow-panel capture verifies semantic sentinels and PNG evidence', async t => {
	const chrome = process.env.NYALA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
	try {
		await readFile(chrome);
	} catch {
		t.skip('Chrome is unavailable for the local integration capture.');
		return;
	}
	const root = await mkdtemp(join(tmpdir(), 'nyala-sql-result-visual-test-'));
	try {
		const output = join(root, 'visual-evidence.json');
		await execFileAsync(
			process.execPath,
			[
				'scripts/capture-sql-result-grid-visual.mjs',
				'--renderer',
				'native',
				'--workload',
				'narrow-panel',
				'--output',
				output,
				'--screenshot-dir',
				join(root, 'screenshots')
			],
			{ env: { ...process.env, NYALA_CHROME: chrome }, timeout: 60_000 }
		);
		const report = JSON.parse(await readFile(output, 'utf8'));
		assert.equal(report.status, 'ready');
		assert.equal(report.artifactCount, 1);
		assert.ok(report.artifacts[0].visualChecks.every(check => check.passed));
		assert.equal(report.artifacts[0].record.visualProbe.headerText, 'column_0');
		assert.match(report.artifacts[0].screenshotSha256, /^[a-f0-9]{64}$/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
