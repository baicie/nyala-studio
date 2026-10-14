import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

function evidence(overrides = {}) {
	return {
		measurementContractVersion: 7,
		scrollCommitBoundary: 'post-presentation-opportunity',
		executionOrder: 'renderer-balanced-rotation-v1',
		platformName: 'macos',
		admissionGrade: true,
		limitations: [],
		provenance: { workflowRunId: 1, zeusBundleSha256: 'aaa' },
		summary: {
			'10k-x-50/zeus': { count: 3, scrollP95Ms: { median: 40, available: true } }
		},
		...overrides
	};
}

async function run(root, baseline, candidate) {
	const baselinePath = join(root, 'baseline.json');
	const candidatePath = join(root, 'candidate.json');
	await writeFile(baselinePath, JSON.stringify(baseline), 'utf8');
	await writeFile(candidatePath, JSON.stringify(candidate), 'utf8');
	const { stdout } = await execFileAsync(process.execPath, [
		'scripts/compare-sql-result-grid-platform-evidence.mjs',
		'--baseline',
		baselinePath,
		'--candidate',
		candidatePath,
		'--json'
	]);
	return JSON.parse(stdout);
}

test('reports scored deltas when identity matches and bundles differ', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-compare-evidence-'));
	try {
		const report = await run(
			root,
			evidence(),
			evidence({
				provenance: { workflowRunId: 2, zeusBundleSha256: 'bbb' },
				summary: { '10k-x-50/zeus': { count: 3, scrollP95Ms: { median: 30, available: true } } }
			})
		);
		assert.equal(report.scored, true);
		assert.equal(report.sameBundle, false);
		assert.deepEqual(report.identityMismatches, []);
		const row = report.rows.find(entry => entry.key === '10k-x-50/zeus');
		assert.equal(row.comparable, true);
		assert.equal(row.metrics.scrollP95Ms.deltaMs, -10);
		assert.equal(row.metrics.scrollP95Ms.changePercent, -25);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('an interleaved run keeps each variant in its own summary bucket', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-compare-interleaved-'));
	try {
		const interleaved = {
			measurementContractVersion: 7,
			scrollCommitBoundary: 'post-presentation-opportunity',
			executionOrder: 'renderer-balanced-rotation-interleaved-variants-v1',
			platformName: 'macos',
			admissionGrade: false,
			limitations: ['paired variant evidence'],
			provenance: {
				workflowRunId: 3,
				zeusBundleSha256: 'pinned',
				interleavedVariants: [
					{ id: 'pinned', bundleSha256: 'pinned' },
					{ id: 'beta-31', bundleSha256: 'bbb' }
				]
			},
			summary: {
				'10k-x-50/zeus@pinned': { count: 3, scrollP95Ms: { median: 49, available: true } },
				'10k-x-50/zeus@beta-31': { count: 3, scrollP95Ms: { median: 19, available: true } },
				'10k-x-50/native': { count: 3, scrollP95Ms: { median: 25, available: true } }
			},
			records: []
		};
		const report = await run(root, interleaved, { ...interleaved });
		const keys = report.rows.map(entry => entry.key).sort();
		assert.deepEqual(keys, ['10k-x-50/native', '10k-x-50/zeus@beta-31', '10k-x-50/zeus@pinned']);
		// The two variants must stay separate rows rather than collapsing into one
		// workload/renderer bucket, otherwise the comparison scores a variant
		// against itself.
		const pinned = report.rows.find(entry => entry.key === '10k-x-50/zeus@pinned');
		const beta = report.rows.find(entry => entry.key === '10k-x-50/zeus@beta-31');
		assert.equal(pinned.metrics.scrollP95Ms.deltaMs, 0);
		assert.equal(beta.metrics.scrollP95Ms.deltaMs, 0);
		// An interleaved run is paired evidence, so it must not be reported as
		// admission-scored.
		assert.equal(report.scored, false);
		assert.ok(
			report.caveats.some(caveat => caveat.includes('admissionGrade=false')),
			'the paired run must carry its diagnostic-only caveat'
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('refuses to score when the zeus bundle is identical', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-compare-evidence-'));
	try {
		const report = await run(
			root,
			evidence(),
			evidence({ summary: { '10k-x-50/zeus': { count: 3, scrollP95Ms: { median: 10, available: true } } } })
		);
		assert.equal(report.scored, false);
		assert.equal(report.sameBundle, true);
		assert.ok(report.caveats.some(caveat => caveat.includes('measurement noise')));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('marks rows incomparable when measurement identity differs', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-compare-evidence-'));
	try {
		const report = await run(root, evidence(), evidence({ platformName: 'windows' }));
		assert.equal(report.scored, false);
		assert.ok(report.identityMismatches.some(entry => entry.startsWith('platformName')));
		assert.equal(
			report.rows.every(row => row.comparable === false),
			true
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('surfaces admission-grade and limitation caveats verbatim', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-compare-evidence-'));
	try {
		const report = await run(
			root,
			evidence({ admissionGrade: false, limitations: ['instrumented baseline'] }),
			evidence({ provenance: { workflowRunId: 2, zeusBundleSha256: 'bbb' } })
		);
		assert.ok(report.caveats.some(caveat => caveat.includes('diagnostic only')));
		assert.ok(report.caveats.some(caveat => caveat.includes('instrumented baseline')));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

function record(overrides = {}) {
	return {
		status: 'ok',
		workloadId: '10k-x-50',
		renderer: 'zeus',
		workload: { rows: 10_000, columns: 50, wide: false },
		scroll: { medianMs: 30, samples: [] },
		textChurn: { textWrites: 6422, addedNodes: 0, removedNodes: 0, mutations: 6422 },
		segmentTrace: {
			segments: [
				{ commitStartTime: 10, commitEndTime: 12, nextPaintRafTime: 100, nextPaintTaskTime: 118 },
				{ commitStartTime: 20, commitEndTime: 22, nextPaintRafTime: 200, nextPaintTaskTime: 216 }
			]
		},
		...overrides
	};
}

test('derives raf-to-task and commit medians that the summary does not carry', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-compare-evidence-'));
	try {
		const report = await run(
			root,
			evidence({ records: [record()] }),
			evidence({
				provenance: { workflowRunId: 2, zeusBundleSha256: 'bbb' },
				records: [
					record({
						segmentTrace: {
							segments: [{ commitStartTime: 10, commitEndTime: 11, nextPaintRafTime: 100, nextPaintTaskTime: 110 }]
						}
					})
				]
			})
		);
		const row = report.rows.find(entry => entry.key === '10k-x-50/zeus');
		assert.equal(row.metrics.rafToTaskMs.baselineMedian, 17);
		assert.equal(row.metrics.rafToTaskMs.candidateMedian, 10);
		assert.equal(row.metrics.commitMs.baselineMedian, 2);
		assert.equal(row.metrics.commitMs.candidateMedian, 1);
		assert.equal(row.metrics.scrollMedianMs.baselineMedian, 30);
		assert.equal(row.metrics.textWrites.baselineMedian, 6422);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('ignores records that did not complete', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-compare-evidence-'));
	try {
		const report = await run(
			root,
			evidence({ records: [record(), record({ status: 'failed', scroll: { medianMs: 999 } })] }),
			evidence({ provenance: { workflowRunId: 2, zeusBundleSha256: 'bbb' }, records: [record()] })
		);
		const row = report.rows.find(entry => entry.key === '10k-x-50/zeus');
		assert.equal(row.metrics.scrollMedianMs.baselineMedian, 30);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('flags control-renderer movement as run drift', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-compare-evidence-'));
	try {
		function withSummary(extra) {
			return evidence({
				summary: {
					'10k-x-50/zeus': { count: 5, scrollP95Ms: { median: extra.zeus, available: true } },
					'10k-x-50/native': { count: 5, scrollP95Ms: { median: extra.native, available: true } }
				}
			});
		}
		const report = await run(
			root,
			withSummary({ zeus: 50, native: 50 }),
			evidence({
				provenance: { workflowRunId: 2, zeusBundleSha256: 'bbb' },
				summary: {
					'10k-x-50/zeus': { count: 5, scrollP95Ms: { median: 20, available: true } },
					'10k-x-50/native': { count: 5, scrollP95Ms: { median: 25, available: true } }
				}
			})
		);
		assert.ok(
			report.caveats.some(
				caveat => caveat.includes('control renderer native') && caveat.includes('run-level host or runner drift')
			)
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('stays quiet when control renderers hold still', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-compare-evidence-'));
	try {
		const report = await run(
			root,
			evidence({
				summary: {
					'10k-x-50/zeus': { count: 5, scrollP95Ms: { median: 50, available: true } },
					'10k-x-50/native': { count: 5, scrollP95Ms: { median: 50, available: true } }
				}
			}),
			evidence({
				provenance: { workflowRunId: 2, zeusBundleSha256: 'bbb' },
				summary: {
					'10k-x-50/zeus': { count: 5, scrollP95Ms: { median: 20, available: true } },
					'10k-x-50/native': { count: 5, scrollP95Ms: { median: 50, available: true } }
				}
			})
		);
		assert.equal(
			report.caveats.some(caveat => caveat.includes('control renderer')),
			false
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
