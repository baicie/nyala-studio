/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Splash dismissal contribution.
 *
 * The static splash overlay (see `public/splash.css` and the splash
 * markup in `index.html`) is rendered immediately when the page loads
 * so the WebView never shows a blank white screen during the workbench
 * boot. This contribution disposes the splash once the workbench has
 * finished the layout restore phase.
 *
 * The dismissal is implemented in two stages so the visual is right:
 *
 *   1. Add `.nyala-splash--hidden` so the CSS opacity transition runs;
 *   2. After the transition (or the fallback timeout) remove the
 *      element from the DOM so it stops capturing input.
 *
 * A 12-second safety timer always runs, even if the restored phase
 * never fires (for example because of a broken restore), so the user
 * is never stuck staring at "Booting workbench…".
 *--------------------------------------------------------------------------------------------*/

import {
	Disposable,
	DisposableStore,
	IDisposable,
	MutableDisposable,
	toDisposable
} from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

export const NYALA_SPLASH_ELEMENT_ID = 'nyala-splash';
const NYALA_SPLASH_HIDDEN_CLASS = 'nyala-splash--hidden';
const NYALA_SPLASH_SAFETY_TIMEOUT_MS = 12_000;
const NYALA_SPLASH_TRANSITION_TIMEOUT_MS = 360;

export interface ISplashTimerHost {
	setTimeout(callback: () => void, delay: number): number;
	clearTimeout(handle: number): void;
}

const browserSplashTimerHost: ISplashTimerHost = {
	setTimeout: (callback, delay) => window.setTimeout(callback, delay),
	clearTimeout: handle => window.clearTimeout(handle)
};

export function beginSplashDismissal(
	splash: HTMLElement,
	timerHost: ISplashTimerHost = browserSplashTimerHost
): IDisposable {
	const resources = new DisposableStore();
	let finalized = false;

	const finalize = () => {
		if (finalized) {
			return;
		}

		finalized = true;
		resources.dispose();
		splash.parentElement?.removeChild(splash);
	};

	splash.classList.add(NYALA_SPLASH_HIDDEN_CLASS);
	splash.addEventListener('transitionend', finalize, { once: true });
	resources.add(toDisposable(() => splash.removeEventListener('transitionend', finalize)));

	const transitionTimer = timerHost.setTimeout(finalize, NYALA_SPLASH_TRANSITION_TIMEOUT_MS);
	resources.add(toDisposable(() => timerHost.clearTimeout(transitionTimer)));

	return resources;
}

export function disposeSplashNow(reason: 'restored' | 'timeout' | 'manual', logService: ILogService): IDisposable {
	const splash = document.getElementById(NYALA_SPLASH_ELEMENT_ID);
	if (!splash) {
		return Disposable.None;
	}

	logService.debug(`[Nyala] splash dismissed (${reason})`);
	return beginSplashDismissal(splash);
}

/**
 * Disposes the splash screen the first time the workbench lifecycle
 * reaches the `Restored` phase. Falls back to a timeout so a failed
 * restore never leaves the overlay on screen.
 */
export class SqlWorkbenchSplashContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.sqlWorkbenchSplash';

	private readonly safetyTimer = this._register(new MutableDisposable<IDisposable>());
	private readonly splashDismissal = this._register(new MutableDisposable<IDisposable>());
	private didDismiss = false;
	private isDisposed = false;

	constructor(
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		const safetyTimer = window.setTimeout(() => this.dismiss('timeout'), NYALA_SPLASH_SAFETY_TIMEOUT_MS);
		this.safetyTimer.value = toDisposable(() => window.clearTimeout(safetyTimer));

		this.lifecycleService
			.when(LifecyclePhase.Restored)
			.then(() => this.dismiss('restored'))
			.catch(() => {
				// Lifecycle failed before reaching Restored. The safety
				// timer still fires below.
			});
	}

	private dismiss(reason: 'restored' | 'timeout'): void {
		if (this.isDisposed || this.didDismiss) {
			return;
		}

		this.didDismiss = true;
		this.safetyTimer.clear();
		this.splashDismissal.value = disposeSplashNow(reason, this.logService);
	}

	override dispose(): void {
		this.isDisposed = true;
		super.dispose();
	}
}
