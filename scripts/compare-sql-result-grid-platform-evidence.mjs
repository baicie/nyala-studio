#!/usr/bin/env node

// 对比两份 SQL Result Grid 平台证据（baseline vs candidate）。
//
// 设计原则：只做「可核验的机械对比」，不生成任何结论性性能宣称。
// - 只有当两份证据的 measurementContractVersion / scrollCommitBoundary / executionOrder
//   / platformName / workload 集合一致时，指标才进入 delta 表；否则标记为不可比。
// - zeusBundleSha256 相同意味着同一份 bundle，任何 delta 都必须视为噪声，不能当作收益。
// - admissionGrade 为 false 的 run（例如 instrument_baseline=true）只做诊断对比，
//   脚本会在输出里显式标注 scored=false。

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const IDENTITY_KEYS = ['measurementContractVersion', 'scrollCommitBoundary', 'executionOrder'];

// Metrics that only exist on the raw records, not in the summary object. Without
// these the Zeus-side commit and raf-to-task costs are invisible, which is the
// whole point of the comparison.
const RECORD_METRICS = ['scrollMedianMs', 'rafToTaskMs', 'commitMs', 'textWrites'];

// Summary-level metrics. `scrollMedianMs` is absent here because the summary
// only collapses to `scrollP95Ms`/`scrollMaxMs`.
const METRICS = ['scrollP95Ms', 'scrollMaxMs', 'presentationFloorP95Ms'];

/** Control-renderer scrollP95Ms movement above this is treated as run drift. */
const CONTROL_DRIFT_REPORT_PERCENT = 10;

const cli = parseArgs(process.argv.slice(2));
if (!cli.baseline || !cli.candidate) {
	throw new Error('Usage: compare-sql-result-grid-platform-evidence.mjs --baseline <file> --candidate <file> [--json]');
}

const baseline = await load(cli.baseline);
const candidate = await load(cli.candidate);
const report = compare(baseline, candidate);

if (cli.json) {
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
	process.stdout.write(`${renderText(report)}\n`);
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
		result[key] = args[index + 1] ?? 'true';
		index += 1;
	}
	return result;
}

async function load(filePath) {
	const resolved = resolve(filePath);
	const value = JSON.parse(await readFile(resolved, 'utf8'));
	if (!value || typeof value !== 'object') throw new Error(`${resolved} is not an evidence object`);
	if (!value.summary || typeof value.summary !== 'object') {
		throw new Error(`${resolved} has no summary object`);
	}
	return { path: resolved, value };
}

function compare(baselineFile, candidateFile) {
	const base = baselineFile.value;
	const cand = candidateFile.value;

	const identityMismatches = [];
	for (const key of IDENTITY_KEYS) {
		if (base[key] !== cand[key]) {
			identityMismatches.push(`${key}: ${JSON.stringify(base[key])} -> ${JSON.stringify(cand[key])}`);
		}
	}
	if (base.platformName !== cand.platformName) {
		identityMismatches.push(
			`platformName: ${JSON.stringify(base.platformName)} -> ${JSON.stringify(cand.platformName)}`
		);
	}

	const baseBundle = base.provenance?.zeusBundleSha256 ?? null;
	const candBundle = cand.provenance?.zeusBundleSha256 ?? null;
	const sameBundle = baseBundle !== null && baseBundle === candBundle;

	const keys = [...new Set([...Object.keys(base.summary), ...Object.keys(cand.summary)])].sort();
	const baseRecordMetrics = collectRecordMetrics(base.records);
	const candRecordMetrics = collectRecordMetrics(cand.records);
	const rows = [];
	for (const key of keys) {
		const b = base.summary[key];
		const c = cand.summary[key];
		if (!b || !c) {
			rows.push({ key, comparable: false, reason: b ? 'missing in candidate' : 'missing in baseline' });
			continue;
		}
		const metricDeltas = {};
		for (const metric of METRICS) {
			const bm = medianOf(b, metric);
			const cm = medianOf(c, metric);
			if (bm === null || cm === null) continue;
			metricDeltas[metric] = {
				baselineMedian: bm,
				candidateMedian: cm,
				deltaMs: round(cm - bm),
				changePercent: bm === 0 ? null : round(((cm - bm) / bm) * 100, 1)
			};
		}
		for (const metric of RECORD_METRICS) {
			const bm = baseRecordMetrics.get(key)?.[metric] ?? null;
			const cm = candRecordMetrics.get(key)?.[metric] ?? null;
			if (bm === null || cm === null) continue;
			metricDeltas[metric] = {
				baselineMedian: round(bm),
				candidateMedian: round(cm),
				deltaMs: round(cm - bm),
				changePercent: bm === 0 ? null : round(((cm - bm) / bm) * 100, 1)
			};
		}
		rows.push({
			key,
			comparable: identityMismatches.length === 0,
			reason: identityMismatches.length === 0 ? undefined : 'measurement identity differs between runs',
			baselineRuns: b.count ?? null,
			candidateRuns: c.count ?? null,
			metrics: metricDeltas
		});
	}

	const scored = identityMismatches.length === 0 && !sameBundle;
	const caveats = [];
	if (sameBundle) {
		caveats.push(
			`zeusBundleSha256 is identical (${baseBundle}); the compared bundles are the same build, so every delta is measurement noise, not a fix effect.`
		);
	}
	if (identityMismatches.length > 0) {
		caveats.push(`Measurement identity differs: ${identityMismatches.join('; ')}.`);
	}
	if (base.admissionGrade === false || cand.admissionGrade === false) {
		caveats.push(
			`At least one run is diagnostic only (admissionGrade=false: baseline=${base.admissionGrade}, candidate=${cand.admissionGrade}); it must not be scored for gate admission.`
		);
	}
	caveats.push(...controlRendererCaveats(rows));
	for (const file of [baselineFile, candidateFile]) {
		for (const limitation of file.value.limitations ?? []) {
			caveats.push(`[${file.path}] ${limitation}`);
		}
	}

	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		baseline: {
			path: baselineFile.path,
			workflowRunId: base.provenance?.workflowRunId ?? null,
			zeusBundleSha256: baseBundle,
			admissionGrade: base.admissionGrade ?? null
		},
		candidate: {
			path: candidateFile.path,
			workflowRunId: cand.provenance?.workflowRunId ?? null,
			zeusBundleSha256: candBundle,
			admissionGrade: cand.admissionGrade ?? null
		},
		scored,
		sameBundle,
		identityMismatches,
		caveats,
		rows
	};
}

function medianOf(summaryEntry, metric) {
	const direct = summaryEntry[metric];
	const source = direct ?? summaryEntry.scroll?.[metric];
	if (source && typeof source === 'object' && typeof source.median === 'number') return source.median;
	if (typeof source === 'number') return source;
	return null;
}

/**
 * The native and workbench-table renderers do not load the Zeus bundle, so any
 * movement in their metrics is host or runner drift, not a Zeus fix effect. If
 * the controls moved as much as Zeus did, the Zeus delta cannot be attributed
 * to the change under test and the run pair is not usable as evidence.
 */
function controlRendererCaveats(rows) {
	const caveats = [];
	const byWorkload = new Map();
	for (const row of rows) {
		const { workload, renderer } = splitSummaryKey(row.key);
		if (renderer === 'zeus') continue;
		const change = row.metrics?.scrollP95Ms?.changePercent;
		if (!Number.isFinite(change)) continue;
		const bucket = byWorkload.get(workload) ?? [];
		bucket.push({ renderer, change });
		byWorkload.set(workload, bucket);
	}
	for (const row of rows) {
		const parsed = splitSummaryKey(row.key);
		if (parsed.renderer !== 'zeus') continue;
		const { workload } = parsed;
		const zeusChange = row.metrics?.scrollP95Ms?.changePercent;
		if (!Number.isFinite(zeusChange)) continue;
		const controls = byWorkload.get(workload) ?? [];
		for (const control of controls) {
			// The controls do not load the Zeus bundle, so any movement at all is
			// run-level drift. Report it whenever it is large enough to matter
			// next to the Zeus delta being claimed.
			if (Math.abs(control.change) >= CONTROL_DRIFT_REPORT_PERCENT) {
				caveats.push(
					`${workload}: control renderer ${control.renderer} scrollP95Ms moved ${control.change}% while Zeus moved ${zeusChange}%. The control does not load the Zeus bundle, so this is run-level host or runner drift and it bounds how much of the Zeus delta can be attributed to the bundle change.`
				);
			}
		}
	}
	return caveats;
}

/** Splits `workload/renderer` or the interleaved `workload/renderer@variant`. */
function splitSummaryKey(key) {
	const slash = key.lastIndexOf('/');
	const workload = key.slice(0, slash);
	const tail = key.slice(slash + 1);
	const at = tail.lastIndexOf('@');
	return {
		workload,
		renderer: at === -1 ? tail : tail.slice(0, at),
		variant: at === -1 ? null : tail.slice(at + 1)
	};
}

function median(values) {
	const sorted = values.filter(value => Number.isFinite(value)).sort((left, right) => left - right);
	if (sorted.length === 0) return null;
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function summaryKey(record) {
	// An interleaved run measures one workload/renderer per bundle variant, so the
	// summary key carries the variant. Without it the two variants would collapse
	// into one bucket and the comparison would compare a variant against itself.
	const base = `${record.workloadId}/${record.renderer}`;
	return record.zeusVariant ? `${base}@${record.zeusVariant}` : base;
}

function segmentMedian(record, select) {
	const segments = record.segmentTrace?.segments ?? [];
	return median(
		segments
			.filter(segment => Number.isFinite(segment.commitEndTime) && Number.isFinite(segment.commitStartTime))
			.map(select)
	);
}

/**
 * Derives the record-level metrics the summary does not carry. The summary is
 * computed from `record.scroll`, but the Zeus commit cost and the raf-to-task
 * gap only live in the segment trace, so a summary-only comparison cannot see
 * the cost this investigation is about.
 */
function collectRecordMetrics(records) {
	const groups = new Map();
	for (const record of records ?? []) {
		if (record.status !== 'ok') continue;
		const key = summaryKey(record);
		const bucket = groups.get(key) ?? { rafToTask: [], commit: [], textWrites: [] };
		const rafToTask = segmentMedian(record, segment => segment.nextPaintTaskTime - segment.nextPaintRafTime);
		if (rafToTask !== null) bucket.rafToTask.push(rafToTask);
		const commit = segmentMedian(record, segment => segment.commitEndTime - segment.commitStartTime);
		if (commit !== null) bucket.commit.push(commit);
		if (Number.isFinite(record.textChurn?.textWrites)) bucket.textWrites.push(record.textChurn.textWrites);
		groups.set(key, bucket);
	}
	const result = new Map();
	for (const [key, bucket] of groups) {
		result.set(key, {
			scrollMedianMs: median(
				(records ?? [])
					.filter(record => record.status === 'ok' && summaryKey(record) === key)
					.map(record => record.scroll?.medianMs)
			),
			rafToTaskMs: median(bucket.rafToTask),
			commitMs: median(bucket.commit),
			textWrites: median(bucket.textWrites)
		});
	}
	return result;
}

function round(value, digits = 2) {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

function renderText(report) {
	const lines = [];
	lines.push(`baseline : ${report.baseline.path} (run ${report.baseline.workflowRunId})`);
	lines.push(`candidate: ${report.candidate.path} (run ${report.candidate.workflowRunId})`);
	lines.push(`scored=${report.scored} sameBundle=${report.sameBundle}`);
	if (report.identityMismatches.length > 0) {
		lines.push(`identity mismatches: ${report.identityMismatches.join('; ')}`);
	}
	lines.push('');
	for (const row of report.rows) {
		const metrics = Object.entries(row.metrics ?? {})
			.map(
				([metric, value]) =>
					`${metric} ${value.baselineMedian}->${value.candidateMedian} (${value.changePercent ?? 'n/a'}%)`
			)
			.join('  ');
		lines.push(`${row.key}: ${metrics || '(no comparable metric)'}${row.reason ? ` [${row.reason}]` : ''}`);
	}
	if (report.caveats.length > 0) {
		lines.push('');
		lines.push('caveats:');
		for (const caveat of report.caveats) lines.push(`- ${caveat}`);
	}
	lines.push('');
	lines.push('This report is a mechanical diff only. It does not assert a performance improvement.');
	return lines.join('\n');
}
