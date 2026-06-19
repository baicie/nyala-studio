/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor pane.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlEditor.css';

import { $, addDisposableListener, append, clearNode, Dimension, EventType } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
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
import { ISqlConnectionService } from '../../../services/sql/common/sqlConnection.js';
import { ISqlQueryService } from '../../../services/sql/common/sqlQuery.js';
import { SqlConnection } from '../../../services/sql/common/sqlTypes.js';
import { SqlEditorInput } from '../common/sqlEditorInput.js';
import { SQL_EDITOR_PANE_ID } from '../common/sqlEditor.js';
import {
	createExecutePayload,
	createFormatterPlaceholderResult,
	findSqlStatementAtOffset,
	getSqlEditorStatusLabel,
	SqlEditorExecutionSource,
	SqlEditorExecutePayload
} from '../common/sqlEditorModel.js';
import { ISqlEditorEventService } from '../common/sqlEditorEvents.js';
import { ISqlEditorDraftService } from '../common/sqlEditorDraftService.js';

export class SqlEditorPane extends EditorPane {
	static readonly ID = SQL_EDITOR_PANE_ID;

	private readonly modelDisposables = this._register(new DisposableStore());

	private container!: HTMLElement;
	private toolbar!: HTMLElement;
	private connectionSelect!: HTMLSelectElement;
	private runButton!: HTMLButtonElement;
	private runSelectionButton!: HTMLButtonElement;
	private runStatementButton!: HTMLButtonElement;
	private formatButton!: HTMLButtonElement;
	private statusElement!: HTMLElement;
	private editorContainer!: HTMLElement;

	private editor: ICodeEditor | undefined;
	private currentInput: SqlEditorInput | undefined;
	private currentConnections: SqlConnection[] = [];
	private running = false;
	private dirty = false;

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
		@ISqlEditorDraftService private readonly draftService: ISqlEditorDraftService
	) {
		super(SqlEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.sql-editor-pane'));
		this.toolbar = append(this.container, $('.sql-editor-toolbar'));

		this.connectionSelect = append(
			this.toolbar,
			$('select.sql-editor-connection-select', {
				'aria-label': 'SQL connection'
			})
		) as HTMLSelectElement;

		this.runButton = append(
			this.toolbar,
			$('button.sql-editor-button.primary', { type: 'button', title: 'Execute all SQL' }, 'Run All')
		) as HTMLButtonElement;

		this.runSelectionButton = append(
			this.toolbar,
			$('button.sql-editor-button', { type: 'button', title: 'Execute selected SQL' }, 'Run Selection')
		) as HTMLButtonElement;

		this.runStatementButton = append(
			this.toolbar,
			$('button.sql-editor-button', { type: 'button', title: 'Execute current statement' }, 'Run Statement')
		) as HTMLButtonElement;

		this.formatButton = append(
			this.toolbar,
			$('button.sql-editor-button', { type: 'button', title: 'Format SQL placeholder' }, 'Format')
		) as HTMLButtonElement;

		this.statusElement = append(this.toolbar, $('span.sql-editor-status'));
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
			addDisposableListener(this.runButton, EventType.CLICK, () => {
				this.executeQuery(SqlEditorExecutionSource.All).catch(error => this.showError(error));
			})
		);

		this._register(
			addDisposableListener(this.runSelectionButton, EventType.CLICK, () => {
				this.executeQuery(SqlEditorExecutionSource.Selection).catch(error => this.showError(error));
			})
		);

		this._register(
			addDisposableListener(this.runStatementButton, EventType.CLICK, () => {
				this.executeQuery(SqlEditorExecutionSource.Statement).catch(error => this.showError(error));
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
			})
		);

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
			})
		);

		this.editor?.setModel(model);
		this.editor?.focus();

		this.saveCurrentDraft();
		this.updateReadyStatus();
	}

	override clearInput(): void {
		this.modelDisposables.clear();
		this.editor?.setModel(null);
		this.currentInput = undefined;
		this.dirty = false;
		super.clearInput();
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

	async executeQuery(sourceOrSelectionOnly: SqlEditorExecutionSource | boolean): Promise<void> {
		const source = typeof sourceOrSelectionOnly === 'boolean'
			? sourceOrSelectionOnly ? SqlEditorExecutionSource.Selection : SqlEditorExecutionSource.All
			: sourceOrSelectionOnly;

		const input = this.currentInput;
		const startedAt = Date.now();
		let payload: SqlEditorExecutePayload | undefined;

		try {
			if (!input) {
				throw new Error('No SQL editor input is active.');
			}

			const connectionId = this.getSelectedConnectionId();
			const sql = this.getSqlForExecution(source);

			payload = createExecutePayload(connectionId, sql, source);

			this.status('Running query...');
			this.setRunning(true);

			this.sqlEditorEventService.fireQueryStarted({
				editorId: input.id,
				connectionId: payload.connectionId,
				sql: payload.sql,
				startedAt
			});

			const result = await this.sqlQueryService.executeQuery({
				connectionId: payload.connectionId,
				sql: payload.sql
			});

			const completedAt = Date.now();

			this.sqlEditorEventService.fireQueryCompleted({
				editorId: input.id,
				connectionId: payload.connectionId,
				sql: payload.sql,
				startedAt,
				completedAt,
				result
			});

			const message = `Query completed: ${result.rowCount} row(s) in ${result.elapsedMs}ms.`;
			this.dirty = false;
			this.saveCurrentDraft();
			this.status(message);
			this.notificationService.info(message);
		} catch (error) {
			const completedAt = Date.now();
			const normalizedError = error instanceof Error ? error : new Error(String(error));

			if (input && payload) {
				this.sqlEditorEventService.fireQueryFailed({
					editorId: input.id,
					connectionId: payload.connectionId,
					sql: payload.sql,
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

	formatQuery(): void {
		const model = this.editor?.getModel();

		if (!model) {
			return;
		}

		const formatted = createFormatterPlaceholderResult(model.getValue());

		if (formatted !== model.getValue()) {
			model.setValue(formatted);
			this.dirty = true;
			this.saveCurrentDraft();
		}

		this.status('SQL formatter is reserved for a future phase.');
		this.notificationService.info('SQL formatter is reserved for a future phase.');
	}

	private async refreshConnections(input: SqlEditorInput): Promise<void> {
		try {
			this.currentConnections = await this.sqlConnectionService.listConnections();
		} catch (error) {
			this.currentConnections = [];
			this.showError(error);
		}

		clearNode(this.connectionSelect);

		if (this.currentConnections.length === 0) {
			const option = document.createElement('option');
			option.value = '';
			option.textContent = 'No connection';
			this.connectionSelect.appendChild(option);
			this.connectionSelect.disabled = true;
			return;
		}

		this.connectionSelect.disabled = false;

		for (const connection of this.currentConnections) {
			const option = document.createElement('option');
			option.value = connection.id;
			option.textContent = connection.name;
			this.connectionSelect.appendChild(option);
		}

		const preferredConnectionId = input.connectionId;

		if (preferredConnectionId && this.currentConnections.some(connection => connection.id === preferredConnectionId)) {
			this.connectionSelect.value = preferredConnectionId;
		} else {
			this.connectionSelect.value = this.currentConnections[0].id;
		}
	}

	private getSelectedConnectionId(): string | undefined {
		const value = this.connectionSelect?.value?.trim();
		return value || undefined;
	}

	private getSelectedConnectionName(): string | undefined {
		const connectionId = this.getSelectedConnectionId();
		return this.currentConnections.find(connection => connection.id === connectionId)?.name;
	}

	private getAllSql(): string {
		return this.editor?.getModel()?.getValue() ?? '';
	}

	private getSelectedSql(): string {
		const editor = this.editor;
		const model = editor?.getModel();
		const selection = editor?.getSelection();

		if (!model || !selection || selection.isEmpty()) {
			return this.getCurrentStatementSql();
		}

		return model.getValueInRange(selection);
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

		return statement.sql || this.getAllSql();
	}

	private getSqlForExecution(source: SqlEditorExecutionSource): string {
		switch (source) {
			case SqlEditorExecutionSource.All:
				return this.getAllSql();

			case SqlEditorExecutionSource.Selection:
				return this.getSelectedSql();

			case SqlEditorExecutionSource.Statement:
				return this.getCurrentStatementSql();
		}
	}

	private saveCurrentDraft(): void {
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
				dirty: this.dirty,
				running: this.running
			})
		);
	}

	private setRunning(running: boolean): void {
		this.running = running;

		if (!this.runButton || !this.runSelectionButton || !this.runStatementButton || !this.formatButton || !this.connectionSelect) {
			return;
		}

		this.runButton.disabled = running;
		this.runSelectionButton.disabled = running;
		this.runStatementButton.disabled = running;
		this.formatButton.disabled = running;
		this.connectionSelect.disabled = running || this.currentConnections.length === 0;
	}

	private status(message: string): void {
		if (this.statusElement) {
			this.statusElement.textContent = message;
		}
	}

	private showError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.status(`Error: ${message}`);
		this.notificationService.error(message);
	}
}
