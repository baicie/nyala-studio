/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Connections workbench contribution.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlConnections.css';

import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	Extensions,
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainer,
	ViewContainerLocation
} from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { SqlConnectionsView } from './sqlConnectionsView.js';
import {
	SQL_CONNECTIONS_FOCUS_COMMAND_ID,
	SQL_CONNECTIONS_STORAGE_ID,
	SQL_CONNECTIONS_VIEW_ID,
	SQL_CONNECTIONS_VIEWLET_ID
} from '../common/sqlConnections.js';

const sqlConnectionsIcon = registerIcon(
	'sql-connections-view-icon',
	Codicon.repo,
	localize('sqlConnectionsViewIcon', 'View icon of the SQL Connections view.')
);

export class SqlConnectionsViewPaneContainer extends ViewPaneContainer {
	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IExtensionService extensionService: IExtensionService,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@ILogService logService: ILogService
	) {
		super(
			SQL_CONNECTIONS_VIEWLET_ID,
			{ mergeViewWithContainerWhenSingleView: true },
			instantiationService,
			configurationService,
			layoutService,
			contextMenuService,
			telemetryService,
			extensionService,
			themeService,
			storageService,
			contextService,
			viewDescriptorService,
			logService
		);
	}

	override create(parent: HTMLElement): void {
		super.create(parent);
		parent.classList.add('sql-connections-viewlet');
	}
}

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry);

export const SQL_CONNECTIONS_VIEW_CONTAINER: ViewContainer = viewContainerRegistry.registerViewContainer(
	{
		id: SQL_CONNECTIONS_VIEWLET_ID,
		title: localize2('sqlConnections', 'SQL Connections'),
		ctorDescriptor: new SyncDescriptor(SqlConnectionsViewPaneContainer),
		storageId: SQL_CONNECTIONS_STORAGE_ID,
		icon: sqlConnectionsIcon,
		alwaysUseContainerInfo: true,
		hideIfEmpty: false,
		order: 1,
		openCommandActionDescriptor: {
			id: SQL_CONNECTIONS_FOCUS_COMMAND_ID,
			title: localize2('sqlConnections', 'SQL Connections'),
			mnemonicTitle: localize({ key: 'miViewSqlConnections', comment: ['&& denotes a mnemonic'] }, 'SQL &&Connections'),
			order: 1
		}
	},
	ViewContainerLocation.Sidebar
);

const viewsRegistry = Registry.as<IViewsRegistry>(Extensions.ViewsRegistry);

viewsRegistry.registerViews(
	[
		{
			id: SQL_CONNECTIONS_VIEW_ID,
			name: localize2('sqlConnectionsView', 'Connections'),
			containerIcon: sqlConnectionsIcon,
			ctorDescriptor: new SyncDescriptor(SqlConnectionsView),
			order: 0,
			canMoveView: false,
			canToggleVisibility: false
		}
	],
	SQL_CONNECTIONS_VIEW_CONTAINER
);
