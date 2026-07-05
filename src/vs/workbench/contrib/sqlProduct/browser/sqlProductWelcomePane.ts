/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product welcome pane (Phase 08 §2.6 ViewPane).
 *
 * Renders the four canonical welcome actions committed in
 * `docs/sql-mvp-phases/phase-08-mvp-packaging.md` §2.6. The pane
 * owns a `SqlProductWelcomeView` model (a Disposable with an
 * `onAct` emitter) and forwards clicked tiles to the
 * `ICommandService`, mapping each action id to the matching
 * command:
 *
 *   * `open.demo`         -> `sqlStudio.product.bootstrapDemo`
 *                            (already wired by Phase 08 §2.4)
 *   * `new.connection`    -> `workbench.view.sqlConnections` focus
 *   * `open.history`      -> `sqlStudio.queryHistory` view focus
 *   * `docs.shortcuts`    -> `workbench.action.showCommands` so the
 *                            user lands on the keybindings page
 *
 * The pane lives in the SQL Results panel (same container as the
 * Preferences view) so it shares the user-facing toggle surface
 * with the rest of the SQL product. It does *not* auto-open on
 * first launch; the host either fires the welcome from a startup
 * contribution or the user pulls it up via the View menu.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { SQL_PRODUCT_WELCOME_VIEW_ID } from '../common/sqlProduct.js';
import {
	mapWelcomeActionToCommandId
} from './sqlProductWelcomeRouting.js';
import { SqlProductWelcomeView, WelcomeAction } from './sqlProductWelcomeView.js';

// Re-export for other browser-side contributors; the canonical
// definition lives in `common/sqlProduct.ts`.
export { SQL_PRODUCT_WELCOME_VIEW_ID };

const WELCOME_PRIMARY_LABEL = localize('sqlProductWelcomePrimary', 'Open the demo database');
const WELCOME_PRIMARY_HINT = localize(
	'sqlProductWelcomePrimaryHint',
	'Bootstraps the local SQLite demo database, opens the connection, and runs `SELECT 1`.'
);

export class SqlProductWelcomePane extends ViewPane {
	static readonly ID = SQL_PRODUCT_WELCOME_VIEW_ID;
	static readonly NAME = localize('sqlProductWelcomeName', 'Welcome');

	private readonly renderDisposables = this._register(new DisposableStore());

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ICommandService private readonly commandService: ICommandService
	) {
		super(
			options,
			keybindingService,
			contextMenuService,
			configurationService,
			contextKeyService,
			viewDescriptorService,
			instantiationService,
			openerService,
			themeService,
			hoverService
		);
	}

	protected override renderBody(container: HTMLElement): void {
		const root = append(container, $('.sql-product-welcome-view'));
		append(root, $('h3.sql-product-welcome-title', undefined, 'Welcome to Nyala Studio'));
		append(
			root,
			$(
				'p.sql-product-welcome-lede',
				undefined,
				'Pick one of the four starting points below. The first one is the fastest way to see the workbench in action.'
			)
		);

		const welcome = new SqlProductWelcomeView();
		this._register(welcome);

		this._register(welcome.onAct(action => this.dispatch(action)));

		const list = append(root, $('.sql-product-welcome-actions'));
		for (const action of welcome.actions()) {
			this.renderAction(list, welcome, action);
		}
	}

	private renderAction(parent: HTMLElement, welcome: SqlProductWelcomeView, action: WelcomeAction): void {
		const tile = append(parent, $('button.sql-product-welcome-action', {
			type: 'button',
			role: 'button',
			'aria-label': action.label
		}));

		if (action.primary) {
			tile.classList.add('sql-product-welcome-action--primary');
			append(tile, $('strong.sql-product-welcome-action-label', undefined, WELCOME_PRIMARY_LABEL));
			append(tile, $('span.sql-product-welcome-action-hint', undefined, WELCOME_PRIMARY_HINT));
		} else {
			append(tile, $('span.sql-product-welcome-action-label', undefined, action.label));
		}

		this.renderDisposables.add(
			addDisposableListener(tile, 'click', () => welcome.fire(action))
		);
	}

	private async dispatch(action: WelcomeAction): Promise<void> {
		const commandId = mapWelcomeActionToCommandId(action.id);
		if (commandId === undefined) {
			// Unknown action id — swallow rather than throw so a
			// stale tile cannot break the pane.
			return;
		}
		try {
			await this.commandService.executeCommand(commandId);
		} catch {
			// Routing failures (missing command, denied action, etc.)
			// are intentionally silent here: the welcome pane is a
			// pointer surface, the host notification service carries
			// the actual error message.
		}
	}

	override focus(): void {
		super.focus();
		const first = this.element?.querySelector<HTMLElement>('.sql-product-welcome-action');
		first?.focus();
	}
}