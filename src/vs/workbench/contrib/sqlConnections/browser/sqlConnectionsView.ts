/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Connections View.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlConnections.css';
import './media/driverCardBadge.css';

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { Schemas } from '../../../../base/common/network.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { defaultSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ISqlConnectionService } from '../../../services/sql/common/sqlConnection.js';
import { isTauri } from '../../../../sidex-bridge.js';
import { ISqlDriverCatalogService } from '../../../services/sql/common/sqlDriverCatalog.js';
import { ISqlMetadataService } from '../../../services/sql/common/sqlMetadata.js';
import { getSqlConnectorRuntimeDriverId } from '../../../services/sql/common/sqlConnectorRuntimeGuard.js';
import { getDialectForConnectionKind, SqlDialect } from '../../../services/sql/common/sqlDialect.js';
import {
	SqlColumn,
	SqlConnection,
	SqlConnectionInput,
	SqlConnectionKind,
	SqlDatabase,
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
import {
	SQL_CONNECTIONS_ADD_COMMAND_ID,
	SQL_CONNECTIONS_VIEW_ID,
	SQL_CONNECTORS_VIEW_ID
} from '../common/sqlConnections.js';
import {
	refreshDataSourcesAfterConnection,
	requestSavedMysqlDataSourceForm
} from '../common/sqlConnectionNavigation.js';
import {
	refreshAndRequireSqlConnection,
	restoreSavedConnectionsForRefresh,
	SqlConnectionRefreshOptions
} from '../common/sqlConnectionRefresh.js';
import { setSqlConnectionFormTextControlsBusy } from '../common/sqlConnectionFormBusyState.js';
import { runSqlConnectionFormOperation } from '../common/sqlConnectionFormOperation.js';
import {
	createDefaultSqlConnectionFormState,
	createSafeSqlConnectionInputFromFormState,
	createSqlConnectionFormPreview,
	createSqlConnectionFormStateFromSavedConnection,
	createSqlConnectionInputFromFormState,
	getSqlConnectionFormFieldRequirements,
	getSqliteConnectionMode,
	setSqliteConnectionMode,
	SqlConnectionFormState,
	SqliteConnectionMode
} from '../common/sqlConnectionFormModel.js';
import { getSqlConnectorPresentation, SQL_CONNECTOR_PRESENTATIONS } from '../common/sqlConnectorPresentationModel.js';
import { openAndSaveMysqlConnection } from '../common/sqlConnectionSubmission.js';
import { buildSqlDriverStatusBadge, buildSqlDriverStatusPlaceholder, SqlDriverStatusBadge } from './driverCardBadge.js';
import { MysqlPreviewValidationController } from './mysqlValidationView.js';
import { applySqlConnectionFormAccessibility } from './sqlConnectionFormAccessibility.js';

interface SqlConnectionTreeSnapshotState {
	connections: SqlConnection[];
	databasesByConnectionId: Record<string, SqlDatabase[]>;
	tablesByConnectionId: Record<string, SqlTable[]>;
	columnsByTableId: Record<string, SqlColumn[]>;
	errorsByConnectionId: Record<string, string>;
	errorsByTableId: Record<string, string>;
}

const SQL_CONNECTOR_FORM_STATUS_ID = 'sql-connector-form-status';

export class SqlConnectionsView extends ViewPane {
	static readonly ID = SQL_CONNECTIONS_VIEW_ID;
	static readonly NAME = localize('sqlDataSourcesViewName', 'Data Sources');

	private readonly formDisposables = this._register(new DisposableStore());
	private readonly treeRenderDisposables = this._register(new DisposableStore());
	private readonly savedRenderDisposables = this._register(new DisposableStore());

	private body!: HTMLElement;
	private formSection!: HTMLElement;
	private form!: HTMLFormElement;
	private connectorHeaderIcon!: HTMLElement;
	private connectorHeaderTitle!: HTMLElement;
	private connectorHeaderDescription!: HTMLElement;
	private nameInput!: HTMLInputElement;
	private sqliteFileFieldsElement!: HTMLElement;
	private databasePathInput!: HTMLInputElement;
	private browseDatabaseButton!: HTMLButtonElement;
	private sqliteFileModeButton!: HTMLButtonElement;
	private sqliteMemoryModeButton!: HTMLButtonElement;
	private readOnlyOptionElement!: HTMLElement;
	private createIfMissingOptionElement!: HTMLElement;
	private saveConnectionOptionElement!: HTMLElement;
	private autoConnectOptionElement!: HTMLElement;
	private readOnlyInput!: HTMLInputElement;
	private createIfMissingInput!: HTMLInputElement;
	private saveConnectionInput!: HTMLInputElement;
	private autoConnectInput!: HTMLInputElement;
	private messageElement!: HTMLElement;
	private treeElement!: HTMLElement;
	private savedConnectionsElement!: HTMLElement;

	private readonly connectorButtons = new Map<SqlConnectionKind, HTMLButtonElement>();
	private readonly connectorBadges = new Map<SqlConnectionKind, HTMLElement>();
	private readonly connectorDescriptions = new Map<SqlConnectionKind, HTMLElement>();
	private readonly connectorAvailability = new Map<SqlConnectionKind, SqlDriverStatusBadge>();
	private connectorCatalogLoad: Promise<void> | undefined;
	private connectorCatalogUnavailable = false;
	private readonly touchedFormInputs = new Set<HTMLInputElement>();
	private sqliteFieldsElement!: HTMLElement;
	private networkFieldsElement!: HTMLElement;
	private hostInput!: HTMLInputElement;
	private portInput!: HTMLInputElement;
	private databaseInput!: HTMLInputElement;
	private usernameInput!: HTMLInputElement;
	private passwordInput!: HTMLInputElement;
	private sslModeSelect!: SelectBox;
	private sslModeKind!: SqlSslMode[];
	private currentSslIndex = 0;
	private testButton!: HTMLButtonElement;
	private validateButton!: HTMLButtonElement;
	private connectButton!: HTMLButtonElement;
	private driverPreviewElement!: HTMLElement;
	private resetButton!: HTMLButtonElement;
	private refreshButton!: HTMLButtonElement;

	private currentFormKind: SqlConnectionKind = SqlConnectionKind.Sqlite;
	private currentFormConnectionId: string | undefined;
	private currentSqliteMode = SqliteConnectionMode.File;
	private isFormBusy = false;
	private readonly mysqlValidationController: MysqlPreviewValidationController;

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
	private didRestoreSavedConnections = false;
	private readonly isConnectorView: boolean;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IContextViewService contextViewService: IContextViewService,
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
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService
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

		this.contextViewService = contextViewService;
		this.isConnectorView = options.id === SQL_CONNECTORS_VIEW_ID;
		this.mysqlValidationController = this._register(
			instantiationService.createInstance(MysqlPreviewValidationController)
		);
	}

	private readonly contextViewService: IContextViewService;

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
		this.renderConnectionForm(this.body);

		const defaults = createDefaultSqlConnectionFormState(SqlConnectionKind.Sqlite);
		this.applyFormState(defaults);
		this.formDisposables.add(
			this.sqlDriverCatalogService.onChange(() => {
				this.connectorCatalogUnavailable = false;
				this.refreshConnectorOptions();
				this.refreshDriverPreview();
			})
		);

		// Phase 00: warm the catalog so the selector reflects backend maturity.
		this.ensureConnectorCatalogLoaded().catch(() => undefined);
		this.refreshConnectorOptions();
		this.refreshDriverPreview();
	}

	private renderDataSourcesBody(): void {
		const actions = append(this.body, $('.sql-data-sources-actions'));
		const addDataSourceButton = this.appendIconButton(actions, 'add', 'New data source');
		const refreshDataSourcesButton = this.appendIconButton(actions, 'refresh', 'Refresh data sources');

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

		this.savedConnectionsElement = append(this.body, $('.sql-saved-connections'));
		this.messageElement = append(
			this.body,
			$('.sql-connections-message', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' })
		);
		this.treeElement = append(this.body, $('.sql-connections-tree', { role: 'tree', tabIndex: 0 }));

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

	override focus(): void {
		if (this.isConnectorView) {
			this.connectorButtons.get(this.currentFormKind)?.focus();
		} else {
			this.treeElement?.focus();
		}
		super.focus();
	}

	openConnectionForm(): void {
		if (!this.isConnectorView) {
			return;
		}

		this.resetConnectionForm();
		this.revealConnectionForm();
	}

	openSavedConnectionForm(saved: SqlSavedConnection): void {
		if (!this.isConnectorView) {
			return;
		}

		this.touchedFormInputs.clear();
		this.applyFormState(createSqlConnectionFormStateFromSavedConnection(saved));
		this.refreshDriverPreview();
		this.revealConnectionForm();
		this.passwordInput.focus();
		this.showInfo(`Enter the password for ${saved.name} to connect.`);
	}

	private revealConnectionForm(): void {
		this.connectorButtons.get(this.currentFormKind)?.focus();
	}

	async refresh(options: SqlConnectionRefreshOptions = {}): Promise<void> {
		if (this.isConnectorView) {
			return;
		}

		this.showInfo('Loading connections...');

		try {
			this.didRestoreSavedConnections = await restoreSavedConnectionsForRefresh(
				this.didRestoreSavedConnections,
				() => this.sqlConnectionService.restoreSavedConnections(),
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
			this.state.errorsByConnectionId = Object.create(null);
			this.state.errorsByTableId = Object.create(null);
			this.savedConnections = saved;

			for (const connection of connections) {
				await this.loadConnectionMetadata(connection);
			}

			this.showInfo(connections.length === 0 ? 'No connections yet.' : '');
			this.renderTree();
			this.renderSavedConnections();
		} catch (error) {
			this.state.connections = [];
			this.state.databasesByConnectionId = Object.create(null);
			this.state.tablesByConnectionId = Object.create(null);
			this.state.columnsByTableId = Object.create(null);
			this.state.errorsByConnectionId = Object.create(null);
			this.state.errorsByTableId = Object.create(null);
			this.savedConnections = [];
			this.renderTree();
			this.renderSavedConnections();
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

	async addConnectionFromForm(): Promise<void> {
		await this.runFormOperation(async formState => {
			const preview = createSqlConnectionFormPreview(formState);
			if (!preview.canConnect || preview.kind === SqlConnectionKind.PostgreSql) {
				this.showInfo(preview.message);
				return;
			}

			this.showInfo(
				preview.kind === SqlConnectionKind.MySql ? 'Opening MySQL connection...' : 'Opening SQLite connection...'
			);

			const rawInput: SqlConnectionInput = createSqlConnectionInputFromFormState(formState);
			const safeInput: SqlConnectionInput = createSafeSqlConnectionInputFromFormState(formState);
			const input = preview.kind === SqlConnectionKind.MySql ? rawInput : safeInput;

			let connectionId: string;
			let connectionName: string;

			const shouldSave = preview.canSave;

			if (shouldSave && preview.kind === SqlConnectionKind.MySql) {
				const connection = await openAndSaveMysqlConnection(this.sqlConnectionService, rawInput, safeInput);

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

			this.showInfo(`Connected to ${connectionName}.`);
			this.resetConnectionForm();
			await refreshDataSourcesAfterConnection(
				(commandId, ...args) => this.commandService.executeCommand(commandId, ...args),
				connectionId
			);
		});
	}

	private async testConnectionFromForm(): Promise<void> {
		await this.runFormOperation(async formState => {
			const preview = createSqlConnectionFormPreview(formState);
			if (!preview.canConnect || preview.kind === SqlConnectionKind.PostgreSql) {
				this.showInfo(preview.message);
				return;
			}

			this.showInfo('Testing connection...');
			const input =
				preview.kind === SqlConnectionKind.MySql
					? createSqlConnectionInputFromFormState(formState)
					: createSafeSqlConnectionInputFromFormState(formState);
			const result = await this.sqlConnectionService.testConnection(input);

			if (!result.ok) {
				throw new Error(result.error || 'Connection test failed.');
			}

			this.showInfo('Connection test passed.');
		});
	}

	private async validateMysqlFromForm(): Promise<void> {
		await this.runFormOperation(async formState => {
			const preview = createSqlConnectionFormPreview(formState);
			if (preview.kind !== SqlConnectionKind.MySql || !preview.canConnect) {
				this.showInfo(preview.message);
				return;
			}

			this.showInfo('Running MySQL Preview validation...');
			const outcome = await this.mysqlValidationController.validate(
				formState.host ?? '',
				formState.port ?? 0,
				formState.database ?? '',
				formState.username ?? '',
				formState.password ?? '',
				formState.sslMode ?? SqlSslMode.Prefer
			);

			if (!outcome.ok) {
				const detail = outcome.message || 'MySQL Preview validation failed.';
				throw new Error(outcome.code ? `${outcome.code}: ${detail}` : detail);
			}

			const warning = outcome.warnings.length > 0 ? ` ${outcome.warnings.join(' ')}` : '';
			this.showInfo(`MySQL Preview validation passed.${warning}`);
		});
	}

	private async runFormOperation(operation: (state: SqlConnectionFormState) => Promise<void>): Promise<void> {
		if (this.isFormBusy) {
			return;
		}

		this.isFormBusy = true;
		this.refreshDriverPreview();
		const formState = this.getFormState();

		try {
			await runSqlConnectionFormOperation({
				state: formState,
				catalog: this.sqlDriverCatalogService,
				loadCatalog: () => this.ensureConnectorCatalogLoaded(),
				operation: async state => {
					this.refreshConnectorOptions();
					await operation(state);
				},
				onError: error => this.showError(error),
				clearSecret: () => {
					this.passwordInput.value = '';
				}
			});
		} finally {
			this.isFormBusy = false;
			this.refreshDriverPreview();
		}
	}

	private renderConnectionForm(container: HTMLElement): void {
		this.formSection = append(container, $('.sql-connectors-settings'));
		const connectorCatalog = append(
			this.formSection,
			$('.sql-connectors-catalog', { role: 'group', 'aria-label': 'Database connectors' })
		);
		append(connectorCatalog, $('.sql-connectors-catalog-title', undefined, 'Connector'));

		for (const presentation of SQL_CONNECTOR_PRESENTATIONS) {
			const button = append(
				connectorCatalog,
				$(`button.sql-connector-option.sql-connector-option--${presentation.kind}`, {
					type: 'button',
					'aria-pressed': 'false',
					'aria-disabled': 'false',
					title: presentation.description
				})
			) as HTMLButtonElement;
			append(
				button,
				$(`span.codicon.codicon-${presentation.icon}.sql-connector-option-icon`, { 'aria-hidden': 'true' })
			);
			const copy = append(button, $('.sql-connector-option-copy'));
			const title = append(copy, $('.sql-connector-option-title'));
			append(title, $('span.sql-connector-option-name', undefined, presentation.label));
			const badge = append(title, $('.sql-driver-status-badge'));
			this.connectorBadges.set(presentation.kind, badge);
			const description = append(copy, $('.sql-connector-option-description', undefined, presentation.description));
			this.connectorButtons.set(presentation.kind, button);
			this.connectorDescriptions.set(presentation.kind, description);
			this.formDisposables.add(
				addDisposableListener(button, EventType.CLICK, () => {
					if (button.classList.contains('disabled') || this.isFormBusy) {
						this.showInfo(this.connectorAvailability.get(presentation.kind)?.title ?? presentation.description);
						return;
					}
					this.selectConnector(presentation.kind);
				})
			);
		}

		const settingsPane = append(this.formSection, $('.sql-connector-settings-pane'));
		const header = append(settingsPane, $('.sql-connector-settings-header'));
		this.connectorHeaderIcon = append(header, $('.sql-connector-settings-icon.codicon', { 'aria-hidden': 'true' }));
		const headerCopy = append(header, $('.sql-connector-settings-copy'));
		this.connectorHeaderTitle = append(headerCopy, $('h2.sql-connector-settings-title'));
		this.connectorHeaderDescription = append(headerCopy, $('.sql-connector-settings-description'));
		const headerActions = append(header, $('.sql-connections-form-header-actions'));
		this.resetButton = this.appendIconButton(headerActions, 'discard', 'Reset data source form');
		this.refreshButton = this.appendIconButton(headerActions, 'refresh', 'Refresh connector availability');

		this.form = append(
			settingsPane,
			$('form.sql-connections-form', {
				id: 'sql-connections-new-connection-form',
				'aria-label': 'Connection settings',
				'aria-busy': 'false'
			})
		) as HTMLFormElement;

		const generalSection = this.appendSettingsSection(this.form, 'General');
		const nameLabel = append(generalSection, $('label.sql-connections-field'));
		append(nameLabel, $('span.sql-connections-field-label', undefined, 'Name'));
		this.nameInput = append(
			nameLabel,
			$('input.sql-connections-input', {
				type: 'text',
				placeholder: 'Local SQLite'
			})
		) as HTMLInputElement;

		this.sqliteFieldsElement = this.appendSettingsSection(
			this.form,
			'Database',
			'sql-connections-driver-fields sqlite'
		);
		const sqliteModeField = append(this.sqliteFieldsElement, $('.sql-connections-field'));
		append(sqliteModeField, $('span.sql-connections-field-label', undefined, 'Mode'));
		const sqliteModeControl = append(
			sqliteModeField,
			$('.sql-connections-segmented', { role: 'group', 'aria-label': 'SQLite database mode' })
		);
		this.sqliteFileModeButton = append(
			sqliteModeControl,
			$('button.sql-connections-segment', { type: 'button', 'aria-pressed': 'true' }, 'File')
		) as HTMLButtonElement;
		this.sqliteMemoryModeButton = append(
			sqliteModeControl,
			$('button.sql-connections-segment', { type: 'button', 'aria-pressed': 'false' }, 'In-memory')
		) as HTMLButtonElement;

		this.sqliteFileFieldsElement = append(this.sqliteFieldsElement, $('.sql-connections-file-fields'));
		const pathLabel = append(this.sqliteFileFieldsElement, $('label.sql-connections-field'));
		append(pathLabel, $('span.sql-connections-field-label', undefined, 'File'));
		const pathRow = append(pathLabel, $('.sql-connections-path-row'));
		this.databasePathInput = append(
			pathRow,
			$('input.sql-connections-input', {
				type: 'text',
				placeholder: '/absolute/path/to/database.db'
			})
		) as HTMLInputElement;
		this.browseDatabaseButton = this.appendIconButton(pathRow, 'folder-opened', 'Browse for SQLite database');

		this.networkFieldsElement = append(this.form, $('.sql-connections-driver-fields.network'));
		const serverSection = this.appendSettingsSection(this.networkFieldsElement, 'Server');

		const networkAddressRow = append(serverSection, $('.sql-connections-network-address'));
		const hostLabel = append(networkAddressRow, $('label.sql-connections-field.sql-connections-host-field'));
		append(hostLabel, $('span.sql-connections-field-label', undefined, 'Host'));
		this.hostInput = append(
			hostLabel,
			$('input.sql-connections-input', {
				type: 'text',
				placeholder: 'localhost'
			})
		) as HTMLInputElement;

		const portLabel = append(networkAddressRow, $('label.sql-connections-field.sql-connections-port-field'));
		append(portLabel, $('span.sql-connections-field-label', undefined, 'Port'));
		this.portInput = append(
			portLabel,
			$('input.sql-connections-input', {
				type: 'number',
				min: '1',
				max: '65535',
				placeholder: '3306'
			})
		) as HTMLInputElement;

		const databaseLabel = append(serverSection, $('label.sql-connections-field'));
		append(databaseLabel, $('span.sql-connections-field-label', undefined, 'Database'));
		this.databaseInput = append(
			databaseLabel,
			$('input.sql-connections-input', {
				type: 'text',
				placeholder: 'mysql'
			})
		) as HTMLInputElement;

		const authenticationSection = this.appendSettingsSection(this.networkFieldsElement, 'Authentication');
		const usernameLabel = append(authenticationSection, $('label.sql-connections-field'));
		append(usernameLabel, $('span.sql-connections-field-label', undefined, 'Username'));
		this.usernameInput = append(
			usernameLabel,
			$('input.sql-connections-input', {
				type: 'text',
				placeholder: 'root',
				autocomplete: 'username'
			})
		) as HTMLInputElement;

		const passwordLabel = append(authenticationSection, $('label.sql-connections-field'));
		append(passwordLabel, $('span.sql-connections-field-label', undefined, 'Password (optional)'));
		this.passwordInput = append(
			passwordLabel,
			$('input.sql-connections-input', {
				type: 'password',
				placeholder: 'Not saved',
				autocomplete: 'current-password'
			})
		) as HTMLInputElement;

		const securitySection = this.appendSettingsSection(this.networkFieldsElement, 'Security');
		const sslLabel = append(securitySection, $('label.sql-connections-field'));
		append(sslLabel, $('span.sql-connections-field-label', undefined, 'SSL mode'));
		const sslHost = append(sslLabel, $('.sql-connections-selectbox.sql-connections-input'));
		this.sslModeKind = [SqlSslMode.Disable, SqlSslMode.Prefer, SqlSslMode.Require];
		this.currentSslIndex = this.sslModeKind.indexOf(SqlSslMode.Prefer);
		this.sslModeSelect = new SelectBox(
			this.sslModeKind.map(mode => ({ text: mode })),
			this.currentSslIndex,
			this.contextViewService,
			defaultSelectBoxStyles,
			{
				ariaLabel: localize('sqlConnectionsSslLabel', 'SSL mode'),
				useCustomDrawn: true
			}
		);
		this.sslModeSelect.render(sslHost);
		this.formDisposables.add(this.sslModeSelect);
		this.sslModeSelect.setAriaLabel(localize('sqlConnectionsSslLabel', 'SSL mode'));

		const optionsSection = this.appendSettingsSection(this.form, 'Options');
		const options = append(optionsSection, $('.sql-connections-options'));

		const readOnlyLabel = (this.readOnlyOptionElement = append(options, $('label.sql-connections-checkbox')));
		this.readOnlyInput = append(readOnlyLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
		append(readOnlyLabel, $('span', undefined, 'Read-only'));

		const createLabel = (this.createIfMissingOptionElement = append(options, $('label.sql-connections-checkbox')));
		this.createIfMissingInput = append(createLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
		append(createLabel, $('span', undefined, 'Create if missing'));

		const saveLabel = (this.saveConnectionOptionElement = append(options, $('label.sql-connections-checkbox')));
		this.saveConnectionInput = append(saveLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
		append(saveLabel, $('span', undefined, 'Save'));

		const autoConnectLabel = (this.autoConnectOptionElement = append(options, $('label.sql-connections-checkbox')));
		this.autoConnectInput = append(autoConnectLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
		append(autoConnectLabel, $('span', undefined, 'Auto connect'));

		const footer = append(this.form, $('.sql-connectors-footer'));
		this.driverPreviewElement = append(
			footer,
			$('.sql-connection-driver-preview', {
				id: SQL_CONNECTOR_FORM_STATUS_ID,
				role: 'status',
				'aria-live': 'polite',
				'aria-atomic': 'true'
			})
		);
		this.messageElement = append(
			footer,
			$('.sql-connections-message', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' })
		);

		const actions = append(footer, $('.sql-connections-actions'));
		this.testButton = append(
			actions,
			$('button.sql-connections-button', { type: 'button' }, 'Test')
		) as HTMLButtonElement;
		this.validateButton = append(
			actions,
			$(
				'button.sql-connections-button',
				{
					type: 'button',
					title: 'Run MySQL Preview validation'
				},
				'Validate'
			)
		) as HTMLButtonElement;
		this.connectButton = append(
			actions,
			$('button.sql-connections-button.primary', { type: 'submit' }, 'Connect')
		) as HTMLButtonElement;

		this.formDisposables.add(
			addDisposableListener(this.form, EventType.SUBMIT, event => {
				event.preventDefault();
				this.addConnectionFromForm().catch(error => this.showError(error));
			})
		);

		this.formDisposables.add(
			addDisposableListener(this.resetButton, EventType.CLICK, () => {
				this.resetConnectionForm();
			})
		);

		this.formDisposables.add(
			addDisposableListener(this.refreshButton, EventType.CLICK, () => {
				this.refreshConnectorCatalog().catch(error => this.showError(error));
			})
		);

		this.formDisposables.add(
			addDisposableListener(this.testButton, EventType.CLICK, () => {
				this.testConnectionFromForm().catch(error => this.showError(error));
			})
		);

		this.formDisposables.add(
			addDisposableListener(this.validateButton, EventType.CLICK, () => {
				this.validateMysqlFromForm().catch(error => this.showError(error));
			})
		);

		this.formDisposables.add(
			addDisposableListener(this.browseDatabaseButton, EventType.CLICK, () => {
				this.pickSqliteDatabaseFile().catch(error => this.showError(error));
			})
		);

		this.formDisposables.add(
			addDisposableListener(this.sqliteFileModeButton, EventType.CLICK, () => {
				this.applyFormState(setSqliteConnectionMode(this.getFormState(), SqliteConnectionMode.File));
				this.refreshDriverPreview();
			})
		);

		this.formDisposables.add(
			addDisposableListener(this.sqliteMemoryModeButton, EventType.CLICK, () => {
				this.applyFormState(setSqliteConnectionMode(this.getFormState(), SqliteConnectionMode.Memory));
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
			this.passwordInput
		]) {
			this.formDisposables.add(addDisposableListener(input, EventType.INPUT, () => this.refreshDriverPreview()));
			this.formDisposables.add(
				addDisposableListener(input, EventType.BLUR, () => {
					this.touchedFormInputs.add(input);
					this.refreshDriverPreview();
				})
			);
		}

		for (const input of [this.readOnlyInput, this.createIfMissingInput, this.autoConnectInput]) {
			this.formDisposables.add(addDisposableListener(input, EventType.CHANGE, () => this.refreshDriverPreview()));
		}

		this.formDisposables.add(
			this.sslModeSelect.onDidSelect(({ index }) => {
				this.currentSslIndex = index;
				this.refreshDriverPreview();
			})
		);

		this.formDisposables.add(
			addDisposableListener(this.saveConnectionInput, EventType.CHANGE, () => {
				if (!this.saveConnectionInput.checked) {
					this.autoConnectInput.checked = false;
				}

				this.refreshDriverPreview();
			})
		);
	}

	private appendSettingsSection(parent: HTMLElement, title: string, classNames = ''): HTMLElement {
		const section = append(parent, $('section.sql-connector-section'));
		for (const className of classNames.split(' ').filter(Boolean)) {
			section.classList.add(className);
		}
		append(section, $('h3.sql-connector-section-title', undefined, title));
		return section;
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

	private getFormState(): SqlConnectionFormState {
		const sslMode = this.sslModeKind?.[this.currentSslIndex] ?? SqlSslMode.Prefer;
		return {
			id: this.currentFormConnectionId,
			kind: this.currentFormKind,
			name: this.nameInput.value,
			sqliteMode: this.currentSqliteMode,
			databasePath: this.databasePathInput.value,
			host: this.hostInput.value,
			port: this.portInput.value ? Number(this.portInput.value) : undefined,
			database: this.databaseInput.value,
			username: this.usernameInput.value,
			password: this.passwordInput.value,
			sslMode,
			readOnly: this.readOnlyInput.checked,
			createIfMissing: this.createIfMissingInput.checked,
			saveConnection: this.saveConnectionInput.checked,
			autoConnect: this.autoConnectInput.checked
		};
	}

	private applyFormState(state: SqlConnectionFormState): void {
		this.currentFormConnectionId = state.id;
		this.currentFormKind = state.kind;
		this.currentSqliteMode = getSqliteConnectionMode(state);
		this.refreshConnectorSelection();

		this.nameInput.value = state.name ?? '';
		this.databasePathInput.value = state.databasePath ?? '';

		this.hostInput.value = state.host ?? '';
		this.portInput.value = state.port === undefined ? '' : String(state.port);
		this.databaseInput.value = state.database ?? '';
		this.usernameInput.value = state.username ?? '';
		this.passwordInput.value = state.password ?? '';
		const sslIndex = this.sslModeKind.indexOf(state.sslMode ?? SqlSslMode.Prefer);
		if (sslIndex >= 0) {
			this.currentSslIndex = sslIndex;
			this.sslModeSelect.select(sslIndex);
		}

		this.readOnlyInput.checked = state.readOnly;
		this.createIfMissingInput.checked = state.createIfMissing;
		this.saveConnectionInput.checked = state.saveConnection;
		this.autoConnectInput.checked = state.autoConnect;
	}

	private resetConnectionForm(): void {
		this.touchedFormInputs.clear();
		this.applyFormState(createDefaultSqlConnectionFormState(this.currentFormKind));
		this.refreshDriverPreview();
	}

	private selectConnector(kind: SqlConnectionKind): void {
		if (kind === this.currentFormKind) {
			return;
		}

		this.touchedFormInputs.clear();
		this.applyFormState(createDefaultSqlConnectionFormState(kind));
		this.refreshDriverPreview();
		this.nameInput.focus();
	}

	private refreshConnectorSelection(): void {
		const selected = getSqlConnectorPresentation(this.currentFormKind);
		for (const [kind, button] of this.connectorButtons) {
			const isSelected = kind === selected.kind;
			button.classList.toggle('selected', isSelected);
			button.setAttribute('aria-pressed', String(isSelected));
		}

		this.connectorHeaderIcon.className = `sql-connector-settings-icon codicon codicon-${selected.icon}`;
		this.connectorHeaderTitle.textContent = selected.label;
		this.connectorHeaderDescription.textContent = selected.description;
	}

	private createConnectorBadge(kind: SqlConnectionKind): SqlDriverStatusBadge {
		const presentation = getSqlConnectorPresentation(kind);
		try {
			return buildSqlDriverStatusBadge(this.sqlDriverCatalogService, getSqlConnectorRuntimeDriverId(kind));
		} catch {
			return buildSqlDriverStatusPlaceholder(presentation.label, this.connectorCatalogUnavailable);
		}
	}

	private refreshConnectorOptions(): void {
		for (const presentation of SQL_CONNECTOR_PRESENTATIONS) {
			const badge = this.createConnectorBadge(presentation.kind);
			this.connectorAvailability.set(presentation.kind, badge);
			const badgeElement = this.connectorBadges.get(presentation.kind);
			const button = this.connectorButtons.get(presentation.kind);
			const descriptionElement = this.connectorDescriptions.get(presentation.kind);
			if (!badgeElement || !button || !descriptionElement) {
				continue;
			}

			badgeElement.className = badge.className;
			badgeElement.textContent = badge.text;
			badgeElement.setAttribute('aria-label', badge.ariaLabel);
			badgeElement.title = badge.title;
			const description = badge.runnable ? presentation.description : badge.title;
			descriptionElement.textContent = description;
			button.title = description;
			const disabled = !badge.runnable;
			button.classList.toggle('disabled', disabled);
			button.setAttribute('aria-disabled', String(disabled));
		}
		this.refreshConnectorSelection();
	}

	private refreshDriverPreview(): void {
		const formState = this.getFormState();
		const preview = createSqlConnectionFormPreview(formState);
		const availability = this.connectorAvailability.get(preview.kind) ?? this.createConnectorBadge(preview.kind);
		const isSqlite = preview.kind === SqlConnectionKind.Sqlite;
		const isPostgres = preview.kind === SqlConnectionKind.PostgreSql;
		const isMysql = preview.kind === SqlConnectionKind.MySql;
		const isMemory = isSqlite && getSqliteConnectionMode(formState) === SqliteConnectionMode.Memory;

		this.sqliteFieldsElement.classList.toggle('hidden', !isSqlite);
		this.networkFieldsElement.classList.toggle('hidden', isSqlite);
		this.sqliteFileFieldsElement.classList.toggle('hidden', isMemory);
		this.sqliteFileModeButton.classList.toggle('selected', isSqlite && !isMemory);
		this.sqliteMemoryModeButton.classList.toggle('selected', isMemory);
		this.sqliteFileModeButton.setAttribute('aria-pressed', String(isSqlite && !isMemory));
		this.sqliteMemoryModeButton.setAttribute('aria-pressed', String(isMemory));
		this.nameInput.placeholder = isMysql ? 'Local MySQL' : 'Local SQLite';
		this.readOnlyOptionElement.classList.toggle('hidden', !isSqlite);
		this.createIfMissingOptionElement.classList.toggle('hidden', !isSqlite || isMemory);
		this.saveConnectionOptionElement.classList.toggle('hidden', isPostgres || isMemory);
		this.autoConnectOptionElement.classList.toggle('hidden', !isSqlite || isMemory);

		if (!isSqlite || isMemory) {
			if (!isSqlite) {
				this.readOnlyInput.checked = false;
			}
			this.createIfMissingInput.checked = false;
			this.autoConnectInput.checked = false;
		}

		if (isMemory || isPostgres) {
			this.saveConnectionInput.checked = false;
		}

		if (isPostgres) {
			this.readOnlyInput.checked = false;
		}

		this.form.setAttribute('aria-busy', String(this.isFormBusy));
		setSqlConnectionFormTextControlsBusy(
			[
				this.nameInput,
				this.databasePathInput,
				this.hostInput,
				this.portInput,
				this.databaseInput,
				this.usernameInput,
				this.passwordInput
			],
			this.isFormBusy
		);
		for (const button of this.connectorButtons.values()) {
			button.disabled = this.isFormBusy;
		}
		this.sslModeSelect.setEnabled(!this.isFormBusy && !isSqlite);
		this.sqliteFileModeButton.disabled = this.isFormBusy || !isSqlite;
		this.sqliteMemoryModeButton.disabled = this.isFormBusy || !isSqlite;
		this.readOnlyInput.disabled = this.isFormBusy || !isSqlite;
		this.createIfMissingInput.disabled = this.isFormBusy || !isSqlite || isMemory;
		this.browseDatabaseButton.disabled = this.isFormBusy || !isSqlite || isMemory;
		this.saveConnectionInput.disabled = this.isFormBusy || isPostgres || isMemory;
		this.autoConnectInput.disabled = this.isFormBusy || !isSqlite || isMemory || !this.saveConnectionInput.checked;
		this.resetButton.disabled = this.isFormBusy;
		this.refreshButton.disabled = this.isFormBusy;

		this.testButton.disabled = this.isFormBusy || !availability.runnable || !preview.canConnect || isPostgres;
		this.validateButton.classList.toggle('hidden', !isMysql);
		this.validateButton.disabled = this.isFormBusy || !availability.runnable || !preview.canConnect || !isMysql;
		this.connectButton.disabled = this.isFormBusy || !availability.runnable || !preview.canConnect || isPostgres;

		const hasVisibleError = applySqlConnectionFormAccessibility({
			controls: {
				databasePath: this.databasePathInput,
				host: this.hostInput,
				port: this.portInput,
				database: this.databaseInput,
				username: this.usernameInput
			},
			requirements: getSqlConnectionFormFieldRequirements(formState),
			missingFields: preview.missingFields,
			touchedControls: this.touchedFormInputs,
			describedBy: SQL_CONNECTOR_FORM_STATUS_ID
		});

		clearNode(this.driverPreviewElement);
		const title = append(this.driverPreviewElement, $('.sql-connection-driver-preview-title'));
		const message = append(this.driverPreviewElement, $('.sql-connection-driver-preview-message'));
		if (!availability.runnable) {
			title.textContent = availability.text;
			message.textContent = availability.title;
		} else {
			title.textContent = preview.canConnect ? preview.summary : 'Required settings';
			message.textContent = preview.message;
		}
		title.title = title.textContent;
		message.title = message.textContent;
		this.driverPreviewElement.classList.toggle('error', hasVisibleError);
		this.driverPreviewElement.classList.toggle('mysql-warning', isMysql);
		this.driverPreviewElement.classList.toggle('planned', isPostgres);
	}

	private async pickSqliteDatabaseFile(): Promise<void> {
		const selected = await this.fileDialogService.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			title: 'Select SQLite database',
			openLabel: 'Select',
			availableFileSystems: [Schemas.file],
			filters: [
				{
					name: 'SQLite databases',
					extensions: ['db', 'sqlite', 'sqlite3']
				},
				{
					name: 'All files',
					extensions: ['*']
				}
			]
		});

		if (!selected?.[0]) {
			return;
		}

		this.currentSqliteMode = SqliteConnectionMode.File;
		this.databasePathInput.value = selected[0].fsPath;
		this.refreshDriverPreview();
		this.databasePathInput.focus();
	}

	private async refreshConnectorCatalog(): Promise<void> {
		await this.ensureConnectorCatalogLoaded(true);
		this.refreshConnectorOptions();
		this.refreshDriverPreview();
		this.showInfo('Connector availability refreshed.');
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
				this.refreshConnectorOptions();
				this.refreshDriverPreview();
			});
		this.connectorCatalogLoad = load;
		return load;
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

	private renderSavedConnections(): void {
		this.savedRenderDisposables.clear();
		clearNode(this.savedConnectionsElement);

		if (this.savedConnections.length === 0) {
			return;
		}

		const title = append(this.savedConnectionsElement, $('.sql-saved-connections-title'));
		title.textContent = 'Saved Data Sources';

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

		const structuredMessage = (error as { message?: unknown } | undefined)?.message;
		const message =
			error instanceof Error
				? error.message
				: typeof structuredMessage === 'string'
					? structuredMessage
					: String(error);
		this.messageElement.classList.add('error');
		this.messageElement.setAttribute('role', 'alert');
		this.messageElement.setAttribute('aria-live', 'assertive');
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
