/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Connections workbench contribution.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlConnections.css';

import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
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
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import {
	Extensions,
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainer,
	ViewContainerLocation
} from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IEditorPaneRegistry, EditorPaneDescriptor } from '../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { SqlConnectionsView } from './sqlConnectionsView.js';
import { SqlConnectionKind, type SqlSavedConnection } from '../../../services/sql/common/sqlTypes.js';
import { ISqlConnectionDialogService } from '../../../services/sql/common/sqlConnectionDialog.js';
import { SqlConnectionEditorInput } from '../../../services/sql/common/sqlConnectionEditorInput.js';
import { SqlConnectionDialogService } from './sqlConnectionDialogService.js';
import { SqlConnectionEditorPane } from './sqlConnectionEditorPane.js';
import { openNewSqlDataSourceForm, openSavedSqlDataSourceForm } from '../common/sqlConnectionNavigation.js';
import {
	SQL_CONNECTIONS_FOCUS_COMMAND_ID,
	SQL_CONNECTIONS_ADD_COMMAND_ID,
	SQL_CONNECTIONS_REFRESH_COMMAND_ID,
	SQL_CONNECTIONS_STORAGE_ID,
	SQL_CONNECTIONS_VIEW_ID,
	SQL_CONNECTIONS_VIEWLET_ID,
	SQL_CONNECTORS_FOCUS_COMMAND_ID,
	SQL_CONNECTORS_OPEN_SAVED_COMMAND_ID,
	SQL_CONNECTORS_STORAGE_ID,
	SQL_CONNECTORS_VIEW_ID,
	SQL_CONNECTORS_VIEWLET_ID
} from '../common/sqlConnections.js';

class SqlAddConnectionAction extends Action2 {
	constructor() {
		super({
			id: SQL_CONNECTIONS_ADD_COMMAND_ID,
			title: localize2('sqlConnectionsAdd', 'Nyala: New Data Source'),
			category: Categories.View,
			f1: true,
			icon: Codicon.add,
			menu: [
				{ id: MenuId.CommandPalette },
				{
					id: MenuId.ViewTitle,
					when: ContextKeyExpr.equals('view', SQL_CONNECTIONS_VIEW_ID),
					group: 'navigation',
					order: 1
				}
			]
		});
	}

	override async run(accessor: ServicesAccessor, kind: SqlConnectionKind = SqlConnectionKind.Sqlite): Promise<void> {
		await openNewSqlDataSourceForm(accessor.get(ISqlConnectionDialogService), kind);
	}
}

class SqlOpenSavedConnectionAction extends Action2 {
	constructor() {
		super({
			id: SQL_CONNECTORS_OPEN_SAVED_COMMAND_ID,
			title: localize2('sqlConnectorsOpenSaved', 'Nyala: Open Saved Data Source'),
			f1: false
		});
	}

	override async run(accessor: ServicesAccessor, saved?: SqlSavedConnection): Promise<void> {
		await openSavedSqlDataSourceForm(accessor.get(ISqlConnectionDialogService), saved);
	}
}

class SqlRefreshConnectionsAction extends Action2 {
	constructor() {
		super({
			id: SQL_CONNECTIONS_REFRESH_COMMAND_ID,
			title: localize2('sqlConnectionsRefresh', 'Nyala: Refresh Connections'),
			category: Categories.View,
			f1: true,
			icon: Codicon.refresh,
			menu: [
				{ id: MenuId.CommandPalette },
				{
					id: MenuId.ViewTitle,
					when: ContextKeyExpr.equals('view', SQL_CONNECTIONS_VIEW_ID),
					group: 'navigation',
					order: 2
				}
			]
		});
	}

	override async run(accessor: ServicesAccessor, options?: { readonly revealConnectionId?: string }): Promise<void> {
		const view = await accessor.get(IViewsService).openView<SqlConnectionsView>(SQL_CONNECTIONS_VIEW_ID, true);
		if (typeof options?.revealConnectionId === 'string') {
			await view?.refreshAndRevealConnection(options.revealConnectionId);
			return;
		}
		await view?.refresh();
	}
}

const sqlDataSourcesIcon = registerIcon(
	'sql-data-sources-view-icon',
	Codicon.database,
	localize('sqlDataSourcesViewIcon', 'View icon of the SQL data sources view.')
);

const sqlConnectorsIcon = registerIcon(
	'sql-connectors-view-icon',
	Codicon.plug,
	localize('sqlConnectorsViewIcon', 'View icon of the SQL connectors view.')
);

class SqlConnectionViewPaneContainer extends ViewPaneContainer {
	constructor(
		viewletId: string,
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
			viewletId,
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
		title: localize2('sqlDataSources', 'Data Sources'),
		ctorDescriptor: new SyncDescriptor(SqlConnectionViewPaneContainer, [SQL_CONNECTIONS_VIEWLET_ID]),
		storageId: SQL_CONNECTIONS_STORAGE_ID,
		icon: sqlDataSourcesIcon,
		alwaysUseContainerInfo: true,
		hideIfEmpty: false,
		order: 1,
		openCommandActionDescriptor: {
			id: SQL_CONNECTIONS_FOCUS_COMMAND_ID,
			title: localize2('sqlDataSources', 'Data Sources'),
			mnemonicTitle: localize({ key: 'miViewSqlDataSources', comment: ['&& denotes a mnemonic'] }, '&&Data Sources'),
			order: 1
		}
	},
	ViewContainerLocation.Sidebar
);

export const SQL_CONNECTORS_VIEW_CONTAINER: ViewContainer = viewContainerRegistry.registerViewContainer(
	{
		id: SQL_CONNECTORS_VIEWLET_ID,
		title: localize2('sqlConnectors', 'Connectors'),
		ctorDescriptor: new SyncDescriptor(SqlConnectionViewPaneContainer, [SQL_CONNECTORS_VIEWLET_ID]),
		storageId: SQL_CONNECTORS_STORAGE_ID,
		icon: sqlConnectorsIcon,
		alwaysUseContainerInfo: true,
		hideIfEmpty: false,
		order: 2,
		openCommandActionDescriptor: {
			id: SQL_CONNECTORS_FOCUS_COMMAND_ID,
			title: localize2('sqlConnectors', 'Connectors'),
			mnemonicTitle: localize({ key: 'miViewSqlConnectors', comment: ['&& denotes a mnemonic'] }, '&&Connectors'),
			order: 2
		}
	},
	ViewContainerLocation.Sidebar
);

const viewsRegistry = Registry.as<IViewsRegistry>(Extensions.ViewsRegistry);

MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: {
		id: SQL_CONNECTORS_FOCUS_COMMAND_ID,
		title: localize2('sqlConnectionsManageConnectors', 'Manage Connectors')
	},
	when: ContextKeyExpr.equals('view', SQL_CONNECTIONS_VIEW_ID),
	group: '2_manage',
	order: 1
});

viewsRegistry.registerViews(
	[
		{
			id: SQL_CONNECTIONS_VIEW_ID,
			name: localize2('sqlDataSourcesView', 'Data Sources'),
			containerIcon: sqlDataSourcesIcon,
			ctorDescriptor: new SyncDescriptor(SqlConnectionsView),
			order: 0,
			canMoveView: false,
			canToggleVisibility: false
		}
	],
	SQL_CONNECTIONS_VIEW_CONTAINER
);

viewsRegistry.registerViews(
	[
		{
			id: SQL_CONNECTORS_VIEW_ID,
			name: localize2('sqlConnectorsView', 'New Data Source'),
			containerIcon: sqlConnectorsIcon,
			ctorDescriptor: new SyncDescriptor(SqlConnectionsView),
			order: 0,
			canMoveView: false,
			canToggleVisibility: false
		}
	],
	SQL_CONNECTORS_VIEW_CONTAINER
);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		SqlConnectionEditorPane,
		SqlConnectionEditorPane.ID,
		localize('sqlConnectionEditor', 'Data Source')
	),
	[new SyncDescriptor(SqlConnectionEditorInput)]
);

registerSingleton(ISqlConnectionDialogService, SqlConnectionDialogService, InstantiationType.Delayed);

registerAction2(SqlAddConnectionAction);
registerAction2(SqlOpenSavedConnectionAction);
registerAction2(SqlRefreshConnectionsAction);
