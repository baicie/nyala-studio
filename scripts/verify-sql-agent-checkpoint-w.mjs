#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { hasVisiblePngDiversity, inspectPngPixels } from './sql-result-grid-visual-png.mjs';
import { calibrateWindowRectForCssViewport } from './tauri-embedded-webdriver.mjs';

const requiredAutomatedCheckIds = new Set([
	'workbench-ready',
	'agent-root-visible',
	'agent-root-bounds',
	'aria-agent-prompt',
	'aria-agent-task',
	'aria-agent-access-mode',
	'aria-start-agent-run',
	'aria-cancel-agent-run',
	'aria-agent-evidence',
	'aria-agent-activity',
	'aria-agent-warnings',
	'visible-agent-prompt',
	'viewport-agent-prompt',
	'visible-agent-task',
	'viewport-agent-task',
	'visible-agent-access-mode',
	'viewport-agent-access-mode',
	'visible-start-agent-run',
	'viewport-start-agent-run',
	'visible-cancel-agent-run',
	'viewport-cancel-agent-run',
	'start-enabled',
	'cancel-disabled',
	'ready-status',
	'no-fatal-screen',
	'requested-viewport',
	'screenshot-size',
	'screenshot-pixel-diversity'
]);
const requiredManualCheckIds = new Set(['keyboard-tab-order', 'native-keyboard-evidence']);
const requiredAriaLabels = [
	'Agent prompt',
	'Agent task',
	'Agent access mode',
	'Start Agent run',
	'Cancel Agent run',
	'Agent evidence',
	'Agent activity',
	'Agent warnings'
];
const requiredControlLabels = [
	'Agent prompt',
	'Agent task',
	'Agent access mode',
	'Start Agent run',
	'Cancel Agent run'
];
const screenshotDimensionTolerance = 2;
const maxManualEvidenceRefLength = 2048;

const cli = parseArgs(process.argv.slice(2).filter(argument => argument !== '--'));
const outputPath = resolve(cli.output ?? 'docs/sql-mvp-phases/phase-a4-checkpoint-w.json');
const expected = {
	repository: normalizeOptional(cli['expected-repository']),
	sourceRevision: normalizeOptional(cli['expected-revision']),
	sourceRef: normalizeOptional(cli['expected-ref'])
};

const [macosInput, windowsInput, manualInput, captureRunInput] = await Promise.all([
	loadJson(cli.macos, 'macOS native evidence'),
	loadJson(cli.windows, 'Windows native evidence'),
	loadJson(cli.manual, 'manual attestation'),
	loadJson(cli['capture-run'], 'capture run metadata')
]);
const macos = macosInput.value;
const windows = windowsInput.value;
const manual = manualInput.value;
const captureRun = captureRunInput.value;

const checks = [
	validateCaptureRunMetadata(captureRun, captureRunInput.error),
	validateNativeIdentity('macos', macos, macosInput.error),
	validateNativeIdentity('windows', windows, windowsInput.error),
	await validateAutomatedSurface('macos', macos, macosInput.error, macosInput.filePath),
	await validateAutomatedSurface('windows', windows, windowsInput.error, windowsInput.filePath),
	validateProvenance(expected, macos, windows, manual, captureRun),
	validateManualAttestation(manual, manualInput.error),
	validateNativeKeyboard('macos', manual),
	validateScreenReader('macos', 'VoiceOver', manual),
	validateNativeKeyboard('windows', manual),
	validateScreenReader('windows', 'Narrator', manual)
];
const decision = checks.every(check => check.passed) ? 'GO' : 'NO-GO';
const sourceRevision =
	expected.sourceRevision ?? sharedProvenanceValue('sourceRevision', macos, windows, manual, captureRun);
const report = {
	version: 2,
	generatedAt: new Date().toISOString(),
	decision,
	...(sourceRevision ? { sourceRevision } : {}),
	checks,
	blockers: checks.filter(check => !check.passed).map(check => check.reason),
	inputs: {
		macos: cli.macos ?? null,
		windows: cli.windows ?? null,
		manual: cli.manual ?? null,
		captureRun: cli['capture-run'] ?? null,
		expected
	},
	inputDigests: {
		macos: macosInput.sha256 ?? null,
		windows: windowsInput.sha256 ?? null,
		manual: manualInput.sha256 ?? null,
		captureRun: captureRunInput.sha256 ?? null
	},
	evidence: {
		captureRun: summarizeCaptureRunEvidence(captureRun),
		macos: summarizeNativeEvidence(macos),
		windows: summarizeNativeEvidence(windows),
		manual: summarizeManualEvidence(manual)
	}
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, '\t')}\n`, 'utf8');
console.log(`${decision}: ${outputPath}`);
for (const blocker of report.blockers) console.log(`- ${blocker}`);
process.exitCode = decision === 'GO' ? 0 : 1;

function validateCaptureRunMetadata(metadata, loadError) {
	const id = 'capture-run-metadata';
	if (loadError) return failed(id, loadError);
	const reasons = [];
	if (metadata?.version !== 1) reasons.push(`expected metadata version 1, got ${formatValue(metadata?.version)}`);
	if (metadata?.status !== 'verified') reasons.push(`status is ${formatValue(metadata?.status)}`);
	if (!Array.isArray(metadata?.reasons) || metadata.reasons.length !== 0) {
		reasons.push('producer reasons are not empty');
	}
	if (!isWorkflowRunId(metadata?.workflow?.id)) reasons.push('workflow id is invalid');
	if (metadata?.workflow?.name !== 'SQL Agent Native Workbench Capture') reasons.push('workflow name is invalid');
	if (metadata?.workflow?.path !== '.github/workflows/sql-agent-native.yml') reasons.push('workflow path is invalid');
	if (metadata?.workflow?.event !== 'workflow_dispatch') reasons.push('workflow event is invalid');
	if (metadata?.run?.status !== 'completed' || metadata?.run?.conclusion !== 'success') {
		reasons.push('capture run did not complete successfully');
	}
	if (metadata?.run?.id !== metadata?.provenance?.workflowRunId) reasons.push('run id does not match provenance');
	if (metadata?.run?.attempt !== metadata?.provenance?.workflowRunAttempt) {
		reasons.push('run attempt does not match provenance');
	}
	if (metadata?.run?.headSha !== metadata?.provenance?.sourceRevision) {
		reasons.push('run head SHA does not match provenance');
	}
	if (
		metadata?.run?.htmlUrl !==
		`https://github.com/${metadata?.provenance?.repository}/actions/runs/${metadata?.provenance?.workflowRunId}`
	) {
		reasons.push('run URL does not match provenance');
	}
	if (!isIsoDate(metadata?.run?.runStartedAt) || !isIsoDate(metadata?.run?.updatedAt)) {
		reasons.push('run timestamps are invalid');
	}
	const provenanceReasons = [];
	validateCaptureProvenanceShape(metadata?.provenance, provenanceReasons);
	reasons.push(...provenanceReasons);
	const artifacts = Array.isArray(metadata?.artifacts) ? metadata.artifacts : [];
	if (artifacts.length !== 2) reasons.push(`expected 2 capture artifacts, got ${artifacts.length}`);
	const expectedNames = ['sql-agent-native-macos', 'sql-agent-native-windows'];
	for (const expectedName of expectedNames) {
		const matches = artifacts.filter(artifact => artifact?.name === expectedName);
		if (matches.length !== 1) reasons.push(`expected exactly one ${expectedName} artifact, got ${matches.length}`);
	}
	const artifactIds = [];
	for (const artifact of artifacts) {
		if (!isWorkflowRunId(artifact?.id)) reasons.push(`${formatValue(artifact?.name)} artifact id is invalid`);
		else artifactIds.push(artifact.id);
		if (!Number.isInteger(artifact?.bytes) || artifact.bytes <= 0) {
			reasons.push(`${formatValue(artifact?.name)} artifact byte count is invalid`);
		}
		if (!isSha256(artifact?.digest)) reasons.push(`${formatValue(artifact?.name)} artifact digest is invalid`);
		if (!isIsoDate(artifact?.createdAt) || !isIsoDate(artifact?.updatedAt)) {
			reasons.push(`${formatValue(artifact?.name)} artifact timestamps are invalid`);
		}
	}
	if (new Set(artifactIds).size !== artifacts.length) reasons.push('capture artifact ids are not unique');
	if (
		!arraysEqual(
			metadata?.artifactIds,
			artifacts.map(artifact => artifact?.id)
		)
	) {
		reasons.push('capture artifact id list does not match artifact metadata');
	}
	return reasons.length === 0
		? passed(id, 'GitHub run and exact native capture artifact metadata are verified')
		: failed(id, reasons.join('; '));
}

function validateNativeIdentity(platform, evidence, loadError) {
	const id = `${platform}-native-identity`;
	const label = platformLabel(platform);
	if (loadError) return failed(id, `${label}: ${loadError}`);
	const expectedIdentity =
		platform === 'macos'
			? { engine: 'wkwebview-embedded', browser: 'webkit', nativeWebView2: false }
			: { engine: 'webview2-embedded', browser: 'msedge', nativeWebView2: true };
	const reasons = [];
	if (evidence?.version !== 2) reasons.push(`expected evidence version 2, got ${formatValue(evidence?.version)}`);
	if (evidence?.platformName !== platform) {
		reasons.push(`expected platformName ${platform}, got ${formatValue(evidence?.platformName)}`);
	}
	if (evidence?.driverProvider !== 'embedded') reasons.push('driverProvider is not embedded');
	if (evidence?.nativeWebView !== true) reasons.push('nativeWebView is not true');
	if (evidence?.nativeWebView2 !== expectedIdentity.nativeWebView2) {
		reasons.push(`nativeWebView2 is not ${expectedIdentity.nativeWebView2}`);
	}
	if (evidence?.engine !== expectedIdentity.engine) reasons.push(`engine is not ${expectedIdentity.engine}`);
	if (evidence?.browser !== expectedIdentity.browser) reasons.push(`browser is not ${expectedIdentity.browser}`);
	if (evidence?.webdriverOwnership?.runNonceVerified !== true) reasons.push('WebDriver ownership nonce is unverified');
	if (evidence?.webdriverOwnership?.portSource !== 'os-assigned') reasons.push('WebDriver port is not OS-assigned');
	if (evidence?.frontendSource?.kind !== 'local-dist-server') {
		reasons.push('frontend source is not the declared local-dist-server characterization boundary');
	}
	validateNativeProvenanceShape(evidence?.provenance, reasons);
	return reasons.length === 0
		? passed(id, `${label}: embedded native WebView identity and provenance are valid`)
		: failed(id, `${label}: ${reasons.join('; ')}`);
}

async function validateAutomatedSurface(platform, evidence, loadError, evidenceFilePath) {
	const id = `${platform}-automated-surface`;
	const label = platformLabel(platform);
	if (loadError) return failed(id, `${label}: ${loadError}`);
	const reasons = [];
	if (evidence?.status !== 'ready') reasons.push(`status is ${formatValue(evidence?.status)}`);
	if (evidence?.automatedSurfaceStatus !== 'ready') {
		reasons.push(`automatedSurfaceStatus is ${formatValue(evidence?.automatedSurfaceStatus)}`);
	}
	if (evidence?.checkpointDecision !== 'BLOCKED') {
		reasons.push('per-platform capture must not claim Checkpoint W completion');
	}
	if (evidence?.manualGates?.nativeKeyboard !== 'pending' || evidence?.manualGates?.screenReader !== 'pending') {
		reasons.push('capture must leave native keyboard and screen-reader gates pending');
	}
	const artifacts = Array.isArray(evidence?.artifacts) ? evidence.artifacts : [];
	if (artifacts.length !== 2) reasons.push(`expected 2 viewport artifacts, got ${artifacts.length}`);
	for (const expectedViewport of [
		{ id: 'desktop', width: 1440, height: 900 },
		{ id: 'narrow', width: 390, height: 844 }
	]) {
		const matches = artifacts.filter(artifact => artifact?.requestedViewport?.id === expectedViewport.id);
		if (matches.length !== 1) {
			reasons.push(`expected exactly one ${expectedViewport.id} artifact, got ${matches.length}`);
			continue;
		}
		await validateViewportArtifact(matches[0], expectedViewport, reasons, evidenceFilePath);
	}
	return reasons.length === 0
		? passed(id, `${label}: desktop/narrow automated surface evidence is complete`)
		: failed(id, `${label}: ${reasons.join('; ')}`);
}

async function validateViewportArtifact(artifact, expectedViewport, reasons, evidenceFilePath) {
	const prefix = expectedViewport.id;
	if (artifact?.status !== 'ready' || artifact?.automatedSurfaceStatus !== 'ready') {
		reasons.push(`${prefix} automated surface is not ready`);
	}
	for (const field of ['requestedViewport', 'viewport']) {
		const viewport = artifact?.[field];
		if (
			viewport?.id !== expectedViewport.id ||
			viewport?.width !== expectedViewport.width ||
			viewport?.height !== expectedViewport.height
		) {
			reasons.push(`${prefix} ${field} does not match ${expectedViewport.width}x${expectedViewport.height}`);
		}
	}
	if (!isSafeScreenshotName(artifact?.screenshot)) reasons.push(`${prefix} screenshot name is invalid`);
	if (!Number.isInteger(artifact?.screenshotBytes) || artifact.screenshotBytes <= 0) {
		reasons.push(`${prefix} screenshot byte count is invalid`);
	}
	if (!isSha256(artifact?.screenshotSha256)) reasons.push(`${prefix} screenshot SHA-256 is invalid`);
	validateViewportCalibration(artifact, expectedViewport, reasons);
	await validateScreenshotFile(artifact, prefix, evidenceFilePath, reasons);
	validateSnapshot(artifact?.snapshot, expectedViewport, reasons);

	const checks = Array.isArray(artifact?.checks) ? artifact.checks : [];
	const checksById = new Map();
	for (const check of checks) {
		if (typeof check?.id !== 'string' || checksById.has(check.id)) {
			reasons.push(`${prefix} contains an invalid or duplicate check id`);
			continue;
		}
		checksById.set(check.id, check);
	}
	for (const requiredId of requiredAutomatedCheckIds) {
		if (!checksById.has(requiredId)) reasons.push(`${prefix} is missing ${requiredId}`);
	}
	for (const requiredId of requiredManualCheckIds) {
		if (!checksById.has(requiredId)) reasons.push(`${prefix} is missing ${requiredId}`);
	}
	if (expectedViewport.id === 'narrow' && !checksById.has('narrow-focused-layout')) {
		reasons.push('narrow is missing narrow-focused-layout');
	}
	for (const check of checksById.values()) {
		if (requiredManualCheckIds.has(check.id)) {
			if (check.scope !== 'manual') reasons.push(`${prefix} ${check.id} is not scoped manual`);
			continue;
		}
		if (check.scope === 'manual') {
			reasons.push(`${prefix} has unexpected manual check ${check.id}`);
		} else if (check.scope !== 'automated' || check.passed !== true) {
			reasons.push(`${prefix} automated check ${check.id} failed`);
		}
	}
}

function validateViewportCalibration(artifact, expectedViewport, reasons) {
	const prefix = expectedViewport.id;
	const tolerance = artifact?.viewportTolerance;
	const attempts = Array.isArray(artifact?.calibrationAttempts) ? artifact.calibrationAttempts : [];
	if (
		artifact?.viewportConverged !== true ||
		artifact?.convergenceStoppedReason !== 'target-reached' ||
		tolerance !== 1
	) {
		reasons.push(`${prefix} viewport calibration did not converge to the requested viewport`);
	}
	if (!sameDimensions(artifact?.requestedCssViewport, expectedViewport)) {
		reasons.push(`${prefix} calibration requested CSS viewport is invalid`);
	}
	if (attempts.length < 1 || attempts.length > 4) {
		reasons.push(`${prefix} calibration attempt count is invalid`);
		return;
	}
	if (!sameDimensions(attempts[0]?.requestedWindowRect, artifact?.initialWindowRect)) {
		reasons.push(`${prefix} calibration first attempt does not match the initial window rect`);
	}
	for (const [index, attempt] of attempts.entries()) {
		if (
			attempt?.attempt !== index + 1 ||
			!hasPositiveDimensions(attempt?.requestedWindowRect) ||
			!hasPositiveDimensions(attempt?.appliedWindowRect) ||
			!hasPositiveDimensions(attempt?.observedCssViewport)
		) {
			reasons.push(`${prefix} calibration attempt ${index + 1} is invalid`);
			continue;
		}
		if (index > 0) {
			const previous = attempts[index - 1];
			try {
				const expectedRequest = calibrateWindowRectForCssViewport(
					artifact.requestedCssViewport,
					previous.observedCssViewport,
					previous.appliedWindowRect
				);
				if (!sameDimensions(attempt.requestedWindowRect, expectedRequest)) {
					reasons.push(`${prefix} calibration attempt ${index + 1} request was not derived from attempt ${index}`);
				}
			} catch {
				reasons.push(`${prefix} calibration attempt ${index + 1} could not be recomputed`);
			}
		}
		if (index < attempts.length - 1 && dimensionsWithin(attempt.observedCssViewport, expectedViewport, tolerance)) {
			reasons.push(`${prefix} calibration continued after reaching the requested viewport`);
		}
	}
	const lastAttempt = attempts.at(-1);
	if (
		!sameDimensions(lastAttempt?.requestedWindowRect, artifact?.lastAppliedRequestedWindowRect) ||
		!sameDimensions(lastAttempt?.appliedWindowRect, artifact?.appliedWindowRect) ||
		!sameDimensions(lastAttempt?.observedCssViewport, artifact?.observedCssViewport)
	) {
		reasons.push(`${prefix} calibration final attempt does not match the reported final observation`);
	}
	if (!dimensionsWithin(artifact?.observedCssViewport, expectedViewport, tolerance)) {
		reasons.push(`${prefix} calibrated CSS viewport does not match the requested viewport`);
	}
	if (!sameDimensions(artifact?.observedCssViewport, artifact?.viewport)) {
		reasons.push(`${prefix} artifact viewport does not match the calibrated CSS viewport`);
	}
	const devicePixelRatio = artifact?.devicePixelRatio;
	if (
		!Number.isFinite(devicePixelRatio) ||
		devicePixelRatio <= 0 ||
		devicePixelRatio > 8 ||
		artifact?.viewport?.devicePixelRatio !== devicePixelRatio
	) {
		reasons.push(`${prefix} calibrated device pixel ratio is invalid`);
	}
	if (
		artifact?.snapshot?.viewportWidth !== artifact?.viewport?.width ||
		artifact?.snapshot?.viewportHeight !== artifact?.viewport?.height ||
		artifact?.snapshot?.devicePixelRatio !== artifact?.viewport?.devicePixelRatio
	) {
		reasons.push(`${prefix} snapshot viewport or DPR does not match the calibrated artifact viewport`);
	}
}

async function validateScreenshotFile(artifact, prefix, evidenceFilePath, reasons) {
	if (!evidenceFilePath || !isSafeScreenshotName(artifact?.screenshot)) return;
	const screenshotPath = join(dirname(evidenceFilePath), 'screenshots', artifact.screenshot);
	try {
		const bytes = await readFile(screenshotPath);
		if (bytes.byteLength !== artifact.screenshotBytes) {
			reasons.push(`${prefix} screenshot file size does not match manifest`);
		}
		const sha256 = createHash('sha256').update(bytes).digest('hex');
		if (sha256 !== artifact.screenshotSha256) {
			reasons.push(`${prefix} screenshot file SHA-256 does not match manifest`);
		}
		try {
			const png = inspectPngPixels(bytes);
			const expectedWidth = Number(artifact?.viewport?.width) * Number(artifact?.viewport?.devicePixelRatio);
			const expectedHeight = Number(artifact?.viewport?.height) * Number(artifact?.viewport?.devicePixelRatio);
			if (
				!Number.isFinite(expectedWidth) ||
				expectedWidth <= 0 ||
				!Number.isFinite(expectedHeight) ||
				expectedHeight <= 0 ||
				Math.abs(png.width - expectedWidth) > screenshotDimensionTolerance ||
				Math.abs(png.height - expectedHeight) > screenshotDimensionTolerance
			) {
				reasons.push(
					`${prefix} screenshot PNG dimensions ${png.width}x${png.height} do not match viewport ${formatValue(artifact?.viewport?.width)}x${formatValue(artifact?.viewport?.height)} at DPR ${formatValue(artifact?.viewport?.devicePixelRatio)}`
				);
			}
			if (!hasVisiblePngDiversity(png)) {
				reasons.push(
					`${prefix} screenshot PNG has insufficient pixel diversity (${png.distinctColorBuckets} color buckets, luma range ${png.lumaRange})`
				);
			}
		} catch (error) {
			reasons.push(
				`${prefix} screenshot is not a valid PNG: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	} catch (error) {
		reasons.push(
			`${prefix} screenshot file could not be loaded: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

function validateSnapshot(snapshot, expectedViewport, reasons) {
	const prefix = expectedViewport.id;
	if (!snapshot || typeof snapshot !== 'object') {
		reasons.push(`${prefix} Workbench snapshot is missing`);
		return;
	}
	if (snapshot.workbenchReady !== true) reasons.push(`${prefix} Workbench snapshot is not ready`);
	if (snapshot.agentRoot?.visible !== true || !isPositiveRect(snapshot.agentRoot?.rect)) {
		reasons.push(`${prefix} Agent root snapshot is not visible and bounded`);
	}
	if (prefix === 'narrow' && snapshot.primarySidebarVisible !== false) {
		reasons.push('narrow snapshot did not close the primary sidebar');
	}
	const ariaLabels = Array.isArray(snapshot.ariaLabels) ? snapshot.ariaLabels : [];
	for (const label of requiredAriaLabels) {
		if (!ariaLabels.includes(label)) reasons.push(`${prefix} snapshot is missing aria-label ${label}`);
	}
	const controls = Array.isArray(snapshot.controls) ? snapshot.controls : [];
	for (const label of requiredControlLabels) {
		const matches = controls.filter(control => control?.ariaLabel === label);
		if (matches.length !== 1) {
			reasons.push(`${prefix} snapshot expected one ${label} control, got ${matches.length}`);
			continue;
		}
		const control = matches[0];
		if (control.visible !== true || !isPositiveRect(control.rect)) {
			reasons.push(`${prefix} snapshot ${label} is not visible and bounded`);
		} else if (!rectWithinViewport(control.rect, expectedViewport)) {
			reasons.push(`${prefix} snapshot ${label} is outside the viewport`);
		}
	}
	const start = controls.find(control => control?.ariaLabel === 'Start Agent run');
	if (start?.disabled !== false) {
		reasons.push(`${prefix} snapshot Start Agent run is not explicitly enabled`);
	}
	const cancel = controls.find(control => control?.ariaLabel === 'Cancel Agent run');
	if (cancel?.disabled !== true) {
		reasons.push(`${prefix} snapshot Cancel Agent run is not explicitly disabled`);
	}
	if (snapshot.status !== 'Ready.') reasons.push(`${prefix} snapshot status is not Ready`);
	if (snapshot.fatalScreen !== false) reasons.push(`${prefix} snapshot contains a fatal screen`);
}

function validateProvenance(expectedValues, macosEvidence, windowsEvidence, manualEvidence, captureRunEvidence) {
	const id = 'provenance-match';
	const sources = [
		['macOS', macosEvidence?.provenance],
		['Windows', windowsEvidence?.provenance],
		['manual', manualEvidence?.provenance],
		['capture run', captureRunEvidence?.provenance]
	];
	const reasons = [];
	for (const field of ['repository', 'sourceRevision', 'sourceRef', 'workflowRunId', 'workflowRunAttempt']) {
		const expectedValue =
			expectedValues[field] ?? sharedProvenanceValue(field, macosEvidence, windowsEvidence, captureRunEvidence);
		if (!expectedValue) {
			reasons.push(`expected ${field} is unavailable`);
			continue;
		}
		for (const [label, provenance] of sources) {
			if (provenance?.[field] !== expectedValue) {
				reasons.push(`${label} ${field} does not match ${expectedValue}`);
			}
		}
	}
	return reasons.length === 0
		? passed(id, 'capture run, macOS, Windows, and manual evidence target the same repository revision and ref')
		: failed(id, reasons.join('; '));
}

function validateManualAttestation(attestation, loadError) {
	const id = 'manual-attestation';
	if (loadError) return failed(id, loadError);
	const reasons = [];
	if (attestation?.version !== 2)
		reasons.push(`expected attestation version 2, got ${formatValue(attestation?.version)}`);
	if (attestation?.status !== 'attested') reasons.push(`status is ${formatValue(attestation?.status)}`);
	if (Object.hasOwn(attestation ?? {}, 'evidenceRefs')) {
		reasons.push('legacy shared evidenceRefs are not allowed');
	}
	const provenance = attestation?.provenance;
	if (!isRepository(provenance?.repository)) reasons.push('repository is invalid');
	if (!isGitRevision(provenance?.sourceRevision)) reasons.push('sourceRevision is invalid');
	if (!isSourceRef(provenance?.sourceRef)) reasons.push('sourceRef is invalid');
	if (!isWorkflowRunId(provenance?.workflowRunId)) reasons.push('workflowRunId is invalid');
	if (!Number.isInteger(provenance?.workflowRunAttempt) || provenance.workflowRunAttempt < 1) {
		reasons.push('workflowRunAttempt is invalid');
	}
	if (typeof provenance?.reviewer !== 'string' || provenance.reviewer.trim().length < 2)
		reasons.push('reviewer is missing');
	if (!isIsoDate(provenance?.reviewedAt)) reasons.push('reviewedAt is invalid');
	if (!isWorkflowRunUrl(provenance?.workflowRunUrl)) reasons.push('workflowRunUrl is invalid');
	if (
		provenance?.workflowRunUrl !==
		`https://github.com/${provenance?.repository}/actions/runs/${provenance?.workflowRunId}`
	) {
		reasons.push('workflowRunUrl does not match repository and workflowRunId');
	}
	if (!isWorkflowRunId(provenance?.attestationWorkflowRunId)) {
		reasons.push('attestationWorkflowRunId is invalid');
	}
	if (!Number.isInteger(provenance?.attestationWorkflowRunAttempt) || provenance.attestationWorkflowRunAttempt < 1) {
		reasons.push('attestationWorkflowRunAttempt is invalid');
	}
	if (
		provenance?.attestationWorkflowRunUrl !==
		`https://github.com/${provenance?.repository}/actions/runs/${provenance?.attestationWorkflowRunId}`
	) {
		reasons.push('attestationWorkflowRunUrl is invalid');
	}
	if (
		isWorkflowRunId(provenance?.attestationWorkflowRunId) &&
		isWorkflowRunId(provenance?.workflowRunId) &&
		BigInt(provenance.attestationWorkflowRunId) <= BigInt(provenance.workflowRunId)
	) {
		reasons.push('attestation workflow must run after the native capture workflow');
	}
	const normalizedEvidenceRefs = [];
	for (const [label, evidenceRef] of manualGateEvidence(attestation)) {
		const normalized = normalizeManualEvidenceRef(evidenceRef);
		if (!normalized) reasons.push(`${label} evidence reference is invalid`);
		else normalizedEvidenceRefs.push(normalized);
	}
	if (normalizedEvidenceRefs.length === 4 && new Set(normalizedEvidenceRefs).size !== 4) {
		reasons.push('manual evidence references must be unique across all four gates');
	}
	return reasons.length === 0
		? passed(id, 'manual attestation has separate capture/review provenance and four gate-local evidence references')
		: failed(id, reasons.join('; '));
}

function validateNativeKeyboard(platform, attestation) {
	const id = `${platform}-native-keyboard`;
	const value = attestation?.platforms?.[platform]?.nativeKeyboard;
	const expectedOrder = ['Agent prompt', 'Agent task', 'Agent access mode', 'Start Agent run'];
	const valid =
		value?.status === 'passed' &&
		arraysEqual(value?.focusOrder, expectedOrder) &&
		value?.startCancelReachable === true &&
		value?.noFocusTrap === true &&
		isSafeManualEvidenceRef(value?.evidenceRef);
	return valid
		? passed(id, `${platformLabel(platform)}: real keyboard focus order and controls were attested`)
		: failed(
				id,
				`${platformLabel(platform)}: real keyboard focus order, Start/Cancel reachability, and no-focus-trap attestation are required`
			);
}

function validateScreenReader(platform, assistiveTechnology, attestation) {
	const id = `${platform}-${assistiveTechnology.toLowerCase()}`;
	const value = attestation?.platforms?.[platform]?.screenReader;
	const valid =
		value?.status === 'passed' &&
		value?.assistiveTechnology === assistiveTechnology &&
		value?.labelsAnnounced === true &&
		value?.stateChangesAnnounced === true &&
		value?.noFocusTrap === true &&
		isSafeManualEvidenceRef(value?.evidenceRef);
	return valid
		? passed(id, `${platformLabel(platform)}: ${assistiveTechnology} labels, state changes, and focus were attested`)
		: failed(
				id,
				`${platformLabel(platform)}: real ${assistiveTechnology} labels, state changes, and no-focus-trap attestation are required`
			);
}

function validateNativeProvenanceShape(provenance, reasons) {
	validateCaptureProvenanceShape(provenance, reasons);
	if (!isSha256(provenance?.binarySha256)) reasons.push('binary SHA-256 provenance is invalid');
}

function validateCaptureProvenanceShape(provenance, reasons) {
	if (!isRepository(provenance?.repository)) reasons.push('repository provenance is invalid');
	if (!isGitRevision(provenance?.sourceRevision)) reasons.push('source revision provenance is invalid');
	if (!isSourceRef(provenance?.sourceRef)) reasons.push('source ref provenance is invalid');
	if (!isWorkflowRunId(provenance?.workflowRunId)) reasons.push('workflow run id provenance is invalid');
	if (!Number.isInteger(provenance?.workflowRunAttempt) || provenance.workflowRunAttempt < 1) {
		reasons.push('workflow run attempt provenance is invalid');
	}
}

function summarizeCaptureRunEvidence(evidence) {
	if (!evidence || typeof evidence !== 'object') return null;
	return {
		version: evidence.version ?? null,
		status: evidence.status ?? null,
		workflow: evidence.workflow ?? null,
		run: evidence.run ?? null,
		provenance: evidence.provenance ?? null,
		artifacts: Array.isArray(evidence.artifacts) ? evidence.artifacts : []
	};
}

function summarizeNativeEvidence(evidence) {
	if (!evidence || typeof evidence !== 'object') return null;
	return {
		version: evidence.version ?? null,
		status: evidence.status ?? null,
		automatedSurfaceStatus: evidence.automatedSurfaceStatus ?? null,
		platformName: evidence.platformName ?? null,
		engine: evidence.engine ?? null,
		provenance: evidence.provenance ?? null,
		screenshots: Array.isArray(evidence.artifacts)
			? evidence.artifacts.map(artifact => ({
					viewport: artifact?.requestedViewport?.id ?? null,
					file: artifact?.screenshot ?? null,
					sha256: artifact?.screenshotSha256 ?? null
				}))
			: []
	};
}

function summarizeManualEvidence(attestation) {
	if (!attestation || typeof attestation !== 'object') return null;
	return {
		version: attestation.version ?? null,
		status: attestation.status ?? null,
		provenance: attestation.provenance ?? null,
		gateEvidence: {
			macosKeyboard: attestation.platforms?.macos?.nativeKeyboard?.evidenceRef ?? null,
			voiceOver: attestation.platforms?.macos?.screenReader?.evidenceRef ?? null,
			windowsKeyboard: attestation.platforms?.windows?.nativeKeyboard?.evidenceRef ?? null,
			narrator: attestation.platforms?.windows?.screenReader?.evidenceRef ?? null
		}
	};
}

function manualGateEvidence(attestation) {
	return [
		['macOS keyboard', attestation?.platforms?.macos?.nativeKeyboard?.evidenceRef],
		['VoiceOver', attestation?.platforms?.macos?.screenReader?.evidenceRef],
		['Windows keyboard', attestation?.platforms?.windows?.nativeKeyboard?.evidenceRef],
		['Narrator', attestation?.platforms?.windows?.screenReader?.evidenceRef]
	];
}

async function loadJson(filePath, label) {
	if (!filePath) return { value: undefined, error: `${label} path was not provided` };
	const resolvedPath = resolve(filePath);
	try {
		const bytes = await readFile(resolvedPath);
		const value = JSON.parse(bytes.toString('utf8'));
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return { value: undefined, error: `${label} is not a JSON object` };
		}
		return {
			value,
			error: undefined,
			filePath: resolvedPath,
			sha256: createHash('sha256').update(bytes).digest('hex')
		};
	} catch (error) {
		return {
			value: undefined,
			error: `${label} could not be loaded: ${error instanceof Error ? error.message : String(error)}`
		};
	}
}

function parseArgs(args) {
	const result = {};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
		const [key, inlineValue] = argument.slice(2).split('=', 2);
		if (inlineValue !== undefined) {
			result[key] = inlineValue;
			continue;
		}
		const value = args[index + 1];
		if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
		result[key] = value;
		index += 1;
	}
	return result;
}

function sharedProvenanceValue(field, ...evidence) {
	const values = evidence
		.map(item => item?.provenance?.[field])
		.filter(value => value !== undefined && value !== null && value !== '');
	return values.length > 0 && values.every(value => value === values[0]) ? values[0] : undefined;
}

function arraysEqual(left, right) {
	return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeOptional(value) {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRepository(value) {
	return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function isGitRevision(value) {
	return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}

function isSourceRef(value) {
	return typeof value === 'string' && /^refs\/(heads|tags|pull)\//.test(value);
}

function isWorkflowRunId(value) {
	return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

function isSha256(value) {
	return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isSafeScreenshotName(value) {
	return typeof value === 'string' && /^[A-Za-z0-9_.-]+\.png$/.test(value);
}

function isPositiveRect(rect) {
	return (
		rect &&
		Number.isFinite(rect.left) &&
		Number.isFinite(rect.top) &&
		Number.isFinite(rect.right) &&
		Number.isFinite(rect.bottom) &&
		Number.isFinite(rect.width) &&
		Number.isFinite(rect.height) &&
		rect.width > 0 &&
		rect.height > 0
	);
}

function hasPositiveDimensions(value) {
	return Number.isFinite(value?.width) && value.width > 0 && Number.isFinite(value?.height) && value.height > 0;
}

function sameDimensions(actual, expected) {
	return (
		hasPositiveDimensions(actual) &&
		hasPositiveDimensions(expected) &&
		actual.width === expected.width &&
		actual.height === expected.height
	);
}

function dimensionsWithin(actual, expected, tolerance) {
	return (
		hasPositiveDimensions(actual) &&
		hasPositiveDimensions(expected) &&
		Number.isFinite(tolerance) &&
		tolerance >= 0 &&
		Math.abs(actual.width - expected.width) <= tolerance &&
		Math.abs(actual.height - expected.height) <= tolerance
	);
}

function rectWithinViewport(rect, viewport) {
	return rect.left >= 0 && rect.top >= 0 && rect.right <= viewport.width && rect.bottom <= viewport.height;
}

function isIsoDate(value) {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isWorkflowRunUrl(value) {
	return typeof value === 'string' && /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/[1-9][0-9]*$/.test(value);
}

function isSafeManualEvidenceRef(value) {
	return normalizeManualEvidenceRef(value) !== undefined;
}

function normalizeManualEvidenceRef(value) {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > maxManualEvidenceRefLength ||
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

function formatValue(value) {
	return value === undefined ? 'missing' : JSON.stringify(value);
}

function platformLabel(platform) {
	return platform === 'macos' ? 'macOS WKWebView' : 'Windows WebView2';
}

function passed(id, reason) {
	return { id, passed: true, reason };
}

function failed(id, reason) {
	return { id, passed: false, reason };
}
