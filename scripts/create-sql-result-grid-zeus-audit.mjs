#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const expectedPackage = {
	name: '@zeus-web/data-grid',
	version: '0.1.0-beta.4',
	license: 'MIT',
	integrity: 'sha512-hiaTjf29UY8E/hrMkDm81nVORNWSrqTcInJXQcxZ7azfCfVkN82M8UMe/GDlbQBWksJetq8lT3GbapJEbqZbHA==',
	unpackedSize: 341_232
};
const cli = parseArgs(process.argv.slice(2));
const outputPath = resolve(required(cli.output, '--output'));
const provenance = createProvenance(cli);
let report;

try {
	const packagePath = resolve(required(cli['package-json'], '--package-json'));
	const registryPath = resolve(required(cli['registry-json'], '--registry-json'));
	const bundlePath = resolve(required(cli.bundle, '--bundle'));
	const packageMetadata = JSON.parse(await readFile(packagePath, 'utf8'));
	const registryMetadata = JSON.parse(await readFile(registryPath, 'utf8'));
	const bundle = await readFile(bundlePath);
	const observed = {
		name: packageMetadata.name,
		version: packageMetadata.version,
		license: packageMetadata.license,
		integrity: registryMetadata['dist.integrity'] ?? registryMetadata.dist?.integrity,
		unpackedSize: registryMetadata['dist.unpackedSize'] ?? registryMetadata.dist?.unpackedSize
	};
	const checks = Object.entries(expectedPackage).map(([field, expected]) => ({
		id: `package-${field}`,
		passed: observed[field] === expected,
		reason:
			observed[field] === expected
				? `${field} matches the pre-registered value`
				: `${field}=${JSON.stringify(observed[field])} does not match ${JSON.stringify(expected)}`
	}));
	for (const [field, validator] of Object.entries({
		repository: value => typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value),
		sourceRevision: value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value),
		sourceRef: value => typeof value === 'string' && /^refs\/[A-Za-z0-9._/-]+$/.test(value),
		workflowRunId: value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value),
		workflowRunAttempt: value => Number.isInteger(value) && value > 0
	})) {
		checks.push({
			id: `provenance-${field}`,
			passed: validator(provenance[field]),
			reason: `${field} provenance is ${validator(provenance[field]) ? 'valid' : 'invalid'}`
		});
	}
	const gzip = gzipSync(bundle, { level: 9 });
	report = {
		version: 1,
		generatedAt: new Date().toISOString(),
		status: checks.every(check => check.passed) ? 'ready' : 'blocked',
		provenance,
		package: {
			...observed,
			dependencies: sortRecord(packageMetadata.dependencies),
			peerDependencies: sortRecord(packageMetadata.peerDependencies)
		},
		bundle: {
			file: basename(bundlePath),
			bytes: bundle.byteLength,
			gzipBytes: gzip.byteLength,
			sha256: sha256(bundle)
		},
		checks,
		reasons: checks.filter(check => !check.passed).map(check => check.reason)
	};
} catch (error) {
	report = {
		version: 1,
		generatedAt: new Date().toISOString(),
		status: 'blocked',
		provenance,
		checks: [],
		reasons: [error instanceof Error ? error.message : String(error)]
	};
}

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${report.status}: ${outputPath}\n`);
for (const reason of report.reasons) process.stdout.write(`- ${reason}\n`);
process.exitCode = report.status === 'ready' ? 0 : 1;

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
		result[key] = args[index + 1] ?? 'true';
		index += 1;
	}
	return result;
}

function required(value, name) {
	if (typeof value !== 'string' || value.length === 0 || value === 'true') throw new Error(`${name} is required`);
	return value;
}

function createProvenance(options) {
	const workflowRunAttempt = Number(options['workflow-run-attempt']);
	return {
		repository: options.repository,
		sourceRevision: options['source-revision'],
		sourceRef: options['source-ref'],
		workflowRunId: options['workflow-run-id'],
		workflowRunAttempt
	};
}

function sortRecord(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}
