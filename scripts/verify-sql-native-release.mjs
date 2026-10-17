#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportPath = resolve(process.argv[2] ?? 'docs/sql-mvp-phases/phase-native-release-gate.json');
const a4GatePath = resolve(
	process.env.NYALA_A4_CHECKPOINT_W_GATE ?? resolve(repositoryRoot, 'docs/sql-mvp-phases/phase-a4-checkpoint-w.json')
);
const expectedSourceRevision =
	process.env.NYALA_EXPECTED_SOURCE_REVISION ??
	execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();

const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'));
const roadmap = await readFile(resolve(repositoryRoot, 'docs/sql-mvp-phases/mvp-vnext-agent-zeus-roadmap.md'), 'utf8');
const a4GateResult = await loadJsonEvidence(a4GatePath, 'A4 Checkpoint W gate');
const a4Gate = a4GateResult.value ?? {};
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

const checks = [
	check(
		'a4-checkpoint-w',
		isCheckpointWGo(a4Gate, expectedSourceRevision),
		'A4 Checkpoint W is GO for the release revision',
		`A4 Checkpoint W must be a revision-bound GO: ${a4GateResult.error ?? a4FailureReason(a4Gate, expectedSourceRevision)}`
	),
	check(
		'release-source-revision',
		/^[a-f0-9]{40}$/.test(expectedSourceRevision),
		`native-only release targets revision ${expectedSourceRevision}`,
		`native-only release revision is invalid: ${expectedSourceRevision}`
	),
	check(
		'agent-default-smoke',
		hasScript('test:sql-agent'),
		'package test includes SQL Agent coverage',
		'package test does not include SQL Agent coverage'
	),
	check(
		'result-default-smoke',
		hasScript('test:sql-result'),
		'package test includes SQL Result coverage',
		'package test does not include SQL Result coverage'
	),
	check(
		'checkpoint-w-regression',
		hasScript('test:sql-agent-checkpoint-w'),
		'package test includes Checkpoint W contract coverage',
		'package test does not include Checkpoint W contract coverage'
	),
	check(
		'native-result-default',
		await sourceContains(
			'src/vs/workbench/contrib/sqlProduct/common/sqlProductPreferences.ts',
			/DEFAULT_SQL_PRODUCT_PREFERENCES[\s\S]{0,400}resultRenderer:\s*SQL_RESULT_NATIVE_RENDERER_ID/
		),
		'native renderer remains the default result renderer',
		'native renderer is not recorded as the default result renderer'
	),
	check(
		'native-renderer-contract',
		(await sourceContains(
			'src/vs/workbench/contrib/sqlResult/browser/sqlResultNativeRenderer.ts',
			/class SqlResultNativeRendererAdapter implements ISqlResultSuccessGridRenderer/
		)) &&
			(await sourceContains(
				'src/vs/workbench/contrib/sqlResult/browser/sqlResultNativeRenderer.ts',
				/readonly disposable: IDisposable/
			)),
		'native SQL Result renderer owns a disposable success-grid adapter',
		'native SQL Result renderer contract is missing'
	),
	check(
		'zeus-production-dependency-absent',
		!packageJson.dependencies?.['@zeus-web/data-grid'] && !packageJson.optionalDependencies?.['@zeus-web/data-grid'],
		'Zeus is not a production dependency on the native-only release path',
		'Zeus is still listed as a production dependency'
	),
	check(
		'zeus-import-boundary',
		await hasOnlySqlResultZeusImports(),
		'Zeus imports are absent or confined to the SQL Result contribution',
		'Zeus imports escaped the SQL Result contribution'
	),
	check(
		'roadmap-native-only-decision',
		/Native-only release track/.test(roadmap) && /Z1\/Z2 remain deferred/.test(roadmap),
		'roadmap records native-only release and defers Zeus Z1/Z2',
		'roadmap does not record the native-only release decision'
	)
];

const report = {
	version: 1,
	generatedAt: new Date().toISOString(),
	sourceRevision: expectedSourceRevision,
	decision: checks.every(item => item.passed) ? 'GO' : 'NO-GO',
	checks,
	blockers: checks.filter(item => !item.passed).map(item => item.reason),
	inputs: {
		a4Gate: displayPath(a4GatePath),
		a4Decision: a4Gate.decision ?? null,
		a4SourceRevision: a4Gate.sourceRevision ?? null,
		zeusPolicy: 'deferred'
	}
};

await writeFile(reportPath, `${JSON.stringify(report, null, '\t')}\n`, 'utf8');
console.log(`${report.decision}: ${reportPath}`);
for (const blocker of report.blockers) console.log(`- ${blocker}`);
process.exitCode = report.decision === 'GO' ? 0 : 1;

function check(id, passed, passReason, failReason = passReason) {
	return { id, passed: Boolean(passed), reason: passed ? passReason : failReason };
}

function hasScript(name) {
	return typeof packageJson.scripts?.test === 'string' && packageJson.scripts.test.includes(`pnpm run ${name}`);
}

function isCheckpointWGo(gate, revision) {
	const checkIds = Array.isArray(gate?.checks) ? gate.checks.map(item => item?.id) : [];
	return (
		gate?.version === 2 &&
		gate?.decision === 'GO' &&
		gate?.sourceRevision === revision &&
		Array.isArray(gate?.blockers) &&
		gate.blockers.length === 0 &&
		checkIds.length === requiredCheckpointWCheckIds.size &&
		new Set(checkIds).size === requiredCheckpointWCheckIds.size &&
		checkIds.every(id => requiredCheckpointWCheckIds.has(id)) &&
		gate.checks.every(item => item?.passed === true)
	);
}

function a4FailureReason(gate, revision) {
	const reasons = [];
	if (gate?.version !== 2) reasons.push(`schema version is ${gate?.version ?? 'missing'}`);
	if (gate?.decision !== 'GO') reasons.push(`decision is ${gate?.decision ?? 'missing'}`);
	if (gate?.sourceRevision !== revision) reasons.push('source revision does not match the release');
	if (!Array.isArray(gate?.blockers) || gate.blockers.length !== 0) reasons.push('blockers are not empty');
	const checkIds = Array.isArray(gate?.checks) ? gate.checks.map(item => item?.id) : [];
	if (
		checkIds.length !== requiredCheckpointWCheckIds.size ||
		new Set(checkIds).size !== requiredCheckpointWCheckIds.size ||
		checkIds.some(id => !requiredCheckpointWCheckIds.has(id))
	) {
		reasons.push('required Checkpoint W checks are missing or duplicated');
	}
	if (!Array.isArray(gate?.checks) || gate.checks.some(item => item?.passed !== true))
		reasons.push('checks are not all passed');
	return reasons.join('; ') || 'A4 gate is invalid';
}

async function loadJsonEvidence(filePath, label) {
	if (!filePath) return { error: `${label} path is not configured` };
	try {
		const resolvedPath = resolve(filePath);
		const value = JSON.parse(await readFile(resolvedPath, 'utf8'));
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return { error: `${label} is not a JSON object` };
		}
		return { filePath: resolvedPath, value };
	} catch (error) {
		return { error: `${label} could not be loaded: ${error instanceof Error ? error.message : String(error)}` };
	}
}

async function sourceContains(relativePath, pattern) {
	try {
		return pattern.test(await readFile(resolve(repositoryRoot, relativePath), 'utf8'));
	} catch {
		return false;
	}
}

async function hasOnlySqlResultZeusImports() {
	const files = await listFiles(resolve(repositoryRoot, 'src/vs/workbench'));
	for (const file of files.filter(file => /\.(ts|tsx|js|mjs)$/.test(file))) {
		const source = await readFile(file, 'utf8');
		if (/@zeus-web|@zeus-js|zw-data-grid/.test(source) && !file.includes('/contrib/sqlResult/')) return false;
	}
	return true;
}

async function listFiles(directory) {
	const { readdir } = await import('node:fs/promises');
	const files = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const file = resolve(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await listFiles(file)));
		else files.push(file);
	}
	return files;
}

function displayPath(filePath) {
	return filePath.startsWith(repositoryRoot) ? filePath.slice(repositoryRoot.length + 1) : filePath;
}
