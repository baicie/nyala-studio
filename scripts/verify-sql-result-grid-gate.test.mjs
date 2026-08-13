import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

const verifierPath = new URL('./verify-sql-result-grid-gate.mjs', import.meta.url).pathname;

function createSyntheticBenchmark() {
	const summary = {
		'1k-x-20/native': { scrollP95Ms: { median: 10, p95: 12 } },
		'1k-x-20/workbench-table': { scrollP95Ms: { median: 12, p95: 14 } },
		'1k-x-20/zeus': { scrollP95Ms: { median: 10.5, p95: 12.5 } },
		'10k-x-50/native': { scrollP95Ms: { median: 10, p95: 12 } },
		'10k-x-50/workbench-table': { scrollP95Ms: { median: 12, p95: 14 } },
		'10k-x-50/zeus': { scrollP95Ms: { median: 7, p95: 9 } }
	};
	return {
		version: 1,
		browser: 'synthetic-gate-fixture',
		repeat: 1,
		summary,
		records: []
	};
}

function createEmbeddedPlatformEvidence() {
	const summary = createSyntheticBenchmark().summary;
	return {
		macosWebKit: {
			status: 'ready',
			runs: 5,
			driverProvider: 'embedded',
			nativeWebView: true,
			nativeWebView2: false,
			engine: 'wkwebview-embedded',
			browser: 'webkit',
			platformName: 'macos',
			reason: 'recorded in the Nyala WKWebView host',
			summary
		},
		windowsWebView2: {
			status: 'ready',
			runs: 5,
			driverProvider: 'embedded',
			nativeWebView: true,
			nativeWebView2: true,
			engine: 'webview2-embedded',
			browser: 'msedge',
			platformName: 'windows',
			reason: 'recorded in the Nyala WebView2 host',
			summary
		}
	};
}

async function writeSyntheticBenchmark(root) {
	const benchmarkPath = join(root, 'benchmark.json');
	await writeFile(benchmarkPath, `${JSON.stringify(createSyntheticBenchmark())}\n`, 'utf8');
	return benchmarkPath;
}

test('Z1.3 gate verifier records the pre-registered primary metric and platform probes', async () => {
	const source = await readFile(new URL('./verify-sql-result-grid-gate.mjs', import.meta.url), 'utf8');
	assert.match(source, /scrollP95Ms/);
	assert.match(source, /oneKInteractionRegressionMax/);
	assert.match(source, /tenKPrimaryImprovementMin/);
	assert.match(source, /macosWebKit/);
	assert.match(source, /windowsWebView2/);
	assert.match(source, /NO-GO/);
});

test('Z1.3 verifier does not add a production Zeus dependency', async () => {
	const source = await readFile(new URL('./verify-sql-result-grid-gate.mjs', import.meta.url), 'utf8');
	assert.doesNotMatch(source, /pnpm add|package\.json|pnpm-lock/);
});

test('Z1.3 verifier accepts embedded WKWebView and WebView2 evidence', async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), 'nyala-z1-gate-test-'));
	const evidencePath = join(tempRoot, 'platform-evidence.json');
	const outputPath = join(tempRoot, 'gate.json');
	const benchmarkPath = await writeSyntheticBenchmark(tempRoot);
	await writeFile(evidencePath, `${JSON.stringify(createEmbeddedPlatformEvidence())}\n`, 'utf8');
	try {
		const { stdout } = await execFileAsync(process.execPath, [verifierPath, benchmarkPath, outputPath], {
			env: { ...process.env, NYALA_PLATFORM_EVIDENCE: evidencePath },
			cwd: new URL('..', import.meta.url).pathname
		});
		assert.match(stdout, /GO:/);
		const report = JSON.parse(await readFile(outputPath, 'utf8'));
		assert.equal(report.decision, 'GO');
		assert.equal(report.platformEvidence.macosWebKit.runs, 5);
		assert.equal(report.platformEvidence.windowsWebView2.runs, 5);
		assert.equal(report.platformMetricChecks.length, 18);
		assert.ok(report.platformMetricChecks.every(check => check.passed));
		assert.match(report.platformMetricChecks[0].reason, /embedded WKWebView identity verified/);
		assert.match(report.platformMetricChecks[9].reason, /embedded WebView2 identity verified/);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test('Z1.3 verifier rejects legacy SafariDriver evidence', async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), 'nyala-z1-wkwebview-identity-test-'));
	const evidencePath = join(tempRoot, 'platform-evidence.json');
	const outputPath = join(tempRoot, 'gate.json');
	const benchmarkPath = await writeSyntheticBenchmark(tempRoot);
	const evidence = createEmbeddedPlatformEvidence();
	evidence.macosWebKit = {
		...evidence.macosWebKit,
		driverProvider: 'external',
		nativeWebView: false,
		engine: 'safari-webdriver',
		browser: 'safari',
		reason: 'legacy SafariDriver diagnostic run'
	};
	await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, 'utf8');
	try {
		await assert.rejects(
			execFileAsync(process.execPath, [verifierPath, benchmarkPath, outputPath], {
				env: { ...process.env, NYALA_PLATFORM_EVIDENCE: evidencePath },
				cwd: new URL('..', import.meta.url).pathname
			})
		);
		const report = JSON.parse(await readFile(outputPath, 'utf8'));
		assert.equal(report.decision, 'NO-GO');
		assert.match(report.reasons.join('\n'), /macOS WebKit: embedded WKWebView identity mismatch/);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test('Z1.3 verifier rejects legacy EdgeDriver evidence', async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), 'nyala-z1-webview2-identity-test-'));
	const evidencePath = join(tempRoot, 'platform-evidence.json');
	const outputPath = join(tempRoot, 'gate.json');
	const benchmarkPath = await writeSyntheticBenchmark(tempRoot);
	const evidence = createEmbeddedPlatformEvidence();
	evidence.windowsWebView2 = {
		...evidence.windowsWebView2,
		driverProvider: 'external',
		nativeWebView: false,
		nativeWebView2: false,
		engine: 'msedgedriver',
		reason: 'EdgeDriver diagnostic run'
	};
	await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, 'utf8');
	try {
		await assert.rejects(
			execFileAsync(process.execPath, [verifierPath, benchmarkPath, outputPath], {
				env: { ...process.env, NYALA_PLATFORM_EVIDENCE: evidencePath },
				cwd: new URL('..', import.meta.url).pathname
			})
		);
		const report = JSON.parse(await readFile(outputPath, 'utf8'));
		assert.equal(report.decision, 'NO-GO');
		assert.match(report.reasons.join('\n'), /Windows WebView2: embedded WebView2 identity mismatch/);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});
