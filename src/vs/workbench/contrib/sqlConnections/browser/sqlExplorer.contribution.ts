/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL Explorer (Phase 02) workbench contribution.
 *
 * Registers a side-by-side view that consumes the Phase 02
 * `SqlConnectionTreeModel`. The legacy `SqlConnectionsView` stays in
 * place unchanged so the existing save/open form still works.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlConnections.css';

import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import {
	Extensions as ViewContainerExtensions,
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainer,
	ViewContainerLocation
} from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { SqlExplorerView } from './sqlExplorerView.js';
import {
	SQL_EXPLORER_FOCUS_COMMAND_ID,
	SQL_EXPLORER_STORAGE_ID,
	SQL_EXPLORER_VIEW_ID,
	SQL_EXPLORER_VIEWLET_ID
} from '../common/sqlExplorer.contribution.js';

export {
	SQL_EXPLORER_FOCUS_COMMAND_ID,
	SQL_EXPLORER_STORAGE_ID,
	SQL_EXPLORER_VIEW_ID,
	SQL_EXPLORER_VIEWLET_ID
};

const sqlExplorerIcon = registerIcon(
	'sql-explorer-view-icon',
	Codicon.listTree,
	localize('sqlExplorerViewIcon', 'View icon of the SQL Explorer view.')
);

class SqlExplorerViewPaneContainer extends ViewPaneContainer {
	override create(parent: HTMLElement): void {
		super.create(parent);
		parent.classList.add('sql-explorer-viewlet');
	}
}

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);

export const SQL_EXPLORER_VIEW_CONTAINER: ViewContainer = viewContainerRegistry.registerViewContainer(
	{
		id: SQL_EXPLORER_VIEWLET_ID,
		title: localize2('sqlExplorer', 'SQL Explorer'),
		ctorDescriptor: new SyncDescriptor(SqlExplorerViewPaneContainer),
		storageId: SQL_EXPLORER_STORAGE_ID,
		icon: sqlExplorerIcon,
		alwaysUseContainerInfo: true,
		hideIfEmpty: false,
		order: 2,
		openCommandActionDescriptor: {
			id: SQL_EXPLORER_FOCUS_COMMAND_ID,
			title: localize2('sqlExplorer', 'SQL Explorer'),
			mnemonicTitle: localize({ key: 'miViewSqlExplorer', comment: ['&& denotes a mnemonic'] }, 'SQL &&Explorer'),
			order: 2
		}
	},
	ViewContainerLocation.Sidebar
);

const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

viewsRegistry.registerViews(
	[
		{
			id: SQL_EXPLORER_VIEW_ID,
			name: localize2('sqlExplorerView', 'SQL Explorer'),
			containerIcon: sqlExplorerIcon,
			ctorDescriptor: new SyncDescriptor(SqlExplorerView),
			order: 0,
			canMoveView: false,
			canToggleVisibility: true
		}
	],
	SQL_EXPLORER_VIEW_CONTAINER
);