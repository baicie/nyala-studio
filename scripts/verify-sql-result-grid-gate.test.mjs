import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deflateSync, gzipSync } from 'node:zlib';
import test from 'node:test';
import { hasVisiblePngDiversity, inspectPngPixels } from './sql-result-grid-visual-png.mjs';
import {
	createSqlResultGridRunMarkerBytes,
	inspectSqlResultGridRunMarker,
	SQL_RESULT_GRID_RUN_MARKER_LAYOUT,
	SQL_RESULT_GRID_RUN_MARKER_VERSION
} from './sql-result-grid-run-marker.mjs';
import {
	createBalancedBenchmarkPlan,
	EXECUTION_ORDER,
	expectedScrollViewportHeight,
	expectedVisibleRowIndex,
	maximumScrollOffset,
	MEASUREMENT_CONTRACT_VERSION,
	SCROLL_COMMIT_BOUNDARY,
	SCROLL_TARGET_RATIOS,
	scrollTargetOffset
} from './sql-result-grid-benchmark-contract.mjs';

const execFileAsync = promisify(execFile);

const verifierPath = new URL('./verify-sql-result-grid-gate.mjs', import.meta.url).pathname;
const sourceRevision = 'a'.repeat(40);
const sourceRef = 'refs/heads/mvp';
const repository = 'baicie/nyala-studio';
const workflowRunId = '123456789';
const zeusBundle = Buffer.from('customElements.define("zw-data-grid", class extends HTMLElement {});\n');
const zeusBundleSha256 = createHash('sha256').update(zeusBundle).digest('hex');
const expectedProvenanceEnv = {
	NYALA_EXPECTED_REPOSITORY: repository,
	NYALA_EXPECTED_SOURCE_REVISION: sourceRevision,
	NYALA_EXPECTED_SOURCE_REF: sourceRef,
	NYALA_EXPECTED_WORKFLOW_RUN_ID: workflowRunId,
	NYALA_EXPECTED_WORKFLOW_RUN_ATTEMPT: '1'
};
const workloads = [
	{ id: '1k-x-20', rows: 1_000, columns: 20, width: 1_440, height: 420, wide: false },
	{ id: '10k-x-50', rows: 10_000, columns: 50, width: 1_440, height: 420, wide: false },
	{ id: 'wide-columns', rows: 1_000, columns: 20, width: 1_440, height: 420, wide: true },
	{ id: 'narrow-panel', rows: 1_000, columns: 20, width: 390, height: 420, wide: false }
];
const renderers = ['native', 'workbench-table', 'zeus'];

function createSyntheticBenchmark() {
	const records = createBalancedBenchmarkPlan(workloads, renderers, 3).map(
		({ workload, renderer, iteration, executionOrdinal }) =>
			createPlatformRecord('chromium', workload, renderer, iteration, executionOrdinal)
	);
	return {
		version: 1,
		measurementContractVersion: MEASUREMENT_CONTRACT_VERSION,
		scrollCommitBoundary: SCROLL_COMMIT_BOUNDARY,
		executionOrder: EXECUTION_ORDER,
		browser: '/private/tmp/nyala-secret/synthetic-gate-fixture',
		repeat: 3,
		provenance: {
			repository,
			sourceRevision,
			sourceTreeClean: true,
			sourceRef,
			workflowRunId,
			workflowRunAttempt: 1,
			zeusBundleSha256
		},
		summary: summarize(records),
		records
	};
}

async function createEmbeddedPlatformEvidence(root) {
	const provenance = {
		repository,
		sourceRevision,
		sourceRef,
		workflowRunId,
		workflowRunAttempt: 1,
		binarySha256: 'b'.repeat(64),
		zeusBundleSha256
	};
	return {
		version: 1,
		macosWebKit: await createPlatformEvidence(root, {
			platformName: 'macos',
			engine: 'wkwebview-embedded',
			browser: 'webkit',
			nativeWebView2: false,
			provenance
		}),
		windowsWebView2: await createPlatformEvidence(root, {
			platformName: 'windows',
			engine: 'webview2-embedded',
			browser: 'msedge',
			nativeWebView2: true,
			provenance: { ...provenance, binarySha256: 'c'.repeat(64) }
		})
	};
}

async function createPlatformEvidence(root, identity) {
	const screenshotDirectory = join(root, 'screenshots');
	await mkdir(screenshotDirectory, { recursive: true });
	const records = [];
	const screenshots = [];

	for (const { workload, renderer, iteration, executionOrdinal } of createBalancedBenchmarkPlan(
		workloads,
		renderers,
		5
	)) {
		const record = createPlatformRecord(identity.platformName, workload, renderer, iteration, executionOrdinal);
		if (iteration === 1) {
			const screenshotBytes = createColorfulRgbPng(
				workload.width,
				workload.height,
				renderers.indexOf(renderer),
				record.runToken
			);
			const screenshotSha256 = createHash('sha256').update(screenshotBytes).digest('hex');
			const screenshotPixels = inspectPngPixels(screenshotBytes);
			const runMarker = inspectSqlResultGridRunMarker(screenshotBytes, record.runToken, record.browserViewport);
			assert.equal(screenshotPixels.width, workload.width);
			assert.equal(screenshotPixels.height, workload.height);
			assert.equal(hasVisiblePngDiversity(screenshotPixels), true);
			assert.equal(runMarker.passed, true);
			const screenshot = `${identity.platformName}-${workload.id}-${renderer}.png`;
			await writeFile(join(screenshotDirectory, screenshot), screenshotBytes);
			screenshots.push({
				file: screenshot,
				workloadId: workload.id,
				renderer,
				iteration,
				runToken: record.runToken,
				viewport: record.browserViewport,
				bytes: screenshotBytes.byteLength,
				sha256: screenshotSha256,
				runMarkerVersion: SQL_RESULT_GRID_RUN_MARKER_VERSION
			});
			record.screenshot = screenshot;
			record.screenshotProbe = {
				passed: true,
				reason: 'screenshot pixels are visible and nonblank',
				bytes: screenshotBytes.byteLength,
				sha256: screenshotSha256,
				runToken: record.runToken,
				runMarkerVersion: SQL_RESULT_GRID_RUN_MARKER_VERSION,
				viewport: record.browserViewport,
				...screenshotPixels
			};
		}
		records.push(record);
	}

	return {
		version: 2,
		measurementContractVersion: MEASUREMENT_CONTRACT_VERSION,
		scrollCommitBoundary: SCROLL_COMMIT_BOUNDARY,
		executionOrder: EXECUTION_ORDER,
		generatedAt: '2026-08-16T00:00:00.000Z',
		status: 'ready',
		runs: 5,
		driverProvider: 'embedded',
		nativeWebView: true,
		nativeWebView2: identity.nativeWebView2,
		engine: identity.engine,
		browser: identity.browser,
		platformName: identity.platformName,
		provenance: identity.provenance,
		reason: `recorded in the Nyala ${identity.engine} host`,
		summary: summarize(records),
		records,
		screenshots
	};
}

function createPlatformRecord(platformName, workload, renderer, iteration, executionOrdinal) {
	const scrollP95Ms = platformScrollP95(workload.id, renderer) + (iteration - 3) * 0.01;
	const renderedRows = renderer === 'native' ? workload.rows : 24;
	const record = {
		status: 'ok',
		runToken: fixtureRunToken(platformName, workload.id, renderer, iteration),
		renderer,
		measurementContractVersion: MEASUREMENT_CONTRACT_VERSION,
		scrollCommitBoundary: SCROLL_COMMIT_BOUNDARY,
		executionOrder: EXECUTION_ORDER,
		executionOrdinal,
		workload: {
			rows: workload.rows,
			columns: workload.columns,
			wide: workload.wide,
			viewportWidth: workload.width,
			viewportHeight: workload.height
		},
		browserViewport: {
			width: workload.width,
			height: workload.height,
			devicePixelRatio: 1
		},
		userAgent: `Nyala ${platformName} native fixture`,
		formatMs: 1 + iteration / 100,
		parseMs: 2 + iteration / 100,
		renderMs: 5 + iteration / 10,
		scroll: createScrollMeasurement(workload, scrollP95Ms),
		domNodes: renderer === 'native' ? workload.rows * workload.columns + 35 : 381,
		fixtureBytes: workload.rows * workload.columns * 12,
		heapBytes: 1_000_000 + iteration,
		renderedRows,
		visualProbe: {
			rootWidth: workload.width,
			rootHeight: workload.height,
			headerText: 'column_0',
			firstVisibleCellText: '0',
			firstCellInViewport: true,
			virtualRowsBounded: true,
			visibleTextLength: 100
		},
		workloadId: workload.id,
		iteration
	};
	if (platformName !== 'chromium') {
		record.viewportCalibration = {
			requestedCssViewport: { width: workload.width, height: workload.height },
			initialWindowRect: { width: workload.width, height: workload.height },
			lastAppliedRequestedWindowRect: { width: workload.width, height: workload.height },
			appliedWindowRect: { width: workload.width, height: workload.height },
			observedCssViewport: { width: workload.width, height: workload.height },
			viewportConverged: true,
			viewportTolerance: 1,
			convergenceStoppedReason: 'target-reached',
			calibrationAttempts: [
				{
					attempt: 1,
					requestedWindowRect: { width: workload.width, height: workload.height },
					appliedWindowRect: { width: workload.width, height: workload.height },
					observedCssViewport: { width: workload.width, height: workload.height }
				}
			]
		};
	}
	return record;
}

function fixtureRunToken(platformName, workloadId, renderer, iteration) {
	const digest = createHash('sha256').update(`${platformName}/${workloadId}/${renderer}/${iteration}`).digest('hex');
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function createScrollMeasurement(workload, scrollP95Ms) {
	const scrollViewportHeight = expectedScrollViewportHeight(workload);
	const maxOffset = maximumScrollOffset(workload.rows, scrollViewportHeight);
	const samples = SCROLL_TARGET_RATIOS.map((_ratio, sampleIndex) => {
		const targetOffset = scrollTargetOffset(maxOffset, sampleIndex);
		const startOffset = sampleIndex === 0 ? maxOffset : scrollTargetOffset(maxOffset, sampleIndex - 1);
		const expectedRowIndex = expectedVisibleRowIndex(targetOffset, workload.rows);
		const totalMs = Number(
			(sampleIndex === SCROLL_TARGET_RATIOS.length - 1
				? scrollP95Ms + 0.25
				: scrollP95Ms - (SCROLL_TARGET_RATIOS.length - 2 - sampleIndex) * 0.1
			).toFixed(4)
		);
		const inputMs = Number((totalMs / 4).toFixed(4));
		return {
			sampleIndex,
			startOffset,
			targetOffset,
			actualOffset: targetOffset,
			scrollViewportHeight,
			expectedRowIndex,
			visibleRowIndex: expectedRowIndex,
			rowDelta: 0,
			attempts: 1,
			presentationOpportunities: 1,
			inputMs,
			settleMs: Number((totalMs - inputMs).toFixed(4)),
			totalMs,
			committed: true
		};
	});
	const total = summarizeMetric(samples.map(sample => sample.totalMs));
	const input = summarizeMetric(samples.map(sample => sample.inputMs));
	const settle = summarizeMetric(samples.map(sample => sample.settleMs));
	return {
		maximumOffset: maxOffset,
		scrollViewportHeight,
		medianMs: total.median,
		p95Ms: total.p95,
		maxMs: total.max,
		inputMedianMs: input.median,
		inputP95Ms: input.p95,
		settleMedianMs: settle.median,
		settleP95Ms: settle.p95,
		samples
	};
}

function platformScrollP95(workloadId, renderer) {
	return {
		'1k-x-20': { native: 10, 'workbench-table': 12, zeus: 10.5 },
		'10k-x-50': { native: 10, 'workbench-table': 12, zeus: 7 },
		'wide-columns': { native: 8, 'workbench-table': 9, zeus: 7 },
		'narrow-panel': { native: 8, 'workbench-table': 9, zeus: 7 }
	}[workloadId][renderer];
}

function summarize(records) {
	const groups = new Map();
	for (const record of records) {
		const key = `${record.workloadId}/${record.renderer}`;
		const group = groups.get(key) ?? [];
		group.push(record);
		groups.set(key, group);
	}
	return Object.fromEntries(
		[...groups.entries()].map(([key, group]) => [
			key,
			{
				count: group.length,
				renderMs: summarizeMetric(group.map(record => record.renderMs)),
				scrollP95Ms: summarizeMetric(group.map(record => record.scroll.p95Ms)),
				scrollMaxMs: summarizeMetric(group.map(record => record.scroll.maxMs)),
				domNodes: summarizeMetric(group.map(record => record.domNodes)),
				heapBytes: summarizeMetric(group.map(record => record.heapBytes)),
				formatMs: summarizeMetric(group.map(record => record.formatMs)),
				parseMs: summarizeMetric(group.map(record => record.parseMs)),
				fixtureBytes: group[0].fixtureBytes
			}
		])
	);
}

function summarizeMetric(values) {
	const sorted = [...values].sort((left, right) => left - right);
	return {
		available: true,
		median: sorted[Math.floor(sorted.length / 2)],
		p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
		min: sorted[0],
		max: sorted.at(-1)
	};
}

function createColorfulRgbPng(width, height, phase = 0, runToken, options = {}) {
	const devicePixelRatio = options.devicePixelRatio ?? 1;
	const physicalWidth = Math.round(width * devicePixelRatio);
	const physicalHeight = Math.round(height * devicePixelRatio);
	const channels = options.colorType === 'rgba' ? 4 : 3;
	const colors = [
		[16, 24, 32],
		[48, 132, 196],
		[214, 218, 224],
		[196, 48, 72]
	];
	const rows = [];
	for (let rowIndex = 0; rowIndex < physicalHeight; rowIndex += 1) {
		const row = Buffer.alloc(physicalWidth * channels + 1);
		for (let columnIndex = 0; columnIndex < physicalWidth; columnIndex += 1) {
			const color =
				options.solidColor ??
				colors[(Math.floor(columnIndex / 24) + Math.floor(rowIndex / 24) + phase) % colors.length];
			const offset = columnIndex * channels + 1;
			row[offset] = color[0];
			row[offset + 1] = color[1];
			row[offset + 2] = color[2];
			if (channels === 4) row[offset + 3] = 255;
		}
		rows.push(row);
	}
	if (runToken) {
		paintRunMarker(rows, physicalWidth, physicalHeight, channels, runToken, devicePixelRatio, options.markerBitFlip);
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(physicalWidth, 0);
	header.writeUInt32BE(physicalHeight, 4);
	header[8] = 8;
	header[9] = channels === 4 ? 6 : 2;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', header),
		pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
		pngChunk('IEND', Buffer.alloc(0))
	]);
}

function paintRunMarker(rows, width, height, channels, runToken, devicePixelRatio, markerBitFlip) {
	const markerBytes = createSqlResultGridRunMarkerBytes(runToken);
	const bitCount = SQL_RESULT_GRID_RUN_MARKER_LAYOUT.columns * SQL_RESULT_GRID_RUN_MARKER_LAYOUT.rows;
	assert.equal(markerBytes.byteLength * 8, bitCount);
	const startY =
		height -
		Math.round(SQL_RESULT_GRID_RUN_MARKER_LAYOUT.bottom * devicePixelRatio) -
		Math.round(
			SQL_RESULT_GRID_RUN_MARKER_LAYOUT.totalRows * SQL_RESULT_GRID_RUN_MARKER_LAYOUT.cellSize * devicePixelRatio
		);
	const startX = Math.round(SQL_RESULT_GRID_RUN_MARKER_LAYOUT.left * devicePixelRatio);
	for (let row = 0; row < SQL_RESULT_GRID_RUN_MARKER_LAYOUT.totalRows; row += 1) {
		for (let column = 0; column < SQL_RESULT_GRID_RUN_MARKER_LAYOUT.totalColumns; column += 1) {
			const frame =
				column === 0 ||
				row === 0 ||
				column === SQL_RESULT_GRID_RUN_MARKER_LAYOUT.totalColumns - 1 ||
				row === SQL_RESULT_GRID_RUN_MARKER_LAYOUT.totalRows - 1;
			const bitIndex =
				(row - SQL_RESULT_GRID_RUN_MARKER_LAYOUT.frame) * SQL_RESULT_GRID_RUN_MARKER_LAYOUT.columns +
				column -
				SQL_RESULT_GRID_RUN_MARKER_LAYOUT.frame;
			let bit = frame ? (column + row) % 2 : (markerBytes[Math.floor(bitIndex / 8)] >> (7 - (bitIndex % 8))) & 1;
			if (!frame && bitIndex === markerBitFlip) bit = bit === 1 ? 0 : 1;
			const color = bit === 1 ? 255 : 0;
			const cellStartX = startX + Math.round(column * SQL_RESULT_GRID_RUN_MARKER_LAYOUT.cellSize * devicePixelRatio);
			const cellEndX =
				startX + Math.round((column + 1) * SQL_RESULT_GRID_RUN_MARKER_LAYOUT.cellSize * devicePixelRatio);
			const cellStartY = startY + Math.round(row * SQL_RESULT_GRID_RUN_MARKER_LAYOUT.cellSize * devicePixelRatio);
			const cellEndY = startY + Math.round((row + 1) * SQL_RESULT_GRID_RUN_MARKER_LAYOUT.cellSize * devicePixelRatio);
			for (let y = cellStartY; y < cellEndY && y < height; y += 1) {
				for (let x = cellStartX; x < cellEndX && x < width; x += 1) {
					const offset = x * channels + 1;
					rows[y][offset] = color;
					rows[y][offset + 1] = color;
					rows[y][offset + 2] = color;
					if (channels === 4) rows[y][offset + 3] = 255;
				}
			}
		}
	}
}

function pngChunk(type, data) {
	const typeBytes = Buffer.from(type, 'ascii');
	const chunk = Buffer.alloc(data.byteLength + 12);
	chunk.writeUInt32BE(data.byteLength, 0);
	typeBytes.copy(chunk, 4);
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.byteLength + 8);
	return chunk;
}

function crc32(bytes) {
	let checksum = 0xffffffff;
	for (const byte of bytes) {
		checksum ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
		}
	}
	return (checksum ^ 0xffffffff) >>> 0;
}

async function writeSyntheticBenchmark(root) {
	const benchmarkPath = join(root, 'benchmark.json');
	const bundlePath = join(root, 'data-grid-bundle.js');
	const auditPath = join(root, 'zeus-audit.json');
	await writeFile(benchmarkPath, `${JSON.stringify(createSyntheticBenchmark())}\n`, 'utf8');
	await writeFile(bundlePath, zeusBundle);
	await writeFile(
		auditPath,
		`${JSON.stringify({
			version: 1,
			status: 'ready',
			provenance: {
				repository,
				sourceRevision,
				sourceRef,
				workflowRunId,
				workflowRunAttempt: 1
			},
			package: {
				name: '@zeus-web/data-grid',
				version: '0.1.0-beta.2',
				license: 'MIT',
				integrity: 'sha512-Tmw5sldixp52arDoGJC8HbeUJvSw6Yr9mRgMBT08zvZiFhLa0n2Ifnf7IrU1IgoAT/uZqfPsyeo8cdFS5cNGNw==',
				unpackedSize: 279_075,
				dependencies: {
					'@zeus-js/output-react-wrapper': '0.1.0-beta.8',
					'@zeus-js/output-vue-wrapper': '0.1.0-beta.8',
					'@zeus-js/runtime-dom': '0.1.0-beta.8',
					'@zeus-js/web-c-runtime': '0.1.0-beta.8',
					'@zeus-web/virtual': '0.1.0-beta.2',
					'@zeus-web/zeus-compat': '0.1.0-beta.2'
				},
				peerDependencies: {
					'@zeus-js/zeus': '0.1.0-beta.8',
					react: '>=18 || >=19',
					vue: '>=3'
				}
			},
			bundle: {
				file: 'data-grid-bundle.js',
				bytes: zeusBundle.byteLength,
				gzipBytes: gzipSync(zeusBundle, { level: 9 }).byteLength,
				sha256: zeusBundleSha256
			},
			checks: [{ id: 'fixture', passed: true, reason: 'fixture is valid' }],
			reasons: []
		})}\n`,
		'utf8'
	);
	return benchmarkPath;
}

function gateEnv(root, evidencePath) {
	return {
		...process.env,
		...expectedProvenanceEnv,
		NYALA_PLATFORM_EVIDENCE: evidencePath,
		NYALA_ZEUS_AUDIT_EVIDENCE: join(root, 'zeus-audit.json')
	};
}

async function withTempRoot(prefix, run) {
	const tempRoot = await mkdtemp(join(tmpdir(), prefix));
	try {
		return await run(tempRoot);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}

async function assertPlatformEvidenceRejected(prefix, mutate, reasonPattern) {
	return withTempRoot(prefix, async tempRoot => {
		const evidencePath = join(tempRoot, 'platform-evidence.json');
		const outputPath = join(tempRoot, 'gate.json');
		const benchmarkPath = await writeSyntheticBenchmark(tempRoot);
		const benchmark = JSON.parse(await readFile(benchmarkPath, 'utf8'));
		const evidence = await createEmbeddedPlatformEvidence(tempRoot);
		await mutate(evidence, tempRoot, benchmark);
		await writeFile(benchmarkPath, `${JSON.stringify(benchmark)}\n`, 'utf8');
		await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, 'utf8');
		await assert.rejects(
			execFileAsync(process.execPath, [verifierPath, benchmarkPath, outputPath], {
				env: gateEnv(tempRoot, evidencePath),
				cwd: new URL('..', import.meta.url).pathname
			})
		);
		const report = JSON.parse(await readFile(outputPath, 'utf8'));
		assert.equal(report.decision, 'NO-GO');
		assert.match(report.reasons.join('\n'), reasonPattern);
	});
}

async function assertBenchmarkRejected(prefix, mutate, reasonPattern) {
	return withTempRoot(prefix, async tempRoot => {
		const evidencePath = join(tempRoot, 'platform-evidence.json');
		const outputPath = join(tempRoot, 'gate.json');
		const benchmarkPath = await writeSyntheticBenchmark(tempRoot);
		const benchmark = JSON.parse(await readFile(benchmarkPath, 'utf8'));
		await mutate(benchmark);
		await writeFile(benchmarkPath, `${JSON.stringify(benchmark)}\n`, 'utf8');
		const evidence = await createEmbeddedPlatformEvidence(tempRoot);
		await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, 'utf8');
		await assert.rejects(
			execFileAsync(process.execPath, [verifierPath, benchmarkPath, outputPath], {
				env: gateEnv(tempRoot, evidencePath),
				cwd: new URL('..', import.meta.url).pathname
			})
		);
		const report = JSON.parse(await readFile(outputPath, 'utf8'));
		assert.equal(report.decision, 'NO-GO');
		assert.match(report.reasons.join('\n'), reasonPattern);
	});
}

test('Z1.3 gate verifier records the pre-registered primary metric and platform probes', async () => {
	const source = await readFile(new URL('./verify-sql-result-grid-gate.mjs', import.meta.url), 'utf8');
	assert.match(source, /scrollP95Ms/);
	assert.match(source, /oneKInteractionRegressionMax/);
	assert.match(source, /tenKPrimaryImprovementMin/);
	assert.match(source, /macosWebKit/);
	assert.match(source, /windowsWebView2/);
	assert.match(source, /NO-GO/);
});

test('screenshot run marker decodes across fractional DPR and rejects token or CRC changes', () => {
	const runToken = fixtureRunToken('marker', 'narrow-panel', 'native', 1);
	const otherRunToken = fixtureRunToken('marker', 'narrow-panel', 'native', 2);
	for (const [index, devicePixelRatio] of [1, 1.25, 1.5, 2].entries()) {
		const viewport = { width: 390, height: 420, devicePixelRatio };
		const bytes = createColorfulRgbPng(390, 420, index, runToken, {
			devicePixelRatio,
			colorType: index % 2 === 0 ? 'rgb' : 'rgba'
		});
		assert.equal(inspectSqlResultGridRunMarker(bytes, runToken, viewport).passed, true);
		assert.equal(inspectSqlResultGridRunMarker(bytes, otherRunToken, viewport).passed, false);
	}
	const corrupted = createColorfulRgbPng(390, 420, 0, runToken, { markerBitFlip: 47 });
	assert.match(inspectSqlResultGridRunMarker(corrupted, runToken, { width: 390, height: 420 }).reason, /CRC/i);
});

test('Z1.3 verifier does not add a production Zeus dependency', async () => {
	const source = await readFile(new URL('./verify-sql-result-grid-gate.mjs', import.meta.url), 'utf8');
	assert.doesNotMatch(source, /pnpm add|package\.json|pnpm-lock/);
});

test('Z1.3 fixture helper removes its temp root when mutation setup fails', async () => {
	let tempRoot;
	const setupError = new Error('synthetic fixture setup failure');
	await assert.rejects(
		assertPlatformEvidenceRejected(
			'nyala-z1-cleanup-test-',
			(_evidence, root) => {
				tempRoot = root;
				throw setupError;
			},
			/unreachable/
		),
		error => error === setupError
	);
	assert.ok(tempRoot);
	try {
		await assert.rejects(access(tempRoot), { code: 'ENOENT' });
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test('Z1.3 verifier accepts embedded WKWebView and WebView2 evidence', async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), 'nyala-z1-gate-test-'));
	try {
		const evidencePath = join(tempRoot, 'platform-evidence.json');
		const outputPath = join(tempRoot, 'gate.json');
		const benchmarkPath = await writeSyntheticBenchmark(tempRoot);
		const evidence = await createEmbeddedPlatformEvidence(tempRoot);
		await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, 'utf8');
		const { stdout } = await execFileAsync(process.execPath, [verifierPath, benchmarkPath, outputPath], {
			env: gateEnv(tempRoot, evidencePath),
			cwd: new URL('..', import.meta.url).pathname
		});
		assert.match(stdout, /GO:/);
		const report = JSON.parse(await readFile(outputPath, 'utf8'));
		assert.equal(report.decision, 'GO');
		assert.equal(report.sourceRevision, sourceRevision);
		assert.equal(report.benchmark.browser, 'synthetic-gate-fixture');
		assert.equal(report.platformEvidence.macosWebKit.runs, 5);
		assert.equal(report.platformEvidence.windowsWebView2.runs, 5);
		assert.equal(report.platformEvidence.macosWebKit.records.length, 60);
		assert.equal(report.platformEvidence.windowsWebView2.records.length, 60);
		assert.equal(
			new Set(
				report.platformEvidence.macosWebKit.records.map(
					record => `${record.workloadId}/${record.renderer}/${record.iteration}`
				)
			).size,
			60
		);
		assert.equal(report.platformEvidence.macosWebKit.screenshots.length, 12);
		assert.equal(report.platformEvidence.windowsWebView2.screenshots.length, 12);
		assert.equal(report.platformMetricChecks.length, 18);
		assert.ok(report.platformMetricChecks.every(check => check.passed));
		assert.match(report.platformMetricChecks[0].reason, /embedded WKWebView identity verified/);
		assert.match(report.platformMetricChecks[9].reason, /embedded WebView2 identity verified/);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test('Z1.3 verifier cannot issue GO without trusted expected workflow provenance', async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), 'nyala-z1-trusted-provenance-test-'));
	try {
		const evidencePath = join(tempRoot, 'platform-evidence.json');
		const outputPath = join(tempRoot, 'gate.json');
		const benchmarkPath = await writeSyntheticBenchmark(tempRoot);
		const evidence = await createEmbeddedPlatformEvidence(tempRoot);
		await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, 'utf8');
		const env = gateEnv(tempRoot, evidencePath);
		delete env.NYALA_EXPECTED_REPOSITORY;
		delete env.NYALA_EXPECTED_SOURCE_REF;
		delete env.NYALA_EXPECTED_WORKFLOW_RUN_ID;
		delete env.NYALA_EXPECTED_WORKFLOW_RUN_ATTEMPT;
		await assert.rejects(
			execFileAsync(process.execPath, [verifierPath, benchmarkPath, outputPath], {
				env,
				cwd: new URL('..', import.meta.url).pathname
			})
		);
		const report = JSON.parse(await readFile(outputPath, 'utf8'));
		assert.equal(report.decision, 'NO-GO');
		assert.match(report.reasons.join('\n'), /trusted expected workflow provenance.*missing/i);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test('Z1.3 verifier rejects a Chromium benchmark without measurement contract v6', async () => {
	await assertBenchmarkRejected(
		'nyala-z1-benchmark-measurement-contract-test-',
		benchmark => {
			delete benchmark.measurementContractVersion;
		},
		/Chromium benchmark.*measurement contract.*expected 6/i
	);
});

test('Z1.3 verifier rejects a Chromium benchmark without the v5 scroll commit boundary', async () => {
	await assertBenchmarkRejected(
		'nyala-z1-benchmark-scroll-boundary-test-',
		benchmark => {
			delete benchmark.scrollCommitBoundary;
		},
		/Chromium benchmark.*scroll commit boundary.*post-presentation-opportunity/i
	);
});

test('Z1.3 verifier rejects a Chromium benchmark without the balanced execution order', async () => {
	await assertBenchmarkRejected(
		'nyala-z1-benchmark-execution-order-test-',
		benchmark => {
			delete benchmark.executionOrder;
		},
		/Chromium benchmark.*execution order.*renderer-balanced-rotation-v1/i
	);
});

test('Z1.3 verifier rejects Chromium records outside the canonical balanced plan', async () => {
	await assertBenchmarkRejected(
		'nyala-z1-benchmark-execution-plan-test-',
		benchmark => {
			[benchmark.records[0], benchmark.records[1]] = [benchmark.records[1], benchmark.records[0]];
		},
		/Chromium benchmark.*execution (?:ordinal|plan|order)/i
	);
});

test('Z1.3 verifier rejects a forged Chromium summary that differs from raw records', async () => {
	await assertBenchmarkRejected(
		'nyala-z1-benchmark-summary-test-',
		benchmark => {
			benchmark.summary['1k-x-20/zeus'].scrollP95Ms.median = 0.1;
		},
		/Chromium benchmark.*summary/i
	);
});

test('Z1.3 verifier rejects a forged per-run p95 even when the Chromium summary matches it', async () => {
	await assertBenchmarkRejected(
		'nyala-z1-benchmark-scroll-p95-test-',
		benchmark => {
			const record = benchmark.records.find(
				candidate => candidate.workloadId === 'wide-columns' && candidate.renderer === 'native'
			);
			assert.ok(record);
			record.scroll.p95Ms = record.scroll.medianMs;
			benchmark.summary = summarize(benchmark.records);
		},
		/Chromium benchmark.*scroll.*samples/i
	);
});

test('Z1.3 verifier requires exactly 20 raw scroll samples per record', async () => {
	await assertBenchmarkRejected(
		'nyala-z1-benchmark-scroll-sample-count-test-',
		benchmark => {
			const record = benchmark.records.find(
				candidate => candidate.workloadId === 'wide-columns' && candidate.renderer === 'native'
			);
			assert.ok(record);
			record.scroll.samples.pop();
			const total = summarizeMetric(record.scroll.samples.map(sample => sample.totalMs));
			record.scroll.medianMs = total.median;
			record.scroll.p95Ms = total.p95;
			record.scroll.maxMs = total.max;
			benchmark.summary = summarize(benchmark.records);
		},
		/Chromium benchmark.*scroll samples.*expected exactly 20/i
	);
});

test('Z1.3 verifier rejects a forged scroll run whose samples never move', async () => {
	await assertBenchmarkRejected(
		'nyala-z1-benchmark-zero-scroll-test-',
		benchmark => {
			const record = benchmark.records.find(
				candidate => candidate.workloadId === '10k-x-50' && candidate.renderer === 'native'
			);
			assert.ok(record);
			for (const sample of record.scroll.samples) {
				sample.targetOffset = 0;
				sample.actualOffset = 0;
				sample.expectedRowIndex = 0;
				sample.visibleRowIndex = 0;
				sample.rowDelta = 0;
				sample.committed = true;
			}
			benchmark.summary = summarize(benchmark.records);
		},
		/Chromium benchmark.*scroll sample.*target sequence/i
	);
});

test('Z1.3 verifier derives the expected visible row instead of trusting producer fields', async () => {
	await assertBenchmarkRejected(
		'nyala-z1-benchmark-derived-row-test-',
		benchmark => {
			const sample = benchmark.records[0].scroll.samples[8];
			sample.expectedRowIndex = 0;
			sample.visibleRowIndex = 0;
			sample.rowDelta = 0;
		},
		/Chromium benchmark.*scroll sample 8 expected row/i
	);
});

test('Z1.3 verifier rejects a missing visible row forged as tolerance-aligned', async () => {
	await assertBenchmarkRejected(
		'nyala-z1-benchmark-missing-visible-row-test-',
		benchmark => {
			const sample = benchmark.records[0].scroll.samples[0];
			assert.equal(sample.expectedRowIndex, 0);
			sample.visibleRowIndex = -1;
			sample.rowDelta = 1;
			sample.committed = true;
		},
		/Chromium benchmark.*scroll sample 0 visible row is invalid/i
	);
});

test('Z1.3 verifier requires raw scroll timing components to recompute total time', async () => {
	await assertBenchmarkRejected(
		'nyala-z1-benchmark-scroll-timing-sum-test-',
		benchmark => {
			const record = benchmark.records[0];
			const sample = record.scroll.samples[4];
			sample.settleMs += 10;
			benchmark.summary = summarize(benchmark.records);
		},
		/Chromium benchmark.*scroll sample 4 timing components/i
	);
});

test('Z1.3 verifier requires scroll sample indexes in strict 0 through 19 sequence', async () => {
	await assertBenchmarkRejected(
		'nyala-z1-benchmark-scroll-sample-sequence-test-',
		benchmark => {
			benchmark.records[0].scroll.samples[5].sampleIndex = 4;
		},
		/Chromium benchmark.*scroll sample 5 sequence.*expected 5/i
	);
});

test('Z1.3 verifier requires each scroll probe to follow a presentation opportunity', async () => {
	await assertBenchmarkRejected(
		'nyala-z1-benchmark-presentation-opportunity-test-',
		benchmark => {
			const sample = benchmark.records[0].scroll.samples[5];
			sample.presentationOpportunities = 0;
		},
		/Chromium benchmark.*scroll sample 5 presentation opportunities/i
	);
});

test('Z1.3 verifier rejects a raw record from a legacy measurement contract', async () => {
	await assertBenchmarkRejected(
		'nyala-z1-benchmark-record-measurement-contract-test-',
		benchmark => {
			const record = benchmark.records.find(candidate => candidate.renderer === 'zeus');
			assert.ok(record);
			record.measurementContractVersion = 2;
		},
		/Chromium benchmark.*record measurement contract version is 2.*expected 6/i
	);
});

test('Z1.3 verifier rejects a raw record with another scroll commit boundary', async () => {
	await assertBenchmarkRejected(
		'nyala-z1-benchmark-record-scroll-boundary-test-',
		benchmark => {
			benchmark.records[0].scrollCommitBoundary = 'immediate-dom-probe';
		},
		/Chromium benchmark.*record scroll commit boundary.*post-presentation-opportunity/i
	);
});

test('Z1.3 verifier rejects Chromium benchmark provenance from another revision', async () => {
	await assertBenchmarkRejected(
		'nyala-z1-benchmark-provenance-test-',
		benchmark => {
			benchmark.provenance.sourceRevision = 'e'.repeat(40);
		},
		/Chromium benchmark.*sourceRevision/i
	);
});

test('Z1.3 verifier rejects a Chromium benchmark captured from a dirty source tree', async () => {
	await assertBenchmarkRejected(
		'nyala-z1-benchmark-dirty-source-test-',
		benchmark => {
			benchmark.provenance.sourceTreeClean = false;
		},
		/Chromium benchmark.*source tree is not clean/i
	);
});

test('Z1.3 verifier rejects ready platform evidence with empty records and a forged passing summary', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-empty-records-test-',
		evidence => {
			evidence.macosWebKit.records = [];
		},
		/macOS WebKit.*records/i
	);
});

test('Z1.3 verifier rejects duplicate platform record iterations', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-duplicate-iteration-test-',
		evidence => {
			const first = evidence.macosWebKit.records.find(
				record => record.workloadId === '1k-x-20' && record.renderer === 'native' && record.iteration === 1
			);
			const second = evidence.macosWebKit.records.find(
				record => record.workloadId === '1k-x-20' && record.renderer === 'native' && record.iteration === 2
			);
			assert.ok(first && second);
			second.iteration = first.iteration;
		},
		/macOS WebKit.*(?:duplicate|iteration)/i
	);
});

test('Z1.3 verifier rejects duplicate run tokens across distinct iterations', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-duplicate-run-token-test-',
		evidence => {
			const first = evidence.windowsWebView2.records.find(
				record => record.workloadId === '1k-x-20' && record.renderer === 'native' && record.iteration === 1
			);
			const second = evidence.windowsWebView2.records.find(
				record => record.workloadId === '1k-x-20' && record.renderer === 'native' && record.iteration === 2
			);
			assert.ok(first && second);
			second.runToken = first.runToken;
		},
		/Windows WebView2.*duplicate run token/i
	);
});

test('Z1.3 verifier rejects run tokens reused across Chromium, WKWebView, and WebView2 evidence', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-cross-source-run-token-test-',
		(evidence, _root, benchmark) => {
			const sharedRunToken = evidence.macosWebKit.records[1].runToken;
			evidence.windowsWebView2.records[1].runToken = sharedRunToken;
			benchmark.records[1].runToken = sharedRunToken;
		},
		/global.*run token.*(?:reused|duplicate)/i
	);
});

test('Z1.3 verifier rejects platform evidence whose real CSS viewport misses the workload', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-platform-css-viewport-test-',
		evidence => {
			const record = evidence.macosWebKit.records.find(candidate => candidate.workload.viewportWidth === 1_440);
			assert.ok(record);
			record.browserViewport.width = 390;
			record.viewportCalibration.observedCssViewport.width = 390;
		},
		/macOS WebKit.*browser viewport/i
	);
});

test('Z1.3 verifier requires platform viewport calibration evidence', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-platform-viewport-calibration-test-',
		evidence => {
			delete evidence.windowsWebView2.records[0].viewportCalibration;
		},
		/Windows WebView2.*viewport calibration/i
	);
});

test('Z1.3 verifier rejects a reported platform summary that differs from raw records', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-summary-mismatch-test-',
		evidence => {
			evidence.macosWebKit.summary['1k-x-20/native'].scrollP95Ms.p95 += 50;
		},
		/macOS WebKit.*summary/i
	);
});

test('Z1.3 verifier rejects an uncommitted platform scroll sample', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-uncommitted-scroll-sample-test-',
		evidence => {
			evidence.macosWebKit.records[0].scroll.samples[4].committed = false;
		},
		/macOS WebKit.*scroll sample.*committed/i
	);
});

test('Z1.3 verifier rejects a row-misaligned scroll sample with forged committed fields', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-row-misaligned-scroll-sample-test-',
		evidence => {
			const sample = evidence.windowsWebView2.records[0].scroll.samples[4];
			sample.visibleRowIndex = sample.expectedRowIndex + 3;
			sample.rowDelta = 0;
			sample.committed = true;
		},
		/Windows WebView2.*scroll sample.*row alignment/i
	);
});

test('Z1.3 verifier rejects scroll sample offsets outside the workload bounds', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-scroll-sample-offset-bounds-test-',
		evidence => {
			const record = evidence.macosWebKit.records[0];
			const sample = record.scroll.samples[4];
			sample.targetOffset = record.workload.rows * 28 + 29;
			sample.actualOffset = sample.targetOffset;
		},
		/macOS WebKit.*scroll sample 4 offsets are out of bounds/i
	);
});

test('Z1.3 verifier rejects a forged committed sample whose actual offset misses its target', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-scroll-sample-offset-commit-test-',
		evidence => {
			const sample = evidence.macosWebKit.records[0].scroll.samples[4];
			sample.actualOffset = sample.targetOffset + 2;
			sample.committed = true;
		},
		/macOS WebKit.*scroll sample 4 offset did not commit within 1px/i
	);
});

test('Z1.3 verifier rejects non-finite raw scroll sample timings', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-scroll-sample-timing-test-',
		evidence => {
			evidence.windowsWebView2.records[0].scroll.samples[4].inputMs = 'forged';
		},
		/Windows WebView2.*scroll sample 4 timing values are invalid/i
	);
});

test('Z1.3 verifier rejects a screenshot whose file SHA-256 differs from its probe', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-screenshot-hash-test-',
		async (evidence, root) => {
			const screenshot = evidence.macosWebKit.records.find(record => record.iteration === 1)?.screenshot;
			assert.ok(screenshot);
			await writeFile(join(root, 'screenshots', screenshot), createColorfulRgbPng(390, 420, 1));
		},
		/macOS WebKit.*screenshot.*(?:SHA-256|hash|manifest)/i
	);
});

test('Z1.3 verifier binds screenshot physical dimensions to the measured CSS viewport and DPR', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-screenshot-viewport-test-',
		async (evidence, root) => {
			const record = evidence.macosWebKit.records.find(
				candidate => candidate.workloadId === '1k-x-20' && candidate.renderer === 'native' && candidate.iteration === 1
			);
			assert.ok(record);
			const manifest = evidence.macosWebKit.screenshots.find(candidate => candidate.file === record.screenshot);
			assert.ok(manifest);
			const bytes = createColorfulRgbPng(390, 420, 1);
			const pixels = inspectPngPixels(bytes);
			const sha256 = createHash('sha256').update(bytes).digest('hex');
			record.screenshotProbe = {
				passed: true,
				reason: 'screenshot pixels are visible and nonblank',
				bytes: bytes.byteLength,
				sha256,
				runToken: record.runToken,
				runMarkerVersion: SQL_RESULT_GRID_RUN_MARKER_VERSION,
				viewport: record.browserViewport,
				...pixels
			};
			manifest.bytes = bytes.byteLength;
			manifest.sha256 = sha256;
			await writeFile(join(root, 'screenshots', record.screenshot), bytes);
		},
		/macOS WebKit.*screenshot.*physical dimensions.*viewport.*DPR/i
	);
});

test('Z1.3 verifier rejects screenshot files reused across distinct benchmark runs', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-screenshot-run-identity-test-',
		evidence => {
			const firstRecord = evidence.windowsWebView2.records.find(
				candidate => candidate.workloadId === '1k-x-20' && candidate.renderer === 'native' && candidate.iteration === 1
			);
			const secondRecord = evidence.windowsWebView2.records.find(
				candidate =>
					candidate.workloadId === '1k-x-20' && candidate.renderer === 'workbench-table' && candidate.iteration === 1
			);
			assert.ok(firstRecord);
			assert.ok(secondRecord);
			const firstManifest = evidence.windowsWebView2.screenshots.find(
				candidate => candidate.file === firstRecord.screenshot
			);
			const secondManifest = evidence.windowsWebView2.screenshots.find(
				candidate => candidate.file === secondRecord.screenshot
			);
			assert.ok(firstManifest);
			assert.ok(secondManifest);
			secondRecord.screenshot = firstRecord.screenshot;
			secondRecord.screenshotProbe = {
				...firstRecord.screenshotProbe,
				runToken: secondRecord.runToken,
				viewport: secondRecord.browserViewport
			};
			secondManifest.file = firstManifest.file;
			secondManifest.bytes = firstManifest.bytes;
			secondManifest.sha256 = firstManifest.sha256;
		},
		/Windows WebView2.*screenshot.*(?:reused|duplicate).*file/i
	);
});

test('Z1.3 verifier rejects copied screenshot pixels with forged file and probe metadata', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-copied-screenshot-pixels-test-',
		async (evidence, root) => {
			const firstRecord = evidence.macosWebKit.records.find(
				candidate => candidate.workloadId === '1k-x-20' && candidate.renderer === 'native' && candidate.iteration === 1
			);
			const secondRecord = evidence.macosWebKit.records.find(
				candidate =>
					candidate.workloadId === '1k-x-20' && candidate.renderer === 'workbench-table' && candidate.iteration === 1
			);
			assert.ok(firstRecord);
			assert.ok(secondRecord);
			const secondManifest = evidence.macosWebKit.screenshots.find(
				candidate => candidate.file === secondRecord.screenshot
			);
			assert.ok(secondManifest);
			const copiedBytes = await readFile(join(root, 'screenshots', firstRecord.screenshot));
			const copiedSha256 = createHash('sha256').update(copiedBytes).digest('hex');
			await writeFile(join(root, 'screenshots', secondRecord.screenshot), copiedBytes);
			secondRecord.screenshotProbe = {
				...firstRecord.screenshotProbe,
				bytes: copiedBytes.byteLength,
				sha256: copiedSha256,
				runToken: secondRecord.runToken,
				viewport: secondRecord.browserViewport
			};
			secondManifest.bytes = copiedBytes.byteLength;
			secondManifest.sha256 = copiedSha256;
		},
		/macOS WebKit.*screenshot.*run marker.*(?:mismatch|invalid)/i
	);
});

test('Z1.3 verifier excludes the run marker from screenshot pixel diversity', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-marker-diversity-test-',
		async (evidence, root) => {
			const record = evidence.macosWebKit.records.find(
				candidate =>
					candidate.workloadId === 'narrow-panel' && candidate.renderer === 'native' && candidate.iteration === 1
			);
			assert.ok(record);
			const manifest = evidence.macosWebKit.screenshots.find(candidate => candidate.file === record.screenshot);
			assert.ok(manifest);
			const bytes = createColorfulRgbPng(390, 420, 0, record.runToken, { solidColor: [96, 96, 96] });
			const sha256 = createHash('sha256').update(bytes).digest('hex');
			record.screenshotProbe = {
				passed: true,
				reason: 'forged diversity claim',
				bytes: bytes.byteLength,
				sha256,
				runToken: record.runToken,
				runMarkerVersion: SQL_RESULT_GRID_RUN_MARKER_VERSION,
				viewport: record.browserViewport,
				...inspectPngPixels(bytes)
			};
			manifest.bytes = bytes.byteLength;
			manifest.sha256 = sha256;
			await writeFile(join(root, 'screenshots', record.screenshot), bytes);
		},
		/macOS WebKit.*screenshot.*(?:blank|uniform)/i
	);
});

test('Z1.3 verifier rejects screenshot symlinks even when they remain inside the artifact root', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-screenshot-symlink-test-',
		async (evidence, root) => {
			const firstRecord = evidence.windowsWebView2.records.find(
				candidate =>
					candidate.workloadId === 'wide-columns' && candidate.renderer === 'native' && candidate.iteration === 1
			);
			const secondRecord = evidence.windowsWebView2.records.find(
				candidate =>
					candidate.workloadId === 'wide-columns' &&
					candidate.renderer === 'workbench-table' &&
					candidate.iteration === 1
			);
			assert.ok(firstRecord);
			assert.ok(secondRecord);
			const secondPath = join(root, 'screenshots', secondRecord.screenshot);
			await rm(secondPath);
			await symlink(firstRecord.screenshot, secondPath);
		},
		/Windows WebView2.*screenshot.*symlink/i
	);
});

test('Z1.3 verifier rejects a platform artifact directory symlink that escapes the evidence root', async () => {
	const externalRoot = await mkdtemp(join(tmpdir(), 'nyala-z1-external-artifact-test-'));
	try {
		await assertPlatformEvidenceRejected(
			'nyala-z1-artifact-root-symlink-test-',
			async (evidence, root) => {
				await cp(join(root, 'screenshots'), join(externalRoot, 'screenshots'), { recursive: true });
				await symlink(externalRoot, join(root, 'escaped-artifact-root'));
				evidence.macosWebKit.artifactDirectory = 'escaped-artifact-root';
			},
			/macOS WebKit.*artifact root.*(?:symlink|escapes)/i
		);
	} finally {
		await rm(externalRoot, { recursive: true, force: true });
	}
});

test('Z1.3 verifier rejects an unknown platform evidence schema version', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-platform-version-test-',
		evidence => {
			evidence.macosWebKit.version = 999;
		},
		/macOS WebKit.*version/i
	);
});

test('Z1.3 verifier rejects platform evidence without measurement contract v6', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-platform-measurement-contract-test-',
		evidence => {
			delete evidence.macosWebKit.measurementContractVersion;
		},
		/macOS WebKit.*measurement contract.*expected 6/i
	);
});

test('Z1.3 verifier rejects platform evidence without the v5 scroll commit boundary', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-platform-scroll-boundary-test-',
		evidence => {
			delete evidence.macosWebKit.scrollCommitBoundary;
		},
		/macOS WebKit.*scroll commit boundary.*post-presentation-opportunity/i
	);
});

test('Z1.3 verifier rejects platform evidence without the balanced execution order', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-platform-execution-order-test-',
		evidence => {
			delete evidence.macosWebKit.executionOrder;
		},
		/macOS WebKit.*execution order.*renderer-balanced-rotation-v1/i
	);
});

test('Z1.3 verifier rejects a forged platform execution ordinal', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-platform-execution-ordinal-test-',
		evidence => {
			evidence.macosWebKit.records[0].executionOrdinal = 999;
		},
		/macOS WebKit.*execution ordinal/i
	);
});

test('Z1.3 verifier rejects a forged Zeus bundle audit digest', async () => {
	await assertPlatformEvidenceRejected(
		'nyala-z1-zeus-audit-test-',
		async (_evidence, root) => {
			const auditPath = join(root, 'zeus-audit.json');
			const audit = JSON.parse(await readFile(auditPath, 'utf8'));
			audit.bundle.sha256 = 'f'.repeat(64);
			await writeFile(auditPath, `${JSON.stringify(audit)}\n`, 'utf8');
		},
		/Zeus.*(?:SHA-256|digest|bundle)/i
	);
});

test('Z1.3 verifier rejects platform evidence from different workflow revisions', async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), 'nyala-z1-provenance-test-'));
	try {
		const evidencePath = join(tempRoot, 'platform-evidence.json');
		const outputPath = join(tempRoot, 'gate.json');
		const benchmarkPath = await writeSyntheticBenchmark(tempRoot);
		const evidence = await createEmbeddedPlatformEvidence(tempRoot);
		evidence.windowsWebView2.provenance.sourceRevision = 'b'.repeat(40);
		await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, 'utf8');
		await assert.rejects(
			execFileAsync(process.execPath, [verifierPath, benchmarkPath, outputPath], {
				env: gateEnv(tempRoot, evidencePath),
				cwd: new URL('..', import.meta.url).pathname
			})
		);
		const report = JSON.parse(await readFile(outputPath, 'utf8'));
		assert.equal(report.decision, 'NO-GO');
		assert.match(report.reasons.join('\n'), /Windows WebView2.*sourceRevision/i);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test('Z1.3 verifier rejects legacy SafariDriver evidence', async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), 'nyala-z1-wkwebview-identity-test-'));
	try {
		const evidencePath = join(tempRoot, 'platform-evidence.json');
		const outputPath = join(tempRoot, 'gate.json');
		const benchmarkPath = await writeSyntheticBenchmark(tempRoot);
		const evidence = await createEmbeddedPlatformEvidence(tempRoot);
		evidence.macosWebKit = {
			...evidence.macosWebKit,
			driverProvider: 'external',
			nativeWebView: false,
			engine: 'safari-webdriver',
			browser: 'safari',
			reason: 'legacy SafariDriver diagnostic run'
		};
		await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, 'utf8');
		await assert.rejects(
			execFileAsync(process.execPath, [verifierPath, benchmarkPath, outputPath], {
				env: gateEnv(tempRoot, evidencePath),
				cwd: new URL('..', import.meta.url).pathname
			})
		);
		const report = JSON.parse(await readFile(outputPath, 'utf8'));
		assert.equal(report.decision, 'NO-GO');
		assert.match(report.reasons.join('\n'), /macOS WebKit: embedded WKWebView identity mismatch/);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test('Z1.3 verifier rejects legacy EdgeDriver evidence', async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), 'nyala-z1-webview2-identity-test-'));
	try {
		const evidencePath = join(tempRoot, 'platform-evidence.json');
		const outputPath = join(tempRoot, 'gate.json');
		const benchmarkPath = await writeSyntheticBenchmark(tempRoot);
		const evidence = await createEmbeddedPlatformEvidence(tempRoot);
		evidence.windowsWebView2 = {
			...evidence.windowsWebView2,
			driverProvider: 'external',
			nativeWebView: false,
			nativeWebView2: false,
			engine: 'msedgedriver',
			reason: 'EdgeDriver diagnostic run'
		};
		await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, 'utf8');
		await assert.rejects(
			execFileAsync(process.execPath, [verifierPath, benchmarkPath, outputPath], {
				env: gateEnv(tempRoot, evidencePath),
				cwd: new URL('..', import.meta.url).pathname
			})
		);
		const report = JSON.parse(await readFile(outputPath, 'utf8'));
		assert.equal(report.decision, 'NO-GO');
		assert.match(report.reasons.join('\n'), /Windows WebView2: embedded WebView2 identity mismatch/);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});
