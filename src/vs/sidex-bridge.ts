/*---------------------------------------------------------------------------------------------
 * SQL Studio Next — Low-level Tauri IPC bridge.
 * Wraps the Tauri v2 core API with a graceful fallback when running outside
 * the Tauri webview, such as in a plain browser during development.
 *--------------------------------------------------------------------------------------------*/

import { invoke as tauriInvoke, isTauri as isTauriRuntime } from '@tauri-apps/api/core';

declare global {
	interface Window {
		__TAURI__?: {
			core: {
				invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
			};
		};
	}
}

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function getTauriWindow(): Window | undefined {
	if (typeof window === 'undefined') {
		return undefined;
	}

	return window;
}

function getInvoke(): TauriInvoke | null {
	const tauriWindow = getTauriWindow();

	if (tauriWindow?.__TAURI__?.core?.invoke) {
		return tauriWindow.__TAURI__.core.invoke;
	}

	if (isTauriRuntime()) {
		return tauriInvoke;
	}

	return null;
}

export async function invoke<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
	const fn = getInvoke();

	if (!fn) {
		console.warn(`[SQL Studio] invoke(${cmd}) — Tauri not available`);
		return null as unknown as T;
	}

	return fn(cmd, args) as Promise<T>;
}

export function isTauri(): boolean {
	return getInvoke() !== null;
}
