下面给出 **Phase 7.3：SQL Editor UX Enhancement** 的详细设计与完整代码。
这版严格限定在 SQL Editor 体验增强，不做多数据库、不做 AI、不做真实 SQL formatter，只做 formatter 入口预留。

当前 `SqlEditorPane` 已经有基础 toolbar：连接下拉、Run、Run Selection、status，并且执行成功/失败会通过 `SqlEditorEventService` 发事件。  当前 `SqlEditorInput` 只保存 `id / connectionId / connectionName / initialSql`，还没有 draft 恢复能力。 当前 SQL Editor 命令也只有 New Query / Execute All / Execute Selection。

---

# Phase 7.3：SQL Editor UX Enhancement

## 目标

```txt id="4ci0h3"
1. 当前连接显示更清晰
2. 支持 Execute Current Statement
3. 保留 Execute All / Execute Selection
4. SQL formatter 预留入口
5. SQL 草稿本地持久化
6. 应用恢复后自动恢复最近 query tab
7. 单元测试覆盖 SQL 当前语句识别、draft 持久化、命令模型
```

## 不做

```txt id="assgc5"
1. 不做真实 SQL formatter
2. 不做复杂 SQL parser
3. 不做多数据库
4. 不做 AI
5. 不做错误定位跳转
6. 不做保存到文件
```

---

# 文件变化

新增：

```txt id="zufxwm"
src/vs/workbench/contrib/sqlEditor/common/sqlEditorDraftService.ts
src/vs/workbench/contrib/sqlEditor/browser/sqlEditorDraftRestore.ts
src/vs/workbench/contrib/sqlEditor/test/sqlEditorModel.test.ts
src/vs/workbench/contrib/sqlEditor/test/sqlEditorDraftService.test.ts
```

替换：

```txt id="1gtmqz"
src/vs/workbench/contrib/sqlEditor/common/sqlEditor.ts
src/vs/workbench/contrib/sqlEditor/common/sqlEditorModel.ts
src/vs/workbench/contrib/sqlEditor/browser/sqlEditorPane.ts
src/vs/workbench/contrib/sqlEditor/browser/sqlEditorActions.ts
src/vs/workbench/contrib/sqlEditor/browser/sqlEditor.contribution.ts
src/vs/workbench/contrib/sqlEditor/browser/media/sqlEditor.css
```

修改：

```txt id="z6475t"
package.json
```

---

# 1. 替换 `sqlEditor.ts`

路径：

```txt id="35asdn"
src/vs/workbench/contrib/sqlEditor/common/sqlEditor.ts
```

```ts id="75nu22"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor constants.
 *--------------------------------------------------------------------------------------------*/

export const SQL_EDITOR_INPUT_TYPE_ID = 'workbench.input.sqlStudio.query';
export const SQL_EDITOR_PANE_ID = 'workbench.editor.sqlStudio.query';

export const SQL_EDITOR_SCHEME = 'sqlstudio-query';

export const SQL_NEW_QUERY_COMMAND_ID = 'sql.newQuery';
export const SQL_EXECUTE_QUERY_COMMAND_ID = 'sql.executeQuery';
export const SQL_EXECUTE_SELECTION_COMMAND_ID = 'sql.executeSelection';
export const SQL_EXECUTE_CURRENT_STATEMENT_COMMAND_ID = 'sql.executeCurrentStatement';
export const SQL_FORMAT_QUERY_COMMAND_ID = 'sql.formatQuery';

export const SQL_EDITOR_DEFAULT_QUERY = `-- SQL Studio Query
SELECT 1 AS value;
`;

export const SQL_EDITOR_DRAFT_STORAGE_KEY = 'workbench.sqlStudio.editorDrafts';
export const SQL_EDITOR_MAX_RESTORED_DRAFTS = 20;
```

---

# 2. 替换 `sqlEditorModel.ts`

路径：

```txt id="0qgmuz"
src/vs/workbench/contrib/sqlEditor/common/sqlEditorModel.ts
```

```ts id="o156oj"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor pure model helpers.
 *--------------------------------------------------------------------------------------------*/

export interface SqlEditorOptions {
	id?: string;
	connectionId?: string;
	connectionName?: string;
	initialSql?: string;
}

export interface NormalizedSqlEditorOptions {
	id: string;
	connectionId?: string;
	connectionName?: string;
	initialSql: string;
}

export const enum SqlEditorExecutionSource {
	All = 'all',
	Selection = 'selection',
	Statement = 'statement'
}

export interface SqlEditorExecutePayload {
	connectionId: string;
	sql: string;
	source: SqlEditorExecutionSource;
}

export interface SqlStatementRange {
	readonly start: number;
	readonly end: number;
	readonly sql: string;
}

export function normalizeSqlEditorOptions(
	options: SqlEditorOptions,
	defaultSql: string,
	createId: () => string
): NormalizedSqlEditorOptions {
	const id = normalizeOptionalString(options.id) ?? createId();
	const connectionId = normalizeOptionalString(options.connectionId);
	const connectionName = normalizeOptionalString(options.connectionName);
	const initialSql = options.initialSql ?? defaultSql;

	return {
		id,
		connectionId,
		connectionName,
		initialSql
	};
}

export function getSqlEditorName(connectionName?: string): string {
	return connectionName ? `SQL Query · ${connectionName}` : 'SQL Query';
}

export function getSqlEditorDescription(connectionId?: string): string | undefined {
	return connectionId ? `Connection: ${connectionId}` : 'No connection selected';
}

export function normalizeExecutableSql(sql: string): string {
	return sql.trim();
}

export function createExecutePayload(
	connectionId: string | undefined,
	sql: string,
	source: SqlEditorExecutionSource
): SqlEditorExecutePayload {
	const normalizedConnectionId = normalizeOptionalString(connectionId);
	if (!normalizedConnectionId) {
		throw new Error('No SQL connection selected.');
	}

	const normalizedSql = normalizeExecutableSql(sql);
	if (!normalizedSql) {
		throw new Error('SQL is empty.');
	}

	return {
		connectionId: normalizedConnectionId,
		sql: normalizedSql,
		source
	};
}

export function findSqlStatementAtOffset(sql: string, offset: number): SqlStatementRange {
	if (typeof sql !== 'string') {
		throw new Error('sql must be a string');
	}

	const clampedOffset = clampOffset(offset, sql.length);
	const boundaries = findStatementBoundaries(sql);

	let start = 0;
	let end = sql.length;

	for (const boundary of boundaries) {
		if (boundary < clampedOffset) {
			start = boundary + 1;
			continue;
		}

		end = boundary;
		break;
	}

	return trimStatementRange(sql, start, end);
}

export function getSqlEditorStatusLabel(options: {
	readonly connectionId?: string;
	readonly connectionName?: string;
	readonly dirty?: boolean;
	readonly running?: boolean;
}): string {
	const connection = options.connectionName ?? options.connectionId ?? 'No connection';
	const state = options.running ? 'Running' : options.dirty ? 'Draft saved' : 'Ready';

	return `${state} · ${connection}`;
}

export function createFormatterPlaceholderResult(sql: string): string {
	return sql;
}

function findStatementBoundaries(sql: string): number[] {
	const boundaries: number[] = [];

	let inSingleQuote = false;
	let inDoubleQuote = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let index = 0; index < sql.length; index++) {
		const char = sql[index];
		const next = sql[index + 1];

		if (inLineComment) {
			if (char === '\n') {
				inLineComment = false;
			}
			continue;
		}

		if (inBlockComment) {
			if (char === '*' && next === '/') {
				inBlockComment = false;
				index++;
			}
			continue;
		}

		if (inSingleQuote) {
			if (char === "'" && next === "'") {
				index++;
				continue;
			}

			if (char === "'") {
				inSingleQuote = false;
			}

			continue;
		}

		if (inDoubleQuote) {
			if (char === '"' && next === '"') {
				index++;
				continue;
			}

			if (char === '"') {
				inDoubleQuote = false;
			}

			continue;
		}

		if (char === '-' && next === '-') {
			inLineComment = true;
			index++;
			continue;
		}

		if (char === '/' && next === '*') {
			inBlockComment = true;
			index++;
			continue;
		}

		if (char === "'") {
			inSingleQuote = true;
			continue;
		}

		if (char === '"') {
			inDoubleQuote = true;
			continue;
		}

		if (char === ';') {
			boundaries.push(index);
		}
	}

	return boundaries;
}

function trimStatementRange(sql: string, start: number, end: number): SqlStatementRange {
	let trimmedStart = start;
	let trimmedEnd = end;

	while (trimmedStart < trimmedEnd && /\s/.test(sql[trimmedStart])) {
		trimmedStart++;
	}

	while (trimmedEnd > trimmedStart && /\s/.test(sql[trimmedEnd - 1])) {
		trimmedEnd--;
	}

	return {
		start: trimmedStart,
		end: trimmedEnd,
		sql: sql.slice(trimmedStart, trimmedEnd)
	};
}

function clampOffset(offset: number, max: number): number {
	if (!Number.isFinite(offset)) {
		return 0;
	}

	return Math.max(0, Math.min(max, Math.floor(offset)));
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}
```

---

# 3. 新增 `sqlEditorDraftService.ts`

路径：

```txt id="zjvri2"
src/vs/workbench/contrib/sqlEditor/common/sqlEditorDraftService.ts
```

```ts id="p9suwd"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor draft service.
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
	SQL_EDITOR_DRAFT_STORAGE_KEY,
	SQL_EDITOR_MAX_RESTORED_DRAFTS
} from './sqlEditor.js';

export const ISqlEditorDraftService = createDecorator<ISqlEditorDraftService>('sqlEditorDraftService');

export interface SqlEditorDraftEntry {
	readonly id: string;
	readonly connectionId?: string;
	readonly connectionName?: string;
	readonly sql: string;
	readonly updatedAt: number;
}

export interface SerializedSqlEditorDraftDocument {
	readonly version: 1;
	readonly entries: SqlEditorDraftEntry[];
}

export interface ISqlEditorDraftService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeDrafts: Event<readonly SqlEditorDraftEntry[]>;

	readonly entries: readonly SqlEditorDraftEntry[];

	saveDraft(entry: SqlEditorDraftEntry): void;
	removeDraft(id: string): void;
	clear(): void;
}

export class SqlEditorDraftService extends Disposable implements ISqlEditorDraftService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeDrafts = this._register(new Emitter<readonly SqlEditorDraftEntry[]>());
	readonly onDidChangeDrafts = this._onDidChangeDrafts.event;

	private _entries: SqlEditorDraftEntry[];

	constructor(
		@IStorageService private readonly storageService: IStorageService
	) {
		super();

		this._entries = this.load();
	}

	get entries(): readonly SqlEditorDraftEntry[] {
		return this._entries;
	}

	saveDraft(entry: SqlEditorDraftEntry): void {
		const normalized = normalizeDraftEntry(entry);

		if (!normalized) {
			return;
		}

		const next = [
			normalized,
			...this._entries.filter(item => item.id !== normalized.id)
		];

		this.setEntries(normalizeDraftEntries(next));
	}

	removeDraft(id: string): void {
		const normalizedId = id.trim();

		if (!normalizedId) {
			return;
		}

		this.setEntries(this._entries.filter(entry => entry.id !== normalizedId));
	}

	clear(): void {
		this.setEntries([]);
	}

	private load(): SqlEditorDraftEntry[] {
		const raw = this.storageService.getObject<SerializedSqlEditorDraftDocument>(
			SQL_EDITOR_DRAFT_STORAGE_KEY,
			StorageScope.PROFILE,
			undefined
		);

		return deserializeDrafts(raw);
	}

	private setEntries(entries: SqlEditorDraftEntry[]): void {
		this._entries = entries;
		this.persist();
		this._onDidChangeDrafts.fire(this._entries);
	}

	private persist(): void {
		this.storageService.store(
			SQL_EDITOR_DRAFT_STORAGE_KEY,
			JSON.stringify(serializeDrafts(this._entries)),
			StorageScope.PROFILE,
			StorageTarget.USER
		);
	}
}

export function serializeDrafts(entries: readonly SqlEditorDraftEntry[]): SerializedSqlEditorDraftDocument {
	return {
		version: 1,
		entries: normalizeDraftEntries(entries)
	};
}

export function deserializeDrafts(raw: unknown): SqlEditorDraftEntry[] {
	if (!raw || typeof raw !== 'object') {
		return [];
	}

	const document = raw as Partial<SerializedSqlEditorDraftDocument>;

	if (document.version !== 1 || !Array.isArray(document.entries)) {
		return [];
	}

	return normalizeDraftEntries(document.entries);
}

export function normalizeDraftEntries(
	entries: readonly SqlEditorDraftEntry[],
	maxEntries = SQL_EDITOR_MAX_RESTORED_DRAFTS
): SqlEditorDraftEntry[] {
	if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
		throw new Error('maxEntries must be a positive integer');
	}

	const seen = new Set<string>();
	const normalized: SqlEditorDraftEntry[] = [];

	for (const entry of entries) {
		const draft = normalizeDraftEntry(entry);

		if (!draft || seen.has(draft.id)) {
			continue;
		}

		seen.add(draft.id);
		normalized.push(draft);

		if (normalized.length >= maxEntries) {
			break;
		}
	}

	return normalized.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function normalizeDraftEntry(entry: SqlEditorDraftEntry): SqlEditorDraftEntry | undefined {
	if (!entry || typeof entry !== 'object') {
		return undefined;
	}

	const id = normalizeOptionalString(entry.id);
	const sql = typeof entry.sql === 'string' ? entry.sql : '';

	if (!id || !sql.trim()) {
		return undefined;
	}

	return {
		id,
		connectionId: normalizeOptionalString(entry.connectionId),
		connectionName: normalizeOptionalString(entry.connectionName),
		sql,
		updatedAt: normalizeTimestamp(entry.updatedAt)
	};
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function normalizeTimestamp(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : Date.now();
}
```

---

# 4. 新增 `sqlEditorDraftRestore.ts`

路径：

```txt id="zda62a"
src/vs/workbench/contrib/sqlEditor/browser/sqlEditorDraftRestore.ts
```

```ts id="30fm3e"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor draft restore contribution.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ISqlEditorDraftService } from '../common/sqlEditorDraftService.js';
import { SqlEditorInput } from '../common/sqlEditorInput.js';

export class SqlEditorDraftRestoreContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@ISqlEditorDraftService draftService: ISqlEditorDraftService,
		@IEditorService editorService: IEditorService
	) {
		super();

		this.restoreDrafts(draftService, editorService).catch(() => undefined);
	}

	private async restoreDrafts(
		draftService: ISqlEditorDraftService,
		editorService: IEditorService
	): Promise<void> {
		for (const draft of draftService.entries) {
			await editorService.openEditor(
				new SqlEditorInput({
					id: draft.id,
					connectionId: draft.connectionId,
					connectionName: draft.connectionName,
					initialSql: draft.sql
				}),
				{
					pinned: false,
					inactive: true
				}
			);
		}
	}
}
```

---

# 5. 替换 `sqlEditorInput.ts`

路径：

```txt id="y8tzpg"
src/vs/workbench/contrib/sqlEditor/common/sqlEditorInput.ts
```

```ts id="e1yeb6"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor input.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorInputCapabilities, IUntypedEditorInput, Verbosity } from '../../../common/editor.js';
import {
	SQL_EDITOR_DEFAULT_QUERY,
	SQL_EDITOR_INPUT_TYPE_ID,
	SQL_EDITOR_PANE_ID,
	SQL_EDITOR_SCHEME
} from './sqlEditor.js';
import {
	getSqlEditorDescription,
	getSqlEditorName,
	normalizeSqlEditorOptions,
	SqlEditorOptions
} from './sqlEditorModel.js';

export class SqlEditorInput extends EditorInput {
	static readonly TYPE_ID = SQL_EDITOR_INPUT_TYPE_ID;
	static readonly EDITOR_ID = SQL_EDITOR_PANE_ID;

	readonly id: string;
	readonly connectionId?: string;
	readonly connectionName?: string;
	readonly initialSql: string;
	readonly resource: URI;

	constructor(options: SqlEditorOptions = {}) {
		super();

		const normalized = normalizeSqlEditorOptions(
			options,
			SQL_EDITOR_DEFAULT_QUERY,
			() => `query-${Date.now()}-${Math.random().toString(16).slice(2)}`
		);

		this.id = normalized.id;
		this.connectionId = normalized.connectionId;
		this.connectionName = normalized.connectionName;
		this.initialSql = normalized.initialSql;
		this.resource = URI.from({
			scheme: SQL_EDITOR_SCHEME,
			path: `/${encodeURIComponent(this.id)}.sql`
		});
	}

	override get typeId(): string {
		return SqlEditorInput.TYPE_ID;
	}

	override get editorId(): string {
		return SqlEditorInput.EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Scratchpad | EditorInputCapabilities.CanSplitInGroup;
	}

	override getName(): string {
		return getSqlEditorName(this.connectionName);
	}

	override getDescription(_verbosity?: Verbosity): string | undefined {
		return getSqlEditorDescription(this.connectionId);
	}

	override getTitle(_verbosity?: Verbosity): string {
		const description = this.getDescription();

		if (!description) {
			return this.getName();
		}

		return `${this.getName()} — ${description}`;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		if (otherInput instanceof SqlEditorInput) {
			return otherInput.id === this.id;
		}

		return super.matches(otherInput);
	}

	override copy(): EditorInput {
		return new SqlEditorInput({
			id: this.id,
			connectionId: this.connectionId,
			connectionName: this.connectionName,
			initialSql: this.initialSql
		});
	}
}
```

---

# 6. 替换 `sqlEditorPane.ts`

路径：

```txt id="c13mxo"
src/vs/workbench/contrib/sqlEditor/browser/sqlEditorPane.ts
```

```ts id="w27olu"
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
```

---

# 7. 替换 `sqlEditorActions.ts`

路径：

```txt id="50gr49"
src/vs/workbench/contrib/sqlEditor/browser/sqlEditorActions.ts
```

```ts id="m7vhiq"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor commands.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ISqlConnectionService } from '../../../services/sql/common/sqlConnection.js';
import {
	SQL_EXECUTE_CURRENT_STATEMENT_COMMAND_ID,
	SQL_EXECUTE_QUERY_COMMAND_ID,
	SQL_EXECUTE_SELECTION_COMMAND_ID,
	SQL_FORMAT_QUERY_COMMAND_ID,
	SQL_NEW_QUERY_COMMAND_ID
} from '../common/sqlEditor.js';
import { SqlEditorExecutionSource } from '../common/sqlEditorModel.js';
import { SqlEditorInput } from '../common/sqlEditorInput.js';
import { SqlEditorPane } from './sqlEditorPane.js';

export interface OpenSqlQueryArgs {
	id?: string;
	connectionId?: string;
	connectionName?: string;
	initialSql?: string;
}

export class NewSqlQueryAction extends Action2 {
	constructor() {
		super({
			id: SQL_NEW_QUERY_COMMAND_ID,
			title: localize2('sqlNewQuery', 'New SQL Query'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor, args?: OpenSqlQueryArgs): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const connectionService = accessor.get(ISqlConnectionService);

		let connectionId = args?.connectionId?.trim() || undefined;
		let connectionName = args?.connectionName?.trim() || undefined;

		if (!connectionId) {
			try {
				const connections = await connectionService.listConnections();
				const first = connections[0];

				if (first) {
					connectionId = first.id;
					connectionName = first.name;
				}
			} catch {
				connectionId = undefined;
				connectionName = undefined;
			}
		}

		await editorService.openEditor(
			new SqlEditorInput({
				id: args?.id,
				connectionId,
				connectionName,
				initialSql: args?.initialSql
			})
		);
	}
}

export class ExecuteSqlQueryAction extends Action2 {
	constructor() {
		super({
			id: SQL_EXECUTE_QUERY_COMMAND_ID,
			title: localize2('sqlExecuteQuery', 'Execute SQL Query'),
			category: Categories.View,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.Enter,
				weight: KeybindingWeight.EditorContrib
			},
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await runSqlEditorCommand(accessor, pane => pane.executeQuery(SqlEditorExecutionSource.All), 'Open a SQL Query editor before executing SQL.');
	}
}

export class ExecuteSqlSelectionAction extends Action2 {
	constructor() {
		super({
			id: SQL_EXECUTE_SELECTION_COMMAND_ID,
			title: localize2('sqlExecuteSelection', 'Execute SQL Selection'),
			category: Categories.View,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter,
				weight: KeybindingWeight.EditorContrib
			},
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await runSqlEditorCommand(accessor, pane => pane.executeQuery(SqlEditorExecutionSource.Selection), 'Open a SQL Query editor before executing selected SQL.');
	}
}

export class ExecuteSqlCurrentStatementAction extends Action2 {
	constructor() {
		super({
			id: SQL_EXECUTE_CURRENT_STATEMENT_COMMAND_ID,
			title: localize2('sqlExecuteCurrentStatement', 'Execute Current SQL Statement'),
			category: Categories.View,
			f1: true,
			keybinding: {
				primary: KeyMod.Alt | KeyCode.Enter,
				weight: KeybindingWeight.EditorContrib
			},
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await runSqlEditorCommand(accessor, pane => pane.executeQuery(SqlEditorExecutionSource.Statement), 'Open a SQL Query editor before executing current statement.');
	}
}

export class FormatSqlQueryAction extends Action2 {
	constructor() {
		super({
			id: SQL_FORMAT_QUERY_COMMAND_ID,
			title: localize2('sqlFormatQuery', 'Format SQL Query'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await runSqlEditorCommand(accessor, pane => {
			pane.formatQuery();
		}, 'Open a SQL Query editor before formatting SQL.');
	}
}

async function runSqlEditorCommand(
	accessor: ServicesAccessor,
	callback: (pane: SqlEditorPane) => Promise<void> | void,
	message: string
): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const notificationService = accessor.get(INotificationService);
	const pane = editorService.activeEditorPane;

	if (pane instanceof SqlEditorPane) {
		await callback(pane);
		return;
	}

	notificationService.info(message);
}

registerAction2(NewSqlQueryAction);
registerAction2(ExecuteSqlQueryAction);
registerAction2(ExecuteSqlSelectionAction);
registerAction2(ExecuteSqlCurrentStatementAction);
registerAction2(FormatSqlQueryAction);
```

---

# 8. 替换 `sqlEditor.contribution.ts`

路径：

```txt id="wibdpc"
src/vs/workbench/contrib/sqlEditor/browser/sqlEditor.contribution.ts
```

```ts id="olf75t"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor workbench contribution.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlEditor.css';

import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { EditorExtensions } from '../../../common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { Extensions as WorkbenchExtensions, IWorkbenchContributionsRegistry, WorkbenchPhase } from '../../../common/contributions.js';
import { ISqlEditorDraftService, SqlEditorDraftService } from '../common/sqlEditorDraftService.js';
import { ISqlEditorEventService, SqlEditorEventService } from '../common/sqlEditorEvents.js';
import { SQL_EDITOR_PANE_ID } from '../common/sqlEditor.js';
import { SqlEditorInput } from '../common/sqlEditorInput.js';
import { SqlEditorDraftRestoreContribution } from './sqlEditorDraftRestore.js';
import { SqlEditorPane } from './sqlEditorPane.js';
import './sqlEditorActions.js';

registerSingleton(ISqlEditorEventService, SqlEditorEventService, InstantiationType.Delayed);
registerSingleton(ISqlEditorDraftService, SqlEditorDraftService, InstantiationType.Delayed);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(SqlEditorPane, SQL_EDITOR_PANE_ID, 'SQL Query Editor'),
	[new SyncDescriptor(SqlEditorInput)]
);

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution2(
	'workbench.contrib.sqlEditorDraftRestore',
	SqlEditorDraftRestoreContribution,
	WorkbenchPhase.AfterRestored
);
```

---

# 9. 替换 `sqlEditor.css`

路径：

```txt id="b5u9f8"
src/vs/workbench/contrib/sqlEditor/browser/media/sqlEditor.css
```

```css id="3xztp7"
.sql-editor-pane {
	box-sizing: border-box;
	height: 100%;
	width: 100%;
	display: flex;
	flex-direction: column;
	overflow: hidden;
	background: var(--vscode-editor-background);
	color: var(--vscode-editor-foreground);
}

.sql-editor-toolbar {
	box-sizing: border-box;
	min-height: 34px;
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 4px 8px;
	border-bottom: 1px solid var(--vscode-editorGroup-border);
	background: var(--vscode-sideBar-background);
}

.sql-editor-connection-select {
	min-width: 180px;
	max-width: 280px;
	height: 24px;
	color: var(--vscode-dropdown-foreground);
	background: var(--vscode-dropdown-background);
	border: 1px solid var(--vscode-dropdown-border);
}

.sql-editor-button {
	height: 24px;
	padding: 0 10px;
	border: 1px solid var(--vscode-button-border);
	color: var(--vscode-button-secondaryForeground);
	background: var(--vscode-button-secondaryBackground);
	cursor: pointer;
	font-size: 12px;
}

.sql-editor-button.primary {
	color: var(--vscode-button-foreground);
	background: var(--vscode-button-background);
}

.sql-editor-button:hover:not(:disabled) {
	background: var(--vscode-button-hoverBackground);
}

.sql-editor-button:disabled {
	opacity: 0.45;
	cursor: default;
}

.sql-editor-status {
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--vscode-descriptionForeground);
	font-size: 12px;
}

.sql-editor-container {
	flex: 1 1 auto;
	min-height: 0;
	overflow: hidden;
}
```

---

# 10. 新增 `sqlEditorModel.test.ts`

路径：

```txt id="x41rj9"
src/vs/workbench/contrib/sqlEditor/test/sqlEditorModel.test.ts
```

```ts id="jnor5p"
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createExecutePayload,
	createFormatterPlaceholderResult,
	findSqlStatementAtOffset,
	getSqlEditorStatusLabel,
	normalizeExecutableSql,
	normalizeSqlEditorOptions,
	SqlEditorExecutionSource
} from '../common/sqlEditorModel.js';

test('normalizeSqlEditorOptions creates defaults', () => {
	const normalized = normalizeSqlEditorOptions(
		{},
		'SELECT 1;',
		() => 'query-1'
	);

	assert.deepEqual(normalized, {
		id: 'query-1',
		connectionId: undefined,
		connectionName: undefined,
		initialSql: 'SELECT 1;'
	});
});

test('normalizeSqlEditorOptions trims optional fields', () => {
	const normalized = normalizeSqlEditorOptions(
		{
			id: ' query-1 ',
			connectionId: ' local ',
			connectionName: ' Local SQLite ',
			initialSql: 'SELECT 2;'
		},
		'SELECT 1;',
		() => 'query-fallback'
	);

	assert.equal(normalized.id, 'query-1');
	assert.equal(normalized.connectionId, 'local');
	assert.equal(normalized.connectionName, 'Local SQLite');
	assert.equal(normalized.initialSql, 'SELECT 2;');
});

test('normalizeExecutableSql trims SQL', () => {
	assert.equal(normalizeExecutableSql(' SELECT 1; '), 'SELECT 1;');
});

test('createExecutePayload creates executable payload', () => {
	assert.deepEqual(
		createExecutePayload(' local ', ' SELECT 1; ', SqlEditorExecutionSource.Statement),
		{
			connectionId: 'local',
			sql: 'SELECT 1;',
			source: SqlEditorExecutionSource.Statement
		}
	);
});

test('createExecutePayload rejects missing connection', () => {
	assert.throws(
		() => createExecutePayload(undefined, 'SELECT 1;', SqlEditorExecutionSource.All),
		/No SQL connection selected/
	);
});

test('createExecutePayload rejects empty SQL', () => {
	assert.throws(
		() => createExecutePayload('local', '   ', SqlEditorExecutionSource.All),
		/SQL is empty/
	);
});

test('findSqlStatementAtOffset returns first statement', () => {
	const sql = 'SELECT 1;\nSELECT 2;';
	const statement = findSqlStatementAtOffset(sql, 3);

	assert.deepEqual(statement, {
		start: 0,
		end: 8,
		sql: 'SELECT 1'
	});
});

test('findSqlStatementAtOffset returns second statement', () => {
	const sql = 'SELECT 1;\nSELECT 2;';
	const statement = findSqlStatementAtOffset(sql, sql.indexOf('2'));

	assert.deepEqual(statement, {
		start: 10,
		end: 18,
		sql: 'SELECT 2'
	});
});

test('findSqlStatementAtOffset ignores semicolon inside single quote', () => {
	const sql = "SELECT ';' AS value;\nSELECT 2;";
	const statement = findSqlStatementAtOffset(sql, 5);

	assert.equal(statement.sql, "SELECT ';' AS value");
});

test('findSqlStatementAtOffset ignores semicolon inside double quote', () => {
	const sql = 'SELECT ";" AS value;\nSELECT 2;';
	const statement = findSqlStatementAtOffset(sql, 5);

	assert.equal(statement.sql, 'SELECT ";" AS value');
});

test('findSqlStatementAtOffset ignores semicolon inside line comment', () => {
	const sql = 'SELECT 1 -- ; comment\n;\nSELECT 2;';
	const statement = findSqlStatementAtOffset(sql, 5);

	assert.equal(statement.sql, 'SELECT 1 -- ; comment');
});

test('findSqlStatementAtOffset ignores semicolon inside block comment', () => {
	const sql = 'SELECT 1 /* ; comment */;\nSELECT 2;';
	const statement = findSqlStatementAtOffset(sql, 5);

	assert.equal(statement.sql, 'SELECT 1 /* ; comment */');
});

test('getSqlEditorStatusLabel renders connection status', () => {
	assert.equal(
		getSqlEditorStatusLabel({
			connectionId: 'local',
			connectionName: 'Local SQLite',
			dirty: false,
			running: false
		}),
		'Ready · Local SQLite'
	);

	assert.equal(
		getSqlEditorStatusLabel({
			connectionId: 'local',
			dirty: true,
			running: false
		}),
		'Draft saved · local'
	);

	assert.equal(
		getSqlEditorStatusLabel({
			connectionId: 'local',
			running: true
		}),
		'Running · local'
	);
});

test('createFormatterPlaceholderResult is a no-op placeholder', () => {
	assert.equal(createFormatterPlaceholderResult('SELECT 1;'), 'SELECT 1;');
});
```

---

# 11. 新增 `sqlEditorDraftService.test.ts`

路径：

```txt id="qcoagz"
src/vs/workbench/contrib/sqlEditor/test/sqlEditorDraftService.test.ts
```

```ts id="4az0mk"
import assert from 'node:assert/strict';
import test from 'node:test';

import { Event } from '../../../../base/common/event.js';
import {
	IStorageService,
	StorageScope,
	StorageTarget
} from '../../../../platform/storage/common/storage.js';
import {
	deserializeDrafts,
	normalizeDraftEntries,
	serializeDrafts,
	SerializedSqlEditorDraftDocument,
	SqlEditorDraftEntry,
	SqlEditorDraftService
} from '../common/sqlEditorDraftService.js';
import { SQL_EDITOR_DRAFT_STORAGE_KEY } from '../common/sqlEditor.js';

class MinimalStorageService {
	private readonly values = new Map<string, unknown>();

	readonly onDidChangeTarget = Event.None;
	readonly onWillSaveState = Event.None;

	onDidChangeValue() {
		return Event.None;
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
}

function createStorage(): IStorageService {
	return new MinimalStorageService() as unknown as IStorageService;
}

function createDraft(id: string, updatedAt: number): SqlEditorDraftEntry {
	return {
		id,
		connectionId: 'local',
		connectionName: 'Local SQLite',
		sql: `SELECT ${updatedAt};`,
		updatedAt
	};
}

test('serializeDrafts and deserializeDrafts round trip', () => {
	const draft = createDraft('query-1', 1000);
	const document = serializeDrafts([draft]);

	assert.equal(document.version, 1);

	const entries = deserializeDrafts(document);

	assert.equal(entries.length, 1);
	assert.equal(entries[0].id, 'query-1');
	assert.equal(entries[0].sql, 'SELECT 1000;');
});

test('deserializeDrafts rejects invalid document', () => {
	assert.deepEqual(deserializeDrafts(undefined), []);
	assert.deepEqual(deserializeDrafts({ version: 2, entries: [] }), []);
	assert.deepEqual(deserializeDrafts({ version: 1, entries: 'bad' }), []);
});

test('normalizeDraftEntries removes invalid and duplicate entries', () => {
	const draft = createDraft('query-1', 1000);

	const invalid = {
		...draft,
		id: '',
		sql: ''
	};

	const entries = normalizeDraftEntries([draft, draft, invalid]);

	assert.equal(entries.length, 1);
	assert.equal(entries[0].id, 'query-1');
});

test('normalizeDraftEntries sorts by updatedAt desc and caps entries', () => {
	const entries = normalizeDraftEntries(
		[
			createDraft('query-1', 1000),
			createDraft('query-2', 3000),
			createDraft('query-3', 2000)
		],
		2
	);

	assert.deepEqual(entries.map(entry => entry.id), ['query-2', 'query-3']);
});

test('SqlEditorDraftService starts empty', () => {
	const service = new SqlEditorDraftService(createStorage());

	assert.equal(service.entries.length, 0);

	service.dispose();
});

test('SqlEditorDraftService saves draft', () => {
	const storage = createStorage();
	const service = new SqlEditorDraftService(storage);

	service.saveDraft(createDraft('query-1', 1000));

	assert.equal(service.entries.length, 1);
	assert.equal(service.entries[0].id, 'query-1');

	const stored = storage.getObject<SerializedSqlEditorDraftDocument>(
		SQL_EDITOR_DRAFT_STORAGE_KEY,
		StorageScope.PROFILE
	);

	assert.ok(stored);
	assert.equal(stored.version, 1);
	assert.equal(stored.entries.length, 1);

	service.dispose();
});

test('SqlEditorDraftService updates existing draft', () => {
	const service = new SqlEditorDraftService(createStorage());

	service.saveDraft(createDraft('query-1', 1000));
	service.saveDraft({
		...createDraft('query-1', 2000),
		sql: 'SELECT 2;'
	});

	assert.equal(service.entries.length, 1);
	assert.equal(service.entries[0].sql, 'SELECT 2;');

	service.dispose();
});

test('SqlEditorDraftService removes draft', () => {
	const service = new SqlEditorDraftService(createStorage());

	service.saveDraft(createDraft('query-1', 1000));
	service.removeDraft('query-1');

	assert.equal(service.entries.length, 0);

	service.dispose();
});

test('SqlEditorDraftService clears drafts', () => {
	const service = new SqlEditorDraftService(createStorage());

	service.saveDraft(createDraft('query-1', 1000));
	service.saveDraft(createDraft('query-2', 2000));

	assert.equal(service.entries.length, 2);

	service.clear();

	assert.equal(service.entries.length, 0);

	service.dispose();
});

test('SqlEditorDraftService fires change event', () => {
	const service = new SqlEditorDraftService(createStorage());
	let count = 0;

	const disposable = service.onDidChangeDrafts(() => {
		count++;
	});

	service.saveDraft(createDraft('query-1', 1000));

	assert.equal(count, 1);

	disposable.dispose();
	service.dispose();
});

test('SqlEditorDraftService loads persisted draft', () => {
	const storage = createStorage();
	const first = new SqlEditorDraftService(storage);

	first.saveDraft(createDraft('query-1', 1000));
	first.dispose();

	const second = new SqlEditorDraftService(storage);

	assert.equal(second.entries.length, 1);
	assert.equal(second.entries[0].id, 'query-1');

	second.dispose();
});
```

---

# 12. 修改 `package.json`

新增：

```json id="td4qq9"
{
  "scripts": {
    "test:sql-editor": "node --test --import tsx src/vs/workbench/contrib/sqlEditor/test/sqlEditorModel.test.ts src/vs/workbench/contrib/sqlEditor/test/sqlEditorDraftService.test.ts"
  }
}
```

总测试链路保持或改为：

```json id="m8gt63"
{
  "scripts": {
    "test": "pnpm run test:branding && pnpm run test:rust && pnpm run test:sql-services && pnpm run test:sql-domain && pnpm run test:sql-connections && pnpm run test:sql-editor && pnpm run test:sql-result && pnpm run test:sql-history"
  }
}
```

---

# 13. 验收命令

```bash id="qxs7yn"
pnpm run test:sql-editor
pnpm run test
pnpm run lint
pnpm run build
```

---

# 14. 手动验收

```txt id="2fxm6e"
1. 启动应用
2. 添加 SQLite 连接
3. 打开 New SQL Query
4. toolbar 显示连接名和 Ready 状态
5. 输入多条 SQL：
   SELECT 1;
   SELECT 2;
6. 光标放在 SELECT 2 内，点击 Run Statement
7. 只执行 SELECT 2
8. 选中 SQL 后点击 Run Selection
9. 只执行选区
10. 点击 Run All
11. 执行全文
12. 修改 SQL 后状态显示 Draft saved
13. 重启应用
14. 最近 query tab 自动恢复
15. 点击 Format，提示 formatter 未来阶段实现
```

---

# Phase 7.3 完成标准

```txt id="uxse2z"
1. SQL Editor 有 Run All / Run Selection / Run Statement / Format
2. Current Statement 识别可用
3. 当前连接状态展示清晰
4. SQL 草稿能本地保存
5. 应用恢复后能恢复最近 query tab
6. 单元测试进入 test:sql-editor
7. 不引入多数据库 / AI / 插件 / 真实 formatter
```

下一阶段：

```txt id="fon8e1"
Phase 7.4：Schema Tree UX Enhancement
```
