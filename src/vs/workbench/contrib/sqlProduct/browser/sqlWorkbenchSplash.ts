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

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

export const NYALA_SPLASH_ELEMENT_ID = 'nyala-splash';
const NYALA_SPLASH_HIDDEN_CLASS = 'nyala-splash--hidden';
const NYALA_SPLASH_SAFETY_TIMEOUT_MS = 12_000;
const NYALA_SPLASH_TRANSITION_TIMEOUT_MS = 360;

export function disposeSplashNow(reason: 'restored' | 'timeout' | 'manual'): void {
	const splash = document.getElementById(NYALA_SPLASH_ELEMENT_ID);
	if (!splash) {
		return;
	}

	splash.classList.add(NYALA_SPLASH_HIDDEN_CLASS);

	let cleared = false;
	const finalize = () => {
		if (cleared) {
			return;
		}
		cleared = true;
		if (splash.parentElement) {
			splash.parentElement.removeChild(splash);
		}
	};

	if (typeof splash.addEventListener === 'function') {
		splash.addEventListener('transitionend', finalize, { once: true });
		window.setTimeout(finalize, NYALA_SPLASH_TRANSITION_TIMEOUT_MS);
	} else {
		window.setTimeout(finalize, 16);
	}

	console.debug?.(`[Nyala] splash dismissed (${reason})`);
}

/**
 * Disposes the splash screen the first time the workbench lifecycle
 * reaches the `Restored` phase. Falls back to a timeout so a failed
 * restore never leaves the overlay on screen.
 */
export class SqlWorkbenchSplashContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.sqlWorkbenchSplash';

	private readonly disposables = this._register(new DisposableStore());
	private didDispose = false;

	constructor(@ILifecycleService private readonly lifecycleService: ILifecycleService) {
		super();

		this.lifecycleService
			.when(LifecyclePhase.Restored)
			.then(() => {
				if (this.didDispose) {
					return;
				}
				this.didDispose = true;
				disposeSplashNow('restored');
			})
			.catch(() => {
				// Lifecycle failed before reaching Restored. The safety
				// timer still fires below.
			});

		const safety = window.setTimeout(() => {
			if (!this.didDispose) {
				this.didDispose = true;
				disposeSplashNow('timeout');
			}
		}, NYALA_SPLASH_SAFETY_TIMEOUT_MS);
		this.disposables.add({ dispose: () => window.clearTimeout(safety) });
	}
}
