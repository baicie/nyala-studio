/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Result Panel View.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlResult.css';

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
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
	getActiveSqlResultSnapshot,
	getSqlResultPanelContentState,
	getSqlResultSummary,
	SqlResultPanelState,
	SqlResultSnapshotKind,
	SqlResultState,
	SqlResultStateKind
} from '../common/sqlResultModel.js';
import { SQL_RESULT_VIEW_ID } from '../common/sqlResult.js';
import { ISqlProductPreferencesService } from '../../sqlProduct/common/sqlProductPreferencesService.js';
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
import { getPreferredResultMaxRows } from '../../sqlProduct/common/sqlProductIntegrationModel.js';

export class SqlResultView extends ViewPane {
	static readonly ID = SQL_RESULT_VIEW_ID;
	static readonly NAME = localize('sqlResultViewName', 'Results');

	private readonly contentRenderDisposables = this._register(new DisposableStore());
	private readonly historyRenderDisposables = this._register(new DisposableStore());

	private container!: HTMLElement;
	private toolbarElement!: HTMLElement;
	private summaryElement!: HTMLElement;
	private contentElement!: HTMLElement;
	private statusElement!: HTMLElement;
	private historyElement!: HTMLElement;
	private copyCellButton!: HTMLButtonElement;
	private copyRowButton!: HTMLButtonElement;
	private copyColumnButton!: HTMLButtonElement;
	private copyCsvButton!: HTMLButtonElement;
	private copyTsvButton!: HTMLButtonElement;
	private clearButton!: HTMLButtonElement;

	private currentGrid: SqlResultGrid | undefined;
	private selectedCell: SqlResultCellAddress | undefined;
	private selectedCellElement: HTMLElement | undefined;
	private readonly historyItemElements = new Map<string, HTMLElement>();

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
		@ISqlResultService private readonly sqlResultService: ISqlResultService,
		@ISqlProductPreferencesService private readonly preferencesService: ISqlProductPreferencesService
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

	override dispose(): void {
		this.historyItemElements.clear();
		super.dispose();
	}

	protected override renderBody(container: HTMLElement): void {
		this.container = append(container, $('.sql-result-view'));
		this.historyElement = append(this.container, $('.sql-result-history'));
		this.toolbarElement = append(
			this.container,
			$('.sql-result-toolbar', { role: 'toolbar', 'aria-label': 'Result actions' })
		);

		this.summaryElement = append(this.toolbarElement, $('span.sql-result-summary'));
		const actions = append(this.toolbarElement, $('.sql-result-toolbar-actions'));

		this.copyCellButton = this.appendToolbarButton(actions, Codicon.copy, 'Copy selected cell');
		this.copyRowButton = this.appendToolbarButton(actions, Codicon.listFlat, 'Copy selected row as TSV');
		this.copyColumnButton = this.appendToolbarButton(actions, Codicon.symbolField, 'Copy selected column as TSV');
		this.copyCsvButton = this.appendToolbarButton(actions, Codicon.file, 'Copy all rows as CSV');
		this.copyTsvButton = this.appendToolbarButton(actions, Codicon.bracketDot, 'Copy all rows as TSV');
		this.clearButton = this.appendToolbarButton(actions, Codicon.clearAll, 'Clear result');

		this.contentElement = append(this.container, $('.sql-result-content', { tabIndex: 0 }));
		this.statusElement = append(
			this.container,
			$('.sql-result-statusbar', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' })
		);

		this._register(
			addDisposableListener(this.copyCellButton, EventType.CLICK, () => {
				this.copySelection(SqlResultCopyMode.Cell, SqlResultCopyFormat.Tsv).catch(error =>
					this.setStatus(toCopyErrorMessage(error))
				);
			})
		);

		this._register(
			addDisposableListener(this.copyRowButton, EventType.CLICK, () => {
				this.copySelection(SqlResultCopyMode.Row, SqlResultCopyFormat.Tsv).catch(error =>
					this.setStatus(toCopyErrorMessage(error))
				);
			})
		);

		this._register(
			addDisposableListener(this.copyColumnButton, EventType.CLICK, () => {
				this.copySelection(SqlResultCopyMode.Column, SqlResultCopyFormat.Tsv).catch(error =>
					this.setStatus(toCopyErrorMessage(error))
				);
			})
		);

		this._register(
			addDisposableListener(this.copyCsvButton, EventType.CLICK, () => {
				this.copySelection(SqlResultCopyMode.All, SqlResultCopyFormat.Csv).catch(error =>
					this.setStatus(toCopyErrorMessage(error))
				);
			})
		);

		this._register(
			addDisposableListener(this.copyTsvButton, EventType.CLICK, () => {
				this.copySelection(SqlResultCopyMode.All, SqlResultCopyFormat.Tsv).catch(error =>
					this.setStatus(toCopyErrorMessage(error))
				);
			})
		);

		this._register(
			addDisposableListener(this.clearButton, EventType.CLICK, () => {
				this.sqlResultService.clear();
			})
		);

		this._register(this.sqlResultService.onDidChangeResult(() => this.renderCurrentContent()));
		this._register(
			this.sqlResultService.onDidChangePanelState(state => {
				this.renderPanelState(state);
				this.renderCurrentContent();
			})
		);
		this._register(this.preferencesService.onDidChangePreferences(() => this.renderCurrentContent()));
		this.renderCurrentContent();
		this.renderPanelState(this.sqlResultService.panelState);
	}

	private appendToolbarButton(parent: HTMLElement, icon: ThemeIcon, label: string): HTMLButtonElement {
		const button = append(
			parent,
			$('button.sql-result-button', { type: 'button', title: label, 'aria-label': label })
		) as HTMLButtonElement;
		const iconElement = append(button, $('.sql-result-button-icon', { 'aria-hidden': 'true' }));
		iconElement.classList.add(...ThemeIcon.asClassNameArray(icon));
		return button;
	}

	override focus(): void {
		this.contentElement?.focus();
		super.focus();
	}

	private renderState(state: SqlResultState): void {
		this.contentRenderDisposables.clear();
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
				this.setStatus(getTerminalStatus('Query failed', state.query, state.errorCode));
				break;

			case SqlResultStateKind.Cancelled:
				this.renderCancelled(state);
				this.setStatus(getTerminalStatus('Query cancelled', state.query));
				break;

			case SqlResultStateKind.Success:
				this.renderSuccess(state);
				break;
		}

		this.updateToolbarState();
	}

	private renderEmpty(): void {
		const wrapper = append(this.contentElement, $('.sql-result-state.empty'));
		append(wrapper, $('.codicon.codicon-table.sql-result-state-icon', { 'aria-hidden': 'true' }));
		append(wrapper, $('.sql-result-state-title', undefined, 'No query results'));
		append(wrapper, $('.sql-result-state-description', undefined, 'Run a SQL query to populate this grid.'));
	}

	private renderPanelState(state: SqlResultPanelState): void {
		this.historyRenderDisposables.clear();
		this.historyItemElements.clear();
		clearNode(this.historyElement);

		const activeSnapshotId = getActiveSqlResultSnapshot(state)?.id;

		if (state.snapshots.length === 0) {
			return;
		}

		const list = append(
			this.historyElement,
			$('ul.sql-result-history-list', {
				role: 'listbox',
				'aria-label': 'Query results',
				'aria-orientation': 'horizontal'
			})
		);

		for (const snapshot of state.snapshots) {
			const isActive = snapshot.id === activeSnapshotId;
			const item = append(
				list,
				$('li.sql-result-history-item', {
					'data-snapshot-id': snapshot.id,
					role: 'option',
					tabIndex: isActive ? 0 : -1,
					'aria-selected': String(isActive),
					title: snapshot.sqlPreview
				})
			);
			this.historyItemElements.set(snapshot.id, item);
			if (isActive) {
				item.classList.add('active');
			}
			item.classList.add(`kind-${snapshot.kind}`);

			append(item, $('span.sql-result-history-kind', undefined, snapshotKindLabel(snapshot.kind)));
			append(item, $('span.sql-result-history-title', { title: snapshot.title }, snapshot.title));

			const removeButton = append(
				item,
				$('button.sql-result-history-remove', {
					type: 'button',
					title: 'Remove from history',
					'aria-label': `Remove ${snapshot.title} from history`
				})
			) as HTMLButtonElement;
			removeButton.classList.add(...ThemeIcon.asClassName(Codicon.close).split(' '));

			this.historyRenderDisposables.add(
				addDisposableListener(removeButton, EventType.CLICK, event => {
					event.stopPropagation();
					this.sqlResultService.removeSnapshot(snapshot.id);
				})
			);

			this.historyRenderDisposables.add(
				addDisposableListener(item, EventType.CLICK, () => {
					this.sqlResultService.activateSnapshot(snapshot.id);
				})
			);

			this.historyRenderDisposables.add(
				addDisposableListener(item, EventType.KEY_DOWN, event => {
					if (event.target !== item) {
						return;
					}

					let targetIndex: number | undefined;
					switch (event.key) {
						case 'ArrowLeft':
						case 'ArrowUp':
							targetIndex = Math.max(0, state.snapshots.indexOf(snapshot) - 1);
							break;
						case 'ArrowRight':
						case 'ArrowDown':
							targetIndex = Math.min(state.snapshots.length - 1, state.snapshots.indexOf(snapshot) + 1);
							break;
						case 'Home':
							targetIndex = 0;
							break;
						case 'End':
							targetIndex = state.snapshots.length - 1;
							break;
						case 'Enter':
						case ' ':
							this.sqlResultService.activateSnapshot(snapshot.id);
							this.historyItemElements.get(snapshot.id)?.focus();
							event.preventDefault();
							return;
						default:
							return;
					}

					const targetSnapshot = state.snapshots[targetIndex];
					if (targetSnapshot) {
						this.sqlResultService.activateSnapshot(targetSnapshot.id);
						this.historyItemElements.get(targetSnapshot.id)?.focus();
					}
					event.preventDefault();
				})
			);
		}
	}

	private renderRunning(state: Extract<SqlResultState, { kind: SqlResultStateKind.Running }>): void {
		const wrapper = append(this.contentElement, $('.sql-result-state.running'));
		append(
			wrapper,
			$('.codicon.codicon-loading.codicon-modifier-spin.sql-result-state-icon', { 'aria-hidden': 'true' })
		);
		append(wrapper, $('.sql-result-state-title', undefined, 'Running query…'));
		append(wrapper, $('pre.sql-result-sql', undefined, state.query.sql));
	}

	private renderError(state: Extract<SqlResultState, { kind: SqlResultStateKind.Error }>): void {
		const wrapper = append(this.contentElement, $('.sql-result-state.error'));
		append(wrapper, $('.codicon.codicon-error.sql-result-state-icon', { 'aria-hidden': 'true' }));
		if (state.errorCode) {
			append(wrapper, $('div.sql-result-error-code', undefined, state.errorCode));
		}
		append(wrapper, $('div.sql-result-error-title', undefined, state.errorMessage));
		if (state.errorDetail !== state.errorMessage) {
			append(wrapper, $('pre.sql-result-error-detail', undefined, state.errorDetail));
		}
		append(wrapper, $('pre.sql-result-sql', undefined, state.query.sql));
	}

	private renderCancelled(state: Extract<SqlResultState, { kind: SqlResultStateKind.Cancelled }>): void {
		const wrapper = append(this.contentElement, $('.sql-result-state.cancelled'));
		append(wrapper, $('.codicon.codicon-circle-slash.sql-result-state-icon', { 'aria-hidden': 'true' }));
		append(wrapper, $('div.sql-result-cancelled-title', undefined, state.message));
		append(wrapper, $('pre.sql-result-sql', undefined, state.query.sql));
	}

	private renderSuccess(state: Extract<SqlResultState, { kind: SqlResultStateKind.Success }>): void {
		const result = state.result;

		if (result.columns.length === 0) {
			const affectedRows = result.affectedRows ?? 0;
			const wrapper = append(this.contentElement, $('.sql-result-state.success'));
			append(wrapper, $('.codicon.codicon-pass-filled.sql-result-state-icon', { 'aria-hidden': 'true' }));
			append(wrapper, $('.sql-result-state-title', undefined, `${affectedRows} row(s) affected`));
			append(wrapper, $('.sql-result-state-description', undefined, `Completed in ${result.elapsedMs}ms.`));
			this.setStatus(`${affectedRows} row(s) affected · ${result.elapsedMs}ms`);
			return;
		}

		const grid = buildSqlResultGrid(result, getPreferredResultMaxRows(this.preferencesService.preferences));
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

		if (grid.isEmpty) {
			const emptyRow = append(tbody, $('tr.sql-result-empty-row'));
			const emptyCell = append(emptyRow, $('td', undefined, 'No rows returned.')) as HTMLTableCellElement;
			emptyCell.colSpan = grid.columns.length + 1;
		}

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

		this.contentRenderDisposables.add(
			addDisposableListener(wrapper, EventType.CLICK, event => {
				this.handleGridActivation(event);
			})
		);

		this.contentRenderDisposables.add(
			addDisposableListener(wrapper, EventType.KEY_DOWN, event => {
				if (event.key === 'Enter' || event.key === ' ') {
					this.handleGridActivation(event);
					event.preventDefault();
				}
			})
		);

		if (grid.truncatedByPanel || grid.truncatedByBackend) {
			const message = grid.truncatedByPanel
				? `Showing first ${grid.renderedRowCount} of ${grid.sourceRowCount} loaded row(s).`
				: `Backend truncated result at ${grid.totalRowCount} row(s).`;

			append(this.contentElement, $('.sql-result-truncated', undefined, message));
		}
	}

	private renderCurrentContent(): void {
		this.renderState(getSqlResultPanelContentState(this.sqlResultService.state, this.sqlResultService.panelState));
	}

	private handleGridActivation(event: Event): void {
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

		if (cell) {
			this.setStatus(`Selected row ${address.rowIndex + 1}, column ${address.columnIndex + 1}: ${cell.text}`);
		}

		this.updateToolbarState();
	}

	private updateToolbarState(): void {
		const hasGrid = Boolean(this.currentGrid);
		const hasSelection = hasGrid && Boolean(this.selectedCell);

		this.copyCellButton.disabled = !hasSelection;
		this.copyRowButton.disabled = !hasSelection;
		this.copyColumnButton.disabled = !hasSelection;
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
			this.setStatus('Nothing to copy.');
			return;
		}

		await writeClipboardText(text);
		this.setStatus(this.getCopyStatus(mode, format));
	}

	private getCopyStatus(mode: SqlResultCopyMode, format: SqlResultCopyFormat): string {
		switch (mode) {
			case SqlResultCopyMode.Cell:
				return 'Copied selected cell.';

			case SqlResultCopyMode.Row:
				return `Copied selected row as ${format.toUpperCase()}.`;

			case SqlResultCopyMode.Column:
				return `Copied selected column as ${format.toUpperCase()}.`;

			case SqlResultCopyMode.All:
				return `Copied result as ${format.toUpperCase()}.`;
		}
	}

	private setStatus(message: string): void {
		this.statusElement.textContent = message;
		this.statusElement.title = message;
	}
}

async function writeClipboardText(text: string): Promise<void> {
	if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}

	throw new Error('Clipboard API is not available.');
}

function toCopyErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return `Copy failed: ${error.message}`;
	}

	return `Copy failed: ${String(error)}`;
}

function snapshotKindLabel(kind: SqlResultSnapshotKind): string {
	switch (kind) {
		case SqlResultSnapshotKind.Success:
			return 'Success';
		case SqlResultSnapshotKind.Error:
			return 'Error';
		case SqlResultSnapshotKind.Cancelled:
			return 'Cancelled';
	}
}

function getTerminalStatus(
	label: string,
	query: { readonly startedAt: number; readonly completedAt?: number },
	code?: string
): string {
	const parts = [code ? `${label} [${code}]` : label];
	if (query.completedAt !== undefined) {
		parts.push(`${Math.max(0, query.completedAt - query.startedAt)}ms`);
	}
	return parts.join(' · ');
}
