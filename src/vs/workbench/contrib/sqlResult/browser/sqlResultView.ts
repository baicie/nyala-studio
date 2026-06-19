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
	getSqlResultSummary,
	SqlResultState,
	SqlResultStateKind
} from '../common/sqlResultModel.js';
import { SQL_RESULT_MAX_RENDER_ROWS, SQL_RESULT_VIEW_ID } from '../common/sqlResult.js';
import { ISqlResultService } from '../common/sqlResultService.js';
import {
	buildSqlResultGrid,
	copySqlResultGrid,
	getGridCell,
	getSqlResultGridStatus,
	SqlResultCellAddress,
	SqlResultCopyFormat,
	SqlResultCopyMode,
	SqlResultGrid
} from '../common/sqlResultGridModel.js';

export class SqlResultView extends ViewPane {
	static readonly ID = SQL_RESULT_VIEW_ID;
	static readonly NAME = localize('sqlResultViewName', 'Results');

	private readonly renderDisposables = this._register(new DisposableStore());

	private container!: HTMLElement;
	private toolbar!: HTMLElement;
	private summaryElement!: HTMLElement;
	private contentElement!: HTMLElement;
	private statusElement!: HTMLElement;
	private copyCellButton!: HTMLButtonElement;
	private copyRowButton!: HTMLButtonElement;
	private copyCsvButton!: HTMLButtonElement;
	private copyTsvButton!: HTMLButtonElement;
	private clearButton!: HTMLButtonElement;

	private currentGrid: SqlResultGrid | undefined;
	private selectedCell: SqlResultCellAddress | undefined;
	private selectedCellElement: HTMLElement | undefined;

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

		this.copyCellButton = append(
			this.toolbar,
			$('button.sql-result-button', { type: 'button', title: 'Copy selected cell' }, 'Copy Cell')
		) as HTMLButtonElement;

		this.copyRowButton = append(
			this.toolbar,
			$('button.sql-result-button', { type: 'button', title: 'Copy selected row as TSV' }, 'Copy Row')
		) as HTMLButtonElement;

		this.copyCsvButton = append(
			this.toolbar,
			$('button.sql-result-button', { type: 'button', title: 'Copy all rows as CSV' }, 'Copy CSV')
		) as HTMLButtonElement;

		this.copyTsvButton = append(
			this.toolbar,
			$('button.sql-result-button', { type: 'button', title: 'Copy all rows as TSV' }, 'Copy TSV')
		) as HTMLButtonElement;

		this.clearButton = append(
			this.toolbar,
			$('button.sql-result-button', { type: 'button', title: 'Clear result' }, 'Clear')
		) as HTMLButtonElement;

		this.contentElement = append(this.container, $('.sql-result-content', { tabIndex: 0 }));
		this.statusElement = append(this.container, $('.sql-result-statusbar'));

		this._register(
			addDisposableListener(this.copyCellButton, EventType.CLICK, () => {
				this.copySelection(SqlResultCopyMode.Cell, SqlResultCopyFormat.Tsv).catch(() => undefined);
			})
		);

		this._register(
			addDisposableListener(this.copyRowButton, EventType.CLICK, () => {
				this.copySelection(SqlResultCopyMode.Row, SqlResultCopyFormat.Tsv).catch(() => undefined);
			})
		);

		this._register(
			addDisposableListener(this.copyCsvButton, EventType.CLICK, () => {
				this.copySelection(SqlResultCopyMode.All, SqlResultCopyFormat.Csv).catch(() => undefined);
			})
		);

		this._register(
			addDisposableListener(this.copyTsvButton, EventType.CLICK, () => {
				this.copySelection(SqlResultCopyMode.All, SqlResultCopyFormat.Tsv).catch(() => undefined);
			})
		);

		this._register(
			addDisposableListener(this.clearButton, EventType.CLICK, () => {
				this.sqlResultService.clear();
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

		this.currentGrid = undefined;
		this.selectedCell = undefined;
		this.selectedCellElement = undefined;

		this.summaryElement.textContent = getSqlResultSummary(state);

		switch (state.kind) {
			case SqlResultStateKind.Idle:
				this.renderEmpty();
				this.setStatus('No result.');
				break;

			case SqlResultStateKind.Running:
				this.renderRunning(state);
				this.setStatus('Running...');
				break;

			case SqlResultStateKind.Error:
				this.renderError(state);
				this.setStatus('Query failed.');
				break;

			case SqlResultStateKind.Success:
				this.renderSuccess(state);
				break;
		}

		this.updateToolbarState();
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
			this.setStatus(`${affectedRows} row(s) affected · ${result.elapsedMs}ms`);
			return;
		}

		const grid = buildSqlResultGrid(result, SQL_RESULT_MAX_RENDER_ROWS);
		this.currentGrid = grid;
		this.setStatus(getSqlResultGridStatus(result, grid));

		const wrapper = append(this.contentElement, $('.sql-result-table-wrapper', { tabIndex: 0 }));
		const table = append(wrapper, $('table.sql-result-table'));

		const thead = append(table, $('thead'));
		const headerRow = append(thead, $('tr'));
		append(headerRow, $('th.sql-result-row-number', undefined, '#'));

		for (const column of grid.columns) {
			const th = append(headerRow, $('th.sql-result-column-header', { title: column.name }, column.name));
			th.style.width = `${column.width}px`;
			th.style.maxWidth = `${column.width}px`;
		}

		const tbody = append(table, $('tbody'));

		for (const row of grid.rows) {
			const tr = append(tbody, $('tr.sql-result-row'));
			append(tr, $('td.sql-result-row-number', undefined, String(row.index + 1)));

			for (const cell of row.cells) {
				const td = append(
					tr,
					$('td.sql-result-cell', {
						title: cell.text,
						tabIndex: 0,
						'data-row-index': String(cell.rowIndex),
						'data-column-index': String(cell.columnIndex)
					})
				);

				td.classList.add(cell.className);
				td.textContent = cell.text;
			}
		}

		this.renderDisposables.add(
			addDisposableListener(wrapper, EventType.CLICK, event => {
				this.handleGridClick(event);
			})
		);

		this.renderDisposables.add(
			addDisposableListener(wrapper, EventType.KEY_DOWN, event => {
				if (event.key === 'Enter') {
					this.handleGridClick(event);
				}
			})
		);

		if (grid.truncatedByBackend || grid.truncatedByPanel) {
			const message = grid.truncatedByPanel
				? `Showing first ${grid.renderedRowCount} of ${grid.totalRowCount} row(s).`
				: `Backend truncated result at ${grid.totalRowCount} row(s).`;

			append(this.contentElement, $('.sql-result-truncated', undefined, message));
		}
	}

	private handleGridClick(event: Event): void {
		const target = event.target;

		if (!(target instanceof HTMLElement)) {
			return;
		}

		const cellElement = target.closest('.sql-result-cell');

		if (!(cellElement instanceof HTMLElement)) {
			return;
		}

		const rowIndex = Number(cellElement.dataset.rowIndex);
		const columnIndex = Number(cellElement.dataset.columnIndex);

		if (!Number.isInteger(rowIndex) || !Number.isInteger(columnIndex)) {
			return;
		}

		this.selectCell({ rowIndex, columnIndex }, cellElement);
	}

	private selectCell(address: SqlResultCellAddress, element: HTMLElement): void {
		this.selectedCellElement?.classList.remove('selected');

		this.selectedCell = address;
		this.selectedCellElement = element;
		this.selectedCellElement.classList.add('selected');

		const cell = this.currentGrid ? getGridCell(this.currentGrid, address) : undefined;
		const cellLabel = cell ? `Selected row ${address.rowIndex + 1}, column ${address.columnIndex + 1}: ${cell.text}` : '';

		if (cellLabel) {
			this.setStatus(cellLabel);
		}

		this.updateToolbarState();
	}

	private updateToolbarState(): void {
		const hasGrid = Boolean(this.currentGrid);
		const hasSelection = hasGrid && Boolean(this.selectedCell);

		this.copyCellButton.disabled = !hasSelection;
		this.copyRowButton.disabled = !hasSelection;
		this.copyCsvButton.disabled = !hasGrid;
		this.copyTsvButton.disabled = !hasGrid;
	}

	private async copySelection(mode: SqlResultCopyMode, format: SqlResultCopyFormat): Promise<void> {
		if (!this.currentGrid) {
			return;
		}

		const text = copySqlResultGrid(this.currentGrid, {
			mode,
			format,
			selection: this.selectedCell,
			includeHeader: mode !== SqlResultCopyMode.Cell
		});

		if (!text) {
			return;
		}

		if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
		}

		this.setStatus(this.getCopyStatus(mode, format));
	}

	private getCopyStatus(mode: SqlResultCopyMode, format: SqlResultCopyFormat): string {
		switch (mode) {
			case SqlResultCopyMode.Cell:
				return 'Copied selected cell.';

			case SqlResultCopyMode.Row:
				return `Copied selected row as ${format.toUpperCase()}.`;

			case SqlResultCopyMode.All:
				return `Copied result as ${format.toUpperCase()}.`;
		}
	}

	private setStatus(message: string): void {
		if (this.statusElement) {
			this.statusElement.textContent = message;
		}
	}
}
