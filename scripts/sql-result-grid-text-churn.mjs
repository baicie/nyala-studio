/**
 * Opt-in diagnostic counter. Kept self-contained so the benchmark can stringify
 * it into a page without installing observers on the primary timing path.
 */
export function installSqlResultGridTextChurnObserver(options = {}) {
	if (options.enabled !== true) return undefined;
	const target = options.target ?? globalThis.document?.documentElement;
	if (!target || typeof globalThis.MutationObserver !== 'function') {
		throw new Error('Text churn diagnostics require a DOM target and MutationObserver.');
	}
	const counts = { textWrites: 0, addedNodes: 0, removedNodes: 0, mutations: 0 };
	let disposed = false;
	function collect(records) {
		if (disposed) return;
		for (const record of records) {
			counts.mutations += 1;
			if (record.type === 'characterData') counts.textWrites += 1;
			for (const node of record.addedNodes) if (node.nodeType === 3) counts.addedNodes += 1;
			for (const node of record.removedNodes) if (node.nodeType === 3) counts.removedNodes += 1;
		}
	}
	const observer = new globalThis.MutationObserver(collect);
	try {
		observer.observe(target, { childList: true, subtree: true, characterData: true });
	} catch (error) {
		observer.disconnect();
		throw error;
	}
	return {
		snapshot() {
			if (!disposed) collect(observer.takeRecords());
			return { ...counts };
		},
		reset() {
			if (!disposed) observer.takeRecords();
			counts.textWrites = 0;
			counts.addedNodes = 0;
			counts.removedNodes = 0;
			counts.mutations = 0;
		},
		dispose() {
			if (disposed) return;
			collect(observer.takeRecords());
			observer.disconnect();
			disposed = true;
		}
	};
}
