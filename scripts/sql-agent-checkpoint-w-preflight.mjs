#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

export const defaultRepository = 'baicie/nyala-studio';
export const defaultRef = 'mvp';
export const diagnosticEvidenceRefPrefix = 'qa://local-preflight-not-admission-evidence';
export const diagnosticReviewer = 'local-preflight-diagnostic-not-a-signoff';

// 这四个人工门 + manual attestation 自身的结构门是预检中唯一允许失败的项目。
export const expectedManualFailureCheckIds = [
	'manual-attestation',
	'macos-native-keyboard',
	'macos-voiceover',
	'windows-native-keyboard',
	'windows-narrator'
];

export const preflightDisclaimer = [
	'本地诊断（diagnostic-only）：这里的 GO / NO-GO 都不是准入证据。',
	'只有受保护默认分支 sql-agent-checkpoint-w-attest.yml 产出的 phase-a4-checkpoint-w.json 才允许登记。',
	'预检使用全部四项为 false 的临时 manual attestation，不构成任何人工签收。'
];

if (isMain) await runCli();

export function validatePreflightOptions(options, root = repositoryRoot) {
	const reasons = [];
	const rawRunId = options['run-id'];
	const runId = typeof rawRunId === 'number' ? String(rawRunId) : rawRunId;
	const repository = options.repository ?? defaultRepository;
	const ref = options.ref ?? defaultRef;
	const validRunId = typeof runId === 'string' && /^[1-9][0-9]*$/.test(runId);
	if (!validRunId) {
		reasons.push('--run-id 必须是正整数 GitHub Actions run id');
	}
	if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
		reasons.push('--repository 必须是 owner/name');
	}
	if (!isBranchName(ref)) {
		reasons.push('--ref 必须是合法分支名');
	}
	const directory = resolve(options.dir ?? `/tmp/nyala-a4-preflight-${runId ?? '<run-id>'}`);
	if (validRunId && isInsideRepository(directory, root)) {
		reasons.push('--dir 不能位于仓库内：本地预检产物不是准入证据，必须留在仓库外的临时目录');
	}
	for (const [flag, value] of [
		['--artifacts-dir', options['artifacts-dir']],
		['--run-json', options['run-json']],
		['--artifacts-json', options['artifacts-json']]
	]) {
		if (typeof value !== 'string' || value.trim() === '') continue;
		if (isInsideRepository(resolve(value), root)) {
			reasons.push(`${flag} 不能位于仓库内：本地预检产物不是准入证据，必须留在仓库外的临时目录`);
		}
	}
	const declaredDefaultBranch = normalizeString(options['default-branch']);
	const declaredTipRevision = normalizeString(options['tip-revision']);
	if ((declaredDefaultBranch === undefined) !== (declaredTipRevision === undefined)) {
		reasons.push('--default-branch 与 --tip-revision 必须同时提供（离线 / 复用模式无法查询默认分支 tip）');
	}
	if (declaredDefaultBranch !== undefined && !isBranchName(declaredDefaultBranch)) {
		reasons.push('--default-branch 必须是合法分支名');
	}
	if (declaredTipRevision !== undefined && !isGitRevision(declaredTipRevision)) {
		reasons.push('--tip-revision 必须是 40 位 Git SHA');
	}
	return { reasons, runId, repository, ref, directory };
}

/**
 * Compare the capture revision with the repository default branch and its current tip.
 * The protected attestation workflow (W5) rejects any capture that is not the current
 * default-branch revision, so the preflight must not report "ready for W4" without it.
 */
export function evaluateRevisionBinding({ ref, captureRevision, defaultBranch, tipRevision }) {
	if (
		typeof defaultBranch !== 'string' ||
		defaultBranch === '' ||
		typeof tipRevision !== 'string' ||
		tipRevision === ''
	) {
		return {
			status: 'unverified',
			reason: '默认分支或 tip revision 未知（离线 / 复用模式）：无法确认 capture revision 仍是默认分支当前 tip'
		};
	}
	if (defaultBranch !== ref) {
		return { status: 'wrong-branch', reason: `--ref ${ref} 不是仓库默认分支 ${defaultBranch}` };
	}
	if (tipRevision.toLowerCase() !== captureRevision.toLowerCase()) {
		return {
			status: 'stale',
			reason: `${ref} 的当前 tip ${tipRevision} 与 capture revision ${captureRevision} 不一致`
		};
	}
	return { status: 'match', reason: `${ref} 当前 tip 与 capture revision 一致` };
}

export function classifyPreflightReport(
	report,
	expectedCheckIds = expectedManualFailureCheckIds,
	revisionBinding = { status: 'unverified' }
) {
	const checks = Array.isArray(report?.checks) ? report.checks : [];
	const expected = new Set(expectedCheckIds);
	const failedChecks = checks.filter(check => check?.passed !== true);
	const passedChecks = checks.filter(check => check?.passed === true);
	const expectedManualFailures = failedChecks.filter(check => expected.has(check?.id));
	const unexpectedFailures = failedChecks.filter(check => !expected.has(check?.id));
	const manualChecksPassed = passedChecks.filter(check => expected.has(check?.id)).map(check => check.id);
	const missingManualChecks = expectedCheckIds.filter(id => !checks.some(check => check?.id === id));
	let verdict;
	if (report?.decision === 'GO') verdict = 'unexpected-go';
	else if (unexpectedFailures.length > 0) verdict = 'machine-side-blocked';
	else if (manualChecksPassed.length > 0 || missingManualChecks.length > 0) verdict = 'unexpected-manual-result';
	else if (revisionBinding.status === 'stale') verdict = 'stale-revision';
	else verdict = 'expected-diagnostic';
	return {
		verdict,
		exitCode: verdict === 'expected-diagnostic' ? 0 : 1,
		decision: report?.decision ?? null,
		checkCount: checks.length,
		machineSideChecksPassed: passedChecks.filter(check => !expected.has(check?.id)).length,
		revisionBinding,
		expectedManualFailures: expectedManualFailures.map(check => ({
			id: check.id ?? null,
			reason: typeof check.reason === 'string' ? check.reason : null
		})),
		unexpectedFailures: unexpectedFailures.map(check => ({
			id: check.id ?? null,
			reason: typeof check.reason === 'string' ? check.reason : null
		})),
		manualChecksPassed,
		missingManualChecks
	};
}

export function buildManualAttestationOptions({ directory, captureRun }) {
	const provenance = captureRun?.provenance ?? {};
	return {
		output: join(directory, 'manual-attestation.LOCAL-DIAGNOSTIC.json'),
		repository: provenance.repository,
		sourceRevision: provenance.sourceRevision,
		sourceRef: provenance.sourceRef,
		workflowRunId: provenance.workflowRunId,
		workflowRunAttempt: String(provenance.workflowRunAttempt),
		reviewer: diagnosticReviewer,
		workflowRunUrl: `https://github.com/${provenance.repository}/actions/runs/${provenance.workflowRunId}`,
		confirmations: {
			'macos-keyboard': 'false',
			voiceover: 'false',
			'windows-keyboard': 'false',
			narrator: 'false'
		},
		evidenceRefs: {
			'macos-keyboard-evidence-ref': `${diagnosticEvidenceRefPrefix}/macos-keyboard`,
			'voiceover-evidence-ref': `${diagnosticEvidenceRefPrefix}/voiceover`,
			'windows-keyboard-evidence-ref': `${diagnosticEvidenceRefPrefix}/windows-keyboard`,
			'narrator-evidence-ref': `${diagnosticEvidenceRefPrefix}/narrator`
		}
	};
}

export function buildManualAttestationArgs(options) {
	const args = [
		join(scriptDirectory, 'create-sql-agent-checkpoint-w-attestation.mjs'),
		'--output',
		options.output,
		'--repository',
		options.repository,
		'--source-revision',
		options.sourceRevision,
		'--source-ref',
		options.sourceRef,
		'--workflow-run-id',
		options.workflowRunId,
		'--workflow-run-attempt',
		options.workflowRunAttempt,
		'--reviewer',
		options.reviewer,
		'--workflow-run-url',
		options.workflowRunUrl
	];
	for (const [name, value] of Object.entries(options.confirmations)) args.push(`--${name}`, value);
	for (const [name, value] of Object.entries(options.evidenceRefs)) args.push(`--${name}`, value);
	return args;
}

async function runCli() {
	const cli = parseArgs(process.argv.slice(2).filter(argument => argument !== '--'));
	if (cli.help !== undefined) {
		process.stdout.write(usage());
		return;
	}
	try {
		const summary = await runPreflight(cli);
		process.exitCode = summary.exitCode;
	} catch (error) {
		process.stderr.write(`preflight setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	}
}

export async function runPreflight(cli) {
	const { reasons, runId, repository, ref, directory } = validatePreflightOptions(cli);
	if (reasons.length > 0) throw new Error(reasons.join('; '));
	const expectedRef = `refs/heads/${ref}`;
	process.stdout.write(`local diagnostic preflight for ${repository} run ${runId} (expected ref ${expectedRef})\n`);
	process.stdout.write('read-only: gh api / gh run download only; nothing is dispatched or published\n');
	await mkdir(directory, { recursive: true });

	const { runMetadataPath, artifactMetadataPath } = await captureApiMetadata({ cli, directory, repository, runId });
	const captureRun = await verifyCaptureRun({ directory, repository, runId, runMetadataPath, artifactMetadataPath });
	const provenance = captureRun.provenance;
	if (provenance.sourceRef !== expectedRef || captureRun.run?.headBranch !== ref) {
		throw new Error(
			`capture run head ref ${captureRun.run?.headBranch ?? '<unknown>'} does not match expected ${expectedRef}; ` +
				'only a capture dispatched from the protected default branch can feed the attestation workflow'
		);
	}
	const revisionBinding = await resolveRevisionBinding({
		cli,
		repository,
		ref,
		captureRevision: provenance.sourceRevision
	});
	if (revisionBinding.status === 'wrong-branch') {
		throw new Error(`${revisionBinding.reason}；W5 只接受受保护默认分支上的 capture`);
	}
	process.stdout.write(
		`revision binding: ${revisionBinding.status} (${revisionBinding.source}) — ${revisionBinding.reason}\n`
	);

	const artifactsDirectory = resolve(cli['artifacts-dir'] ?? join(directory, 'artifacts'));
	await ensureEvidenceArtifacts({ artifactsDirectory, repository, runId, evidence: captureRun.artifacts });
	const macosEvidencePath = join(artifactsDirectory, 'sql-agent-native-macos', 'workbench-evidence.json');
	const windowsEvidencePath = join(artifactsDirectory, 'sql-agent-native-windows', 'workbench-evidence.json');

	const manualAttestationPath = await createDiagnosticManualAttestation({ directory, captureRun });
	const reportPath = join(directory, 'phase-a4-checkpoint-w.preflight.json');
	const gateStartedAt = Date.now();
	await runCheckpointWGate({
		macosEvidencePath,
		windowsEvidencePath,
		manualAttestationPath,
		captureRunPath: join(directory, 'capture-run.json'),
		reportPath,
		repository,
		sourceRevision: provenance.sourceRevision,
		sourceRef: provenance.sourceRef
	});
	const report = await readJson(reportPath, 'preflight gate report');
	const reportGeneratedAt = Date.parse(report.generatedAt ?? '');
	if (!Number.isFinite(reportGeneratedAt) || reportGeneratedAt < gateStartedAt - 5000) {
		throw new Error(
			`gate report at ${reportPath} is stale (generatedAt ${formatValue(report.generatedAt)}); ` +
				'delete that temporary directory and rerun the preflight'
		);
	}
	const classification = classifyPreflightReport(report, expectedManualFailureCheckIds, revisionBinding);
	const summary = {
		version: 1,
		generatedAt: new Date().toISOString(),
		diagnosticOnly: true,
		repository,
		runId,
		expectedRef,
		captureProvenance: provenance,
		revisionBinding,
		inputs: {
			macosEvidencePath,
			windowsEvidencePath,
			manualAttestationPath,
			captureRunPath: join(directory, 'capture-run.json'),
			gateReportPath: reportPath,
			summaryPath: join(directory, 'preflight-summary.json')
		},
		...classification,
		disclaimer: preflightDisclaimer
	};
	await writeFile(summary.inputs.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
	printSummary(summary);
	return summary;
}

async function captureApiMetadata({ cli, directory, repository, runId }) {
	const runMetadataPath = resolve(cli['run-json'] ?? join(directory, 'run.json'));
	const artifactMetadataPath = resolve(cli['artifacts-json'] ?? join(directory, 'artifacts.json'));
	if (!cli['run-json']) {
		await gh(['api', `repos/${repository}/actions/runs/${runId}`], runMetadataPath);
	}
	if (!cli['artifacts-json']) {
		await gh(['api', `repos/${repository}/actions/runs/${runId}/artifacts`], artifactMetadataPath);
	}
	return { runMetadataPath, artifactMetadataPath };
}

async function verifyCaptureRun({ directory, repository, runId, runMetadataPath, artifactMetadataPath }) {
	const captureRunPath = join(directory, 'capture-run.json');
	try {
		await execFileAsync(process.execPath, [
			join(scriptDirectory, 'verify-sql-agent-capture-run.mjs'),
			'--run-metadata',
			runMetadataPath,
			'--artifact-metadata',
			artifactMetadataPath,
			'--output',
			captureRunPath,
			'--expected-repository',
			repository,
			'--expected-run-id',
			runId
		]);
	} catch (error) {
		throw new Error(
			`capture run metadata is not verifiable: ${collectProcessOutput(error) || (error instanceof Error ? error.message : String(error))}`
		);
	}
	const captureRun = await readJson(captureRunPath, 'capture run metadata');
	if (captureRun.status !== 'verified') {
		throw new Error(`capture run metadata status is ${formatValue(captureRun.status)}; do not proceed to W4`);
	}
	return captureRun;
}

async function ensureEvidenceArtifacts({ artifactsDirectory, repository, runId, evidence }) {
	const expectedPaths = [
		join(artifactsDirectory, 'sql-agent-native-macos', 'workbench-evidence.json'),
		join(artifactsDirectory, 'sql-agent-native-windows', 'workbench-evidence.json')
	];
	const present = await Promise.all(expectedPaths.map(path => fileExists(path)));
	if (present.every(Boolean)) {
		process.stdout.write(`using extracted native evidence in ${artifactsDirectory}\n`);
		return;
	}
	if (present.some(Boolean)) {
		throw new Error(`${artifactsDirectory} contains an incomplete evidence set; remove it and rerun the download`);
	}
	process.stdout.write(`downloading ${evidence.length} capture artifacts into ${artifactsDirectory}\n`);
	try {
		await execFileAsync('gh', ['run', 'download', runId, '--repo', repository, '--dir', artifactsDirectory]);
	} catch (error) {
		throw new Error(`gh run download failed: ${collectProcessOutput(error) || 'unknown error'}`);
	}
	const downloaded = await Promise.all(expectedPaths.map(path => fileExists(path)));
	if (!downloaded.every(Boolean)) {
		throw new Error(
			'downloaded artifacts do not contain sql-agent-native-macos / sql-agent-native-windows workbench-evidence.json'
		);
	}
}

async function createDiagnosticManualAttestation({ directory, captureRun }) {
	const options = buildManualAttestationOptions({ directory, captureRun });
	const args = buildManualAttestationArgs(options);
	try {
		await execFileAsync(process.execPath, args);
	} catch (error) {
		throw new Error(
			`diagnostic manual attestation failed: ${collectProcessOutput(error) || (error instanceof Error ? error.message : String(error))}`
		);
	}
	const attestation = await readJson(options.output, 'diagnostic manual attestation');
	if (attestation.status !== 'pending') {
		throw new Error(
			'diagnostic manual attestation must stay pending; refusing to continue with a non-pending attestation'
		);
	}
	return options.output;
}

async function runCheckpointWGate({
	macosEvidencePath,
	windowsEvidencePath,
	manualAttestationPath,
	captureRunPath,
	reportPath,
	repository,
	sourceRevision,
	sourceRef
}) {
	try {
		await execFileAsync(process.execPath, [
			join(scriptDirectory, 'verify-sql-agent-checkpoint-w.mjs'),
			'--macos',
			macosEvidencePath,
			'--windows',
			windowsEvidencePath,
			'--manual',
			manualAttestationPath,
			'--capture-run',
			captureRunPath,
			'--output',
			reportPath,
			'--expected-repository',
			repository,
			'--expected-revision',
			sourceRevision,
			'--expected-ref',
			sourceRef
		]);
	} catch (error) {
		// NO-GO 是预检的预期结果；只有报告不可读时才是真正的执行失败。
		if (!(await fileExists(reportPath))) {
			throw new Error(`Checkpoint W gate did not produce a report: ${collectProcessOutput(error)}`);
		}
	}
}

function printSummary(summary) {
	process.stdout.write(`\npreflight verdict: ${summary.verdict} (exit ${summary.exitCode})\n`);
	process.stdout.write(`  gate decision: ${formatValue(summary.decision)}\n`);
	process.stdout.write(`  machine-side checks passed: ${summary.machineSideChecksPassed}\n`);
	for (const failure of summary.expectedManualFailures) {
		process.stdout.write(`  expected manual failure: ${failure.id}\n`);
	}
	for (const failure of summary.unexpectedFailures) {
		process.stdout.write(`  UNEXPECTED failure: ${failure.id} -> ${failure.reason ?? 'no reason recorded'}\n`);
	}
	for (const id of summary.manualChecksPassed) {
		process.stdout.write(`  UNEXPECTED manual pass: ${id}\n`);
	}
	for (const id of summary.missingManualChecks) {
		process.stdout.write(`  MISSING manual check: ${id}\n`);
	}
	process.stdout.write(`  gate report: ${summary.inputs.gateReportPath}\n`);
	process.stdout.write(`  summary: ${summary.inputs.summaryPath}\n`);
	if (summary.verdict === 'expected-diagnostic') {
		process.stdout.write('  机器面全部通过、人工面按预期未签收。\n');
		if (summary.revisionBinding?.status === 'match') {
			process.stdout.write(
				'  revision 绑定已核对（默认分支 tip == capture revision）：可以进入 W4；W4 期间不要再向该分支推提交。\n'
			);
		} else {
			process.stdout.write(
				'  注意：未能核对默认分支当前 tip，进入 W4 前请自行确认 capture revision 就是受保护默认分支的当前 tip。\n'
			);
		}
	} else if (summary.verdict === 'stale-revision') {
		process.stdout.write('  capture revision 已不是默认分支当前 tip：先重新 capture（W2），不要开始 W4 人工走查。\n');
	} else if (summary.verdict === 'machine-side-blocked') {
		process.stdout.write('  机器面存在失败项：不要进入 W4，先按上面的 reason 修复并重新 capture。\n');
	} else if (summary.verdict === 'unexpected-go') {
		process.stdout.write('  全 false 输入竟然得到 GO：输入或 gate 被篡改，禁止登记，立即人工复核。\n');
	} else {
		process.stdout.write('  人工面结果不符合全 false 诊断输入：确认 attestation 未被替换或伪造。\n');
	}
	for (const line of preflightDisclaimer) process.stdout.write(`  ${line}\n`);
}

async function gh(args, outputPath) {
	const stdout = await ghText(args);
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, stdout, 'utf8');
}

async function ghText(args) {
	try {
		const { stdout } = await execFileAsync('gh', args, { maxBuffer: 16 * 1024 * 1024 });
		return stdout;
	} catch (error) {
		throw new Error(
			`gh ${args.join(' ')} failed: ${collectProcessOutput(error) || (error instanceof Error ? error.message : String(error))}`
		);
	}
}

/**
 * Resolve the repository default branch and its current tip, then bind them to the
 * capture revision. Offline / reuse mode can declare them explicitly with
 * --default-branch / --tip-revision; otherwise `gh api` is queried. A failed query
 * degrades to `unverified` (never to a silent "ready for W4").
 */
export async function resolveRevisionBinding({ cli, repository, ref, captureRevision, ghQuery = ghText }) {
	const declaredDefaultBranch = normalizeString(cli['default-branch']);
	const declaredTipRevision = normalizeString(cli['tip-revision']);
	if (declaredDefaultBranch !== undefined || declaredTipRevision !== undefined) {
		return {
			...evaluateRevisionBinding({
				ref,
				captureRevision,
				defaultBranch: declaredDefaultBranch,
				tipRevision: declaredTipRevision
			}),
			source: 'declared'
		};
	}
	try {
		const defaultBranch = (await ghQuery(['api', `repos/${repository}`, '--jq', '.default_branch'])).trim();
		const tipRevision = (await ghQuery(['api', `repos/${repository}/commits/${ref}`, '--jq', '.sha'])).trim();
		return {
			...evaluateRevisionBinding({ ref, captureRevision, defaultBranch, tipRevision }),
			source: 'gh-api'
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			...evaluateRevisionBinding({ ref, captureRevision }),
			source: 'unavailable',
			reason: `gh api 查询默认分支 tip 失败：${reason}`
		};
	}
}

async function readJson(filePath, label) {
	try {
		const value = JSON.parse(await readFile(filePath, 'utf8'));
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not a JSON object');
		return value;
	} catch (error) {
		throw new Error(
			`${label} could not be loaded from ${filePath}: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

async function fileExists(filePath) {
	try {
		return (await lstat(filePath)).isFile();
	} catch {
		return false;
	}
}

function isBranchName(value) {
	return (
		typeof value === 'string' &&
		/^[A-Za-z0-9._/-]+$/.test(value) &&
		!value.startsWith('/') &&
		!value.endsWith('/') &&
		!value.includes('..') &&
		!value.includes('//')
	);
}

function isGitRevision(value) {
	return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
}

function normalizeString(value) {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isInsideRepository(directory, root) {
	const normalizedRoot = resolve(root);
	return directory === normalizedRoot || directory.startsWith(`${normalizedRoot}${sep}`);
}

function collectProcessOutput(error) {
	const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
	const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
	return [stderr, stdout].filter(Boolean).join(' | ');
}

function formatValue(value) {
	return JSON.stringify(value) ?? String(value);
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
		if (value === undefined || value.startsWith('--')) {
			result[key] = true;
			continue;
		}
		result[key] = value;
		index += 1;
	}
	return result;
}

function usage() {
	return [
		'用法: node scripts/sql-agent-checkpoint-w-preflight.mjs --run-id <capture-run-id> [选项]',
		'',
		'诊断-only：读取 capture run 元数据、下载双平台 artifact、用全部四项为 false 的临时',
		'manual attestation 跑一次 fail-closed gate，预期 machine-side 全通过、manual 面失败（NO-GO）。',
		'本地 GO / NO-GO 都不是准入证据；只有受保护默认分支 attestation workflow 的产物可以登记。',
		'',
		'选项:',
		`  --run-id <id>          必填，sql-agent-native.yml 的 run id`,
		`  --repository <o/n>     默认 ${defaultRepository}`,
		`  --ref <branch>         默认 ${defaultRef}；capture 必须从该受保护分支触发`,
		'  --dir <path>           默认 /tmp/nyala-a4-preflight-<run-id>；必须在仓库之外',
		'  --artifacts-dir <path> 复用已解压的 artifact（必须在仓库外），跳过 gh run download',
		'  --run-json <path>      复用已保存的 run API JSON（必须在仓库外），跳过 gh api',
		'  --artifacts-json <path> 复用已保存的 artifacts API JSON（必须在仓库外），跳过 gh api',
		'  --default-branch <name> 与 --tip-revision 成对提供：离线 / 复用模式下声明默认分支当前 tip',
		'  --tip-revision <sha>   默认分支当前 tip 的 40 位 SHA；与 capture revision 不一致时判定 stale-revision',
		'  --help                 显示本帮助',
		'',
		'退出码: 0 预检符合预期；1 结果异常（机器面失败 / 意外 GO / 人工面意外通过 / capture 落后于默认分支 tip）；',
		'        2 用法或环境错误。',
		''
	].join('\n');
}
