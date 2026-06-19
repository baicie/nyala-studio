下面是**重新拉回路线后的 Phase 7**。这版不做多数据库、不做 Driver Form、不做 AI、不做插件，而是专注把 Phase 6 的简单 Result Panel 提升成“能日常使用”的结果表格体验。

当前 Phase 6 的结果模型还是 `columns: string[] / rows: string[][]`，只有基础 CSV 导出能力。 当前 `SqlResultView` 也只有 `Copy CSV / Clear` 两个按钮，表格单元格只是普通 `td`。  所以 Phase 7 的目标就是增强这里。

---

# Phase 7：Result Grid & Query UX Migration

## 目标

```txt
把 Phase 6 的简单 SQL Results Panel
升级成一个可用的 SQL 查询结果表格体验
```

本阶段做：

```txt
1. 新增 SqlResultGridModel
2. 保留 raw cell kind，不再只转 string
3. 支持 cell / row / all copy
4. 支持 CSV / TSV 输出
5. 支持选中单元格
6. 支持 NULL / blob / number / text 样式区分
7. 支持 Result status bar
8. 支持 copied message
9. 继续限制 1000 行，不做虚拟滚动
10. 完整单元测试
```

本阶段不做：

```txt
1. 不接 AG Grid
2. 不做虚拟滚动
3. 不做编辑单元格
4. 不做分页查询
5. 不做多结果集
6. 不做 MySQL/Postgres
7. 不做 AI
```

---

# 文件变化

新增：

```txt
src/vs/workbench/contrib/sqlResult/common/sqlResultGridModel.ts
src/vs/workbench/contrib/sqlResult/test/sqlResultGridModel.test.ts
```

修改：

```txt
src/vs/workbench/contrib/sqlResult/browser/sqlResultView.ts
src/vs/workbench/contrib/sqlResult/browser/media/sqlResult.css
package.json
```

---

# 1. 新增 `src/vs/workbench/contrib/sqlResult/common/sqlResultGridModel.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Result Grid Model.
 *--------------------------------------------------------------------------------------------*/

import {
	SqlCellKind,
	SqlCellValue,
	SqlQueryResult,
	SqlResultColumn
} from '../../../services/sql/common/sqlTypes.js';
import { SQL_RESULT_MAX_RENDER_ROWS } from './sqlResult.js';

export const SQL_RESULT_DEFAULT_COLUMN_WIDTH = 160;
export const SQL_RESULT_MIN_COLUMN_WIDTH = 80;
export const SQL_RESULT_MAX_COLUMN_WIDTH = 480;

export interface SqlResultGridColumn {
	readonly id: string;
	readonly name: string;
	readonly ordinal: number;
	readonly width: number;
}

export interface SqlResultGridCell {
	readonly rowIndex: number;
	readonly columnIndex: number;
	readonly kind: SqlCellKind;
	readonly value: SqlCellValue['value'];
	readonly text: string;
	readonly className: string;
	readonly isNull: boolean;
	readonly isBlob: boolean;
}

export interface SqlResultGridRow {
	readonly index: number;
	readonly cells: SqlResultGridCell[];
}

export interface SqlResultGrid {
	readonly columns: SqlResultGridColumn[];
	readonly rows: SqlResultGridRow[];
	readonly renderedRowCount: number;
	readonly totalRowCount: number;
	readonly truncatedByBackend: boolean;
	readonly truncatedByPanel: boolean;
}

export interface SqlResultCellAddress {
	readonly rowIndex: number;
	readonly columnIndex: number;
}

export const enum SqlResultCopyMode {
	Cell = 'cell',
	Row = 'row',
	All = 'all'
}

export const enum SqlResultCopyFormat {
	Csv = 'csv',
	Tsv = 'tsv'
}

export interface SqlResultCopyOptions {
	readonly mode: SqlResultCopyMode;
	readonly format: SqlResultCopyFormat;
	readonly selection?: SqlResultCellAddress;
	readonly includeHeader?: boolean;
}

export function buildSqlResultGrid(
	result: SqlQueryResult,
	maxRows = SQL_RESULT_MAX_RENDER_ROWS
): SqlResultGrid {
	const normalizedMaxRows = normalizeMaxRows(maxRows);
	const rows = result.rows.slice(0, normalizedMaxRows);

	return {
		columns: result.columns.map(createGridColumn),
		rows: rows.map((row, rowIndex) => ({
			index: rowIndex,
			cells: row.map((cell, columnIndex) => createGridCell(cell, rowIndex, columnIndex))
		})),
		renderedRowCount: rows.length,
		totalRowCount: result.rowCount,
		truncatedByBackend: result.truncated,
		truncatedByPanel: result.rows.length > rows.length
	};
}

export function createGridColumn(column: SqlResultColumn): SqlResultGridColumn {
	const name = column.name || `Column ${column.ordinal + 1}`;

	return {
		id: `column-${column.ordinal}`,
		name,
		ordinal: column.ordinal,
		width: clampColumnWidth(estimateColumnWidth(name))
	};
}

export function createGridCell(
	cell: SqlCellValue,
	rowIndex: number,
	columnIndex: number
): SqlResultGridCell {
	const text = formatSqlResultCell(cell);
	const isNull = cell.kind === SqlCellKind.Null || cell.value === null || cell.value === undefined;
	const isBlob = cell.kind === SqlCellKind.Blob;

	return {
		rowIndex,
		columnIndex,
		kind: cell.kind,
		value: cell.value,
		text,
		className: getCellClassName(cell),
		isNull,
		isBlob
	};
}

export function formatSqlResultCell(cell: SqlCellValue): string {
	if (cell.kind === SqlCellKind.Null || cell.value === null || cell.value === undefined) {
		return 'NULL';
	}

	if (cell.kind === SqlCellKind.Blob) {
		if (isBlobJsonValue(cell.value)) {
			return `[blob ${cell.value.byteLength} bytes]`;
		}

		return '[blob]';
	}

	if (typeof cell.value === 'object') {
		return JSON.stringify(cell.value);
	}

	return String(cell.value);
}

export function getCellClassName(cell: SqlCellValue): string {
	switch (cell.kind) {
		case SqlCellKind.Null:
			return 'kind-null';

		case SqlCellKind.Integer:
		case SqlCellKind.Real:
			return 'kind-number';

		case SqlCellKind.Blob:
			return 'kind-blob';

		case SqlCellKind.Text:
		default:
			return 'kind-text';
	}
}

export function copySqlResultGrid(grid: SqlResultGrid, options: SqlResultCopyOptions): string {
	const includeHeader = options.includeHeader !== false;

	switch (options.mode) {
		case SqlResultCopyMode.Cell:
			return copySelectedCell(grid, options.selection);

		case SqlResultCopyMode.Row:
			return serializeRows(
				grid,
				options.selection ? [options.selection.rowIndex] : [],
				options.format,
				includeHeader
			);

		case SqlResultCopyMode.All:
			return serializeRows(
				grid,
				grid.rows.map(row => row.index),
				options.format,
				includeHeader
			);

		default:
			return assertNever(options.mode);
	}
}

export function copySelectedCell(
	grid: SqlResultGrid,
	selection: SqlResultCellAddress | undefined
): string {
	if (!selection) {
		return '';
	}

	const cell = getGridCell(grid, selection);

	return cell?.text ?? '';
}

export function getGridCell(
	grid: SqlResultGrid,
	address: SqlResultCellAddress
): SqlResultGridCell | undefined {
	const row = grid.rows[address.rowIndex];

	if (!row) {
		return undefined;
	}

	return row.cells[address.columnIndex];
}

export function getSqlResultGridStatus(result: SqlQueryResult, grid: SqlResultGrid): string {
	if (result.columns.length === 0) {
		return `${result.affectedRows ?? 0} row(s) affected · ${result.elapsedMs}ms`;
	}

	const parts = [
		`${grid.totalRowCount} row(s)`,
		`${grid.columns.length} column(s)`,
		`${result.elapsedMs}ms`
	];

	if (grid.truncatedByPanel) {
		parts.push(`showing first ${grid.renderedRowCount}`);
	}

	if (grid.truncatedByBackend) {
		parts.push('backend truncated');
	}

	return parts.join(' · ');
}

export function serializeRows(
	grid: SqlResultGrid,
	rowIndexes: readonly number[],
	format: SqlResultCopyFormat,
	includeHeader = true
): string {
	const rows: string[][] = [];

	if (includeHeader) {
		rows.push(grid.columns.map(column => column.name));
	}

	for (const rowIndex of rowIndexes) {
		const row = grid.rows[rowIndex];

		if (!row) {
			continue;
		}

		rows.push(row.cells.map(cell => cell.text));
	}

	return serializeTable(rows, format);
}

export function serializeTable(
	rows: readonly (readonly string[])[],
	format: SqlResultCopyFormat
): string {
	switch (format) {
		case SqlResultCopyFormat.Csv:
			return rows.map(row => row.map(escapeCsvCell).join(',')).join('\n');

		case SqlResultCopyFormat.Tsv:
			return rows.map(row => row.map(escapeTsvCell).join('\t')).join('\n');

		default:
			return assertNever(format);
	}
}

export function escapeCsvCell(value: string): string {
	if (!/[",\n\r]/.test(value)) {
		return value;
	}

	return `"${value.replaceAll('"', '""')}"`;
}

export function escapeTsvCell(value: string): string {
	return value
		.replaceAll('\t', ' ')
		.replaceAll('\r\n', '\n')
		.replaceAll('\r', '\n')
		.replaceAll('\n', ' ');
}

export function clampColumnWidth(width: number): number {
	if (!Number.isFinite(width)) {
		return SQL_RESULT_DEFAULT_COLUMN_WIDTH;
	}

	return Math.min(SQL_RESULT_MAX_COLUMN_WIDTH, Math.max(SQL_RESULT_MIN_COLUMN_WIDTH, Math.round(width)));
}

export function estimateColumnWidth(columnName: string): number {
	return SQL_RESULT_DEFAULT_COLUMN_WIDTH + Math.max(0, columnName.length - 12) * 8;
}

function normalizeMaxRows(maxRows: number): number {
	if (!Number.isInteger(maxRows) || maxRows <= 0) {
		throw new Error('maxRows must be a positive integer');
	}

	return maxRows;
}

function isBlobJsonValue(value: SqlCellValue['value']): value is { encoding: 'base64'; data: string; byteLength: number } {
	return typeof value === 'object' && value !== null && !Array.isArray(value) && 'byteLength' in value;
}

function assertNever(value: never): never {
	throw new Error(`Unexpected SQL result grid value: ${String(value)}`);
}
```

---

# 2. 替换 `src/vs/workbench/contrib/sqlResult/browser/sqlResultView.ts`

```ts
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
```

---

# 3. 替换 `src/vs/workbench/contrib/sqlResult/browser/media/sqlResult.css`

```css
.sql-result-panel {
	min-height: 0;
}

.sql-result-view {
	box-sizing: border-box;
	height: 100%;
	width: 100%;
	display: flex;
	flex-direction: column;
	overflow: hidden;
	background: var(--vscode-editor-background);
	color: var(--vscode-editor-foreground);
}

.sql-result-toolbar {
	box-sizing: border-box;
	min-height: 32px;
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 4px 8px;
	border-bottom: 1px solid var(--vscode-editorGroup-border);
	background: var(--vscode-sideBar-background);
}

.sql-result-summary {
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 12px;
	opacity: 0.9;
}

.sql-result-button {
	height: 24px;
	padding: 0 10px;
	border: 1px solid var(--vscode-button-border);
	color: var(--vscode-button-secondaryForeground);
	background: var(--vscode-button-secondaryBackground);
	cursor: pointer;
	font-size: 12px;
}

.sql-result-button:hover:not(:disabled) {
	background: var(--vscode-button-hoverBackground);
}

.sql-result-button:disabled {
	opacity: 0.45;
	cursor: default;
}

.sql-result-content {
	flex: 1 1 auto;
	min-height: 0;
	overflow: auto;
	outline: none;
}

.sql-result-empty,
.sql-result-message {
	padding: 12px;
	font-size: 12px;
	opacity: 0.9;
}

.sql-result-message.error {
	color: var(--vscode-errorForeground);
}

.sql-result-message.running {
	color: var(--vscode-descriptionForeground);
}

.sql-result-error-title {
	font-weight: 600;
	margin-bottom: 8px;
}

.sql-result-sql {
	box-sizing: border-box;
	margin: 8px 0 0;
	padding: 8px;
	white-space: pre-wrap;
	color: var(--vscode-textPreformat-foreground);
	background: var(--vscode-textCodeBlock-background);
	border-radius: 3px;
	overflow: auto;
}

.sql-result-table-wrapper {
	min-height: 0;
	overflow: auto;
	outline: none;
}

.sql-result-table {
	width: max-content;
	min-width: 100%;
	border-collapse: collapse;
	font-size: 12px;
}

.sql-result-table th,
.sql-result-table td {
	box-sizing: border-box;
	max-width: 480px;
	padding: 4px 8px;
	border-right: 1px solid var(--vscode-editorGroup-border);
	border-bottom: 1px solid var(--vscode-editorGroup-border);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	text-align: left;
}

.sql-result-table th {
	position: sticky;
	top: 0;
	z-index: 1;
	font-weight: 600;
	background: var(--vscode-sideBar-background);
}

.sql-result-column-header {
	user-select: none;
}

.sql-result-row:hover {
	background: var(--vscode-list-hoverBackground);
}

.sql-result-row-number {
	width: 52px;
	max-width: 52px;
	text-align: right;
	color: var(--vscode-descriptionForeground);
	background: var(--vscode-sideBar-background);
	user-select: none;
}

.sql-result-cell {
	cursor: default;
	outline: none;
}

.sql-result-cell:hover {
	background: var(--vscode-list-hoverBackground);
}

.sql-result-cell.selected {
	outline: 1px solid var(--vscode-focusBorder);
	outline-offset: -1px;
	background: var(--vscode-list-activeSelectionBackground);
	color: var(--vscode-list-activeSelectionForeground);
}

.sql-result-cell.kind-null {
	color: var(--vscode-descriptionForeground);
	font-style: italic;
}

.sql-result-cell.kind-number {
	text-align: right;
	font-variant-numeric: tabular-nums;
}

.sql-result-cell.kind-blob {
	color: var(--vscode-descriptionForeground);
	font-family: var(--vscode-editor-font-family);
}

.sql-result-cell.kind-text {
	text-align: left;
}

.sql-result-truncated {
	padding: 8px;
	font-size: 12px;
	color: var(--vscode-descriptionForeground);
	border-top: 1px solid var(--vscode-editorGroup-border);
}

.sql-result-statusbar {
	box-sizing: border-box;
	min-height: 24px;
	padding: 4px 8px;
	border-top: 1px solid var(--vscode-editorGroup-border);
	color: var(--vscode-descriptionForeground);
	background: var(--vscode-sideBar-background);
	font-size: 12px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
```

---

# 4. 新增 `src/vs/workbench/contrib/sqlResult/test/sqlResultGridModel.test.ts`

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlCellKind, SqlQueryResult } from '../../../services/sql/common/sqlTypes.js';
import {
	buildSqlResultGrid,
	clampColumnWidth,
	copySelectedCell,
	copySqlResultGrid,
	escapeCsvCell,
	escapeTsvCell,
	formatSqlResultCell,
	getGridCell,
	getSqlResultGridStatus,
	serializeTable,
	SqlResultCopyFormat,
	SqlResultCopyMode
} from '../common/sqlResultGridModel.js';

const sampleResult: SqlQueryResult = {
	columns: [
		{ name: 'id', ordinal: 0 },
		{ name: 'name', ordinal: 1 },
		{ name: 'note', ordinal: 2 }
	],
	rows: [
		[
			{ kind: SqlCellKind.Integer, value: 1 },
			{ kind: SqlCellKind.Text, value: 'Alice' },
			{ kind: SqlCellKind.Text, value: 'hello, "world"' }
		],
		[
			{ kind: SqlCellKind.Integer, value: 2 },
			{ kind: SqlCellKind.Null, value: null },
			{ kind: SqlCellKind.Blob, value: { encoding: 'base64', data: 'AQID', byteLength: 3 } }
		]
	],
	rowCount: 2,
	elapsedMs: 5,
	truncated: false
};

test('buildSqlResultGrid keeps column and cell metadata', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.deepEqual(
		grid.columns.map(column => column.name),
		['id', 'name', 'note']
	);

	assert.equal(grid.rows.length, 2);
	assert.equal(grid.rows[0].cells[0].text, '1');
	assert.equal(grid.rows[0].cells[0].className, 'kind-number');
	assert.equal(grid.rows[1].cells[1].text, 'NULL');
	assert.equal(grid.rows[1].cells[1].isNull, true);
	assert.equal(grid.rows[1].cells[2].text, '[blob 3 bytes]');
	assert.equal(grid.rows[1].cells[2].isBlob, true);
});

test('buildSqlResultGrid marks panel truncation', () => {
	const grid = buildSqlResultGrid(sampleResult, 1);

	assert.equal(grid.renderedRowCount, 1);
	assert.equal(grid.totalRowCount, 2);
	assert.equal(grid.truncatedByPanel, true);
});

test('buildSqlResultGrid rejects invalid maxRows', () => {
	assert.throws(() => buildSqlResultGrid(sampleResult, 0), /maxRows must be a positive integer/);
});

test('formatSqlResultCell formats supported cell kinds', () => {
	assert.equal(formatSqlResultCell({ kind: SqlCellKind.Null, value: null }), 'NULL');
	assert.equal(formatSqlResultCell({ kind: SqlCellKind.Integer, value: 1 }), '1');
	assert.equal(formatSqlResultCell({ kind: SqlCellKind.Real, value: 1.25 }), '1.25');
	assert.equal(formatSqlResultCell({ kind: SqlCellKind.Text, value: 'hello' }), 'hello');
	assert.equal(
		formatSqlResultCell({
			kind: SqlCellKind.Blob,
			value: { encoding: 'base64', data: 'AQID', byteLength: 3 }
		}),
		'[blob 3 bytes]'
	);
});

test('getGridCell returns selected cell', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(getGridCell(grid, { rowIndex: 0, columnIndex: 1 })?.text, 'Alice');
	assert.equal(getGridCell(grid, { rowIndex: 99, columnIndex: 1 }), undefined);
});

test('copySelectedCell copies only selected cell text', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(copySelectedCell(grid, { rowIndex: 0, columnIndex: 1 }), 'Alice');
	assert.equal(copySelectedCell(grid, undefined), '');
});

test('copySqlResultGrid copies selected cell', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(
		copySqlResultGrid(grid, {
			mode: SqlResultCopyMode.Cell,
			format: SqlResultCopyFormat.Tsv,
			selection: { rowIndex: 0, columnIndex: 2 }
		}),
		'hello, "world"'
	);
});

test('copySqlResultGrid copies selected row as TSV with header', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(
		copySqlResultGrid(grid, {
			mode: SqlResultCopyMode.Row,
			format: SqlResultCopyFormat.Tsv,
			selection: { rowIndex: 0, columnIndex: 1 }
		}),
		'id\tname\tnote\n1\tAlice\thello, "world"'
	);
});

test('copySqlResultGrid copies all rows as CSV', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(
		copySqlResultGrid(grid, {
			mode: SqlResultCopyMode.All,
			format: SqlResultCopyFormat.Csv
		}),
		'id,name,note\n1,Alice,"hello, ""world"""\n2,NULL,[blob 3 bytes]'
	);
});

test('serializeTable supports TSV', () => {
	assert.equal(
		serializeTable(
			[
				['a', 'b'],
				['1', 'hello\tworld']
			],
			SqlResultCopyFormat.Tsv
		),
		'a\tb\n1\thello world'
	);
});

test('escapeCsvCell escapes comma quote and newline', () => {
	assert.equal(escapeCsvCell('hello'), 'hello');
	assert.equal(escapeCsvCell('hello, world'), '"hello, world"');
	assert.equal(escapeCsvCell('hello "world"'), '"hello ""world"""');
	assert.equal(escapeCsvCell('hello\nworld'), '"hello\nworld"');
});

test('escapeTsvCell removes tabs and normalizes newlines', () => {
	assert.equal(escapeTsvCell('hello\tworld'), 'hello world');
	assert.equal(escapeTsvCell('hello\r\nworld'), 'hello world');
	assert.equal(escapeTsvCell('hello\rworld'), 'hello world');
});

test('getSqlResultGridStatus describes select result', () => {
	const grid = buildSqlResultGrid(sampleResult);

	assert.equal(getSqlResultGridStatus(sampleResult, grid), '2 row(s) · 3 column(s) · 5ms');
});

test('getSqlResultGridStatus describes affected rows result', () => {
	const result: SqlQueryResult = {
		columns: [],
		rows: [],
		affectedRows: 3,
		rowCount: 0,
		elapsedMs: 8,
		truncated: false
	};

	const grid = buildSqlResultGrid(result);

	assert.equal(getSqlResultGridStatus(result, grid), '3 row(s) affected · 8ms');
});

test('clampColumnWidth clamps invalid and out-of-range width', () => {
	assert.equal(clampColumnWidth(Number.NaN), 160);
	assert.equal(clampColumnWidth(10), 80);
	assert.equal(clampColumnWidth(999), 480);
	assert.equal(clampColumnWidth(200), 200);
});
```

---

# 5. 修改 `package.json`

当前 `test:sql-result` 只跑 `sqlResultModel.test.ts`。

改成：

```json
"test:sql-result": "node --test --import tsx src/vs/workbench/contrib/sqlResult/test/sqlResultModel.test.ts src/vs/workbench/contrib/sqlResult/test/sqlResultGridModel.test.ts"
```

总测试不用改，因为当前 `test` 已经包含 `test:sql-result`。

---

# 6. 验收命令

```bash
pnpm run test:sql-result
pnpm run test
pnpm run lint
pnpm run build
```

手动验收：

```txt
1. 启动应用
2. 添加 SQLite 连接
3. 打开 SQL Editor
4. 执行 SELECT 1 AS id, 'Alice' AS name;
5. SQL Results 展示表格
6. 点击单元格，单元格高亮
7. Copy Cell 能复制单元格
8. Copy Row 能复制表头 + 当前行 TSV
9. Copy CSV 能复制完整结果 CSV
10. Copy TSV 能复制完整结果 TSV
11. NULL 显示为灰色 italic
12. number 右对齐
13. blob 显示 [blob N bytes]
14. statusbar 显示 row / column / elapsed 信息
```

---

# 7. Phase 7 完成后的效果

完成后结果面板会从：

```txt
简单 HTML table
只有 Copy CSV / Clear
```

变成：

```txt
可选中单元格的 Result Grid
支持 Copy Cell / Copy Row / Copy CSV / Copy TSV
有结果状态栏
有 NULL / number / blob / text 基础展示语义
```

这一步才是“迁移旧 MVP 产品体验”的正确方向。

下一步建议继续做：

```txt
Phase 7.2：Query History & Recent SQL
```

而不是回到多数据库抽象。因为 Result Grid 后，用户马上会需要“刚才执行过什么 SQL、能否重新打开、能否复用”。
