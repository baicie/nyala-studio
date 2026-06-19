/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Result workbench contribution.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlResult.css';
import '../../sqlHistory/browser/media/sqlQueryHistory.css';

import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
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
import {
	Extensions as WorkbenchExtensions,
	IWorkbenchContributionsRegistry,
	WorkbenchPhase
} from '../../../common/contributions.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import {
	SQL_RESULT_FOCUS_COMMAND_ID,
	SQL_RESULT_OPEN_COMMAND_ID,
	SQL_RESULT_STORAGE_ID,
	SQL_RESULT_VIEW_ID,
	SQL_RESULT_VIEWLET_ID
} from '../common/sqlResult.js';
import { ISqlResultService, SqlResultService } from '../common/sqlResultService.js';
import { SqlResultBridgeContribution } from './sqlResultBridge.js';
import { SqlResultView } from './sqlResultView.js';
import { ISqlQueryHistoryService, SqlQueryHistoryService } from '../../sqlHistory/common/sqlQueryHistoryService.js';
import { SqlQueryHistoryBridgeContribution } from '../../sqlHistory/browser/sqlQueryHistoryBridge.js';
import { SqlQueryHistoryView } from '../../sqlHistory/browser/sqlQueryHistoryView.js';

registerSingleton(ISqlResultService, SqlResultService, InstantiationType.Delayed);
registerSingleton(ISqlQueryHistoryService, SqlQueryHistoryService, InstantiationType.Delayed);

const sqlResultIcon = registerIcon(
	'sql-result-view-icon',
	Codicon.table,
	localize('sqlResultViewIcon', 'View icon of the SQL Results view.')
);

export class SqlResultViewPaneContainer extends ViewPaneContainer {
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
			SQL_RESULT_VIEWLET_ID,
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
		parent.classList.add('sql-result-panel');
	}
}

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);

export const SQL_RESULT_VIEW_CONTAINER: ViewContainer = viewContainerRegistry.registerViewContainer(
	{
		id: SQL_RESULT_VIEWLET_ID,
		title: localize2('sqlResults', 'SQL Results'),
		ctorDescriptor: new SyncDescriptor(SqlResultViewPaneContainer),
		storageId: SQL_RESULT_STORAGE_ID,
		icon: sqlResultIcon,
		alwaysUseContainerInfo: true,
		hideIfEmpty: false,
		order: 1,
		openCommandActionDescriptor: {
			id: SQL_RESULT_OPEN_COMMAND_ID,
			title: localize2('sqlResults', 'SQL Results'),
			mnemonicTitle: localize({ key: 'miViewSqlResults', comment: ['&& denotes a mnemonic'] }, 'SQL &&Results'),
			order: 1
		}
	},
	ViewContainerLocation.Panel
);

const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

viewsRegistry.registerViews(
	[
		{
			id: SQL_RESULT_VIEW_ID,
			name: localize2('sqlResultView', 'Results'),
			containerIcon: sqlResultIcon,
			ctorDescriptor: new SyncDescriptor(SqlResultView),
			order: 0,
			canMoveView: false,
			canToggleVisibility: false,
			focusCommand: {
				id: SQL_RESULT_FOCUS_COMMAND_ID
			}
		},
		{
			id: SqlQueryHistoryView.ID,
			name: localize2('sqlQueryHistoryView', 'Query History'),
			containerIcon: sqlResultIcon,
			ctorDescriptor: new SyncDescriptor(SqlQueryHistoryView),
			order: 1,
			canMoveView: false,
			canToggleVisibility: true
		}
	],
	SQL_RESULT_VIEW_CONTAINER
);

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution2(
	'workbench.contrib.sqlResultBridge',
	SqlResultBridgeContribution,
	WorkbenchPhase.AfterRestored
);

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution2(
	'workbench.contrib.sqlQueryHistoryBridge',
	SqlQueryHistoryBridgeContribution,
	WorkbenchPhase.AfterRestored
);
