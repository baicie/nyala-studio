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
import { INotificationService } from '../../../../platform/notification/common/notification.js';
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
	SqlSslMode,
	SqlTable
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
import { SQL_CONNECTIONS_VIEW_ID } from '../common/sqlConnections.js';
import {
	createDefaultSqlConnectionFormState,
	createSafeSqlConnectionInputFromFormState,
	createSqlConnectionFormPreview,
	createSqlConnectionInputFromFormState,
	SQL_CONNECTION_PREVIEW_KINDS,
	SqlConnectionFormState
} from '../common/sqlConnectionFormModel.js';

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

	private driverSelect!: HTMLSelectElement;
	private sqliteFieldsElement!: HTMLElement;
	private networkFieldsElement!: HTMLElement;
	private hostInput!: HTMLInputElement;
	private portInput!: HTMLInputElement;
	private databaseInput!: HTMLInputElement;
	private usernameInput!: HTMLInputElement;
	private passwordInput!: HTMLInputElement;
	private sslModeInput!: HTMLSelectElement;
	private connectButton!: HTMLButtonElement;
	private driverPreviewElement!: HTMLElement;

	private currentFormKind: SqlConnectionKind = SqlConnectionKind.Sqlite;

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
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService
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

		const defaults = createDefaultSqlConnectionFormState(SqlConnectionKind.Sqlite);
		this.applyFormState(defaults);
		this.refreshDriverPreview();

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
		const formState = this.getFormState();
		const preview = createSqlConnectionFormPreview(formState);

		if (!preview.canConnect) {
			this.showInfo(preview.message);
			return;
		}

		if (preview.kind === SqlConnectionKind.PostgreSql) {
			this.showInfo(preview.message);
			return;
		}

		this.showInfo(preview.kind === SqlConnectionKind.MySql ? 'Opening MySQL connection...' : 'Opening SQLite connection...');

		try {
			const rawInput: SqlConnectionInput = createSqlConnectionInputFromFormState(formState);
			const safeInput: SqlConnectionInput = createSafeSqlConnectionInputFromFormState(formState);
			const input = preview.kind === SqlConnectionKind.MySql ? rawInput : safeInput;

			let connectionId: string;
			let connectionName: string;

			const shouldSave = preview.canSave;

			if (preview.kind === SqlConnectionKind.Sqlite && formState.saveConnection && !shouldSave) {
				this.showInfo('In-memory SQLite connections are temporary and will not be saved.');
			}

			if (shouldSave && preview.kind === SqlConnectionKind.MySql) {
				const connection = await this.sqlConnectionService.openConnection(rawInput);

				await this.sqlConnectionService.saveConnection({
					input: safeInput,
					autoConnect: false,
					openNow: false
				});

				connectionId = connection.id;
				connectionName = connection.name;
			} else if (shouldSave) {
				const saved = await this.sqlConnectionService.saveConnection({
					input,
					autoConnect: formState.autoConnect,
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

		const driverLabel = append(this.form, $('label.sql-connections-field'));
		append(driverLabel, $('span', undefined, 'Driver'));
		this.driverSelect = append(
			driverLabel,
			$('select.sql-connections-input', {
				'aria-label': 'SQL driver'
			})
		) as HTMLSelectElement;

		for (const kind of SQL_CONNECTION_PREVIEW_KINDS) {
			const option = document.createElement('option');
			option.value = kind;

			switch (kind) {
				case SqlConnectionKind.Sqlite:
					option.textContent = 'SQLite';
					break;
				case SqlConnectionKind.PostgreSql:
					option.textContent = 'PostgreSQL Preview';
					break;
				case SqlConnectionKind.MySql:
					option.textContent = 'MySQL Preview';
					break;
			}

			this.driverSelect.appendChild(option);
		}

		const nameLabel = append(this.form, $('label.sql-connections-field'));
		append(nameLabel, $('span', undefined, 'Name'));
		this.nameInput = append(
			nameLabel,
			$('input.sql-connections-input', {
				type: 'text',
				placeholder: 'Local SQLite'
			})
		) as HTMLInputElement;

		this.sqliteFieldsElement = append(this.form, $('.sql-connections-driver-fields.sqlite'));

		const pathLabel = append(this.sqliteFieldsElement, $('label.sql-connections-field'));
		append(pathLabel, $('span', undefined, 'Database path'));
		this.databasePathInput = append(
			pathLabel,
			$('input.sql-connections-input', {
				type: 'text',
				placeholder: '/absolute/path/to/database.db or :memory:'
			})
		) as HTMLInputElement;

		this.networkFieldsElement = append(this.form, $('.sql-connections-driver-fields.network'));

		const hostLabel = append(this.networkFieldsElement, $('label.sql-connections-field'));
		append(hostLabel, $('span', undefined, 'Host'));
		this.hostInput = append(
			hostLabel,
			$('input.sql-connections-input', {
				type: 'text',
				placeholder: 'localhost'
			})
		) as HTMLInputElement;

		const portLabel = append(this.networkFieldsElement, $('label.sql-connections-field'));
		append(portLabel, $('span', undefined, 'Port'));
		this.portInput = append(
			portLabel,
			$('input.sql-connections-input', {
				type: 'number',
				min: '1',
				max: '65535',
				placeholder: '3306'
			})
		) as HTMLInputElement;

		const databaseLabel = append(this.networkFieldsElement, $('label.sql-connections-field'));
		append(databaseLabel, $('span', undefined, 'Database'));
		this.databaseInput = append(
			databaseLabel,
			$('input.sql-connections-input', {
				type: 'text',
				placeholder: 'mysql'
			})
		) as HTMLInputElement;

		const usernameLabel = append(this.networkFieldsElement, $('label.sql-connections-field'));
		append(usernameLabel, $('span', undefined, 'Username'));
		this.usernameInput = append(
			usernameLabel,
			$('input.sql-connections-input', {
				type: 'text',
				placeholder: 'root'
			})
		) as HTMLInputElement;

		const passwordLabel = append(this.networkFieldsElement, $('label.sql-connections-field'));
		append(passwordLabel, $('span', undefined, 'Password'));
		this.passwordInput = append(
			passwordLabel,
			$('input.sql-connections-input', {
				type: 'password',
				placeholder: 'Preview only; not saved'
			})
		) as HTMLInputElement;

		const sslLabel = append(this.networkFieldsElement, $('label.sql-connections-field'));
		append(sslLabel, $('span', undefined, 'SSL mode'));
		this.sslModeInput = append(
			sslLabel,
			$('select.sql-connections-input')
		) as HTMLSelectElement;

		for (const mode of [SqlSslMode.Disable, SqlSslMode.Prefer, SqlSslMode.Require]) {
			const option = document.createElement('option');
			option.value = mode;
			option.textContent = mode;
			this.sslModeInput.appendChild(option);
		}

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

		this.driverPreviewElement = append(this.form, $('.sql-connection-driver-preview'));

		const actions = append(this.form, $('.sql-connections-actions'));
		this.connectButton = append(actions, $('button.sql-connections-button.primary', { type: 'submit' }, 'Connect')) as HTMLButtonElement;

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
			addDisposableListener(this.driverSelect, EventType.CHANGE, () => {
				switch (this.driverSelect.value) {
					case SqlConnectionKind.PostgreSql:
						this.currentFormKind = SqlConnectionKind.PostgreSql;
						break;
					case SqlConnectionKind.MySql:
						this.currentFormKind = SqlConnectionKind.MySql;
						break;
					case SqlConnectionKind.Sqlite:
					default:
						this.currentFormKind = SqlConnectionKind.Sqlite;
						break;
				}

				this.applyFormState(createDefaultSqlConnectionFormState(this.currentFormKind));
				this.refreshDriverPreview();
			})
		);

		for (const input of [
			this.nameInput,
			this.databasePathInput,
			this.hostInput,
			this.portInput,
			this.databaseInput,
			this.usernameInput,
			this.passwordInput,
			this.sslModeInput,
			this.readOnlyInput,
			this.createIfMissingInput,
			this.saveConnectionInput,
			this.autoConnectInput
		]) {
			this.formDisposables.add(
				addDisposableListener(input, EventType.CHANGE, () => this.refreshDriverPreview())
			);
		}

		this.formDisposables.add(
			addDisposableListener(this.saveConnectionInput, EventType.CHANGE, () => {
				this.autoConnectInput.disabled = !this.saveConnectionInput.checked;

				if (!this.saveConnectionInput.checked) {
					this.autoConnectInput.checked = false;
				}

				this.refreshDriverPreview();
			})
		);
	}

	private getFormState(): SqlConnectionFormState {
		return {
			kind: this.currentFormKind,
			name: this.nameInput.value,
			databasePath: this.databasePathInput.value,
			host: this.hostInput.value,
			port: this.portInput.value ? Number(this.portInput.value) : undefined,
			database: this.databaseInput.value,
			username: this.usernameInput.value,
			password: this.passwordInput.value,
			sslMode: this.sslModeInput.value as SqlSslMode,
			readOnly: this.readOnlyInput.checked,
			createIfMissing: this.createIfMissingInput.checked,
			saveConnection: this.saveConnectionInput.checked,
			autoConnect: this.autoConnectInput.checked
		};
	}

	private applyFormState(state: SqlConnectionFormState): void {
		this.currentFormKind = state.kind;
		this.driverSelect.value = state.kind;

		this.nameInput.value = state.name ?? '';
		this.databasePathInput.value = state.databasePath ?? ':memory:';

		this.hostInput.value = state.host ?? 'localhost';
		this.portInput.value = state.port ? String(state.port) : '3306';
		this.databaseInput.value = state.database ?? 'mysql';
		this.usernameInput.value = state.username ?? '';
		this.passwordInput.value = state.password ?? '';
		this.sslModeInput.value = state.sslMode ?? SqlSslMode.Prefer;

		this.readOnlyInput.checked = state.readOnly;
		this.createIfMissingInput.checked = state.createIfMissing;
		this.saveConnectionInput.checked = state.saveConnection;
		this.autoConnectInput.checked = state.autoConnect;
	}

	private refreshDriverPreview(): void {
		const formState = this.getFormState();
		const preview = createSqlConnectionFormPreview(formState);
		const isSqlite = preview.kind === SqlConnectionKind.Sqlite;
		const isPostgres = preview.kind === SqlConnectionKind.PostgreSql;
		const isMysql = preview.kind === SqlConnectionKind.MySql;

		this.sqliteFieldsElement.classList.toggle('hidden', !isSqlite);
		this.networkFieldsElement.classList.toggle('hidden', isSqlite);

		this.readOnlyInput.disabled = !isSqlite;
		this.createIfMissingInput.disabled = !isSqlite;
		this.saveConnectionInput.disabled = isPostgres;
		this.autoConnectInput.disabled = !isSqlite || !this.saveConnectionInput.checked;

		if (!isSqlite) {
			this.readOnlyInput.checked = false;
			this.createIfMissingInput.checked = false;
			this.autoConnectInput.checked = false;
		}

		if (isPostgres) {
			this.saveConnectionInput.checked = false;
		}

		this.connectButton.disabled = !preview.canConnect;

		clearNode(this.driverPreviewElement);

		const title = append(this.driverPreviewElement, $('.sql-connection-driver-preview-title'));
		title.textContent = preview.summary;

		const message = append(this.driverPreviewElement, $('.sql-connection-driver-preview-message'));
		message.textContent = preview.message;

		if (isMysql) {
			const note = append(this.driverPreviewElement, $('.sql-connection-driver-preview-note'));
			note.textContent = 'MySQL runtime preview is enabled. Password is only used for the current connection and is not saved.';
		}

		if (isPostgres) {
			const note = append(this.driverPreviewElement, $('.sql-connection-driver-preview-note'));
			note.textContent = 'PostgreSQL remains preview-only. Runtime connection is not enabled in this phase.';
		}
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

			delete this.state.errorsByConnectionId[connection.id];
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
		if (!isActionableNode(node)) {
			return;
		}

		const actions = append(row, $('.sql-connection-node-actions'));

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

			this.appendActionButton(actions, '\u00d7', 'Close connection', event => {
				event.preventDefault();
				event.stopPropagation();
				this.closeConnection(node.connectionId!).catch(error => this.showError(error));
			}, 'danger');

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
			$('button.sql-connection-node-action', {
				type: 'button',
				title
			}, label)
		) as HTMLButtonElement;

		if (variant) {
			button.classList.add(variant);
		}

		this.treeRenderDisposables.add(addDisposableListener(button, EventType.CLICK, listener));

		return button;
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
		columns: SqlColumn[];
	} {
		return {
			connectionName: node.connectionId ? this.getConnectionName(node.connectionId) : undefined,
			columns: this.getColumnsForNode(node)
		};
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

	private async refreshTable(node: SqlConnectionTreeNode): Promise<void> {
		if (!node.connectionId || !isSqlTableLikeNode(node)) {
			throw new Error('Cannot refresh columns for this node.');
		}

		const table = tableFromNode(node);

		this.showInfo(`Refreshing ${table.name}...`);

		const columns = await this.sqlMetadataService.listColumns({
			connectionId: node.connectionId,
			schema: table.schema,
			tableName: table.name
		});

		this.state.columnsByTableId[getColumnsKey(node.connectionId, table)] = columns;
		this.collapsedNodes.delete(node.id);
		this.renderTree();
		this.showInfo(`Refreshed ${table.name}.`);
	}

	private removeMetadataForConnection(connectionId: string): void {
		delete this.state.tablesByConnectionId[connectionId];
		delete this.state.errorsByConnectionId[connectionId];

		const prefix = getConnectionColumnsKeyPrefix(connectionId);

		for (const key of Object.keys(this.state.columnsByTableId)) {
			if (key.startsWith(prefix)) {
				delete this.state.columnsByTableId[key];
			}
		}
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

		const message = error instanceof Error ? error.message : String(error);
		this.messageElement.classList.add('error');
		this.messageElement.textContent = message;
		this.notificationService.error(message);
	}
}

function isActionableNode(node: SqlConnectionTreeNode): boolean {
	return node.type === SqlConnectionTreeNodeType.Connection || isSqlTableLikeNode(node);
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

async function writeClipboardText(text: string): Promise<void> {
	if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}

	throw new Error('Clipboard API is not available.');
}
