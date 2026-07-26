import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { ILogService } from '../../../../platform/log/common/log.js';
import type { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import {
	beginSplashDismissal,
	ISplashTimerHost,
	NYALA_SPLASH_ELEMENT_ID,
	SqlWorkbenchSplashContribution
} from '../browser/sqlWorkbenchSplash.js';

const productContributionSource = readFileSync(
	new URL('../browser/sqlProduct.contribution.ts', import.meta.url),
	'utf8'
);

function createFakeSplashElement(): {
	element: HTMLElement;
	listeners: Set<EventListenerOrEventListenerObject>;
	state: { hidden: boolean; removed: boolean };
} {
	const listeners = new Set<EventListenerOrEventListenerObject>();
	const state = { hidden: false, removed: false };
	const element = {
		classList: {
			add: (className: string) => {
				state.hidden = className === 'nyala-splash--hidden';
			}
		},
		parentElement: {
			removeChild: (child: Node) => {
				assert.equal(child, element);
				state.removed = true;
				return child;
			}
		},
		addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
			listeners.add(listener);
		},
		removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
			listeners.delete(listener);
		}
	} as unknown as HTMLElement;

	return { element, listeners, state };
}

function createFakeTimerHost(): {
	host: ISplashTimerHost;
	pending: Map<number, () => void>;
} {
	let nextHandle = 1;
	const pending = new Map<number, () => void>();

	return {
		host: {
			setTimeout: callback => {
				const handle = nextHandle++;
				pending.set(handle, callback);
				return handle;
			},
			clearTimeout: handle => {
				pending.delete(handle);
			}
		},
		pending
	};
}

function fireListener(listener: EventListenerOrEventListenerObject): void {
	if (typeof listener === 'function') {
		listener({ type: 'transitionend' } as Event);
	} else {
		listener.handleEvent({ type: 'transitionend' } as Event);
	}
}

async function withBrowserGlobals<T>(
	windowValue: Pick<Window, 'setTimeout' | 'clearTimeout'>,
	documentValue: Pick<Document, 'getElementById'>,
	run: () => Promise<T>
): Promise<T> {
	const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');

	Object.defineProperty(globalThis, 'window', { configurable: true, value: windowValue });
	Object.defineProperty(globalThis, 'document', { configurable: true, value: documentValue });

	try {
		return await run();
	} finally {
		if (windowDescriptor) {
			Object.defineProperty(globalThis, 'window', windowDescriptor);
		} else {
			Reflect.deleteProperty(globalThis, 'window');
		}

		if (documentDescriptor) {
			Object.defineProperty(globalThis, 'document', documentDescriptor);
		} else {
			Reflect.deleteProperty(globalThis, 'document');
		}
	}
}

test('NYALA_SPLASH_ELEMENT_ID matches the static markup rendered by index.html', () => {
	assert.strictEqual(
		NYALA_SPLASH_ELEMENT_ID,
		'nyala-splash',
		'changing the splash element id requires updating the index.html markup in lockstep'
	);
});

test('SqlWorkbenchSplashContribution.ID is stable for the registry', async () => {
	assert.strictEqual(
		SqlWorkbenchSplashContribution.ID,
		'workbench.contrib.sqlWorkbenchSplash',
		'changing the contribution id would invalidate any contribution registry caches; keep it stable'
	);
});

test('splash safety timer starts during workbench startup', () => {
	assert.match(
		productContributionSource,
		/SqlWorkbenchSplashContribution\.ID,\s*SqlWorkbenchSplashContribution,\s*WorkbenchPhase\.BlockStartup/
	);
});

test('beginSplashDismissal releases its transition listener and timer when disposed', () => {
	const splash = createFakeSplashElement();
	const timers = createFakeTimerHost();
	const dismissal = beginSplashDismissal(splash.element, timers.host);

	assert.equal(splash.state.hidden, true);
	assert.equal(splash.listeners.size, 1);
	assert.equal(timers.pending.size, 1);

	dismissal.dispose();

	assert.equal(splash.listeners.size, 0);
	assert.equal(timers.pending.size, 0);
	assert.equal(splash.state.removed, false);
});

test('beginSplashDismissal finalizes and releases resources after the transition', () => {
	const splash = createFakeSplashElement();
	const timers = createFakeTimerHost();
	beginSplashDismissal(splash.element, timers.host);

	const listener = [...splash.listeners][0];
	assert.ok(listener);
	fireListener(listener);

	assert.equal(splash.state.removed, true);
	assert.equal(splash.listeners.size, 0);
	assert.equal(timers.pending.size, 0);
});

test('SqlWorkbenchSplashContribution clears safety timer and ignores lifecycle completion after dispose', async () => {
	const timers = createFakeTimerHost();
	let resolveRestored!: () => void;
	const restored = new Promise<void>(resolve => {
		resolveRestored = resolve;
	});
	let splashLookups = 0;

	await withBrowserGlobals(
		{
			setTimeout: timers.host.setTimeout as Window['setTimeout'],
			clearTimeout: timers.host.clearTimeout as Window['clearTimeout']
		},
		{
			getElementById: () => {
				splashLookups++;
				return null;
			}
		},
		async () => {
			const lifecycleService = { when: () => restored } as unknown as ILifecycleService;
			const logService = { debug: () => undefined } as unknown as ILogService;
			const contribution = new SqlWorkbenchSplashContribution(lifecycleService, logService);

			assert.equal(timers.pending.size, 1);
			contribution.dispose();
			assert.equal(timers.pending.size, 0);

			resolveRestored();
			await restored;
			await Promise.resolve();

			assert.equal(splashLookups, 0);
		}
	);
});
