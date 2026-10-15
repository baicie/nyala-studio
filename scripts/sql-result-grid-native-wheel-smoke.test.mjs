import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { evaluateNativeWheelSmoke, parseNativeWheelHelperResult } from './sql-result-grid-native-wheel-contract.mjs';

test('native wheel smoke passes only for trusted input that reaches and scrolls the viewport', () => {
	const checks = evaluateNativeWheelSmoke({
		nativeInput: { posted: true },
		before: { scrollTop: 0, visibleRowIndex: 0 },
		after: {
			scrollTop: 84,
			visibleRowIndex: 3,
			wheelEvents: [{ isTrusted: true, pathContainsViewport: true }]
		}
	});
	assert.deepEqual(checks, {
		nativeInputPosted: true,
		trustedWheelObserved: true,
		wheelTargetedViewport: true,
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
		wheelTargetedViewport: false,
		viewportMoved: false,
		visibleRowChanged: false
	});
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
