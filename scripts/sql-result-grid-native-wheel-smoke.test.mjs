import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import {
	evaluateNativeWheelSmoke,
	evaluateNativeWheelTimeline,
	parseNativeWheelHelperResult,
	summarizeNativeWheelTimeline
} from './sql-result-grid-native-wheel-contract.mjs';

const execFileAsync = promisify(execFile);

test('native wheel smoke rejects invalid diagnostic-profile booleans before starting the app', async () => {
	await assert.rejects(
		execFileAsync(process.execPath, [
			'scripts/sql-result-grid-native-wheel-smoke.mjs',
			'--app-binary', '/tmp/unused-app',
			'--zeus-bundle', '/tmp/unused-bundle.js',
			'--diagnostic-profile', 'flase'
		]),
		error => error.code === 1 && /--diagnostic-profile must be true or false/.test(error.stderr)
	);
});

test('native wheel smoke passes only for trusted input that reaches and scrolls the viewport', () => {
	const checks = evaluateNativeWheelSmoke({
		nativeInput: { posted: true },
		before: { scrollTop: 0, visibleRowIndex: 0 },
		after: {
			scrollTop: 84,
			visibleRowIndex: 3,
			wheelEvents: [{ isTrusted: true, pathContainsViewport: true }],
			scrollEvents: [{ gestureId: 1, scrollTop: 84 }]
		}
	});
	assert.deepEqual(checks, {
		nativeInputPosted: true,
		trustedWheelObserved: true,
		singleTrustedWheelObserved: true,
		wheelTargetedViewport: true,
		singleViewportScrollObserved: true,
		viewportMoved: true,
		visibleRowChanged: true
	});
});

test('native wheel smoke rejects synthetic, mis-targeted, or ineffective input', () => {
	const checks = evaluateNativeWheelSmoke({
		nativeInput: { posted: true },
		before: { scrollTop: 0, visibleRowIndex: 0 },
		after: {
			scrollTop: 0,
			visibleRowIndex: 0,
			wheelEvents: [
				{ isTrusted: false, pathContainsViewport: true },
				{ isTrusted: true, pathContainsViewport: false }
			]
		}
	});
	assert.deepEqual(checks, {
		nativeInputPosted: true,
		trustedWheelObserved: true,
		singleTrustedWheelObserved: true,
		wheelTargetedViewport: false,
		singleViewportScrollObserved: false,
		viewportMoved: false,
		visibleRowChanged: false
	});
});

test('native wheel smoke rejects extra trusted wheel or viewport scroll events', () => {
	const checks = evaluateNativeWheelSmoke({
		nativeInput: { posted: true },
		before: { scrollTop: 0, visibleRowIndex: 0 },
		after: {
			scrollTop: 84,
			visibleRowIndex: 3,
			wheelEvents: [
				{ isTrusted: true, pathContainsViewport: true },
				{ isTrusted: true, pathContainsViewport: true }
			],
			scrollEvents: [{ gestureId: 1, scrollTop: 56 }, { scrollTop: 84 }]
		}
	});
	assert.equal(checks.singleTrustedWheelObserved, false);
	assert.equal(checks.singleViewportScrollObserved, false);
});

function validNativeWheelTimeline() {
	return {
		scrollTop: 84,
		visibleRowIndex: 3,
		diagnosticComplete: true,
		timeline: [
			{ kind: 'wheel', gestureId: 7, at: 10, eventTimeStamp: 100, isTrusted: true },
			{ kind: 'scroll', gestureId: 7, at: 11, eventTimeStamp: 101 },
			{
				kind: 'renderer-commit',
				gestureId: 7,
				transactionId: 4,
				at: 18
			},
			{ kind: 'raf', gestureId: 7, at: 20 },
			{ kind: 'renderer-diagnostics-end', gestureId: 7, at: 21, commitTransactionIds: [4] },
			{
				kind: 'after-frame-task',
				gestureId: 7,
				at: 22,
				scrollTop: 84,
				visibleRowIndex: 3,
				expectedVisibleRowIndex: 3
			}
		],
		diagnostics: {
			gestureId: 7,
			operation: { phase: 'native-wheel', sampleIndex: 0, commitTransactionIds: [4], primaryCommitTransactionId: 4 },
			snapshot: {
				commits: [
					{
						transactionId: 4,
						source: 'scroll',
						inputTime: 101,
						handlerStartTime: 12,
						handlerEndTime: 13,
						rangeStartTime: 14,
						rangeCalculatedTime: 15,
						commitStartTime: 16,
						commitEndTime: 18
					}
				]
			}
		}
	};
}

test('native wheel timeline links one trusted gesture to renderer work and frame opportunities', () => {
	const checks = evaluateNativeWheelTimeline({ after: validNativeWheelTimeline() });
	assert.deepEqual(checks, {
		trustedWheelTimestampRecorded: true,
		scrollTimestampRecorded: true,
		rendererCommitObserved: true,
		commitTimingValid: true,
		timelineOrderValid: true,
		rafOpportunityRecorded: true,
		afterFrameTaskRecorded: true,
		afterFrameRowCorrect: true,
		diagnosticOperationClosed: true
	});
});

test('native wheel timeline accepts millisecond-quantized equal timestamps when insertion order is intact', () => {
	const after = validNativeWheelTimeline();
	for (const event of after.timeline) event.at = 10;
	after.timeline.forEach((event, sequence) => {
		event.sequence = sequence;
	});
	after.timeline.reverse();
	for (const commit of after.diagnostics.snapshot.commits) {
		commit.handlerStartTime = 10;
		commit.handlerEndTime = 10;
		commit.rangeStartTime = 10;
		commit.rangeCalculatedTime = 10;
		commit.commitStartTime = 10;
		commit.commitEndTime = 10;
	}
	const checks = evaluateNativeWheelTimeline({ after });
	assert.equal(checks.timelineOrderValid, true);
	assert.equal(checks.commitTimingValid, true);
	assert.equal(checks.diagnosticOperationClosed, true);
});

test('native wheel timeline accepts compositor scroll before late wheel capture when event timestamp is earlier', () => {
	const after = validNativeWheelTimeline();
	const wheel = after.timeline.find(event => event.kind === 'wheel');
	const scroll = after.timeline.find(event => event.kind === 'scroll');
	wheel.at = 15;
	wheel.eventTimeStamp = 100;
	scroll.at = 11;
	scroll.eventTimeStamp = 101;
	after.timeline.sort((left, right) => left.at - right.at);
	after.timeline.forEach((event, sequence) => {
		event.sequence = sequence;
	});
	const checks = evaluateNativeWheelTimeline({ after });
	assert.equal(checks.scrollTimestampRecorded, true);
	assert.equal(checks.timelineOrderValid, true);
});

test('native wheel timeline rejects a later wheel event linked to an earlier scroll despite callback order', () => {
	const after = validNativeWheelTimeline();
	after.timeline.find(event => event.kind === 'wheel').eventTimeStamp = 102;
	const checks = evaluateNativeWheelTimeline({ after });
	assert.equal(checks.scrollTimestampRecorded, false);
	assert.equal(checks.timelineOrderValid, false);
});

test('native wheel timeline stays incomplete when the trusted wheel does not scroll', () => {
	const checks = evaluateNativeWheelTimeline({
		after: {
			diagnosticComplete: false,
			timeline: [{ kind: 'wheel', gestureId: 7, at: 10, eventTimeStamp: 100, isTrusted: true }],
			diagnostics: {
				operation: {
					phase: 'native-wheel',
					sampleIndex: 0,
					commitTransactionIds: [],
					primaryCommitTransactionId: null
				},
				snapshot: { commits: [] }
			}
		}
	});
	assert.deepEqual(checks, {
		trustedWheelTimestampRecorded: true,
		scrollTimestampRecorded: false,
		rendererCommitObserved: false,
		commitTimingValid: false,
		timelineOrderValid: false,
		rafOpportunityRecorded: false,
		afterFrameTaskRecorded: false,
		afterFrameRowCorrect: false,
		diagnosticOperationClosed: false
	});
});

test('native wheel timeline rejects broken gesture links, commit timing, order, and visible-row proof', () => {
	const cases = [
		{
			name: 'scroll from another gesture',
			mutate(after) {
				after.timeline.find(event => event.kind === 'scroll').gestureId = 8;
			},
			check: 'scrollTimestampRecorded'
		},
		{
			name: 'commit end does not match renderer event',
			mutate(after) {
				after.diagnostics.snapshot.commits[0].commitEndTime = 19;
			},
			check: 'commitTimingValid'
		},
		{
			name: 'scroll precedes the wheel capture',
			mutate(after) {
				const scroll = after.timeline.find(event => event.kind === 'scroll');
				scroll.at = 9;
				scroll.eventTimeStamp = 99;
				after.timeline.forEach((event, sequence) => {
					event.sequence = sequence;
				});
				const wheel = after.timeline.find(event => event.kind === 'wheel');
				[wheel.sequence, scroll.sequence] = [scroll.sequence, wheel.sequence];
			},
			check: 'timelineOrderValid'
		},
		{
			name: 'equal timestamps still reject reversed sequence order',
			mutate(after) {
				for (const event of after.timeline) event.at = 10;
				after.timeline.forEach((event, sequence) => {
					event.sequence = sequence;
				});
				const wheel = after.timeline.find(event => event.kind === 'wheel');
				const scroll = after.timeline.find(event => event.kind === 'scroll');
				[wheel.sequence, scroll.sequence] = [scroll.sequence, wheel.sequence];
			},
			check: 'timelineOrderValid'
		},
		{
			name: 'visible row disagrees with expected row',
			mutate(after) {
				after.timeline.find(event => event.kind === 'after-frame-task').visibleRowIndex = 2;
			},
			check: 'afterFrameRowCorrect'
		}
	];

	for (const testCase of cases) {
		const after = validNativeWheelTimeline();
		testCase.mutate(after);
		assert.equal(evaluateNativeWheelTimeline({ after })[testCase.check], false, testCase.name);
	}
});

test('native wheel timeline summary uses one performance clock and preserves missing stages', () => {
	const summary = summarizeNativeWheelTimeline({
		after: {
			timeline: [
				{ kind: 'wheel', gestureId: 7, at: 10, receivedAt: 10.2, eventTimeStamp: 100, isTrusted: true },
				{ kind: 'scroll', gestureId: 7, at: 11, eventTimeStamp: 101 },
				{ kind: 'renderer-commit', gestureId: 7, transactionId: 4, at: 18 },
				{ kind: 'raf', gestureId: 7, at: 20 },
				{ kind: 'renderer-diagnostics-end', gestureId: 7, at: 21, commitTransactionIds: [4] },
				{ kind: 'after-frame-task', gestureId: 7, at: 22 }
			],
			diagnostics: {
				gestureId: 7,
				operation: { phase: 'native-wheel', sampleIndex: 0, commitTransactionIds: [4], primaryCommitTransactionId: 4 },
				snapshot: {
					commits: [
						{
							transactionId: 4,
							source: 'scroll',
							inputTime: 101,
							handlerStartTime: 12,
							handlerEndTime: 13,
							rangeStartTime: 14,
							rangeCalculatedTime: 15,
							commitStartTime: 16,
							commitEndTime: 18
						}
					]
				}
			}
		}
	});
	assert.deepEqual(summary, {
		timingClock: 'performance-now',
		wheelEventTimeStamp: 100,
		wheelCaptureAt: 10,
		scrollEventTimeStamp: 101,
		rendererCommitAt: 18,
		rendererDiagnosticsEndAt: 21,
		wheelToScrollMs: 1,
		wheelToCommitHandlerMs: 2,
		commitDurationMs: 6,
		commitToRafMs: 2,
		wheelToRafMs: 10,
		wheelToAfterFrameTaskMs: 12,
		commitInputTime: 101,
		commitInputToScrollEventTimestampMs: 0
	});
});

test('native wheel closes diagnostics after rAF entry and records the callback-entry timestamp', async () => {
	const source = await readFile(new URL('./benchmark-sql-result-grid.mjs', import.meta.url), 'utf8');
	const callbackStart = source.indexOf('requestAnimationFrame(frameTimeStamp => {');
	assert.notEqual(callbackStart, -1, 'native wheel rAF callback must be present');
	const callback = source.slice(callbackStart);
	const rafEntry = callback.indexOf('const rafAt = performance.now();');
	const endOperation = callback.indexOf('endOperation(operation)');
	const snapshot = callback.indexOf('zeusDiagnostics.snapshot()');
	const commitEvent = callback.indexOf("kind: 'renderer-commit'");
	const rafEvent = callback.indexOf("kind: 'raf'");
	const diagnosticsEndEvent = callback.indexOf("kind: 'renderer-diagnostics-end'");
	assert.ok(rafEntry >= 0 && rafEntry < endOperation);
	assert.ok(endOperation < snapshot);
	assert.ok(snapshot < commitEvent && commitEvent < rafEvent && rafEvent < diagnosticsEndEvent);
	assert.match(callback.slice(rafEvent, diagnosticsEndEvent), /at: rafAt/);
});

test('native wheel arms one gesture before the native helper can dispatch input', async () => {
	const [pageSource, runnerSource] = await Promise.all([
		readFile(new URL('./benchmark-sql-result-grid.mjs', import.meta.url), 'utf8'),
		readFile(new URL('./sql-result-grid-native-wheel-smoke.mjs', import.meta.url), 'utf8')
	]);
	const arm = pageSource.indexOf('globalThis.__nyalaNativeWheelSmokeArm = () =>');
	const diagnostics = pageSource.indexOf('nativeWheelState.rendered.zeusDiagnostics?.beginOperation(', arm);
	const armedFlag = pageSource.indexOf('nativeWheelState.armed = true;', arm);
	const scrollListener = pageSource.indexOf("document.addEventListener('scroll'", armedFlag);
	const helperArm = runnerSource.indexOf('await armNativeWheel(endpoint.driverUrl);');
	const helperRun = runnerSource.indexOf('helperResult = runHelper(', helperArm);
	assert.ok(arm >= 0 && diagnostics > arm && armedFlag > diagnostics && scrollListener > armedFlag);
	assert.ok(helperArm >= 0 && helperRun > helperArm);
});

test('native wheel timeout records the last probe and fails the smoke when input did not complete', async () => {
	const source = await readFile(new URL('./sql-result-grid-native-wheel-smoke.mjs', import.meta.url), 'utf8');
	assert.match(source, /catch \(error\) \{[\s\S]*?readProbe\(driverUrl\)[\s\S]*?recordNativeWheelOutcome/);
	assert.match(source, /function recordNativeWheelOutcome\(\{ nativeInput, before, after \}\)/);
	assert.match(source, /report\.status =\s*\n\s*Object\.values\(report\.checks\)\.every\(Boolean\)/);
});

test('Windows wheel helper avoids PowerShell automatic PID variable', async () => {
	const source = await readFile(new URL('./sql-result-grid-native-wheel-smoke.mjs', import.meta.url), 'utf8');
	const helper = source.match(/function windowsHelperSource\(\) \{\s*return `([\s\S]*?)`;\s*\}/)?.[1];
	assert.ok(helper, 'Windows native input helper source must be present');
	assert.match(helper, /\[uint32\]\$windowProcessId = 0/);
	assert.match(helper, /GetWindowThreadProcessId\(\$hwnd, \[ref\]\$windowProcessId\)/);
	assert.match(helper, /\$windowProcessId -eq \$ProcessId/);
	assert.match(helper, /\[int\]\$Delta = -120/);
	assert.match(helper, /\[BitConverter\]::ToUInt32\(\[BitConverter\]::GetBytes\(\[int32\]\$Delta\), 0\)/);
	assert.match(helper, /WindowFromPoint/);
	assert.match(helper, /GetGUIThreadInfo/);
	assert.match(helper, /ConvertTo-Json -Compress -Depth 8/);
	assert.doesNotMatch(helper, /\$pid\b/i);
	assert.match(source, /'-Delta',\s*'-120'/);
});

test('native wheel helper result preserves stderr alongside valid JSON', () => {
	assert.deepEqual(
		parseNativeWheelHelperResult({
			stdout: '{"posted":false,"reason":"target-window-not-found"}',
			stderr: 'PowerShell diagnostic',
			status: 3
		}),
		{
			posted: false,
			reason: 'target-window-not-found',
			helperStderr: 'PowerShell diagnostic'
		}
	);
});
