#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createSqlResultGridFrameAwareProfile } from './sql-result-grid-frame-aware-profile.mjs';

const cli = parseArgs(process.argv.slice(2));
if (cli.help === 'true') {
	printUsage();
	process.exit(0);
}
const evidencePaths = cli.evidence;
if (evidencePaths.length === 0) {
	printUsage();
	throw new Error('At least one --evidence <path> is required.');
}

const analyses = [];
for (const evidencePath of evidencePaths) {
	const absolutePath = resolve(evidencePath);
	const evidence = JSON.parse(await readFile(absolutePath, 'utf8'));
	const workloadIds = cli.workload
		? cli.workload
				.split(',')
				.map(id => id.trim())
				.filter(Boolean)
		: undefined;
	analyses.push({
		label: basename(absolutePath, '.json'),
		evidence: absolutePath,
		platform: evidence.platform ?? null,
		runs: evidence.runs ?? null,
		profile: createSqlResultGridFrameAwareProfile(evidence, workloadIds ? { workloadIds } : {})
	});
}

console.log(JSON.stringify({ analyses }, null, '	'));

function parseArgs(argv) {
	const parsed = {};
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token.startsWith('--')) {
			continue;
		}
		const name = token.slice(2);
		const next = argv[index + 1];
		if (next === undefined || next.startsWith('--')) {
			parsed[name] = 'true';
		} else {
			parsed[name] = next;
			index += 1;
		}
	}
	return { evidence: [], ...parsed, ...collectRepeated(parsed, 'evidence') };
}

function collectRepeated(parsed, name) {
	const values = [];
	const argv = process.argv.slice(2);
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === `--${name}` && argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) {
			values.push(argv[index + 1]);
		}
	}
	return values.length > 0 ? { [name]: values } : {};
}

function printUsage() {
	console.log(`Usage: node scripts/verify-sql-result-grid-frame-aware.mjs [options]

Options:
  -h, --help                    Show this help
  --evidence <path>             Platform evidence JSON (repeatable)
  --workload <ids>              Comma-separated workload ids (default: all)
`);
}
