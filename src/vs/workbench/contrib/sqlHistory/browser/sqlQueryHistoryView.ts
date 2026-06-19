/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Query History view.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlQueryHistory.css';

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ISqlQueryService } from '../../../services/sql/common/sqlQuery.js';
import { SQL_NEW_QUERY_COMMAND_ID } from '../../sqlEditor/common/sqlEditor.js';
import { ISqlEditorEventService } from '../../sqlEditor/common/sqlEditorEvents.js';
import {
	SQL_QUERY_HISTORY_VIEW_ID
} from '../common/sqlQueryHistory.js';
import {
	getHistoryEntryDetail,
	getHistoryEntryLabel,
	SqlQueryHistoryEntry,
	SqlQueryHistoryStatus
} from '../common/sqlQueryHistoryModel.js';
import { ISqlQueryHistoryService } from '../common/sqlQueryHistoryService.js';

export class SqlQueryHistoryView extends ViewPane {
	static readonly ID = SQL_QUERY_HISTORY_VIEW_ID;
	static readonly NAME = localize('sqlQueryHistoryViewName', 'Query History');

	private readonly renderDisposables = this._register(new DisposableStore());

	private container!: HTMLElement;
	private toolbar!: HTMLElement;
	private contentElement!: HTMLElement;
	private statusElement!: HTMLElement;
	private clearButton!: HTMLButtonElement;

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
		@ISqlQueryHistoryService private readonly historyService: ISqlQueryHistoryService,
		@ICommandService private readonly commandService: ICommandService,
		@ISqlQueryService private readonly sqlQueryService: ISqlQueryService,
		@ISqlEditorEventService private readonly sqlEditorEventService: ISqlEditorEventService,
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
		this.container = append(container, $('.sql-query-history-view'));
		this.toolbar = append(this.container, $('.sql-query-history-toolbar'));

		this.clearButton = append(
			this.toolbar,
			$('button.sql-query-history-button', { type: 'button' }, 'Clear History')
		) as HTMLButtonElement;

		this.contentElement = append(this.container, $('.sql-query-history-content', { tabIndex: 0 }));
		this.statusElement = append(this.container, $('.sql-query-history-statusbar'));

		this._register(
			addDisposableListener(this.clearButton, EventType.CLICK, () => {
				this.historyService.clear();
			})
		);

		this._register(this.historyService.onDidChangeHistory(() => this.renderHistory()));
		this.renderHistory();
	}

	override focus(): void {
		this.contentElement?.focus();
		super.focus();
	}

	private renderHistory(): void {
		this.renderDisposables.clear();
		clearNode(this.contentElement);

		const entries = this.historyService.entries;
		this.clearButton.disabled = entries.length === 0;

		if (entries.length === 0) {
			append(this.contentElement, $('.sql-query-history-empty', undefined, 'No query history yet.'));
			this.setStatus('No query history.');
			return;
		}

		const list = append(this.contentElement, $('.sql-query-history-list', { role: 'list' }));

		for (const entry of entries) {
			this.renderEntry(list, entry);
		}

		this.setStatus(`${entries.length} query history item(s).`);
	}

	private renderEntry(parent: HTMLElement, entry: SqlQueryHistoryEntry): void {
		const item = append(parent, $('.sql-query-history-item', {
			role: 'listitem',
			'data-entry-id': entry.id
		}));

		item.classList.add(entry.status === SqlQueryHistoryStatus.Success ? 'success' : 'error');

		const main = append(item, $('.sql-query-history-main'));
		append(main, $('.sql-query-history-title', { title: entry.sql }, getHistoryEntryLabel(entry)));
		append(main, $('.sql-query-history-detail', undefined, getHistoryEntryDetail(entry)));

		const actions = append(item, $('.sql-query-history-actions'));

		const openButton = append(
			actions,
			$('button.sql-query-history-button', { type: 'button' }, 'Open')
		) as HTMLButtonElement;

		const rerunButton = append(
			actions,
			$('button.sql-query-history-button', { type: 'button' }, 'Rerun')
		) as HTMLButtonElement;

		const removeButton = append(
			actions,
			$('button.sql-query-history-button', { type: 'button' }, 'Remove')
		) as HTMLButtonElement;

		this.renderDisposables.add(
			addDisposableListener(openButton, EventType.CLICK, () => {
				this.openEntry(entry).catch(error => this.showError(error));
			})
		);

		this.renderDisposables.add(
			addDisposableListener(rerunButton, EventType.CLICK, () => {
				this.rerunEntry(entry).catch(error => this.showError(error));
			})
		);

		this.renderDisposables.add(
			addDisposableListener(removeButton, EventType.CLICK, () => {
				this.historyService.remove(entry.id);
			})
		);
	}

	private async openEntry(entry: SqlQueryHistoryEntry): Promise<void> {
		await this.commandService.executeCommand(SQL_NEW_QUERY_COMMAND_ID, {
			connectionId: entry.connectionId,
			initialSql: entry.sql
		});

		this.setStatus('Opened query from history.');
	}

	private async rerunEntry(entry: SqlQueryHistoryEntry): Promise<void> {
		const startedAt = Date.now();

		this.sqlEditorEventService.fireQueryStarted({
			editorId: `history-${entry.id}`,
			connectionId: entry.connectionId,
			sql: entry.sql,
			startedAt
		});

		try {
			const result = await this.sqlQueryService.executeQuery({
				connectionId: entry.connectionId,
				sql: entry.sql
			});

			this.sqlEditorEventService.fireQueryCompleted({
				editorId: `history-${entry.id}`,
				connectionId: entry.connectionId,
				sql: entry.sql,
				startedAt,
				completedAt: Date.now(),
				result
			});

			this.setStatus(`Rerun completed: ${result.rowCount} row(s).`);
		} catch (error) {
			const normalizedError = error instanceof Error ? error : new Error(String(error));

			this.sqlEditorEventService.fireQueryFailed({
				editorId: `history-${entry.id}`,
				connectionId: entry.connectionId,
				sql: entry.sql,
				startedAt,
				completedAt: Date.now(),
				error: normalizedError
			});

			throw normalizedError;
		}
	}

	private showError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.setStatus(`Error: ${message}`);
		this.notificationService.error(message);
	}

	private setStatus(message: string): void {
		this.statusElement.textContent = message;
	}
}
