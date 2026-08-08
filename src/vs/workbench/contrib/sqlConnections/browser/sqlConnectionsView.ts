/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Connections View.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlConnections.css';
import './media/driverCardBadge.css';
import './media/sqlConnectorBrand.css';

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ISqlConnectionService } from '../../../services/sql/common/sqlConnection.js';
import { ISqlConnectionDialogService } from '../../../services/sql/common/sqlConnectionDialog.js';
import { isTauri } from '../../../../sidex-bridge.js';
import { ISqlDriverCatalogService } from '../../../services/sql/common/sqlDriverCatalog.js';
import { ISqlDriverPackageService } from '../../../services/sql/common/sqlDriverPackages.js';
import { ISqlMetadataService } from '../../../services/sql/common/sqlMetadata.js';
import { getSqlConnectorRuntimeDriverId } from '../../../services/sql/common/sqlConnectorRuntimeGuard.js';
import { getDialectForConnectionKind, SqlDialect } from '../../../services/sql/common/sqlDialect.js';
import {
	SqlColumn,
	SqlConnection,
	SqlConnectionKind,
	SqlDatabase,
	SqlSavedConnection,
	SqlTable,
	SqlTableType
} from '../../../services/sql/common/sqlTypes.js';
import { SQL_NEW_QUERY_COMMAND_ID } from '../../sqlEditor/common/sqlEditor.js';
import {
	buildSqlConnectionTree,
	getColumnsKey,
	getConnectionColumnsKeyPrefix,
	getConnectionNodeId,
	SqlConnectionTreeNode,
	SqlConnectionTreeNodeType
} from '../common/sqlConnectionTreeModel.js';
import {
	createCopyQualifiedNameTextFromTreeNode,
	createCopyTableNameTextFromTreeNode,
	createConnectionQueryDraft,
	createCountDraftFromTreeNode,
	createInsertDraftFromTreeNode,
	createSelectDraftFromTreeNode,
	createSqlEditorDraftFromTreeNode,
	createUpdateDraftFromTreeNode,
	getSqlTableTypeFromNode,
	isSqlMutableTableNode,
	isSqlTableLikeNode,
	SqlEditorDraft
} from '../common/sqlConnectionQueryModel.js';
import {
	SQL_CONNECTIONS_ADD_COMMAND_ID,
	SQL_CONNECTIONS_VIEW_ID,
	SQL_CONNECTORS_VIEW_ID
} from '../common/sqlConnections.js';
import { requestSavedMysqlDataSourceForm } from '../common/sqlConnectionNavigation.js';
import {
	createSafeSqlConnectionInputFromFormState,
	createSqlConnectionFormStateFromSavedConnection
} from '../common/sqlConnectionFormModel.js';
import { formatSqlConnectionOperationError } from '../common/sqlConnectionFormOperation.js';
import {
	indexSqlRestoreSavedConnectionErrors,
	refreshAndRequireSqlConnection,
	restoreSavedConnectionsForRefresh,
	SqlConnectionRefreshOptions
} from '../common/sqlConnectionRefresh.js';
import {
	filterSqlConnectorPresentations,
	getSqlConnectorPresentation,
	SQL_CONNECTOR_PRESENTATIONS,
	SqlConnectorDelivery
} from '../common/sqlConnectorPresentationModel.js';
import {
	buildSqlDataSourceManagementItems,
	createSqlDataSourceRemovalRequest,
	getSqlDataSourceManagementActions,
	matchesSqlDataSourceManagementItem,
	SqlDataSourceManagementAction,
	SqlDataSourceManagementItem,
	SqlDataSourceManagementState
} from '../common/sqlDataSourceManagementModel.js';
import { buildSqlDriverStatusBadge, buildSqlDriverStatusPlaceholder, SqlDriverStatusBadge } from './driverCardBadge.js';
import { buildSqlDriverPackageStatusBadge, SqlDriverPackageStatusBadge } from './driverPackageBadge.js';

interface SqlConnectionTreeSnapshotState {
	connections: SqlConnection[];
	databasesByConnectionId: Record<string, SqlDatabase[]>;
	tablesByConnectionId: Record<string, SqlTable[]>;
	columnsByTableId: Record<string, SqlColumn[]>;
	errorsByConnectionId: Record<string, string>;
	errorsByTableId: Record<string, string>;
}

export class SqlConnectionsView extends ViewPane {
	static readonly ID = SQL_CONNECTIONS_VIEW_ID;
	static readonly NAME = localize('sqlDataSourcesViewName', 'Data Sources');

	private readonly connectorRenderDisposables = this._register(new DisposableStore());
	private readonly treeRenderDisposables = this._register(new DisposableStore());
	private readonly dataSourceRenderDisposables = this._register(new DisposableStore());

	private body!: HTMLElement;
	private messageElement!: HTMLElement;
	private treeElement!: HTMLElement;
	private dataSourceSearchInput!: HTMLInputElement;
	private dataSourceListElement!: HTMLElement;
	private dataSourceCountElement!: HTMLElement;
	private connectorSearchInput!: HTMLInputElement;
	private connectorListElement!: HTMLElement;
	private connectorCountElement!: HTMLElement;
	private connectorCatalogLoad: Promise<void> | undefined;
	private connectorCatalogUnavailable = false;
	private driverPackagesLoad: Promise<void> | undefined;
	private driverPackagesLoaded = false;
	private driverPackagesUnavailable = false;
	private readonly downloadingDriverPackages = new Set<string>();
	private readonly treeRowsByNodeId = new Map<string, HTMLElement>();
	private readonly busyDataSourceIds = new Set<string>();

	private readonly collapsedNodes = new Set<string>();

	private readonly state: SqlConnectionTreeSnapshotState = {
		connections: [],
		databasesByConnectionId: Object.create(null),
		tablesByConnectionId: Object.create(null),
		columnsByTableId: Object.create(null),
		errorsByConnectionId: Object.create(null),
		errorsByTableId: Object.create(null)
	};

	private savedConnections: SqlSavedConnection[] = [];
	private savedConnectionRestoreErrors: Record<string, string> = Object.create(null);
	private didRestoreSavedConnections = false;
	private readonly isConnectorView: boolean;

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
		@ISqlConnectionService private readonly sqlConnectionService: ISqlConnectionService,
		@ISqlMetadataService private readonly sqlMetadataService: ISqlMetadataService,
		@ISqlDriverCatalogService private readonly sqlDriverCatalogService: ISqlDriverCatalogService,
		@ISqlDriverPackageService private readonly sqlDriverPackageService: ISqlDriverPackageService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@ISqlConnectionDialogService private readonly sqlConnectionDialogService: ISqlConnectionDialogService
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

		this.isConnectorView = options.id === SQL_CONNECTORS_VIEW_ID;
	}

	protected override renderBody(container: HTMLElement): void {
		this.body = append(container, $('.sql-connections-view'));
		this.body.classList.add(this.isConnectorView ? 'sql-connectors-mode' : 'sql-data-sources-mode');

		if (this.isConnectorView) {
			this.renderConnectorBody();
			return;
		}

		this.renderDataSourcesBody();
	}

	private renderConnectorBody(): void {
		const toolbar = append(this.body, $('.sql-connector-manager-toolbar'));
		const searchWrap = append(toolbar, $('.sql-connector-manager-search-wrap'));
		append(searchWrap, $('.codicon.codicon-search', { 'aria-hidden': 'true' }));
		this.connectorSearchInput = append(
			searchWrap,
			$('input.sql-connector-manager-search', {
				type: 'search',
				placeholder: 'Filter connectors',
				'aria-label': 'Filter connectors'
			})
		) as HTMLInputElement;
		const refreshButton = this.appendIconButton(toolbar, 'refresh', 'Refresh connector status');
		this.connectorCountElement = append(this.body, $('.sql-connector-manager-summary'));
		this.connectorListElement = append(this.body, $('.sql-connector-manager-list'));
		this.messageElement = append(
			this.body,
			$('.sql-connections-message', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' })
		);

		this._register(
			addDisposableListener(this.connectorSearchInput, EventType.INPUT, () => this.renderConnectorManagement())
		);
		this._register(
			addDisposableListener(refreshButton, EventType.CLICK, () => {
				this.refreshConnectorCatalog().catch(error => this.showError(error));
			})
		);
		this._register(
			this.sqlDriverCatalogService.onChange(() => {
				this.connectorCatalogUnavailable = false;
				this.renderConnectorManagement();
			})
		);
		this._register(
			this.sqlDriverPackageService.onChange(() => {
				this.driverPackagesLoaded = true;
				this.driverPackagesUnavailable = false;
				this.renderConnectorManagement();
			})
		);

		this.renderConnectorManagement();
		Promise.all([this.ensureConnectorCatalogLoaded(), this.ensureDriverPackagesLoaded()]).catch(() => {
			this.showInfo('Connector or driver package status is unavailable. Refresh to retry.');
		});
	}

	private renderDataSourcesBody(): void {
		const actions = append(this.body, $('.sql-data-sources-actions'));
		const searchWrap = append(actions, $('.sql-data-source-search-wrap'));
		append(searchWrap, $('.codicon.codicon-search', { 'aria-hidden': 'true' }));
		this.dataSourceSearchInput = append(
			searchWrap,
			$('input.sql-data-source-search', {
				type: 'search',
				placeholder: 'Filter data sources',
				'aria-label': 'Filter data sources'
			})
		) as HTMLInputElement;
		const addDataSourceButton = this.appendIconButton(actions, 'add', 'New data source');
		const refreshDataSourcesButton = this.appendIconButton(actions, 'refresh', 'Refresh data sources');

		this._register(
			addDisposableListener(this.dataSourceSearchInput, EventType.INPUT, () => this.renderDataSourceManagement())
		);
		this._register(
			addDisposableListener(addDataSourceButton, EventType.CLICK, () => {
				this.commandService.executeCommand(SQL_CONNECTIONS_ADD_COMMAND_ID).catch(error => this.showError(error));
			})
		);
		this._register(
			addDisposableListener(refreshDataSourcesButton, EventType.CLICK, () => {
				this.refresh().catch(error => this.showError(error));
			})
		);

		this.dataSourceCountElement = append(this.body, $('.sql-data-source-summary'));
		this.dataSourceListElement = append(this.body, $('.sql-data-source-list', { role: 'list' }));
		append(this.body, $('.sql-data-source-section-title', undefined, 'Database Navigator'));
		this.messageElement = append(
			this.body,
			$('.sql-connections-message', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' })
		);
		this.treeElement = append(this.body, $('.sql-connections-tree', { role: 'tree', tabIndex: 0 }));
		this.renderDataSourceManagement();
		this.renderTree();

		// Phase 01: only hit the Rust backend when it actually exists. In a
		// plain browser dev session `isTauri()` is false and every SQL command
		// throws "Tauri runtime is not available", which would otherwise fire
		// a notification storm at workbench boot.
		if (isTauri()) {
			this.refresh().catch(error => this.showError(error));
		} else {
			this.showInfo('SQL backend unavailable in this preview window.');
		}
	}

	private appendIconButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
		const button = append(
			parent,
			$('button.sql-connections-icon-button', {
				type: 'button',
				title: label,
				'aria-label': label
			})
		) as HTMLButtonElement;
		append(button, $(`span.codicon.codicon-${icon}`, { 'aria-hidden': 'true' }));
		return button;
	}

	override focus(): void {
		if (this.isConnectorView) {
			this.connectorSearchInput?.focus();
		} else {
			this.dataSourceSearchInput?.focus();
		}
		super.focus();
	}

	async refresh(options: SqlConnectionRefreshOptions = {}): Promise<void> {
		if (this.isConnectorView) {
			return;
		}

		this.showInfo('Loading connections...');

		try {
			this.didRestoreSavedConnections = await restoreSavedConnectionsForRefresh(
				this.didRestoreSavedConnections,
				async () => {
					const result = await this.sqlConnectionService.restoreSavedConnections();
					this.savedConnectionRestoreErrors = indexSqlRestoreSavedConnectionErrors(result.errors);
				},
				error => this.showError(error),
				options
			);

			const [connections, saved] = await Promise.all([
				this.sqlConnectionService.listConnections(),
				this.sqlConnectionService.listSavedConnections()
			]);

			this.state.connections = connections;
			this.state.databasesByConnectionId = Object.create(null);
			this.state.tablesByConnectionId = Object.create(null);
			this.state.columnsByTableId = Object.create(null);
			this.state.errorsByConnectionId = Object.assign(Object.create(null), this.savedConnectionRestoreErrors);
			this.state.errorsByTableId = Object.create(null);
			this.savedConnections = saved;

			for (const connection of connections) {
				await this.loadConnectionMetadata(connection);
			}

			this.showInfo(connections.length === 0 ? 'No connections yet.' : '');
			this.renderTree();
			this.renderDataSourceManagement();
		} catch (error) {
			this.state.connections = [];
			this.state.databasesByConnectionId = Object.create(null);
			this.state.tablesByConnectionId = Object.create(null);
			this.state.columnsByTableId = Object.create(null);
			this.state.errorsByConnectionId = Object.create(null);
			this.state.errorsByTableId = Object.create(null);
			this.savedConnections = [];
			this.renderTree();
			this.renderDataSourceManagement();
			this.showError(error);
			if (options.throwOnError) {
				throw error;
			}
		}
	}

	async refreshAndRevealConnection(connectionId: string): Promise<void> {
		await refreshAndRequireSqlConnection(
			connectionId,
			options => this.refresh(options),
			candidateId => this.state.connections.some(connection => connection.id === candidateId)
		);

		this.collapsedNodes.delete(getConnectionNodeId(connectionId));
		this.renderTree();
		this.treeElement.focus();
	}

	private renderConnectorManagement(): void {
		if (!this.connectorListElement) {
			return;
		}

		this.connectorRenderDisposables.clear();
		clearNode(this.connectorListElement);
		const presentations = filterSqlConnectorPresentations({ text: this.connectorSearchInput.value });
		const runnableCount = presentations.filter(
			presentation => this.createConnectorBadge(presentation.kind).runnable
		).length;
		this.connectorCountElement.textContent = `${presentations.length} connectors · ${runnableCount} available`;

		if (presentations.length === 0) {
			append(
				this.connectorListElement,
				$('.sql-connector-manager-empty', undefined, 'No connectors match this filter.')
			);
			return;
		}

		for (const presentation of presentations) {
			const badge = this.createConnectorBadge(presentation.kind);
			const packageBadge = this.createDriverPackageBadge(presentation.kind);
			const card = append(this.connectorListElement, $('article.sql-connector-manager-card'));
			const icon = append(
				card,
				$(`span.sql-connector-brand.sql-connector-brand--${presentation.brandIcon}`, { 'aria-hidden': 'true' })
			);
			icon.title = presentation.label;
			const copy = append(card, $('.sql-connector-manager-copy'));
			const title = append(copy, $('.sql-connector-manager-title'));
			append(title, $('span.sql-connector-manager-name', undefined, presentation.label));
			const status = append(title, $('span'));
			status.className = badge.className;
			status.textContent = badge.text;
			status.setAttribute('role', 'status');
			status.setAttribute('aria-label', badge.ariaLabel);
			status.title = badge.title;
			append(title, $('span.sql-connector-delivery-badge', undefined, deliveryLabel(presentation.delivery)));
			append(copy, $('.sql-connector-manager-description', undefined, presentation.description));
			append(copy, $('.sql-connector-manager-runtime', undefined, badge.title));
			if (packageBadge) {
				const packageStatus = append(copy, $('span.sql-connector-manager-package'));
				packageStatus.className = packageBadge.className;
				packageStatus.textContent = `Driver package: ${packageBadge.text}`;
				packageStatus.title = packageBadge.title;
			}

			const actions = append(card, $('.sql-connector-manager-actions'));
			if (badge.runnable) {
				const addButton = append(
					actions,
					$('button.sql-connector-manager-action', {
						type: 'button',
						title: `New ${presentation.label} data source`,
						'aria-label': `New ${presentation.label} data source`
					})
				) as HTMLButtonElement;
				append(addButton, $('.codicon.codicon-add', { 'aria-hidden': 'true' }));
				this.connectorRenderDisposables.add(
					addDisposableListener(addButton, EventType.CLICK, () => {
						this.commandService
							.executeCommand(SQL_CONNECTIONS_ADD_COMMAND_ID, presentation.kind)
							.catch(error => this.showError(error));
					})
				);
			}
			if (packageBadge?.canDownload && presentation.driverPackageId) {
				const downloadButton = append(
					actions,
					$('button.sql-connector-manager-action', {
						type: 'button',
						title: `Download ${packageBadge.text.replace(/^Download /, '')}`,
						'aria-label': `Download ${presentation.label} driver package`,
						disabled: this.downloadingDriverPackages.has(presentation.driverPackageId) ? 'true' : undefined
					})
				) as HTMLButtonElement;
				append(downloadButton, $('.codicon.codicon-cloud-download', { 'aria-hidden': 'true' }));
				this.connectorRenderDisposables.add(
					addDisposableListener(downloadButton, EventType.CLICK, () => {
						this.downloadDriverPackage(presentation.driverPackageId!, presentation.label).catch(error =>
							this.showError(error)
						);
					})
				);
			}
		}
	}

	private createConnectorBadge(kind: SqlConnectionKind): SqlDriverStatusBadge {
		const presentation = SQL_CONNECTOR_PRESENTATIONS.find(candidate => candidate.kind === kind);
		try {
			return buildSqlDriverStatusBadge(this.sqlDriverCatalogService, getSqlConnectorRuntimeDriverId(kind));
		} catch {
			return buildSqlDriverStatusPlaceholder(presentation?.label ?? kind, this.connectorCatalogUnavailable);
		}
	}

	private createDriverPackageBadge(kind: SqlConnectionKind): SqlDriverPackageStatusBadge | undefined {
		const presentation = getSqlConnectorPresentation(kind);
		if (!presentation.driverPackageId) {
			return undefined;
		}

		return buildSqlDriverPackageStatusBadge(
			this.sqlDriverPackageService.findForDriver(getSqlConnectorRuntimeDriverId(kind)),
			{
				loaded: this.driverPackagesLoaded,
				unavailable: this.driverPackagesUnavailable
			}
		);
	}

	private async refreshConnectorCatalog(): Promise<void> {
		await Promise.all([this.ensureConnectorCatalogLoaded(true), this.ensureDriverPackagesLoaded(true)]);
		this.renderConnectorManagement();
		this.showInfo('Connector and driver package status refreshed.');
	}

	private ensureConnectorCatalogLoaded(forceRefresh = false): Promise<void> {
		if (this.connectorCatalogLoad) {
			return this.connectorCatalogLoad;
		}

		const request = forceRefresh
			? this.sqlDriverCatalogService.refreshRuntimeStatus()
			: this.sqlDriverCatalogService.getRuntimeStatus();
		const load = request
			.then(() => {
				this.connectorCatalogUnavailable = false;
			})
			.catch(error => {
				this.connectorCatalogUnavailable = true;
				throw error;
			})
			.finally(() => {
				if (this.connectorCatalogLoad === load) {
					this.connectorCatalogLoad = undefined;
				}
				this.renderConnectorManagement();
			});
		this.connectorCatalogLoad = load;
		return load;
	}

	private ensureDriverPackagesLoaded(forceRefresh = false): Promise<void> {
		if (this.driverPackagesLoad) {
			return this.driverPackagesLoad;
		}

		const request = forceRefresh
			? this.sqlDriverPackageService.refreshPackages()
			: this.sqlDriverPackageService.getPackages();
		const load = request
			.then(() => {
				this.driverPackagesLoaded = true;
				this.driverPackagesUnavailable = false;
			})
			.catch(error => {
				this.driverPackagesLoaded = true;
				this.driverPackagesUnavailable = true;
				throw error;
			})
			.finally(() => {
				if (this.driverPackagesLoad === load) {
					this.driverPackagesLoad = undefined;
				}
				this.renderConnectorManagement();
			});
		this.driverPackagesLoad = load;
		return load;
	}

	private async downloadDriverPackage(packageId: string, connectorLabel: string): Promise<void> {
		if (this.downloadingDriverPackages.has(packageId)) {
			return;
		}

		this.downloadingDriverPackages.add(packageId);
		this.renderConnectorManagement();
		this.showInfo(`Downloading ${connectorLabel} driver package...`);
		try {
			const packageEntry = await this.sqlDriverPackageService.download(packageId);
			this.showInfo(`${packageEntry.displayName} ${packageEntry.version} downloaded. Runtime support is unchanged.`);
		} finally {
			this.downloadingDriverPackages.delete(packageId);
			this.renderConnectorManagement();
		}
	}

	private async loadConnectionMetadata(connection: SqlConnection): Promise<void> {
		try {
			let databases: SqlDatabase[] = [];
			try {
				databases = await this.sqlMetadataService.listDatabases(connection.id);
			} catch (_databaseError) {
				/**
				 * listDatabases failure is non-fatal: SQLite returns the synthetic
				 * `main` database when the snapshot does not include one, and a
				 * backend that refuses listDatabases still allows browsing tables.
				 * The tree model derives schema nodes from tablesByConnectionId
				 * when the database list is empty so the explorer stays useful.
				 */
				databases = [];
			}

			const tables = await this.sqlMetadataService.listTables(connection.id);

			this.state.databasesByConnectionId[connection.id] = databases;
			this.state.tablesByConnectionId[connection.id] = tables;
			this.clearTableMetadataForConnection(connection.id);

			for (const table of tables) {
				const tableKey = getColumnsKey(connection.id, table);
				try {
					const columns = await this.sqlMetadataService.listColumns({
						connectionId: connection.id,
						schema: table.schema,
						tableName: table.name
					});
					this.state.columnsByTableId[tableKey] = columns;
					delete this.state.errorsByTableId[tableKey];
				} catch (columnError) {
					this.state.errorsByTableId[tableKey] =
						columnError instanceof Error ? columnError.message : String(columnError);
				}
			}

			delete this.state.errorsByConnectionId[connection.id];
		} catch (error) {
			this.state.errorsByConnectionId[connection.id] = error instanceof Error ? error.message : String(error);
		}
	}

	private renderTree(): void {
		this.treeRenderDisposables.clear();
		this.treeRowsByNodeId.clear();
		clearNode(this.treeElement);

		const nodes = buildSqlConnectionTree(this.state);

		for (const node of nodes) {
			this.treeElement.appendChild(this.renderNode(node, 0));
		}
	}

	private renderNode(node: SqlConnectionTreeNode, depth: number): HTMLElement {
		const wrapper = $('.sql-connection-node-wrapper');
		const row = append(wrapper, $('.sql-connection-node', { role: 'treeitem' }));
		this.treeRowsByNodeId.set(node.id, row);

		row.style.paddingLeft = `${8 + depth * 14}px`;
		row.classList.add(`type-${node.type}`);

		const hasChildren = Boolean(node.children?.length);
		const isNodeExpanded = this.isNodeExpanded(node);

		const twisty = append(
			row,
			$('button.sql-connection-node-twisty', {
				type: 'button',
				tabIndex: hasChildren ? 0 : -1,
				'aria-label': isNodeExpanded ? 'Collapse' : 'Expand',
				'aria-expanded': hasChildren ? String(isNodeExpanded) : undefined
			})
		) as HTMLButtonElement;

		twisty.textContent = hasChildren ? (isNodeExpanded ? '\u25be' : '\u25b8') : '';

		if (hasChildren) {
			this.treeRenderDisposables.add(
				addDisposableListener(twisty, EventType.CLICK, event => {
					event.preventDefault();
					event.stopPropagation();
					this.toggleNode(node.id);
				})
			);
		}

		const icon = append(row, $('span.sql-connection-node-icon'));
		icon.textContent = getNodeIcon(node);

		const label = append(row, $('span.sql-connection-node-label'));
		label.textContent = node.label;

		if (node.description) {
			const description = append(row, $('span.sql-connection-node-description'));
			description.textContent = node.description;
		}

		this.renderNodeActions(row, node);

		if (hasChildren && isNodeExpanded) {
			const children = append(wrapper, $('.sql-connection-node-children', { role: 'group' }));
			for (const child of node.children!) {
				children.appendChild(this.renderNode(child, depth + 1));
			}
		}

		return wrapper;
	}

	private renderNodeActions(row: HTMLElement, node: SqlConnectionTreeNode): void {
		if (!isActionableNode(node)) {
			return;
		}

		const actions = append(row, $('.sql-connection-node-actions'));

		if (node.type === SqlConnectionTreeNodeType.Error && node.connectionId) {
			this.appendActionButton(actions, 'Refresh', 'Retry metadata load', event => {
				event.preventDefault();
				event.stopPropagation();
				this.refreshErrorNode(node).catch(error => this.showError(error));
			});
			return;
		}

		if (node.type === SqlConnectionTreeNodeType.Connection && node.connectionId) {
			this.appendActionButton(actions, 'SQL', 'Open SQL query', event => {
				event.preventDefault();
				event.stopPropagation();
				this.openQueryForNode(node).catch(error => this.showError(error));
			});

			this.appendActionButton(actions, 'Refresh', 'Refresh connection metadata', event => {
				event.preventDefault();
				event.stopPropagation();
				this.refreshConnection(node.connectionId!).catch(error => this.showError(error));
			});

			this.appendActionButton(
				actions,
				'\u00d7',
				'Close connection',
				event => {
					event.preventDefault();
					event.stopPropagation();
					this.closeConnection(node.connectionId!).catch(error => this.showError(error));
				},
				'danger'
			);

			return;
		}

		if (isSqlTableLikeNode(node)) {
			const draftOptions = this.getDraftOptionsForNode(node);

			this.appendActionButton(actions, 'SELECT', 'Generate SELECT query', event => {
				event.preventDefault();
				event.stopPropagation();
				this.openDraft(createSelectDraftFromTreeNode(node, draftOptions)).catch(error => this.showError(error));
			});

			this.appendActionButton(actions, 'COUNT', 'Generate COUNT query', event => {
				event.preventDefault();
				event.stopPropagation();
				this.openDraft(createCountDraftFromTreeNode(node, draftOptions)).catch(error => this.showError(error));
			});

			if (isSqlMutableTableNode(node)) {
				this.appendActionButton(actions, 'INSERT', 'Generate INSERT template', event => {
					event.preventDefault();
					event.stopPropagation();
					this.openDraft(createInsertDraftFromTreeNode(node, draftOptions)).catch(error => this.showError(error));
				});

				this.appendActionButton(actions, 'UPDATE', 'Generate UPDATE template', event => {
					event.preventDefault();
					event.stopPropagation();
					this.openDraft(createUpdateDraftFromTreeNode(node, draftOptions)).catch(error => this.showError(error));
				});
			}

			this.appendActionButton(actions, 'Copy Name', 'Copy table name', event => {
				event.preventDefault();
				event.stopPropagation();
				this.copyTableName(node).catch(error => this.showError(error));
			});

			this.appendActionButton(actions, 'Copy Full', 'Copy qualified name', event => {
				event.preventDefault();
				event.stopPropagation();
				this.copyQualifiedName(node).catch(error => this.showError(error));
			});

			this.appendActionButton(actions, 'Refresh', 'Refresh columns', event => {
				event.preventDefault();
				event.stopPropagation();
				this.refreshTable(node).catch(error => this.showError(error));
			});
		}
	}

	private appendActionButton(
		parent: HTMLElement,
		label: string,
		title: string,
		listener: (event: MouseEvent) => void,
		variant?: 'danger'
	): HTMLButtonElement {
		const button = append(
			parent,
			$(
				'button.sql-connection-node-action',
				{
					type: 'button',
					title
				},
				label
			)
		) as HTMLButtonElement;

		if (variant) {
			button.classList.add(variant);
		}

		this.treeRenderDisposables.add(addDisposableListener(button, EventType.CLICK, listener));

		return button;
	}

	private renderDataSourceManagement(): void {
		if (!this.dataSourceListElement) {
			return;
		}

		this.dataSourceRenderDisposables.clear();
		clearNode(this.dataSourceListElement);
		const items = buildSqlDataSourceManagementItems(
			this.savedConnections,
			this.state.connections,
			this.state.errorsByConnectionId
		).filter(item => matchesSqlDataSourceManagementItem(item, this.dataSourceSearchInput.value));
		const connectedCount = items.filter(item => item.state === SqlDataSourceManagementState.Connected).length;
		this.dataSourceCountElement.textContent = `${items.length} data sources · ${connectedCount} connected`;

		if (items.length === 0) {
			append(
				this.dataSourceListElement,
				$(
					'.sql-data-source-empty',
					undefined,
					this.dataSourceSearchInput.value.trim()
						? 'No data sources match this filter.'
						: 'No saved or open data sources.'
				)
			);
			return;
		}

		for (const item of items) {
			this.renderDataSourceManagementItem(item);
		}
	}

	private renderDataSourceManagementItem(item: SqlDataSourceManagementItem): void {
		const presentation = getSqlConnectorPresentation(item.kind);
		const card = append(
			this.dataSourceListElement,
			$('article.sql-data-source-card', {
				role: 'listitem',
				'aria-label': `${item.name}, ${item.driverLabel}, ${item.state}`
			})
		);
		card.classList.toggle('busy', this.busyDataSourceIds.has(item.id));

		const summary = append(card, $('.sql-data-source-card-summary'));
		const icon = append(
			summary,
			$(`span.sql-connector-brand.sql-connector-brand--${presentation.brandIcon}`, { 'aria-hidden': 'true' })
		);
		icon.title = item.driverLabel;
		const copy = append(summary, $('.sql-data-source-card-copy'));
		const title = append(copy, $('.sql-data-source-card-title'));
		append(title, $('span.sql-data-source-card-name', undefined, item.name));
		const state = append(title, $('span.sql-data-source-state', undefined, dataSourceStateLabel(item.state)));
		state.classList.add(item.state);
		const target = append(copy, $('.sql-data-source-card-target'));
		target.textContent = `${item.driverLabel} · ${item.target || 'Local data source'}`;
		target.title = target.textContent;
		if (item.error) {
			append(copy, $('.sql-data-source-card-error', undefined, item.error));
		}

		const actions = append(card, $('.sql-data-source-card-actions'));
		for (const action of getSqlDataSourceManagementActions(item)) {
			this.appendDataSourceActionButton(actions, item, action);
		}
	}

	private appendDataSourceActionButton(
		parent: HTMLElement,
		item: SqlDataSourceManagementItem,
		action: SqlDataSourceManagementAction
	): void {
		const presentation = getDataSourceActionPresentation(action);
		const button = append(
			parent,
			$('button.sql-data-source-action', {
				type: 'button',
				title: presentation.title,
				'aria-label': `${presentation.title}: ${item.name}`
			})
		) as HTMLButtonElement;
		button.disabled = this.busyDataSourceIds.has(item.id);
		button.classList.toggle('danger', presentation.danger === true);
		append(button, $(`span.codicon.codicon-${presentation.icon}`, { 'aria-hidden': 'true' }));
		this.dataSourceRenderDisposables.add(
			addDisposableListener(button, EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				this.runDataSourceAction(item, action).catch(error => this.showError(error));
			})
		);
	}

	private async runDataSourceAction(
		item: SqlDataSourceManagementItem,
		action: SqlDataSourceManagementAction
	): Promise<void> {
		if (this.busyDataSourceIds.has(item.id)) {
			return;
		}

		this.busyDataSourceIds.add(item.id);
		this.renderDataSourceManagement();
		try {
			switch (action) {
				case SqlDataSourceManagementAction.Connect:
					if (item.saved) {
						await this.openSavedConnection(item.saved);
					}
					break;
				case SqlDataSourceManagementAction.Reveal:
					this.revealConnectionInTree(item.id, item.name);
					break;
				case SqlDataSourceManagementAction.OpenQuery:
					await this.openDraft(createConnectionQueryDraft(item.id, item.name));
					break;
				case SqlDataSourceManagementAction.Refresh:
					await this.refreshConnection(item.id);
					break;
				case SqlDataSourceManagementAction.Edit:
					if (item.saved) {
						await this.sqlConnectionDialogService.openSaved(item.saved);
					}
					break;
				case SqlDataSourceManagementAction.Test:
					if (item.saved) {
						await this.testSavedDataSource(item.saved);
					}
					break;
				case SqlDataSourceManagementAction.Reconnect:
					if (item.saved) {
						await this.reconnectSavedDataSource(item.saved);
					}
					break;
				case SqlDataSourceManagementAction.Disconnect:
					await this.closeConnection(item.id);
					break;
				case SqlDataSourceManagementAction.Delete:
					await this.removeDataSource(item);
					break;
			}
		} finally {
			this.busyDataSourceIds.delete(item.id);
			this.renderDataSourceManagement();
		}
	}

	private async openQueryForNode(node: SqlConnectionTreeNode): Promise<void> {
		const draft = createSqlEditorDraftFromTreeNode(node, {
			connectionName: node.connectionId ? this.getConnectionName(node.connectionId) : undefined,
			columns: this.getColumnsForNode(node)
		});

		await this.openDraft(draft);
	}

	private async openDraft(draft: SqlEditorDraft): Promise<void> {
		await this.commandService.executeCommand(SQL_NEW_QUERY_COMMAND_ID, draft);
	}

	private getConnectionName(connectionId: string): string | undefined {
		return this.state.connections.find(connection => connection.id === connectionId)?.name;
	}

	private getDraftOptionsForNode(node: SqlConnectionTreeNode): {
		connectionName?: string;
		dialect: SqlDialect;
		columns: SqlColumn[];
	} {
		return {
			connectionName: node.connectionId ? this.getConnectionName(node.connectionId) : undefined,
			dialect: this.getDialectForNode(node),
			columns: this.getColumnsForNode(node)
		};
	}

	private getDialectForNode(node: SqlConnectionTreeNode): SqlDialect {
		if (!node.connectionId) {
			return SqlDialect.Sqlite;
		}

		const connection = this.state.connections.find(item => item.id === node.connectionId);
		return connection ? getDialectForConnectionKind(connection.kind) : SqlDialect.Sqlite;
	}

	private getColumnsForNode(node: SqlConnectionTreeNode): SqlColumn[] {
		if (!node.connectionId || !isSqlTableLikeNode(node)) {
			return [];
		}

		const table = tableFromNode(node);
		return this.state.columnsByTableId[getColumnsKey(node.connectionId, table)] ?? [];
	}

	private async refreshConnection(connectionId: string): Promise<void> {
		const connection = this.state.connections.find(item => item.id === connectionId);

		if (!connection) {
			throw new Error(`Connection '${connectionId}' is not open.`);
		}

		this.showInfo(`Refreshing ${connection.name}...`);
		this.removeMetadataForConnection(connectionId);
		await this.loadConnectionMetadata(connection);
		this.collapsedNodes.delete(getConnectionNodeId(connectionId));
		this.renderTree();
		this.showInfo(`Refreshed ${connection.name}.`);
	}

	private async refreshErrorNode(node: SqlConnectionTreeNode): Promise<void> {
		if (!node.connectionId) {
			throw new Error('Cannot refresh an error node without a connection id.');
		}

		if (node.tableName) {
			await this.refreshTable({
				...node,
				type: node.tableType === SqlTableType.View ? SqlConnectionTreeNodeType.View : SqlConnectionTreeNodeType.Table
			});
			return;
		}

		await this.refreshConnection(node.connectionId);
	}

	private async refreshTable(node: SqlConnectionTreeNode): Promise<void> {
		if (!node.connectionId || !isSqlTableLikeNode(node)) {
			throw new Error('Cannot refresh columns for this node.');
		}

		const table = tableFromNode(node);
		const tableKey = getColumnsKey(node.connectionId, table);

		this.showInfo(`Refreshing ${table.name}...`);

		try {
			const columns = await this.sqlMetadataService.listColumns({
				connectionId: node.connectionId,
				schema: table.schema,
				tableName: table.name
			});

			this.state.columnsByTableId[tableKey] = columns;
			delete this.state.errorsByTableId[tableKey];
			this.collapsedNodes.delete(node.id);
			this.renderTree();
			this.showInfo(`Refreshed ${table.name}.`);
		} catch (error) {
			this.state.errorsByTableId[tableKey] = error instanceof Error ? error.message : String(error);
			delete this.state.columnsByTableId[tableKey];
			this.collapsedNodes.delete(node.id);
			this.renderTree();
			throw error;
		}
	}

	private removeMetadataForConnection(connectionId: string): void {
		delete this.state.databasesByConnectionId[connectionId];
		delete this.state.tablesByConnectionId[connectionId];
		delete this.state.errorsByConnectionId[connectionId];
		this.clearTableMetadataForConnection(connectionId);
	}

	private clearTableMetadataForConnection(connectionId: string): void {
		const prefix = getConnectionColumnsKeyPrefix(connectionId);

		deleteKeysWithPrefix(this.state.columnsByTableId, prefix);
		deleteKeysWithPrefix(this.state.errorsByTableId, prefix);
	}

	private async copyTableName(node: SqlConnectionTreeNode): Promise<void> {
		const text = createCopyTableNameTextFromTreeNode(node);
		await writeClipboardText(text);
		this.showInfo(`Copied table name ${text}.`);
	}

	private async copyQualifiedName(node: SqlConnectionTreeNode): Promise<void> {
		const text = createCopyQualifiedNameTextFromTreeNode(node);
		await writeClipboardText(text);
		this.showInfo(`Copied ${text}.`);
	}

	private async openSavedConnection(saved: SqlSavedConnection): Promise<void> {
		const alreadyOpen = this.state.connections.some(connection => connection.id === saved.id);

		if (alreadyOpen) {
			this.collapsedNodes.delete(getConnectionNodeId(saved.id));
			this.showInfo(`${saved.name} is already connected.`);
			this.renderTree();
			return;
		}

		if (saved.kind === SqlConnectionKind.MySql) {
			await requestSavedMysqlDataSourceForm(
				(commandId, ...args) => this.commandService.executeCommand(commandId, ...args),
				saved
			);
			return;
		}

		if (saved.kind === SqlConnectionKind.PostgreSql) {
			this.showInfo('PostgreSQL is planned. Runtime connection is not enabled yet.');
			return;
		}

		await this.sqlConnectionService.openConnection({
			id: saved.id,
			name: saved.name,
			kind: saved.kind,
			databasePath: saved.databasePath,
			host: saved.host,
			port: saved.port,
			database: saved.database,
			username: saved.username,
			sslMode: saved.sslMode,
			readOnly: saved.readOnly,
			createIfMissing: saved.createIfMissing
		});

		this.collapsedNodes.delete(getConnectionNodeId(saved.id));
		await this.refresh();
		this.showInfo(`Connected to ${saved.name}.`);
	}

	private revealConnectionInTree(connectionId: string, connectionName: string): void {
		this.collapsedNodes.delete(getConnectionNodeId(connectionId));
		this.renderTree();
		this.treeRowsByNodeId.get(getConnectionNodeId(connectionId))?.scrollIntoView({ block: 'nearest' });
		this.treeElement.focus();
		this.showInfo(`Revealed ${connectionName} in Database Navigator.`);
	}

	private async testSavedDataSource(saved: SqlSavedConnection): Promise<void> {
		if (saved.kind !== SqlConnectionKind.Sqlite) {
			this.showInfo('Enter any required credentials, then use Test in the data source editor.');
			await this.sqlConnectionDialogService.openSaved(saved);
			return;
		}

		this.showInfo(`Testing ${saved.name}...`);
		const input = createSafeSqlConnectionInputFromFormState(createSqlConnectionFormStateFromSavedConnection(saved));
		const result = await this.sqlConnectionService.testConnection(input);
		if (!result.ok) {
			throw result.error ?? new Error('Connection test failed.');
		}
		this.showInfo(`Connection test passed for ${saved.name}.`);
	}

	private async reconnectSavedDataSource(saved: SqlSavedConnection): Promise<void> {
		this.showInfo(`Reconnecting ${saved.name}...`);
		if (this.state.connections.some(connection => connection.id === saved.id)) {
			await this.sqlConnectionService.closeConnection(saved.id);
		}
		await this.refresh();
		await this.openSavedConnection(saved);
	}

	private async removeDataSource(item: SqlDataSourceManagementItem): Promise<void> {
		const request = createSqlDataSourceRemovalRequest(item);
		if (!request) {
			return;
		}

		const { confirmed } = await this.dialogService.confirm({
			type: 'warning',
			message: `Delete data source '${item.name}'?`,
			detail:
				item.state === SqlDataSourceManagementState.Connected || item.state === SqlDataSourceManagementState.Error
					? 'The saved profile will be removed and its active connection will be closed.'
					: 'The saved profile will be removed from Nyala Studio.',
			primaryButton: 'Delete',
			cancelButton: 'Cancel'
		});
		if (!confirmed) {
			return;
		}

		await this.sqlConnectionService.removeSavedConnection(request);

		this.collapsedNodes.delete(getConnectionNodeId(item.id));
		this.showInfo(`Deleted data source ${item.name}.`);
		await this.refresh();
	}

	private async closeConnection(connectionId: string): Promise<void> {
		await this.sqlConnectionService.closeConnection(connectionId);
		this.collapsedNodes.delete(getConnectionNodeId(connectionId));
		this.showInfo('Connection closed.');
		await this.refresh();
	}

	private toggleNode(nodeId: string): void {
		if (this.collapsedNodes.has(nodeId)) {
			this.collapsedNodes.delete(nodeId);
		} else {
			this.collapsedNodes.add(nodeId);
		}

		this.renderTree();
	}

	private isNodeExpanded(node: SqlConnectionTreeNode): boolean {
		return !this.collapsedNodes.has(node.id);
	}

	private showInfo(message: string): void {
		if (!this.messageElement) {
			return;
		}

		this.messageElement.classList.remove('error');
		this.messageElement.setAttribute('role', 'status');
		this.messageElement.setAttribute('aria-live', 'polite');
		this.messageElement.textContent = message;
	}

	private showError(error: unknown): void {
		if (!this.messageElement) {
			return;
		}

		const message = formatSqlConnectionOperationError(error);
		this.messageElement.classList.add('error');
		this.messageElement.setAttribute('role', 'alert');
		this.messageElement.setAttribute('aria-live', 'assertive');
		this.messageElement.textContent = message;
		this.notificationService.error(message);
	}
}

function isActionableNode(node: SqlConnectionTreeNode): boolean {
	return (
		node.type === SqlConnectionTreeNodeType.Connection ||
		(node.type === SqlConnectionTreeNodeType.Error && Boolean(node.connectionId)) ||
		isSqlTableLikeNode(node)
	);
}

function tableFromNode(node: SqlConnectionTreeNode): Pick<SqlTable, 'schema' | 'name' | 'tableType'> {
	return {
		schema: node.schema,
		name: node.tableName ?? node.label,
		tableType: getSqlTableTypeFromNode(node)
	};
}

function getNodeIcon(node: SqlConnectionTreeNode): string {
	switch (node.type) {
		case SqlConnectionTreeNodeType.Connection:
			return '\u25c9';
		case SqlConnectionTreeNodeType.Database:
			return '\u25b8';
		case SqlConnectionTreeNodeType.Group:
			return '\u25a3';
		case SqlConnectionTreeNodeType.Table:
			return '\u25a6';
		case SqlConnectionTreeNodeType.View:
			return '\u25eb';
		case SqlConnectionTreeNodeType.Column:
			return '\u2022';
		case SqlConnectionTreeNodeType.Error:
			return '!';
		case SqlConnectionTreeNodeType.Empty:
		default:
			return '\u00b7';
	}
}

function dataSourceStateLabel(state: SqlDataSourceManagementState): string {
	switch (state) {
		case SqlDataSourceManagementState.Connected:
			return 'Connected';
		case SqlDataSourceManagementState.Error:
			return 'Error';
		case SqlDataSourceManagementState.Saved:
			return 'Saved';
	}
}

function getDataSourceActionPresentation(action: SqlDataSourceManagementAction): {
	readonly icon: string;
	readonly title: string;
	readonly danger?: boolean;
} {
	switch (action) {
		case SqlDataSourceManagementAction.Connect:
			return { icon: 'plug', title: 'Connect' };
		case SqlDataSourceManagementAction.Reveal:
			return { icon: 'target', title: 'Show in Database Navigator' };
		case SqlDataSourceManagementAction.OpenQuery:
			return { icon: 'file-code', title: 'New SQL query' };
		case SqlDataSourceManagementAction.Refresh:
			return { icon: 'refresh', title: 'Refresh metadata' };
		case SqlDataSourceManagementAction.Edit:
			return { icon: 'edit', title: 'Edit data source' };
		case SqlDataSourceManagementAction.Test:
			return { icon: 'beaker', title: 'Test connection' };
		case SqlDataSourceManagementAction.Reconnect:
			return { icon: 'sync', title: 'Reconnect' };
		case SqlDataSourceManagementAction.Disconnect:
			return { icon: 'debug-disconnect', title: 'Disconnect' };
		case SqlDataSourceManagementAction.Delete:
			return { icon: 'trash', title: 'Delete data source', danger: true };
	}
}

function deliveryLabel(delivery: SqlConnectorDelivery): string {
	return delivery === SqlConnectorDelivery.Bundled ? 'Bundled' : 'Planned';
}

async function writeClipboardText(text: string): Promise<void> {
	if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}

	throw new Error('Clipboard API is not available.');
}

function deleteKeysWithPrefix<T>(record: Record<string, T>, prefix: string): void {
	for (const key of Object.keys(record)) {
		if (key.startsWith(prefix)) {
			delete record[key];
		}
	}
}
