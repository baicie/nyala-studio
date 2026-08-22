/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor pane.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlEditor.css';

import { $, addDisposableListener, append, clearNode, Dimension, EventType } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { isTauri } from '../../../../sidex-bridge.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ISqlConnectionChangeService, ISqlConnectionService } from '../../../services/sql/common/sqlConnection.js';
import { ISqlQueryService } from '../../../services/sql/common/sqlQuery.js';
import { SqlConnection, SqlConnectionKind } from '../../../services/sql/common/sqlTypes.js';
import { SqlEditorInput } from '../common/sqlEditorInput.js';
import { SQL_EDITOR_PANE_ID } from '../common/sqlEditor.js';
import {
	canLoadSqlEditorConnections,
	findSqlStatementAtOffset,
	getSqlEditorStatusLabel,
	getSqlEditorToolbarState,
	SqlEditorConnectionRefreshCoordinator,
	SqlEditorExecutionSource
} from '../common/sqlEditorModel.js';
import { SqlEditorExecutionController, SqlEditorRunningState } from '../common/sqlEditorExecutionController.js';
import { ISqlEditorEventService } from '../common/sqlEditorEvents.js';
import { ISqlEditorDraftService } from '../common/sqlEditorDraftService.js';
import { ISqlProductPreferencesService } from '../../sqlProduct/common/sqlProductPreferencesService.js';
import { shouldAutoSaveSqlEditorDraft } from '../../sqlProduct/common/sqlProductIntegrationModel.js';
import { formatSql } from '../../sqlAdvanced/common/sqlAdvancedFormatter.js';
import { createExplainSql } from '../../sqlAdvanced/common/sqlAdvancedExplain.js';
import { getDialectForConnectionKind } from '../../../services/sql/common/sqlDialect.js';
import {
	applySqlAgentArtifact,
	SqlAgentArtifact,
	SqlAgentArtifactApplyResult,
	SqlAgentArtifactTarget
} from '../../../services/sql/common/sqlAgentArtifacts.js';

export interface SqlEditorAssistantContext {
	readonly editorId?: string;
	readonly connectionId?: string;
	readonly connectionKind?: SqlConnectionKind;
	readonly connectionName?: string;
	readonly sql: string;
	readonly selectedSql?: string;
	readonly versionId?: number;
}

export class SqlEditorPane extends EditorPane {
	static readonly ID = SQL_EDITOR_PANE_ID;

	private readonly modelDisposables = this._register(new DisposableStore());

	private container!: HTMLElement;
	private toolbar!: HTMLElement;
	private connectionSelect!: HTMLSelectElement;
	private runStatementButton!: HTMLButtonElement;
	private runSelectionButton!: HTMLButtonElement;
	private runAllButton!: HTMLButtonElement;
	private cancelButton!: HTMLButtonElement;
	private formatButton!: HTMLButtonElement;
	private statusElement!: HTMLElement;
	private editorContainer!: HTMLElement;

	private editor: ICodeEditor | undefined;
	private currentInput: SqlEditorInput | undefined;
	private currentConnections: SqlConnection[] = [];
	private readonly connectionRefreshCoordinator = new SqlEditorConnectionRefreshCoordinator<SqlConnection>();
	private running = false;
	private dirty = false;
	private readonly executionController: SqlEditorExecutionController;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@INotificationService private readonly notificationService: INotificationService,
		@ISqlConnectionService private readonly sqlConnectionService: ISqlConnectionService,
		@ISqlQueryService private readonly sqlQueryService: ISqlQueryService,
		@ISqlEditorEventService private readonly sqlEditorEventService: ISqlEditorEventService,
		@ISqlEditorDraftService private readonly draftService: ISqlEditorDraftService,
		@ISqlProductPreferencesService private readonly preferencesService: ISqlProductPreferencesService,
		@ISqlConnectionChangeService connectionChangeService: ISqlConnectionChangeService
	) {
		super(SqlEditorPane.ID, group, telemetryService, themeService, storageService);
		this.executionController = new SqlEditorExecutionController(sqlQueryService);
		this._register(
			connectionChangeService.onDidChangeConnections(() => {
				if (!this.currentInput || !this.connectionSelect) {
					return;
				}
				this.refreshConnections(this.currentInput, true).catch(error => this.showError(error));
			})
		);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.sql-editor-pane'));
		this.toolbar = append(
			this.container,
			$('.sql-editor-toolbar', {
				role: 'toolbar',
				'aria-label': 'SQL execution'
			})
		);

		const connectionGroup = append(this.toolbar, $('.sql-editor-toolbar-group.connection'));
		append(connectionGroup, $('.codicon.codicon-database.sql-editor-connection-icon', { 'aria-hidden': 'true' }));
		this.connectionSelect = append(
			connectionGroup,
			$('select.sql-editor-connection-select', {
				'aria-label': 'SQL connection'
			})
		) as HTMLSelectElement;

		const executionGroup = append(this.toolbar, $('.sql-editor-toolbar-group.execution'));
		this.runStatementButton = this.appendToolbarButton(
			executionGroup,
			Codicon.run,
			'Run',
			'Execute current statement (Ctrl/Cmd+Enter)',
			true
		);
		this.runSelectionButton = this.appendToolbarButton(
			executionGroup,
			Codicon.selection,
			'Selection',
			'Execute selection (Shift+Enter)'
		);
		this.runAllButton = this.appendToolbarButton(executionGroup, Codicon.runAll, 'All', 'Execute all SQL');
		this.cancelButton = this.appendToolbarButton(executionGroup, Codicon.stopCircle, 'Stop', 'Cancel running query');
		this.cancelButton.classList.add('stop');

		const utilityGroup = append(this.toolbar, $('.sql-editor-toolbar-group.utility'));
		this.formatButton = this.appendToolbarButton(utilityGroup, Codicon.wand, 'Format', 'Format SQL');

		this.statusElement = append(this.toolbar, $('span.sql-editor-status', { role: 'status', 'aria-live': 'polite' }));
		this.editorContainer = append(this.container, $('.sql-editor-container'));

		this.editor = this._register(
			this.instantiationService.createInstance(
				CodeEditorWidget,
				this.editorContainer,
				{
					automaticLayout: false,
					minimap: { enabled: false },
					scrollBeyondLastLine: false,
					fixedOverflowWidgets: true
				},
				{}
			)
		);

		this._register(
			addDisposableListener(this.runStatementButton, EventType.CLICK, () => {
				this.executeQuery(SqlEditorExecutionSource.Statement).catch(error => this.showError(error));
			})
		);

		this._register(
			addDisposableListener(this.runSelectionButton, EventType.CLICK, () => {
				this.executeQuery(SqlEditorExecutionSource.Selection).catch(error => this.showError(error));
			})
		);

		this._register(
			addDisposableListener(this.runAllButton, EventType.CLICK, () => {
				this.executeQuery(SqlEditorExecutionSource.All).catch(error => this.showError(error));
			})
		);

		this._register(
			addDisposableListener(this.cancelButton, EventType.CLICK, () => {
				this.cancelQuery().catch(error => this.showError(error));
			})
		);

		this._register(
			addDisposableListener(this.formatButton, EventType.CLICK, () => {
				this.formatQuery();
			})
		);

		this._register(
			addDisposableListener(this.connectionSelect, EventType.CHANGE, () => {
				this.dirty = true;
				this.saveCurrentDraft();
				this.updateReadyStatus();
				this.updateToolbarState();
			})
		);

		this._register(this.editor.onDidChangeCursorSelection(() => this.updateToolbarState()));
		this.updateToolbarState();

		this._onDidChangeControl.fire();
	}

	override async setInput(
		input: SqlEditorInput,
		options: unknown,
		context: IEditorOpenContext,
		token: CancellationToken
	): Promise<void> {
		await super.setInput(input, options as never, context, token);

		this.currentInput = input;
		this.dirty = false;

		await this.refreshConnections(input);

		if (token.isCancellationRequested) {
			return;
		}

		const existingModel = this.modelService.getModel(input.resource);
		const model =
			existingModel ??
			this.modelService.createModel(input.initialSql, this.languageService.createById('sql'), input.resource);

		this.modelDisposables.clear();
		this.modelDisposables.add(
			model.onDidChangeContent(() => {
				this.dirty = true;
				this.saveCurrentDraft();
				this.updateReadyStatus();
				this.updateToolbarState();
			})
		);

		this.editor?.setModel(model);
		this.editor?.focus();

		this.updateReadyStatus();
		this.updateToolbarState();
	}

	override clearInput(): void {
		this.connectionRefreshCoordinator.invalidate();
		this.currentConnections = [];
		if (this.connectionSelect) {
			this.connectionSelect.value = '';
		}
		this.modelDisposables.clear();
		this.editor?.setModel(null);
		this.currentInput = undefined;
		this.dirty = false;
		this.updateToolbarState();
		super.clearInput();
	}

	override dispose(): void {
		this.connectionRefreshCoordinator.invalidate();
		this.currentInput = undefined;
		super.dispose();
	}

	override layout(dimension: Dimension): void {
		if (!this.container || !this.editorContainer) {
			return;
		}

		const toolbarHeight = this.toolbar?.offsetHeight ?? 34;
		const editorHeight = Math.max(0, dimension.height - toolbarHeight);

		this.editorContainer.style.height = `${editorHeight}px`;
		this.editor?.layout({
			width: dimension.width,
			height: editorHeight
		});
	}

	override focus(): void {
		super.focus();
		this.editor?.focus();
	}

	override getControl(): ICodeEditor | undefined {
		return this.editor;
	}

	getAssistantContext(): SqlEditorAssistantContext {
		const connection = this.getSelectedConnection();
		const selectedSql = this.getSelectedSql();
		const model = this.editor?.getModel();

		return {
			editorId: this.currentInput?.id,
			connectionId: connection?.id,
			connectionKind: connection?.kind,
			connectionName: connection?.name,
			sql: this.getAllSql(),
			selectedSql: selectedSql.trim() ? selectedSql : undefined,
			versionId: model?.getVersionId()
		};
	}

	getAgentArtifactTarget(): SqlAgentArtifactTarget | undefined {
		const model = this.editor?.getModel();
		const editorId = this.currentInput?.id;
		if (!model || !editorId) {
			return undefined;
		}
		return {
			editorId,
			versionId: model.getVersionId(),
			sql: model.getValue()
		};
	}

	applyAgentArtifact(artifact: SqlAgentArtifact): SqlAgentArtifactApplyResult {
		const model = this.editor?.getModel();
		const target = this.getAgentArtifactTarget();
		if (!model || !target) {
			return { applied: false, reason: 'editor' };
		}
		const result = applySqlAgentArtifact(artifact, target);
		if (result.applied) {
			model.setValue(result.sql);
			this.dirty = true;
			this.saveCurrentDraft();
			this.updateReadyStatus();
			this.updateToolbarState();
		}
		return result;
	}

	async executeQuery(sourceOrSelectionOnly: SqlEditorExecutionSource | boolean): Promise<void> {
		const source =
			typeof sourceOrSelectionOnly === 'boolean'
				? sourceOrSelectionOnly
					? SqlEditorExecutionSource.Selection
					: SqlEditorExecutionSource.All
				: sourceOrSelectionOnly;

		const input = this.currentInput;

		try {
			if (!input) {
				throw new Error('No SQL editor input is active.');
			}

			if (this.running) {
				throw new Error('A SQL query is already running in this editor.');
			}

			const connection = this.getSelectedConnection();
			const editorVersionId = this.editor?.getModel()?.getVersionId();
			const executionPromise = this.executionController.execute({
				editorId: input.id,
				editorVersionId,
				connectionId: connection?.id,
				fullSql: this.getAllSql(),
				selectedSql: this.getSelectedSql(),
				cursorOffset: this.getCursorOffset(),
				source,
				canCancel: connection?.kind === SqlConnectionKind.Sqlite
			});

			const runningState = this.executionController.state;
			if (
				runningState.state !== SqlEditorRunningState.Running ||
				!runningState.connectionId ||
				!runningState.sql ||
				runningState.source === undefined ||
				runningState.startedAt === undefined
			) {
				await executionPromise;
				throw new Error('SQL execution did not enter the running state.');
			}

			this.running = true;
			this.status(this.getRunningStatusLabel(source));
			this.updateToolbarState();
			this.sqlEditorEventService.fireQueryStarted({
				editorId: runningState.editorId,
				editorVersionId: runningState.editorVersionId,
				executionId: runningState.executionId,
				connectionId: runningState.connectionId,
				sql: runningState.sql,
				source: runningState.source,
				statementCount: runningState.statementCount,
				startedAt: runningState.startedAt
			});

			const execution = await executionPromise;

			if (execution.completed) {
				this.sqlEditorEventService.fireQueryCompleted(execution.completed);

				const result = execution.completed.result;
				const message = `Query completed: ${result.rowCount} row(s) in ${result.elapsedMs}ms.`;
				this.dirty = false;
				this.saveCurrentDraft();
				this.status(message);
				this.notificationService.info(message);
			} else if (execution.failed) {
				this.sqlEditorEventService.fireQueryFailed(execution.failed);
				this.showError(execution.failed.error);
			}
		} catch (error) {
			const normalizedError = error instanceof Error ? error : new Error(String(error));
			this.showError(normalizedError);
		} finally {
			this.running = this.executionController.state.state === SqlEditorRunningState.Running;
			this.updateToolbarState();
		}
	}

	async cancelQuery(): Promise<void> {
		if (!this.running) {
			return;
		}

		this.cancelButton.disabled = true;
		this.status('Cancelling query...');

		try {
			const cancelled = await this.executionController.cancel();

			if (!cancelled) {
				this.status('Query cancellation is not available for this connection.');
				return;
			}

			this.sqlEditorEventService.fireQueryCancelled(cancelled);
			this.running = this.executionController.state.state === SqlEditorRunningState.Running;
			this.status('Query cancelled.');
			this.notificationService.info('Query cancelled.');
		} catch (error) {
			this.showError(error);
		} finally {
			this.updateToolbarState();
		}
	}

	formatQuery(): void {
		const model = this.editor?.getModel();

		if (!model) {
			return;
		}

		const connection = this.getSelectedConnection();
		const formatted = formatSql(model.getValue(), {
			dialect: connection ? getDialectForConnectionKind(connection.kind) : undefined
		});

		if (formatted !== model.getValue()) {
			model.setValue(formatted);
			this.dirty = true;
			this.saveCurrentDraft();
		}

		this.status('SQL formatted.');
		this.notificationService.info('SQL formatted.');
	}

	async explainPlan(): Promise<void> {
		const input = this.currentInput;
		const connection = this.getSelectedConnection();
		const startedAt = Date.now();
		let explainSql: string | undefined;
		let editorVersionId: number | undefined;

		try {
			if (!input) {
				throw new Error('No SQL editor input is active.');
			}

			if (!connection) {
				throw new Error('Select a SQL connection before explaining SQL.');
			}

			editorVersionId = this.editor?.getModel()?.getVersionId();
			const sql = this.getCurrentStatementSql();

			explainSql = createExplainSql({
				dialect: getDialectForConnectionKind(connection.kind),
				sql
			});

			this.status('Running explain plan...');
			this.setRunning(true);

			this.sqlEditorEventService.fireQueryStarted({
				editorId: input.id,
				editorVersionId,
				connectionId: connection.id,
				sql: explainSql,
				source: SqlEditorExecutionSource.Statement,
				statementCount: 1,
				startedAt
			});

			const result = await this.sqlQueryService.executeQuery({
				connectionId: connection.id,
				sql: explainSql
			});

			const completedAt = Date.now();

			this.sqlEditorEventService.fireQueryCompleted({
				editorId: input.id,
				editorVersionId,
				connectionId: connection.id,
				sql: explainSql,
				source: SqlEditorExecutionSource.Statement,
				statementCount: 1,
				startedAt,
				completedAt,
				result
			});

			this.status(`Explain completed: ${result.rowCount} row(s).`);
			this.notificationService.info(`Explain completed: ${result.rowCount} row(s).`);
		} catch (error) {
			const completedAt = Date.now();
			const normalizedError = error instanceof Error ? error : new Error(String(error));

			if (input && connection && explainSql) {
				this.sqlEditorEventService.fireQueryFailed({
					editorId: input.id,
					editorVersionId,
					connectionId: connection.id,
					sql: explainSql,
					source: SqlEditorExecutionSource.Statement,
					statementCount: 1,
					startedAt,
					completedAt,
					error: normalizedError
				});
			}

			this.showError(normalizedError);
		} finally {
			this.setRunning(false);
		}
	}

	private async refreshConnections(input: SqlEditorInput, preserveCurrentSelection = false): Promise<void> {
		const result = await this.connectionRefreshCoordinator.load(
			() =>
				canLoadSqlEditorConnections(isTauri()) ? this.sqlConnectionService.listConnections() : Promise.resolve([]),
			{
				inputConnectionId: input.connectionId,
				preserveCurrentSelection,
				getCurrentSelection: () => this.connectionSelect?.value
			}
		);
		if (!result) {
			return;
		}

		this.currentConnections = result.connections;

		clearNode(this.connectionSelect);

		if ('error' in result) {
			const option = document.createElement('option');
			option.value = '';
			option.textContent = 'No connection';
			this.connectionSelect.appendChild(option);
			this.connectionSelect.disabled = true;
			this.showError(result.error);
			this.updateToolbarState();
			return;
		}

		if (this.currentConnections.length === 0) {
			const option = document.createElement('option');
			option.value = '';
			option.textContent = 'No connection';
			this.connectionSelect.appendChild(option);
			this.connectionSelect.disabled = true;
			this.updateReadyStatus();
			this.updateToolbarState();
			return;
		}

		this.connectionSelect.disabled = false;

		for (const connection of this.currentConnections) {
			const option = document.createElement('option');
			option.value = connection.id;
			option.textContent = connection.name;
			this.connectionSelect.appendChild(option);
		}

		this.connectionSelect.value = result.selectedConnectionId ?? this.currentConnections[0].id;
		this.updateReadyStatus();
		this.updateToolbarState();
	}

	private getSelectedConnectionId(): string | undefined {
		const value = this.connectionSelect?.value?.trim();
		return value || undefined;
	}

	private getSelectedConnectionName(): string | undefined {
		const connectionId = this.getSelectedConnectionId();
		return this.currentConnections.find(connection => connection.id === connectionId)?.name;
	}

	private getSelectedConnection(): SqlConnection | undefined {
		const connectionId = this.getSelectedConnectionId();
		return this.currentConnections.find(connection => connection.id === connectionId);
	}

	private getAllSql(): string {
		return this.editor?.getModel()?.getValue() ?? '';
	}

	private getSelectedSql(): string {
		const editor = this.editor;
		const model = editor?.getModel();
		const selection = editor?.getSelection();

		if (!model || !selection || selection.isEmpty()) {
			return '';
		}

		return model.getValueInRange(selection);
	}

	private getCursorOffset(): number {
		const editor = this.editor;
		const model = editor?.getModel();
		const position = editor?.getPosition();

		return model && position ? model.getOffsetAt(position) : 0;
	}

	private getCurrentStatementSql(): string {
		const editor = this.editor;
		const model = editor?.getModel();
		const position = editor?.getPosition();

		if (!model || !position) {
			return this.getAllSql();
		}

		const offset = model.getOffsetAt(position);
		const statement = findSqlStatementAtOffset(model.getValue(), offset);

		return statement.sql;
	}

	private saveCurrentDraft(): void {
		if (!shouldAutoSaveSqlEditorDraft(this.preferencesService.preferences)) {
			return;
		}

		const input = this.currentInput;
		const sql = this.getAllSql();

		if (!input || !sql.trim()) {
			return;
		}

		this.draftService.saveDraft({
			id: input.id,
			connectionId: this.getSelectedConnectionId() ?? input.connectionId,
			connectionName: this.getSelectedConnectionName() ?? input.connectionName,
			sql,
			updatedAt: Date.now()
		});
	}

	private updateReadyStatus(): void {
		this.status(
			getSqlEditorStatusLabel({
				connectionId: this.getSelectedConnectionId(),
				connectionName: this.getSelectedConnectionName(),
				readOnly: this.getSelectedConnection()?.readOnly,
				dirty: this.dirty,
				running: this.running
			})
		);
	}

	private setRunning(running: boolean): void {
		this.running = running;
		this.updateToolbarState();
	}

	private updateToolbarState(): void {
		if (
			!this.runStatementButton ||
			!this.runSelectionButton ||
			!this.runAllButton ||
			!this.cancelButton ||
			!this.formatButton ||
			!this.connectionSelect
		) {
			return;
		}

		const controllerState = this.executionController.state;
		const state = getSqlEditorToolbarState({
			hasConnection: Boolean(this.getSelectedConnectionId()),
			hasConnections: this.currentConnections.length > 0,
			hasSelection: Boolean(this.getSelectedSql().trim()),
			running: this.running,
			canCancel: controllerState.state === SqlEditorRunningState.Running && controllerState.canCancel
		});

		this.runStatementButton.disabled = !state.canExecuteStatement;
		this.runSelectionButton.disabled = !state.canExecuteSelection;
		this.runAllButton.disabled = !state.canExecuteAll;
		this.cancelButton.disabled = !state.canCancel;
		this.formatButton.disabled = !state.canFormat || !this.currentInput;
		this.connectionSelect.disabled = !state.canChangeConnection;
		this.cancelButton.title =
			this.running && !state.canCancel
				? 'Cancellation is not supported for this running query'
				: 'Cancel running query';
		this.container?.setAttribute('aria-busy', String(this.running));
	}

	private appendToolbarButton(
		parent: HTMLElement,
		icon: ThemeIcon,
		label: string,
		title: string,
		primary = false
	): HTMLButtonElement {
		const button = append(
			parent,
			$(primary ? 'button.sql-editor-button.primary' : 'button.sql-editor-button', {
				type: 'button',
				title,
				'aria-label': title
			})
		) as HTMLButtonElement;
		const iconElement = append(button, $('span.sql-editor-button-icon'));
		iconElement.classList.add(...ThemeIcon.asClassNameArray(icon));
		append(button, $('span.sql-editor-button-label', undefined, label));

		return button;
	}

	private getRunningStatusLabel(source: SqlEditorExecutionSource): string {
		switch (source) {
			case SqlEditorExecutionSource.All:
				return 'Running all SQL...';
			case SqlEditorExecutionSource.Selection:
				return 'Running selection...';
			case SqlEditorExecutionSource.Statement:
				return 'Running current statement...';
		}
	}

	private status(message: string): void {
		if (this.statusElement) {
			this.statusElement.textContent = message;
			this.statusElement.title = message;
		}
	}

	private showError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.status(`Error: ${message}`);
		this.notificationService.error(message);
	}
}
