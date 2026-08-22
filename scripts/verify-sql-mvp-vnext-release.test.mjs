import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
	createBalancedBenchmarkPlan,
	EXECUTION_ORDER,
	MEASUREMENT_CONTRACT_VERSION,
	SCROLL_COMMIT_BOUNDARY
} from './sql-result-grid-benchmark-contract.mjs';

const execFileAsync = promisify(execFile);

function createValidZ1Gate(sourceRevision) {
	const bundleSha256 = 'b'.repeat(64);
	const workbenchTableBundleSha256 = 'e'.repeat(64);
	const commonProvenance = {
		repository: 'baicie/nyala-studio',
		sourceRevision,
		sourceRef: 'refs/heads/mvp',
		workflowRunId: '123456789',
		workflowRunAttempt: 1
	};
	const labels = ['macOS WebKit', 'Windows WebView2'];
	const workloads = ['1k-x-20', '10k-x-50', 'wide-columns', 'narrow-panel'];
	const renderers = ['native', 'workbench-table', 'zeus'];
	const platformPlan = createBalancedBenchmarkPlan(
		workloads.map(id => ({ id })),
		renderers,
		5
	);
	const platformEvidence = Object.fromEntries(
		labels.map((label, platformIndex) => {
			const platformName = platformIndex === 0 ? 'macos' : 'windows';
			return [
				platformIndex === 0 ? 'macosWebKit' : 'windowsWebView2',
				{
					version: 2,
					measurementContractVersion: MEASUREMENT_CONTRACT_VERSION,
					scrollCommitBoundary: SCROLL_COMMIT_BOUNDARY,
					executionOrder: EXECUTION_ORDER,
					status: 'ready',
					runs: 5,
					driverProvider: 'embedded',
					nativeWebView: true,
					nativeWebView2: platformIndex === 1,
					engine: platformIndex === 0 ? 'wkwebview-embedded' : 'webview2-embedded',
					browser: platformIndex === 0 ? 'webkit' : 'msedge',
					platformName,
					provenance: {
						...commonProvenance,
						binarySha256: String(platformIndex + 1).repeat(64),
						zeusBundleSha256: bundleSha256,
						workbenchTableBundleSha256
					},
					records: platformPlan.map(({ workload, renderer, iteration, executionOrdinal }) => ({
						status: 'ok',
						workloadId: workload.id,
						renderer,
						iteration,
						executionOrder: EXECUTION_ORDER,
						executionOrdinal
					})),
					screenshots: workloads.flatMap(workloadId =>
						renderers.map(renderer => ({
							file: `${platformName}-${workloadId}-${renderer}.png`,
							workloadId,
							renderer,
							iteration: 1,
							bytes: 1,
							sha256: 'c'.repeat(64)
						}))
					)
				}
			];
		})
	);
	const passed = id => ({ id, passed: true, reason: `${id} passed` });
	const platformMetricChecks = labels.flatMap(label => [
		passed(`${label}-identity`),
		passed(`${label}-1k-x-20 scroll interaction`),
		passed(`${label}-10k-x-50-primary`),
		...['1k-x-20', '10k-x-50'].flatMap(workload =>
			renderers.map(renderer => passed(`${label}-${workload}-${renderer}-long-tail`))
		)
	]);
	return {
		version: 2,
		generatedAt: '2026-08-16T04:05:00.000Z',
		sourceRevision,
		decision: 'GO',
		thresholds: {
			oneKInteractionRegressionMax: 0.1,
			tenKPrimaryImprovementMin: 0.2,
			primaryMetric: 'scrollP95Ms',
			gzipBudgetBytes: 30_000
		},
		benchmark: {
			measurementContractVersion: MEASUREMENT_CONTRACT_VERSION,
			scrollCommitBoundary: SCROLL_COMMIT_BOUNDARY,
			executionOrder: EXECUTION_ORDER,
			workbenchTableImplementation: 'real',
			repeat: 3,
			recordCount: 36,
			sha256: 'd'.repeat(64),
			provenance: { ...commonProvenance, zeusBundleSha256: bundleSha256, workbenchTableBundleSha256 }
		},
		metricChecks: [passed('1k-x-20 scroll interaction'), passed('10k-x-50-primary')],
		benchmarkEvidenceChecks: [
			passed('chromium-benchmark-schema-version'),
			passed('chromium-benchmark-measurement-contract-version'),
			passed('chromium-benchmark-scroll-commit-boundary'),
			passed('chromium-benchmark-execution-order'),
			passed('chromium-benchmark-workbench-table-implementation'),
			passed('chromium-benchmark-record-contract'),
			passed('chromium-benchmark-summary-integrity'),
			passed('chromium-benchmark-provenance')
		],
		platformMetricChecks,
		platformEvidenceChecks: labels.flatMap(label => [
			passed(`${label}-schema-version`),
			passed(`${label}-measurement-contract-version`),
			passed(`${label}-scroll-commit-boundary`),
			passed(`${label}-execution-order`),
			passed(`${label}-record-contract`),
			passed(`${label}-summary-integrity`),
			passed(`${label}-screenshot-integrity`)
		]),
		provenanceChecks: [
			passed('trusted-expected-workflow-provenance'),
			passed('macOS WebKit-provenance'),
			passed('Windows WebView2-provenance'),
			...[
				'repository',
				'sourceRevision',
				'sourceRef',
				'workflowRunId',
				'workflowRunAttempt',
				'zeusBundleSha256',
				'workbenchTableBundleSha256'
			].map(field => passed(`platform-provenance-${field}`)),
			passed('zeus-bundle-provenance'),
			passed('workbench-table-bundle-provenance')
		],
		dependencyCheck: {
			passed: true,
			budgetBytes: 30_000,
			bundleBytes: 100,
			bundleGzipBytes: 90,
			bundleSha256,
			package: {
				name: '@zeus-web/data-grid',
				version: '0.1.0-beta.4',
				license: 'MIT',
				integrity: 'sha512-hiaTjf29UY8E/hrMkDm81nVORNWSrqTcInJXQcxZ7azfCfVkN82M8UMe/GDlbQBWksJetq8lT3GbapJEbqZbHA==',
				unpackedSize: 341_232
			},
			provenance: commonProvenance
		},
		platformEvidence,
		reasons: []
	};
}

function createValidCheckpointWGate(
	sourceRevision,
	inputDigests = {
		macos: '1'.repeat(64),
		windows: '2'.repeat(64),
		manual: '3'.repeat(64),
		captureRun: '4'.repeat(64)
	}
) {
	const commonProvenance = {
		repository: 'baicie/nyala-studio',
		sourceRevision,
		sourceRef: 'refs/heads/mvp',
		workflowRunId: '123456789',
		workflowRunAttempt: 1
	};
	const passed = id => ({ id, passed: true, reason: `${id} passed` });
	const nativeSummary = (platform, binarySha256) => ({
		version: 2,
		status: 'ready',
		automatedSurfaceStatus: 'ready',
		platformName: platform,
		engine: platform === 'macos' ? 'wkwebview-embedded' : 'webview2-embedded',
		provenance: { ...commonProvenance, binarySha256 },
		screenshots: ['desktop', 'narrow'].map(viewport => ({
			viewport,
			file: `sql-agent-${platform}-${viewport}.png`,
			sha256: 'd'.repeat(64)
		}))
	});
	return {
		version: 2,
		generatedAt: '2026-08-16T03:15:00.000Z',
		decision: 'GO',
		sourceRevision,
		checks: [
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
		].map(passed),
		blockers: [],
		inputDigests,
		evidence: {
			captureRun: {
				version: 1,
				status: 'verified',
				workflow: {
					id: '987654',
					name: 'SQL Agent Native Workbench Capture',
					path: '.github/workflows/sql-agent-native.yml',
					event: 'workflow_dispatch'
				},
				run: {
					id: commonProvenance.workflowRunId,
					attempt: commonProvenance.workflowRunAttempt,
					status: 'completed',
					conclusion: 'success',
					headSha: sourceRevision,
					headBranch: 'mvp',
					runStartedAt: '2026-08-16T01:00:00.000Z',
					updatedAt: '2026-08-16T02:00:00.000Z',
					htmlUrl: 'https://github.com/baicie/nyala-studio/actions/runs/123456789'
				},
				provenance: commonProvenance,
				artifacts: [
					{
						id: '111',
						name: 'sql-agent-native-macos',
						bytes: 4096,
						digest: '5'.repeat(64),
						createdAt: '2026-08-16T01:30:00.000Z',
						updatedAt: '2026-08-16T01:31:00.000Z'
					},
					{
						id: '222',
						name: 'sql-agent-native-windows',
						bytes: 4096,
						digest: '6'.repeat(64),
						createdAt: '2026-08-16T01:30:00.000Z',
						updatedAt: '2026-08-16T01:31:00.000Z'
					}
				]
			},
			macos: nativeSummary('macos', 'a'.repeat(64)),
			windows: nativeSummary('windows', 'b'.repeat(64)),
			manual: {
				version: 2,
				status: 'attested',
				provenance: {
					...commonProvenance,
					reviewer: 'nyala-qa',
					reviewedAt: '2026-08-16T03:00:00.000Z',
					workflowRunUrl: 'https://github.com/baicie/nyala-studio/actions/runs/123456789',
					attestationWorkflowRunId: '223456789',
					attestationWorkflowRunAttempt: 1,
					attestationWorkflowRunUrl: 'https://github.com/baicie/nyala-studio/actions/runs/223456789'
				},
				gateEvidence: {
					macosKeyboard: 'qa://checkpoint-w/macos-keyboard',
					voiceOver: 'qa://checkpoint-w/voiceover',
					windowsKeyboard: 'qa://checkpoint-w/windows-keyboard',
					narrator: 'qa://checkpoint-w/narrator'
				}
			}
		}
	};
}

function serializeJson(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

function createRawManualAttestation(summary) {
	const keyboard = platform => ({
		status: 'passed',
		focusOrder: ['prompt', 'task', 'access-mode', 'start', 'cancel'],
		startCancelReachable: true,
		noFocusTrap: true,
		evidenceRef: summary.gateEvidence[`${platform}Keyboard`]
	});
	const screenReader = (assistiveTechnology, evidenceKey) => ({
		status: 'passed',
		assistiveTechnology,
		labelsAnnounced: true,
		stateChangesAnnounced: true,
		noFocusTrap: true,
		evidenceRef: summary.gateEvidence[evidenceKey]
	});
	return {
		version: summary.version,
		status: summary.status,
		provenance: summary.provenance,
		platforms: {
			macos: {
				nativeKeyboard: keyboard('macos'),
				screenReader: screenReader('VoiceOver', 'voiceOver')
			},
			windows: {
				nativeKeyboard: keyboard('windows'),
				screenReader: screenReader('Narrator', 'narrator')
			}
		}
	};
}

function createAttestationRunMetadata(sourceRevision) {
	return {
		id: 223456789,
		name: 'SQL Agent Checkpoint W Attestation',
		workflow_id: 876543,
		head_branch: 'mvp',
		head_sha: sourceRevision,
		path: '.github/workflows/sql-agent-checkpoint-w-attest.yml',
		event: 'workflow_dispatch',
		status: 'completed',
		conclusion: 'success',
		run_attempt: 1,
		created_at: '2026-08-16T02:15:00.000Z',
		run_started_at: '2026-08-16T02:30:00.000Z',
		updated_at: '2026-08-16T03:30:00.000Z',
		html_url: 'https://github.com/baicie/nyala-studio/actions/runs/223456789',
		artifacts_url: 'https://api.github.com/repos/baicie/nyala-studio/actions/runs/223456789/artifacts',
		repository: { full_name: 'baicie/nyala-studio' },
		head_repository: { full_name: 'baicie/nyala-studio' }
	};
}

function createAttestationArtifactMetadata(sourceRevision) {
	return {
		total_count: 1,
		artifacts: [
			{
				id: 333,
				name: 'sql-agent-checkpoint-w',
				size_in_bytes: 8192,
				expired: false,
				digest: `sha256:${'7'.repeat(64)}`,
				created_at: '2026-08-16T03:20:00.000Z',
				updated_at: '2026-08-16T03:21:00.000Z',
				expires_at: '2026-08-30T03:20:00.000Z',
				archive_download_url: 'https://api.github.com/repos/baicie/nyala-studio/actions/artifacts/333/zip',
				workflow_run: {
					id: 223456789,
					head_branch: 'mvp',
					head_sha: sourceRevision
				}
			}
		]
	};
}

async function runCheckpointWReleaseScenario({ includeRawEvidence = true, mutate, expected = {} } = {}) {
	const root = await mkdtemp(join(tmpdir(), 'nyala-r0-checkpoint-w-evidence-test-'));
	try {
		const sourceRevision = 'f'.repeat(40);
		const seedGate = createValidCheckpointWGate(sourceRevision);
		const raw = {
			macos: seedGate.evidence.macos,
			windows: seedGate.evidence.windows,
			manual: createRawManualAttestation(seedGate.evidence.manual),
			captureRun: {
				...seedGate.evidence.captureRun,
				generatedAt: '2026-08-16T02:15:00.000Z',
				artifactIds: seedGate.evidence.captureRun.artifacts.map(artifact => artifact.id),
				reasons: []
			}
		};
		const rawJson = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, serializeJson(value)]));
		const gate = createValidCheckpointWGate(
			sourceRevision,
			Object.fromEntries(Object.entries(rawJson).map(([key, value]) => [key, sha256(value)]))
		);
		const attestationRun = createAttestationRunMetadata(sourceRevision);
		const attestationArtifacts = createAttestationArtifactMetadata(sourceRevision);
		mutate?.({ gate, raw, attestationRun, attestationArtifacts });

		const paths = Object.fromEntries(
			['gate', 'macos', 'windows', 'manual', 'captureRun', 'attestationRun', 'attestationArtifacts', 'output'].map(
				name => [name, join(root, `${name}.json`)]
			)
		);
		await Promise.all([
			writeFile(paths.gate, serializeJson(gate), 'utf8'),
			...Object.entries(raw).map(([key, value]) => writeFile(paths[key], serializeJson(value), 'utf8')),
			writeFile(paths.attestationRun, serializeJson(attestationRun), 'utf8'),
			writeFile(paths.attestationArtifacts, serializeJson(attestationArtifacts), 'utf8')
		]);
		const evidenceEnv = {
			NYALA_A4_CHECKPOINT_W_MACOS_EVIDENCE: paths.macos,
			NYALA_A4_CHECKPOINT_W_WINDOWS_EVIDENCE: paths.windows,
			NYALA_A4_CHECKPOINT_W_MANUAL_ATTESTATION: paths.manual,
			NYALA_A4_CHECKPOINT_W_CAPTURE_RUN: paths.captureRun,
			NYALA_A4_CHECKPOINT_W_ATTESTATION_RUN_METADATA: paths.attestationRun,
			NYALA_A4_CHECKPOINT_W_ATTESTATION_ARTIFACT_METADATA: paths.attestationArtifacts
		};
		const env = {
			...process.env,
			NYALA_EXPECTED_SOURCE_REVISION: sourceRevision,
			NYALA_EXPECTED_REPOSITORY: expected.repository ?? 'baicie/nyala-studio',
			NYALA_EXPECTED_SOURCE_REF: expected.sourceRef ?? 'refs/heads/mvp',
			NYALA_A4_CHECKPOINT_W_GATE: paths.gate,
			...evidenceEnv
		};
		if (!includeRawEvidence) {
			for (const key of Object.keys(evidenceEnv)) delete env[key];
		}
		const executionError = await execFileAsync(
			process.execPath,
			['scripts/verify-sql-mvp-vnext-release.mjs', paths.output],
			{ env }
		).then(
			() => undefined,
			error => error
		);
		assert.ok(executionError instanceof Error, 'R0 remains NO-GO because later release checks are intentionally unmet');
		try {
			return JSON.parse(await readFile(paths.output, 'utf8'));
		} catch (error) {
			error.message += `\nVerifier stderr:\n${executionError.stderr ?? ''}`;
			throw error;
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function createZ1AttestationRunMetadata(sourceRevision) {
	return {
		id: 423456789,
		name: 'SQL Result Grid Z1 Gate Attestation',
		workflow_id: 765432,
		head_branch: 'mvp',
		head_sha: sourceRevision,
		path: '.github/workflows/sql-result-grid-gate-attest.yml',
		event: 'workflow_dispatch',
		status: 'completed',
		conclusion: 'success',
		run_attempt: 1,
		created_at: '2026-08-16T04:01:00.000Z',
		run_started_at: '2026-08-16T04:02:00.000Z',
		updated_at: '2026-08-16T04:10:00.000Z',
		html_url: 'https://github.com/baicie/nyala-studio/actions/runs/423456789',
		artifacts_url: 'https://api.github.com/repos/baicie/nyala-studio/actions/runs/423456789/artifacts',
		repository: { full_name: 'baicie/nyala-studio' },
		head_repository: { full_name: 'baicie/nyala-studio' }
	};
}

function createZ1AttestationArtifactMetadata(sourceRevision) {
	return {
		total_count: 1,
		artifacts: [
			{
				id: 777,
				name: 'sql-result-grid-gate-attestation',
				size_in_bytes: 16384,
				expired: false,
				digest: `sha256:${'8'.repeat(64)}`,
				created_at: '2026-08-16T04:08:00.000Z',
				updated_at: '2026-08-16T04:09:00.000Z',
				expires_at: '2026-08-30T04:08:00.000Z',
				archive_download_url: 'https://api.github.com/repos/baicie/nyala-studio/actions/artifacts/777/zip',
				workflow_run: {
					id: 423456789,
					head_branch: 'mvp',
					head_sha: sourceRevision
				}
			}
		]
	};
}

async function runZ1ReleaseScenario({ includeAttestation = true, mutate, expected = {} } = {}) {
	const root = await mkdtemp(join(tmpdir(), 'nyala-r0-z1-attestation-test-'));
	try {
		const sourceRevision = 'f'.repeat(40);
		const gate = createValidZ1Gate(sourceRevision);
		const bundle = Buffer.from('b'.repeat(20));
		const bundleSha256 = sha256(bundle);
		gate.benchmark.provenance.zeusBundleSha256 = bundleSha256;
		gate.dependencyCheck.bundleSha256 = bundleSha256;
		gate.platformEvidence.macosWebKit.provenance.zeusBundleSha256 = bundleSha256;
		gate.platformEvidence.windowsWebView2.provenance.zeusBundleSha256 = bundleSha256;
		const commonProvenance = gate.benchmark.provenance;
		const raw = {
			benchmark: { version: 1, provenance: gate.benchmark.provenance },
			platformEvidence: { version: 1, ...gate.platformEvidence },
			zeusAudit: {
				version: 1,
				status: 'ready',
				provenance: commonProvenance,
				bundle: { file: 'data-grid-bundle.js', bytes: 20, sha256: gate.dependencyCheck.bundleSha256 }
			},
			platformRun: {
				version: 1,
				generatedAt: '2026-08-16T04:00:30.000Z',
				status: 'verified',
				workflow: {
					id: '2345678',
					name: 'SQL Result Grid Native WebView Evidence',
					path: '.github/workflows/sql-result-grid-platform.yml',
					event: 'workflow_dispatch'
				},
				run: {
					id: commonProvenance.workflowRunId,
					attempt: commonProvenance.workflowRunAttempt,
					status: 'completed',
					conclusion: 'success',
					headSha: sourceRevision,
					headBranch: 'mvp',
					createdAt: '2026-08-16T00:45:00.000Z',
					runStartedAt: '2026-08-16T01:00:00.000Z',
					updatedAt: '2026-08-16T04:00:00.000Z',
					htmlUrl: `https://github.com/baicie/nyala-studio/actions/runs/${commonProvenance.workflowRunId}`
				},
				provenance: commonProvenance,
				aggregateArtifactId: '444',
				aggregateArtifactDigest: '4'.repeat(64),
				aggregateArtifactUrl: 'https://api.github.com/repos/baicie/nyala-studio/actions/artifacts/444/zip',
				reasons: []
			}
		};
		const rawJson = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, serializeJson(value)]));
		const gateJson = serializeJson(gate);
		const attestation = {
			version: 1,
			generatedAt: '2026-08-16T04:06:00.000Z',
			status: 'recorded',
			gateDecision: 'GO',
			gateGeneratedAt: gate.generatedAt,
			provenance: {
				repository: commonProvenance.repository,
				sourceRevision,
				sourceRef: commonProvenance.sourceRef,
				platformWorkflowRunId: commonProvenance.workflowRunId,
				platformWorkflowRunAttempt: commonProvenance.workflowRunAttempt,
				attestationWorkflowRunId: '423456789',
				attestationWorkflowRunAttempt: 1,
				attestationWorkflowRunUrl: 'https://github.com/baicie/nyala-studio/actions/runs/423456789'
			},
			inputDigests: {
				gate: sha256(gateJson),
				benchmark: sha256(rawJson.benchmark),
				platformEvidence: sha256(rawJson.platformEvidence),
				zeusAudit: sha256(rawJson.zeusAudit),
				zeusBundle: sha256(bundle),
				platformRun: sha256(rawJson.platformRun)
			},
			platformRun: {
				workflow: raw.platformRun.workflow,
				run: raw.platformRun.run,
				aggregateArtifactId: raw.platformRun.aggregateArtifactId,
				aggregateArtifactDigest: raw.platformRun.aggregateArtifactDigest,
				aggregateArtifactUrl: raw.platformRun.aggregateArtifactUrl
			},
			reasons: []
		};
		const attestationRun = createZ1AttestationRunMetadata(sourceRevision);
		const attestationArtifacts = createZ1AttestationArtifactMetadata(sourceRevision);
		mutate?.({ gate, raw, bundle, attestation, attestationRun, attestationArtifacts });

		const paths = Object.fromEntries(
			[
				'gate',
				'benchmark',
				'platformEvidence',
				'zeusAudit',
				'zeusBundle',
				'platformRun',
				'attestation',
				'attestationRun',
				'attestationArtifacts',
				'output'
			].map(name => [name, join(root, `${name}.${name === 'zeusBundle' ? 'js' : 'json'}`)])
		);
		await Promise.all([
			writeFile(paths.gate, serializeJson(gate), 'utf8'),
			...Object.entries(raw).map(([key, value]) => writeFile(paths[key], serializeJson(value), 'utf8')),
			writeFile(paths.zeusBundle, bundle),
			writeFile(paths.attestation, serializeJson(attestation), 'utf8'),
			writeFile(paths.attestationRun, serializeJson(attestationRun), 'utf8'),
			writeFile(paths.attestationArtifacts, serializeJson(attestationArtifacts), 'utf8')
		]);
		const evidenceEnv = {
			NYALA_Z1_ATTESTATION: paths.attestation,
			NYALA_Z1_BENCHMARK: paths.benchmark,
			NYALA_Z1_PLATFORM_EVIDENCE: paths.platformEvidence,
			NYALA_Z1_ZEUS_AUDIT: paths.zeusAudit,
			NYALA_Z1_ZEUS_BUNDLE: paths.zeusBundle,
			NYALA_Z1_PLATFORM_RUN: paths.platformRun,
			NYALA_Z1_ATTESTATION_RUN_METADATA: paths.attestationRun,
			NYALA_Z1_ATTESTATION_ARTIFACT_METADATA: paths.attestationArtifacts
		};
		const env = {
			...process.env,
			NYALA_EXPECTED_SOURCE_REVISION: sourceRevision,
			NYALA_EXPECTED_REPOSITORY: expected.repository ?? 'baicie/nyala-studio',
			NYALA_EXPECTED_SOURCE_REF: expected.sourceRef ?? 'refs/heads/mvp',
			NYALA_Z1_GATE: paths.gate,
			...evidenceEnv
		};
		if (!includeAttestation) {
			for (const key of Object.keys(evidenceEnv)) delete env[key];
		}
		const executionError = await execFileAsync(
			process.execPath,
			['scripts/verify-sql-mvp-vnext-release.mjs', paths.output],
			{ env }
		).then(
			() => undefined,
			error => error
		);
		assert.ok(executionError instanceof Error, 'R0 remains NO-GO because later release checks are intentionally unmet');
		return JSON.parse(await readFile(paths.output, 'utf8'));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test('R0 verifier is fail-closed on the current Z1 No-Go state', async () => {
	const source = await readFile(new URL('./verify-sql-mvp-vnext-release.mjs', import.meta.url), 'utf8');
	const report = JSON.parse(
		await readFile(new URL('../docs/sql-mvp-phases/phase-vnext-release-gate.json', import.meta.url), 'utf8')
	);
	assert.match(source, /NO-GO/);
	assert.equal(report.decision, 'NO-GO');
	assert.ok(report.blockers.some(reason => reason.includes('Z1 gate decision')));
});

test('R0 verifier consumes the structured Checkpoint W gate instead of Markdown wording', async () => {
	const source = await readFile(new URL('./verify-sql-mvp-vnext-release.mjs', import.meta.url), 'utf8');
	assert.match(source, /phase-a4-checkpoint-w\.json/);
	assert.doesNotMatch(source, /phase-a4-workbench-verification\.md|a4Verification/);

	const root = await mkdtemp(join(tmpdir(), 'nyala-r0-gate-test-'));
	try {
		const output = join(root, 'release-gate.json');
		await assert.rejects(execFileAsync(process.execPath, ['scripts/verify-sql-mvp-vnext-release.mjs', output]));
		const report = JSON.parse(await readFile(output, 'utf8'));
		assert.equal(report.decision, 'NO-GO');
		assert.ok(report.blockers.some(reason => reason.includes('A4 Checkpoint W gate decision')));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('R0 verifier binds A4 and Z1 gate artifacts to the expected release revision', async () => {
	const source = await readFile(new URL('./verify-sql-mvp-vnext-release.mjs', import.meta.url), 'utf8');
	assert.match(source, /NYALA_EXPECTED_SOURCE_REVISION/);
	assert.match(source, /NYALA_A4_CHECKPOINT_W_GATE/);
	assert.match(source, /NYALA_Z1_GATE/);

	const root = await mkdtemp(join(tmpdir(), 'nyala-r0-revision-test-'));
	try {
		const output = join(root, 'release-gate.json');
		await assert.rejects(
			execFileAsync(process.execPath, ['scripts/verify-sql-mvp-vnext-release.mjs', output], {
				env: { ...process.env, NYALA_EXPECTED_SOURCE_REVISION: 'f'.repeat(40) }
			})
		);
		const report = JSON.parse(await readFile(output, 'utf8'));
		assert.equal(report.sourceRevision, 'f'.repeat(40));
		assert.equal(report.checks.find(check => check.id === 'a4-source-revision')?.passed, false);
		assert.equal(report.checks.find(check => check.id === 'z1-source-revision')?.passed, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('R0 verifier rejects a minimal forged Checkpoint W GO document', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-r0-forged-a4-test-'));
	try {
		const output = join(root, 'release-gate.json');
		const a4Gate = join(root, 'a4-gate.json');
		const expectedRevision = 'f'.repeat(40);
		await writeFile(
			a4Gate,
			`${JSON.stringify({ version: 1, decision: 'GO', sourceRevision: expectedRevision })}\n`,
			'utf8'
		);
		await assert.rejects(
			execFileAsync(process.execPath, ['scripts/verify-sql-mvp-vnext-release.mjs', output], {
				env: {
					...process.env,
					NYALA_EXPECTED_SOURCE_REVISION: expectedRevision,
					NYALA_A4_CHECKPOINT_W_GATE: a4Gate
				}
			})
		);
		const report = JSON.parse(await readFile(output, 'utf8'));
		assert.equal(report.checks.find(check => check.id === 'a4-checkpoint-w')?.passed, false);
		assert.match(report.checks.find(check => check.id === 'a4-checkpoint-w')?.reason ?? '', /integrity/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('R0 verifier accepts a complete Checkpoint W gate bound to raw and attestation evidence', async () => {
	const report = await runCheckpointWReleaseScenario();
	assert.equal(report.checks.find(check => check.id === 'a4-checkpoint-w')?.passed, true);
	assert.equal(report.checks.find(check => check.id === 'a4-source-revision')?.passed, true);
	assert.equal(report.decision, 'NO-GO');
});

test('R0 verifier rejects a complete handwritten Checkpoint W gate without raw or attestation metadata', async () => {
	const report = await runCheckpointWReleaseScenario({ includeRawEvidence: false });
	assert.equal(report.checks.find(check => check.id === 'a4-checkpoint-w')?.passed, false);
});

test('R0 verifier rejects a Checkpoint W raw input whose digest differs from the gate', async () => {
	const report = await runCheckpointWReleaseScenario({
		mutate: ({ raw }) => {
			raw.macos.status = 'tampered-after-gate';
		}
	});
	assert.equal(report.checks.find(check => check.id === 'a4-checkpoint-w')?.passed, false);
});

for (const mismatch of [
	{ label: 'repository', expected: { repository: 'other/nyala-studio' } },
	{ label: 'source ref', expected: { sourceRef: 'refs/heads/release' } }
]) {
	test(`R0 verifier rejects Checkpoint W evidence that mismatches the expected ${mismatch.label}`, async () => {
		const report = await runCheckpointWReleaseScenario({ expected: mismatch.expected });
		assert.equal(report.checks.find(check => check.id === 'a4-checkpoint-w')?.passed, false);
	});
}

for (const invalidAttestation of [
	{
		label: 'workflow path',
		mutate: ({ attestationRun }) => {
			attestationRun.path = '.github/workflows/forged.yml';
		}
	},
	{
		label: 'head SHA',
		mutate: ({ attestationRun }) => {
			attestationRun.head_sha = 'e'.repeat(40);
		}
	},
	{
		label: 'conclusion',
		mutate: ({ attestationRun }) => {
			attestationRun.conclusion = 'failure';
		}
	},
	{
		label: 'artifact digest',
		mutate: ({ attestationArtifacts }) => {
			attestationArtifacts.artifacts[0].digest = 'sha256:not-a-digest';
		}
	},
	{
		label: 'expired artifact',
		mutate: ({ attestationArtifacts }) => {
			attestationArtifacts.artifacts[0].expired = true;
		}
	}
]) {
	test(`R0 verifier rejects invalid Checkpoint W attestation ${invalidAttestation.label}`, async () => {
		const report = await runCheckpointWReleaseScenario({ mutate: invalidAttestation.mutate });
		assert.equal(report.checks.find(check => check.id === 'a4-checkpoint-w')?.passed, false);
	});
}

test('R0 verifier rejects a manual review completed before the capture run finished', async () => {
	const report = await runCheckpointWReleaseScenario({
		mutate: ({ gate, raw }) => {
			const reviewedAt = '2026-08-16T01:59:59.000Z';
			gate.evidence.manual.provenance.reviewedAt = reviewedAt;
			raw.manual.provenance.reviewedAt = reviewedAt;
			gate.inputDigests.manual = sha256(serializeJson(raw.manual));
		}
	});
	assert.equal(report.checks.find(check => check.id === 'a4-checkpoint-w')?.passed, false);
});

test('R0 verifier rejects a Checkpoint W gate generated outside its attestation run window', async () => {
	const report = await runCheckpointWReleaseScenario({
		mutate: ({ gate }) => {
			gate.generatedAt = '2026-08-16T03:30:01.000Z';
		}
	});
	assert.equal(report.checks.find(check => check.id === 'a4-checkpoint-w')?.passed, false);
});

test('R0 verifier rejects an attestation dispatched before the native capture completed', async () => {
	const report = await runCheckpointWReleaseScenario({
		mutate: ({ attestationRun }) => {
			attestationRun.created_at = '2026-08-16T01:59:59.000Z';
		}
	});
	assert.equal(report.checks.find(check => check.id === 'a4-checkpoint-w')?.passed, false);
});

test('R0 verifier rejects Checkpoint W evidence from an untrusted capture workflow', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-r0-capture-workflow-test-'));
	try {
		const output = join(root, 'release-gate.json');
		const a4Gate = join(root, 'a4-gate.json');
		const expectedRevision = 'f'.repeat(40);
		const gate = createValidCheckpointWGate(expectedRevision);
		gate.evidence.captureRun.workflow.path = '.github/workflows/forged.yml';
		await writeFile(a4Gate, `${JSON.stringify(gate)}\n`, 'utf8');
		await assert.rejects(
			execFileAsync(process.execPath, ['scripts/verify-sql-mvp-vnext-release.mjs', output], {
				env: {
					...process.env,
					NYALA_EXPECTED_SOURCE_REVISION: expectedRevision,
					NYALA_A4_CHECKPOINT_W_GATE: a4Gate
				}
			})
		);
		const report = JSON.parse(await readFile(output, 'utf8'));
		assert.equal(report.checks.find(check => check.id === 'a4-checkpoint-w')?.passed, false);
		assert.match(report.checks.find(check => check.id === 'a4-checkpoint-w')?.reason ?? '', /capture workflow/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('R0 verifier rejects missing or unsafe Checkpoint W gate-local evidence', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-r0-invalid-a4-evidence-test-'));
	try {
		const output = join(root, 'release-gate.json');
		const a4Gate = join(root, 'a4-gate.json');
		const expectedRevision = 'f'.repeat(40);
		const gate = createValidCheckpointWGate(expectedRevision);
		gate.evidence.manual.gateEvidence.narrator = 'https://reviewer:secret@example.test/checkpoint-w?narrator=passed';
		await writeFile(a4Gate, `${JSON.stringify(gate)}\n`, 'utf8');
		await assert.rejects(
			execFileAsync(process.execPath, ['scripts/verify-sql-mvp-vnext-release.mjs', output], {
				env: {
					...process.env,
					NYALA_EXPECTED_SOURCE_REVISION: expectedRevision,
					NYALA_A4_CHECKPOINT_W_GATE: a4Gate
				}
			})
		);
		const report = JSON.parse(await readFile(output, 'utf8'));
		assert.equal(report.checks.find(check => check.id === 'a4-checkpoint-w')?.passed, false);
		assert.match(report.checks.find(check => check.id === 'a4-checkpoint-w')?.reason ?? '', /gate-local/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('R0 verifier rejects a minimal forged Z1 GO document', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-r0-forged-z1-test-'));
	try {
		const output = join(root, 'release-gate.json');
		const z1Gate = join(root, 'z1-gate.json');
		const expectedRevision = 'f'.repeat(40);
		await writeFile(
			z1Gate,
			`${JSON.stringify({ version: 2, decision: 'GO', sourceRevision: expectedRevision })}\n`,
			'utf8'
		);
		await assert.rejects(
			execFileAsync(process.execPath, ['scripts/verify-sql-mvp-vnext-release.mjs', output], {
				env: {
					...process.env,
					NYALA_EXPECTED_SOURCE_REVISION: expectedRevision,
					NYALA_Z1_GATE: z1Gate
				}
			})
		);
		const report = JSON.parse(await readFile(output, 'utf8'));
		assert.equal(report.checks.find(check => check.id === 'z1-go')?.passed, false);
		assert.match(report.checks.find(check => check.id === 'z1-go')?.reason ?? '', /integrity/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('R0 verifier rejects a complete handwritten Z1 GO without raw attestation evidence', async () => {
	const report = await runZ1ReleaseScenario({ includeAttestation: false });
	assert.equal(report.checks.find(check => check.id === 'z1-go')?.passed, false);
});

test('R0 verifier accepts a Z1 GO bound to raw inputs and a protected attestation run', async () => {
	const report = await runZ1ReleaseScenario();
	assert.equal(report.checks.find(check => check.id === 'z1-go')?.passed, true);
	assert.equal(report.checks.find(check => check.id === 'z1-source-revision')?.passed, true);
	assert.equal(report.decision, 'NO-GO');
});

test('R0 verifier rejects a Z1 GO that omits the v6 measurement and execution-order checks', async () => {
	const report = await runZ1ReleaseScenario({
		mutate: ({ gate }) => {
			gate.benchmarkEvidenceChecks = gate.benchmarkEvidenceChecks.filter(
				check => !['chromium-benchmark-scroll-commit-boundary', 'chromium-benchmark-execution-order'].includes(check.id)
			);
			gate.platformEvidenceChecks = gate.platformEvidenceChecks.filter(
				check => !check.id.endsWith('-scroll-commit-boundary') && !check.id.endsWith('-execution-order')
			);
		}
	});
	assert.equal(report.checks.find(check => check.id === 'z1-go')?.passed, false);
});

test('R0 verifier rejects a Z1 GO that omits real WorkbenchTable identity or bundle binding checks', async () => {
	const report = await runZ1ReleaseScenario({
		mutate: ({ gate }) => {
			gate.benchmarkEvidenceChecks = gate.benchmarkEvidenceChecks.filter(
				check => check.id !== 'chromium-benchmark-workbench-table-implementation'
			);
			gate.provenanceChecks = gate.provenanceChecks.filter(
				check =>
					!['platform-provenance-workbenchTableBundleSha256', 'workbench-table-bundle-provenance'].includes(check.id)
			);
		}
	});
	assert.equal(report.checks.find(check => check.id === 'z1-go')?.passed, false);
});

test('R0 verifier rejects mismatched WorkbenchTable bundle provenance summaries', async () => {
	const report = await runZ1ReleaseScenario({
		mutate: ({ gate }) => {
			gate.platformEvidence.windowsWebView2.provenance.workbenchTableBundleSha256 = 'f'.repeat(64);
		}
	});
	assert.equal(report.checks.find(check => check.id === 'z1-go')?.passed, false);
	assert.match(
		report.checks.find(check => check.id === 'z1-go')?.reason ?? '',
		/WorkbenchTable bundle SHA-256 provenance summary does not match/
	);
});

test('R0 verifier rejects a Z1 GO with a forged platform execution plan', async () => {
	const report = await runZ1ReleaseScenario({
		mutate: ({ gate }) => {
			[gate.platformEvidence.macosWebKit.records[0], gate.platformEvidence.macosWebKit.records[1]] = [
				gate.platformEvidence.macosWebKit.records[1],
				gate.platformEvidence.macosWebKit.records[0]
			];
		}
	});
	assert.equal(report.checks.find(check => check.id === 'z1-go')?.passed, false);
	assert.match(report.checks.find(check => check.id === 'z1-go')?.reason ?? '', /raw record summary is invalid/);
});

test('R0 verifier rejects a Z1 raw input changed after attestation', async () => {
	const report = await runZ1ReleaseScenario({
		mutate: ({ raw }) => {
			raw.platformEvidence.version = 999;
		}
	});
	assert.equal(report.checks.find(check => check.id === 'z1-go')?.passed, false);
});

test('R0 verifier rejects Z1 evidence from another expected repository or ref', async () => {
	const report = await runZ1ReleaseScenario({ expected: { sourceRef: 'refs/heads/release' } });
	assert.equal(report.checks.find(check => check.id === 'z1-go')?.passed, false);
});

test('R0 verifier rejects a forged or expired Z1 attestation run artifact', async () => {
	const report = await runZ1ReleaseScenario({
		mutate: ({ attestationRun, attestationArtifacts }) => {
			attestationRun.path = '.github/workflows/forged.yml';
			attestationArtifacts.artifacts[0].expired = true;
		}
	});
	assert.equal(report.checks.find(check => check.id === 'z1-go')?.passed, false);
});

test('R0 verifier rejects a Z1 attestation dispatched before platform evidence completed', async () => {
	const report = await runZ1ReleaseScenario({
		mutate: ({ attestationRun }) => {
			attestationRun.created_at = '2026-08-16T03:59:59.000Z';
		}
	});
	assert.equal(report.checks.find(check => check.id === 'z1-go')?.passed, false);
});

test('R0 verifier keeps Zeus production imports inside SQL Result', async () => {
	const source = await readFile(new URL('./verify-sql-mvp-vnext-release.mjs', import.meta.url), 'utf8');
	assert.match(source, /contrib\/sqlResult/);
	assert.match(source, /@zeus-web|@zeus-js|zw-data-grid/);
});
