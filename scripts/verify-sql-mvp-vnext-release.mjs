#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	createBalancedBenchmarkPlan,
	EXECUTION_ORDER,
	MEASUREMENT_CONTRACT_VERSION,
	SCROLL_COMMIT_BOUNDARY
} from './sql-result-grid-benchmark-contract.mjs';
import { verifyAttestationRunMetadata } from './verify-sql-agent-attestation-run.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportPath = resolve(process.argv[2] ?? 'docs/sql-mvp-phases/phase-vnext-release-gate.json');
const z1GatePath = resolve(
	process.env.NYALA_Z1_GATE ?? resolve(repositoryRoot, 'docs/sql-mvp-phases/phase-z1-gate.json')
);
const a4GatePath = resolve(
	process.env.NYALA_A4_CHECKPOINT_W_GATE ?? resolve(repositoryRoot, 'docs/sql-mvp-phases/phase-a4-checkpoint-w.json')
);
const expectedSourceRevision =
	process.env.NYALA_EXPECTED_SOURCE_REVISION ??
	execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
const expectedRepository = process.env.NYALA_EXPECTED_REPOSITORY;
const expectedSourceRef = process.env.NYALA_EXPECTED_SOURCE_REF;
const requiredCheckpointWCheckIds = new Set([
	'capture-run-metadata',
	'macos-native-identity',
	'windows-native-identity',
	'macos-automated-surface',
	'windows-automated-surface',
	'provenance-match',
	'manual-attestation',
	'macos-native-keyboard',
	'macos-voiceover',
	'windows-native-keyboard',
	'windows-narrator'
]);
const requiredZ1MetricCheckIds = new Set(['1k-x-20 scroll interaction', '10k-x-50-primary']);
const requiredZ1BenchmarkCheckIds = new Set([
	'chromium-benchmark-schema-version',
	'chromium-benchmark-measurement-contract-version',
	'chromium-benchmark-scroll-commit-boundary',
	'chromium-benchmark-execution-order',
	'chromium-benchmark-workbench-table-implementation',
	'chromium-benchmark-record-contract',
	'chromium-benchmark-summary-integrity',
	'chromium-benchmark-provenance'
]);
const requiredZ1PlatformEvidenceCheckIds = new Set(
	['macOS WebKit', 'Windows WebView2'].flatMap(label => [
		`${label}-schema-version`,
		`${label}-measurement-contract-version`,
		`${label}-scroll-commit-boundary`,
		`${label}-execution-order`,
		`${label}-record-contract`,
		`${label}-summary-integrity`,
		`${label}-screenshot-integrity`
	])
);
const requiredZ1PlatformMetricCheckIds = new Set(
	['macOS WebKit', 'Windows WebView2'].flatMap(label => [
		`${label}-identity`,
		`${label}-1k-x-20 scroll interaction`,
		`${label}-10k-x-50-primary`,
		...['1k-x-20', '10k-x-50'].flatMap(workload =>
			['native', 'workbench-table', 'zeus'].map(renderer => `${label}-${workload}-${renderer}-long-tail`)
		)
	])
);
const requiredZ1ProvenanceCheckIds = new Set([
	'trusted-expected-workflow-provenance',
	'macOS WebKit-provenance',
	'Windows WebView2-provenance',
	'platform-provenance-repository',
	'platform-provenance-sourceRevision',
	'platform-provenance-sourceRef',
	'platform-provenance-workflowRunId',
	'platform-provenance-workflowRunAttempt',
	'platform-provenance-zeusBundleSha256',
	'platform-provenance-workbenchTableBundleSha256',
	'zeus-bundle-provenance',
	'workbench-table-bundle-provenance'
]);
const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'));
const z1GateBytes = await readFile(z1GatePath);
const z1Gate = JSON.parse(z1GateBytes.toString('utf8'));
const z1GateSha256 = createHash('sha256').update(z1GateBytes).digest('hex');
const a4Gate = JSON.parse(await readFile(a4GatePath, 'utf8'));
const z1Inputs = await loadZ1AttestationInputs();
const a4Inputs = await loadCheckpointWInputs();
const z1AttestationRun = verifyZ1AttestationRun(z1Inputs);
const a4AttestationRun = verifyCheckpointWAttestationRun(a4Gate, a4Inputs);
const z1GateIntegrity = validateZ1Gate(z1Gate, expectedSourceRevision, {
	expectedRepository,
	expectedSourceRef,
	gateSha256: z1GateSha256,
	inputs: z1Inputs,
	attestationRun: z1AttestationRun
});
const a4GateIntegrity = validateCheckpointWGate(a4Gate, {
	expectedRevision: expectedSourceRevision,
	expectedRepository,
	expectedSourceRef,
	inputs: a4Inputs,
	attestationRun: a4AttestationRun
});
const roadmap = await readFile(resolve(repositoryRoot, 'docs/sql-mvp-phases/mvp-vnext-agent-zeus-roadmap.md'), 'utf8');

const checks = [
	check(
		'release-source-revision',
		/^[a-f0-9]{40}$/.test(expectedSourceRevision),
		`release source revision is ${expectedSourceRevision}`,
		`release source revision is invalid: ${expectedSourceRevision}`
	),
	check(
		'agent-default-smoke',
		packageJson.scripts?.test?.includes('pnpm run test:sql-agent'),
		'pnpm run test includes test:sql-agent'
	),
	check(
		'benchmark-default-smoke',
		packageJson.scripts?.test?.includes('pnpm run test:sql-result-grid-benchmark'),
		'pnpm run test includes deterministic result-grid benchmark smoke'
	),
	check(
		'z1-go',
		z1GateIntegrity.passed,
		'Z1 gate decision and evidence integrity are GO',
		`Z1 gate decision/integrity failed: ${z1GateIntegrity.reason}`
	),
	check(
		'z1-source-revision',
		z1Gate.sourceRevision === expectedSourceRevision,
		`Z1 gate targets release revision ${expectedSourceRevision}`,
		`Z1 gate source revision ${z1Gate.sourceRevision ?? 'missing'} does not match ${expectedSourceRevision}`
	),
	check(
		'a4-checkpoint-w',
		a4GateIntegrity.passed,
		'A4 Checkpoint W gate decision is GO',
		`A4 Checkpoint W gate decision/integrity failed: ${a4GateIntegrity.reason}`
	),
	check(
		'a4-source-revision',
		a4Gate.sourceRevision === expectedSourceRevision,
		`A4 Checkpoint W gate targets release revision ${expectedSourceRevision}`,
		`A4 Checkpoint W gate source revision ${a4Gate.sourceRevision ?? 'missing'} does not match ${expectedSourceRevision}`
	),
	check(
		'z2-production-dependency',
		typeof packageJson.dependencies?.['@zeus-web/data-grid'] === 'string',
		'@zeus-web/data-grid is an exact production dependency',
		'@zeus-web/data-grid is not an exact production dependency'
	),
	check(
		'z2-roadmap-status',
		isZ2RoadmapComplete(roadmap),
		'roadmap records Z2 as implemented rather than pending',
		'roadmap does not record Z2 as completed'
	),
	check(
		'z2-renderer-seam',
		await hasZeusRendererSeam(),
		'SQL Result contains a Zeus adapter and native fallback implementation',
		'SQL Result is missing the Zeus adapter/native fallback seam'
	),
	check(
		'zeus-import-boundary',
		await hasOnlySqlResultZeusImports(),
		'Zeus production imports stay inside the SQL Result contribution',
		'Zeus production imports escaped the SQL Result contribution'
	)
];

const report = {
	version: 3,
	generatedAt: new Date().toISOString(),
	sourceRevision: expectedSourceRevision,
	decision: checks.every(item => item.passed) ? 'GO' : 'NO-GO',
	checks,
	blockers: checks.filter(item => !item.passed).map(item => item.reason),
	inputs: {
		z1Decision: z1Gate.decision,
		z1Gate: displayPath(z1GatePath),
		z1Evidence: Object.fromEntries(
			Object.entries(z1Inputs).map(([key, input]) => [
				key,
				{
					path: input.filePath ? displayPath(input.filePath) : null,
					sha256: input.sha256 ?? null,
					error: input.error ?? null
				}
			])
		),
		z1AttestationRun: summarizeAttestationRun(z1AttestationRun),
		a4Decision: a4Gate.decision,
		a4Gate: displayPath(a4GatePath),
		a4Evidence: Object.fromEntries(
			Object.entries(a4Inputs).map(([key, input]) => [
				key,
				{
					path: input.filePath ? displayPath(input.filePath) : null,
					sha256: input.sha256 ?? null,
					error: input.error ?? null
				}
			])
		),
		a4AttestationRun: summarizeAttestationRun(a4AttestationRun)
	}
};

await writeFile(reportPath, `${JSON.stringify(report, null, '\t')}\n`, 'utf8');
console.log(`${report.decision}: ${reportPath}`);
for (const blocker of report.blockers) console.log(`- ${blocker}`);
process.exitCode = report.decision === 'GO' ? 0 : 1;

function check(id, passed, passReason, failReason = passReason) {
	return { id, passed: Boolean(passed), reason: passed ? passReason : failReason };
}

async function loadZ1AttestationInputs() {
	const jsonDefinitions = {
		attestation: ['NYALA_Z1_ATTESTATION', 'Z1 attestation manifest'],
		benchmark: ['NYALA_Z1_BENCHMARK', 'Z1 benchmark evidence'],
		platformEvidence: ['NYALA_Z1_PLATFORM_EVIDENCE', 'Z1 platform evidence'],
		zeusAudit: ['NYALA_Z1_ZEUS_AUDIT', 'Z1 Zeus audit'],
		platformRun: ['NYALA_Z1_PLATFORM_RUN', 'Z1 platform run metadata'],
		attestationRunMetadata: ['NYALA_Z1_ATTESTATION_RUN_METADATA', 'Z1 attestation run API metadata'],
		attestationArtifactMetadata: ['NYALA_Z1_ATTESTATION_ARTIFACT_METADATA', 'Z1 attestation artifact API metadata']
	};
	const entries = await Promise.all(
		Object.entries(jsonDefinitions).map(async ([key, [environmentName, label]]) => [
			key,
			await loadJsonEvidence(process.env[environmentName], label)
		])
	);
	entries.push(['zeusBundle', await loadBinaryEvidence(process.env.NYALA_Z1_ZEUS_BUNDLE, 'Z1 Zeus bundle')]);
	return Object.fromEntries(entries);
}

async function loadCheckpointWInputs() {
	const definitions = {
		macos: ['NYALA_A4_CHECKPOINT_W_MACOS_EVIDENCE', 'macOS native evidence'],
		windows: ['NYALA_A4_CHECKPOINT_W_WINDOWS_EVIDENCE', 'Windows native evidence'],
		manual: ['NYALA_A4_CHECKPOINT_W_MANUAL_ATTESTATION', 'manual attestation'],
		captureRun: ['NYALA_A4_CHECKPOINT_W_CAPTURE_RUN', 'capture run metadata'],
		attestationRunMetadata: ['NYALA_A4_CHECKPOINT_W_ATTESTATION_RUN_METADATA', 'attestation run API metadata'],
		attestationArtifactMetadata: [
			'NYALA_A4_CHECKPOINT_W_ATTESTATION_ARTIFACT_METADATA',
			'attestation artifact API metadata'
		]
	};
	return Object.fromEntries(
		await Promise.all(
			Object.entries(definitions).map(async ([key, [environmentName, label]]) => [
				key,
				await loadJsonEvidence(process.env[environmentName], label)
			])
		)
	);
}

async function loadBinaryEvidence(filePath, label) {
	if (!filePath) return { error: `${label} path is not configured` };
	const resolvedPath = resolve(filePath);
	try {
		const bytes = await readFile(resolvedPath);
		return {
			filePath: resolvedPath,
			bytes,
			sha256: createHash('sha256').update(bytes).digest('hex')
		};
	} catch (error) {
		return {
			filePath: resolvedPath,
			error: `${label} could not be loaded: ${error instanceof Error ? error.message : String(error)}`
		};
	}
}

async function loadJsonEvidence(filePath, label) {
	if (!filePath) return { error: `${label} path is not configured` };
	const resolvedPath = resolve(filePath);
	try {
		const bytes = await readFile(resolvedPath);
		const value = JSON.parse(bytes.toString('utf8'));
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return { filePath: resolvedPath, error: `${label} is not a JSON object` };
		}
		return {
			filePath: resolvedPath,
			value,
			sha256: createHash('sha256').update(bytes).digest('hex')
		};
	} catch (error) {
		return {
			filePath: resolvedPath,
			error: `${label} could not be loaded: ${error instanceof Error ? error.message : String(error)}`
		};
	}
}

function verifyCheckpointWAttestationRun(gate, inputs) {
	const runId = gate?.evidence?.manual?.provenance?.attestationWorkflowRunId;
	return verifyAttestationRunMetadata({
		runMetadata: inputs.attestationRunMetadata.value,
		artifactMetadata: inputs.attestationArtifactMetadata.value,
		expectedRepository,
		expectedRunId: runId,
		expectedRevision: expectedSourceRevision,
		expectedRef: expectedSourceRef
	});
}

function verifyZ1AttestationRun(inputs) {
	const runId = inputs.attestation.value?.provenance?.attestationWorkflowRunId;
	return verifyAttestationRunMetadata({
		runMetadata: inputs.attestationRunMetadata.value,
		artifactMetadata: inputs.attestationArtifactMetadata.value,
		expectedRepository,
		expectedRunId: runId,
		expectedRevision: expectedSourceRevision,
		expectedRef: expectedSourceRef,
		expectedWorkflow: {
			name: 'SQL Result Grid Z1 Gate Attestation',
			path: '.github/workflows/sql-result-grid-gate-attest.yml',
			event: 'workflow_dispatch'
		},
		expectedArtifactName: 'sql-result-grid-gate-attestation'
	});
}

function summarizeAttestationRun(attestationRun) {
	return {
		status: attestationRun.status,
		workflow: attestationRun.workflow,
		run: attestationRun.run,
		provenance: attestationRun.provenance,
		artifacts: attestationRun.artifacts,
		reasons: attestationRun.reasons
	};
}

function validateZ1Gate(gate, expectedRevision, options) {
	const reasons = [];
	if (gate?.version !== 2) reasons.push(`schema version is ${gate?.version ?? 'missing'}`);
	if (gate?.decision !== 'GO') reasons.push(`decision is ${gate?.decision ?? 'missing'}`);
	if (gate?.sourceRevision !== expectedRevision) reasons.push('source revision does not match the release');
	validateRequiredChecks(gate?.metricChecks, requiredZ1MetricCheckIds, 'metric checks', reasons);
	validateRequiredChecks(
		gate?.benchmarkEvidenceChecks,
		requiredZ1BenchmarkCheckIds,
		'benchmark evidence checks',
		reasons
	);
	validateRequiredChecks(
		gate?.platformMetricChecks,
		requiredZ1PlatformMetricCheckIds,
		'platform metric checks',
		reasons
	);
	validateRequiredChecks(
		gate?.platformEvidenceChecks,
		requiredZ1PlatformEvidenceCheckIds,
		'platform evidence checks',
		reasons
	);
	validateRequiredChecks(gate?.provenanceChecks, requiredZ1ProvenanceCheckIds, 'provenance checks', reasons);
	if (!Array.isArray(gate?.reasons) || gate.reasons.length !== 0) reasons.push('gate reasons are not empty');
	if (
		gate?.thresholds?.oneKInteractionRegressionMax !== 0.1 ||
		gate?.thresholds?.tenKPrimaryImprovementMin !== 0.2 ||
		gate?.thresholds?.primaryMetric !== 'scrollP95Ms' ||
		gate?.thresholds?.gzipBudgetBytes !== 30_000
	) {
		reasons.push('pre-registered thresholds are invalid');
	}
	const dependency = gate?.dependencyCheck;
	if (
		dependency?.passed !== true ||
		dependency?.budgetBytes !== 30_000 ||
		!Number.isInteger(dependency?.bundleBytes) ||
		dependency.bundleBytes <= 0 ||
		!Number.isInteger(dependency?.bundleGzipBytes) ||
		dependency.bundleGzipBytes <= 0 ||
		dependency.bundleGzipBytes > dependency.budgetBytes ||
		!isSha256(dependency?.bundleSha256)
	) {
		reasons.push('Zeus dependency/bundle audit summary is invalid');
	}
	if (
		dependency?.package?.name !== '@zeus-web/data-grid' ||
		dependency?.package?.version !== '0.1.0-beta.4' ||
		dependency?.package?.license !== 'MIT' ||
		dependency?.package?.integrity !==
			'sha512-hiaTjf29UY8E/hrMkDm81nVORNWSrqTcInJXQcxZ7azfCfVkN82M8UMe/GDlbQBWksJetq8lT3GbapJEbqZbHA==' ||
		dependency?.package?.unpackedSize !== 341_232
	) {
		reasons.push('Zeus package audit summary is invalid');
	}
	if (
		gate?.benchmark?.measurementContractVersion !== MEASUREMENT_CONTRACT_VERSION ||
		gate?.benchmark?.scrollCommitBoundary !== SCROLL_COMMIT_BOUNDARY ||
		gate?.benchmark?.executionOrder !== EXECUTION_ORDER ||
		gate?.benchmark?.workbenchTableImplementation !== 'real' ||
		gate?.benchmark?.repeat !== 3 ||
		gate?.benchmark?.recordCount !== 36 ||
		!isSha256(gate?.benchmark?.sha256)
	) {
		reasons.push('Chromium benchmark summary is invalid');
	}
	validateZ1PlatformSummary(gate?.platformEvidence?.macosWebKit, 'macos', expectedRevision, reasons);
	validateZ1PlatformSummary(gate?.platformEvidence?.windowsWebView2, 'windows', expectedRevision, reasons);
	validateZ1ProvenanceSummary(gate, expectedRevision, reasons);
	validateZ1Attestation(gate, expectedRevision, options, reasons);
	return { passed: reasons.length === 0, reason: reasons.join('; ') || 'valid' };
}

function validateRequiredChecks(value, requiredIds, label, reasons) {
	const checks = Array.isArray(value) ? value : [];
	const byId = new Map();
	const invalidIds = [];
	for (const item of checks) {
		if (typeof item?.id !== 'string' || byId.has(item.id)) {
			reasons.push(`${label} contain an invalid or duplicate id`);
			continue;
		}
		byId.set(item.id, item);
		if (item.passed !== true || typeof item.reason !== 'string' || item.reason.length === 0) {
			invalidIds.push(item.id);
		}
	}
	const missingIds = [...requiredIds].filter(id => !byId.has(id));
	if (invalidIds.length > 0) reasons.push(`${label} have ${invalidIds.length} failed checks: ${invalidIds.join(', ')}`);
	if (missingIds.length > 0) reasons.push(`${label} are missing ${missingIds.length} required checks`);
	if (byId.size !== requiredIds.size) reasons.push(`${label} do not match the required contract`);
}

function validateZ1PlatformSummary(summary, platform, expectedRevision, reasons) {
	const label = platform === 'macos' ? 'macOS WebKit' : 'Windows WebView2';
	const expectedIdentity =
		platform === 'macos'
			? {
					platformName: 'macos',
					engine: 'wkwebview-embedded',
					browser: 'webkit',
					nativeWebView2: false
				}
			: {
					platformName: 'windows',
					engine: 'webview2-embedded',
					browser: 'msedge',
					nativeWebView2: true
				};
	if (
		summary?.version !== 2 ||
		summary?.measurementContractVersion !== MEASUREMENT_CONTRACT_VERSION ||
		summary?.scrollCommitBoundary !== SCROLL_COMMIT_BOUNDARY ||
		summary?.executionOrder !== EXECUTION_ORDER ||
		summary?.status !== 'ready' ||
		summary?.runs !== 5 ||
		summary?.driverProvider !== 'embedded' ||
		summary?.nativeWebView !== true ||
		Object.entries(expectedIdentity).some(([field, value]) => summary?.[field] !== value)
	) {
		reasons.push(`${label} identity/status summary is invalid`);
	}
	const records = Array.isArray(summary?.records) ? summary.records : [];
	const workloadIds = ['1k-x-20', '10k-x-50', 'wide-columns', 'narrow-panel'];
	const renderers = ['native', 'workbench-table', 'zeus'];
	const expectedPlan = createBalancedBenchmarkPlan(
		workloadIds.map(id => ({ id })),
		renderers,
		5
	);
	const tuples = new Set(
		records.map(record => `${record?.workloadId}/${record?.renderer}/${String(record?.iteration)}`)
	);
	if (
		records.length !== 60 ||
		tuples.size !== 60 ||
		records.some(
			(record, index) =>
				record?.status !== 'ok' ||
				!workloadIds.includes(record?.workloadId) ||
				!renderers.includes(record?.renderer) ||
				!Number.isInteger(record?.iteration) ||
				record.iteration < 1 ||
				record.iteration > 5 ||
				record.executionOrder !== EXECUTION_ORDER ||
				record.executionOrdinal !== index + 1 ||
				record.workloadId !== expectedPlan[index]?.workload.id ||
				record.renderer !== expectedPlan[index]?.renderer ||
				record.iteration !== expectedPlan[index]?.iteration
		)
	) {
		reasons.push(`${label} raw record summary is invalid`);
	}
	const screenshots = Array.isArray(summary?.screenshots) ? summary.screenshots : [];
	const screenshotKeys = new Set(
		screenshots.map(item => `${item?.workloadId}/${item?.renderer}/${String(item?.iteration)}`)
	);
	if (
		screenshots.length !== 12 ||
		screenshotKeys.size !== 12 ||
		screenshots.some(
			item =>
				!isSafeScreenshotName(item?.file) ||
				item?.iteration !== 1 ||
				!Number.isInteger(item?.bytes) ||
				item.bytes <= 0 ||
				!isSha256(item?.sha256)
		)
	) {
		reasons.push(`${label} screenshot manifest summary is invalid`);
	}
	if (
		summary?.provenance?.sourceRevision !== expectedRevision ||
		!isSha256(summary?.provenance?.binarySha256) ||
		!isSha256(summary?.provenance?.zeusBundleSha256) ||
		!isSha256(summary?.provenance?.workbenchTableBundleSha256)
	) {
		reasons.push(`${label} source/binary/bundle provenance summary is invalid`);
	}
}

function validateZ1ProvenanceSummary(gate, expectedRevision, reasons) {
	const sources = [
		gate?.benchmark?.provenance,
		gate?.dependencyCheck?.provenance,
		gate?.platformEvidence?.macosWebKit?.provenance,
		gate?.platformEvidence?.windowsWebView2?.provenance
	];
	for (const field of ['repository', 'sourceRevision', 'sourceRef', 'workflowRunId', 'workflowRunAttempt']) {
		const values = sources.map(source => source?.[field]);
		if (values.some(value => value === undefined) || !values.every(value => value === values[0])) {
			reasons.push(`Z1 ${field} provenance summary does not match`);
		}
	}
	if (sources.some(source => source?.sourceRevision !== expectedRevision)) {
		reasons.push('Z1 provenance summary does not target the release revision');
	}
	const bundleHashes = [
		gate?.benchmark?.provenance?.zeusBundleSha256,
		gate?.dependencyCheck?.bundleSha256,
		gate?.platformEvidence?.macosWebKit?.provenance?.zeusBundleSha256,
		gate?.platformEvidence?.windowsWebView2?.provenance?.zeusBundleSha256
	];
	if (!bundleHashes.every(value => isSha256(value) && value === bundleHashes[0])) {
		reasons.push('Z1 Zeus bundle SHA-256 provenance summary does not match');
	}
	const workbenchTableBundleHashes = [
		gate?.benchmark?.provenance?.workbenchTableBundleSha256,
		gate?.platformEvidence?.macosWebKit?.provenance?.workbenchTableBundleSha256,
		gate?.platformEvidence?.windowsWebView2?.provenance?.workbenchTableBundleSha256
	];
	if (!workbenchTableBundleHashes.every(value => isSha256(value) && value === workbenchTableBundleHashes[0])) {
		reasons.push('Z1 WorkbenchTable bundle SHA-256 provenance summary does not match');
	}
}

function validateZ1Attestation(gate, expectedRevision, options, reasons) {
	const { expectedRepository: repository, expectedSourceRef: sourceRef, gateSha256, inputs, attestationRun } = options;
	for (const input of Object.values(inputs)) {
		if (input.error) reasons.push(input.error);
	}
	const attestation = inputs.attestation.value;
	if (
		attestation?.version !== 1 ||
		attestation?.status !== 'recorded' ||
		attestation?.gateDecision !== 'GO' ||
		!Array.isArray(attestation?.reasons) ||
		attestation.reasons.length !== 0
	) {
		reasons.push('Z1 attestation manifest is not a recorded GO');
	}
	if (!isRepository(repository)) reasons.push('trusted expected repository is missing or invalid');
	if (!isSourceRef(sourceRef)) reasons.push('trusted expected source ref is missing or invalid');
	const provenance = attestation?.provenance;
	if (
		provenance?.repository !== repository ||
		provenance?.sourceRevision !== expectedRevision ||
		provenance?.sourceRef !== sourceRef ||
		!isWorkflowRunId(provenance?.platformWorkflowRunId) ||
		!Number.isInteger(provenance?.platformWorkflowRunAttempt) ||
		provenance.platformWorkflowRunAttempt < 1 ||
		!isWorkflowRunId(provenance?.attestationWorkflowRunId) ||
		!Number.isInteger(provenance?.attestationWorkflowRunAttempt) ||
		provenance.attestationWorkflowRunAttempt < 1 ||
		provenance?.attestationWorkflowRunUrl !==
			`https://github.com/${repository}/actions/runs/${provenance?.attestationWorkflowRunId}`
	) {
		reasons.push('Z1 attestation provenance is invalid or does not match the trusted release');
	}
	if (
		isWorkflowRunId(provenance?.platformWorkflowRunId) &&
		isWorkflowRunId(provenance?.attestationWorkflowRunId) &&
		BigInt(provenance.attestationWorkflowRunId) <= BigInt(provenance.platformWorkflowRunId)
	) {
		reasons.push('Z1 attestation workflow does not follow the platform workflow');
	}

	const digestInputs = {
		gate: gateSha256,
		benchmark: inputs.benchmark.sha256,
		platformEvidence: inputs.platformEvidence.sha256,
		zeusAudit: inputs.zeusAudit.sha256,
		zeusBundle: inputs.zeusBundle.sha256,
		platformRun: inputs.platformRun.sha256
	};
	const inputDigests = attestation?.inputDigests;
	if (
		!inputDigests ||
		typeof inputDigests !== 'object' ||
		Array.isArray(inputDigests) ||
		Object.keys(inputDigests).length !== Object.keys(digestInputs).length
	) {
		reasons.push('Z1 attestation input digest contract is invalid');
	}
	for (const [key, digest] of Object.entries(digestInputs)) {
		if (!isSha256(digest) || inputDigests?.[key] !== digest) {
			reasons.push(`Z1 ${key} raw input digest does not match the attestation`);
		}
	}
	if (
		gate?.dependencyCheck?.bundleSha256 !== inputs.zeusBundle.sha256 ||
		gate?.benchmark?.provenance?.zeusBundleSha256 !== inputs.zeusBundle.sha256
	) {
		reasons.push('Z1 gate bundle provenance does not match the attested bundle bytes');
	}

	const platformRun = inputs.platformRun.value;
	if (
		platformRun?.version !== 1 ||
		platformRun?.status !== 'verified' ||
		!Array.isArray(platformRun?.reasons) ||
		platformRun.reasons.length !== 0 ||
		platformRun?.workflow?.name !== 'SQL Result Grid Native WebView Evidence' ||
		platformRun?.workflow?.path !== '.github/workflows/sql-result-grid-platform.yml' ||
		platformRun?.workflow?.event !== 'workflow_dispatch' ||
		!isWorkflowRunId(platformRun?.workflow?.id)
	) {
		reasons.push('Z1 platform run metadata summary is invalid');
	}
	const platformProvenance = platformRun?.provenance;
	if (
		platformProvenance?.repository !== repository ||
		platformProvenance?.sourceRevision !== expectedRevision ||
		platformProvenance?.sourceRef !== sourceRef ||
		platformProvenance?.workflowRunId !== provenance?.platformWorkflowRunId ||
		platformProvenance?.workflowRunAttempt !== provenance?.platformWorkflowRunAttempt ||
		platformRun?.run?.id !== platformProvenance?.workflowRunId ||
		platformRun?.run?.attempt !== platformProvenance?.workflowRunAttempt ||
		platformRun?.run?.status !== 'completed' ||
		platformRun?.run?.conclusion !== 'success' ||
		platformRun?.run?.headSha !== expectedRevision ||
		platformRun?.run?.htmlUrl !==
			`https://github.com/${repository}/actions/runs/${platformProvenance?.workflowRunId}` ||
		!isIsoDate(platformRun?.run?.updatedAt)
	) {
		reasons.push('Z1 platform run provenance does not match the trusted release');
	}
	if (
		!isWorkflowRunId(platformRun?.aggregateArtifactId) ||
		!isSha256(platformRun?.aggregateArtifactDigest) ||
		platformRun?.aggregateArtifactUrl !==
			`https://api.github.com/repos/${repository}/actions/artifacts/${platformRun?.aggregateArtifactId}/zip` ||
		attestation?.platformRun?.aggregateArtifactId !== platformRun?.aggregateArtifactId ||
		attestation?.platformRun?.aggregateArtifactDigest !== platformRun?.aggregateArtifactDigest ||
		attestation?.platformRun?.aggregateArtifactUrl !== platformRun?.aggregateArtifactUrl
	) {
		reasons.push('Z1 aggregate platform artifact identity does not match the attestation');
	}

	if (attestationRun.status !== 'verified' || attestationRun.reasons.length > 0) {
		reasons.push(`Z1 attestation workflow metadata is not verified: ${attestationRun.reasons.join(', ') || 'blocked'}`);
		return;
	}
	if (
		attestationRun.provenance?.workflowRunId !== provenance?.attestationWorkflowRunId ||
		attestationRun.provenance?.workflowRunAttempt !== provenance?.attestationWorkflowRunAttempt ||
		attestationRun.run?.htmlUrl !== provenance?.attestationWorkflowRunUrl
	) {
		reasons.push('Z1 attestation workflow metadata does not match the manifest provenance');
	}
	const platformUpdatedAt = isoTimestamp(platformRun?.run?.updatedAt);
	const runCreatedAt = isoTimestamp(attestationRun.run?.createdAt);
	const runStartedAt = isoTimestamp(attestationRun.run?.runStartedAt);
	const runUpdatedAt = isoTimestamp(attestationRun.run?.updatedAt);
	const gateGeneratedAt = isoTimestamp(gate?.generatedAt);
	const manifestGeneratedAt = isoTimestamp(attestation?.generatedAt);
	if (
		!platformUpdatedAt ||
		!runCreatedAt ||
		!runStartedAt ||
		!runUpdatedAt ||
		!gateGeneratedAt ||
		!manifestGeneratedAt ||
		platformUpdatedAt > runCreatedAt ||
		runCreatedAt > runStartedAt ||
		gateGeneratedAt < runStartedAt ||
		manifestGeneratedAt < gateGeneratedAt ||
		isAfterOutsideTimestampPrecision(manifestGeneratedAt, runUpdatedAt) ||
		attestation?.gateGeneratedAt !== gate?.generatedAt
	) {
		reasons.push('Z1 platform, gate, manifest, and attestation run timestamps are out of order');
	}
	const artifact = attestationRun.artifacts?.[0];
	const artifactCreatedAt = isoTimestamp(artifact?.createdAt);
	const artifactUpdatedAt = isoTimestamp(artifact?.updatedAt);
	if (
		!artifactCreatedAt ||
		!artifactUpdatedAt ||
		!manifestGeneratedAt ||
		isAfterOutsideTimestampPrecision(manifestGeneratedAt, artifactCreatedAt) ||
		artifactUpdatedAt > runUpdatedAt
	) {
		reasons.push('Z1 attestation artifact timestamps do not contain the manifest');
	}
}

function validateCheckpointWGate(gate, options) {
	const {
		expectedRevision,
		expectedRepository: repository,
		expectedSourceRef: sourceRef,
		inputs,
		attestationRun
	} = options;
	const reasons = [];
	if (gate?.version !== 2) reasons.push(`schema version is ${gate?.version ?? 'missing'}`);
	if (gate?.decision !== 'GO') reasons.push(`decision is ${gate?.decision ?? 'missing'}`);
	if (gate?.sourceRevision !== expectedRevision) reasons.push('source revision does not match the release');
	if (!isRepository(repository)) reasons.push('trusted expected repository is missing or invalid');
	if (!isSourceRef(sourceRef)) reasons.push('trusted expected source ref is missing or invalid');
	if (!isIsoDate(gate?.generatedAt)) reasons.push('gate generation timestamp is invalid');
	const gateChecks = Array.isArray(gate?.checks) ? gate.checks : [];
	const checksById = new Map();
	for (const gateCheck of gateChecks) {
		if (typeof gateCheck?.id !== 'string' || checksById.has(gateCheck.id)) {
			reasons.push('checks contain an invalid or duplicate id');
			continue;
		}
		checksById.set(gateCheck.id, gateCheck);
		if (gateCheck.passed !== true || typeof gateCheck.reason !== 'string' || gateCheck.reason.length === 0) {
			reasons.push(`check ${gateCheck.id} is not a recorded pass`);
		}
	}
	for (const id of requiredCheckpointWCheckIds) {
		if (!checksById.has(id)) reasons.push(`required check ${id} is missing`);
	}
	if (!Array.isArray(gate?.blockers) || gate.blockers.length !== 0) reasons.push('blockers are not empty');
	const inputDigests = gate?.inputDigests;
	const expectedDigestKeys = ['macos', 'windows', 'manual', 'captureRun'];
	if (
		!inputDigests ||
		typeof inputDigests !== 'object' ||
		Array.isArray(inputDigests) ||
		Object.keys(inputDigests).length !== expectedDigestKeys.length ||
		!expectedDigestKeys.every(key => isSha256(inputDigests[key]))
	) {
		reasons.push('Checkpoint W input digests are invalid');
	}
	validateCheckpointRawInputs(inputDigests, inputs, reasons);
	validateCheckpointCaptureRunSummary(gate?.evidence?.captureRun, expectedRevision, reasons);
	validateCheckpointNativeSummary(gate?.evidence?.macos, 'macos', expectedRevision, reasons);
	validateCheckpointNativeSummary(gate?.evidence?.windows, 'windows', expectedRevision, reasons);
	validateCheckpointManualSummary(gate?.evidence?.manual, expectedRevision, reasons);
	validateCheckpointSummaryProvenance(gate?.evidence, reasons);
	validateExpectedCheckpointProvenance(gate?.evidence, repository, sourceRef, reasons);
	validateCheckpointAttestationRun(gate, inputs, attestationRun, reasons);
	return { passed: reasons.length === 0, reason: reasons.join('; ') || 'valid' };
}

function validateCheckpointRawInputs(inputDigests, inputs, reasons) {
	for (const key of ['macos', 'windows', 'manual', 'captureRun']) {
		const input = inputs[key];
		if (input.error) {
			reasons.push(input.error);
			continue;
		}
		if (!isSha256(input.sha256) || input.sha256 !== inputDigests?.[key]) {
			reasons.push(`Checkpoint W ${key} raw input digest does not match the gate`);
		}
	}
	for (const key of ['attestationRunMetadata', 'attestationArtifactMetadata']) {
		if (inputs[key].error) reasons.push(inputs[key].error);
	}
}

function validateExpectedCheckpointProvenance(evidence, repository, sourceRef, reasons) {
	const sources = [
		['capture run', evidence?.captureRun?.provenance],
		['macOS', evidence?.macos?.provenance],
		['Windows', evidence?.windows?.provenance],
		['manual', evidence?.manual?.provenance]
	];
	for (const [label, provenance] of sources) {
		if (provenance?.repository !== repository)
			reasons.push(`${label} repository does not match the trusted release repository`);
		if (provenance?.sourceRef !== sourceRef) reasons.push(`${label} source ref does not match the trusted release ref`);
	}
}

function validateCheckpointAttestationRun(gate, inputs, attestationRun, reasons) {
	if (attestationRun.status !== 'verified' || attestationRun.reasons.length > 0) {
		reasons.push(`attestation workflow metadata is not verified: ${attestationRun.reasons.join(', ') || 'blocked'}`);
		return;
	}
	const manualProvenance = gate?.evidence?.manual?.provenance;
	if (
		attestationRun.provenance?.workflowRunId !== manualProvenance?.attestationWorkflowRunId ||
		attestationRun.provenance?.workflowRunAttempt !== manualProvenance?.attestationWorkflowRunAttempt ||
		attestationRun.run?.htmlUrl !== manualProvenance?.attestationWorkflowRunUrl
	) {
		reasons.push('attestation workflow metadata does not match the manual attestation provenance');
	}
	const runCreatedAt = isoTimestamp(attestationRun.run?.createdAt);
	const runStartedAt = isoTimestamp(attestationRun.run?.runStartedAt);
	const runUpdatedAt = isoTimestamp(attestationRun.run?.updatedAt);
	const captureUpdatedAt = isoTimestamp(inputs.captureRun.value?.run?.updatedAt);
	const reviewedAt = isoTimestamp(inputs.manual.value?.provenance?.reviewedAt);
	const generatedAt = isoTimestamp(gate?.generatedAt);
	if (
		!runCreatedAt ||
		!runStartedAt ||
		!runUpdatedAt ||
		!captureUpdatedAt ||
		!reviewedAt ||
		!generatedAt ||
		captureUpdatedAt > runCreatedAt ||
		runCreatedAt > runStartedAt ||
		captureUpdatedAt > reviewedAt ||
		reviewedAt < runStartedAt ||
		reviewedAt > runUpdatedAt ||
		generatedAt < reviewedAt ||
		isAfterOutsideTimestampPrecision(generatedAt, runUpdatedAt)
	) {
		reasons.push('capture, review, gate, and attestation run timestamps are out of order');
	}
	const artifact = attestationRun.artifacts?.[0];
	const artifactCreatedAt = isoTimestamp(artifact?.createdAt);
	const artifactUpdatedAt = isoTimestamp(artifact?.updatedAt);
	if (
		!artifactCreatedAt ||
		!artifactUpdatedAt ||
		!generatedAt ||
		isAfterOutsideTimestampPrecision(generatedAt, artifactCreatedAt) ||
		artifactUpdatedAt > runUpdatedAt
	) {
		reasons.push('Checkpoint W aggregate artifact timestamps do not contain the generated gate');
	}
}

function isAfterOutsideTimestampPrecision(left, right) {
	return Math.floor(left / 1000) > Math.floor(right / 1000);
}

function validateCheckpointCaptureRunSummary(summary, expectedRevision, reasons) {
	if (summary?.version !== 1 || summary?.status !== 'verified') {
		reasons.push('capture run metadata summary is not verified');
	}
	if (
		summary?.workflow?.name !== 'SQL Agent Native Workbench Capture' ||
		summary?.workflow?.path !== '.github/workflows/sql-agent-native.yml' ||
		summary?.workflow?.event !== 'workflow_dispatch' ||
		!isWorkflowRunId(summary?.workflow?.id)
	) {
		reasons.push('capture workflow identity is invalid');
	}
	const provenance = summary?.provenance;
	if (
		!isRepository(provenance?.repository) ||
		provenance?.sourceRevision !== expectedRevision ||
		!isSourceRef(provenance?.sourceRef) ||
		!isWorkflowRunId(provenance?.workflowRunId) ||
		!Number.isInteger(provenance?.workflowRunAttempt) ||
		provenance.workflowRunAttempt < 1
	) {
		reasons.push('capture run provenance is invalid');
	}
	if (
		summary?.run?.id !== provenance?.workflowRunId ||
		summary?.run?.attempt !== provenance?.workflowRunAttempt ||
		summary?.run?.headSha !== provenance?.sourceRevision ||
		summary?.run?.status !== 'completed' ||
		summary?.run?.conclusion !== 'success' ||
		summary?.run?.htmlUrl !==
			`https://github.com/${provenance?.repository}/actions/runs/${provenance?.workflowRunId}` ||
		!isIsoDate(summary?.run?.runStartedAt) ||
		!isIsoDate(summary?.run?.updatedAt)
	) {
		reasons.push('capture run identity or completion state is invalid');
	}
	const artifacts = Array.isArray(summary?.artifacts) ? summary.artifacts : [];
	const expectedNames = ['sql-agent-native-macos', 'sql-agent-native-windows'];
	if (artifacts.length !== 2) reasons.push('capture artifact summary count is invalid');
	for (const name of expectedNames) {
		const matches = artifacts.filter(artifact => artifact?.name === name);
		if (
			matches.length !== 1 ||
			!isWorkflowRunId(matches[0]?.id) ||
			!Number.isInteger(matches[0]?.bytes) ||
			matches[0].bytes <= 0 ||
			!isSha256(matches[0]?.digest) ||
			!isIsoDate(matches[0]?.createdAt) ||
			!isIsoDate(matches[0]?.updatedAt)
		) {
			reasons.push(`${name} artifact summary is invalid`);
		}
	}
	if (new Set(artifacts.map(artifact => artifact?.id)).size !== artifacts.length) {
		reasons.push('capture artifact ids are not unique');
	}
}

function validateCheckpointNativeSummary(summary, platform, expectedRevision, reasons) {
	const label = platform === 'macos' ? 'macOS' : 'Windows';
	const expectedEngine = platform === 'macos' ? 'wkwebview-embedded' : 'webview2-embedded';
	if (summary?.version !== 2) reasons.push(`${label} evidence version is invalid`);
	if (summary?.status !== 'ready' || summary?.automatedSurfaceStatus !== 'ready') {
		reasons.push(`${label} automated surface is not ready`);
	}
	if (summary?.platformName !== platform || summary?.engine !== expectedEngine) {
		reasons.push(`${label} native identity summary is invalid`);
	}
	if (summary?.provenance?.sourceRevision !== expectedRevision || !isSha256(summary?.provenance?.binarySha256)) {
		reasons.push(`${label} revision/binary provenance is invalid`);
	}
	const screenshots = Array.isArray(summary?.screenshots) ? summary.screenshots : [];
	for (const viewport of ['desktop', 'narrow']) {
		const matches = screenshots.filter(item => item?.viewport === viewport);
		if (matches.length !== 1 || !isSafeScreenshotName(matches[0]?.file) || !isSha256(matches[0]?.sha256)) {
			reasons.push(`${label} ${viewport} screenshot summary is invalid`);
		}
	}
	if (screenshots.length !== 2) reasons.push(`${label} screenshot summary count is invalid`);
}

function validateCheckpointManualSummary(summary, expectedRevision, reasons) {
	if (summary?.version !== 2 || summary?.status !== 'attested') reasons.push('manual evidence summary is not attested');
	if (summary?.provenance?.sourceRevision !== expectedRevision) reasons.push('manual evidence revision is invalid');
	const provenance = summary?.provenance;
	if (typeof provenance?.reviewer !== 'string' || provenance.reviewer.trim().length < 2) {
		reasons.push('manual reviewer provenance is invalid');
	}
	if (!isIsoDate(provenance?.reviewedAt)) reasons.push('manual review timestamp is invalid');
	if (
		provenance?.workflowRunUrl !==
		`https://github.com/${provenance?.repository}/actions/runs/${provenance?.workflowRunId}`
	) {
		reasons.push('manual capture workflow URL is invalid');
	}
	if (
		!isWorkflowRunId(provenance?.attestationWorkflowRunId) ||
		!Number.isInteger(provenance?.attestationWorkflowRunAttempt) ||
		provenance.attestationWorkflowRunAttempt < 1 ||
		provenance?.attestationWorkflowRunUrl !==
			`https://github.com/${provenance?.repository}/actions/runs/${provenance?.attestationWorkflowRunId}` ||
		!isWorkflowRunId(provenance?.workflowRunId) ||
		BigInt(provenance.attestationWorkflowRunId) <= BigInt(provenance.workflowRunId)
	) {
		reasons.push('manual attestation workflow provenance is invalid');
	}
	const requiredGateEvidence = ['macosKeyboard', 'voiceOver', 'windowsKeyboard', 'narrator'];
	const gateEvidence = summary?.gateEvidence;
	if (
		!gateEvidence ||
		typeof gateEvidence !== 'object' ||
		Array.isArray(gateEvidence) ||
		Object.keys(gateEvidence).length !== requiredGateEvidence.length ||
		!requiredGateEvidence.every(key => isSafeManualEvidenceRef(gateEvidence[key]))
	) {
		reasons.push('manual gate-local evidence references are invalid');
	} else {
		const normalized = requiredGateEvidence.map(key => normalizeManualEvidenceRef(gateEvidence[key]));
		if (new Set(normalized).size !== normalized.length) {
			reasons.push('manual gate-local evidence references are not unique');
		}
	}
}

function validateCheckpointSummaryProvenance(evidence, reasons) {
	const sources = [
		evidence?.captureRun?.provenance,
		evidence?.macos?.provenance,
		evidence?.windows?.provenance,
		evidence?.manual?.provenance
	];
	for (const field of ['repository', 'sourceRevision', 'sourceRef', 'workflowRunId', 'workflowRunAttempt']) {
		const values = sources.map(source => source?.[field]);
		if (values.some(value => value === undefined) || !values.every(value => value === values[0])) {
			reasons.push(`evidence summary ${field} provenance does not match`);
		}
	}
}

function isSha256(value) {
	return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isRepository(value) {
	return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function isSourceRef(value) {
	return typeof value === 'string' && /^refs\/(heads|tags|pull)\//.test(value);
}

function isWorkflowRunId(value) {
	return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

function isIsoDate(value) {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isoTimestamp(value) {
	return isIsoDate(value) ? Date.parse(value) : undefined;
}

function isSafeManualEvidenceRef(value) {
	return normalizeManualEvidenceRef(value) !== undefined;
}

function normalizeManualEvidenceRef(value) {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > 2048 ||
		value.trim() !== value ||
		!/^(?:https|qa):\/\//iu.test(value) ||
		value.includes('\\') ||
		value.includes('?') ||
		value.includes('#') ||
		/[\s\u0000-\u001f\u007f]/u.test(value) ||
		/%(?:0[0-9a-f]|1[0-9a-f]|20|7f)/iu.test(value)
	) {
		return undefined;
	}
	try {
		const parsed = new URL(value);
		return (parsed.protocol === 'https:' || parsed.protocol === 'qa:') &&
			parsed.username === '' &&
			parsed.password === '' &&
			parsed.search === '' &&
			parsed.hash === '' &&
			parsed.hostname !== ''
			? parsed.href
			: undefined;
	} catch {
		return undefined;
	}
}

function isSafeScreenshotName(value) {
	return typeof value === 'string' && /^[A-Za-z0-9_.-]+\.png$/.test(value);
}

function displayPath(path) {
	const repositoryRelative = relative(repositoryRoot, path);
	if (
		repositoryRelative === '' ||
		(!repositoryRelative.startsWith(`..${sep}`) && repositoryRelative !== '..' && !isAbsolute(repositoryRelative))
	) {
		return repositoryRelative.split(sep).join('/') || '.';
	}
	return `<external>/${path.split(sep).at(-1)}`;
}

function isZ2RoadmapComplete(source) {
	const row = source.match(/^\|\s*Z2\s*\|\s*Result Grid Preview\s*\|[^\n]+$/m)?.[0];
	return typeof row === 'string' && /\|\s*已完成(?:\s|（|\|)/.test(row);
}

async function hasZeusRendererSeam() {
	const rendererRoot = resolve(repositoryRoot, 'src/vs/workbench/contrib/sqlResult/browser/zeus');
	try {
		const entries = await readdir(rendererRoot, { withFileTypes: true });
		if (!entries.some(entry => entry.isFile() && /\.(ts|css)$/.test(entry.name))) {
			return false;
		}
		const source = await readDirectoryText(rendererRoot);
		return /native|fallback/i.test(source) && /zeus|data-grid/i.test(source);
	} catch {
		return false;
	}
}

async function hasOnlySqlResultZeusImports() {
	const workbenchRoot = resolve(repositoryRoot, 'src/vs/workbench');
	const files = await listFiles(workbenchRoot);
	for (const file of files.filter(file => /\.(ts|tsx|js|mjs)$/.test(file))) {
		const source = await readFile(file, 'utf8');
		if (/@zeus-web|@zeus-js|zw-data-grid/.test(source) && !file.includes('/contrib/sqlResult/')) {
			return false;
		}
	}
	return true;
}

async function listFiles(directory) {
	const files = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const fullPath = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFiles(fullPath)));
		} else {
			files.push(fullPath);
		}
	}
	return files;
}

async function readDirectoryText(directory) {
	const files = await listFiles(directory);
	return (
		await Promise.all(files.filter(file => /\.(ts|tsx|js|css)$/.test(file)).map(file => readFile(file, 'utf8')))
	).join('\n');
}
