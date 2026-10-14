import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createInterleavedVariantBenchmarkPlan,
	INTERLEAVED_EXECUTION_ORDER
} from './sql-result-grid-interleaved-plan.mjs';

const variants = [
	{ id: 'beta-31', bundlePath: '/tmp/a.js' },
	{ id: 'beta-32', bundlePath: '/tmp/b.js' }
];
const workloads = [{ id: '10k-x-50' }, { id: 'wide-columns' }];
const renderers = ['native', 'workbench-table', 'zeus'];

test('interleaved plan alternates both variants inside one iteration', () => {
	const plan = createInterleavedVariantBenchmarkPlan(variants, workloads, renderers, 2);
	const first = plan.filter(entry => entry.workload.id === '10k-x-50' && entry.iteration === 1);
	assert.deepEqual(
		first.map(entry => [entry.renderer, entry.variant?.id ?? null]),
		[
			['zeus', 'beta-31'],
			['native', null],
			['workbench-table', null],
			['zeus', 'beta-32']
		]
	);
});

test('interleaved plan swaps variant order between iterations', () => {
	const plan = createInterleavedVariantBenchmarkPlan(variants, workloads, renderers, 2);
	const zeusIdsForWorkload = workloadId =>
		plan.filter(entry => entry.workload.id === workloadId && entry.renderer === 'zeus').map(entry => entry.variant.id);
	assert.deepEqual(zeusIdsForWorkload('10k-x-50'), ['beta-31', 'beta-32', 'beta-32', 'beta-31']);
	// 第二个 workload 的轮转相位不同，避免顺序与 workload 绑定。
	assert.deepEqual(zeusIdsForWorkload('wide-columns'), ['beta-32', 'beta-31', 'beta-31', 'beta-32']);
});

test('each variant occupies the leading slot exactly half the time', () => {
	const plan = createInterleavedVariantBenchmarkPlan(variants, workloads, renderers, 4);
	const leaders = new Map();
	for (const entry of plan.filter(item => item.renderer === 'zeus')) {
		const key = `${entry.workload.id}#${entry.iteration}`;
		if (!leaders.has(key)) leaders.set(key, entry.variant.id);
	}
	const counts = {};
	for (const id of leaders.values()) counts[id] = (counts[id] ?? 0) + 1;
	assert.equal(counts['beta-31'], counts['beta-32']);
	assert.equal(counts['beta-31'], workloads.length * 2);
});

test('control renderers are measured once per iteration, never per variant', () => {
	const plan = createInterleavedVariantBenchmarkPlan(variants, workloads, renderers, 3);
	for (const workload of workloads) {
		for (let iteration = 1; iteration <= 3; iteration += 1) {
			for (const renderer of ['native', 'workbench-table']) {
				const slots = plan.filter(
					entry => entry.workload.id === workload.id && entry.iteration === iteration && entry.renderer === renderer
				);
				assert.equal(slots.length, 1);
				assert.equal(slots[0].variant, null);
			}
		}
	}
});

test('execution ordinals are dense and ordered', () => {
	const plan = createInterleavedVariantBenchmarkPlan(variants, workloads, renderers, 2);
	assert.deepEqual(
		plan.map(entry => entry.executionOrdinal),
		plan.map((_, index) => index + 1)
	);
});

test('the plan declares the interleaved execution order', () => {
	assert.equal(INTERLEAVED_EXECUTION_ORDER, 'renderer-balanced-rotation-interleaved-variants-v1');
});

test('a plan without two variants, a Zeus renderer or a control renderer is rejected', () => {
	assert.throws(() => createInterleavedVariantBenchmarkPlan([variants[0]], workloads, renderers, 2));
	assert.throws(() => createInterleavedVariantBenchmarkPlan(variants, workloads, ['zeus'], 2));
	assert.throws(() => createInterleavedVariantBenchmarkPlan(variants, workloads, ['native'], 2));
	assert.throws(
		() => createInterleavedVariantBenchmarkPlan([variants[0], variants[0]], workloads, renderers, 2),
		/unique/
	);
});
