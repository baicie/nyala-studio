/*---------------------------------------------------------------------------------------------
 * Nyala Studio - modal data source editor.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlConnections.css';
import './media/driverCardBadge.css';
import './media/sqlConnectorBrand.css';
import './media/sqlConnectionEditor.css';

import { $, addDisposableListener, append, clearNode, Dimension, EventType } from '../../../../base/browser/dom.js';
import { SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { defaultSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ISqlConnectionService } from '../../../services/sql/common/sqlConnection.js';
import { ISqlDriverCatalogService } from '../../../services/sql/common/sqlDriverCatalog.js';
import { getSqlConnectorRuntimeDriverId } from '../../../services/sql/common/sqlConnectorRuntimeGuard.js';
import { SqlConnectionKind, SqlSslMode } from '../../../services/sql/common/sqlTypes.js';
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
import { setSqlConnectionFormTextControlsBusy } from '../common/sqlConnectionFormBusyState.js';
import { runSqlConnectionFormOperation } from '../common/sqlConnectionFormOperation.js';
import {
	filterSqlConnectorPresentations,
	getSqlConnectorPresentation,
	SQL_CONNECTOR_CATEGORIES,
	SqlConnectorCategory,
	SqlConnectorDelivery,
	SqlConnectorPresentation
} from '../common/sqlConnectorPresentationModel.js';
import { SqlConnectionEditorInput } from '../../../services/sql/common/sqlConnectionEditorInput.js';
import { openAndSaveMysqlConnection } from '../common/sqlConnectionSubmission.js';
import { SQL_CONNECTIONS_REFRESH_COMMAND_ID } from '../common/sqlConnections.js';
import { applySqlConnectionFormAccessibility } from './sqlConnectionFormAccessibility.js';
import { buildSqlDriverStatusBadge, buildSqlDriverStatusPlaceholder, SqlDriverStatusBadge } from './driverCardBadge.js';
import { MysqlPreviewValidationController } from './mysqlValidationView.js';

const SQL_CONNECTION_EDITOR_STATUS_ID = 'sql-connection-editor-status';

export class SqlConnectionEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.sqlConnection';

	private readonly inputDisposables = this._register(new DisposableStore());
	private readonly connectorRenderDisposables = this._register(new DisposableStore());
	private readonly categoryButtons = new Map<SqlConnectorCategory, HTMLButtonElement>();
	private readonly touchedFormInputs = new Set<HTMLInputElement>();
	private readonly connectorAvailability = new Map<SqlConnectionKind, SqlDriverStatusBadge>();
	private readonly mysqlValidationController: MysqlPreviewValidationController;

	private rootElement!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private clearSearchButton!: HTMLButtonElement;
	private connectorCountElement!: HTMLElement;
	private connectorListElement!: HTMLElement;
	private connectorHeaderIcon!: HTMLElement;
	private connectorHeaderTitle!: HTMLElement;
	private connectorHeaderDescription!: HTMLElement;
	private form!: HTMLFormElement;
	private nameInput!: HTMLInputElement;
	private sqliteFieldsElement!: HTMLElement;
	private sqliteFileFieldsElement!: HTMLElement;
	private databasePathInput!: HTMLInputElement;
	private browseDatabaseButton!: HTMLButtonElement;
	private sqliteFileModeButton!: HTMLButtonElement;
	private sqliteMemoryModeButton!: HTMLButtonElement;
	private networkFieldsElement!: HTMLElement;
	private hostInput!: HTMLInputElement;
	private portInput!: HTMLInputElement;
	private databaseInput!: HTMLInputElement;
	private usernameInput!: HTMLInputElement;
	private passwordInput!: HTMLInputElement;
	private sslModeSelect!: SelectBox;
	private readonly sslModes = [SqlSslMode.Disable, SqlSslMode.Prefer, SqlSslMode.Require];
	private currentSslIndex = 1;
	private readOnlyOptionElement!: HTMLElement;
	private createIfMissingOptionElement!: HTMLElement;
	private saveConnectionOptionElement!: HTMLElement;
	private autoConnectOptionElement!: HTMLElement;
	private readOnlyInput!: HTMLInputElement;
	private createIfMissingInput!: HTMLInputElement;
	private saveConnectionInput!: HTMLInputElement;
	private autoConnectInput!: HTMLInputElement;
	private advancedElement!: HTMLDetailsElement;
	private testButton!: HTMLButtonElement;
	private validateButton!: HTMLButtonElement;
	private connectButton!: HTMLButtonElement;
	private resetButton!: HTMLButtonElement;
	private refreshButton!: HTMLButtonElement;
	private cancelButton!: HTMLButtonElement;
	private driverPreviewElement!: HTMLElement;
	private messageElement!: HTMLElement;

	private category = SqlConnectorCategory.All;
	private currentFormKind = SqlConnectionKind.Sqlite;
	private currentFormConnectionId: string | undefined;
	private currentSqliteMode = SqliteConnectionMode.File;
	private isFormBusy = false;
	private connectorCatalogLoad: Promise<void> | undefined;
	private connectorCatalogUnavailable = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		@ISqlConnectionService private readonly sqlConnectionService: ISqlConnectionService,
		@ISqlDriverCatalogService private readonly sqlDriverCatalogService: ISqlDriverCatalogService
	) {
		super(SqlConnectionEditorPane.ID, group, telemetryService, themeService, storageService);
		this.mysqlValidationController = this._register(
			instantiationService.createInstance(MysqlPreviewValidationController)
		);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.rootElement = append(parent, $('.sql-connection-editor.sql-connectors-mode'));
		const shell = append(this.rootElement, $('.sql-connectors-settings'));
		this.createCategoryRail(shell);
		this.createConnectorCatalog(shell);
		this.createConnectionForm(shell);

		this._register(
			this.sqlDriverCatalogService.onChange(() => {
				this.connectorCatalogUnavailable = false;
				this.renderConnectorCatalog();
				this.refreshDriverPreview();
			})
		);

		this.ensureConnectorCatalogLoaded().catch(() => {
			this.showInfo('Connector availability could not be loaded. Refresh to retry.');
		});
	}

	override async setInput(
		input: SqlConnectionEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken
	): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested) {
			return;
		}

		this.inputDisposables.clear();
		this.touchedFormInputs.clear();
		this.category = SqlConnectorCategory.All;
		this.searchInput.value = '';

		const state =
			input.request.mode === 'saved'
				? createSqlConnectionFormStateFromSavedConnection(input.request.saved)
				: createDefaultSqlConnectionFormState(input.request.initialKind);
		this.applyFormState(state);
		this.renderConnectorCatalog();
		this.refreshDriverPreview();

		if (input.request.mode === 'saved' && input.request.saved.kind === SqlConnectionKind.MySql) {
			this.showInfo(`Enter the password for ${input.request.saved.name} to connect.`);
			this.passwordInput.focus();
		} else {
			this.showInfo('');
		}
	}

	override clearInput(): void {
		if (this.passwordInput) {
			this.passwordInput.value = '';
		}
		this.inputDisposables.clear();
		super.clearInput();
	}

	override focus(): void {
		super.focus();
		this.searchInput?.focus();
	}

	override layout(dimension: Dimension): void {
		this.rootElement?.classList.toggle('compact', dimension.width < 850);
	}

	private createCategoryRail(parent: HTMLElement): void {
		const rail = append(
			parent,
			$('.sql-connection-editor-categories', { role: 'navigation', 'aria-label': 'Connector types' })
		);
		append(rail, $('.sql-connection-editor-category-title', undefined, 'Type'));

		for (const item of SQL_CONNECTOR_CATEGORIES) {
			const button = append(
				rail,
				$(
					'button.sql-connection-editor-category',
					{
						type: 'button',
						title: item.description,
						'aria-pressed': String(item.id === this.category)
					},
					item.label
				)
			) as HTMLButtonElement;
			button.classList.toggle('selected', item.id === this.category);
			this.categoryButtons.set(item.id, button);
			this._register(
				addDisposableListener(button, EventType.CLICK, () => {
					this.category = item.id;
					this.refreshCategorySelection();
					this.renderConnectorCatalog();
				})
			);
		}
	}

	private createConnectorCatalog(parent: HTMLElement): void {
		const catalog = append(parent, $('.sql-connection-editor-catalog'));
		append(catalog, $('.sql-connection-editor-catalog-title', undefined, 'Database connectors'));
		const searchWrap = append(catalog, $('.sql-connection-editor-search-wrap'));
		append(searchWrap, $('.codicon.codicon-search.sql-connection-editor-search-icon', { 'aria-hidden': 'true' }));
		this.searchInput = append(
			searchWrap,
			$('input.sql-connection-editor-search', {
				type: 'search',
				placeholder: 'Search connectors',
				'aria-label': 'Search database connectors'
			})
		) as HTMLInputElement;
		this.clearSearchButton = append(
			searchWrap,
			$('button.sql-connection-editor-search-clear', {
				type: 'button',
				title: 'Clear search',
				'aria-label': 'Clear connector search'
			})
		) as HTMLButtonElement;
		append(this.clearSearchButton, $('.codicon.codicon-close', { 'aria-hidden': 'true' }));
		this.connectorCountElement = append(catalog, $('.sql-connection-editor-count'));
		this.connectorListElement = append(
			catalog,
			$('.sql-connection-editor-list', { role: 'listbox', 'aria-label': 'Database connectors' })
		);

		this._register(
			addDisposableListener(this.searchInput, EventType.INPUT, () => {
				this.renderConnectorCatalog();
			})
		);
		this._register(
			addDisposableListener(this.clearSearchButton, EventType.CLICK, () => {
				this.searchInput.value = '';
				this.renderConnectorCatalog();
				this.searchInput.focus();
			})
		);
	}

	private createConnectionForm(parent: HTMLElement): void {
		const settingsPane = append(parent, $('.sql-connector-settings-pane'));
		const header = append(settingsPane, $('.sql-connector-settings-header'));
		this.connectorHeaderIcon = append(header, $('.sql-connector-brand', { 'aria-hidden': 'true' }));
		const headerCopy = append(header, $('.sql-connector-settings-copy'));
		this.connectorHeaderTitle = append(headerCopy, $('h2.sql-connector-settings-title'));
		this.connectorHeaderDescription = append(headerCopy, $('.sql-connector-settings-description'));
		const headerActions = append(header, $('.sql-connections-form-header-actions'));
		this.resetButton = this.appendIconButton(headerActions, 'discard', 'Reset data source form');
		this.refreshButton = this.appendIconButton(headerActions, 'refresh', 'Refresh connector availability');

		this.form = append(
			settingsPane,
			$('form.sql-connections-form', {
				id: 'sql-connection-editor-form',
				'aria-label': 'Connection settings',
				'aria-busy': 'false'
			})
		) as HTMLFormElement;

		const generalSection = this.appendSettingsSection(this.form, 'General');
		const nameLabel = append(generalSection, $('label.sql-connections-field'));
		append(nameLabel, $('span.sql-connections-field-label', undefined, 'Name'));
		this.nameInput = append(
			nameLabel,
			$('input.sql-connections-input', { type: 'text', placeholder: 'Local SQLite' })
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
			$('input.sql-connections-input', { type: 'text', placeholder: '/absolute/path/to/database.db' })
		) as HTMLInputElement;
		this.browseDatabaseButton = this.appendIconButton(pathRow, 'folder-opened', 'Browse for SQLite database');

		this.networkFieldsElement = append(this.form, $('.sql-connections-driver-fields.network'));
		const serverSection = this.appendSettingsSection(this.networkFieldsElement, 'Server');
		const addressRow = append(serverSection, $('.sql-connections-network-address'));
		const hostLabel = append(addressRow, $('label.sql-connections-field.sql-connections-host-field'));
		append(hostLabel, $('span.sql-connections-field-label', undefined, 'Host'));
		this.hostInput = append(
			hostLabel,
			$('input.sql-connections-input', { type: 'text', placeholder: 'localhost' })
		) as HTMLInputElement;
		const portLabel = append(addressRow, $('label.sql-connections-field.sql-connections-port-field'));
		append(portLabel, $('span.sql-connections-field-label', undefined, 'Port'));
		this.portInput = append(
			portLabel,
			$('input.sql-connections-input', { type: 'number', min: '1', max: '65535', placeholder: '3306' })
		) as HTMLInputElement;
		const databaseLabel = append(serverSection, $('label.sql-connections-field'));
		append(databaseLabel, $('span.sql-connections-field-label', undefined, 'Database'));
		this.databaseInput = append(
			databaseLabel,
			$('input.sql-connections-input', { type: 'text', placeholder: 'mysql' })
		) as HTMLInputElement;

		const authenticationSection = this.appendSettingsSection(this.networkFieldsElement, 'Authentication');
		const usernameLabel = append(authenticationSection, $('label.sql-connections-field'));
		append(usernameLabel, $('span.sql-connections-field-label', undefined, 'Username'));
		this.usernameInput = append(
			usernameLabel,
			$('input.sql-connections-input', { type: 'text', placeholder: 'root', autocomplete: 'username' })
		) as HTMLInputElement;
		const passwordLabel = append(authenticationSection, $('label.sql-connections-field'));
		append(passwordLabel, $('span.sql-connections-field-label', undefined, 'Password (optional)'));
		this.passwordInput = append(
			passwordLabel,
			$('input.sql-connections-input', { type: 'password', placeholder: 'Not saved', autocomplete: 'current-password' })
		) as HTMLInputElement;

		const securitySection = this.appendSettingsSection(this.networkFieldsElement, 'Security');
		const sslLabel = append(securitySection, $('label.sql-connections-field'));
		append(sslLabel, $('span.sql-connections-field-label', undefined, 'SSL mode'));
		const sslHost = append(sslLabel, $('.sql-connections-selectbox.sql-connections-input'));
		this.sslModeSelect = new SelectBox(
			this.sslModes.map(mode => ({ text: mode })),
			this.currentSslIndex,
			this.contextViewService,
			defaultSelectBoxStyles,
			{ ariaLabel: localize('sqlConnectionEditorSslLabel', 'SSL mode'), useCustomDrawn: true }
		);
		this.sslModeSelect.render(sslHost);
		this._register(this.sslModeSelect);

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
		append(saveLabel, $('span', undefined, 'Save data source'));
		const autoLabel = (this.autoConnectOptionElement = append(options, $('label.sql-connections-checkbox')));
		this.autoConnectInput = append(autoLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
		append(autoLabel, $('span', undefined, 'Auto connect'));

		this.advancedElement = append(
			this.form,
			$('details.sql-connection-editor-advanced', { hidden: true })
		) as HTMLDetailsElement;
		append(this.advancedElement, $('summary', undefined, 'Advanced'));
		const advancedBody = append(this.advancedElement, $('.sql-connection-editor-advanced-body'));
		append(
			advancedBody,
			$(
				'p.sql-connection-editor-validation-note',
				undefined,
				'Preview validation creates and removes a temporary table on the target database.'
			)
		);
		this.validateButton = append(
			advancedBody,
			$('button.sql-connections-button', { type: 'button', title: 'Run MySQL Preview validation' }, 'Validate')
		) as HTMLButtonElement;

		const footer = append(this.form, $('.sql-connectors-footer'));
		this.driverPreviewElement = append(
			footer,
			$('.sql-connection-driver-preview', {
				id: SQL_CONNECTION_EDITOR_STATUS_ID,
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
		this.cancelButton = append(
			actions,
			$('button.sql-connections-button', { type: 'button' }, 'Cancel')
		) as HTMLButtonElement;
		this.testButton = append(
			actions,
			$('button.sql-connections-button', { type: 'button' }, 'Test')
		) as HTMLButtonElement;
		this.connectButton = append(
			actions,
			$('button.sql-connections-button.primary', { type: 'submit' }, 'Connect')
		) as HTMLButtonElement;

		this.registerFormListeners();
	}

	private registerFormListeners(): void {
		this._register(
			addDisposableListener(this.form, EventType.SUBMIT, event => {
				event.preventDefault();
				this.addConnectionFromForm().catch(error => this.showError(error));
			})
		);
		this._register(addDisposableListener(this.cancelButton, EventType.CLICK, () => this.closeEditor()));
		this._register(
			addDisposableListener(this.resetButton, EventType.CLICK, () => {
				this.touchedFormInputs.clear();
				this.applyFormState(createDefaultSqlConnectionFormState(this.currentFormKind));
				this.refreshDriverPreview();
			})
		);
		this._register(
			addDisposableListener(this.refreshButton, EventType.CLICK, () => {
				this.refreshConnectorCatalog().catch(error => this.showError(error));
			})
		);
		this._register(
			addDisposableListener(this.testButton, EventType.CLICK, () => {
				this.testConnectionFromForm().catch(error => this.showError(error));
			})
		);
		this._register(
			addDisposableListener(this.validateButton, EventType.CLICK, () => {
				this.validateMysqlFromForm().catch(error => this.showError(error));
			})
		);
		this._register(
			addDisposableListener(this.browseDatabaseButton, EventType.CLICK, () => {
				this.pickSqliteDatabaseFile().catch(error => this.showError(error));
			})
		);
		this._register(
			addDisposableListener(this.sqliteFileModeButton, EventType.CLICK, () => {
				this.applyFormState(setSqliteConnectionMode(this.getFormState(), SqliteConnectionMode.File));
				this.refreshDriverPreview();
			})
		);
		this._register(
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
			this._register(addDisposableListener(input, EventType.INPUT, () => this.refreshDriverPreview()));
			this._register(
				addDisposableListener(input, EventType.BLUR, () => {
					this.touchedFormInputs.add(input);
					this.refreshDriverPreview();
				})
			);
		}
		for (const input of [this.readOnlyInput, this.createIfMissingInput, this.autoConnectInput]) {
			this._register(addDisposableListener(input, EventType.CHANGE, () => this.refreshDriverPreview()));
		}
		this._register(
			this.sslModeSelect.onDidSelect(({ index }) => {
				this.currentSslIndex = index;
				this.refreshDriverPreview();
			})
		);
		this._register(
			addDisposableListener(this.saveConnectionInput, EventType.CHANGE, () => {
				if (!this.saveConnectionInput.checked) {
					this.autoConnectInput.checked = false;
				}
				this.refreshDriverPreview();
			})
		);
	}

	private renderConnectorCatalog(): void {
		if (!this.connectorListElement) {
			return;
		}

		this.connectorRenderDisposables.clear();
		clearNode(this.connectorListElement);
		const presentations = filterSqlConnectorPresentations({
			category: this.category,
			text: this.searchInput.value
		});
		this.connectorCountElement.textContent = `${presentations.length} connector${presentations.length === 1 ? '' : 's'}`;
		this.clearSearchButton.classList.toggle('hidden', this.searchInput.value.length === 0);

		if (presentations.length === 0) {
			append(
				this.connectorListElement,
				$('.sql-connection-editor-empty', undefined, 'No connectors match this search.')
			);
			return;
		}

		for (const presentation of presentations) {
			const badge = this.getConnectorBadge(presentation);
			this.connectorAvailability.set(presentation.kind, badge);
			const selected = presentation.kind === this.currentFormKind;
			const button = append(
				this.connectorListElement,
				$(`button.sql-connector-option.sql-connector-option--${presentation.kind}`, {
					type: 'button',
					'aria-pressed': String(selected),
					'aria-disabled': String(!badge.runnable),
					title: badge.runnable ? presentation.description : badge.title
				})
			) as HTMLButtonElement;
			button.classList.toggle('selected', selected);
			button.classList.toggle('disabled', !badge.runnable);
			append(
				button,
				$(`span.sql-connector-brand.sql-connector-brand--${presentation.brandIcon}`, { 'aria-hidden': 'true' })
			);
			const copy = append(button, $('.sql-connector-option-copy'));
			const title = append(copy, $('.sql-connector-option-title'));
			append(title, $('span.sql-connector-option-name', undefined, presentation.label));
			const status = append(title, $('span'));
			status.className = badge.className;
			status.textContent = badge.text;
			status.setAttribute('role', 'status');
			status.setAttribute('aria-label', badge.ariaLabel);
			status.title = badge.title;
			append(title, $('span.sql-connector-delivery-badge', undefined, deliveryLabel(presentation.delivery)));
			append(
				copy,
				$('.sql-connector-option-description', undefined, badge.runnable ? presentation.description : badge.title)
			);

			this.connectorRenderDisposables.add(
				addDisposableListener(button, EventType.CLICK, () => {
					if (!badge.runnable) {
						this.showInfo(badge.title);
						return;
					}
					this.selectConnector(presentation.kind);
				})
			);
		}
	}

	private refreshCategorySelection(): void {
		for (const [id, button] of this.categoryButtons) {
			const selected = id === this.category;
			button.classList.toggle('selected', selected);
			button.setAttribute('aria-pressed', String(selected));
		}
	}

	private getConnectorBadge(presentation: SqlConnectorPresentation): SqlDriverStatusBadge {
		try {
			return buildSqlDriverStatusBadge(this.sqlDriverCatalogService, getSqlConnectorRuntimeDriverId(presentation.kind));
		} catch {
			return buildSqlDriverStatusPlaceholder(presentation.label, this.connectorCatalogUnavailable);
		}
	}

	private getFormState(): SqlConnectionFormState {
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
			sslMode: this.sslModes[this.currentSslIndex] ?? SqlSslMode.Prefer,
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
		this.nameInput.value = state.name ?? '';
		this.databasePathInput.value = state.databasePath ?? '';
		this.hostInput.value = state.host ?? '';
		this.portInput.value = state.port === undefined ? '' : String(state.port);
		this.databaseInput.value = state.database ?? '';
		this.usernameInput.value = state.username ?? '';
		this.passwordInput.value = state.password ?? '';
		const sslIndex = this.sslModes.indexOf(state.sslMode ?? SqlSslMode.Prefer);
		if (sslIndex >= 0) {
			this.currentSslIndex = sslIndex;
			this.sslModeSelect.select(sslIndex);
		}
		this.readOnlyInput.checked = state.readOnly;
		this.createIfMissingInput.checked = state.createIfMissing;
		this.saveConnectionInput.checked = state.saveConnection;
		this.autoConnectInput.checked = state.autoConnect;
		this.refreshConnectorHeader();
	}

	private selectConnector(kind: SqlConnectionKind): void {
		if (this.isFormBusy || kind === this.currentFormKind) {
			return;
		}

		this.touchedFormInputs.clear();
		this.applyFormState(createDefaultSqlConnectionFormState(kind));
		this.renderConnectorCatalog();
		this.refreshDriverPreview();
		this.nameInput.focus();
	}

	private refreshConnectorHeader(): void {
		const presentation = getSqlConnectorPresentation(this.currentFormKind);
		this.connectorHeaderIcon.className = `sql-connector-brand sql-connector-brand--${presentation.brandIcon}`;
		this.connectorHeaderTitle.textContent = presentation.label;
		this.connectorHeaderDescription.textContent = presentation.description;
	}

	private refreshDriverPreview(): void {
		if (!this.form) {
			return;
		}

		const formState = this.getFormState();
		const preview = createSqlConnectionFormPreview(formState);
		const presentation = getSqlConnectorPresentation(preview.kind);
		const availability = this.connectorAvailability.get(preview.kind) ?? this.getConnectorBadge(presentation);
		const isSqlite = preview.kind === SqlConnectionKind.Sqlite;
		const isMysql = preview.kind === SqlConnectionKind.MySql;
		const isPostgres = preview.kind === SqlConnectionKind.PostgreSql;
		const isMemory = isSqlite && getSqliteConnectionMode(formState) === SqliteConnectionMode.Memory;

		this.refreshConnectorHeader();
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
		this.advancedElement.hidden = !isMysql;

		if (!isSqlite || isMemory) {
			this.readOnlyInput.checked = false;
		}
		if (!isSqlite || isMemory) {
			this.createIfMissingInput.checked = false;
			this.autoConnectInput.checked = false;
		}
		if (isMemory || isPostgres) {
			this.saveConnectionInput.checked = false;
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
		this.cancelButton.disabled = this.isFormBusy;
		this.testButton.disabled = this.isFormBusy || !availability.runnable || !preview.canConnect || isPostgres;
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
			describedBy: SQL_CONNECTION_EDITOR_STATUS_ID
		});

		clearNode(this.driverPreviewElement);
		const title = append(this.driverPreviewElement, $('.sql-connection-driver-preview-title'));
		const message = append(this.driverPreviewElement, $('.sql-connection-driver-preview-message'));
		title.textContent = availability.runnable
			? preview.canConnect
				? preview.summary
				: 'Required settings'
			: availability.text;
		message.textContent = availability.runnable ? preview.message : availability.title;
		title.title = title.textContent;
		message.title = message.textContent;
		this.driverPreviewElement.classList.toggle('error', hasVisibleError);
		this.driverPreviewElement.classList.toggle('mysql-warning', isMysql);
		this.driverPreviewElement.classList.toggle('planned', isPostgres);
	}

	private async addConnectionFromForm(): Promise<void> {
		await this.runFormOperation(async formState => {
			const preview = createSqlConnectionFormPreview(formState);
			if (!preview.canConnect || preview.kind === SqlConnectionKind.PostgreSql) {
				this.showInfo(preview.message);
				return;
			}

			this.showInfo(
				preview.kind === SqlConnectionKind.MySql ? 'Opening MySQL connection...' : 'Opening SQLite connection...'
			);
			const rawInput = createSqlConnectionInputFromFormState(formState);
			const safeInput = createSafeSqlConnectionInputFromFormState(formState);
			const input = preview.kind === SqlConnectionKind.MySql ? rawInput : safeInput;
			let connectionId: string;
			let connectionName: string;

			if (preview.canSave && preview.kind === SqlConnectionKind.MySql) {
				const connection = await openAndSaveMysqlConnection(this.sqlConnectionService, rawInput, safeInput);
				connectionId = connection.id;
				connectionName = connection.name;
			} else if (preview.canSave) {
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
			await this.commandService.executeCommand(SQL_CONNECTIONS_REFRESH_COMMAND_ID, {
				revealConnectionId: connectionId
			});
			await this.closeEditor();
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
					this.renderConnectorCatalog();
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

	private async closeEditor(): Promise<void> {
		const input = this.input;
		if (input) {
			await this.group.closeEditor(input);
		}
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
				{ name: 'SQLite databases', extensions: ['db', 'sqlite', 'sqlite3'] },
				{ name: 'All files', extensions: ['*'] }
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
		this.renderConnectorCatalog();
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
				this.renderConnectorCatalog();
				this.refreshDriverPreview();
			});
		this.connectorCatalogLoad = load;
		return load;
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
			$('button.sql-connections-icon-button', { type: 'button', title: label, 'aria-label': label })
		) as HTMLButtonElement;
		append(button, $(`span.codicon.codicon-${icon}`, { 'aria-hidden': 'true' }));
		return button;
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

function deliveryLabel(delivery: SqlConnectorDelivery): string {
	return delivery === SqlConnectorDelivery.Bundled ? 'Bundled' : 'Planned';
}
