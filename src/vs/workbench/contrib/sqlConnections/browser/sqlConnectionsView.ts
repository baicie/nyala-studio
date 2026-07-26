/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Connections View.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlConnections.css';

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { ISelectOptionItem, SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
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
import {
	ISqlDriverCatalogService,
	SqlRuntimeDriverId,
	SqlRuntimeStatus
} from '../../../services/sql/common/sqlDriverCatalog.js';
import { ISqlMetadataService } from '../../../services/sql/common/sqlMetadata.js';
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
import { SQL_CONNECTIONS_VIEW_ID } from '../common/sqlConnections.js';
import {
	refreshAndRequireSqlConnection,
	restoreSavedConnectionsForRefresh,
	SqlConnectionRefreshOptions
} from '../common/sqlConnectionRefresh.js';
import { setSqlConnectionFormTextControlsBusy } from '../common/sqlConnectionFormBusyState.js';
import {
	createDefaultSqlConnectionFormState,
	createSafeSqlConnectionInputFromFormState,
	createSqlConnectionFormPreview,
	createSqlConnectionFormStateFromSavedConnection,
	createSqlConnectionInputFromFormState,
	getSqliteConnectionMode,
	SQL_CONNECTION_PREVIEW_KINDS,
	setSqliteConnectionMode,
	SqlConnectionFormState,
	SqliteConnectionMode
} from '../common/sqlConnectionFormModel.js';
import { openAndSaveMysqlConnection } from '../common/sqlConnectionSubmission.js';
import { MysqlPreviewValidationController } from './mysqlValidationView.js';

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
	static readonly NAME = localize('sqlConnectionsViewName', 'Connections');

	private readonly formDisposables = this._register(new DisposableStore());
	private readonly treeRenderDisposables = this._register(new DisposableStore());
	private readonly savedRenderDisposables = this._register(new DisposableStore());

	private body!: HTMLElement;
	private formSection!: HTMLElement;
	private formToggleButton!: HTMLButtonElement;
	private formToggleIcon!: HTMLElement;
	private form!: HTMLFormElement;
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

	private driverSelect!: SelectBox;
	private currentDriverIndex = 0;
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
	private isConnectionFormExpanded = true;
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
		this.mysqlValidationController = this._register(
			instantiationService.createInstance(MysqlPreviewValidationController)
		);
	}

	private readonly contextViewService: IContextViewService;

	protected override renderBody(container: HTMLElement): void {
		this.body = append(container, $('.sql-connections-view'));
		this.renderConnectionForm(this.body);
		this.savedConnectionsElement = append(this.body, $('.sql-saved-connections'));
		this.messageElement = append(
			this.body,
			$('.sql-connections-message', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' })
		);
		this.treeElement = append(this.body, $('.sql-connections-tree', { role: 'tree', tabIndex: 0 }));

		const defaults = createDefaultSqlConnectionFormState(SqlConnectionKind.Sqlite);
		this.applyFormState(defaults);
		this.setConnectionFormExpanded(true);

		// Phase 00: warm the catalog so the selector reflects backend maturity.
		this.sqlDriverCatalogService
			.getRuntimeStatus()
			.then(() => {
				this.refreshDriverSelectOptions();
				this.refreshDriverPreview();
			})
			.catch(() => {
				this.refreshDriverSelectOptions();
				this.refreshDriverPreview();
			});
		this.refreshDriverSelectOptions();
		this.refreshDriverPreview();

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
		this.treeElement?.focus();
		super.focus();
	}

	openConnectionForm(): void {
		this.resetConnectionForm();
		this.revealConnectionForm();
	}

	private revealConnectionForm(): void {
		this.setConnectionFormExpanded(true);
		this.driverSelect?.focus();
	}

	async refresh(options: SqlConnectionRefreshOptions = {}): Promise<void> {
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
		this.setConnectionFormExpanded(false);
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

			this.collapsedNodes.delete(getConnectionNodeId(connectionId));
			await this.refresh();
			this.showInfo(`Connected to ${connectionName}.`);
			this.resetConnectionForm();
			this.setConnectionFormExpanded(false);
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
			await operation(formState);
		} catch (error) {
			this.showError(error);
		} finally {
			this.passwordInput.value = '';
			this.isFormBusy = false;
			this.refreshDriverPreview();
		}
	}

	private renderConnectionForm(container: HTMLElement): void {
		this.formSection = append(container, $('.sql-connections-form-section'));
		const header = append(this.formSection, $('.sql-connections-form-header'));
		this.formToggleButton = append(
			header,
			$('button.sql-connections-form-toggle', {
				type: 'button',
				'aria-expanded': 'true',
				'aria-controls': 'sql-connections-new-connection-form'
			})
		) as HTMLButtonElement;
		this.formToggleIcon = append(
			this.formToggleButton,
			$('span.codicon.codicon-chevron-down', { 'aria-hidden': 'true' })
		);
		append(this.formToggleButton, $('span.sql-connections-form-title', undefined, 'New connection'));

		const headerActions = append(header, $('.sql-connections-form-header-actions'));
		this.resetButton = this.appendIconButton(headerActions, 'discard', 'Reset connection form');
		this.refreshButton = this.appendIconButton(headerActions, 'refresh', 'Refresh connections');

		this.form = append(
			this.formSection,
			$('form.sql-connections-form', {
				id: 'sql-connections-new-connection-form',
				'aria-busy': 'false'
			})
		) as HTMLFormElement;

		const driverLabel = append(this.form, $('label.sql-connections-field'));
		append(driverLabel, $('span', undefined, 'Connector'));
		const driverHost = append(driverLabel, $('.sql-connections-selectbox.sql-connections-input'));
		this.currentDriverIndex = 0;
		this.driverSelect = new SelectBox(
			this.createDriverSelectOptions(),
			this.currentDriverIndex,
			this.contextViewService,
			defaultSelectBoxStyles,
			{
				ariaLabel: localize('sqlConnectionsDriverLabel', 'SQL connector'),
				ariaDescription: localize('sqlConnectionsDriverDescription', 'Select a stable or preview database connector.'),
				useCustomDrawn: true
			}
		);
		this.driverSelect.render(driverHost);
		this.formDisposables.add(this.driverSelect);
		this.driverSelect.setAriaLabel(localize('sqlConnectionsDriverLabel', 'SQL connector'));

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
		const sqliteModeField = append(this.sqliteFieldsElement, $('.sql-connections-field'));
		append(sqliteModeField, $('span', undefined, 'Database'));
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
		append(pathLabel, $('span', undefined, 'Database path'));
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

		const networkAddressRow = append(this.networkFieldsElement, $('.sql-connections-network-address'));
		const hostLabel = append(networkAddressRow, $('label.sql-connections-field.sql-connections-host-field'));
		append(hostLabel, $('span', undefined, 'Host'));
		this.hostInput = append(
			hostLabel,
			$('input.sql-connections-input', {
				type: 'text',
				placeholder: 'localhost'
			})
		) as HTMLInputElement;

		const portLabel = append(networkAddressRow, $('label.sql-connections-field.sql-connections-port-field'));
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
				placeholder: 'root',
				autocomplete: 'username'
			})
		) as HTMLInputElement;

		const passwordLabel = append(this.networkFieldsElement, $('label.sql-connections-field'));
		append(passwordLabel, $('span', undefined, 'Password (optional)'));
		this.passwordInput = append(
			passwordLabel,
			$('input.sql-connections-input', {
				type: 'password',
				placeholder: 'Not saved',
				autocomplete: 'current-password'
			})
		) as HTMLInputElement;

		const sslLabel = append(this.networkFieldsElement, $('label.sql-connections-field'));
		append(sslLabel, $('span', undefined, 'SSL mode'));
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

		const options = append(this.form, $('.sql-connections-options'));

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

		this.driverPreviewElement = append(
			this.form,
			$('.sql-connection-driver-preview', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' })
		);

		const actions = append(this.form, $('.sql-connections-actions'));
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
			addDisposableListener(this.formToggleButton, EventType.CLICK, () => {
				this.setConnectionFormExpanded(!this.isConnectionFormExpanded);
			})
		);

		this.formDisposables.add(
			addDisposableListener(this.resetButton, EventType.CLICK, () => {
				this.resetConnectionForm();
			})
		);

		this.formDisposables.add(
			addDisposableListener(this.refreshButton, EventType.CLICK, () => {
				this.refresh().catch(error => this.showError(error));
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

		this.formDisposables.add(
			this.driverSelect.onDidSelect(({ index }) => {
				const kind = this.kindAtDriverIndex(index) ?? SqlConnectionKind.Sqlite;
				this.currentDriverIndex = index;
				this.currentFormKind = kind;

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
			this.passwordInput
		]) {
			this.formDisposables.add(addDisposableListener(input, EventType.INPUT, () => this.refreshDriverPreview()));
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
		const driverIndex = SQL_CONNECTION_PREVIEW_KINDS.indexOf(state.kind);
		if (driverIndex >= 0) {
			this.currentDriverIndex = driverIndex;
			this.driverSelect.select(driverIndex);
		}

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
		this.applyFormState(createDefaultSqlConnectionFormState(this.currentFormKind));
		this.refreshDriverPreview();
	}

	private kindAtDriverIndex(index: number): SqlConnectionKind | undefined {
		return SQL_CONNECTION_PREVIEW_KINDS[index];
	}

	private createDriverSelectOptions(): ISelectOptionItem[] {
		return SQL_CONNECTION_PREVIEW_KINDS.map(kind => {
			const fallback = getDriverOptionFallback(kind);
			const driverId = driverIdForConnectionKind(kind);
			let displayName = fallback.displayName;
			let status = fallback.status;
			let description = fallback.description;

			if (driverId !== undefined) {
				try {
					const entry = this.sqlDriverCatalogService.findRuntimeStatus(driverId);
					if (entry) {
						displayName = entry.displayName;
						status = entry.status;
						description = entry.summary;
					}
				} catch {
					// The fallback keeps the selector useful while the catalog warms up.
				}
			}

			return {
				text: `${displayName} · ${formatRuntimeStatus(status)}`,
				description,
				isDisabled:
					kind === SqlConnectionKind.PostgreSql ||
					status === SqlRuntimeStatus.Planned ||
					status === SqlRuntimeStatus.Disabled
			};
		});
	}

	private refreshDriverPreview(): void {
		const formState = this.getFormState();
		const preview = createSqlConnectionFormPreview(formState);
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
		this.driverSelect.setEnabled(!this.isFormBusy);
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

		this.testButton.disabled = this.isFormBusy || !preview.canConnect || isPostgres;
		this.validateButton.classList.toggle('hidden', !isMysql);
		this.validateButton.disabled = this.isFormBusy || !preview.canConnect || !isMysql;
		this.connectButton.disabled = this.isFormBusy || !preview.canConnect || isPostgres;

		this.setInputValidity(
			this.databasePathInput,
			isSqlite && !isMemory && preview.missingFields.includes('databasePath')
		);
		this.setInputValidity(this.hostInput, !isSqlite && preview.missingFields.includes('host'));
		this.setInputValidity(this.portInput, !isSqlite && preview.missingFields.includes('port'));
		this.setInputValidity(this.databaseInput, !isSqlite && preview.missingFields.includes('database'));
		this.setInputValidity(this.usernameInput, isMysql && preview.missingFields.includes('username'));

		clearNode(this.driverPreviewElement);
		const title = append(this.driverPreviewElement, $('.sql-connection-driver-preview-title'));
		title.textContent = preview.summary;
		const message = append(this.driverPreviewElement, $('.sql-connection-driver-preview-message'));
		message.textContent = preview.message;
		this.driverPreviewElement.classList.toggle('error', preview.missingFields.length > 0);
		this.driverPreviewElement.classList.toggle('mysql-warning', isMysql);
		this.driverPreviewElement.classList.toggle('planned', isPostgres);
	}

	private setInputValidity(input: HTMLInputElement, invalid: boolean): void {
		input.classList.toggle('invalid', invalid);
		if (invalid) {
			input.setAttribute('aria-invalid', 'true');
		} else {
			input.removeAttribute('aria-invalid');
		}
	}

	private setConnectionFormExpanded(expanded: boolean): void {
		this.isConnectionFormExpanded = expanded;
		this.form.hidden = !expanded;
		this.formToggleButton.setAttribute('aria-expanded', String(expanded));
		this.formToggleIcon.classList.toggle('codicon-chevron-down', expanded);
		this.formToggleIcon.classList.toggle('codicon-chevron-right', !expanded);
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

	private refreshDriverSelectOptions(): void {
		if (!this.driverSelect) {
			return;
		}

		this.driverSelect.setOptions(this.createDriverSelectOptions(), this.currentDriverIndex);
		this.driverSelect.select(this.currentDriverIndex);
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
			this.applyFormState(createSqlConnectionFormStateFromSavedConnection(saved));
			this.refreshDriverPreview();
			this.revealConnectionForm();
			this.passwordInput.focus();
			this.showInfo(`Enter the password for ${saved.name} to connect.`);
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

function driverIdForConnectionKind(kind: SqlConnectionKind): SqlRuntimeDriverId | undefined {
	switch (kind) {
		case SqlConnectionKind.Sqlite:
			return SqlRuntimeDriverId.Sqlite;
		case SqlConnectionKind.MySql:
			return SqlRuntimeDriverId.MySql;
		case SqlConnectionKind.PostgreSql:
			return SqlRuntimeDriverId.Postgres;
		default:
			return undefined;
	}
}

function getDriverOptionFallback(kind: SqlConnectionKind): {
	displayName: string;
	status: SqlRuntimeStatus;
	description: string;
} {
	switch (kind) {
		case SqlConnectionKind.MySql:
			return {
				displayName: 'MySQL',
				status: SqlRuntimeStatus.Preview,
				description: 'Local and development validation; query cancellation is not available yet.'
			};
		case SqlConnectionKind.PostgreSql:
			return {
				displayName: 'PostgreSQL',
				status: SqlRuntimeStatus.Planned,
				description: 'Runtime support is planned and cannot be selected.'
			};
		case SqlConnectionKind.Sqlite:
		default:
			return {
				displayName: 'SQLite',
				status: SqlRuntimeStatus.Stable,
				description: 'File and in-memory databases for the stable MVP flow.'
			};
	}
}

function formatRuntimeStatus(status: SqlRuntimeStatus): string {
	switch (status) {
		case SqlRuntimeStatus.Stable:
			return 'Stable';
		case SqlRuntimeStatus.Preview:
			return 'Preview';
		case SqlRuntimeStatus.Planned:
			return 'Planned';
		case SqlRuntimeStatus.Disabled:
			return 'Disabled';
	}
}
