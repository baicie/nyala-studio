/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Connections View.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlConnections.css';

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ISqlConnectionService } from '../../../services/sql/common/sqlConnection.js';
import { ISqlMetadataService } from '../../../services/sql/common/sqlMetadata.js';
import {
	SqlColumn,
	SqlConnection,
	SqlConnectionInput,
	SqlConnectionKind,
	SqlSavedConnection,
	SqlTable
} from '../../../services/sql/common/sqlTypes.js';
import { SQL_NEW_QUERY_COMMAND_ID } from '../../sqlEditor/common/sqlEditor.js';
import {
	buildSqlConnectionTree,
	getColumnsKey,
	SqlConnectionTreeNode,
	SqlConnectionTreeNodeType
} from '../common/sqlConnectionTreeModel.js';
import { createSqlEditorDraftFromTreeNode } from '../common/sqlConnectionQueryModel.js';
import { SQL_CONNECTIONS_VIEW_ID } from '../common/sqlConnections.js';

interface SqlConnectionTreeSnapshotState {
	connections: SqlConnection[];
	tablesByConnectionId: Record<string, SqlTable[]>;
	columnsByTableId: Record<string, SqlColumn[]>;
	errorsByConnectionId: Record<string, string>;
}

export class SqlConnectionsView extends ViewPane {
	static readonly ID = SQL_CONNECTIONS_VIEW_ID;
	static readonly NAME = localize('sqlConnectionsViewName', 'Connections');

	private readonly formDisposables = this._register(new DisposableStore());
	private readonly treeRenderDisposables = this._register(new DisposableStore());
	private readonly savedRenderDisposables = this._register(new DisposableStore());

	private body!: HTMLElement;
	private form!: HTMLFormElement;
	private nameInput!: HTMLInputElement;
	private databasePathInput!: HTMLInputElement;
	private readOnlyInput!: HTMLInputElement;
	private createIfMissingInput!: HTMLInputElement;
	private saveConnectionInput!: HTMLInputElement;
	private autoConnectInput!: HTMLInputElement;
	private messageElement!: HTMLElement;
	private treeElement!: HTMLElement;
	private savedConnectionsElement!: HTMLElement;

	private readonly collapsedNodes = new Set<string>();

	private readonly state: SqlConnectionTreeSnapshotState = {
		connections: [],
		tablesByConnectionId: Object.create(null),
		columnsByTableId: Object.create(null),
		errorsByConnectionId: Object.create(null)
	};

	private savedConnections: SqlSavedConnection[] = [];
	private didRestoreSavedConnections = false;

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
		this.body = append(container, $('.sql-connections-view'));
		this.renderConnectionForm(this.body);
		this.savedConnectionsElement = append(this.body, $('.sql-saved-connections'));
		this.messageElement = append(this.body, $('.sql-connections-message'));
		this.treeElement = append(this.body, $('.sql-connections-tree', { role: 'tree', tabIndex: 0 }));

		this.databasePathInput.value = ':memory:';
		this.createIfMissingInput.checked = true;
		this.saveConnectionInput.checked = false;
		this.autoConnectInput.checked = false;
		this.autoConnectInput.disabled = true;

		this.refresh().catch(error => this.showError(error));
	}

	override focus(): void {
		this.treeElement?.focus();
		super.focus();
	}

	async refresh(): Promise<void> {
		this.showInfo('Loading connections...');

		try {
			if (!this.didRestoreSavedConnections) {
				this.didRestoreSavedConnections = true;
				try {
					await this.sqlConnectionService.restoreSavedConnections();
				} catch (error) {
					this.showError(error);
				}
			}

			const [connections, saved] = await Promise.all([
				this.sqlConnectionService.listConnections(),
				this.sqlConnectionService.listSavedConnections()
			]);

			this.state.connections = connections;
			this.state.tablesByConnectionId = Object.create(null);
			this.state.columnsByTableId = Object.create(null);
			this.state.errorsByConnectionId = Object.create(null);
			this.savedConnections = saved;

			for (const connection of connections) {
				await this.loadConnectionMetadata(connection);
			}

			this.showInfo(connections.length === 0 ? 'No connections yet.' : '');
			this.renderTree();
			this.renderSavedConnections();
		} catch (error) {
			this.state.connections = [];
			this.state.tablesByConnectionId = Object.create(null);
			this.state.columnsByTableId = Object.create(null);
			this.state.errorsByConnectionId = Object.create(null);
			this.savedConnections = [];
			this.renderTree();
			this.renderSavedConnections();
			this.showError(error);
		}
	}

	async addConnectionFromForm(): Promise<void> {
		const databasePath = this.databasePathInput.value.trim();
		const name = this.nameInput.value.trim();

		if (!databasePath) {
			this.showInfo('Database path is required.');
			this.databasePathInput.focus();
			return;
		}

		this.showInfo('Opening SQLite connection...');

		try {
			const input: SqlConnectionInput = {
				name: name || undefined,
				kind: SqlConnectionKind.Sqlite,
				databasePath,
				readOnly: this.readOnlyInput.checked,
				createIfMissing: this.createIfMissingInput.checked
			};

			let connectionId: string;
			let connectionName: string;

			const shouldSave = this.saveConnectionInput.checked && isPersistableDatabasePath(databasePath);

			if (this.saveConnectionInput.checked && !shouldSave) {
				this.showInfo('In-memory SQLite connections are temporary and will not be saved.');
			}

			if (shouldSave) {
				const saved = await this.sqlConnectionService.saveConnection({
					input,
					autoConnect: this.autoConnectInput.checked,
					openNow: true
				});

				connectionId = saved.id;
				connectionName = saved.name;
			} else {
				const connection = await this.sqlConnectionService.openConnection(input);

				connectionId = connection.id;
				connectionName = connection.name;
			}

			this.collapsedNodes.delete(getConnectionNodeId(connectionId));
			this.showInfo(`Connected to ${connectionName}.`);
			await this.refresh();
		} catch (error) {
			this.showError(error);
		}
	}

	private renderConnectionForm(container: HTMLElement): void {
		this.form = append(container, $('form.sql-connections-form'));

		const nameLabel = append(this.form, $('label.sql-connections-field'));
		append(nameLabel, $('span', undefined, 'Name'));
		this.nameInput = append(
			nameLabel,
			$('input.sql-connections-input', {
				type: 'text',
				placeholder: 'Local SQLite'
			})
		) as HTMLInputElement;

		const pathLabel = append(this.form, $('label.sql-connections-field'));
		append(pathLabel, $('span', undefined, 'Database path'));
		this.databasePathInput = append(
			pathLabel,
			$('input.sql-connections-input', {
				type: 'text',
				placeholder: '/absolute/path/to/database.db or :memory:'
			})
		) as HTMLInputElement;

		const options = append(this.form, $('.sql-connections-options'));

		const readOnlyLabel = append(options, $('label.sql-connections-checkbox'));
		this.readOnlyInput = append(readOnlyLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
		append(readOnlyLabel, $('span', undefined, 'Read-only'));

		const createLabel = append(options, $('label.sql-connections-checkbox'));
		this.createIfMissingInput = append(createLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
		append(createLabel, $('span', undefined, 'Create if missing'));

		const saveLabel = append(options, $('label.sql-connections-checkbox'));
		this.saveConnectionInput = append(saveLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
		append(saveLabel, $('span', undefined, 'Save'));

		const autoConnectLabel = append(options, $('label.sql-connections-checkbox'));
		this.autoConnectInput = append(autoConnectLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
		append(autoConnectLabel, $('span', undefined, 'Auto connect'));

		const actions = append(this.form, $('.sql-connections-actions'));
		append(actions, $('button.sql-connections-button.primary', { type: 'submit' }, 'Connect'));

		const refreshButton = append(
			actions,
			$('button.sql-connections-button', { type: 'button' }, 'Refresh')
		) as HTMLButtonElement;

		this.formDisposables.add(
			addDisposableListener(this.form, EventType.SUBMIT, event => {
				event.preventDefault();
				this.addConnectionFromForm().catch(error => this.showError(error));
			})
		);

		this.formDisposables.add(
			addDisposableListener(refreshButton, EventType.CLICK, () => {
				this.refresh().catch(error => this.showError(error));
			})
		);

		this.formDisposables.add(
			addDisposableListener(this.saveConnectionInput, EventType.CHANGE, () => {
				this.autoConnectInput.disabled = !this.saveConnectionInput.checked;

				if (!this.saveConnectionInput.checked) {
					this.autoConnectInput.checked = false;
				}
			})
		);
	}

	private async loadConnectionMetadata(connection: SqlConnection): Promise<void> {
		try {
			const tables = await this.sqlMetadataService.listTables(connection.id);
			this.state.tablesByConnectionId[connection.id] = tables;

			for (const table of tables) {
				const columns = await this.sqlMetadataService.listColumns({
					connectionId: connection.id,
					schema: table.schema,
					tableName: table.name
				});

				this.state.columnsByTableId[getColumnsKey(connection.id, table)] = columns;
			}
		} catch (error) {
			this.state.errorsByConnectionId[connection.id] = error instanceof Error ? error.message : String(error);
		}
	}

	private renderTree(): void {
		this.treeRenderDisposables.clear();
		clearNode(this.treeElement);

		const nodes = buildSqlConnectionTree(this.state);

		for (const node of nodes) {
			this.treeElement.appendChild(this.renderNode(node, 0));
		}
	}

	private renderNode(node: SqlConnectionTreeNode, depth: number): HTMLElement {
		const wrapper = $('.sql-connection-node-wrapper');
		const row = append(wrapper, $('.sql-connection-node', { role: 'treeitem' }));

		row.style.paddingLeft = `${8 + depth * 14}px`;
		row.classList.add(`type-${node.type}`);

		const hasChildren = Boolean(node.children?.length);
		const isExpanded = this.isExpanded(node);

		const twisty = append(
			row,
			$('button.sql-connection-node-twisty', {
				type: 'button',
				tabIndex: hasChildren ? 0 : -1,
				'aria-label': isExpanded ? 'Collapse' : 'Expand',
				'aria-expanded': hasChildren ? String(isExpanded) : undefined
			})
		) as HTMLButtonElement;

		twisty.textContent = hasChildren ? (isExpanded ? '\u25be' : '\u25b8') : '';

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

		if (hasChildren && isExpanded) {
			const children = append(wrapper, $('.sql-connection-node-children', { role: 'group' }));
			for (const child of node.children!) {
				children.appendChild(this.renderNode(child, depth + 1));
			}
		}

		return wrapper;
	}

	private renderNodeActions(row: HTMLElement, node: SqlConnectionTreeNode): void {
		if (!isQueryOpenableNode(node) && node.type !== SqlConnectionTreeNodeType.Connection) {
			return;
		}

		const actions = append(row, $('.sql-connection-node-actions'));

		if (isQueryOpenableNode(node)) {
			const openQueryButton = append(
				actions,
				$('button.sql-connection-node-action', {
					type: 'button',
					title: node.type === SqlConnectionTreeNodeType.Connection ? 'Open SQL query' : 'Select top 100'
				})
			) as HTMLButtonElement;

			openQueryButton.textContent = node.type === SqlConnectionTreeNodeType.Connection ? 'SQL' : 'SELECT';

			this.treeRenderDisposables.add(
				addDisposableListener(openQueryButton, EventType.CLICK, event => {
					event.preventDefault();
					event.stopPropagation();
					this.openQueryForNode(node).catch(error => this.showError(error));
				})
			);
		}

		if (node.type === SqlConnectionTreeNodeType.Connection && node.connectionId) {
			const closeButton = append(
				actions,
				$('button.sql-connection-node-action.danger', {
					type: 'button',
					title: 'Close connection'
				})
			) as HTMLButtonElement;

			closeButton.textContent = '\u00d7';

			this.treeRenderDisposables.add(
				addDisposableListener(closeButton, EventType.CLICK, event => {
					event.preventDefault();
					event.stopPropagation();
					this.closeConnection(node.connectionId!).catch(error => this.showError(error));
				})
			);
		}
	}

	private renderSavedConnections(): void {
		this.savedRenderDisposables.clear();
		clearNode(this.savedConnectionsElement);

		if (this.savedConnections.length === 0) {
			return;
		}

		const title = append(this.savedConnectionsElement, $('.sql-saved-connections-title'));
		title.textContent = 'Saved Connections';

		for (const saved of this.savedConnections) {
			const row = append(this.savedConnectionsElement, $('.sql-saved-connection-row'));

			append(row, $('span.sql-saved-connection-name', undefined, saved.name));

			const openButton = append(
				row,
				$('button.sql-saved-connection-action', { type: 'button' }, 'Open')
			) as HTMLButtonElement;

			const removeButton = append(
				row,
				$('button.sql-saved-connection-action.danger', { type: 'button' }, 'Remove')
			) as HTMLButtonElement;

			this.savedRenderDisposables.add(
				addDisposableListener(openButton, EventType.CLICK, event => {
					event.preventDefault();
					event.stopPropagation();
					this.openSavedConnection(saved).catch(error => this.showError(error));
				})
			);

			this.savedRenderDisposables.add(
				addDisposableListener(removeButton, EventType.CLICK, event => {
					event.preventDefault();
					event.stopPropagation();
					this.removeSavedConnection(saved.id).catch(error => this.showError(error));
				})
			);
		}
	}

	private async openQueryForNode(node: SqlConnectionTreeNode): Promise<void> {
		const draft = createSqlEditorDraftFromTreeNode(node, {
			connectionName: node.connectionId ? this.getConnectionName(node.connectionId) : undefined
		});

		await this.commandService.executeCommand(SQL_NEW_QUERY_COMMAND_ID, draft);
	}

	private getConnectionName(connectionId: string): string | undefined {
		return this.state.connections.find(connection => connection.id === connectionId)?.name;
	}

	private async openSavedConnection(saved: SqlSavedConnection): Promise<void> {
		const alreadyOpen = this.state.connections.some(connection => connection.id === saved.id);

		if (alreadyOpen) {
			this.collapsedNodes.delete(getConnectionNodeId(saved.id));
			this.showInfo(`${saved.name} is already connected.`);
			this.renderTree();
			return;
		}

		await this.sqlConnectionService.openConnection({
			id: saved.id,
			name: saved.name,
			kind: saved.kind,
			databasePath: saved.databasePath,
			readOnly: saved.readOnly,
			createIfMissing: saved.createIfMissing
		});

		this.collapsedNodes.delete(getConnectionNodeId(saved.id));
		this.showInfo(`Connected to ${saved.name}.`);
		await this.refresh();
	}

	private async removeSavedConnection(connectionId: string): Promise<void> {
		await this.sqlConnectionService.removeSavedConnection({
			connectionId,
			closeIfOpen: false
		});

		this.showInfo('Saved connection removed.');
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

	private isExpanded(node: SqlConnectionTreeNode): boolean {
		return !this.collapsedNodes.has(node.id);
	}

	private showInfo(message: string): void {
		if (!this.messageElement) {
			return;
		}

		this.messageElement.classList.remove('error');
		this.messageElement.textContent = message;
	}

	private showError(error: unknown): void {
		if (!this.messageElement) {
			return;
		}

		this.messageElement.classList.add('error');
		this.messageElement.textContent = error instanceof Error ? error.message : String(error);
	}
}

function getConnectionNodeId(connectionId: string): string {
	return `sql/connection/${encodeURIComponent(connectionId)}`;
}

function isQueryOpenableNode(node: SqlConnectionTreeNode): boolean {
	return (
		node.type === SqlConnectionTreeNodeType.Connection ||
		node.type === SqlConnectionTreeNodeType.Table ||
		node.type === SqlConnectionTreeNodeType.View
	);
}

function getNodeIcon(node: SqlConnectionTreeNode): string {
	switch (node.type) {
		case SqlConnectionTreeNodeType.Connection:
			return '\u25c9';
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

function isPersistableDatabasePath(databasePath: string): boolean {
	return databasePath.trim() !== ':memory:';
}
