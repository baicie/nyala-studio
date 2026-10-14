// 交错采集的执行计划。
//
// 背景：GitHub-hosted runner 之间存在数十个百分点的宿主级漂移，两次相隔数小时的
// 独立 run 无法支撑 10%/20% 量级的门禁判据。交错计划把两个 bundle 变体放进同一
// 个 runner、同一次 WebView 会话、同一段宿主状态里交替测量，使宿主漂移同时作用于
// 两个变体。
//
// 每个 iteration 的执行序列固定为：
//   zeus(变体 A) -> 对照 renderer -> zeus(变体 B)
// 相邻 iteration 交换 A/B 顺序（A,B / B,A 交替），使每个变体等量占据首尾位置，
// 顺序效应不能单独解释任何一个变体的优势。对照 renderer 每个 iteration 只测一次，
// 夹在两个变体之间，用于观测同段宿主状态下的漂移。

export const INTERLEAVED_EXECUTION_ORDER = 'renderer-balanced-rotation-interleaved-variants-v1';

/**
 * @param {{id: string, bundlePath: string}[]} variants 至少两个变体
 * @param {{id: string}[]} workloads
 * @param {string[]} renderers
 * @param {number} repeat
 */
export function createInterleavedVariantBenchmarkPlan(variants, workloads, renderers, repeat) {
	if (!Array.isArray(variants) || variants.length < 2) {
		throw new Error('An interleaved plan needs at least two Zeus bundle variants.');
	}
	const variantIds = variants.map(variant => variant.id);
	if (new Set(variantIds).size !== variantIds.length) {
		throw new Error('Interleaved variant ids must be unique.');
	}
	if (!Array.isArray(workloads) || workloads.length === 0) {
		throw new Error('An interleaved plan needs at least one workload.');
	}
	if (!Array.isArray(renderers) || renderers.length === 0) {
		throw new Error('An interleaved plan needs at least one renderer.');
	}
	if (!Number.isInteger(repeat) || repeat < 1) {
		throw new Error(`Interleaved repeat must be a positive integer, got ${repeat}.`);
	}
	const controlRenderers = renderers.filter(renderer => renderer !== 'zeus');
	if (!controlRenderers.length) {
		throw new Error('An interleaved plan needs at least one control renderer to expose host drift.');
	}
	if (!renderers.includes('zeus')) {
		throw new Error('An interleaved plan must include the zeus renderer.');
	}

	const plan = [];
	let executionOrdinal = 1;
	const push = (workload, renderer, iteration, variant) => {
		plan.push({ workload, renderer, iteration, variant, executionOrdinal });
		executionOrdinal += 1;
	};

	for (let workloadIndex = 0; workloadIndex < workloads.length; workloadIndex += 1) {
		const workload = workloads[workloadIndex];
		for (let iteration = 1; iteration <= repeat; iteration += 1) {
			// 变体顺序按 iteration 交替，使 A/B 在首尾位置各占一半。workloadIndex
			// 也参与轮转，避免顺序与 workload 固定绑定。
			const rotate = (workloadIndex + iteration - 1) % variants.length;
			const ordered = variants.map((_, offset) => variants[(rotate + offset) % variants.length]);
			ordered.forEach((variant, position) => {
				push(workload, 'zeus', iteration, variant);
				if (position === 0) {
					// 对照 renderer 只在第一个变体之后测一次，夹在两个变体之间。
					controlRenderers.forEach(renderer => push(workload, renderer, iteration, null));
				}
			});
		}
	}
	return plan;
}
