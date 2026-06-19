下面是 **Phase 7.2：Query History & Recent SQL** 的详细设计与完整代码。

这版基于当前已有事件链路实现：`SqlEditorPane.executeQuery()` 已经在执行开始、成功、失败时发出 `SqlEditorEventService` 事件；Result Panel 也是通过 `SqlResultBridgeContribution` 订阅这些事件更新结果。
所以 Phase 7.2 不需要改 SQL 执行链路，只需要新增 Query History Service + Bridge + View。

---

# Phase 7.2：Query History & Recent SQL

## 目标

```txt id="4t67ka"
记录最近执行过的 SQL
支持查看历史
支持 Open in Editor
支持 Rerun
支持 Remove
支持 Clear History
本地持久化
```

## 本阶段不做

```txt id="ua56lg"
不做云同步
不做复杂搜索
不做 AI 总结
不做收藏夹
不做多数据库
不做 SQL 格式化
```

---

# 文件变化

新增：

```txt id="t23ahh"
src/vs/workbench/contrib/sqlHistory/common/sqlQueryHistory.ts
src/vs/workbench/contrib/sqlHistory/common/sqlQueryHistoryModel.ts
src/vs/workbench/contrib/sqlHistory/common/sqlQueryHistoryService.ts
src/vs/workbench/contrib/sqlHistory/browser/sqlQueryHistoryBridge.ts
src/vs/workbench/contrib/sqlHistory/browser/sqlQueryHistoryView.ts
src/vs/workbench/contrib/sqlHistory/browser/media/sqlQueryHistory.css
src/vs/workbench/contrib/sqlHistory/test/sqlQueryHistoryModel.test.ts
src/vs/workbench/contrib/sqlHistory/test/sqlQueryHistoryService.test.ts
```

修改：

```txt id="yv29gh"
src/vs/workbench/contrib/sqlResult/browser/sqlResult.contribution.ts
package.json
```

设计上把 History View 放到现有 SQL Results Panel 里，和 Results View 同一个 Panel Container。当前 SQL Results contribution 已经注册了 `SQL_RESULT_VIEW_CONTAINER` 和 Results view，可以在这里继续注册 History view。

---

# 1. 新增 `sqlQueryHistory.ts`

路径：

```txt id="p28hzf"
src/vs/workbench/contrib/sqlHistory/common/sqlQueryHistory.ts
```

```ts id="8guet6"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Query History constants.
 *--------------------------------------------------------------------------------------------*/

export const SQL_QUERY_HISTORY_VIEW_ID = 'sqlStudio.queryHistory';
export const SQL_QUERY_HISTORY_STORAGE_KEY = 'workbench.sqlStudio.queryHistory.entries';

export const SQL_QUERY_HISTORY_MAX_ENTRIES = 100;
export const SQL_QUERY_HISTORY_SQL_PREVIEW_LENGTH = 160;
```

---

# 2. 新增 `sqlQueryHistoryModel.ts`

路径：

```txt id="ez8my7"
src/vs/workbench/contrib/sqlHistory/common/sqlQueryHistoryModel.ts
```

```ts id="37r13y"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Query History model.
 *--------------------------------------------------------------------------------------------*/

import {
	SqlEditorQueryCompletedEvent,
	SqlEditorQueryFailedEvent
} from '../../sqlEditor/common/sqlEditorEvents.js';
import {
	SQL_QUERY_HISTORY_MAX_ENTRIES,
	SQL_QUERY_HISTORY_SQL_PREVIEW_LENGTH
} from './sqlQueryHistory.js';

export const enum SqlQueryHistoryStatus {
	Success = 'success',
	Error = 'error'
}

export interface SqlQueryHistoryEntry {
	readonly id: string;
	readonly editorId: string;
	readonly connectionId: string;
	readonly sql: string;
	readonly sqlPreview: string;
	readonly status: SqlQueryHistoryStatus;
	readonly startedAt: number;
	readonly completedAt: number;
	readonly durationMs: number;
	readonly rowCount?: number;
	readonly affectedRows?: number;
	readonly elapsedMs?: number;
	readonly errorMessage?: string;
}

export interface SerializedSqlQueryHistoryDocument {
	readonly version: 1;
	readonly entries: SqlQueryHistoryEntry[];
}

export function createCompletedQueryHistoryEntry(event: SqlEditorQueryCompletedEvent): SqlQueryHistoryEntry {
	const sql = normalizeSql(event.sql);
	const completedAt = normalizeTimestamp(event.completedAt);
	const startedAt = normalizeTimestamp(event.startedAt);

	return {
		id: createHistoryEntryId(event.editorId, event.connectionId, completedAt, sql),
		editorId: event.editorId,
		connectionId: event.connectionId,
		sql,
		sqlPreview: createSqlPreview(sql),
		status: SqlQueryHistoryStatus.Success,
		startedAt,
		completedAt,
		durationMs: Math.max(0, completedAt - startedAt),
		rowCount: event.result.rowCount,
		affectedRows: event.result.affectedRows,
		elapsedMs: event.result.elapsedMs
	};
}

export function createFailedQueryHistoryEntry(event: SqlEditorQueryFailedEvent): SqlQueryHistoryEntry {
	const sql = normalizeSql(event.sql);
	const completedAt = normalizeTimestamp(event.completedAt);
	const startedAt = normalizeTimestamp(event.startedAt);

	return {
		id: createHistoryEntryId(event.editorId, event.connectionId, completedAt, sql),
		editorId: event.editorId,
		connectionId: event.connectionId,
		sql,
		sqlPreview: createSqlPreview(sql),
		status: SqlQueryHistoryStatus.Error,
		startedAt,
		completedAt,
		durationMs: Math.max(0, completedAt - startedAt),
		errorMessage: event.error.message || String(event.error)
	};
}

export function normalizeHistoryEntries(
	entries: readonly SqlQueryHistoryEntry[],
	maxEntries = SQL_QUERY_HISTORY_MAX_ENTRIES
): SqlQueryHistoryEntry[] {
	if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
		throw new Error('maxEntries must be a positive integer');
	}

	const seen = new Set<string>();
	const normalized: SqlQueryHistoryEntry[] = [];

	for (const entry of entries) {
		const valid = normalizeHistoryEntry(entry);

		if (!valid) {
			continue;
		}

		if (seen.has(valid.id)) {
			continue;
		}

		seen.add(valid.id);
		normalized.push(valid);

		if (normalized.length >= maxEntries) {
			break;
		}
	}

	return normalized;
}

export function serializeHistory(entries: readonly SqlQueryHistoryEntry[]): SerializedSqlQueryHistoryDocument {
	return {
		version: 1,
		entries: normalizeHistoryEntries(entries)
	};
}

export function deserializeHistory(raw: unknown): SqlQueryHistoryEntry[] {
	if (!raw || typeof raw !== 'object') {
		return [];
	}

	const document = raw as Partial<SerializedSqlQueryHistoryDocument>;

	if (document.version !== 1 || !Array.isArray(document.entries)) {
		return [];
	}

	return normalizeHistoryEntries(document.entries);
}

export function addHistoryEntry(
	entries: readonly SqlQueryHistoryEntry[],
	entry: SqlQueryHistoryEntry,
	maxEntries = SQL_QUERY_HISTORY_MAX_ENTRIES
): SqlQueryHistoryEntry[] {
	const normalized = normalizeHistoryEntry(entry);

	if (!normalized) {
		return normalizeHistoryEntries(entries, maxEntries);
	}

	return normalizeHistoryEntries([normalized, ...entries], maxEntries);
}

export function removeHistoryEntry(
	entries: readonly SqlQueryHistoryEntry[],
	entryId: string
): SqlQueryHistoryEntry[] {
	const normalizedId = entryId.trim();

	if (!normalizedId) {
		return [...entries];
	}

	return entries.filter(entry => entry.id !== normalizedId);
}

export function createSqlPreview(sql: string, maxLength = SQL_QUERY_HISTORY_SQL_PREVIEW_LENGTH): string {
	const normalized = normalizeSql(sql).replace(/\s+/g, ' ');

	if (normalized.length <= maxLength) {
		return normalized;
	}

	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function getHistoryEntryLabel(entry: SqlQueryHistoryEntry): string {
	const status = entry.status === SqlQueryHistoryStatus.Success ? 'OK' : 'ERR';
	return `${status} · ${entry.connectionId} · ${entry.sqlPreview}`;
}

export function getHistoryEntryDetail(entry: SqlQueryHistoryEntry): string {
	if (entry.status === SqlQueryHistoryStatus.Error) {
		return `${entry.durationMs}ms · ${entry.errorMessage ?? 'Query failed'}`;
	}

	const rowText = entry.rowCount === 1 ? '1 row' : `${entry.rowCount ?? 0} rows`;
	const elapsed = entry.elapsedMs ?? entry.durationMs;

	return `${rowText} · ${elapsed}ms`;
}

export function normalizeSql(sql: string): string {
	if (typeof sql !== 'string') {
		return '';
	}

	return sql.trim();
}

function normalizeHistoryEntry(entry: SqlQueryHistoryEntry): SqlQueryHistoryEntry | undefined {
	if (!entry || typeof entry !== 'object') {
		return undefined;
	}

	const id = entry.id?.trim();
	const editorId = entry.editorId?.trim();
	const connectionId = entry.connectionId?.trim();
	const sql = normalizeSql(entry.sql);

	if (!id || !editorId || !connectionId || !sql) {
		return undefined;
	}

	const completedAt = normalizeTimestamp(entry.completedAt);
	const startedAt = normalizeTimestamp(entry.startedAt);

	return {
		id,
		editorId,
		connectionId,
		sql,
		sqlPreview: createSqlPreview(sql),
		status: entry.status === SqlQueryHistoryStatus.Error
			? SqlQueryHistoryStatus.Error
			: SqlQueryHistoryStatus.Success,
		startedAt,
		completedAt,
		durationMs: Math.max(0, entry.durationMs ?? completedAt - startedAt),
		rowCount: normalizeOptionalNumber(entry.rowCount),
		affectedRows: normalizeOptionalNumber(entry.affectedRows),
		elapsedMs: normalizeOptionalNumber(entry.elapsedMs),
		errorMessage: normalizeOptionalString(entry.errorMessage)
	};
}

function normalizeOptionalNumber(value: number | undefined): number | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}

	return Number.isFinite(value) ? value : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function normalizeTimestamp(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : Date.now();
}

function createHistoryEntryId(editorId: string, connectionId: string, completedAt: number, sql: string): string {
	return `${completedAt}-${hashString(`${editorId}:${connectionId}:${sql}`)}`;
}

function hashString(value: string): string {
	let hash = 0;

	for (let index = 0; index < value.length; index++) {
		hash = (hash * 31 + value.charCodeAt(index)) | 0;
	}

	return Math.abs(hash).toString(36);
}
```

---

# 3. 新增 `sqlQueryHistoryService.ts`

路径：

```txt id="m7azuh"
src/vs/workbench/contrib/sqlHistory/common/sqlQueryHistoryService.ts
```

```ts id="2q9ldx"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Query History service.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	IStorageService,
	StorageScope,
	StorageTarget
} from '../../../../platform/storage/common/storage.js';
import {
	SqlEditorQueryCompletedEvent,
	SqlEditorQueryFailedEvent
} from '../../sqlEditor/common/sqlEditorEvents.js';
import { SQL_QUERY_HISTORY_MAX_ENTRIES, SQL_QUERY_HISTORY_STORAGE_KEY } from './sqlQueryHistory.js';
import {
	addHistoryEntry,
	createCompletedQueryHistoryEntry,
	createFailedQueryHistoryEntry,
	deserializeHistory,
	removeHistoryEntry,
	serializeHistory,
	SqlQueryHistoryEntry
} from './sqlQueryHistoryModel.js';

export const ISqlQueryHistoryService = createDecorator<ISqlQueryHistoryService>('sqlQueryHistoryService');

export interface ISqlQueryHistoryService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeHistory: Event<readonly SqlQueryHistoryEntry[]>;

	readonly entries: readonly SqlQueryHistoryEntry[];

	addCompletedQuery(event: SqlEditorQueryCompletedEvent): void;
	addFailedQuery(event: SqlEditorQueryFailedEvent): void;
	remove(entryId: string): void;
	clear(): void;
}

export class SqlQueryHistoryService extends Disposable implements ISqlQueryHistoryService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeHistory = this._register(new Emitter<readonly SqlQueryHistoryEntry[]>());
	readonly onDidChangeHistory = this._onDidChangeHistory.event;

	private _entries: SqlQueryHistoryEntry[];

	constructor(
		@IStorageService private readonly storageService: IStorageService
	) {
		super();

		this._entries = this.load();
	}

	get entries(): readonly SqlQueryHistoryEntry[] {
		return this._entries;
	}

	addCompletedQuery(event: SqlEditorQueryCompletedEvent): void {
		const entry = createCompletedQueryHistoryEntry(event);
		this.setEntries(addHistoryEntry(this._entries, entry, SQL_QUERY_HISTORY_MAX_ENTRIES));
	}

	addFailedQuery(event: SqlEditorQueryFailedEvent): void {
		const entry = createFailedQueryHistoryEntry(event);
		this.setEntries(addHistoryEntry(this._entries, entry, SQL_QUERY_HISTORY_MAX_ENTRIES));
	}

	remove(entryId: string): void {
		this.setEntries(removeHistoryEntry(this._entries, entryId));
	}

	clear(): void {
		this.setEntries([]);
	}

	private load(): SqlQueryHistoryEntry[] {
		const raw = this.storageService.getObject<unknown>(
			SQL_QUERY_HISTORY_STORAGE_KEY,
			StorageScope.PROFILE,
			undefined
		);

		return deserializeHistory(raw);
	}

	private setEntries(entries: SqlQueryHistoryEntry[]): void {
		this._entries = entries;
		this.persist();
		this._onDidChangeHistory.fire(this._entries);
	}

	private persist(): void {
		this.storageService.store(
			SQL_QUERY_HISTORY_STORAGE_KEY,
			JSON.stringify(serializeHistory(this._entries)),
			StorageScope.PROFILE,
			StorageTarget.USER
		);
	}
}
```

> 这里使用 `StorageScope.PROFILE` + `StorageTarget.USER`。`IStorageService` 支持 `getObject()`、`store()` 和 `StorageScope.PROFILE`。

---

# 4. 新增 History Bridge

路径：

```txt id="7rpr1f"
src/vs/workbench/contrib/sqlHistory/browser/sqlQueryHistoryBridge.ts
```

```ts id="3570xl"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor -> SQL Query History bridge.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ISqlEditorEventService } from '../../sqlEditor/common/sqlEditorEvents.js';
import { ISqlQueryHistoryService } from '../common/sqlQueryHistoryService.js';

export class SqlQueryHistoryBridgeContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@ISqlEditorEventService sqlEditorEventService: ISqlEditorEventService,
		@ISqlQueryHistoryService sqlQueryHistoryService: ISqlQueryHistoryService
	) {
		super();

		this._register(sqlEditorEventService.onDidCompleteQuery(event => sqlQueryHistoryService.addCompletedQuery(event)));
		this._register(sqlEditorEventService.onDidFailQuery(event => sqlQueryHistoryService.addFailedQuery(event)));
	}
}
```

---

# 5. 新增 History View

路径：

```txt id="8fqlm5"
src/vs/workbench/contrib/sqlHistory/browser/sqlQueryHistoryView.ts
```

```ts id="h7uvzr"
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
```

---

# 6. 新增 CSS

路径：

```txt id="7kxihq"
src/vs/workbench/contrib/sqlHistory/browser/media/sqlQueryHistory.css
```

```css id="a0evxs"
.sql-query-history-view {
	box-sizing: border-box;
	height: 100%;
	width: 100%;
	display: flex;
	flex-direction: column;
	overflow: hidden;
	background: var(--vscode-editor-background);
	color: var(--vscode-editor-foreground);
}

.sql-query-history-toolbar {
	box-sizing: border-box;
	min-height: 32px;
	display: flex;
	align-items: center;
	justify-content: flex-end;
	gap: 8px;
	padding: 4px 8px;
	border-bottom: 1px solid var(--vscode-editorGroup-border);
	background: var(--vscode-sideBar-background);
}

.sql-query-history-content {
	flex: 1 1 auto;
	min-height: 0;
	overflow: auto;
	outline: none;
}

.sql-query-history-empty {
	padding: 12px;
	font-size: 12px;
	color: var(--vscode-descriptionForeground);
}

.sql-query-history-list {
	display: flex;
	flex-direction: column;
}

.sql-query-history-item {
	box-sizing: border-box;
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px;
	border-bottom: 1px solid var(--vscode-editorGroup-border);
}

.sql-query-history-item:hover {
	background: var(--vscode-list-hoverBackground);
}

.sql-query-history-item.success {
	border-left: 3px solid var(--vscode-testing-iconPassed, #73c991);
}

.sql-query-history-item.error {
	border-left: 3px solid var(--vscode-testing-iconFailed, #f14c4c);
}

.sql-query-history-main {
	flex: 1 1 auto;
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.sql-query-history-title {
	font-size: 12px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.sql-query-history-detail {
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.sql-query-history-actions {
	flex: 0 0 auto;
	display: flex;
	align-items: center;
	gap: 6px;
}

.sql-query-history-button {
	height: 24px;
	padding: 0 10px;
	border: 1px solid var(--vscode-button-border);
	color: var(--vscode-button-secondaryForeground);
	background: var(--vscode-button-secondaryBackground);
	cursor: pointer;
	font-size: 12px;
}

.sql-query-history-button:hover:not(:disabled) {
	background: var(--vscode-button-hoverBackground);
}

.sql-query-history-button:disabled {
	opacity: 0.45;
	cursor: default;
}

.sql-query-history-statusbar {
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

# 7. 修改 `sqlResult.contribution.ts`

路径：

```txt id="umm76x"
src/vs/workbench/contrib/sqlResult/browser/sqlResult.contribution.ts
```

在现有文件基础上修改。

## 7.1 增加 imports

在已有 imports 里追加：

```ts id="1di8w9"
import '../../sqlHistory/browser/media/sqlQueryHistory.css';
import { ISqlQueryHistoryService, SqlQueryHistoryService } from '../../sqlHistory/common/sqlQueryHistoryService.js';
import { SqlQueryHistoryBridgeContribution } from '../../sqlHistory/browser/sqlQueryHistoryBridge.js';
import { SqlQueryHistoryView } from '../../sqlHistory/browser/sqlQueryHistoryView.js';
```

## 7.2 注册 service

在现有：

```ts id="tb0gma"
registerSingleton(ISqlResultService, SqlResultService, InstantiationType.Delayed);
```

后面追加：

```ts id="7mg7fl"
registerSingleton(ISqlQueryHistoryService, SqlQueryHistoryService, InstantiationType.Delayed);
```

## 7.3 注册 History View

把现有 `viewsRegistry.registerViews([...], SQL_RESULT_VIEW_CONTAINER);` 替换成：

```ts id="dm9bga"
viewsRegistry.registerViews(
	[
		{
			id: SQL_RESULT_VIEW_ID,
			name: localize2('sqlResultView', 'Results'),
			containerIcon: sqlResultIcon,
			ctorDescriptor: new SyncDescriptor(SqlResultView),
			order: 0,
			canMoveView: false,
			canToggleVisibility: false
		},
		{
			id: SqlQueryHistoryView.ID,
			name: localize2('sqlQueryHistoryView', 'Query History'),
			containerIcon: sqlResultIcon,
			ctorDescriptor: new SyncDescriptor(SqlQueryHistoryView),
			order: 1,
			canMoveView: false,
			canToggleVisibility: true
		}
	],
	SQL_RESULT_VIEW_CONTAINER
);
```

## 7.4 注册 History Bridge

在现有：

```ts id="xiihz2"
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution2(
	'workbench.contrib.sqlResultBridge',
	SqlResultBridgeContribution,
	WorkbenchPhase.AfterRestored
);
```

后面追加：

```ts id="gybvkn"
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution2(
	'workbench.contrib.sqlQueryHistoryBridge',
	SqlQueryHistoryBridgeContribution,
	WorkbenchPhase.AfterRestored
);
```

---

# 8. 新增 `sqlQueryHistoryModel.test.ts`

路径：

```txt id="f8bpqc"
src/vs/workbench/contrib/sqlHistory/test/sqlQueryHistoryModel.test.ts
```

```ts id="7r3hkg"
import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlCellKind } from '../../../services/sql/common/sqlTypes.js';
import {
	addHistoryEntry,
	createCompletedQueryHistoryEntry,
	createFailedQueryHistoryEntry,
	createSqlPreview,
	deserializeHistory,
	getHistoryEntryDetail,
	getHistoryEntryLabel,
	normalizeHistoryEntries,
	removeHistoryEntry,
	serializeHistory,
	SqlQueryHistoryEntry,
	SqlQueryHistoryStatus
} from '../common/sqlQueryHistoryModel.js';

const completedEvent = {
	editorId: 'editor-1',
	connectionId: 'local',
	sql: 'SELECT 1 AS value;',
	startedAt: 1000,
	completedAt: 1042,
	result: {
		columns: [{ name: 'value', ordinal: 0 }],
		rows: [[{ kind: SqlCellKind.Integer, value: 1 }]],
		rowCount: 1,
		elapsedMs: 12,
		truncated: false
	}
};

const failedEvent = {
	editorId: 'editor-1',
	connectionId: 'local',
	sql: 'SELECT * FROM missing_table;',
	startedAt: 2000,
	completedAt: 2030,
	error: new Error('no such table: missing_table')
};

test('createCompletedQueryHistoryEntry creates success entry', () => {
	const entry = createCompletedQueryHistoryEntry(completedEvent);

	assert.equal(entry.connectionId, 'local');
	assert.equal(entry.sql, 'SELECT 1 AS value;');
	assert.equal(entry.status, SqlQueryHistoryStatus.Success);
	assert.equal(entry.rowCount, 1);
	assert.equal(entry.elapsedMs, 12);
	assert.equal(entry.durationMs, 42);
	assert.ok(entry.id);
});

test('createFailedQueryHistoryEntry creates error entry', () => {
	const entry = createFailedQueryHistoryEntry(failedEvent);

	assert.equal(entry.connectionId, 'local');
	assert.equal(entry.status, SqlQueryHistoryStatus.Error);
	assert.equal(entry.errorMessage, 'no such table: missing_table');
	assert.equal(entry.durationMs, 30);
});

test('createSqlPreview normalizes whitespace and truncates long SQL', () => {
	assert.equal(createSqlPreview(' SELECT   1 \n AS value; '), 'SELECT 1 AS value;');

	const preview = createSqlPreview('SELECT ' + 'x'.repeat(200), 20);
	assert.equal(preview.length, 20);
	assert.ok(preview.endsWith('…'));
});

test('addHistoryEntry prepends and caps entries', () => {
	const first = createCompletedQueryHistoryEntry(completedEvent);
	const second = createFailedQueryHistoryEntry(failedEvent);

	const entries = addHistoryEntry([first], second, 1);

	assert.deepEqual(entries.map(entry => entry.id), [second.id]);
});

test('normalizeHistoryEntries removes duplicate and invalid entries', () => {
	const first = createCompletedQueryHistoryEntry(completedEvent);

	const invalid = {
		...first,
		id: '',
		sql: ''
	} as SqlQueryHistoryEntry;

	const entries = normalizeHistoryEntries([first, first, invalid]);

	assert.deepEqual(entries.map(entry => entry.id), [first.id]);
});

test('removeHistoryEntry removes matching entry', () => {
	const first = createCompletedQueryHistoryEntry(completedEvent);
	const second = createFailedQueryHistoryEntry(failedEvent);

	const entries = removeHistoryEntry([first, second], first.id);

	assert.deepEqual(entries.map(entry => entry.id), [second.id]);
});

test('serializeHistory and deserializeHistory round trip', () => {
	const first = createCompletedQueryHistoryEntry(completedEvent);
	const document = serializeHistory([first]);

	assert.equal(document.version, 1);

	const entries = deserializeHistory(document);

	assert.equal(entries.length, 1);
	assert.equal(entries[0].id, first.id);
	assert.equal(entries[0].sqlPreview, first.sqlPreview);
});

test('deserializeHistory rejects unknown document', () => {
	assert.deepEqual(deserializeHistory(undefined), []);
	assert.deepEqual(deserializeHistory({ version: 999, entries: [] }), []);
	assert.deepEqual(deserializeHistory({ version: 1, entries: 'bad' }), []);
});

test('getHistoryEntryLabel and detail return readable strings', () => {
	const success = createCompletedQueryHistoryEntry(completedEvent);
	const failure = createFailedQueryHistoryEntry(failedEvent);

	assert.ok(getHistoryEntryLabel(success).includes('OK'));
	assert.ok(getHistoryEntryLabel(failure).includes('ERR'));

	assert.equal(getHistoryEntryDetail(success), '1 row · 12ms');
	assert.equal(getHistoryEntryDetail(failure), '30ms · no such table: missing_table');
});
```

---

# 9. 新增 `sqlQueryHistoryService.test.ts`

路径：

```txt id="8u3hao"
src/vs/workbench/contrib/sqlHistory/test/sqlQueryHistoryService.test.ts
```

```ts id="3gmujw"
import assert from 'node:assert/strict';
import test from 'node:test';

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import {
	IStorageService,
	IStorageEntry,
	StorageScope,
	StorageTarget,
	IStorageValueChangeEvent,
	IStorageTargetChangeEvent,
	IWillSaveStateEvent
} from '../../../../platform/storage/common/storage.js';
import { Event } from '../../../../base/common/event.js';
import { SqlCellKind } from '../../../services/sql/common/sqlTypes.js';
import { SQL_QUERY_HISTORY_STORAGE_KEY } from '../common/sqlQueryHistory.js';
import { SqlQueryHistoryService } from '../common/sqlQueryHistoryService.js';

class InMemoryStorageService implements IStorageService {
	declare readonly _serviceBrand: undefined;

	readonly onDidChangeTarget: Event<IStorageTargetChangeEvent> = Event.None;
	readonly onWillSaveState: Event<IWillSaveStateEvent> = Event.None;

	private readonly values = new Map<string, unknown>();

	onDidChangeValue(
		_scope: StorageScope,
		_key: string | undefined,
		_disposable: DisposableStore
	): Event<IStorageValueChangeEvent> {
		return Event.None;
	}

	get(key: string, _scope: StorageScope, fallbackValue?: string): string | undefined {
		const value = this.values.get(key);
		return typeof value === 'string' ? value : fallbackValue;
	}

	getBoolean(key: string, _scope: StorageScope, fallbackValue?: boolean): boolean | undefined {
		const value = this.values.get(key);
		return typeof value === 'boolean' ? value : fallbackValue;
	}

	getNumber(key: string, _scope: StorageScope, fallbackValue?: number): number | undefined {
		const value = this.values.get(key);
		return typeof value === 'number' ? value : fallbackValue;
	}

	getObject<T extends object>(key: string, _scope: StorageScope, fallbackValue?: T): T | undefined {
		const value = this.values.get(key);

		if (typeof value === 'string') {
			return JSON.parse(value) as T;
		}

		return value as T ?? fallbackValue;
	}

	store(key: string, value: unknown, _scope: StorageScope, _target: StorageTarget): void {
		if (value === undefined || value === null) {
			this.values.delete(key);
			return;
		}

		this.values.set(key, value);
	}

	storeAll(entries: IStorageEntry[], _external: boolean): void {
		for (const entry of entries) {
			this.store(entry.key, entry.value, entry.scope, entry.target);
		}
	}

	remove(key: string, _scope: StorageScope): void {
		this.values.delete(key);
	}

	keys(_scope: StorageScope, _target: StorageTarget): string[] {
		return [...this.values.keys()];
	}

	log(): void {}

	hasScope(): boolean {
		return true;
	}

	async switch(): Promise<void> {}
}

function createCompletedEvent(sql = 'SELECT 1 AS value;') {
	return {
		editorId: 'editor-1',
		connectionId: 'local',
		sql,
		startedAt: 1000,
		completedAt: 1042,
		result: {
			columns: [{ name: 'value', ordinal: 0 }],
			rows: [[{ kind: SqlCellKind.Integer, value: 1 }]],
			rowCount: 1,
			elapsedMs: 12,
			truncated: false
		}
	};
}

function createFailedEvent() {
	return {
		editorId: 'editor-1',
		connectionId: 'local',
		sql: 'SELECT * FROM missing_table;',
		startedAt: 2000,
		completedAt: 2030,
		error: new Error('no such table: missing_table')
	};
}

test('SqlQueryHistoryService starts empty', () => {
	const service = new SqlQueryHistoryService(new InMemoryStorageService());

	assert.equal(service.entries.length, 0);
	service.dispose();
});

test('SqlQueryHistoryService records completed query', () => {
	const storage = new InMemoryStorageService();
	const service = new SqlQueryHistoryService(storage);

	service.addCompletedQuery(createCompletedEvent());

	assert.equal(service.entries.length, 1);
	assert.equal(service.entries[0].sql, 'SELECT 1 AS value;');
	assert.equal(service.entries[0].rowCount, 1);

	const stored = storage.getObject<object>(SQL_QUERY_HISTORY_STORAGE_KEY, StorageScope.PROFILE);
	assert.ok(stored);

	service.dispose();
});

test('SqlQueryHistoryService records failed query', () => {
	const service = new SqlQueryHistoryService(new InMemoryStorageService());

	service.addFailedQuery(createFailedEvent());

	assert.equal(service.entries.length, 1);
	assert.equal(service.entries[0].errorMessage, 'no such table: missing_table');

	service.dispose();
});

test('SqlQueryHistoryService fires change events', () => {
	const service = new SqlQueryHistoryService(new InMemoryStorageService());
	let changeCount = 0;

	const disposable = service.onDidChangeHistory(() => {
		changeCount++;
	});

	service.addCompletedQuery(createCompletedEvent());

	assert.equal(changeCount, 1);

	disposable.dispose();
	service.dispose();
});

test('SqlQueryHistoryService removes entry', () => {
	const service = new SqlQueryHistoryService(new InMemoryStorageService());

	service.addCompletedQuery(createCompletedEvent());
	const id = service.entries[0].id;

	service.remove(id);

	assert.equal(service.entries.length, 0);

	service.dispose();
});

test('SqlQueryHistoryService clears entries', () => {
	const service = new SqlQueryHistoryService(new InMemoryStorageService());

	service.addCompletedQuery(createCompletedEvent('SELECT 1;'));
	service.addCompletedQuery(createCompletedEvent('SELECT 2;'));

	assert.equal(service.entries.length, 2);

	service.clear();

	assert.equal(service.entries.length, 0);

	service.dispose();
});

test('SqlQueryHistoryService loads persisted entries', () => {
	const storage = new InMemoryStorageService();
	const first = new SqlQueryHistoryService(storage);

	first.addCompletedQuery(createCompletedEvent());
	first.dispose();

	const second = new SqlQueryHistoryService(storage);

	assert.equal(second.entries.length, 1);
	assert.equal(second.entries[0].sql, 'SELECT 1 AS value;');

	second.dispose();
});
```

---

# 10. 修改 `package.json`

新增测试脚本：

```json id="prhs4v"
{
  "scripts": {
    "test:sql-history": "node --test --import tsx src/vs/workbench/contrib/sqlHistory/test/sqlQueryHistoryModel.test.ts src/vs/workbench/contrib/sqlHistory/test/sqlQueryHistoryService.test.ts"
  }
}
```

总测试链路加入 `test:sql-history`：

```json id="jfv47e"
{
  "scripts": {
    "test": "pnpm run test:branding && pnpm run test:rust && pnpm run test:sql-services && pnpm run test:sql-domain && pnpm run test:sql-connections && pnpm run test:sql-editor && pnpm run test:sql-result && pnpm run test:sql-history"
  }
}
```

---

# 11. 验收命令

```bash id="3lbw9h"
pnpm run test:sql-history
pnpm run test
pnpm run lint
pnpm run build
```

---

# 12. 手动验收

```txt id="sclsy3"
1. 启动应用
2. 添加 SQLite 连接
3. 打开 SQL Editor
4. 执行 SELECT 1 AS value;
5. SQL Results 正常展示
6. 打开 SQL Results Panel 下的 Query History View
7. 能看到刚才的查询
8. 点击 Open，能重新打开 SQL Editor
9. 点击 Rerun，能重新执行查询，并更新 Result Panel
10. 执行错误 SQL，例如 SELECT * FROM missing_table;
11. Query History 中出现错误记录
12. 点击 Clear History，历史清空
13. 重启应用后，历史仍然存在
```

---

# Phase 7.2 完成标准

```txt id="bpb5ph"
查询成功/失败都会入历史
历史本地持久化
History View 可展示记录
Open in Editor 可用
Rerun 可用
Remove 可用
Clear History 可用
测试进入 test 链路
```

下一阶段：

```txt id="8g1qic"
Phase 7.3：SQL Editor UX Enhancement
```
