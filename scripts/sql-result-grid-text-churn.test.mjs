import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { installSqlResultGridTextChurnObserver } from './sql-result-grid-text-churn.mjs';

function observerEnvironment(t) {
	const originalObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
	const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
	const target = {};
	const observers = [];
	class FakeMutationObserver {
		constructor(callback) {
			this.callback = callback;
			this.pending = [];
			this.disconnects = 0;
			observers.push(this);
		}
		observe(observedTarget, options) {
			this.target = observedTarget;
			this.options = options;
		}
		takeRecords() {
			return this.pending.splice(0);
		}
		deliver() {
			this.callback(this.takeRecords());
		}
		disconnect() {
			this.pending.length = 0;
			this.disconnects += 1;
		}
	}
	Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: FakeMutationObserver });
	Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: target } });
	t.after(() => {
		if (originalObserver) Object.defineProperty(globalThis, 'MutationObserver', originalObserver);
		else delete globalThis.MutationObserver;
		if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
		else delete globalThis.document;
	});
	return { target, observers, FakeMutationObserver };
}

function characterMutation() {
	return { type: 'characterData', addedNodes: [], removedNodes: [] };
}

test('text churn is absent unless explicitly enabled', t => {
	const { observers } = observerEnvironment(t);
	assert.equal(installSqlResultGridTextChurnObserver(), undefined);
	assert.equal(installSqlResultGridTextChurnObserver({ enabled: false }), undefined);
	assert.equal(installSqlResultGridTextChurnObserver({ enabled: 'true' }), undefined);
	assert.equal(
		installSqlResultGridTextChurnObserver({
			enabled: false,
			get target() {
				throw new Error('disabled instrumentation accessed its target');
			}
		}),
		undefined
	);
	assert.equal(observers.length, 0);
});

test('enabled text churn observes the document and counts delivered text changes', t => {
	const { target, observers } = observerEnvironment(t);
	const collector = installSqlResultGridTextChurnObserver({ enabled: true });
	const observer = observers[0];
	assert.equal(observers.length, 1);
	assert.equal(observer.target, target);
	assert.deepEqual(observer.options, { childList: true, subtree: true, characterData: true });
	observer.pending.push(characterMutation(), characterMutation(), {
		type: 'childList',
		addedNodes: [{ nodeType: 3 }, { nodeType: 1 }],
		removedNodes: [{ nodeType: 3 }, { nodeType: 3 }, { nodeType: 1 }]
	});
	observer.deliver();
	assert.deepEqual(collector.snapshot(), { textWrites: 2, addedNodes: 1, removedNodes: 2, mutations: 3 });
	collector.dispose();
});

test('snapshot drains queued mutations once and returns an independent value', t => {
	const { observers } = observerEnvironment(t);
	const collector = installSqlResultGridTextChurnObserver({ enabled: true });
	observers[0].pending.push(characterMutation());
	const snapshot = collector.snapshot();
	assert.deepEqual(snapshot, { textWrites: 1, addedNodes: 0, removedNodes: 0, mutations: 1 });
	snapshot.textWrites = 999;
	observers[0].deliver();
	assert.deepEqual(collector.snapshot(), { textWrites: 1, addedNodes: 0, removedNodes: 0, mutations: 1 });
	collector.dispose();
});

test('reset discards delivered and pending changes before the next phase', t => {
	const { observers } = observerEnvironment(t);
	const collector = installSqlResultGridTextChurnObserver({ enabled: true });
	const observer = observers[0];
	observer.pending.push(characterMutation());
	observer.deliver();
	observer.pending.push(characterMutation(), characterMutation());
	collector.reset();
	observer.deliver();
	assert.deepEqual(collector.snapshot(), { textWrites: 0, addedNodes: 0, removedNodes: 0, mutations: 0 });
	observer.pending.push(characterMutation());
	assert.deepEqual(collector.snapshot(), { textWrites: 1, addedNodes: 0, removedNodes: 0, mutations: 1 });
	collector.dispose();
});

test('dispose retains the final count and disconnects idempotently', t => {
	const { observers } = observerEnvironment(t);
	const collector = installSqlResultGridTextChurnObserver({ enabled: true });
	const observer = observers[0];
	observer.pending.push(characterMutation());
	collector.dispose();
	collector.dispose();
	observer.callback([characterMutation()]);
	assert.equal(observer.disconnects, 1);
	assert.deepEqual(collector.snapshot(), { textWrites: 1, addedNodes: 0, removedNodes: 0, mutations: 1 });
});

test('independent collectors keep their counters and targets separate', t => {
	const { observers } = observerEnvironment(t);
	const firstTarget = {};
	const secondTarget = {};
	const first = installSqlResultGridTextChurnObserver({ enabled: true, target: firstTarget });
	const second = installSqlResultGridTextChurnObserver({ enabled: true, target: secondTarget });
	assert.equal(observers[0].target, firstTarget);
	assert.equal(observers[1].target, secondTarget);
	observers[0].pending.push(characterMutation());
	assert.equal(first.snapshot().textWrites, 1);
	assert.equal(second.snapshot().textWrites, 0);
	first.dispose();
	second.dispose();
});

test('the text churn installer works when stringified into an isolated page', t => {
	const { FakeMutationObserver, observers } = observerEnvironment(t);
	const context = vm.createContext({ MutationObserver: FakeMutationObserver, document: { documentElement: {} } });
	const installInPage = vm.runInContext(`(${installSqlResultGridTextChurnObserver.toString()})`, context);
	assert.equal(installInPage(), undefined);
	const collector = installInPage({ enabled: true });
	observers[0].pending.push(characterMutation());
	assert.deepEqual({ ...collector.snapshot() }, { textWrites: 1, addedNodes: 0, removedNodes: 0, mutations: 1 });
	collector.dispose();
});

test('the emitted benchmark page installs a global DOM observer only for explicit text churn traces', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'nyala-text-churn-page-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const pagePath = join(directory, 'page.html');
	const bundlePath = join(directory, 'bare.js');
	await writeFile(bundlePath, 'globalThis.__NYALA_TEST_BARE_BUNDLE__ = true;\n');
	await promisify(execFile)(
		process.execPath,
		[
			new URL('./benchmark-sql-result-grid.mjs', import.meta.url).pathname,
			'--emit-page',
			pagePath,
			'--renderer',
			'zeus',
			'--zeus-bundle',
			bundlePath
		],
		{ timeout: 5_000 }
	);
	const page = await readFile(pagePath, 'utf8');
	const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
	assert.ok(script, 'the emitted page must carry its classic startup script');
	for (const query of [
		'floorOnly=true&diagnosticProfile=true',
		'segmentTrace=true&measureNodeChurn=false',
		'jankTrace=true',
		'segmentTrace=true&textChurn=true',
		'textChurn=true'
	]) {
		await t.test(query, () => {
			let observerCount = 0;
			const listeners = [];
			const context = vm.createContext({
				URLSearchParams,
				location: { search: '?deferStart=true&' + query },
				document: { documentElement: {} },
				MutationObserver: class {
					constructor() {
						observerCount += 1;
					}
					observe() {}
					takeRecords() {
						return [];
					}
					disconnect() {}
				},
				addEventListener: (...listener) => listeners.push(listener)
			});
			if (query === 'textChurn=true') {
				assert.throws(() => vm.runInContext(script, context), /requires a diagnostic segment trace/);
				assert.equal(observerCount, 0);
				assert.equal(listeners.length, 0);
				return;
			}
			vm.runInContext(script, context);
			assert.equal(observerCount, query.includes('textChurn=true') ? 1 : 0);
			assert.equal(listeners.length, 1);
			assert.equal(listeners[0][0], 'nyala-benchmark-start');
			assert.equal(context.__nyalaTextChurn, undefined);
			assert.equal(context.__nyalaChurnObserver, undefined);
		});
	}
});
