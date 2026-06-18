# Phase 6：Query Result Panel

Phase 6 的目标是把产品闭环打通到：

```txt
SQLite Connection
  -> Open Query
  -> Execute SELECT
  -> Query Result Panel 展示结果
```

当前代码已经具备 Phase 6 的前置条件：

- SQL Service 类型里已经有 `SqlQueryResult / SqlResultColumn / SqlCellValue`，结果结构包含 `columns / rows / affectedRows / rowCount / elapsedMs / truncated`。
- Phase 5 已经有 `ISqlEditorEventService`，并且明确写了 “Phase 6 Result Panel will subscribe to this service”。
- 当前 Workbench 已经在 common main 中加载 SQL Service、SQL Connections、SQL Editor contribution。
- `ViewContainerLocation.Panel` 在当前 fork 里存在，可以把 SQL Results 注册到底部 Panel 区域。
- 目前测试链路已经有 `test:sql-services / test:sql-connections / test:sql-editor`，Phase 6 需要新增 `test:sql-result` 并接入总测试。

---

# Phase 6 边界

本阶段做：

```txt
1. 注册 SQL Results Panel
2. 新增 SqlResultService，保存最近一次 query 状态
3. 新增 Bridge contribution，订阅 SqlEditorEventService
4. Query started -> Panel 显示 Running
5. Query completed -> Panel 显示表格
6. Query failed -> Panel 显示错误
7. 支持 NULL / number / text / blob 基础展示
8. 支持 clear
9. 单元测试覆盖结果模型和格式化
```

本阶段不做：

```txt
1. 虚拟滚动
2. AG Grid
3. CSV 下载文件
4. 多结果集
5. Query History
6. Explain Plan
7. 图表
8. 编辑表格
```

---

# 文件结构

新增：

```txt
src/vs/workbench/contrib/sqlResult/
├─ common/
│  ├─ sqlResult.ts
│  ├─ sqlResultModel.ts
│  └─ sqlResultService.ts
├─ browser/
│  ├─ sqlResult.contribution.ts
│  ├─ sqlResultBridge.ts
│  ├─ sqlResultView.ts
│  └─ media/
│     └─ sqlResult.css
└─ test/
   └─ sqlResultModel.test.ts
```

修改：

```txt
src/vs/workbench/workbench.common.main.ts
package.json
```

---

# 1. `src/vs/workbench/contrib/sqlResult/common/sqlResult.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Result constants.
 *--------------------------------------------------------------------------------------------*/

export const SQL_RESULT_VIEWLET_ID = 'workbench.panel.sqlResults';
export const SQL_RESULT_VIEW_ID = 'sqlStudio.results';
export const SQL_RESULT_STORAGE_ID = 'workbench.sqlResults.views.state';
export const SQL_RESULT_FOCUS_COMMAND_ID = SQL_RESULT_VIEWLET_ID;

export const SQL_RESULT_MAX_RENDER_ROWS = 1_000;
```

---

# 2. `src/vs/workbench/contrib/sqlResult/common/sqlResultModel.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Result pure model helpers.
 *--------------------------------------------------------------------------------------------*/

import { SqlCellKind, SqlCellValue, SqlQueryResult, SqlResultColumn } from '../../../services/sql/common/sqlTypes.js';
import {
	SqlEditorQueryCompletedEvent,
	SqlEditorQueryFailedEvent,
	SqlEditorQueryStartedEvent
} from '../../sqlEditor/common/sqlEditorEvents.js';
import { SQL_RESULT_MAX_RENDER_ROWS } from './sqlResult.js';

export const enum SqlResultStateKind {
	Idle = 'idle',
	Running = 'running',
	Success = 'success',
	Error = 'error'
}

export interface SqlResultQueryInfo {
	editorId: string;
	connectionId: string;
	sql: string;
	startedAt: number;
	completedAt?: number;
}

export interface SqlResultIdleState {
	kind: SqlResultStateKind.Idle;
}

export interface SqlResultRunningState {
	kind: SqlResultStateKind.Running;
	query: SqlResultQueryInfo;
}

export interface SqlResultSuccessState {
	kind: SqlResultStateKind.Success;
	query: SqlResultQueryInfo;
	result: SqlQueryResult;
}

export interface SqlResultErrorState {
	kind: SqlResultStateKind.Error;
	query: SqlResultQueryInfo;
	errorMessage: string;
}

export type SqlResultState = SqlResultIdleState | SqlResultRunningState | SqlResultSuccessState | SqlResultErrorState;

export interface SqlResultDisplayGrid {
	columns: string[];
	rows: string[][];
	renderedRowCount: number;
	totalRowCount: number;
	truncatedByBackend: boolean;
	truncatedByPanel: boolean;
}

export function createIdleSqlResultState(): SqlResultIdleState {
	return {
		kind: SqlResultStateKind.Idle
	};
}

export function createRunningSqlResultState(event: SqlEditorQueryStartedEvent): SqlResultRunningState {
	return {
		kind: SqlResultStateKind.Running,
		query: {
			editorId: event.editorId,
			connectionId: event.connectionId,
			sql: event.sql,
			startedAt: event.startedAt
		}
	};
}

export function createSuccessSqlResultState(event: SqlEditorQueryCompletedEvent): SqlResultSuccessState {
	return {
		kind: SqlResultStateKind.Success,
		query: {
			editorId: event.editorId,
			connectionId: event.connectionId,
			sql: event.sql,
			startedAt: event.startedAt,
			completedAt: event.completedAt
		},
		result: event.result
	};
}

export function createErrorSqlResultState(event: SqlEditorQueryFailedEvent): SqlResultErrorState {
	return {
		kind: SqlResultStateKind.Error,
		query: {
			editorId: event.editorId,
			connectionId: event.connectionId,
			sql: event.sql,
			startedAt: event.startedAt,
			completedAt: event.completedAt
		},
		errorMessage: event.error.message
	};
}

export function getSqlResultSummary(state: SqlResultState): string {
	switch (state.kind) {
		case SqlResultStateKind.Idle:
			return 'Run a SQL query to see results.';

		case SqlResultStateKind.Running:
			return `Running query on ${state.query.connectionId}...`;

		case SqlResultStateKind.Error:
			return `Query failed: ${state.errorMessage}`;

		case SqlResultStateKind.Success:
			if (state.result.columns.length === 0) {
				const affectedRows = state.result.affectedRows ?? 0;
				return `Query completed: ${affectedRows} row(s) affected in ${state.result.elapsedMs}ms.`;
			}

			return `Query completed: ${state.result.rowCount} row(s) in ${state.result.elapsedMs}ms${
				state.result.truncated ? ' · truncated' : ''
			}.`;
	}
}

export function buildSqlResultDisplayGrid(
	result: SqlQueryResult,
	maxRows = SQL_RESULT_MAX_RENDER_ROWS
): SqlResultDisplayGrid {
	const normalizedMaxRows = normalizeMaxRows(maxRows);
	const renderedRows = result.rows.slice(0, normalizedMaxRows);

	return {
		columns: result.columns.map(formatColumnLabel),
		rows: renderedRows.map(row => row.map(formatSqlCellValue)),
		renderedRowCount: renderedRows.length,
		totalRowCount: result.rowCount,
		truncatedByBackend: result.truncated,
		truncatedByPanel: result.rows.length > renderedRows.length
	};
}

export function formatColumnLabel(column: SqlResultColumn): string {
	return column.name || `Column ${column.ordinal + 1}`;
}

export function formatSqlCellValue(cell: SqlCellValue): string {
	if (cell.kind === SqlCellKind.Null || cell.value === null || cell.value === undefined) {
		return 'NULL';
	}

	if (cell.kind === SqlCellKind.Blob) {
		if (typeof cell.value === 'object' && !Array.isArray(cell.value) && 'byteLength' in cell.value) {
			return `[blob ${cell.value.byteLength} bytes]`;
		}

		return '[blob]';
	}

	if (typeof cell.value === 'object') {
		return JSON.stringify(cell.value);
	}

	return String(cell.value);
}

export function sqlResultToCsv(result: SqlQueryResult, maxRows = SQL_RESULT_MAX_RENDER_ROWS): string {
	const grid = buildSqlResultDisplayGrid(result, maxRows);
	const lines = [grid.columns.map(escapeCsvCell).join(','), ...grid.rows.map(row => row.map(escapeCsvCell).join(','))];

	return lines.join('\n');
}

function escapeCsvCell(value: string): string {
	if (!/[",\n\r]/.test(value)) {
		return value;
	}

	return `"${value.replaceAll('"', '""')}"`;
}

function normalizeMaxRows(maxRows: number): number {
	if (!Number.isInteger(maxRows) || maxRows <= 0) {
		throw new Error('maxRows must be a positive integer');
	}

	return maxRows;
}
```

---

# 3. `src/vs/workbench/contrib/sqlResult/common/sqlResultService.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Result service.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	SqlEditorQueryCompletedEvent,
	SqlEditorQueryFailedEvent,
	SqlEditorQueryStartedEvent
} from '../../sqlEditor/common/sqlEditorEvents.js';
import {
	createErrorSqlResultState,
	createIdleSqlResultState,
	createRunningSqlResultState,
	createSuccessSqlResultState,
	SqlResultState
} from './sqlResultModel.js';

export const ISqlResultService = createDecorator<ISqlResultService>('sqlResultService');

export interface ISqlResultService {
	readonly _serviceBrand: undefined;

	readonly state: SqlResultState;
	readonly onDidChangeResult: Event<SqlResultState>;

	setRunning(event: SqlEditorQueryStartedEvent): void;
	setSuccess(event: SqlEditorQueryCompletedEvent): void;
	setError(event: SqlEditorQueryFailedEvent): void;
	clear(): void;
}

export class SqlResultService extends Disposable implements ISqlResultService {
	declare readonly _serviceBrand: undefined;

	private _state: SqlResultState = createIdleSqlResultState();

	private readonly _onDidChangeResult = this._register(new Emitter<SqlResultState>());
	readonly onDidChangeResult = this._onDidChangeResult.event;

	get state(): SqlResultState {
		return this._state;
	}

	setRunning(event: SqlEditorQueryStartedEvent): void {
		this.setState(createRunningSqlResultState(event));
	}

	setSuccess(event: SqlEditorQueryCompletedEvent): void {
		this.setState(createSuccessSqlResultState(event));
	}

	setError(event: SqlEditorQueryFailedEvent): void {
		this.setState(createErrorSqlResultState(event));
	}

	clear(): void {
		this.setState(createIdleSqlResultState());
	}

	private setState(state: SqlResultState): void {
		this._state = state;
		this._onDidChangeResult.fire(state);
	}
}
```

---

# 4. `src/vs/workbench/contrib/sqlResult/browser/sqlResultBridge.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor -> SQL Result bridge.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ISqlEditorEventService } from '../../sqlEditor/common/sqlEditorEvents.js';
import { ISqlResultService } from '../common/sqlResultService.js';

export class SqlResultBridgeContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@ISqlEditorEventService sqlEditorEventService: ISqlEditorEventService,
		@ISqlResultService sqlResultService: ISqlResultService
	) {
		super();

		this._register(sqlEditorEventService.onDidStartQuery(event => sqlResultService.setRunning(event)));
		this._register(sqlEditorEventService.onDidCompleteQuery(event => sqlResultService.setSuccess(event)));
		this._register(sqlEditorEventService.onDidFailQuery(event => sqlResultService.setError(event)));
	}
}
```

---

# 5. `src/vs/workbench/contrib/sqlResult/browser/sqlResultView.ts`

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
```

---

# 6. `src/vs/workbench/contrib/sqlResult/browser/sqlResult.contribution.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Result workbench contribution.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlResult.css';

import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	Extensions as ViewExtensions,
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainer,
	ViewContainerLocation
} from '../../../common/views.js';
import {
	Extensions as WorkbenchExtensions,
	IWorkbenchContributionsRegistry,
	WorkbenchPhase
} from '../../../common/contributions.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import {
	SQL_RESULT_FOCUS_COMMAND_ID,
	SQL_RESULT_STORAGE_ID,
	SQL_RESULT_VIEW_ID,
	SQL_RESULT_VIEWLET_ID
} from '../common/sqlResult.js';
import { ISqlResultService, SqlResultService } from '../common/sqlResultService.js';
import { SqlResultBridgeContribution } from './sqlResultBridge.js';
import { SqlResultView } from './sqlResultView.js';

registerSingleton(ISqlResultService, SqlResultService, InstantiationType.Delayed);

const sqlResultIcon = registerIcon(
	'sql-result-view-icon',
	Codicon.table,
	localize('sqlResultViewIcon', 'View icon of the SQL Results view.')
);

export class SqlResultViewPaneContainer extends ViewPaneContainer {
	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IExtensionService extensionService: IExtensionService,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@ILogService logService: ILogService
	) {
		super(
			SQL_RESULT_VIEWLET_ID,
			{ mergeViewWithContainerWhenSingleView: true },
			instantiationService,
			configurationService,
			layoutService,
			contextMenuService,
			telemetryService,
			extensionService,
			themeService,
			storageService,
			contextService,
			viewDescriptorService,
			logService
		);
	}

	override create(parent: HTMLElement): void {
		super.create(parent);
		parent.classList.add('sql-result-panel');
	}
}

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);

export const SQL_RESULT_VIEW_CONTAINER: ViewContainer = viewContainerRegistry.registerViewContainer(
	{
		id: SQL_RESULT_VIEWLET_ID,
		title: localize2('sqlResults', 'SQL Results'),
		ctorDescriptor: new SyncDescriptor(SqlResultViewPaneContainer),
		storageId: SQL_RESULT_STORAGE_ID,
		icon: sqlResultIcon,
		alwaysUseContainerInfo: true,
		hideIfEmpty: false,
		order: 1,
		openCommandActionDescriptor: {
			id: SQL_RESULT_FOCUS_COMMAND_ID,
			title: localize2('sqlResults', 'SQL Results'),
			mnemonicTitle: localize({ key: 'miViewSqlResults', comment: ['&& denotes a mnemonic'] }, 'SQL &&Results'),
			order: 1
		}
	},
	ViewContainerLocation.Panel
);

const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

viewsRegistry.registerViews(
	[
		{
			id: SQL_RESULT_VIEW_ID,
			name: localize2('sqlResultView', 'Results'),
			containerIcon: sqlResultIcon,
			ctorDescriptor: new SyncDescriptor(SqlResultView),
			order: 0,
			canMoveView: false,
			canToggleVisibility: false,
			focusCommand: {
				id: SQL_RESULT_FOCUS_COMMAND_ID
			}
		}
	],
	SQL_RESULT_VIEW_CONTAINER
);

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution2(
	'workbench.contrib.sqlResultBridge',
	SqlResultBridgeContribution,
	WorkbenchPhase.AfterRestored
);
```

---

# 7. `src/vs/workbench/contrib/sqlResult/browser/media/sqlResult.css`

```css
.sql-result-panel {
	min-height: 0;
}

.sql-result-view {
	box-sizing: border-box;
	height: 100%;
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
}

.sql-result-button:hover:not(:disabled) {
	background: var(--vscode-button-hoverBackground);
}

.sql-result-button:disabled {
	opacity: 0.5;
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
	max-width: 360px;
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

.sql-result-table tbody tr:hover {
	background: var(--vscode-list-hoverBackground);
}

.sql-result-row-number {
	width: 52px;
	max-width: 52px;
	text-align: right;
	color: var(--vscode-descriptionForeground);
	background: var(--vscode-sideBar-background);
}

.sql-result-truncated {
	padding: 8px;
	font-size: 12px;
	color: var(--vscode-descriptionForeground);
	border-top: 1px solid var(--vscode-editorGroup-border);
}
```

---

# 8. 修改 `src/vs/workbench/workbench.common.main.ts`

在 SQL Studio import 区域追加：

```ts
// SQL Studio
import './contrib/sqlConnections/browser/sqlConnections.contribution.js';
import './contrib/sqlEditor/browser/sqlEditor.contribution.js';
import './contrib/sqlResult/browser/sqlResult.contribution.js';
```

---

# 9. 单元测试：`src/vs/workbench/contrib/sqlResult/test/sqlResultModel.test.ts`

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlCellKind, SqlQueryResult } from '../../../services/sql/common/sqlTypes.js';
import {
	buildSqlResultDisplayGrid,
	createErrorSqlResultState,
	createIdleSqlResultState,
	createRunningSqlResultState,
	createSuccessSqlResultState,
	formatColumnLabel,
	formatSqlCellValue,
	getSqlResultSummary,
	sqlResultToCsv,
	SqlResultStateKind
} from '../common/sqlResultModel.js';

const sampleResult: SqlQueryResult = {
	columns: [
		{ name: 'id', ordinal: 0 },
		{ name: 'name', ordinal: 1 }
	],
	rows: [
		[
			{ kind: SqlCellKind.Integer, value: 1 },
			{ kind: SqlCellKind.Text, value: 'Alice' }
		],
		[
			{ kind: SqlCellKind.Integer, value: 2 },
			{ kind: SqlCellKind.Null, value: null }
		]
	],
	rowCount: 2,
	elapsedMs: 3,
	truncated: false
};

test('createIdleSqlResultState returns idle state', () => {
	const state = createIdleSqlResultState();

	assert.equal(state.kind, SqlResultStateKind.Idle);
	assert.equal(getSqlResultSummary(state), 'Run a SQL query to see results.');
});

test('createRunningSqlResultState stores query info', () => {
	const state = createRunningSqlResultState({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT 1',
		startedAt: 10
	});

	assert.equal(state.kind, SqlResultStateKind.Running);
	assert.equal(state.query.editorId, 'query-1');
	assert.equal(state.query.connectionId, 'local');
	assert.equal(getSqlResultSummary(state), 'Running query on local...');
});

test('createSuccessSqlResultState stores result', () => {
	const state = createSuccessSqlResultState({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT * FROM users',
		startedAt: 10,
		completedAt: 20,
		result: sampleResult
	});

	assert.equal(state.kind, SqlResultStateKind.Success);
	assert.equal(state.result.rowCount, 2);
	assert.equal(getSqlResultSummary(state), 'Query completed: 2 row(s) in 3ms.');
});

test('createSuccessSqlResultState summarizes affected rows when there are no columns', () => {
	const state = createSuccessSqlResultState({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'UPDATE users SET name = name',
		startedAt: 10,
		completedAt: 20,
		result: {
			columns: [],
			rows: [],
			affectedRows: 5,
			rowCount: 0,
			elapsedMs: 7,
			truncated: false
		}
	});

	assert.equal(getSqlResultSummary(state), 'Query completed: 5 row(s) affected in 7ms.');
});

test('createErrorSqlResultState stores error message', () => {
	const state = createErrorSqlResultState({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT FROM',
		startedAt: 10,
		completedAt: 20,
		error: new Error('syntax error')
	});

	assert.equal(state.kind, SqlResultStateKind.Error);
	assert.equal(state.errorMessage, 'syntax error');
	assert.equal(getSqlResultSummary(state), 'Query failed: syntax error');
});

test('formatColumnLabel falls back to ordinal label', () => {
	assert.equal(formatColumnLabel({ name: '', ordinal: 0 }), 'Column 1');
	assert.equal(formatColumnLabel({ name: 'name', ordinal: 1 }), 'name');
});

test('formatSqlCellValue formats primitive values', () => {
	assert.equal(formatSqlCellValue({ kind: SqlCellKind.Null, value: null }), 'NULL');
	assert.equal(formatSqlCellValue({ kind: SqlCellKind.Integer, value: 1 }), '1');
	assert.equal(formatSqlCellValue({ kind: SqlCellKind.Real, value: 1.5 }), '1.5');
	assert.equal(formatSqlCellValue({ kind: SqlCellKind.Text, value: 'Alice' }), 'Alice');
});

test('formatSqlCellValue formats blob values', () => {
	assert.equal(
		formatSqlCellValue({
			kind: SqlCellKind.Blob,
			value: {
				encoding: 'base64',
				data: 'AQID',
				byteLength: 3
			}
		}),
		'[blob 3 bytes]'
	);
});

test('buildSqlResultDisplayGrid builds display grid', () => {
	const grid = buildSqlResultDisplayGrid(sampleResult);

	assert.deepEqual(grid.columns, ['id', 'name']);
	assert.deepEqual(grid.rows, [
		['1', 'Alice'],
		['2', 'NULL']
	]);
	assert.equal(grid.renderedRowCount, 2);
	assert.equal(grid.totalRowCount, 2);
	assert.equal(grid.truncatedByBackend, false);
	assert.equal(grid.truncatedByPanel, false);
});

test('buildSqlResultDisplayGrid marks panel truncation', () => {
	const grid = buildSqlResultDisplayGrid(sampleResult, 1);

	assert.equal(grid.renderedRowCount, 1);
	assert.equal(grid.totalRowCount, 2);
	assert.equal(grid.truncatedByPanel, true);
});

test('buildSqlResultDisplayGrid rejects invalid maxRows', () => {
	assert.throws(() => buildSqlResultDisplayGrid(sampleResult, 0), /maxRows must be a positive integer/);
});

test('sqlResultToCsv escapes CSV cells', () => {
	const result: SqlQueryResult = {
		columns: [
			{ name: 'id', ordinal: 0 },
			{ name: 'text', ordinal: 1 }
		],
		rows: [
			[
				{ kind: SqlCellKind.Integer, value: 1 },
				{ kind: SqlCellKind.Text, value: 'hello, "world"' }
			]
		],
		rowCount: 1,
		elapsedMs: 1,
		truncated: false
	};

	assert.equal(sqlResultToCsv(result), 'id,text\n1,"hello, ""world"""');
});
```

---

# 10. 修改 `package.json`

新增脚本：

```json
{
	"scripts": {
		"test:sql-result": "node --test --import tsx src/vs/workbench/contrib/sqlResult/test/sqlResultModel.test.ts"
	}
}
```

把总测试改成：

```json
{
	"scripts": {
		"test": "pnpm run test:branding && pnpm run test:rust && pnpm run test:sql-services && pnpm run test:sql-connections && pnpm run test:sql-editor && pnpm run test:sql-result"
	}
}
```

---

# 验收命令

```bash
pnpm run test:sql-result
pnpm run test
pnpm run lint
pnpm run build
```

手动验收：

```txt
1. pnpm tauri dev
2. 添加 SQLite 连接
3. 打开 SQL Query
4. 执行 SELECT 1 AS value;
5. 打开 SQL Results Panel
6. 看到 value / 1 的表格结果
7. 执行错误 SQL
8. SQL Results Panel 显示错误信息
9. 执行 UPDATE/CREATE TABLE
10. SQL Results Panel 显示 affected rows
```

---

# Phase 6 完成后的状态

完成后产品闭环变成：

```txt
Phase 2：Rust SQL command bridge
Phase 3：Workbench SQL services
Phase 4：SQL Connections Activity
Phase 4.5：Connection Tree -> SQL Editor
Phase 5：SQL EditorInput / SQL EditorPane
Phase 6：Query Result Panel
```

这时 MVP 的核心路径已经成立：

```txt
添加 SQLite
  -> 展开表
  -> SELECT Top 100
  -> SQL Editor
  -> Execute
  -> SQL Results Panel
```

下一步建议做：

```txt
Phase 6.5：连接持久化
```

原因是当前连接还只是内存态。Result Panel 做完后，用户每次重启都要重新添加 SQLite，会明显影响产品体验。先做连接持久化，再考虑 MySQL/Postgres、Result Grid 虚拟滚动、AI Agent。
