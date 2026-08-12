#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scriptArgs = process.argv.slice(2).filter(argument => argument !== '--');
const inputPath = resolve(scriptArgs[0] ?? 'docs/sql-mvp-phases/phase-z1-benchmark.json');
const outputPath = resolve(scriptArgs[1] ?? 'docs/sql-mvp-phases/phase-z1-gate.json');
const platformEvidencePath = scriptArgs[2] ? resolve(scriptArgs[2]) : process.env.NYALA_PLATFORM_EVIDENCE;
const benchmark = JSON.parse(await readFile(inputPath, 'utf8'));
const platformEvidence = platformEvidencePath
	? await loadPlatformEvidence(platformEvidencePath)
	: {
			macosWebKit: probeSafariDriver(),
			windowsWebView2: probeWebView2Driver()
		};
const metricChecks = evaluateMetrics(benchmark);
const dependencyCheck = {
	bundleGzipBytes: 24_260,
	budgetBytes: 30_000,
	passed: 24_260 <= 30_000,
	source: 'phase-z1-spike-verification.md Z1.1 audit'
};
const platformMetricChecks = Object.values(platformEvidence).flatMap(evidence => evaluatePlatformMetrics(evidence));
const reasons = [
	...metricChecks.filter(check => !check.passed).map(check => check.reason),
	...platformMetricChecks.filter(check => !check.passed).map(check => check.reason),
	...Object.values(platformEvidence)
		.filter(evidence => evidence.status !== 'ready' || evidence.runs < 5)
		.map(evidence => `${evidence.label}: ${evidence.reason} (${evidence.runs}/5 runs recorded)`),
	...(dependencyCheck.passed
		? []
		: [`gzip increment ${dependencyCheck.bundleGzipBytes} exceeds ${dependencyCheck.budgetBytes} bytes`])
];
const report = {
	version: 1,
	generatedAt: new Date().toISOString(),
	decision: reasons.length === 0 ? 'GO' : 'NO-GO',
	input: inputPath,
	benchmark: {
		repeat: benchmark.repeat,
		recordCount: benchmark.records?.length ?? 0,
		browser: benchmark.browser
	},
	thresholds: {
		oneKInteractionRegressionMax: 0.1,
		tenKPrimaryImprovementMin: 0.2,
		primaryMetric: 'scrollP95Ms',
		gzipBudgetBytes: dependencyCheck.budgetBytes
	},
	metricChecks,
	platformMetricChecks,
	dependencyCheck,
	platformEvidence,
	reasons
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`${report.decision}: ${outputPath}`);
for (const reason of reasons) console.log(`- ${reason}`);
process.exitCode = report.decision === 'GO' ? 0 : 1;

function evaluateMetrics(report) {
	const summary = report.summary ?? {};
	const oneK = getSummary(summary, '1k-x-20');
	const tenK = getSummary(summary, '10k-x-50');
	const checks = [];
	if (oneK) {
		const baseline = bestNonZeus(oneK, 'scrollP95Ms');
		const zeus = oneK.zeus?.scrollP95Ms?.median;
		checks.push(createRatioCheck('1k-x-20 scroll interaction', baseline, zeus, 0.1, 'no regression over 10%'));
	} else {
		checks.push({ id: '1k-x-20', passed: false, reason: 'missing 1k-x-20 benchmark summary' });
	}
	if (tenK) {
		const baseline = bestNonZeus(tenK, 'scrollP95Ms');
		const zeus = tenK.zeus?.scrollP95Ms?.median;
		const improvement = baseline > 0 && Number.isFinite(zeus) ? (baseline - zeus) / baseline : Number.NaN;
		checks.push({
			id: '10k-x-50-primary',
			passed: Number.isFinite(improvement) && improvement >= 0.2,
			baseline,
			zeus,
			improvement,
			reason: Number.isFinite(improvement)
				? improvement >= 0.2
					? `10k-x-50 scroll p95 improvement ${(improvement * 100).toFixed(1)}% meets the 20% threshold`
					: `10k-x-50 scroll p95 improvement ${(improvement * 100).toFixed(1)}% is below 20%`
				: 'missing 10k-x-50 scroll p95 benchmark summary'
		});
	} else {
		checks.push({ id: '10k-x-50-primary', passed: false, reason: 'missing 10k-x-50 benchmark summary' });
	}
	return checks;
}

function evaluatePlatformMetrics(evidence) {
	if (evidence.status !== 'ready' || evidence.runs < 5) {
		return [];
	}
	const identityCheck = evaluatePlatformIdentity(evidence);
	if (!evidence.summary || typeof evidence.summary !== 'object') {
		return [
			...(identityCheck ? [identityCheck] : []),
			{
				id: `${evidence.label}-summary`,
				passed: false,
				reason: `${evidence.label}: ready evidence must include renderer summary metrics`
			}
		];
	}
	const metricChecks = evaluateMetrics({ summary: evidence.summary }).map(check => ({
		...check,
		id: `${evidence.label}-${check.id}`,
		reason: `${evidence.label}: ${check.reason}`
	}));
	const longTailChecks = [];
	for (const workloadId of ['1k-x-20', '10k-x-50']) {
		for (const renderer of ['native', 'workbench-table', 'zeus']) {
			const metric = evidence.summary[`${workloadId}/${renderer}`]?.scrollP95Ms;
			const passed = Number.isFinite(metric?.median) && Number.isFinite(metric?.p95);
			longTailChecks.push({
				id: `${evidence.label}-${workloadId}-${renderer}-long-tail`,
				passed,
				median: metric?.median,
				p95: metric?.p95,
				reason: passed
					? `${evidence.label}: ${workloadId}/${renderer} includes median and p95 scroll metrics`
					: `${evidence.label}: ${workloadId}/${renderer} is missing median or p95 scroll metrics`
			});
		}
	}
	return [...(identityCheck ? [identityCheck] : []), ...metricChecks, ...longTailChecks];
}

function evaluatePlatformIdentity(evidence) {
	const expected =
		evidence.label === 'macOS WebKit'
			? {
					driverProvider: 'embedded',
					nativeWebView: true,
					nativeWebView2: false,
					engine: 'wkwebview-embedded',
					browser: 'webkit',
					platformName: 'macos'
				}
			: evidence.label === 'Windows WebView2'
				? {
						driverProvider: 'embedded',
						nativeWebView: true,
						nativeWebView2: true,
						engine: 'webview2-embedded',
						browser: 'msedge',
						platformName: 'windows'
					}
				: undefined;
	if (!expected) {
		return {
			id: `${evidence.label}-identity`,
			passed: false,
			reason: `${evidence.label}: unsupported platform evidence label`
		};
	}
	const mismatches = Object.entries(expected)
		.filter(([field, expectedValue]) => evidence[field] !== expectedValue)
		.map(
			([field, expectedValue]) =>
				`${field}=${formatIdentityValue(evidence[field])} (expected ${formatIdentityValue(expectedValue)})`
		);
	const webViewName = evidence.label === 'macOS WebKit' ? 'WKWebView' : 'WebView2';
	return {
		id: `${evidence.label}-identity`,
		passed: mismatches.length === 0,
		reason:
			mismatches.length === 0
				? `${evidence.label}: embedded ${webViewName} identity verified`
				: `${evidence.label}: embedded ${webViewName} identity mismatch (${mismatches.join(', ')})`
	};
}

function formatIdentityValue(value) {
	if (value === undefined) return 'missing';
	return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function getSummary(summary, workloadId) {
	const result = {};
	for (const renderer of ['native', 'workbench-table', 'zeus']) {
		const value = summary[`${workloadId}/${renderer}`];
		if (value) result[renderer] = value;
	}
	return Object.keys(result).length === 3 ? result : undefined;
}

function bestNonZeus(summary, metric) {
	return Math.min(
		summary.native?.[metric]?.median ?? Number.POSITIVE_INFINITY,
		summary['workbench-table']?.[metric]?.median ?? Number.POSITIVE_INFINITY
	);
}

function createRatioCheck(id, baseline, zeus, maxRegression, label) {
	const ratio =
		Number.isFinite(zeus) && Number.isFinite(baseline) && baseline > 0 ? (zeus - baseline) / baseline : Number.NaN;
	return {
		id,
		passed: Number.isFinite(ratio) && ratio <= maxRegression,
		baseline,
		zeus,
		regression: ratio,
		reason: Number.isFinite(ratio)
			? ratio <= maxRegression
				? `${id} passed with ${(ratio * 100).toFixed(1)}% regression against baseline`
				: `${id} regression ${(ratio * 100).toFixed(1)}% exceeds ${label}`
			: `${id} metric is unavailable`
	};
}

function probeSafariDriver() {
	const label = 'macOS WebKit';
	try {
		const response = execFileSync(
			'curl',
			[
				'-sS',
				'-X',
				'POST',
				'http://127.0.0.1:4444/session',
				'-H',
				'Content-Type: application/json',
				'--data',
				'{"capabilities":{"alwaysMatch":{"browserName":"safari"}}}'
			],
			{ encoding: 'utf8', timeout: 3_000 }
		);
		const payload = JSON.parse(response);
		if (payload.value?.sessionId || payload.value?.['sessionId']) {
			return {
				label,
				status: 'ready',
				runs: 0,
				reason: 'Safari WebDriver session created; five workload runs are still required.'
			};
		}
		return {
			label,
			status: 'blocked',
			runs: 0,
			reason: payload.value?.message ?? 'Safari WebDriver did not create a session.'
		};
	} catch (error) {
		return { label, status: 'blocked', runs: 0, reason: error instanceof Error ? error.message : String(error) };
	}
}

async function loadPlatformEvidence(filePath) {
	try {
		const value = JSON.parse(await readFile(filePath, 'utf8'));
		return {
			macosWebKit: normalizePlatformEvidence(value.macosWebKit, 'macOS WebKit'),
			windowsWebView2: normalizePlatformEvidence(value.windowsWebView2, 'Windows WebView2')
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			macosWebKit: { label: 'macOS WebKit', status: 'blocked', runs: 0, reason: `evidence file failed: ${reason}` },
			windowsWebView2: {
				label: 'Windows WebView2',
				status: 'blocked',
				runs: 0,
				reason: `evidence file failed: ${reason}`
			}
		};
	}
}

function normalizePlatformEvidence(value, label) {
	if (!value || typeof value !== 'object') {
		return { label, status: 'blocked', runs: 0, reason: 'platform evidence entry is missing' };
	}
	const status = value.status === 'ready' ? 'ready' : 'blocked';
	const runs = Number.isInteger(value.runs) && value.runs >= 0 ? value.runs : 0;
	const summary = value.summary && typeof value.summary === 'object' ? value.summary : undefined;
	return {
		...value,
		label,
		status,
		runs,
		reason: typeof value.reason === 'string' ? value.reason : 'platform evidence has no reason',
		...(summary ? { summary } : {})
	};
}

function probeWebView2Driver() {
	const label = 'Windows WebView2';
	const driver = process.env.WEBVIEW2_DRIVER ?? 'msedgedriver';
	try {
		const version = execFileSync('sh', ['-c', `command -v ${quoteShell(driver)}`], {
			encoding: 'utf8',
			timeout: 3_000
		}).trim();
		return {
			label,
			status: 'ready',
			runs: 0,
			driver: version,
			reason: 'WebView2 driver is available; five workload runs are still required.'
		};
	} catch {
		return { label, status: 'blocked', runs: 0, reason: `${driver} is not available in this environment.` };
	}
}

function quoteShell(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
