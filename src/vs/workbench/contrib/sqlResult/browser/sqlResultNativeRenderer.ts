/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Native SQL Result renderer.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { SQL_RESULT_NATIVE_RENDERER_ID, SqlResultRendererId } from '../common/sqlResultRenderer.js';
import { SqlResultGrid } from '../common/sqlResultGridModel.js';

export interface SqlResultSuccessGridRendererRequest {
	readonly container: HTMLElement;
	readonly grid: SqlResultGrid;
	readonly onGridActivation: (event: Event) => void;
}

export interface SqlResultSuccessGridRendererResult {
	readonly wrapper: HTMLElement;
	readonly disposable: IDisposable;
}

export interface ISqlResultSuccessGridRenderer {
	readonly id: SqlResultRendererId;

	render(request: SqlResultSuccessGridRendererRequest): SqlResultSuccessGridRendererResult;
}

/**
 * Owns only the native success-grid DOM. Result state, selection and copy
 * actions remain in SqlResultView so another renderer can be substituted
 * without changing those contracts.
 */
export class SqlResultNativeRendererAdapter implements ISqlResultSuccessGridRenderer {
	readonly id = SQL_RESULT_NATIVE_RENDERER_ID;

	render(request: SqlResultSuccessGridRendererRequest): SqlResultSuccessGridRendererResult {
		const disposables = new DisposableStore();
		const { grid } = request;
		const wrapper = append(request.container, $('.sql-result-table-wrapper', { tabIndex: 0 }));
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

		disposables.add(addDisposableListener(wrapper, EventType.CLICK, request.onGridActivation));
		disposables.add(
			addDisposableListener(wrapper, EventType.KEY_DOWN, event => {
				if (event.key === 'Enter' || event.key === ' ') {
					request.onGridActivation(event);
					event.preventDefault();
				}
			})
		);

		if (grid.truncatedByPanel || grid.truncatedByBackend) {
			const message = grid.truncatedByPanel
				? `Showing first ${grid.renderedRowCount} of ${grid.sourceRowCount} loaded row(s).`
				: `Backend truncated result at ${grid.totalRowCount} row(s).`;

			append(request.container, $('.sql-result-truncated', undefined, message));
		}

		return { wrapper, disposable: disposables };
	}
}
