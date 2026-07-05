/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product welcome view model (Phase 08 §2.6).
 *
 * Owns the action list the welcome view renders on first launch and
 * an emitter so the host view can route an action click into the
 * existing command palette. This is intentionally a thin model: the
 * actual DOM rendering lives in a `ViewPane` subclass (out of scope
 * for Phase 08 §2.6), and the action `id`s here are stable strings
 * that the host view can translate into command invocations.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';

export interface WelcomeAction {
	readonly id: string;
	readonly label: string;
	readonly primary?: boolean;
}

/**
 * Stable action ids used by the welcome view. Other contributions
 * re-export these so the host view can map a clicked tile to the
 * matching command without stringly-typing the id at every layer.
 */
export const WELCOME_ACTION_IDS = {
	openDemo: 'open.demo',
	newConnection: 'new.connection',
	openHistory: 'open.history',
	docsShortcuts: 'docs.shortcuts'
} as const;

export type WelcomeActionId = (typeof WELCOME_ACTION_IDS)[keyof typeof WELCOME_ACTION_IDS];

export class SqlProductWelcomeView extends Disposable {
	declare readonly _brand: 'SqlProductWelcomeView';

	private readonly _onAct = this._register(new Emitter<WelcomeAction>());
	readonly onAct: Event<WelcomeAction> = this._onAct.event;

	/**
	 * Returns the four canonical welcome actions. Order is significant:
	 * the primary "open.demo" action is first.
	 */
	actions(): WelcomeAction[] {
		return [
			{ id: WELCOME_ACTION_IDS.openDemo, label: 'Open demo database', primary: true },
			{ id: WELCOME_ACTION_IDS.newConnection, label: 'Add a connection' },
			{ id: WELCOME_ACTION_IDS.openHistory, label: 'Browse history' },
			{ id: WELCOME_ACTION_IDS.docsShortcuts, label: 'Show shortcuts' }
		];
	}

	/**
	 * Fire a welcome action. The host view calls this when the user
	 * clicks a tile; listeners can map the action id to a command or
	 * command palette invocation.
	 */
	fire(action: WelcomeAction): void {
		this._onAct.fire(action);
	}
}