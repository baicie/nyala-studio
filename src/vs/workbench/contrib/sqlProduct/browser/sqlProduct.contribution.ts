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
import {
	ISqlProductPreferencesService,
	SqlProductPreferencesService
} from '../common/sqlProductPreferencesService.js';
import { SqlProductBootstrapContribution } from './sqlProductBootstrap.js';
import {
	SQL_PRODUCT_PREFERENCES_VIEW_ID,
	SqlProductPreferencesView
} from './sqlProductPreferencesView.js';
import './sqlProductActions.js';
import './media/sqlProductPreferences.css';

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
		}
	],
	SQL_RESULT_VIEW_CONTAINER
);

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution2(
	'workbench.contrib.sqlProductBootstrap',
	SqlProductBootstrapContribution,
	WorkbenchPhase.AfterRestored
);
