import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';

const source = await readFile(new URL('../.github/workflows/sql-result-grid-platform.yml', import.meta.url), 'utf8');
const exec = promisify(execFile);
const installStep = source.split('- name: Install Zeus only in a temporary directory')[1].split('- name:')[0];
const validation = installStep.split('run: |\n')[1].split('          printf ')[0];

function validateInputs(overrides = {}) {
	return exec('/bin/bash', ['-c', validation], {
		env: {
			...process.env,
			CELL_LAYOUT_VARIANT: '',
			ZEUS_VARIANTS: '',
			DIAGNOSTIC_RENDERERS: '',
			SAME_EXECUTION_PROFILE: 'false',
			INSTRUMENT_BASELINE: 'false',
			TEXT_CHURN: 'false',
			...overrides
		}
	});
}

test('same-execution workflow requires renderer callbacks and excludes the text observer before setup', async () => {
	await validateInputs();
	await assert.rejects(validateInputs({ SAME_EXECUTION_PROFILE: 'true' }), /requires instrument_baseline=true/);
	await assert.rejects(
		validateInputs({ SAME_EXECUTION_PROFILE: 'true', INSTRUMENT_BASELINE: 'true', TEXT_CHURN: 'true' }),
		/text_churn=false/
	);
	await validateInputs({ SAME_EXECUTION_PROFILE: 'true', INSTRUMENT_BASELINE: 'true' });
});

test('same-execution diagnostics allow a renderer subset without creating a CSS or bundle variant', async () => {
	await assert.rejects(validateInputs({ DIAGNOSTIC_RENDERERS: 'zeus,workbench-table' }), /Renderer subsets require/);
	await validateInputs({
		SAME_EXECUTION_PROFILE: 'true',
		INSTRUMENT_BASELINE: 'true',
		DIAGNOSTIC_RENDERERS: 'zeus,workbench-table'
	});
});

test('both native jobs forward the explicit mode and disable the separate trace navigation', () => {
	const macos = source.split('- name: Run embedded WKWebView benchmark')[1].split('- name: Upload macOS')[0];
	const windows = source.split('- name: Run embedded WebView2 benchmark')[1].split('- name: Upload Windows')[0];
	assert.match(macos, /SAME_EXECUTION_PROFILE:.*inputs\.same_execution_profile/);
	assert.match(macos, /if \[ "\$SAME_EXECUTION_PROFILE" = true \]; then TRACE_PROFILE=false; fi/);
	assert.match(macos, /--trace-profile "\$TRACE_PROFILE"/);
	assert.match(macos, /--same-execution-profile "\$SAME_EXECUTION_PROFILE"/);
	assert.match(windows, /SAME_EXECUTION_PROFILE:.*inputs\.same_execution_profile/);
	assert.match(windows, /if \(\$env:SAME_EXECUTION_PROFILE -eq 'true'\) \{ \$traceProfile = 'false' \}/);
	assert.match(windows, /--trace-profile "\$traceProfile"/);
	assert.match(windows, /--same-execution-profile "\$env:SAME_EXECUTION_PROFILE"/);
});

test('aggregate merge and scoring explicitly skip same-execution diagnostics', () => {
	const guards = [...source.matchAll(/if: \$\{\{ ([^\n]+) \}\}/g)]
		.map(match => match[1])
		.filter(condition => condition.includes("inputs.zeus_package_version == ''"));
	assert.equal(guards.length, 2);
	for (const condition of guards) assert.match(condition, /inputs\.same_execution_profile != 'true'/);
});
