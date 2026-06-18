/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Result Panel View.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlResult.css';

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import {
	buildSqlResultDisplayGrid,
	getSqlResultSummary,
	sqlResultToCsv,
	SqlResultState,
	SqlResultStateKind
} from '../common/sqlResultModel.js';
import { SQL_RESULT_MAX_RENDER_ROWS, SQL_RESULT_VIEW_ID } from '../common/sqlResult.js';
import { ISqlResultService } from '../common/sqlResultService.js';

export class SqlResultView extends ViewPane {
	static readonly ID = SQL_RESULT_VIEW_ID;
	static readonly NAME = localize('sqlResultViewName', 'Results');

	private readonly renderDisposables = this._register(new DisposableStore());

	private container!: HTMLElement;
	private toolbar!: HTMLElement;
	private summaryElement!: HTMLElement;
	private contentElement!: HTMLElement;
	private clearButton!: HTMLButtonElement;
	private copyCsvButton!: HTMLButtonElement;

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
		@ISqlResultService private readonly sqlResultService: ISqlResultService
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
		this.container = append(container, $('.sql-result-view'));
		this.toolbar = append(this.container, $('.sql-result-toolbar'));

		this.summaryElement = append(this.toolbar, $('span.sql-result-summary'));

		this.copyCsvButton = append(
			this.toolbar,
			$('button.sql-result-button', { type: 'button', title: 'Copy result as CSV' }, 'Copy CSV')
		) as HTMLButtonElement;

		this.clearButton = append(
			this.toolbar,
			$('button.sql-result-button', { type: 'button', title: 'Clear result' }, 'Clear')
		) as HTMLButtonElement;

		this.contentElement = append(this.container, $('.sql-result-content'));

		this._register(
			addDisposableListener(this.clearButton, EventType.CLICK, () => {
				this.sqlResultService.clear();
			})
		);

		this._register(
			addDisposableListener(this.copyCsvButton, EventType.CLICK, () => {
				this.copyCsv().catch(() => {
					// Clipboard is best-effort. UI still works without it.
				});
			})
		);

		this._register(this.sqlResultService.onDidChangeResult(state => this.renderState(state)));
		this.renderState(this.sqlResultService.state);
	}

	override focus(): void {
		this.contentElement?.focus();
		super.focus();
	}

	private renderState(state: SqlResultState): void {
		this.renderDisposables.clear();
		clearNode(this.contentElement);

		this.summaryElement.textContent = getSqlResultSummary(state);
		this.copyCsvButton.disabled = state.kind !== SqlResultStateKind.Success || state.result.columns.length === 0;

		switch (state.kind) {
			case SqlResultStateKind.Idle:
				this.renderEmpty();
				break;

			case SqlResultStateKind.Running:
				this.renderRunning(state);
				break;

			case SqlResultStateKind.Error:
				this.renderError(state);
				break;

			case SqlResultStateKind.Success:
				this.renderSuccess(state);
				break;
		}
	}

	private renderEmpty(): void {
		append(this.contentElement, $('.sql-result-empty', undefined, 'Run a SQL query to see results here.'));
	}

	private renderRunning(state: Extract<SqlResultState, { kind: SqlResultStateKind.Running }>): void {
		const wrapper = append(this.contentElement, $('.sql-result-message.running'));
		append(wrapper, $('div', undefined, 'Running query...'));
		append(wrapper, $('pre.sql-result-sql', undefined, state.query.sql));
	}

	private renderError(state: Extract<SqlResultState, { kind: SqlResultStateKind.Error }>): void {
		const wrapper = append(this.contentElement, $('.sql-result-message.error'));
		append(wrapper, $('div.sql-result-error-title', undefined, state.errorMessage));
		append(wrapper, $('pre.sql-result-sql', undefined, state.query.sql));
	}

	private renderSuccess(state: Extract<SqlResultState, { kind: SqlResultStateKind.Success }>): void {
		const result = state.result;

		if (result.columns.length === 0) {
			const affectedRows = result.affectedRows ?? 0;
			append(
				this.contentElement,
				$('.sql-result-empty', undefined, `${affectedRows} row(s) affected in ${result.elapsedMs}ms.`)
			);
			return;
		}

		const grid = buildSqlResultDisplayGrid(result, SQL_RESULT_MAX_RENDER_ROWS);

		const wrapper = append(this.contentElement, $('.sql-result-table-wrapper', { tabIndex: 0 }));
		const table = append(wrapper, $('table.sql-result-table'));

		const thead = append(table, $('thead'));
		const headerRow = append(thead, $('tr'));
		append(headerRow, $('th.sql-result-row-number', undefined, '#'));

		for (const column of grid.columns) {
			append(headerRow, $('th', { title: column }, column));
		}

		const tbody = append(table, $('tbody'));

		grid.rows.forEach((row, rowIndex) => {
			const tr = append(tbody, $('tr'));
			append(tr, $('td.sql-result-row-number', undefined, String(rowIndex + 1)));

			for (const cell of row) {
				append(tr, $('td', { title: cell }, cell));
			}
		});

		if (grid.truncatedByBackend || grid.truncatedByPanel) {
			const message = grid.truncatedByPanel
				? `Showing first ${grid.renderedRowCount} of ${grid.totalRowCount} row(s).`
				: `Backend truncated result at ${grid.totalRowCount} row(s).`;

			append(this.contentElement, $('.sql-result-truncated', undefined, message));
		}
	}

	private async copyCsv(): Promise<void> {
		const state = this.sqlResultService.state;

		if (state.kind !== SqlResultStateKind.Success || state.result.columns.length === 0) {
			return;
		}

		const text = sqlResultToCsv(state.result, SQL_RESULT_MAX_RENDER_ROWS);

		if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
		}
	}
}
