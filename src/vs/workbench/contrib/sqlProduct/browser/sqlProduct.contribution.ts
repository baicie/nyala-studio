/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product contribution.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	Extensions as WorkbenchExtensions,
	IWorkbenchContributionsRegistry,
	WorkbenchPhase
} from '../../../common/contributions.js';
import { Extensions as ViewExtensions, IViewsRegistry } from '../../../common/views.js';
import { SQL_RESULT_VIEW_CONTAINER } from '../../sqlResult/browser/sqlResult.contribution.js';
import { ISqlProductPreferencesService, SqlProductPreferencesService } from '../common/sqlProductPreferencesService.js';
import { SqlProductBootstrapContribution } from './sqlProductBootstrap.js';
import { SQL_PRODUCT_PREFERENCES_VIEW_ID, SqlProductPreferencesView } from './sqlProductPreferencesView.js';
import { SqlProductWelcomePane, SQL_PRODUCT_WELCOME_VIEW_ID } from './sqlProductWelcomePane.js';
import { SqlProductWelcomeView, WELCOME_ACTION_IDS } from './sqlProductWelcomeView.js';
import { SqlWorkbenchSplashContribution } from './sqlWorkbenchSplash.js';
import './sqlProductActions.js';
import './media/sqlProductPreferences.css';
import './media/sqlProductWelcome.css';

registerSingleton(ISqlProductPreferencesService, SqlProductPreferencesService, InstantiationType.Delayed);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews(
	[
		{
			id: SQL_PRODUCT_PREFERENCES_VIEW_ID,
			name: localize2('sqlProductPreferencesView', 'Preferences'),
			ctorDescriptor: new SyncDescriptor(SqlProductPreferencesView),
			order: 2,
			canMoveView: false,
			canToggleVisibility: true,
			focusCommand: {
				id: `${SQL_PRODUCT_PREFERENCES_VIEW_ID}.focus`
			}
		},
		{
			id: SQL_PRODUCT_WELCOME_VIEW_ID,
			name: localize2('sqlProductWelcomeView', 'Welcome'),
			ctorDescriptor: new SyncDescriptor(SqlProductWelcomePane),
			order: 1,
			canMoveView: false,
			canToggleVisibility: true,
			focusCommand: {
				id: `${SQL_PRODUCT_WELCOME_VIEW_ID}.focus`
			}
		}
	],
	SQL_RESULT_VIEW_CONTAINER
);

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution2(
	'workbench.contrib.sqlProductBootstrap',
	SqlProductBootstrapContribution,
	WorkbenchPhase.AfterRestored
);

// Register at startup so the 12-second safety timer also protects a
// workbench that never reaches Restored. The contribution itself waits
// for Restored before beginning the normal dismissal transition.
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution2(
	SqlWorkbenchSplashContribution.ID,
	SqlWorkbenchSplashContribution,
	WorkbenchPhase.BlockStartup
);

// Phase 08 §2.6 welcome view model + ViewPane. The pane is the
// renderer for the `SqlProductWelcomeView` model; both are
// re-exported from the contribution root so other contributions
// can pull them without reaching into `browser/`.
export { SqlProductWelcomeView, WELCOME_ACTION_IDS, SqlProductWelcomePane, SQL_PRODUCT_WELCOME_VIEW_ID };
