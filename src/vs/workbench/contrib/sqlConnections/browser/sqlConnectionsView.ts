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
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ISqlConnectionService } from '../../../services/sql/common/sqlConnection.js';
import { ISqlMetadataService } from '../../../services/sql/common/sqlMetadata.js';
import { SqlColumn, SqlConnection, SqlConnectionKind, SqlTable } from '../../../services/sql/common/sqlTypes.js';
import {
	buildSqlConnectionTree,
	getColumnsKey,
	SqlConnectionTreeNode,
	SqlConnectionTreeNodeType
} from '../common/sqlConnectionTreeModel.js';
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

	private body!: HTMLElement;
	private form!: HTMLFormElement;
	private nameInput!: HTMLInputElement;
	private databasePathInput!: HTMLInputElement;
	private readOnlyInput!: HTMLInputElement;
	private createIfMissingInput!: HTMLInputElement;
	private messageElement!: HTMLElement;
	private treeElement!: HTMLElement;

	private readonly collapsedNodes = new Set<string>();

	private readonly state: SqlConnectionTreeSnapshotState = {
		connections: [],
		tablesByConnectionId: Object.create(null),
		columnsByTableId: Object.create(null),
		errorsByConnectionId: Object.create(null)
	};

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
		@ISqlMetadataService private readonly sqlMetadataService: ISqlMetadataService
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
		this.messageElement = append(this.body, $('.sql-connections-message'));
		this.treeElement = append(this.body, $('.sql-connections-tree', { role: 'tree', tabIndex: 0 }));

		this.databasePathInput.value = ':memory:';
		this.createIfMissingInput.checked = true;

		this.refresh().catch(error => this.showError(error));
	}

	override focus(): void {
		this.treeElement?.focus();
		super.focus();
	}

	async refresh(): Promise<void> {
		this.showInfo('Loading connections...');

		try {
			const connections = await this.sqlConnectionService.listConnections();

			this.state.connections = connections;
			this.state.tablesByConnectionId = Object.create(null);
			this.state.columnsByTableId = Object.create(null);
			this.state.errorsByConnectionId = Object.create(null);

			for (const connection of connections) {
				await this.loadConnectionMetadata(connection);
			}

			this.showInfo(connections.length === 0 ? 'No connections yet.' : '');
			this.renderTree();
		} catch (error) {
			this.state.connections = [];
			this.state.tablesByConnectionId = Object.create(null);
			this.state.columnsByTableId = Object.create(null);
			this.state.errorsByConnectionId = Object.create(null);
			this.renderTree();
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
			const connection = await this.sqlConnectionService.openConnection({
				name: name || undefined,
				kind: SqlConnectionKind.Sqlite,
				databasePath,
				readOnly: this.readOnlyInput.checked,
				createIfMissing: this.createIfMissingInput.checked
			});

			this.collapsedNodes.delete(getConnectionNodeId(connection.id));
			this.showInfo(`Connected to ${connection.name}.`);
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

		twisty.textContent = hasChildren ? (isExpanded ? '▾' : '▸') : '';

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

		if (node.type === SqlConnectionTreeNodeType.Connection && node.connectionId) {
			const closeButton = append(
				row,
				$('button.sql-connection-node-action', {
					type: 'button',
					title: 'Close connection'
				})
			) as HTMLButtonElement;
			closeButton.textContent = '×';

			this.treeRenderDisposables.add(
				addDisposableListener(closeButton, EventType.CLICK, event => {
					event.preventDefault();
					event.stopPropagation();
					this.closeConnection(node.connectionId!).catch(error => this.showError(error));
				})
			);
		}

		if (hasChildren && isExpanded) {
			const children = append(wrapper, $('.sql-connection-node-children', { role: 'group' }));
			for (const child of node.children!) {
				children.appendChild(this.renderNode(child, depth + 1));
			}
		}

		return wrapper;
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

function getNodeIcon(node: SqlConnectionTreeNode): string {
	switch (node.type) {
		case SqlConnectionTreeNodeType.Connection:
			return '◉';
		case SqlConnectionTreeNodeType.Group:
			return '▣';
		case SqlConnectionTreeNodeType.Table:
			return '▦';
		case SqlConnectionTreeNodeType.View:
			return '◫';
		case SqlConnectionTreeNodeType.Column:
			return '•';
		case SqlConnectionTreeNodeType.Error:
			return '!';
		case SqlConnectionTreeNodeType.Empty:
		default:
			return '·';
	}
}
