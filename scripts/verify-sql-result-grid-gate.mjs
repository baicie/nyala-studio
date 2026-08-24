#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { gzipSync } from 'node:zlib';
import {
	createBalancedBenchmarkPlan,
	EXECUTION_ORDER,
	expectedScrollViewportHeight,
	expectedVisibleRowIndex,
	isValidVisibleRowIndex,
	maximumVirtualRenderedRows,
	maximumScrollOffset,
	MEASUREMENT_CONTRACT_VERSION,
	SCROLL_COMMIT_BOUNDARY,
	SCROLL_COMMIT_ATTEMPTS,
	SCROLL_OFFSET_TOLERANCE,
	SCROLL_ROW_TOLERANCE,
	SCROLL_TARGET_RATIOS,
	SCROLL_VIEWPORT_TOLERANCE,
	SCROLL_TIMING_TOLERANCE_MS,
	scrollTargetOffset,
	isValidWorkbenchTableRendererImplementation
} from './sql-result-grid-benchmark-contract.mjs';
import {
	hasVisiblePngDiversity,
	inspectPngPixels,
	validatePngViewportDimensions
} from './sql-result-grid-visual-png.mjs';
import { inspectSqlResultGridRunMarker, SQL_RESULT_GRID_RUN_MARKER_VERSION } from './sql-result-grid-run-marker.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const expectedWorkloads = new Map(
	[
		{ id: '1k-x-20', rows: 1_000, columns: 20, width: 1_440, height: 420, wide: false },
		{ id: '10k-x-50', rows: 10_000, columns: 50, width: 1_440, height: 420, wide: false },
		{ id: 'wide-columns', rows: 1_000, columns: 20, width: 1_440, height: 420, wide: true },
		{ id: 'narrow-panel', rows: 1_000, columns: 20, width: 390, height: 420, wide: false }
	].map(workload => [workload.id, workload])
);
const expectedRenderers = ['native', 'workbench-table', 'zeus'];
const expectedZeusPackage = {
	name: '@zeus-web/data-grid',
	version: '0.1.0-beta.4',
	license: 'MIT',
	integrity: 'sha512-hiaTjf29UY8E/hrMkDm81nVORNWSrqTcInJXQcxZ7azfCfVkN82M8UMe/GDlbQBWksJetq8lT3GbapJEbqZbHA==',
	unpackedSize: 341_232,
	dependencies: {
		'@zeus-js/output-react-wrapper': '0.1.1-beta.2',
		'@zeus-js/output-vue-wrapper': '0.1.1-beta.2',
		'@zeus-js/runtime-dom': '0.1.1-beta.2',
		'@zeus-js/web-c-runtime': '0.1.1-beta.2',
		'@zeus-web/virtual': '0.1.0-beta.4',
		'@zeus-web/zeus-compat': '0.1.0-beta.4'
	},
	peerDependencies: {
		'@zeus-js/zeus': '0.1.1-beta.2',
		react: '>=18 || >=19',
		vue: '>=3'
	}
};
const scriptArgs = process.argv.slice(2).filter(argument => argument !== '--');
const inputPath = resolve(scriptArgs[0] ?? 'docs/sql-mvp-phases/phase-z1-benchmark.json');
const outputPath = resolve(scriptArgs[1] ?? 'docs/sql-mvp-phases/phase-z1-gate.json');
const platformEvidencePath = scriptArgs[2] ? resolve(scriptArgs[2]) : process.env.NYALA_PLATFORM_EVIDENCE;
const zeusAuditPath = process.env.NYALA_ZEUS_AUDIT_EVIDENCE
	? resolve(process.env.NYALA_ZEUS_AUDIT_EVIDENCE)
	: undefined;
const expectedProvenance = createExpectedProvenance();
const benchmarkBytes = await readFile(inputPath);
const benchmark = JSON.parse(benchmarkBytes.toString('utf8'));
const platformEvidence = platformEvidencePath
	? await loadPlatformEvidence(platformEvidencePath)
	: {
			macosWebKit: probeSafariDriver(),
			windowsWebView2: probeWebView2Driver()
		};
const platformEvidenceRoot = platformEvidencePath ? dirname(resolve(platformEvidencePath)) : undefined;
const platformIntegrity = Object.fromEntries(
	await Promise.all(
		Object.entries(platformEvidence).map(async ([key, evidence]) => [
			key,
			await validatePlatformEvidence(evidence, platformEvidenceRoot)
		])
	)
);
const benchmarkIntegrity = validateBenchmarkEvidence(benchmark, expectedProvenance);
const metricChecks = evaluateMetrics({ summary: benchmarkIntegrity.summary });
const dependencyCheck = await evaluateZeusAudit(zeusAuditPath, expectedProvenance);
const platformMetricChecks = Object.entries(platformEvidence).flatMap(([key, evidence]) =>
	evaluatePlatformMetrics({ ...evidence, summary: platformIntegrity[key].summary })
);
const platformEvidenceChecks = Object.values(platformIntegrity).flatMap(result => result.checks);
const runIdentityChecks = evaluateGlobalRunTokenUniqueness(benchmark, platformEvidence);
const provenanceChecks = [
	evaluateTrustedExpectedProvenance(expectedProvenance),
	...evaluatePlatformProvenance(platformEvidence, expectedProvenance),
	...evaluateZeusBundleBinding(benchmark, platformEvidence, dependencyCheck),
	...evaluateWorkbenchTableBundleBinding(benchmark, platformEvidence)
];
const benchmarkEvidenceChecks = benchmarkIntegrity.checks;
const reasons = [
	...metricChecks.filter(check => !check.passed).map(check => check.reason),
	...benchmarkEvidenceChecks.filter(check => !check.passed).map(check => check.reason),
	...platformMetricChecks.filter(check => !check.passed).map(check => check.reason),
	...platformEvidenceChecks.filter(check => !check.passed).map(check => check.reason),
	...runIdentityChecks.filter(check => !check.passed).map(check => check.reason),
	...provenanceChecks.filter(check => !check.passed).map(check => check.reason),
	...Object.values(platformEvidence)
		.filter(evidence => evidence.status !== 'ready' || evidence.runs < 5)
		.map(evidence => `${evidence.label}: ${evidence.reason} (${evidence.runs}/5 runs recorded)`),
	...(dependencyCheck.passed ? [] : [dependencyCheck.reason])
];
const report = {
	version: 2,
	generatedAt: new Date().toISOString(),
	sourceRevision: expectedProvenance.sourceRevision,
	decision: reasons.length === 0 ? 'GO' : 'NO-GO',
	input: displayPath(inputPath),
	benchmark: {
		measurementContractVersion: benchmark.measurementContractVersion,
		scrollCommitBoundary: benchmark.scrollCommitBoundary,
		executionOrder: benchmark.executionOrder,
		workbenchTableImplementation: benchmark.workbenchTableImplementation,
		repeat: benchmark.repeat,
		recordCount: benchmark.records?.length ?? 0,
		browser: displayExecutable(benchmark.browser),
		sha256: createHash('sha256').update(benchmarkBytes).digest('hex'),
		provenance: benchmark.provenance
	},
	thresholds: {
		oneKInteractionRegressionMax: 0.1,
		tenKPrimaryImprovementMin: 0.2,
		primaryMetric: 'scrollP95Ms',
		gzipBudgetBytes: dependencyCheck.budgetBytes
	},
	metricChecks,
	benchmarkEvidenceChecks,
	platformMetricChecks,
	platformEvidenceChecks,
	runIdentityChecks,
	provenanceChecks,
	dependencyCheck,
	platformEvidence,
	reasons
};
await writeFile(outputPath, `${JSON.stringify(report, null, '\t')}\n`, 'utf8');
console.log(`${report.decision}: ${outputPath}`);
for (const reason of reasons) console.log(`- ${reason}`);
process.exitCode = report.decision === 'GO' ? 0 : 1;

function createExpectedProvenance() {
	const sourceRevision =
		process.env.NYALA_EXPECTED_SOURCE_REVISION ??
		execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
	const workflowRunAttempt = Number(process.env.NYALA_EXPECTED_WORKFLOW_RUN_ATTEMPT);
	return Object.fromEntries(
		Object.entries({
			repository: process.env.NYALA_EXPECTED_REPOSITORY,
			sourceRevision,
			sourceRef: process.env.NYALA_EXPECTED_SOURCE_REF,
			workflowRunId: process.env.NYALA_EXPECTED_WORKFLOW_RUN_ID,
			workflowRunAttempt:
				Number.isInteger(workflowRunAttempt) && workflowRunAttempt > 0 ? workflowRunAttempt : undefined
		}).filter(([, value]) => value !== undefined && value !== '')
	);
}

function evaluateTrustedExpectedProvenance(expected) {
	const fields = [
		['repository', 'NYALA_EXPECTED_REPOSITORY', isRepository],
		['sourceRevision', 'NYALA_EXPECTED_SOURCE_REVISION', isGitRevision],
		['sourceRef', 'NYALA_EXPECTED_SOURCE_REF', isSourceRef],
		['workflowRunId', 'NYALA_EXPECTED_WORKFLOW_RUN_ID', isWorkflowRunId],
		['workflowRunAttempt', 'NYALA_EXPECTED_WORKFLOW_RUN_ATTEMPT', isWorkflowRunAttempt]
	];
	const missing = fields
		.filter(([, environmentName]) => process.env[environmentName] === undefined || process.env[environmentName] === '')
		.map(([field]) => field);
	const invalid = fields.filter(([field, , validate]) => !validate(expected[field])).map(([field]) => field);
	const passed = missing.length === 0 && invalid.length === 0;
	return {
		id: 'trusted-expected-workflow-provenance',
		passed,
		reason: passed
			? 'trusted expected workflow provenance is complete'
			: `trusted expected workflow provenance is missing or invalid (${[
					...missing.map(field => `${field}:missing`),
					...invalid.map(field => `${field}:invalid`)
				].join(', ')})`
	};
}

function evaluatePlatformProvenance(platforms, expected) {
	const entries = [platforms.macosWebKit, platforms.windowsWebView2];
	const checks = entries.map(evidence => {
		const provenance = evidence.provenance;
		const mismatches = validateProvenanceFields(provenance, expected, {
			requireBinarySha256: true,
			requireZeusBundleSha256: true,
			requireWorkbenchTableBundleSha256: true
		});
		return {
			id: `${evidence.label}-provenance`,
			passed: mismatches.length === 0,
			reason:
				mismatches.length === 0
					? `${evidence.label}: source and binary provenance verified`
					: `${evidence.label}: provenance mismatch (${mismatches.join(', ')})`
		};
	});
	for (const field of [
		'repository',
		'sourceRevision',
		'sourceRef',
		'workflowRunId',
		'workflowRunAttempt',
		'zeusBundleSha256',
		'workbenchTableBundleSha256'
	]) {
		const values = entries.map(evidence => evidence.provenance?.[field]);
		const passed = values[0] !== undefined && values[0] === values[1];
		checks.push({
			id: `platform-provenance-${field}`,
			passed,
			reason: passed
				? `macOS WebKit and Windows WebView2 share ${field}`
				: `macOS WebKit and Windows WebView2 ${field} values do not match`
		});
	}
	return checks;
}

function isRepository(value) {
	return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function isGitRevision(value) {
	return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}

function isSourceRef(value) {
	return typeof value === 'string' && /^refs\/[A-Za-z0-9._/-]+$/.test(value);
}

function isWorkflowRunId(value) {
	return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

function isWorkflowRunAttempt(value) {
	return Number.isInteger(value) && value > 0;
}

function isSha256(value) {
	return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validateBenchmarkEvidence(report, expected) {
	const checks = [
		{
			id: 'chromium-benchmark-schema-version',
			passed: report.version === 1,
			reason:
				report.version === 1
					? 'Chromium benchmark version 1 verified'
					: `Chromium benchmark version is ${report.version ?? 'missing'}, expected 1`
		},
		{
			id: 'chromium-benchmark-measurement-contract-version',
			passed: report.measurementContractVersion === MEASUREMENT_CONTRACT_VERSION,
			reason:
				report.measurementContractVersion === MEASUREMENT_CONTRACT_VERSION
					? `Chromium benchmark measurement contract version ${MEASUREMENT_CONTRACT_VERSION} verified`
					: `Chromium benchmark measurement contract version is ${report.measurementContractVersion ?? 'missing'}, expected ${MEASUREMENT_CONTRACT_VERSION}`
		},
		{
			id: 'chromium-benchmark-scroll-commit-boundary',
			passed: report.scrollCommitBoundary === SCROLL_COMMIT_BOUNDARY,
			reason:
				report.scrollCommitBoundary === SCROLL_COMMIT_BOUNDARY
					? `Chromium benchmark scroll commit boundary ${SCROLL_COMMIT_BOUNDARY} verified`
					: `Chromium benchmark scroll commit boundary is ${report.scrollCommitBoundary ?? 'missing'}, expected ${SCROLL_COMMIT_BOUNDARY}`
		},
		{
			id: 'chromium-benchmark-execution-order',
			passed: report.executionOrder === EXECUTION_ORDER,
			reason:
				report.executionOrder === EXECUTION_ORDER
					? `Chromium benchmark execution order ${EXECUTION_ORDER} verified`
					: `Chromium benchmark execution order is ${report.executionOrder ?? 'missing'}, expected ${EXECUTION_ORDER}`
		},
		{
			id: 'chromium-benchmark-workbench-table-implementation',
			passed: report.workbenchTableImplementation === 'real',
			reason:
				report.workbenchTableImplementation === 'real'
					? 'Chromium benchmark uses the real WorkbenchTable implementation'
					: `Chromium benchmark WorkbenchTable implementation is ${report.workbenchTableImplementation ?? 'missing'}, expected real`
		}
	];
	const records = validateRawRecords(report, {
		expectedRuns: 3,
		runCount: report.repeat,
		requireScreenshots: false
	});
	checks.push({
		id: 'chromium-benchmark-record-contract',
		passed: records.errors.length === 0,
		reason:
			records.errors.length === 0
				? 'Chromium benchmark has 36 unique raw records'
				: `Chromium benchmark records are invalid (${records.errors.join('; ')})`
	});
	const summaryPassed =
		records.errors.length === 0 && report.summary !== undefined && isDeepStrictEqual(report.summary, records.summary);
	checks.push({
		id: 'chromium-benchmark-summary-integrity',
		passed: summaryPassed,
		reason: summaryPassed
			? 'Chromium benchmark summary matches raw records'
			: 'Chromium benchmark reported summary does not match raw records'
	});
	const provenanceErrors = validateProvenanceFields(report.provenance, expected, {
		requireBinarySha256: false,
		requireSourceTreeClean: true,
		requireZeusBundleSha256: true,
		requireWorkbenchTableBundleSha256: true
	});
	checks.push({
		id: 'chromium-benchmark-provenance',
		passed: provenanceErrors.length === 0,
		reason:
			provenanceErrors.length === 0
				? 'Chromium benchmark source and Zeus bundle provenance verified'
				: `Chromium benchmark provenance mismatch (${provenanceErrors.join(', ')})`
	});
	return { checks, summary: records.errors.length === 0 ? records.summary : {} };
}

function validateProvenanceFields(
	provenance,
	expected,
	{
		requireBinarySha256 = false,
		requireSourceTreeClean = false,
		requireZeusBundleSha256 = false,
		requireWorkbenchTableBundleSha256 = false
	} = {}
) {
	const mismatches = [];
	if (!isRepository(provenance?.repository)) mismatches.push('repository is missing or invalid');
	if (!isGitRevision(provenance?.sourceRevision)) mismatches.push('sourceRevision is missing or invalid');
	if (!isSourceRef(provenance?.sourceRef)) mismatches.push('sourceRef is missing or invalid');
	if (!isWorkflowRunId(provenance?.workflowRunId)) mismatches.push('workflowRunId is missing or invalid');
	if (!isWorkflowRunAttempt(provenance?.workflowRunAttempt)) {
		mismatches.push('workflowRunAttempt is missing or invalid');
	}
	if (requireBinarySha256 && !isSha256(provenance?.binarySha256)) {
		mismatches.push('binarySha256 is missing or invalid');
	}
	if (requireSourceTreeClean && provenance?.sourceTreeClean !== true) {
		mismatches.push('source tree is not clean');
	}
	if (requireZeusBundleSha256 && !isSha256(provenance?.zeusBundleSha256)) {
		mismatches.push('zeusBundleSha256 is missing or invalid');
	}
	if (requireWorkbenchTableBundleSha256 && !isSha256(provenance?.workbenchTableBundleSha256)) {
		mismatches.push('workbenchTableBundleSha256 is missing or invalid');
	}
	for (const [field, expectedValue] of Object.entries(expected)) {
		if (provenance?.[field] !== expectedValue) {
			mismatches.push(
				`${field}=${formatIdentityValue(provenance?.[field])} (expected ${formatIdentityValue(expectedValue)})`
			);
		}
	}
	return mismatches;
}

async function evaluateZeusAudit(auditPath, expected) {
	const budgetBytes = 30_000;
	if (!auditPath) {
		return {
			passed: false,
			budgetBytes,
			reason: 'Zeus dependency audit evidence is missing'
		};
	}
	try {
		const audit = JSON.parse(await readFile(auditPath, 'utf8'));
		const errors = [];
		if (audit.version !== 1) errors.push(`schema version is ${audit.version ?? 'missing'}`);
		if (audit.status !== 'ready') errors.push(`status is ${audit.status ?? 'missing'}`);
		const provenanceErrors = validateProvenanceFields(audit.provenance, expected);
		if (provenanceErrors.length > 0) errors.push(`provenance mismatch (${provenanceErrors.join(', ')})`);
		for (const [field, expectedValue] of Object.entries(expectedZeusPackage)) {
			if (!isDeepStrictEqual(audit.package?.[field], expectedValue)) {
				errors.push(`package ${field} does not match the pre-registered value`);
			}
		}
		const auditChecks = Array.isArray(audit.checks) ? audit.checks : [];
		if (
			auditChecks.length === 0 ||
			auditChecks.some(
				check =>
					typeof check?.id !== 'string' ||
					check.passed !== true ||
					typeof check.reason !== 'string' ||
					check.reason.length === 0
			)
		) {
			errors.push('producer checks are missing or contain a failure');
		}
		if (!Array.isArray(audit.reasons) || audit.reasons.length !== 0) {
			errors.push('producer reasons are not empty');
		}
		if (
			!isSafeBundleName(audit.bundle?.file) ||
			!Number.isInteger(audit.bundle?.bytes) ||
			audit.bundle.bytes <= 0 ||
			!Number.isInteger(audit.bundle?.gzipBytes) ||
			audit.bundle.gzipBytes <= 0 ||
			!isSha256(audit.bundle?.sha256)
		) {
			errors.push('bundle manifest is invalid');
		}
		let actualBundle;
		if (isSafeBundleName(audit.bundle?.file)) {
			const auditRoot = await realpath(dirname(auditPath));
			const bundlePath = resolve(auditRoot, audit.bundle.file);
			const realBundlePath = await realpath(bundlePath);
			if (!isWithin(auditRoot, realBundlePath)) {
				errors.push('bundle path escapes the audit artifact root');
			} else {
				const bytes = await readFile(realBundlePath);
				actualBundle = {
					bytes: bytes.byteLength,
					gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
					sha256: createHash('sha256').update(bytes).digest('hex')
				};
				if (
					actualBundle.bytes !== audit.bundle.bytes ||
					actualBundle.gzipBytes !== audit.bundle.gzipBytes ||
					actualBundle.sha256 !== audit.bundle.sha256
				) {
					errors.push('actual Zeus bundle bytes, gzip size, or SHA-256 do not match the audit manifest');
				}
			}
		}
		const bundleGzipBytes = actualBundle?.gzipBytes ?? audit.bundle?.gzipBytes;
		if (!Number.isInteger(bundleGzipBytes) || bundleGzipBytes > budgetBytes) {
			errors.push(`gzip increment ${String(bundleGzipBytes)} exceeds ${budgetBytes} bytes`);
		}
		return {
			passed: errors.length === 0,
			audit: displayPath(auditPath),
			budgetBytes,
			bundleBytes: actualBundle?.bytes,
			bundleGzipBytes,
			bundleSha256: actualBundle?.sha256,
			package: audit.package,
			provenance: audit.provenance,
			reason:
				errors.length === 0
					? `Zeus dependency and ${bundleGzipBytes}-byte gzip bundle audit verified`
					: `Zeus dependency audit failed (${errors.join('; ')})`
		};
	} catch (error) {
		return {
			passed: false,
			audit: displayPath(auditPath),
			budgetBytes,
			reason: `Zeus dependency audit failed (${error instanceof Error ? error.message : String(error)})`
		};
	}
}

function evaluateZeusBundleBinding(benchmark, platforms, dependency) {
	const expected = dependency.bundleSha256;
	const sources = [
		['dependency audit', expected],
		['Chromium benchmark', benchmark.provenance?.zeusBundleSha256],
		['macOS WebKit', platforms.macosWebKit.provenance?.zeusBundleSha256],
		['Windows WebView2', platforms.windowsWebView2.provenance?.zeusBundleSha256]
	];
	const mismatches = sources
		.filter(([, value]) => !isSha256(value) || value !== expected)
		.map(([label, value]) => `${label}=${formatIdentityValue(value)}`);
	return [
		{
			id: 'zeus-bundle-provenance',
			passed: isSha256(expected) && mismatches.length === 0,
			reason:
				isSha256(expected) && mismatches.length === 0
					? 'dependency audit, Chromium, WKWebView, and WebView2 use the same Zeus bundle SHA-256'
					: `Zeus bundle SHA-256 provenance does not match (${mismatches.join(', ') || 'audit digest missing'})`
		}
	];
}

function evaluateWorkbenchTableBundleBinding(benchmark, platforms) {
	const expected = benchmark.provenance?.workbenchTableBundleSha256;
	const sources = [
		['Chromium benchmark', expected],
		['macOS WebKit', platforms.macosWebKit.provenance?.workbenchTableBundleSha256],
		['Windows WebView2', platforms.windowsWebView2.provenance?.workbenchTableBundleSha256]
	];
	const mismatches = sources
		.filter(([, value]) => !isSha256(value) || value !== expected)
		.map(([label, value]) => `${label}=${formatIdentityValue(value)}`);
	return [
		{
			id: 'workbench-table-bundle-provenance',
			passed: isSha256(expected) && mismatches.length === 0,
			reason:
				isSha256(expected) && mismatches.length === 0
					? 'Chromium, WKWebView, and WebView2 use the same WorkbenchTable benchmark bundle SHA-256'
					: `WorkbenchTable bundle SHA-256 provenance does not match (${mismatches.join(', ') || 'benchmark digest missing'})`
		}
	];
}

function isSafeBundleName(value) {
	return typeof value === 'string' && /^[A-Za-z0-9_.-]+\.js$/.test(value);
}

function displayExecutable(value) {
	if (typeof value !== 'string' || (!value.includes('/') && !value.includes('\\'))) {
		return value;
	}
	return value.split(/[\\/]/).filter(Boolean).at(-1) ?? '<unknown>';
}

function displayPath(path) {
	const repositoryRelative = relative(repositoryRoot, path);
	if (repositoryRelative === '' || isWithin(repositoryRoot, path)) {
		return repositoryRelative.split(sep).join('/') || '.';
	}
	return `<external>/${path.split(sep).at(-1)}`;
}

async function validatePlatformEvidence(evidence, evidenceRoot) {
	const checks = [];
	checks.push({
		id: `${evidence.label}-schema-version`,
		passed: evidence.version === 2,
		reason:
			evidence.version === 2
				? `${evidence.label}: platform evidence version 2 verified`
				: `${evidence.label}: platform evidence version is ${evidence.version ?? 'missing'}, expected 2`
	});
	checks.push({
		id: `${evidence.label}-measurement-contract-version`,
		passed: evidence.measurementContractVersion === MEASUREMENT_CONTRACT_VERSION,
		reason:
			evidence.measurementContractVersion === MEASUREMENT_CONTRACT_VERSION
				? `${evidence.label}: measurement contract version ${MEASUREMENT_CONTRACT_VERSION} verified`
				: `${evidence.label}: measurement contract version is ${evidence.measurementContractVersion ?? 'missing'}, expected ${MEASUREMENT_CONTRACT_VERSION}`
	});
	checks.push({
		id: `${evidence.label}-scroll-commit-boundary`,
		passed: evidence.scrollCommitBoundary === SCROLL_COMMIT_BOUNDARY,
		reason:
			evidence.scrollCommitBoundary === SCROLL_COMMIT_BOUNDARY
				? `${evidence.label}: scroll commit boundary ${SCROLL_COMMIT_BOUNDARY} verified`
				: `${evidence.label}: scroll commit boundary is ${evidence.scrollCommitBoundary ?? 'missing'}, expected ${SCROLL_COMMIT_BOUNDARY}`
	});
	checks.push({
		id: `${evidence.label}-execution-order`,
		passed: evidence.executionOrder === EXECUTION_ORDER,
		reason:
			evidence.executionOrder === EXECUTION_ORDER
				? `${evidence.label}: execution order ${EXECUTION_ORDER} verified`
				: `${evidence.label}: execution order is ${evidence.executionOrder ?? 'missing'}, expected ${EXECUTION_ORDER}`
	});
	const recordValidation = validatePlatformRecords(evidence);
	checks.push({
		id: `${evidence.label}-record-contract`,
		passed: recordValidation.errors.length === 0,
		reason:
			recordValidation.errors.length === 0
				? `${evidence.label}: 60 unique raw benchmark records verified`
				: `${evidence.label}: records are invalid (${recordValidation.errors.join('; ')})`
	});
	const summaryPassed =
		recordValidation.errors.length === 0 &&
		evidence.summary !== undefined &&
		isDeepStrictEqual(evidence.summary, recordValidation.summary);
	checks.push({
		id: `${evidence.label}-summary-integrity`,
		passed: summaryPassed,
		reason: summaryPassed
			? `${evidence.label}: reported summary matches raw records`
			: `${evidence.label}: reported summary does not match raw records`
	});
	const screenshotErrors = await validatePlatformScreenshots(evidence, evidenceRoot, recordValidation.records);
	checks.push({
		id: `${evidence.label}-screenshot-integrity`,
		passed: screenshotErrors.length === 0,
		reason:
			screenshotErrors.length === 0
				? `${evidence.label}: 12 screenshot files, hashes, and pixels verified`
				: `${evidence.label}: screenshot evidence is invalid (${screenshotErrors.join('; ')})`
	});
	return { checks, summary: recordValidation.errors.length === 0 ? recordValidation.summary : {} };
}

function validatePlatformRecords(evidence) {
	return validateRawRecords(evidence, { expectedRuns: 5, runCount: evidence.runs, requireScreenshots: true });
}

function validateRawRecords(evidence, { expectedRuns, runCount, requireScreenshots }) {
	const errors = [];
	const records = Array.isArray(evidence.records) ? evidence.records : [];
	const expectedRecordCount = expectedWorkloads.size * expectedRenderers.length * expectedRuns;
	const expectedPlan = createBalancedBenchmarkPlan([...expectedWorkloads.values()], expectedRenderers, expectedRuns);
	if (runCount !== expectedRuns) errors.push(`runs=${String(runCount)}; expected exactly ${expectedRuns}`);
	if (records.length !== expectedRecordCount) {
		errors.push(`record count is ${records.length}; expected ${expectedRecordCount}`);
	}
	const tuples = new Set();
	const runTokens = new Set();
	for (const [index, record] of records.entries()) {
		const expectedPlanEntry = expectedPlan[index];
		const workload = expectedWorkloads.get(record?.workloadId);
		if (!workload || !expectedRenderers.includes(record?.renderer)) {
			errors.push(`record ${index} has an unknown workload or renderer`);
			continue;
		}
		if (!Number.isInteger(record.iteration) || record.iteration < 1 || record.iteration > expectedRuns) {
			errors.push(`record ${index} iteration is invalid`);
			continue;
		}
		const tuple = `${record.workloadId}/${record.renderer}/${record.iteration}`;
		if (tuples.has(tuple)) errors.push(`duplicate iteration tuple ${tuple}`);
		tuples.add(tuple);
		if (!isRunToken(record.runToken)) {
			errors.push(`${tuple} run token is invalid`);
		} else if (runTokens.has(record.runToken)) {
			errors.push(`${tuple} has a duplicate run token`);
		} else {
			runTokens.add(record.runToken);
		}
		if (record.measurementContractVersion !== MEASUREMENT_CONTRACT_VERSION) {
			errors.push(
				`${tuple} record measurement contract version is ${record.measurementContractVersion ?? 'missing'}; expected ${MEASUREMENT_CONTRACT_VERSION}`
			);
		}
		if (record.scrollCommitBoundary !== SCROLL_COMMIT_BOUNDARY) {
			errors.push(
				`${tuple} record scroll commit boundary is ${record.scrollCommitBoundary ?? 'missing'}; expected ${SCROLL_COMMIT_BOUNDARY}`
			);
		}
		if (record.executionOrder !== EXECUTION_ORDER) {
			errors.push(
				`${tuple} record execution order is ${record.executionOrder ?? 'missing'}; expected ${EXECUTION_ORDER}`
			);
		}
		if (record.executionOrdinal !== index + 1) {
			errors.push(`${tuple} execution ordinal is ${String(record.executionOrdinal)}; expected ${index + 1}`);
		}
		if (
			expectedPlanEntry &&
			(record.workloadId !== expectedPlanEntry.workload.id ||
				record.renderer !== expectedPlanEntry.renderer ||
				record.iteration !== expectedPlanEntry.iteration)
		) {
			errors.push(
				`${tuple} execution plan entry does not match ordinal ${index + 1}; expected ${expectedPlanEntry.workload.id}/${expectedPlanEntry.renderer}/${expectedPlanEntry.iteration}`
			);
		}
		if (record.status !== 'ok') errors.push(`${tuple} status is not ok`);
		if (
			record.renderer === 'workbench-table' &&
			!isValidWorkbenchTableRendererImplementation(
				record.rendererImplementation,
				evidence.provenance?.workbenchTableBundleSha256
			)
		) {
			errors.push(`${tuple} WorkbenchTable implementation proof is invalid`);
		}
		if (!matchesWorkload(record.workload, workload)) errors.push(`${tuple} workload shape is invalid`);
		if (!hasValidBrowserViewport(record.browserViewport, workload)) {
			errors.push(`${tuple} browser viewport does not match the workload`);
		}
		if (
			requireScreenshots &&
			!hasValidViewportCalibration(record.viewportCalibration, workload, record.browserViewport)
		) {
			errors.push(`${tuple} viewport calibration is invalid`);
		}
		if (!hasValidMetrics(record)) errors.push(`${tuple} metrics are invalid`);
		if (!hasMatchingScrollSummary(record.scroll)) {
			errors.push(`${tuple} scroll summary does not match raw samples`);
		}
		const scrollSampleError = validateScrollSamples(record.scroll, workload);
		if (scrollSampleError) errors.push(`${tuple} ${scrollSampleError}`);
		if (!hasValidVisualProbe(record, workload)) errors.push(`${tuple} visual probe is invalid`);
		if (requireScreenshots && record.iteration === 1) {
			if (!isSafePngName(record.screenshot) || record.screenshotProbe?.passed !== true) {
				errors.push(`${tuple} first-run screenshot probe is invalid`);
			}
		} else if (requireScreenshots && (record.screenshot !== undefined || record.screenshotProbe !== undefined)) {
			errors.push(`${tuple} unexpectedly contains a screenshot`);
		}
		if (errors.length >= 20) break;
	}
	if (tuples.size !== expectedRecordCount) {
		errors.push(`unique iteration tuple count is ${tuples.size}; expected ${expectedRecordCount}`);
	}
	if (runTokens.size !== expectedRecordCount) {
		errors.push(`unique run token count is ${runTokens.size}; expected ${expectedRecordCount}`);
	}
	return {
		errors,
		records,
		summary: errors.length === 0 ? summarizeRecords(records) : {}
	};
}

function isRunToken(value) {
	return (
		typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
	);
}

function evaluateGlobalRunTokenUniqueness(benchmark, platforms) {
	const sources = [
		['Chromium', benchmark.records],
		['macOS WebKit', platforms.macosWebKit?.records],
		['Windows WebView2', platforms.windowsWebView2?.records]
	];
	const expectedCount = 36 + 60 + 60;
	const seen = new Map();
	const reused = [];
	let recordCount = 0;
	for (const [source, sourceRecords] of sources) {
		for (const [index, record] of (Array.isArray(sourceRecords) ? sourceRecords : []).entries()) {
			recordCount += 1;
			if (!isRunToken(record?.runToken)) continue;
			const identity = `${source} ${record.workloadId ?? 'unknown'}/${record.renderer ?? 'unknown'}/${record.iteration ?? index}`;
			const previous = seen.get(record.runToken);
			if (previous) reused.push(`${record.runToken} reused by ${previous} and ${identity}`);
			else seen.set(record.runToken, identity);
		}
	}
	const passed = recordCount === expectedCount && seen.size === expectedCount && reused.length === 0;
	return [
		{
			id: 'global-run-token-uniqueness',
			passed,
			reason: passed
				? `${expectedCount} run tokens are globally unique across Chromium, macOS WebKit, and Windows WebView2`
				: `global run token uniqueness failed (${[
						...reused.slice(0, 5),
						...(recordCount === expectedCount ? [] : [`record count is ${recordCount}; expected ${expectedCount}`]),
						...(seen.size === expectedCount
							? []
							: [`unique valid token count is ${seen.size}; expected ${expectedCount}`])
					].join('; ')})`
		}
	];
}

function matchesWorkload(actual, expected) {
	return (
		actual?.rows === expected.rows &&
		actual?.columns === expected.columns &&
		actual?.wide === expected.wide &&
		actual?.viewportWidth === expected.width &&
		actual?.viewportHeight === expected.height
	);
}

function hasValidBrowserViewport(viewport, workload) {
	return Boolean(
		dimensionsMatch(viewport, { width: workload.width, height: workload.height }, SCROLL_OFFSET_TOLERANCE) &&
		Number.isFinite(viewport?.devicePixelRatio) &&
		viewport.devicePixelRatio > 0 &&
		viewport.devicePixelRatio <= 8
	);
}

function hasValidViewportCalibration(calibration, workload, browserViewport) {
	const attempts = Array.isArray(calibration?.calibrationAttempts) ? calibration.calibrationAttempts : [];
	if (
		calibration?.viewportConverged !== true ||
		calibration.convergenceStoppedReason !== 'target-reached' ||
		calibration.viewportTolerance !== SCROLL_OFFSET_TOLERANCE ||
		attempts.length < 1 ||
		attempts.length > 4 ||
		!dimensionsMatch(calibration.requestedCssViewport, workload) ||
		!dimensionsMatch(calibration.observedCssViewport, browserViewport, SCROLL_OFFSET_TOLERANCE) ||
		!dimensionsMatch(calibration.observedCssViewport, workload, SCROLL_OFFSET_TOLERANCE) ||
		!hasPositiveDimensions(calibration.initialWindowRect) ||
		!hasPositiveDimensions(calibration.lastAppliedRequestedWindowRect) ||
		!hasPositiveDimensions(calibration.appliedWindowRect)
	) {
		return false;
	}
	for (const [index, attempt] of attempts.entries()) {
		if (
			attempt?.attempt !== index + 1 ||
			!hasPositiveDimensions(attempt.requestedWindowRect) ||
			!hasPositiveDimensions(attempt.appliedWindowRect) ||
			!hasPositiveDimensions(attempt.observedCssViewport)
		) {
			return false;
		}
	}
	const lastAttempt = attempts.at(-1);
	return (
		dimensionsMatch(lastAttempt.requestedWindowRect, calibration.lastAppliedRequestedWindowRect) &&
		dimensionsMatch(lastAttempt.appliedWindowRect, calibration.appliedWindowRect) &&
		dimensionsMatch(lastAttempt.observedCssViewport, calibration.observedCssViewport, SCROLL_OFFSET_TOLERANCE)
	);
}

function hasPositiveDimensions(value) {
	return Number.isFinite(value?.width) && value.width > 0 && Number.isFinite(value?.height) && value.height > 0;
}

function dimensionsMatch(actual, expected, tolerance = 0) {
	return (
		hasPositiveDimensions(actual) &&
		hasPositiveDimensions(expected) &&
		Math.abs(actual.width - expected.width) <= tolerance &&
		Math.abs(actual.height - expected.height) <= tolerance
	);
}

function hasValidMetrics(record) {
	const numericValues = [
		record.formatMs,
		record.parseMs,
		record.renderMs,
		record.scroll?.medianMs,
		record.scroll?.p95Ms,
		record.scroll?.maxMs,
		record.domNodes,
		record.fixtureBytes,
		record.renderedRows
	];
	if (!numericValues.every(value => Number.isFinite(value) && value >= 0)) return false;
	if (record.heapBytes !== null && (!Number.isFinite(record.heapBytes) || record.heapBytes < 0)) return false;
	return record.scroll.medianMs <= record.scroll.p95Ms && record.scroll.p95Ms <= record.scroll.maxMs;
}

function hasMatchingScrollSummary(scroll) {
	if (!Array.isArray(scroll?.samples) || scroll.samples.length === 0) return false;
	const total = summarizeRawSamples(scroll.samples, 'totalMs');
	const input = summarizeRawSamples(scroll.samples, 'inputMs');
	const settle = summarizeRawSamples(scroll.samples, 'settleMs');
	if (!total || !input || !settle) return false;
	return (
		scroll.medianMs === total.median &&
		scroll.p95Ms === total.p95 &&
		scroll.maxMs === total.max &&
		scroll.inputMedianMs === input.median &&
		scroll.inputP95Ms === input.p95 &&
		scroll.settleMedianMs === settle.median &&
		scroll.settleP95Ms === settle.p95
	);
}

function validateScrollSamples(scroll, workload) {
	if (!Array.isArray(scroll?.samples)) return 'scroll samples are missing';
	if (scroll.samples.length !== SCROLL_TARGET_RATIOS.length) {
		return `scroll samples count is ${scroll.samples.length}; expected exactly ${SCROLL_TARGET_RATIOS.length}`;
	}
	const nominalScrollViewportHeight = expectedScrollViewportHeight(workload);
	if (
		!Number.isFinite(scroll.scrollViewportHeight) ||
		scroll.scrollViewportHeight <= 0 ||
		Math.abs(scroll.scrollViewportHeight - nominalScrollViewportHeight) > SCROLL_VIEWPORT_TOLERANCE
	) {
		return `scroll viewport height is ${String(scroll.scrollViewportHeight)}; expected around ${nominalScrollViewportHeight}`;
	}
	const scrollViewportHeight = scroll.scrollViewportHeight;
	const maximumOffset = maximumScrollOffset(workload.rows, scrollViewportHeight);
	if (!approximatelyEqual(scroll.maximumOffset, maximumOffset, SCROLL_OFFSET_TOLERANCE)) {
		return `scroll maximum offset is ${String(scroll.maximumOffset)}; expected ${maximumOffset}`;
	}
	for (const [index, sample] of scroll.samples.entries()) {
		if (sample?.sampleIndex !== index) {
			return `scroll sample ${index} sequence is ${String(sample?.sampleIndex)}; expected ${index}`;
		}
		if (sample?.committed !== true) return `scroll sample ${index} is not committed`;
		if (
			!Number.isFinite(sample.startOffset) ||
			sample.startOffset < 0 ||
			sample.startOffset > maximumOffset + SCROLL_OFFSET_TOLERANCE ||
			!Number.isFinite(sample.targetOffset) ||
			sample.targetOffset < 0 ||
			sample.targetOffset > maximumOffset + SCROLL_OFFSET_TOLERANCE ||
			!Number.isFinite(sample.actualOffset) ||
			sample.actualOffset < 0 ||
			sample.actualOffset > maximumOffset + SCROLL_OFFSET_TOLERANCE
		) {
			return `scroll sample ${index} offsets are out of bounds`;
		}
		const expectedTargetOffset = scrollTargetOffset(maximumOffset, index);
		if (!approximatelyEqual(sample.targetOffset, expectedTargetOffset, SCROLL_OFFSET_TOLERANCE)) {
			return `scroll sample ${index} target sequence is invalid`;
		}
		const expectedStartOffset = index === 0 ? maximumOffset : scroll.samples[index - 1].actualOffset;
		if (!approximatelyEqual(sample.startOffset, expectedStartOffset, SCROLL_OFFSET_TOLERANCE)) {
			return `scroll sample ${index} start offset does not continue the measured sequence`;
		}
		if (Math.abs(sample.actualOffset - sample.startOffset) <= SCROLL_OFFSET_TOLERANCE) {
			return `scroll sample ${index} did not produce a real displacement`;
		}
		if (!approximatelyEqual(sample.actualOffset, sample.targetOffset, SCROLL_OFFSET_TOLERANCE)) {
			return `scroll sample ${index} offset did not commit within ${SCROLL_OFFSET_TOLERANCE}px`;
		}
		if (!approximatelyEqual(sample.scrollViewportHeight, scrollViewportHeight, SCROLL_OFFSET_TOLERANCE)) {
			return `scroll sample ${index} viewport height is invalid`;
		}
		if (![sample.inputMs, sample.settleMs, sample.totalMs].every(value => Number.isFinite(value) && value >= 0)) {
			return `scroll sample ${index} timing values are invalid`;
		}
		if (!approximatelyEqual(sample.inputMs + sample.settleMs, sample.totalMs, SCROLL_TIMING_TOLERANCE_MS)) {
			return `scroll sample ${index} timing components do not recompute total time`;
		}
		if (!Number.isInteger(sample.attempts) || sample.attempts < 1 || sample.attempts > SCROLL_COMMIT_ATTEMPTS) {
			return `scroll sample ${index} attempts are invalid`;
		}
		if (
			!Number.isInteger(sample.presentationOpportunities) ||
			sample.presentationOpportunities < 1 ||
			sample.presentationOpportunities !== sample.attempts
		) {
			return `scroll sample ${index} presentation opportunities are invalid`;
		}
		const derivedExpectedRowIndex = expectedVisibleRowIndex(sample.actualOffset, workload.rows);
		if (sample.expectedRowIndex !== derivedExpectedRowIndex) {
			return `scroll sample ${index} expected row is invalid`;
		}
		if (!isValidVisibleRowIndex(sample.visibleRowIndex, workload.rows)) {
			return `scroll sample ${index} visible row is invalid`;
		}
		const derivedRowDelta = Math.abs(sample.visibleRowIndex - derivedExpectedRowIndex);
		if (
			!Number.isInteger(sample.rowDelta) ||
			sample.rowDelta !== derivedRowDelta ||
			derivedRowDelta > SCROLL_ROW_TOLERANCE
		) {
			return `scroll sample ${index} row alignment is invalid`;
		}
	}
	return undefined;
}

function summarizeRawSamples(samples, field) {
	const values = samples.map(sample => sample?.[field]);
	if (!values.every(value => Number.isFinite(value) && value >= 0)) return undefined;
	const sorted = [...values].sort((left, right) => left - right);
	return {
		median: sorted[Math.floor(sorted.length / 2)],
		p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
		max: sorted.at(-1)
	};
}

function approximatelyEqual(actual, expected, tolerance) {
	return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance;
}

function hasValidVisualProbe(record, workload) {
	const probe = record?.visualProbe;
	const renderedRowsValid =
		record.renderer === 'native'
			? record.renderedRows === workload.rows
			: Number.isInteger(record.renderedRows) &&
				record.renderedRows > 0 &&
				record.renderedRows <= maximumVirtualRenderedRows(workload);
	return Boolean(
		probe &&
		probe.rootWidth >= Math.min(workload.width, 300) &&
		probe.rootHeight >= Math.min(workload.height, 300) &&
		typeof probe.headerText === 'string' &&
		probe.headerText.length > 0 &&
		typeof probe.firstVisibleCellText === 'string' &&
		probe.firstVisibleCellText.length > 0 &&
		probe.firstCellInViewport === true &&
		probe.virtualRowsBounded === true &&
		renderedRowsValid &&
		probe.outerDocumentOverflowFree === true &&
		probe.runMarkerAnchored === true &&
		probe.documentViewport?.clientWidth === record.browserViewport?.width &&
		probe.documentViewport?.clientHeight === record.browserViewport?.height &&
		probe.documentViewport?.scrollWidth === record.browserViewport?.width &&
		probe.documentViewport?.scrollHeight === record.browserViewport?.height &&
		Number.isInteger(probe.visibleTextLength) &&
		probe.visibleTextLength > 0
	);
}

async function validatePlatformScreenshots(evidence, evidenceRoot, records) {
	const errors = [];
	const screenshots = Array.isArray(evidence.screenshots) ? evidence.screenshots : [];
	if (screenshots.length !== expectedWorkloads.size * expectedRenderers.length) {
		errors.push(`manifest count is ${screenshots.length}; expected 12`);
	}
	if (!evidenceRoot) return [...errors, 'platform artifact root is unavailable'];
	const artifactDirectory = evidence.artifactDirectory ?? '.';
	if (!isSafeRelativeDirectory(artifactDirectory)) return [...errors, 'artifactDirectory is unsafe'];
	const artifactRoot = resolve(evidenceRoot, artifactDirectory);
	if (!isWithin(evidenceRoot, artifactRoot)) return [...errors, 'artifactDirectory escapes the evidence root'];
	let realArtifactRoot;
	try {
		const realEvidenceRoot = await realpath(evidenceRoot);
		realArtifactRoot = await realpath(artifactRoot);
		if (!isWithin(realEvidenceRoot, realArtifactRoot)) {
			return [...errors, 'artifact root symlink escapes the evidence root'];
		}
	} catch (error) {
		return [...errors, `artifact root cannot be resolved: ${error instanceof Error ? error.message : String(error)}`];
	}
	const firstRecords = new Map(
		records.filter(record => record?.iteration === 1).map(record => [`${record.workloadId}/${record.renderer}`, record])
	);
	const manifestKeys = new Set();
	const manifestFiles = new Set();
	const realScreenshotPaths = new Set();
	for (const [index, screenshot] of screenshots.entries()) {
		const workload = expectedWorkloads.get(screenshot?.workloadId);
		const key = `${screenshot?.workloadId}/${screenshot?.renderer}`;
		if (
			!workload ||
			!expectedRenderers.includes(screenshot?.renderer) ||
			screenshot?.iteration !== 1 ||
			!isSafePngName(screenshot?.file) ||
			!isRunToken(screenshot?.runToken) ||
			!Number.isInteger(screenshot?.bytes) ||
			screenshot.bytes <= 0 ||
			!isSha256(screenshot?.sha256) ||
			screenshot.runMarkerVersion !== SQL_RESULT_GRID_RUN_MARKER_VERSION
		) {
			errors.push(`manifest entry ${index} is invalid`);
			continue;
		}
		if (manifestKeys.has(key)) {
			errors.push(`duplicate manifest mapping ${key}`);
			continue;
		}
		manifestKeys.add(key);
		if (manifestFiles.has(screenshot.file)) {
			errors.push(`${key} screenshot reuses a duplicate file`);
			continue;
		}
		manifestFiles.add(screenshot.file);
		const record = firstRecords.get(key);
		if (
			record?.screenshot !== screenshot.file ||
			record?.runToken !== screenshot.runToken ||
			!isDeepStrictEqual(record?.browserViewport, screenshot.viewport) ||
			record?.screenshotProbe?.passed !== true ||
			record.screenshotProbe.bytes !== screenshot.bytes ||
			record.screenshotProbe.sha256 !== screenshot.sha256 ||
			record.screenshotProbe.runToken !== screenshot.runToken ||
			record.screenshotProbe.runMarkerVersion !== screenshot.runMarkerVersion ||
			!isDeepStrictEqual(record.screenshotProbe.viewport, screenshot.viewport)
		) {
			errors.push(`${key} screenshot manifest does not match its raw record`);
			continue;
		}
		const screenshotPath = resolve(artifactRoot, 'screenshots', screenshot.file);
		if (!isWithin(artifactRoot, screenshotPath)) {
			errors.push(`${key} screenshot path escapes its artifact root`);
			continue;
		}
		try {
			const screenshotStats = await lstat(screenshotPath);
			if (screenshotStats.isSymbolicLink()) {
				errors.push(`${key} screenshot file must not be a symlink`);
				continue;
			}
			if (!screenshotStats.isFile()) {
				errors.push(`${key} screenshot path is not a regular file`);
				continue;
			}
			const realScreenshotPath = await realpath(screenshotPath);
			if (!isWithin(realArtifactRoot, realScreenshotPath)) {
				errors.push(`${key} screenshot symlink escapes its artifact root`);
				continue;
			}
			if (realScreenshotPaths.has(realScreenshotPath)) {
				errors.push(`${key} screenshot resolves to a duplicate real path`);
				continue;
			}
			realScreenshotPaths.add(realScreenshotPath);
			const bytes = await readFile(realScreenshotPath);
			const actualSha256 = createHash('sha256').update(bytes).digest('hex');
			if (bytes.byteLength !== screenshot.bytes || actualSha256 !== screenshot.sha256) {
				errors.push(`${key} screenshot file bytes or SHA-256 do not match the manifest`);
				continue;
			}
			const runMarker = inspectSqlResultGridRunMarker(bytes, record.runToken, record.browserViewport);
			const pixels = inspectPngPixels(bytes, {
				excludeRegions: runMarker.bounds ? [runMarker.bounds] : []
			});
			const dimensionCheck = validatePngViewportDimensions(pixels, record.browserViewport);
			if (!dimensionCheck.passed) {
				errors.push(
					`${key} screenshot physical dimensions ${pixels.width}x${pixels.height} do not match viewport ${formatIdentityValue(record.browserViewport?.width)}x${formatIdentityValue(record.browserViewport?.height)} at DPR ${formatIdentityValue(record.browserViewport?.devicePixelRatio)}`
				);
			} else if (record.screenshotProbe.width !== pixels.width || record.screenshotProbe.height !== pixels.height) {
				errors.push(`${key} screenshot pixel dimensions do not match its raw record probe`);
			} else if (!runMarker.passed) {
				errors.push(`${key} screenshot run marker mismatch (${runMarker.reason})`);
			} else if (!hasVisiblePngDiversity(pixels)) {
				errors.push(`${key} screenshot PNG is blank or visually uniform`);
			}
		} catch (error) {
			errors.push(
				`${key} screenshot file failed verification: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		if (errors.length >= 20) break;
	}
	if (manifestKeys.size !== 12) errors.push(`unique screenshot mapping count is ${manifestKeys.size}; expected 12`);
	if (manifestFiles.size !== 12) errors.push(`unique screenshot file count is ${manifestFiles.size}; expected 12`);
	return errors;
}

function isSafePngName(value) {
	return typeof value === 'string' && /^[A-Za-z0-9_.-]+\.png$/.test(value);
}

function isSafeRelativeDirectory(value) {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		!isAbsolute(value) &&
		!value.split(/[\\/]/).some(segment => segment === '..' || segment === '')
	);
}

function isWithin(parent, child) {
	const path = relative(parent, child);
	return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function summarizeRecords(records) {
	const groups = new Map();
	for (const record of records) {
		if (record.status !== 'ok') continue;
		const key = `${record.workloadId}/${record.renderer}`;
		const group = groups.get(key) ?? [];
		group.push(record);
		groups.set(key, group);
	}
	return Object.fromEntries(
		[...groups.entries()].map(([key, group]) => [
			key,
			{
				count: group.length,
				renderMs: summarizeMetric(group.map(record => record.renderMs)),
				scrollP95Ms: summarizeMetric(group.map(record => record.scroll.p95Ms)),
				scrollMaxMs: summarizeMetric(group.map(record => record.scroll.maxMs)),
				domNodes: summarizeMetric(group.map(record => record.domNodes)),
				heapBytes: summarizeMetric(group.map(record => record.heapBytes).filter(value => value !== null)),
				formatMs: summarizeMetric(group.map(record => record.formatMs)),
				parseMs: summarizeMetric(group.map(record => record.parseMs)),
				fixtureBytes: group[0].fixtureBytes
			}
		])
	);
}

function summarizeMetric(values) {
	if (values.length === 0) return { available: false };
	const sorted = [...values].sort((left, right) => left - right);
	return {
		available: true,
		median: sorted[Math.floor(sorted.length / 2)] ?? 0,
		p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
		min: sorted[0] ?? 0,
		max: sorted.at(-1) ?? 0
	};
}

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
