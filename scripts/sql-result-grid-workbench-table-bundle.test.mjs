import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSqlResultGridWorkbenchTableBundle } from './sql-result-grid-workbench-table-bundle.mjs';
import {
	WORKBENCH_TABLE_IMPLEMENTATION_ID,
	WORKBENCH_TABLE_RUNTIME_PROOF
} from './sql-result-grid-benchmark-contract.mjs';

test('benchmark-only bundle contains the real WorkbenchTable factory and required CSS', async () => {
	const bundle = await buildSqlResultGridWorkbenchTableBundle();

	assert.ok(bundle.javascriptBytes > 0);
	assert.ok(bundle.cssBytes > 0);
	assert.match(bundle.sha256, /^[a-f0-9]{64}$/);
	assert.match(bundle.javascript, /__NYALA_CREATE_WORKBENCH_TABLE_BENCHMARK__/);
	assert.match(bundle.javascript, new RegExp(WORKBENCH_TABLE_IMPLEMENTATION_ID.replaceAll('.', '\\.')));
	assert.match(bundle.javascript, new RegExp(WORKBENCH_TABLE_RUNTIME_PROOF));
	assert.match(bundle.css, /\.monaco-table/);
	assert.match(bundle.css, /\.monaco-list-row/);
	assert.doesNotMatch(bundle.javascript, /@zeus-web\/data-grid/);
});
