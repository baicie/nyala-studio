#!/usr/bin/env node

/**
 * Verify the accepted v8 frame-aware admission evidence.
 *
 * This verifier deliberately lives beside the frozen v7 verifier.  v8 evidence
 * has a different renderer-work boundary and must never be accepted by the v7
 * contract or silently change a historical gate result.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
	FRAME_AWARE_BASELINE_RENDERER,
	FRAME_AWARE_BOUNDARY_VERSION,
	FRAME_AWARE_MEASUREMENT_CONTRACT_VERSION,
	FRAME_AWARE_REQUIRED_IMPROVEMENT,
	FRAME_AWARE_TOTAL_REGRESSION_LIMIT,
	createFrameAwareContractMetadata,
	rendererOperationDuration,
	validateFrameAwareCalibration,
	validateFrameAwareContractMetadata
} from './sql-result-grid-frame-aware-contract.mjs';

const scriptArgs = process.argv.slice(2).filter(argument => argument !== '--');
const inputPath = resolve(scriptArgs[0] ?? 'platform-evidence-v8.json');
const outputPath = resolve(scriptArgs[1] ?? 'phase-z1-gate-v8.json');
const expectedProvenance = createExpectedProvenance();

const inputBytes = await readFile(inputPath);
let input;
try {
	input = JSON.parse(inputBytes.toString('utf8'));
} catch (error) {
	input = { parseError: error instanceof Error ? error.message : String(error) };
}

const checks = [];
const platformReports = {};
for (const [key, label] of [
	['macosWebKit', 'macOS WebKit'],
	['windowsWebView2', 'Windows WebView2']
]) {
	const evidence = input?.[key];
	const result = verifyPlatformEvidence(evidence, label, expectedProvenance);
	platformReports[key] = result.report;
	checks.push(...result.checks);
}

const reasons = checks.filter(check => !check.passed).map(check => check.reason);
const report = {
	version: 1,
	gateContract: 'z1-v8-frame-aware',
	measurementContractVersion: FRAME_AWARE_MEASUREMENT_CONTRACT_VERSION,
	generatedAt: new Date().toISOString(),
	sourceRevision: expectedProvenance.sourceRevision ?? null,
	decision: reasons.length === 0 ? 'GO' : 'NO-GO',
	input: inputPath,
	inputSha256: createHash('sha256').update(inputBytes).digest('hex'),
	thresholds: {
		baselineRenderer: FRAME_AWARE_BASELINE_RENDERER,
		rendererWorkImprovementMin: FRAME_AWARE_REQUIRED_IMPROVEMENT,
		totalRegressionMax: FRAME_AWARE_TOTAL_REGRESSION_LIMIT,
		rendererWorkP95RegressionMax: FRAME_AWARE_TOTAL_REGRESSION_LIMIT,
		admissionMetric: 'rendererWorkP50Ms'
	},
	checks,
	platformEvidence: platformReports,
	reasons
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${report.decision}: ${outputPath}\n`);
for (const reason of reasons) process.stdout.write(`- ${reason}\n`);
process.exitCode = report.decision === 'GO' ? 0 : 1;

function createExpectedProvenance() {
	const sourceRevision =
		process.env.NYALA_EXPECTED_SOURCE_REVISION ??
		execFileSync('git', ['rev-parse', 'HEAD'], {
			cwd: resolve(new URL('..', import.meta.url).pathname),
			encoding: 'utf8'
		}).trim();
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

function verifyPlatformEvidence(evidence, label, expected) {
	const checks = [];
	const report = evidence && typeof evidence === 'object' ? evidence : { label, status: 'blocked' };
	const add = (id, passed, reason, details = {}) => checks.push({ id: `${label}-${id}`, passed, reason, ...details });

	add(
		'admission-grade',
		report.admissionGrade === true && report.admission?.grade === true,
		report.admissionGrade === true && report.admission?.grade === true
			? `${label}: v8 admission grade verified`
			: `${label}: v8 admission grade must be true at both admissionGrade and admission.grade`
	);
	add(
		'schema',
		report.version === 3 && report.measurementContractVersion === FRAME_AWARE_MEASUREMENT_CONTRACT_VERSION,
		report.version === 3 && report.measurementContractVersion === FRAME_AWARE_MEASUREMENT_CONTRACT_VERSION
			? `${label}: platform evidence schema v3 and measurement contract 8 verified`
			: `${label}: expected platform evidence version 3 and measurement contract 8`
	);
	add(
		'status',
		report.status === 'ready' && Number.isInteger(report.runs) && report.runs >= 5,
		report.status === 'ready' && Number.isInteger(report.runs) && report.runs >= 5
			? `${label}: ready evidence has ${report.runs} runs`
			: `${label}: evidence must be ready with at least 5 runs`
	);

	const contractErrors = validateFrameAwareContractMetadata(report.frameAwareContract);
	add(
		'contract',
		contractErrors.length === 0,
		contractErrors.length === 0
			? `${label}: frame-aware contract metadata verified`
			: `${label}: frame-aware contract is invalid (${contractErrors.join('; ')})`
	);
	const calibrationErrors = validateFrameAwareCalibration(report.frameAwareCalibration);
	add(
		'calibration',
		calibrationErrors.length === 0,
		calibrationErrors.length === 0
			? `${label}: renderer-work calibration verified`
			: `${label}: renderer-work calibration is invalid (${calibrationErrors.join('; ')})`
	);

	const admissionErrors = validateAdmissionMetadata(report);
	add(
		'admission-metadata',
		admissionErrors.length === 0,
		admissionErrors.length === 0
			? `${label}: same-execution admission metadata verified`
			: `${label}: admission metadata is invalid (${admissionErrors.join('; ')})`
	);

	const provenanceErrors = validateProvenance(report.provenance, expected);
	add(
		'provenance',
		provenanceErrors.length === 0,
		provenanceErrors.length === 0
			? `${label}: source, workflow, binary, and renderer bundle provenance verified`
			: `${label}: provenance mismatch (${provenanceErrors.join(', ')})`
	);

	const metricResult = evaluateMetrics(report);
	checks.push(...metricResult.checks.map(check => ({ ...check, id: `${label}-${check.id}` })));
	add(
		'summary-integrity',
		metricResult.summaryErrors.length === 0,
		metricResult.summaryErrors.length === 0
			? `${label}: renderer-work and scroll summaries match raw samples`
			: `${label}: summary does not match raw samples (${metricResult.summaryErrors.join('; ')})`
	);

	return { checks, report };
}

function validateAdmissionMetadata(evidence) {
	const errors = [];
	const admission = evidence.admission;
	if (!admission || typeof admission !== 'object' || Array.isArray(admission)) {
		errors.push('admission metadata is missing');
	} else {
		if (admission.mode !== 'same-execution') errors.push('admission.mode must be same-execution');
		if (admission.correlation !== 'same-input-renderer-operation-v1') {
			errors.push('admission.correlation must be same-input-renderer-operation-v1');
		}
		if (admission.grade !== true) errors.push('admission.grade must be true');
		if (!Array.isArray(admission.reasons) || admission.reasons.length !== 0) {
			errors.push('admission.reasons must be empty');
		}
	}
	for (const field of ['appRestarts', 'sessionRecycles', 'recoveryEvents', 'retriedRounds']) {
		if (Array.isArray(evidence[field]) && evidence[field].length > 0) {
			errors.push(`${field} must be empty for admission evidence`);
		}
	}
	if (evidence.recoveryProbe === true) errors.push('recoveryProbe is diagnostic-only');
	if (evidence.diagnostic === true || evidence.diagnosticOnly === true) {
		errors.push('diagnostic-only evidence is not v8 admission evidence');
	}
	if (evidence.sameExecutionProfile !== undefined) errors.push('legacy sameExecutionProfile is diagnostic-only');
	if (evidence.segmentTrace !== undefined) errors.push('separate-navigation segmentTrace is not v8 admission evidence');
	if (evidence.traceNavigation !== undefined && evidence.traceNavigation !== 'same-execution') {
		errors.push('traceNavigation must be same-execution');
	}
	return errors;
}

function validateProvenance(provenance, expected) {
	const errors = [];
	if (!provenance || typeof provenance !== 'object') return ['provenance is missing'];
	if (!isRepository(provenance.repository)) errors.push('repository is missing or invalid');
	if (!isGitRevision(provenance.sourceRevision)) errors.push('sourceRevision is missing or invalid');
	if (!isSourceRef(provenance.sourceRef)) errors.push('sourceRef is missing or invalid');
	if (!isWorkflowRunId(provenance.workflowRunId)) errors.push('workflowRunId is missing or invalid');
	if (!Number.isInteger(provenance.workflowRunAttempt) || provenance.workflowRunAttempt < 1) {
		errors.push('workflowRunAttempt is missing or invalid');
	}
	for (const field of ['binarySha256', 'zeusBundleSha256', 'workbenchTableBundleSha256']) {
		if (!isSha256(provenance[field])) errors.push(`${field} is missing or invalid`);
	}
	for (const [field, value] of Object.entries(expected)) {
		if (provenance[field] !== value) errors.push(`${field} does not match expected provenance`);
	}
	return errors;
}

function evaluateMetrics(evidence) {
	const errors = [];
	const summary = {};
	const records = Array.isArray(evidence.records) ? evidence.records : [];
	const grouped = new Map();
	const pairKeys = new Map();
	const pairShapes = new Map();
	const runTokens = new Set();
	const generations = new Set();
	for (const [index, record] of records.entries()) {
		const prefix = `record ${index}`;
		if (!record || typeof record !== 'object' || record.status !== 'ok') {
			errors.push(`${prefix} is not an ok object`);
			continue;
		}
		if (!['1k-x-20', '10k-x-50', 'wide-columns', 'narrow-panel'].includes(record.workloadId)) {
			errors.push(`${prefix} workloadId is invalid`);
		}
		if (!['workbench-table', 'zeus'].includes(record.renderer)) {
			errors.push(`${prefix} renderer is invalid for v8`);
		}
		if (typeof record.pairId !== 'string' || record.pairId.length === 0) errors.push(`${prefix} pairId is missing`);
		if (!isUuidV4(record.runToken) || runTokens.has(record.runToken)) {
			errors.push(`${prefix} runToken is missing, invalid, or duplicated`);
		} else {
			runTokens.add(record.runToken);
		}
		if (!Number.isSafeInteger(record.sessionGeneration) || record.sessionGeneration < 1) {
			errors.push(`${prefix} sessionGeneration is invalid`);
		} else {
			generations.add(record.sessionGeneration);
		}
		const expectedBundle =
			record.renderer === 'zeus'
				? evidence.provenance?.zeusBundleSha256
				: evidence.provenance?.workbenchTableBundleSha256;
		if (record.bundleSha256 !== expectedBundle)
			errors.push(`${prefix} renderer bundle digest does not match provenance`);
		if (!sameRecordProvenance(record.provenance, evidence.provenance)) {
			errors.push(`${prefix} provenance does not match the platform provenance`);
		}
		if (record.diagnostic === true || record.diagnosticOnly === true || record.runtimeCounterInstrumentation) {
			errors.push(`${prefix} diagnostic-only flags are not allowed for v8 admission`);
		}
		if (record.segmentTrace !== undefined || record.traceNavigation === 'separate') {
			errors.push(`${prefix} separate-navigation trace is not allowed for v8 admission`);
		}
		if (record.measurementContractVersion !== FRAME_AWARE_MEASUREMENT_CONTRACT_VERSION) {
			errors.push(`${prefix} measurement contract must be 8`);
		}
		const samples = record.scroll?.samples;
		if (!Array.isArray(samples) || samples.length === 0) {
			errors.push(`${prefix} scroll samples are missing`);
			continue;
		}
		const work = [];
		const totals = [];
		for (const [sampleIndex, sample] of samples.entries()) {
			const samplePrefix = `${prefix} sample ${sampleIndex}`;
			if (sample?.sampleIndex !== sampleIndex || sample?.committed !== true) {
				errors.push(`${samplePrefix} identity or committed flag is invalid`);
			}
			if (typeof sample?.sameExecution?.pairSampleId !== 'string') {
				errors.push(`${samplePrefix} same-execution pairSampleId is missing`);
			}
			const operation = sample?.sameExecution?.rendererOperation;
			if (operation?.phase !== 'sample' || operation?.sampleIndex !== sampleIndex) {
				errors.push(`${samplePrefix} renderer operation is not linked to this sample`);
			}
			const duration = rendererOperationDuration(operation);
			if (duration === undefined) {
				errors.push(`${samplePrefix} renderer operation does not satisfy the symmetric boundary`);
			} else {
				work.push(duration);
			}
			if (!Number.isFinite(sample?.totalMs) || sample.totalMs < 0) errors.push(`${samplePrefix} totalMs is invalid`);
			else totals.push(sample.totalMs);
			const pairKey = `${record.pairId}/${sample?.sameExecution?.pairSampleId}`;
			const renderers = pairKeys.get(pairKey) ?? new Set();
			if (renderers.has(record.renderer)) errors.push(`${samplePrefix} is duplicated for the paired renderer`);
			renderers.add(record.renderer);
			pairKeys.set(pairKey, renderers);
			const shape = pairShapes.get(record.pairId) ?? `${record.workloadId}/${record.iteration ?? ''}`;
			if (shape !== `${record.workloadId}/${record.iteration ?? ''}`) {
				errors.push(`${samplePrefix} pairId is reused across workload or iteration`);
			}
			pairShapes.set(record.pairId, shape);
		}
		const key = `${record.workloadId}/${record.renderer}`;
		const group = grouped.get(key) ?? { work: [], totals: [] };
		group.work.push(...work);
		group.totals.push(...totals);
		grouped.set(key, group);
	}
	if (generations.size !== 1) errors.push('sessionGeneration must be stable across the platform evidence');
	for (const [key, group] of grouped) {
		summary[key] = {
			count: group.work.length,
			rendererWorkP50Ms: summarize(group.work),
			rendererWorkP95Ms: summarize(group.work),
			scrollP95Ms: summarize(group.totals)
		};
	}
	for (const [pairKey, renderers] of pairKeys) {
		if (renderers.size !== 2 || !renderers.has('workbench-table') || !renderers.has('zeus')) {
			errors.push(`${pairKey} must contain exactly one WorkbenchTable and one Zeus sample`);
		}
	}
	const summaryErrors = compareSummary(evidence.summary, summary);
	errors.push(...summaryErrors);
	const metricChecks = evaluatePrimaryMetrics(summary);
	return { checks: metricChecks, summaryErrors: errors };
}

function evaluatePrimaryMetrics(summary) {
	const checks = [];
	for (const workloadId of ['1k-x-20', '10k-x-50']) {
		const zeus = summary[`${workloadId}/zeus`];
		const baseline = summary[`${workloadId}/${FRAME_AWARE_BASELINE_RENDERER}`];
		if (!zeus || !baseline) {
			checks.push({
				id: `${workloadId}-metrics`,
				passed: false,
				reason: `${workloadId}: Zeus and WorkbenchTable metrics are required`
			});
			continue;
		}
		const improvement =
			(baseline.rendererWorkP50Ms.median - zeus.rendererWorkP50Ms.median) / baseline.rendererWorkP50Ms.median;
		const totalRegression = (zeus.scrollP95Ms.median - baseline.scrollP95Ms.median) / baseline.scrollP95Ms.median;
		if (!(baseline.rendererWorkP50Ms.median > 0) || !Number.isFinite(improvement)) {
			checks.push({
				id: `${workloadId}-renderer-work`,
				passed: false,
				reason: `${workloadId}: baseline renderer work is not positive`
			});
			continue;
		}
		const workPassed = workloadId === '10k-x-50' ? improvement >= FRAME_AWARE_REQUIRED_IMPROVEMENT : true;
		const rendererWorkP95Regression =
			(zeus.rendererWorkP95Ms.p95 - baseline.rendererWorkP95Ms.p95) / baseline.rendererWorkP95Ms.p95;
		const rendererWorkP95Passed =
			Number.isFinite(rendererWorkP95Regression) && rendererWorkP95Regression <= FRAME_AWARE_TOTAL_REGRESSION_LIMIT;
		const totalPassed = Number.isFinite(totalRegression) && totalRegression <= FRAME_AWARE_TOTAL_REGRESSION_LIMIT;
		checks.push({
			id: `${workloadId}-renderer-work`,
			passed: workPassed,
			improvement,
			reason: workPassed
				? `${workloadId}: renderer work improvement ${(improvement * 100).toFixed(1)}% meets v8 threshold`
				: `${workloadId}: renderer work improvement ${(improvement * 100).toFixed(1)}% is below v8 threshold`
		});
		checks.push({
			id: `${workloadId}-renderer-work-p95`,
			passed: rendererWorkP95Passed,
			regression: rendererWorkP95Regression,
			reason: rendererWorkP95Passed
				? `${workloadId}: renderer-work p95 stays within 10%`
				: `${workloadId}: renderer-work p95 regression exceeds 10%`
		});
		checks.push({
			id: `${workloadId}-total-regression`,
			passed: totalPassed,
			regression: totalRegression,
			reason: totalPassed
				? `${workloadId}: total scroll regression stays within 10%`
				: `${workloadId}: total scroll regression exceeds 10%`
		});
	}
	return checks;
}

function compareSummary(actual, expected) {
	const errors = [];
	if (!actual || typeof actual !== 'object') return ['summary is missing'];
	const actualKeys = Object.keys(actual).sort();
	const expectedKeys = Object.keys(expected).sort();
	if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys))
		errors.push('summary groups do not match raw records');
	for (const key of expectedKeys) {
		const a = actual[key];
		const e = expected[key];
		for (const metric of ['rendererWorkP50Ms', 'rendererWorkP95Ms', 'scrollP95Ms']) {
			if (!metricEqual(a?.[metric], e?.[metric])) errors.push(`${key} ${metric} does not match raw samples`);
		}
		if (a?.count !== e?.count) errors.push(`${key} count does not match raw samples`);
	}
	return errors;
}

function metricEqual(actual, expected) {
	if (!actual || !expected) return false;
	return (
		actual.available === expected.available &&
		actual.count === expected.count &&
		actual.median === expected.median &&
		actual.p95 === expected.p95 &&
		actual.min === expected.min &&
		actual.max === expected.max
	);
}

function summarize(values) {
	if (values.length === 0) return { available: false, count: 0 };
	const sorted = [...values].sort((left, right) => left - right);
	return {
		available: true,
		count: values.length,
		median: sorted[Math.floor(sorted.length / 2)],
		p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
		min: sorted[0],
		max: sorted.at(-1)
	};
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

function isSha256(value) {
	return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isUuidV4(value) {
	return (
		typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
	);
}

function sameRecordProvenance(actual, expected) {
	if (!actual || typeof actual !== 'object' || !expected || typeof expected !== 'object') return false;
	for (const field of [
		'repository',
		'sourceRevision',
		'sourceRef',
		'workflowRunId',
		'workflowRunAttempt',
		'binarySha256',
		'zeusBundleSha256',
		'workbenchTableBundleSha256'
	]) {
		if (actual[field] !== expected[field]) return false;
	}
	return true;
}
