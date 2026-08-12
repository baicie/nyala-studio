#!/usr/bin/env node

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportPath = resolve(process.argv[2] ?? 'docs/sql-mvp-phases/phase-vnext-release-gate.json');
const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'));
const z1Gate = JSON.parse(await readFile(resolve(repositoryRoot, 'docs/sql-mvp-phases/phase-z1-gate.json'), 'utf8'));
const a4Verification = await readFile(
	resolve(repositoryRoot, 'docs/sql-mvp-phases/phase-a4-workbench-verification.md'),
	'utf8'
);
const roadmap = await readFile(resolve(repositoryRoot, 'docs/sql-mvp-phases/mvp-vnext-agent-zeus-roadmap.md'), 'utf8');

const checks = [
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
	check('z1-go', z1Gate.decision === 'GO', `Z1 gate decision is ${z1Gate.decision}`),
	check(
		'a4-checkpoint-w',
		!/(仍需完成|尚未完成|待完成|pending)/i.test(a4Verification),
		'A4 verification record has no unresolved Checkpoint W marker',
		'A4 Checkpoint W remains pending native WebView/screen-reader evidence'
	),
	check(
		'z2-production-dependency',
		typeof packageJson.dependencies?.['@zeus-web/data-grid'] === 'string',
		'@zeus-web/data-grid is an exact production dependency',
		'@zeus-web/data-grid is not an exact production dependency'
	),
	check(
		'z2-roadmap-status',
		!/\|\s*Z2\s*\|\s*Result Grid Preview\s*\|[^\n]*\|\s*待开始/.test(roadmap),
		'roadmap records Z2 as implemented rather than pending',
		'roadmap still marks Z2 as pending'
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
	version: 1,
	generatedAt: new Date().toISOString(),
	decision: checks.every(item => item.passed) ? 'GO' : 'NO-GO',
	checks,
	blockers: checks.filter(item => !item.passed).map(item => item.reason),
	inputs: {
		z1Decision: z1Gate.decision,
		z1Gate: 'docs/sql-mvp-phases/phase-z1-gate.json',
		a4Verification: 'docs/sql-mvp-phases/phase-a4-workbench-verification.md'
	}
};

await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`${report.decision}: ${reportPath}`);
for (const blocker of report.blockers) console.log(`- ${blocker}`);
process.exitCode = report.decision === 'GO' ? 0 : 1;

function check(id, passed, passReason, failReason = passReason) {
	return { id, passed: Boolean(passed), reason: passed ? passReason : failReason };
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
