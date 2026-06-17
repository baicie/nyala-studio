/*---------------------------------------------------------------------------------------------
 * SQL Studio Next — Low-level Tauri IPC bridge.
 * Wraps `window.__TAURI__` with a graceful fallback when running outside
 * the Tauri webview, such as in a plain browser during development.
 *--------------------------------------------------------------------------------------------*/

declare global {
	interface Window {
		__TAURI__?: {
			core: {
				invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
			};
		};
	}
}

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

function getTauriWindow(): Window | undefined {
	if (typeof window === 'undefined') {
		return undefined;
	}

	return window;
}

function getInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
	if (_invoke) {
		return _invoke;
	}

	const tauriWindow = getTauriWindow();

	if (tauriWindow?.__TAURI__?.core?.invoke) {
		_invoke = tauriWindow.__TAURI__.core.invoke;
		return _invoke;
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
