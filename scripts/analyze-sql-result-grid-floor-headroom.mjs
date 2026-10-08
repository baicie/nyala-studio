#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
	createSqlResultGridFloorHeadroomProfile,
	createSqlResultGridWorkloadCpuRatioProfile
} from './sql-result-grid-floor-headroom.mjs';

const FLOOR_HEADROOM_WORKLOAD_ID = '10k-x-50';

const cli = parseArgs(process.argv.slice(2));
if (cli.help === 'true') {
	printUsage();
	process.exit(0);
}
const reportPaths = cli.report;
if (reportPaths.length === 0) {
	printUsage();
	throw new Error('At least one --report <path> is required.');
}

const workloadId = cli.workload ?? FLOOR_HEADROOM_WORKLOAD_ID;
const workloadScoped = workloadId !== FLOOR_HEADROOM_WORKLOAD_ID;
const analyses = [];
for (const reportPath of reportPaths) {
	const absolutePath = resolve(reportPath);
	const report = JSON.parse(await readFile(absolutePath, 'utf8'));
	const analysis = {
		label: basename(absolutePath, '.json'),
		report: absolutePath
	};
	if (workloadScoped) {
		analysis.cpuRatioProfile = createSqlResultGridWorkloadCpuRatioProfile(report, workloadId);
	} else {
		analysis.profile = createSqlResultGridFloorHeadroomProfile(report);
	}
	analyses.push(analysis);
}

process.stdout.write(workloadScoped ? renderWorkloadCpuRatioTable(analyses) : renderTable(analyses));
if (cli.output) {
	const outputPath = resolve(cli.output);
	await writeFile(
		outputPath,
		`${JSON.stringify(
			{
				version: 1,
				mode: workloadScoped ? 'workload-cpu-ratio' : 'floor-headroom',
				workload: workloadId,
				generatedAt: new Date().toISOString(),
				analyses
			},
			null,
			'\t'
		)}\n`,
		'utf8'
	);
	process.stdout.write(`\nWrote ${outputPath}\n`);
}

function renderTable(entries) {
	const rows = [
		[
			'report',
			'baseline p95',
			'required Zeus',
			'shared floor p95',
			'best-case floor improvement',
			'observed improvement',
			'Zeus union p95',
			'WBT union p95',
			'CPU ratio Z/W',
			'one-frame samples',
			'floor-bounded 20% reachable'
		],
		...entries.map(entry => {
			const profile = entry.profile;
			const zeusIntervals = profile.zeusRendererIntervals;
			const workbenchTableIntervals = profile.workbenchTableRendererIntervals;
			const cpuRatio = profile.rendererCpuRatio;
			return [
				entry.label,
				`${formatMs(profile.baselineP95Ms)}ms`,
				`${formatMs(profile.requiredZeusP95Ms)}ms`,
				`${formatMs(profile.sharedPresentationFloorP95Ms)}ms`,
				formatRate(profile.maximumFloorBoundedImprovementAtMostOptimisticFloor),
				formatRate(profile.observedImprovement),
				zeusIntervals.available ? `${formatMs(zeusIntervals.unionMs.p95)}ms` : 'n/a',
				workbenchTableIntervals.available ? `${formatMs(workbenchTableIntervals.unionMs.p95)}ms` : 'n/a',
				cpuRatio.available ? `${(Math.round(cpuRatio.ratio * 1000) / 1000).toFixed(3)}` : 'n/a',
				summarizeOneFrame(profile),
				profile.floorBoundedSuperiorityReachable ? 'yes' : 'no'
			];
		})
	];
	return renderRows(rows);
}

function renderWorkloadCpuRatioTable(entries) {
	const rows = [
		['report', 'workload', 'Zeus union p95', 'WBT union p95', 'CPU ratio Z/W', 'records (Zeus/WBT)', 'available'],
		...entries.map(entry => {
			const profile = entry.cpuRatioProfile;
			const zeusIntervals = profile.zeusRendererIntervals;
			const workbenchTableIntervals = profile.workbenchTableRendererIntervals;
			const cpuRatio = profile.rendererCpuRatio;
			return [
				entry.label,
				profile.workloadId,
				zeusIntervals.available ? `${formatMs(zeusIntervals.unionMs.p95)}ms` : 'n/a',
				workbenchTableIntervals.available ? `${formatMs(workbenchTableIntervals.unionMs.p95)}ms` : 'n/a',
				cpuRatio.available ? `${(Math.round(cpuRatio.ratio * 1000) / 1000).toFixed(3)}` : 'n/a',
				`${profile.recordCounts.zeus}/${profile.recordCounts.workbenchTable}`,
				cpuRatio.available ? 'yes' : 'no'
			];
		})
	];
	return renderRows(rows);
}

function renderRows(rows) {
	const widths = rows[0].map((_, columnIndex) => Math.max(...rows.map(row => row[columnIndex].length)));
	return `${rows
		.map(row => `| ${row.map((cell, columnIndex) => cell.padEnd(widths[columnIndex])).join(' | ')} |`)
		.join('\n')}\n`;
}

function summarizeOneFrame(profile) {
	const buckets = Object.values(profile.scrollSamples);
	const samples = buckets.reduce((total, bucket) => total + bucket.sampleCount, 0);
	const oneFrame = buckets.reduce((total, bucket) => total + bucket.oneFrameSampleCount, 0);
	return `${oneFrame}/${samples}`;
}

function formatMs(value) {
	return (Math.round(value * 100) / 100).toFixed(2);
}

function formatRate(value) {
	return `${(Math.round(value * 10_000) / 100).toFixed(2)}%`;
}

function parseArgs(args) {
	const reports = [];
	const result = { report: reports };
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
		const [key, inlineValue] = argument.slice(2).split('=', 2);
		if (key === 'help') {
			result.help = 'true';
			continue;
		}
		const value = inlineValue ?? args[index + 1];
		if (typeof value !== 'string' || value.startsWith('--')) {
			throw new Error(`--${key} requires a value.`);
		}
		if (inlineValue === undefined) index += 1;
		if (key === 'report') {
			for (const entry of value.split(',').filter(Boolean)) reports.push(entry);
			continue;
		}
		if (key === 'output') {
			result[key] = value;
			continue;
		}
		if (key === 'workload') {
			result[key] = value;
			continue;
		}
		throw new Error(`Unknown argument: --${key}`);
	}
	return result;
}

function printUsage() {
	process.stdout.write(
		[
			'Usage: node scripts/analyze-sql-result-grid-floor-headroom.mjs --report <path> [--report <path>] [--workload <id>] [--output <path>]',
			'',
			'Decomposes a diagnostic-profile v6 benchmark report into the shared presentation floor,',
			'the Zeus and WorkbenchTable renderer interval unions, the Q95(Zeus)/Q95(WorkbenchTable)',
			'CPU interval ratio, and the floor-bounded improvement bound. Diagnostic evidence only:',
			'it cannot rewrite v6 admission evidence or flip phase-z1-gate.json.',
			'',
			'With --workload <id> other than 10k-x-50 the floor math is skipped and only the',
			'workload-scoped CPU interval ratio of that workload is reported.',
			''
		].join('\n')
	);
}
