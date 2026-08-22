/*---------------------------------------------------------------------------------------------
 * SQL Workspace Agent panel contribution.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlAgent.css';

import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
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
	Extensions as ViewExtensions,
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainer,
	ViewContainerLocation
} from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { SqlAgentView, SQL_AGENT_VIEW_ID, SQL_AGENT_VIEWLET_ID } from './sqlAgentView.js';

const sqlAgentIcon = registerIcon(
	'sql-agent-view-icon',
	Codicon.sparkle,
	localize('sqlAgentViewIcon', 'View icon of the SQL Agent panel.')
);

class SqlAgentViewPaneContainer extends ViewPaneContainer {
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
			SQL_AGENT_VIEWLET_ID,
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
}

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
const sqlAgentViewContainer: ViewContainer = viewContainerRegistry.registerViewContainer(
	{
		id: SQL_AGENT_VIEWLET_ID,
		title: localize2('sqlAgentPanel', 'SQL Agent'),
		ctorDescriptor: new SyncDescriptor(SqlAgentViewPaneContainer),
		storageId: SQL_AGENT_VIEWLET_ID,
		icon: sqlAgentIcon,
		alwaysUseContainerInfo: true,
		hideIfEmpty: false,
		order: 2,
		openCommandActionDescriptor: {
			id: 'sql.agent.openPanel',
			title: localize2('sqlAgentOpenPanel', 'SQL Agent')
		}
	},
	ViewContainerLocation.Panel
);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews(
	[
		{
			id: SQL_AGENT_VIEW_ID,
			name: localize2('sqlAgentView', 'Agent'),
			containerIcon: sqlAgentIcon,
			ctorDescriptor: new SyncDescriptor(SqlAgentView),
			order: 0,
			canMoveView: false,
			canToggleVisibility: false
		}
	],
	sqlAgentViewContainer
);
