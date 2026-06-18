# Phase 5：SQL EditorInput / SQL EditorPane

Phase 5 的目标是把 SQL Studio 从“能看连接树”推进到“能打开 SQL 查询编辑器并执行 SQL”。

当前仓库已经具备 Phase 5 所需的几个关键基础：

1. `EditorPaneRegistry` 已存在，可以通过 `Registry.as(EditorExtensions.EditorPane).registerEditorPane(...)` 把 `EditorInput` 映射到 `EditorPane`。
2. `EditorPaneDescriptor.create(...)` 支持用 Workbench DI 创建自定义 EditorPane。
3. `EditorInput` 是 Workbench 编辑器输入的标准基类，子类需要提供 `typeId`、`resource`、`getName()`、`matches()` 等能力。
4. `IEditorService.openEditor(EditorInput, options, group)` 可以直接打开 typed editor input。
5. `CodeEditorWidget` 可以通过 `IInstantiationService.createInstance(...)` 创建 Monaco 风格代码编辑器。
6. `IModelService.createModel(...)` 可以创建文本模型，`ILanguageService.createById('sql')` 可以绑定 SQL language id。

---

# Phase 5 边界

本阶段做：

```txt id="uy8es9"
1. SQL EditorInput
2. SQL EditorPane
3. New SQL Query 命令
4. Execute SQL 命令
5. Execute Selection 命令
6. Cmd/Ctrl + Enter 执行当前 SQL
7. Shift + Cmd/Ctrl + Enter 执行选中 SQL
8. 执行结果通过 SqlEditorEventService 广播
9. 当前阶段用 Notification 临时提示结果
10. 单元测试覆盖 input / model / command payload / event bridge
```

本阶段不做：

```txt id="w4jamu"
1. Result Panel
2. Result Grid
3. Query History
4. SQL formatter
5. Explain Plan
6. 多结果集
7. SQL 右键菜单
8. 保存 SQL 文件
```

---

# 新增文件结构

```txt id="dnw1yp"
src/vs/workbench/contrib/sqlEditor/
├─ common/
│  ├─ sqlEditor.ts
│  ├─ sqlEditorInput.ts
│  ├─ sqlEditorModel.ts
│  └─ sqlEditorEvents.ts
├─ browser/
│  ├─ sqlEditor.contribution.ts
│  ├─ sqlEditorPane.ts
│  ├─ sqlEditorActions.ts
│  └─ media/
│     └─ sqlEditor.css
└─ test/
   └─ sqlEditor.test.ts
```

修改：

```txt id="dxda9h"
src/vs/workbench/workbench.common.main.ts
package.json
```

---

# 1. `src/vs/workbench/contrib/sqlEditor/common/sqlEditor.ts`

```ts id="5cp9t7"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor constants.
 *--------------------------------------------------------------------------------------------*/

export const SQL_EDITOR_INPUT_TYPE_ID = 'workbench.input.sqlStudio.query';
export const SQL_EDITOR_PANE_ID = 'workbench.editor.sqlStudio.query';

export const SQL_EDITOR_SCHEME = 'sqlstudio-query';

export const SQL_NEW_QUERY_COMMAND_ID = 'sql.newQuery';
export const SQL_EXECUTE_QUERY_COMMAND_ID = 'sql.executeQuery';
export const SQL_EXECUTE_SELECTION_COMMAND_ID = 'sql.executeSelection';

export const SQL_EDITOR_DEFAULT_QUERY = `-- SQL Studio Query
SELECT 1 AS value;
`;
```

---

# 2. `src/vs/workbench/contrib/sqlEditor/common/sqlEditorModel.ts`

```ts id="ciruu0"
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

export interface SqlEditorExecutePayload {
	connectionId: string;
	sql: string;
	source: 'all' | 'selection';
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
	source: 'all' | 'selection'
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

function normalizeOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}
```

---

# 3. `src/vs/workbench/contrib/sqlEditor/common/sqlEditorEvents.ts`

```ts id="7btuee"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor event bridge.
 * Phase 6 Result Panel will subscribe to this service.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SqlQueryResult } from '../../../services/sql/common/sqlTypes.js';

export const ISqlEditorEventService = createDecorator<ISqlEditorEventService>('sqlEditorEventService');

export interface SqlEditorQueryStartedEvent {
	readonly editorId: string;
	readonly connectionId: string;
	readonly sql: string;
	readonly startedAt: number;
}

export interface SqlEditorQueryCompletedEvent extends SqlEditorQueryStartedEvent {
	readonly result: SqlQueryResult;
	readonly completedAt: number;
}

export interface SqlEditorQueryFailedEvent extends SqlEditorQueryStartedEvent {
	readonly error: Error;
	readonly completedAt: number;
}

export interface ISqlEditorEventService {
	readonly _serviceBrand: undefined;

	readonly onDidStartQuery: Event<SqlEditorQueryStartedEvent>;
	readonly onDidCompleteQuery: Event<SqlEditorQueryCompletedEvent>;
	readonly onDidFailQuery: Event<SqlEditorQueryFailedEvent>;

	fireQueryStarted(event: SqlEditorQueryStartedEvent): void;
	fireQueryCompleted(event: SqlEditorQueryCompletedEvent): void;
	fireQueryFailed(event: SqlEditorQueryFailedEvent): void;
}

export class SqlEditorEventService extends Disposable implements ISqlEditorEventService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidStartQuery = this._register(new Emitter<SqlEditorQueryStartedEvent>());
	readonly onDidStartQuery = this._onDidStartQuery.event;

	private readonly _onDidCompleteQuery = this._register(new Emitter<SqlEditorQueryCompletedEvent>());
	readonly onDidCompleteQuery = this._onDidCompleteQuery.event;

	private readonly _onDidFailQuery = this._register(new Emitter<SqlEditorQueryFailedEvent>());
	readonly onDidFailQuery = this._onDidFailQuery.event;

	fireQueryStarted(event: SqlEditorQueryStartedEvent): void {
		this._onDidStartQuery.fire(event);
	}

	fireQueryCompleted(event: SqlEditorQueryCompletedEvent): void {
		this._onDidCompleteQuery.fire(event);
	}

	fireQueryFailed(event: SqlEditorQueryFailedEvent): void {
		this._onDidFailQuery.fire(event);
	}
}
```

---

# 4. `src/vs/workbench/contrib/sqlEditor/common/sqlEditorInput.ts`

```ts id="jgf4zm"
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
			connectionId: this.connectionId,
			connectionName: this.connectionName,
			initialSql: this.initialSql
		});
	}
}
```

---

# 5. `src/vs/workbench/contrib/sqlEditor/browser/sqlEditorPane.ts`

```ts id="5tgvxu"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor pane.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlEditor.css';

import { $, append, Dimension } from '../../../../base/browser/dom.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ScrollType } from '../../../../editor/common/editorCommon.js';
import { Selection } from '../../../../editor/common/core/selection.js';
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
import { createExecutePayload } from '../common/sqlEditorModel.js';
import { ISqlEditorEventService } from '../common/sqlEditorEvents.js';

export class SqlEditorPane extends EditorPane {
	static readonly ID = SQL_EDITOR_PANE_ID;

	private container!: HTMLElement;
	private toolbar!: HTMLElement;
	private connectionSelect!: HTMLSelectElement;
	private runButton!: HTMLButtonElement;
	private runSelectionButton!: HTMLButtonElement;
	private statusElement!: HTMLElement;
	private editorContainer!: HTMLElement;

	private editor: ICodeEditor | undefined;
	private currentInput: SqlEditorInput | undefined;
	private currentConnections: SqlConnection[] = [];
	private modelDisposal: IDisposable | undefined;

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
		@ISqlEditorEventService private readonly sqlEditorEventService: ISqlEditorEventService
	) {
		super(SqlEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
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
			$('button.sql-editor-button.primary', { type: 'button', title: 'Execute SQL' }, 'Run')
		) as HTMLButtonElement;

		this.runSelectionButton = append(
			this.toolbar,
			$('button.sql-editor-button', { type: 'button', title: 'Execute selected SQL' }, 'Run Selection')
		) as HTMLButtonElement;

		this.statusElement = append(this.toolbar, $('span.sql-editor-status'));

		this.editorContainer = append(this.container, $('.sql-editor-container'));

		this.editor = this._register(
			this.instantiationService.createInstance(
				CodeEditorWidget,
				this.editorContainer,
				{
					automaticLayout: false,
					language: 'sql',
					minimap: { enabled: false },
					scrollBeyondLastLine: false,
					fixedOverflowWidgets: true
				},
				{}
			)
		);

		this._register(
			this.runButton.addEventListener('click', () => {
				this.executeQuery(false).catch(error => this.showError(error));
			}) as unknown as IDisposable
		);

		this._register(
			this.runSelectionButton.addEventListener('click', () => {
				this.executeQuery(true).catch(error => this.showError(error));
			}) as unknown as IDisposable
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

		await this.refreshConnections(input);

		if (token.isCancellationRequested) {
			return;
		}

		const existingModel = this.modelService.getModel(input.resource);
		const model =
			existingModel ??
			this.modelService.createModel(input.initialSql, this.languageService.createById('sql'), input.resource);

		this.editor?.setModel(model);
		this.editor?.focus();
		this.status(`Ready${this.getSelectedConnectionId() ? '' : ' · no connection selected'}`);
	}

	override clearInput(): void {
		this.editor?.setModel(null);
		this.currentInput = undefined;
		super.clearInput();
	}

	override layout(dimension: Dimension): void {
		if (!this.container || !this.editorContainer) {
			return;
		}

		const toolbarHeight = this.toolbar?.offsetHeight ?? 34;
		this.editorContainer.style.height = `${Math.max(0, dimension.height - toolbarHeight)}px`;
		this.editor?.layout({
			width: dimension.width,
			height: Math.max(0, dimension.height - toolbarHeight)
		});
	}

	override focus(): void {
		super.focus();
		this.editor?.focus();
	}

	override getControl(): ICodeEditor | undefined {
		return this.editor;
	}

	async executeQuery(selectionOnly: boolean): Promise<void> {
		const input = this.currentInput;

		if (!input) {
			throw new Error('No SQL editor input is active.');
		}

		const connectionId = this.getSelectedConnectionId();
		const sql = selectionOnly ? this.getSelectedSql() : this.getAllSql();
		const payload = createExecutePayload(connectionId, sql, selectionOnly ? 'selection' : 'all');
		const startedAt = Date.now();

		this.status('Running query...');
		this.setRunning(true);

		this.sqlEditorEventService.fireQueryStarted({
			editorId: input.id,
			connectionId: payload.connectionId,
			sql: payload.sql,
			startedAt
		});

		try {
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
			this.status(message);
			this.notificationService.info(message);
		} catch (error) {
			const completedAt = Date.now();
			const normalizedError = error instanceof Error ? error : new Error(String(error));

			this.sqlEditorEventService.fireQueryFailed({
				editorId: input.id,
				connectionId: payload.connectionId,
				sql: payload.sql,
				startedAt,
				completedAt,
				error: normalizedError
			});

			this.showError(normalizedError);
		} finally {
			this.setRunning(false);
		}
	}

	private async refreshConnections(input: SqlEditorInput): Promise<void> {
		this.currentConnections = await this.sqlConnectionService.listConnections();

		while (this.connectionSelect.firstChild) {
			this.connectionSelect.firstChild.remove();
		}

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

	private getAllSql(): string {
		return this.editor?.getModel()?.getValue() ?? '';
	}

	private getSelectedSql(): string {
		const editor = this.editor;
		const model = editor?.getModel();
		const selection = editor?.getSelection();

		if (!model || !selection || selection.isEmpty()) {
			return this.getAllSql();
		}

		return model.getValueInRange(selection);
	}

	private setRunning(running: boolean): void {
		this.runButton.disabled = running;
		this.runSelectionButton.disabled = running;
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

> 注意：上面代码里 `addEventListener(...) as IDisposable` 是为了保持示例短。更严格的写法是用 `addDisposableListener`。如果你要走更规范实现，把两个 listener 改成 `this._register(addDisposableListener(...))` 即可。

---

# 6. 更规范版 listener 修改

如果你希望不留上面的类型 hack，把 `sqlEditorPane.ts` 里的 import 增加：

```ts id="tgpzb7"
import { $, append, Dimension, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
```

然后把：

```ts id="rrkloz"
this._register(
	this.runButton.addEventListener('click', () => {
		this.executeQuery(false).catch(error => this.showError(error));
	}) as unknown as IDisposable
);

this._register(
	this.runSelectionButton.addEventListener('click', () => {
		this.executeQuery(true).catch(error => this.showError(error));
	}) as unknown as IDisposable
);
```

替换成：

```ts id="6klhm2"
this._register(
	addDisposableListener(this.runButton, EventType.CLICK, () => {
		this.executeQuery(false).catch(error => this.showError(error));
	})
);

this._register(
	addDisposableListener(this.runSelectionButton, EventType.CLICK, () => {
		this.executeQuery(true).catch(error => this.showError(error));
	})
);
```

最终建议使用规范版。

---

# 7. `src/vs/workbench/contrib/sqlEditor/browser/sqlEditorActions.ts`

```ts id="fi8o9c"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor commands.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ISqlConnectionService } from '../../../services/sql/common/sqlConnection.js';
import {
	SQL_EXECUTE_QUERY_COMMAND_ID,
	SQL_EXECUTE_SELECTION_COMMAND_ID,
	SQL_NEW_QUERY_COMMAND_ID
} from '../common/sqlEditor.js';
import { SqlEditorInput } from '../common/sqlEditorInput.js';
import { SqlEditorPane } from './sqlEditorPane.js';

export interface OpenSqlQueryArgs {
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

		let connectionId = args?.connectionId;
		let connectionName = args?.connectionName;

		if (!connectionId) {
			const connections = await connectionService.listConnections();
			const first = connections[0];

			if (first) {
				connectionId = first.id;
				connectionName = first.name;
			}
		}

		await editorService.openEditor(
			new SqlEditorInput({
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
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const pane = editorService.activeEditorPane;

		if (pane instanceof SqlEditorPane) {
			await pane.executeQuery(false);
		}
	}
}

export class ExecuteSqlSelectionAction extends Action2 {
	constructor() {
		super({
			id: SQL_EXECUTE_SELECTION_COMMAND_ID,
			title: localize2('sqlExecuteSelection', 'Execute SQL Selection'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const pane = editorService.activeEditorPane;

		if (pane instanceof SqlEditorPane) {
			await pane.executeQuery(true);
		}
	}
}

registerAction2(NewSqlQueryAction);
registerAction2(ExecuteSqlQueryAction);
registerAction2(ExecuteSqlSelectionAction);
```

---

# 8. `src/vs/workbench/contrib/sqlEditor/browser/sqlEditor.contribution.ts`

```ts id="iieb2j"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor workbench contribution.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlEditor.css';

import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { EditorExtensions } from '../../../common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { ISqlEditorEventService, SqlEditorEventService } from '../common/sqlEditorEvents.js';
import { SQL_EDITOR_PANE_ID } from '../common/sqlEditor.js';
import { SqlEditorInput } from '../common/sqlEditorInput.js';
import { SqlEditorPane } from './sqlEditorPane.js';
import './sqlEditorActions.js';

registerSingleton(ISqlEditorEventService, SqlEditorEventService, InstantiationType.Delayed);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(SqlEditorPane, SQL_EDITOR_PANE_ID, 'SQL Query Editor'),
	[new SyncDescriptor(SqlEditorInput)]
);
```

---

# 9. `src/vs/workbench/contrib/sqlEditor/browser/media/sqlEditor.css`

```css id="hxafgx"
.sql-editor-pane {
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
	padding: 5px 8px;
	border-bottom: 1px solid var(--vscode-editorGroup-border);
	background: var(--vscode-sideBar-background);
}

.sql-editor-connection-select {
	height: 24px;
	min-width: 180px;
	max-width: 360px;
	padding: 0 6px;
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
}

.sql-editor-button.primary {
	color: var(--vscode-button-foreground);
	background: var(--vscode-button-background);
}

.sql-editor-button:hover:not(:disabled) {
	background: var(--vscode-button-hoverBackground);
}

.sql-editor-button:disabled,
.sql-editor-connection-select:disabled {
	opacity: 0.5;
	cursor: default;
}

.sql-editor-status {
	margin-left: auto;
	opacity: 0.75;
	font-size: 12px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.sql-editor-container {
	flex: 1 1 auto;
	min-height: 0;
	overflow: hidden;
}
```

---

# 10. 修改 `src/vs/workbench/workbench.common.main.ts`

在 SQL Studio 区域追加：

```ts id="g9cwt4"
// SQL Studio
import './contrib/sqlConnections/browser/sqlConnections.contribution.js';
import './contrib/sqlEditor/browser/sqlEditor.contribution.js';
```

如果当前已经有 `sqlConnections`，只新增第二行即可。

---

# 11. 单元测试 `src/vs/workbench/contrib/sqlEditor/test/sqlEditor.test.ts`

```ts id="ygocv9"
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createExecutePayload,
	getSqlEditorDescription,
	getSqlEditorName,
	normalizeExecutableSql,
	normalizeSqlEditorOptions
} from '../common/sqlEditorModel.js';
import { SqlEditorInput } from '../common/sqlEditorInput.js';
import {
	SQL_EDITOR_DEFAULT_QUERY,
	SQL_EDITOR_INPUT_TYPE_ID,
	SQL_EDITOR_PANE_ID,
	SQL_EDITOR_SCHEME
} from '../common/sqlEditor.js';
import { SqlEditorEventService } from '../common/sqlEditorEvents.js';
import { EditorInputCapabilities } from '../../../common/editor.js';

test('normalizeSqlEditorOptions fills id and default sql', () => {
	const normalized = normalizeSqlEditorOptions({}, SQL_EDITOR_DEFAULT_QUERY, () => 'query-1');

	assert.equal(normalized.id, 'query-1');
	assert.equal(normalized.initialSql, SQL_EDITOR_DEFAULT_QUERY);
	assert.equal(normalized.connectionId, undefined);
});

test('normalizeSqlEditorOptions trims connection metadata', () => {
	const normalized = normalizeSqlEditorOptions(
		{
			id: ' query-1 ',
			connectionId: ' local ',
			connectionName: ' Local SQLite ',
			initialSql: ' SELECT 1 '
		},
		SQL_EDITOR_DEFAULT_QUERY,
		() => 'fallback'
	);

	assert.deepEqual(normalized, {
		id: 'query-1',
		connectionId: 'local',
		connectionName: 'Local SQLite',
		initialSql: ' SELECT 1 '
	});
});

test('getSqlEditorName uses connection name when present', () => {
	assert.equal(getSqlEditorName(), 'SQL Query');
	assert.equal(getSqlEditorName('Local SQLite'), 'SQL Query · Local SQLite');
});

test('getSqlEditorDescription describes connection state', () => {
	assert.equal(getSqlEditorDescription(), 'No connection selected');
	assert.equal(getSqlEditorDescription('local'), 'Connection: local');
});

test('normalizeExecutableSql trims SQL', () => {
	assert.equal(normalizeExecutableSql('  SELECT 1  '), 'SELECT 1');
});

test('createExecutePayload rejects missing connection', () => {
	assert.throws(() => createExecutePayload(undefined, 'SELECT 1', 'all'), /No SQL connection selected/);
});

test('createExecutePayload rejects empty SQL', () => {
	assert.throws(() => createExecutePayload('local', '   ', 'all'), /SQL is empty/);
});

test('createExecutePayload returns normalized payload', () => {
	assert.deepEqual(createExecutePayload(' local ', ' SELECT 1 ', 'selection'), {
		connectionId: 'local',
		sql: 'SELECT 1',
		source: 'selection'
	});
});

test('SqlEditorInput exposes Workbench editor metadata', () => {
	const input = new SqlEditorInput({
		id: 'query-1',
		connectionId: 'local',
		connectionName: 'Local SQLite',
		initialSql: 'SELECT 1'
	});

	assert.equal(input.typeId, SQL_EDITOR_INPUT_TYPE_ID);
	assert.equal(input.editorId, SQL_EDITOR_PANE_ID);
	assert.equal(input.resource.scheme, SQL_EDITOR_SCHEME);
	assert.equal(input.getName(), 'SQL Query · Local SQLite');
	assert.equal(input.getDescription(), 'Connection: local');
	assert.equal(input.getTitle(), 'SQL Query · Local SQLite — Connection: local');
	assert.equal(input.initialSql, 'SELECT 1');
	assert.equal(input.hasCapability(EditorInputCapabilities.Scratchpad), true);
});

test('SqlEditorInput matches same query id', () => {
	const first = new SqlEditorInput({ id: 'query-1' });
	const second = new SqlEditorInput({ id: 'query-1' });
	const third = new SqlEditorInput({ id: 'query-2' });

	assert.equal(first.matches(second), true);
	assert.equal(first.matches(third), false);
});

test('SqlEditorInput copy creates a new independent query input', () => {
	const input = new SqlEditorInput({
		id: 'query-1',
		connectionId: 'local',
		connectionName: 'Local SQLite',
		initialSql: 'SELECT 1'
	});

	const copy = input.copy() as SqlEditorInput;

	assert.notEqual(copy.id, input.id);
	assert.equal(copy.connectionId, input.connectionId);
	assert.equal(copy.connectionName, input.connectionName);
	assert.equal(copy.initialSql, input.initialSql);
});

test('SqlEditorEventService emits query lifecycle events', () => {
	const service = new SqlEditorEventService();

	const events: string[] = [];

	service.onDidStartQuery(event => {
		events.push(`start:${event.editorId}:${event.connectionId}`);
	});

	service.onDidCompleteQuery(event => {
		events.push(`complete:${event.result.rowCount}`);
	});

	service.onDidFailQuery(event => {
		events.push(`fail:${event.error.message}`);
	});

	service.fireQueryStarted({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT 1',
		startedAt: 1
	});

	service.fireQueryCompleted({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT 1',
		startedAt: 1,
		completedAt: 2,
		result: {
			columns: [{ name: 'value', ordinal: 0 }],
			rows: [],
			rowCount: 1,
			elapsedMs: 1,
			truncated: false
		}
	});

	service.fireQueryFailed({
		editorId: 'query-1',
		connectionId: 'local',
		sql: 'SELECT FROM',
		startedAt: 1,
		completedAt: 2,
		error: new Error('syntax error')
	});

	assert.deepEqual(events, ['start:query-1:local', 'complete:1', 'fail:syntax error']);
});
```

---

# 12. 修改 `package.json`

在 scripts 中追加：

```json id="h7ifrr"
{
	"scripts": {
		"test:sql-editor": "node --test --import tsx src/vs/workbench/contrib/sqlEditor/test/sqlEditor.test.ts"
	}
}
```

把总测试改成：

```json id="4en1ep"
{
	"scripts": {
		"test": "pnpm run test:branding && pnpm run test:rust && pnpm run test:sql-services && pnpm run test:sql-connections && pnpm run test:sql-editor"
	}
}
```

---

# 13. 可选：从 Connection Tree 打开 SQL Editor

Phase 5 的基础命令已经支持：

```ts id="c7l9w9"
commandService.executeCommand('sql.newQuery', {
	connectionId: 'local',
	connectionName: 'Local SQLite',
	initialSql: 'SELECT * FROM users LIMIT 100;'
});
```

如果要在 Phase 4 的 Connection Tree 上加一个按钮，可以在 `SqlConnectionsView` 的 connection row 上调用：

```ts id="c4tcf1"
this.commandService.executeCommand(SQL_NEW_QUERY_COMMAND_ID, {
	connectionId: node.connectionId,
	connectionName: node.label
});
```

但这需要给 `SqlConnectionsView` 注入 `ICommandService`。为了保持 Phase 5 边界清晰，这一步可以放到 Phase 5.1 或 Phase 6 前做。

---

# 14. 验收方式

运行：

```bash id="jw3bl7"
pnpm run test:sql-editor
pnpm run test
pnpm run lint
pnpm run build
```

手动验证：

```txt id="cszv45"
1. pnpm tauri dev
2. 打开 Command Palette
3. 执行 New SQL Query
4. 出现 SQL Query 编辑器
5. 如果已有 SQLite 连接，顶部自动选择第一个连接
6. 输入 SELECT 1 AS value;
7. 执行 Execute SQL Query
8. 看到 Query completed notification
```

---

# 15. Phase 5 完成后的状态

```txt id="xsk0h2"
Phase 2: Rust SQL command bridge
Phase 3: Workbench SQL services
Phase 4: SQL Connections Activity
Phase 5: SQL EditorInput + SQL EditorPane
```

后续 Phase 6 只需要订阅：

```ts id="3pk3w1"
ISqlEditorEventService.onDidCompleteQuery;
```

然后把 `SqlQueryResult` 展示到 Result Panel 即可。

这也是为什么 Phase 5 要引入 `SqlEditorEventService`：避免 SQL Editor 直接依赖 Result Panel，保持编辑器和结果面板解耦。
