下面给出 **Phase 8.5：轻量设置与本地偏好** 的详细设计与完整代码。

当前 Phase 8 已经有产品级 storage prefix、启动命令、默认欢迎 SQL，并且 `createSqlProductStartupPlan()` 已经支持 `restoreSqlLayout / openWelcomeQuery / force` 这些启动参数。
当前 SQL Editor 也已经有 draft storage key 和最大恢复数量常量，SQL Result 也有 `SQL_RESULT_MAX_RENDER_ROWS = 1000`。
所以 Phase 8.5 不做 VS Code 全局 Settings，而是先做 **SQL Studio 自己的轻量 Preferences Service**，统一落在 profile storage，后续再迁移到正式 Settings。

---

# Phase 8.5：轻量设置与本地偏好

## 目标

```txt id="oe02tr"
1. 提供 SQL Studio 本地偏好模型
2. 偏好保存在 IStorageService / PROFILE / USER
3. 启动布局读取偏好
4. 支持 Preferences View
5. 支持 Command Palette 快速开关
6. 支持 Reset Preferences
7. 单元测试覆盖 normalize / serialize / service / startup integration
```

## 本阶段不做

```txt id="g7twp6"
1. 不接 VS Code Settings JSON
2. 不做复杂 Settings UI
3. 不做远程同步
4. 不做账号级偏好
5. 不做多数据库设置
6. 不做主题编辑器
```

---

# 文件变化

新增：

```txt id="uh06rz"
src/vs/workbench/contrib/sqlProduct/common/sqlProductPreferences.ts
src/vs/workbench/contrib/sqlProduct/common/sqlProductPreferencesService.ts
src/vs/workbench/contrib/sqlProduct/browser/sqlProductPreferencesView.ts
src/vs/workbench/contrib/sqlProduct/browser/media/sqlProductPreferences.css
src/vs/workbench/contrib/sqlProduct/test/sqlProductPreferences.test.ts
src/vs/workbench/contrib/sqlProduct/test/sqlProductPreferencesService.test.ts
```

替换：

```txt id="yufzm2"
src/vs/workbench/contrib/sqlProduct/common/sqlProductBootstrapModel.ts
src/vs/workbench/contrib/sqlProduct/browser/sqlProductBootstrap.ts
src/vs/workbench/contrib/sqlProduct/browser/sqlProductActions.ts
src/vs/workbench/contrib/sqlProduct/browser/sqlProduct.contribution.ts
```

修改：

```txt id="jh4e6o"
package.json
```

---

# 1. 新增 `sqlProductPreferences.ts`

路径：

```txt id="ihm6sz"
src/vs/workbench/contrib/sqlProduct/common/sqlProductPreferences.ts
```

```ts id="a1v5bn"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Lightweight local preferences.
 *--------------------------------------------------------------------------------------------*/

import { SQL_EDITOR_MAX_RESTORED_DRAFTS } from '../../sqlEditor/common/sqlEditor.js';
import { SQL_RESULT_MAX_RENDER_ROWS } from '../../sqlResult/common/sqlResult.js';
import {
	SQL_PRODUCT_DEFAULT_QUERY,
	SQL_PRODUCT_STORAGE_PREFIX
} from './sqlProduct.js';

export const SQL_PRODUCT_PREFERENCES_STORAGE_KEY = `${SQL_PRODUCT_STORAGE_PREFIX}.preferences`;

export const SQL_PRODUCT_MIN_RESULT_ROWS = 50;
export const SQL_PRODUCT_MAX_RESULT_ROWS = 10_000;

export const SQL_PRODUCT_MIN_RESTORED_DRAFTS = 0;
export const SQL_PRODUCT_MAX_RESTORED_DRAFTS = 50;

export interface SqlProductPreferences {
	readonly restoreSqlLayoutOnStartup: boolean;
	readonly openWelcomeQueryOnFirstLaunch: boolean;
	readonly restoreEditorDraftsOnStartup: boolean;
	readonly autoSaveEditorDrafts: boolean;
	readonly resultMaxRows: number;
	readonly maxRestoredEditorDrafts: number;
	readonly defaultQuery: string;
}

export type SqlProductPreferenceKey = keyof SqlProductPreferences;

export const DEFAULT_SQL_PRODUCT_PREFERENCES: SqlProductPreferences = {
	restoreSqlLayoutOnStartup: true,
	openWelcomeQueryOnFirstLaunch: false,
	restoreEditorDraftsOnStartup: true,
	autoSaveEditorDrafts: true,
	resultMaxRows: SQL_RESULT_MAX_RENDER_ROWS,
	maxRestoredEditorDrafts: SQL_EDITOR_MAX_RESTORED_DRAFTS,
	defaultQuery: SQL_PRODUCT_DEFAULT_QUERY
};

export interface SerializedSqlProductPreferencesDocument {
	readonly version: 1;
	readonly preferences: Partial<SqlProductPreferences>;
}

export function normalizeSqlProductPreferences(raw: unknown): SqlProductPreferences {
	if (!raw || typeof raw !== 'object') {
		return DEFAULT_SQL_PRODUCT_PREFERENCES;
	}

	const value = raw as Partial<SqlProductPreferences>;

	return {
		restoreSqlLayoutOnStartup: normalizeBoolean(
			value.restoreSqlLayoutOnStartup,
			DEFAULT_SQL_PRODUCT_PREFERENCES.restoreSqlLayoutOnStartup
		),
		openWelcomeQueryOnFirstLaunch: normalizeBoolean(
			value.openWelcomeQueryOnFirstLaunch,
			DEFAULT_SQL_PRODUCT_PREFERENCES.openWelcomeQueryOnFirstLaunch
		),
		restoreEditorDraftsOnStartup: normalizeBoolean(
			value.restoreEditorDraftsOnStartup,
			DEFAULT_SQL_PRODUCT_PREFERENCES.restoreEditorDraftsOnStartup
		),
		autoSaveEditorDrafts: normalizeBoolean(
			value.autoSaveEditorDrafts,
			DEFAULT_SQL_PRODUCT_PREFERENCES.autoSaveEditorDrafts
		),
		resultMaxRows: normalizeIntegerRange(
			value.resultMaxRows,
			SQL_PRODUCT_MIN_RESULT_ROWS,
			SQL_PRODUCT_MAX_RESULT_ROWS,
			DEFAULT_SQL_PRODUCT_PREFERENCES.resultMaxRows
		),
		maxRestoredEditorDrafts: normalizeIntegerRange(
			value.maxRestoredEditorDrafts,
			SQL_PRODUCT_MIN_RESTORED_DRAFTS,
			SQL_PRODUCT_MAX_RESTORED_DRAFTS,
			DEFAULT_SQL_PRODUCT_PREFERENCES.maxRestoredEditorDrafts
		),
		defaultQuery: normalizeDefaultQuery(
			value.defaultQuery,
			DEFAULT_SQL_PRODUCT_PREFERENCES.defaultQuery
		)
	};
}

export function serializeSqlProductPreferences(
	preferences: SqlProductPreferences
): SerializedSqlProductPreferencesDocument {
	return {
		version: 1,
		preferences: normalizeSqlProductPreferences(preferences)
	};
}

export function deserializeSqlProductPreferences(raw: unknown): SqlProductPreferences {
	if (!raw || typeof raw !== 'object') {
		return DEFAULT_SQL_PRODUCT_PREFERENCES;
	}

	const document = raw as Partial<SerializedSqlProductPreferencesDocument>;

	if (document.version !== 1 || !document.preferences || typeof document.preferences !== 'object') {
		return DEFAULT_SQL_PRODUCT_PREFERENCES;
	}

	return normalizeSqlProductPreferences(document.preferences);
}

export function updateSqlProductPreference<K extends SqlProductPreferenceKey>(
	preferences: SqlProductPreferences,
	key: K,
	value: SqlProductPreferences[K]
): SqlProductPreferences {
	return normalizeSqlProductPreferences({
		...preferences,
		[key]: value
	});
}

export function resetSqlProductPreferences(): SqlProductPreferences {
	return DEFAULT_SQL_PRODUCT_PREFERENCES;
}

export function getSqlProductPreferenceLabel(key: SqlProductPreferenceKey): string {
	switch (key) {
		case 'restoreSqlLayoutOnStartup':
			return 'Restore SQL layout on startup';

		case 'openWelcomeQueryOnFirstLaunch':
			return 'Open welcome query on first launch';

		case 'restoreEditorDraftsOnStartup':
			return 'Restore editor drafts on startup';

		case 'autoSaveEditorDrafts':
			return 'Auto save editor drafts';

		case 'resultMaxRows':
			return 'Max result rows';

		case 'maxRestoredEditorDrafts':
			return 'Max restored editor drafts';

		case 'defaultQuery':
			return 'Default query';

		default:
			return assertNever(key);
	}
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function normalizeIntegerRange(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return fallback;
	}

	const normalized = Math.floor(value);

	return Math.min(max, Math.max(min, normalized));
}

function normalizeDefaultQuery(value: unknown, fallback: string): string {
	if (typeof value !== 'string') {
		return fallback;
	}

	const normalized = value.trim();

	if (!normalized) {
		return fallback;
	}

	return value;
}

function assertNever(value: never): never {
	throw new Error(`Unexpected SQL product preference key: ${String(value)}`);
}
```

---

# 2. 新增 `sqlProductPreferencesService.ts`

路径：

```txt id="j5k9oa"
src/vs/workbench/contrib/sqlProduct/common/sqlProductPreferencesService.ts
```

```ts id="mdrfhg"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product preferences service.
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
	deserializeSqlProductPreferences,
	resetSqlProductPreferences,
	serializeSqlProductPreferences,
	SerializedSqlProductPreferencesDocument,
	SqlProductPreferenceKey,
	SqlProductPreferences,
	SQL_PRODUCT_PREFERENCES_STORAGE_KEY,
	updateSqlProductPreference
} from './sqlProductPreferences.js';

export const ISqlProductPreferencesService = createDecorator<ISqlProductPreferencesService>('sqlProductPreferencesService');

export interface ISqlProductPreferencesService {
	readonly _serviceBrand: undefined;

	readonly onDidChangePreferences: Event<SqlProductPreferences>;

	readonly preferences: SqlProductPreferences;

	updatePreference<K extends SqlProductPreferenceKey>(key: K, value: SqlProductPreferences[K]): void;
	updatePreferences(value: Partial<SqlProductPreferences>): void;
	reset(): void;
}

export class SqlProductPreferencesService extends Disposable implements ISqlProductPreferencesService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangePreferences = this._register(new Emitter<SqlProductPreferences>());
	readonly onDidChangePreferences = this._onDidChangePreferences.event;

	private _preferences: SqlProductPreferences;

	constructor(
		@IStorageService private readonly storageService: IStorageService
	) {
		super();

		this._preferences = this.load();
	}

	get preferences(): SqlProductPreferences {
		return this._preferences;
	}

	updatePreference<K extends SqlProductPreferenceKey>(key: K, value: SqlProductPreferences[K]): void {
		this.setPreferences(updateSqlProductPreference(this._preferences, key, value));
	}

	updatePreferences(value: Partial<SqlProductPreferences>): void {
		this.setPreferences({
			...this._preferences,
			...value
		});
	}

	reset(): void {
		this.setPreferences(resetSqlProductPreferences());
	}

	private load(): SqlProductPreferences {
		const raw = this.storageService.getObject<SerializedSqlProductPreferencesDocument>(
			SQL_PRODUCT_PREFERENCES_STORAGE_KEY,
			StorageScope.PROFILE,
			undefined
		);

		return deserializeSqlProductPreferences(raw);
	}

	private setPreferences(preferences: SqlProductPreferences): void {
		this._preferences = deserializeSqlProductPreferences(serializeSqlProductPreferences(preferences));
		this.persist();
		this._onDidChangePreferences.fire(this._preferences);
	}

	private persist(): void {
		this.storageService.store(
			SQL_PRODUCT_PREFERENCES_STORAGE_KEY,
			JSON.stringify(serializeSqlProductPreferences(this._preferences)),
			StorageScope.PROFILE,
			StorageTarget.USER
		);
	}
}
```

---

# 3. 替换 `sqlProductBootstrapModel.ts`

路径：

```txt id="rkkkt5"
src/vs/workbench/contrib/sqlProduct/common/sqlProductBootstrapModel.ts
```

```ts id="uv1cqs"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product bootstrap pure model.
 *--------------------------------------------------------------------------------------------*/

import { SQL_CONNECTIONS_FOCUS_COMMAND_ID } from '../../sqlConnections/common/sqlConnections.js';
import { SQL_RESULT_OPEN_COMMAND_ID } from '../../sqlResult/common/sqlResult.js';
import { SQL_NEW_QUERY_COMMAND_ID } from '../../sqlEditor/common/sqlEditor.js';
import { DEFAULT_SQL_PRODUCT_PREFERENCES, SqlProductPreferences } from './sqlProductPreferences.js';

export const enum SqlProductStartupCommandKind {
	FocusConnections = 'focusConnections',
	OpenResults = 'openResults',
	NewQuery = 'newQuery'
}

export interface SqlProductStartupCommand {
	readonly kind: SqlProductStartupCommandKind;
	readonly commandId: string;
	readonly args?: unknown[];
}

export interface SqlProductBootstrapOptions {
	readonly alreadyBootstrapped: boolean;
	readonly preferences?: SqlProductPreferences;
	readonly force?: boolean;
}

export function shouldRunSqlProductBootstrap(options: SqlProductBootstrapOptions): boolean {
	if (options.force) {
		return true;
	}

	return !options.alreadyBootstrapped;
}

export function createSqlProductStartupPlan(options: SqlProductBootstrapOptions): SqlProductStartupCommand[] {
	if (!shouldRunSqlProductBootstrap(options)) {
		return [];
	}

	const preferences = options.preferences ?? DEFAULT_SQL_PRODUCT_PREFERENCES;
	const commands: SqlProductStartupCommand[] = [];

	if (preferences.restoreSqlLayoutOnStartup) {
		commands.push({
			kind: SqlProductStartupCommandKind.FocusConnections,
			commandId: SQL_CONNECTIONS_FOCUS_COMMAND_ID
		});

		commands.push({
			kind: SqlProductStartupCommandKind.OpenResults,
			commandId: SQL_RESULT_OPEN_COMMAND_ID
		});
	}

	if (preferences.openWelcomeQueryOnFirstLaunch) {
		commands.push({
			kind: SqlProductStartupCommandKind.NewQuery,
			commandId: SQL_NEW_QUERY_COMMAND_ID,
			args: [
				{
					initialSql: preferences.defaultQuery
				}
			]
		});
	}

	return dedupeStartupCommands(commands);
}

export function dedupeStartupCommands(commands: readonly SqlProductStartupCommand[]): SqlProductStartupCommand[] {
	const seen = new Set<string>();
	const result: SqlProductStartupCommand[] = [];

	for (const command of commands) {
		const key = `${command.commandId}:${JSON.stringify(command.args ?? [])}`;

		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		result.push(command);
	}

	return result;
}
```

---

# 4. 替换 `sqlProductBootstrap.ts`

路径：

```txt id="a98yrq"
src/vs/workbench/contrib/sqlProduct/browser/sqlProductBootstrap.ts
```

```ts id="sfh8yj"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product bootstrap contribution.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import {
	IStorageService,
	StorageScope,
	StorageTarget
} from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import {
	createSqlProductStartupPlan,
	SqlProductStartupCommand
} from '../common/sqlProductBootstrapModel.js';
import {
	SQL_PRODUCT_BOOTSTRAPPED_STORAGE_KEY,
	SQL_PRODUCT_NAME
} from '../common/sqlProduct.js';
import { ISqlProductPreferencesService } from '../common/sqlProductPreferencesService.js';

export class SqlProductBootstrapContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@ISqlProductPreferencesService private readonly preferencesService: ISqlProductPreferencesService
	) {
		super();

		this.bootstrap().catch(error => {
			const message = error instanceof Error ? error.message : String(error);
			this.notificationService.warn(`${SQL_PRODUCT_NAME} startup layout was not fully restored: ${message}`);
		});
	}

	private async bootstrap(): Promise<void> {
		const alreadyBootstrapped = this.storageService.getBoolean(
			SQL_PRODUCT_BOOTSTRAPPED_STORAGE_KEY,
			StorageScope.PROFILE,
			false
		) === true;

		const plan = createSqlProductStartupPlan({
			alreadyBootstrapped,
			preferences: this.preferencesService.preferences
		});

		await this.runPlan(plan);

		if (!alreadyBootstrapped) {
			this.storageService.store(
				SQL_PRODUCT_BOOTSTRAPPED_STORAGE_KEY,
				true,
				StorageScope.PROFILE,
				StorageTarget.USER
			);
		}
	}

	private async runPlan(plan: readonly SqlProductStartupCommand[]): Promise<void> {
		for (const item of plan) {
			await this.commandService.executeCommand(item.commandId, ...(item.args ?? []));
		}
	}
}
```

---

# 5. 新增 `sqlProductPreferencesView.ts`

路径：

```txt id="9e7d79"
src/vs/workbench/contrib/sqlProduct/browser/sqlProductPreferencesView.ts
```

```ts id="bhqnjy"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Lightweight Preferences View.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlProductPreferences.css';

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
	DEFAULT_SQL_PRODUCT_PREFERENCES,
	getSqlProductPreferenceLabel,
	SQL_PRODUCT_MAX_RESULT_ROWS,
	SQL_PRODUCT_MAX_RESTORED_DRAFTS,
	SQL_PRODUCT_MIN_RESULT_ROWS,
	SQL_PRODUCT_MIN_RESTORED_DRAFTS,
	SqlProductPreferences
} from '../common/sqlProductPreferences.js';
import { ISqlProductPreferencesService } from '../common/sqlProductPreferencesService.js';

export const SQL_PRODUCT_PREFERENCES_VIEW_ID = 'sqlStudio.product.preferences';

export class SqlProductPreferencesView extends ViewPane {
	static readonly ID = SQL_PRODUCT_PREFERENCES_VIEW_ID;
	static readonly NAME = localize('sqlProductPreferencesViewName', 'Preferences');

	private readonly renderDisposables = this._register(new DisposableStore());

	private container!: HTMLElement;
	private contentElement!: HTMLElement;
	private statusElement!: HTMLElement;

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

	protected override renderBody(container: HTMLElement): void {
		this.container = append(container, $('.sql-product-preferences-view'));
		this.contentElement = append(this.container, $('.sql-product-preferences-content'));
		this.statusElement = append(this.container, $('.sql-product-preferences-statusbar'));

		this._register(this.preferencesService.onDidChangePreferences(() => this.renderPreferences()));
		this.renderPreferences();
	}

	override focus(): void {
		this.contentElement?.focus();
		super.focus();
	}

	private renderPreferences(): void {
		this.renderDisposables.clear();
		clearNode(this.contentElement);

		const preferences = this.preferencesService.preferences;

		append(this.contentElement, $('h3.sql-product-preferences-title', undefined, 'SQL Studio Preferences'));

		this.renderBooleanPreference(preferences, 'restoreSqlLayoutOnStartup');
		this.renderBooleanPreference(preferences, 'openWelcomeQueryOnFirstLaunch');
		this.renderBooleanPreference(preferences, 'restoreEditorDraftsOnStartup');
		this.renderBooleanPreference(preferences, 'autoSaveEditorDrafts');

		this.renderNumberPreference(
			preferences,
			'resultMaxRows',
			SQL_PRODUCT_MIN_RESULT_ROWS,
			SQL_PRODUCT_MAX_RESULT_ROWS
		);

		this.renderNumberPreference(
			preferences,
			'maxRestoredEditorDrafts',
			SQL_PRODUCT_MIN_RESTORED_DRAFTS,
			SQL_PRODUCT_MAX_RESTORED_DRAFTS
		);

		this.renderDefaultQueryPreference(preferences);
		this.renderActions();

		this.setStatus('Preferences are stored locally.');
	}

	private renderBooleanPreference<K extends keyof Pick<
		SqlProductPreferences,
		'restoreSqlLayoutOnStartup' | 'openWelcomeQueryOnFirstLaunch' | 'restoreEditorDraftsOnStartup' | 'autoSaveEditorDrafts'
	>>(preferences: SqlProductPreferences, key: K): void {
		const row = append(this.contentElement, $('.sql-product-preference-row'));
		const label = append(row, $('label.sql-product-preference-checkbox'));

		const input = append(label, $('input', { type: 'checkbox' })) as HTMLInputElement;
		input.checked = preferences[key];

		append(label, $('span', undefined, getSqlProductPreferenceLabel(key)));

		this.renderDisposables.add(
			addDisposableListener(input, EventType.CHANGE, () => {
				this.preferencesService.updatePreference(key, input.checked as SqlProductPreferences[K]);
				this.setStatus(`Updated ${getSqlProductPreferenceLabel(key)}.`);
			})
		);
	}

	private renderNumberPreference<K extends keyof Pick<
		SqlProductPreferences,
		'resultMaxRows' | 'maxRestoredEditorDrafts'
	>>(
		preferences: SqlProductPreferences,
		key: K,
		min: number,
		max: number
	): void {
		const row = append(this.contentElement, $('.sql-product-preference-row'));
		const label = append(row, $('label.sql-product-preference-field'));

		append(label, $('span', undefined, getSqlProductPreferenceLabel(key)));

		const input = append(label, $('input.sql-product-preference-input', {
			type: 'number',
			min: String(min),
			max: String(max),
			value: String(preferences[key])
		})) as HTMLInputElement;

		this.renderDisposables.add(
			addDisposableListener(input, EventType.CHANGE, () => {
				this.preferencesService.updatePreference(key, Number(input.value) as SqlProductPreferences[K]);
				this.setStatus(`Updated ${getSqlProductPreferenceLabel(key)}.`);
			})
		);
	}

	private renderDefaultQueryPreference(preferences: SqlProductPreferences): void {
		const row = append(this.contentElement, $('.sql-product-preference-row'));
		const label = append(row, $('label.sql-product-preference-field'));

		append(label, $('span', undefined, getSqlProductPreferenceLabel('defaultQuery')));

		const textarea = append(label, $('textarea.sql-product-preference-textarea')) as HTMLTextAreaElement;
		textarea.value = preferences.defaultQuery;

		this.renderDisposables.add(
			addDisposableListener(textarea, EventType.CHANGE, () => {
				this.preferencesService.updatePreference('defaultQuery', textarea.value);
				this.setStatus('Updated default query.');
			})
		);
	}

	private renderActions(): void {
		const row = append(this.contentElement, $('.sql-product-preferences-actions'));

		const resetButton = append(row, $('button.sql-product-preferences-button', { type: 'button' }, 'Reset')) as HTMLButtonElement;

		const defaultsButton = append(row, $('button.sql-product-preferences-button', { type: 'button' }, 'Fill Defaults')) as HTMLButtonElement;

		this.renderDisposables.add(
			addDisposableListener(resetButton, EventType.CLICK, () => {
				this.preferencesService.reset();
				this.setStatus('Preferences reset.');
			})
		);

		this.renderDisposables.add(
			addDisposableListener(defaultsButton, EventType.CLICK, () => {
				this.preferencesService.updatePreferences(DEFAULT_SQL_PRODUCT_PREFERENCES);
				this.setStatus('Default preferences restored.');
			})
		);
	}

	private setStatus(message: string): void {
		this.statusElement.textContent = message;
	}
}
```

---

# 6. 新增 CSS

路径：

```txt id="3cwyhi"
src/vs/workbench/contrib/sqlProduct/browser/media/sqlProductPreferences.css
```

```css id="dbs6bw"
.sql-product-preferences-view {
	box-sizing: border-box;
	height: 100%;
	width: 100%;
	display: flex;
	flex-direction: column;
	overflow: hidden;
	background: var(--vscode-editor-background);
	color: var(--vscode-editor-foreground);
}

.sql-product-preferences-content {
	flex: 1 1 auto;
	min-height: 0;
	overflow: auto;
	padding: 12px;
	outline: none;
}

.sql-product-preferences-title {
	margin: 0 0 12px;
	font-size: 13px;
	font-weight: 600;
}

.sql-product-preference-row {
	margin-bottom: 12px;
}

.sql-product-preference-checkbox {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 12px;
}

.sql-product-preference-field {
	display: flex;
	flex-direction: column;
	gap: 4px;
	font-size: 12px;
}

.sql-product-preference-input {
	width: 160px;
	height: 24px;
	color: var(--vscode-input-foreground);
	background: var(--vscode-input-background);
	border: 1px solid var(--vscode-input-border);
}

.sql-product-preference-textarea {
	box-sizing: border-box;
	width: 100%;
	min-height: 120px;
	resize: vertical;
	color: var(--vscode-input-foreground);
	background: var(--vscode-input-background);
	border: 1px solid var(--vscode-input-border);
	font-family: var(--vscode-editor-font-family);
	font-size: 12px;
	padding: 8px;
}

.sql-product-preferences-actions {
	display: flex;
	gap: 8px;
	margin-top: 16px;
}

.sql-product-preferences-button {
	height: 24px;
	padding: 0 10px;
	border: 1px solid var(--vscode-button-border);
	color: var(--vscode-button-secondaryForeground);
	background: var(--vscode-button-secondaryBackground);
	cursor: pointer;
	font-size: 12px;
}

.sql-product-preferences-button:hover {
	background: var(--vscode-button-hoverBackground);
}

.sql-product-preferences-statusbar {
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

# 7. 替换 `sqlProductActions.ts`

路径：

```txt id="qlc61q"
src/vs/workbench/contrib/sqlProduct/browser/sqlProductActions.ts
```

```ts id="6tf0yb"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product commands.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { SQL_CONNECTIONS_FOCUS_COMMAND_ID } from '../../sqlConnections/common/sqlConnections.js';
import { SQL_NEW_QUERY_COMMAND_ID } from '../../sqlEditor/common/sqlEditor.js';
import { SQL_RESULT_OPEN_COMMAND_ID } from '../../sqlResult/common/sqlResult.js';
import {
	SQL_PRODUCT_HOME_COMMAND_ID,
	SQL_PRODUCT_NEW_QUERY_COMMAND_ID,
	SQL_PRODUCT_OPEN_RESULTS_COMMAND_ID
} from '../common/sqlProduct.js';
import { ISqlProductPreferencesService } from '../common/sqlProductPreferencesService.js';
import { SQL_PRODUCT_PREFERENCES_VIEW_ID } from './sqlProductPreferencesView.js';

export const SQL_PRODUCT_OPEN_PREFERENCES_COMMAND_ID = 'sqlStudio.product.openPreferences';
export const SQL_PRODUCT_RESET_PREFERENCES_COMMAND_ID = 'sqlStudio.product.resetPreferences';
export const SQL_PRODUCT_TOGGLE_RESTORE_LAYOUT_COMMAND_ID = 'sqlStudio.product.toggleRestoreLayout';
export const SQL_PRODUCT_TOGGLE_WELCOME_QUERY_COMMAND_ID = 'sqlStudio.product.toggleWelcomeQuery';

class SqlProductHomeAction extends Action2 {
	constructor() {
		super({
			id: SQL_PRODUCT_HOME_COMMAND_ID,
			title: localize2('sqlProductHome', 'SQL Studio: Home'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);

		await commandService.executeCommand(SQL_CONNECTIONS_FOCUS_COMMAND_ID);
		await commandService.executeCommand(SQL_RESULT_OPEN_COMMAND_ID);
	}
}

class SqlProductNewQueryAction extends Action2 {
	constructor() {
		super({
			id: SQL_PRODUCT_NEW_QUERY_COMMAND_ID,
			title: localize2('sqlProductNewQuery', 'SQL Studio: New Query'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		const preferencesService = accessor.get(ISqlProductPreferencesService);

		await commandService.executeCommand(SQL_NEW_QUERY_COMMAND_ID, {
			initialSql: preferencesService.preferences.defaultQuery
		});
	}
}

class SqlProductOpenResultsAction extends Action2 {
	constructor() {
		super({
			id: SQL_PRODUCT_OPEN_RESULTS_COMMAND_ID,
			title: localize2('sqlProductOpenResults', 'SQL Studio: Open Results'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);

		await commandService.executeCommand(SQL_RESULT_OPEN_COMMAND_ID);
	}
}

class SqlProductOpenPreferencesAction extends Action2 {
	constructor() {
		super({
			id: SQL_PRODUCT_OPEN_PREFERENCES_COMMAND_ID,
			title: localize2('sqlProductOpenPreferences', 'SQL Studio: Preferences'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);

		await commandService.executeCommand(`${SQL_PRODUCT_PREFERENCES_VIEW_ID}.focus`);
	}
}

class SqlProductResetPreferencesAction extends Action2 {
	constructor() {
		super({
			id: SQL_PRODUCT_RESET_PREFERENCES_COMMAND_ID,
			title: localize2('sqlProductResetPreferences', 'SQL Studio: Reset Preferences'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const preferencesService = accessor.get(ISqlProductPreferencesService);
		const notificationService = accessor.get(INotificationService);

		preferencesService.reset();
		notificationService.info('SQL Studio preferences reset.');
	}
}

class SqlProductToggleRestoreLayoutAction extends Action2 {
	constructor() {
		super({
			id: SQL_PRODUCT_TOGGLE_RESTORE_LAYOUT_COMMAND_ID,
			title: localize2('sqlProductToggleRestoreLayout', 'SQL Studio: Toggle Restore Layout On Startup'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const preferencesService = accessor.get(ISqlProductPreferencesService);
		const notificationService = accessor.get(INotificationService);
		const next = !preferencesService.preferences.restoreSqlLayoutOnStartup;

		preferencesService.updatePreference('restoreSqlLayoutOnStartup', next);
		notificationService.info(`Restore SQL layout on startup: ${next ? 'on' : 'off'}.`);
	}
}

class SqlProductToggleWelcomeQueryAction extends Action2 {
	constructor() {
		super({
			id: SQL_PRODUCT_TOGGLE_WELCOME_QUERY_COMMAND_ID,
			title: localize2('sqlProductToggleWelcomeQuery', 'SQL Studio: Toggle Welcome Query On First Launch'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const preferencesService = accessor.get(ISqlProductPreferencesService);
		const notificationService = accessor.get(INotificationService);
		const next = !preferencesService.preferences.openWelcomeQueryOnFirstLaunch;

		preferencesService.updatePreference('openWelcomeQueryOnFirstLaunch', next);
		notificationService.info(`Open welcome query on first launch: ${next ? 'on' : 'off'}.`);
	}
}

registerAction2(SqlProductHomeAction);
registerAction2(SqlProductNewQueryAction);
registerAction2(SqlProductOpenResultsAction);
registerAction2(SqlProductOpenPreferencesAction);
registerAction2(SqlProductResetPreferencesAction);
registerAction2(SqlProductToggleRestoreLayoutAction);
registerAction2(SqlProductToggleWelcomeQueryAction);
```

---

# 8. 替换 `sqlProduct.contribution.ts`

路径：

```txt id="jwkdqc"
src/vs/workbench/contrib/sqlProduct/browser/sqlProduct.contribution.ts
```

```ts id="04328p"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product contribution.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	Extensions as WorkbenchExtensions,
	IWorkbenchContributionsRegistry,
	WorkbenchPhase
} from '../../../common/contributions.js';
import { Extensions as ViewExtensions, IViewsRegistry } from '../../../common/views.js';
import { SQL_RESULT_VIEW_CONTAINER } from '../../sqlResult/browser/sqlResult.contribution.js';
import {
	ISqlProductPreferencesService,
	SqlProductPreferencesService
} from '../common/sqlProductPreferencesService.js';
import { SqlProductBootstrapContribution } from './sqlProductBootstrap.js';
import {
	SQL_PRODUCT_PREFERENCES_VIEW_ID,
	SqlProductPreferencesView
} from './sqlProductPreferencesView.js';
import './sqlProductActions.js';
import './media/sqlProductPreferences.css';

registerSingleton(ISqlProductPreferencesService, SqlProductPreferencesService, InstantiationType.Delayed);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews(
	[
		{
			id: SQL_PRODUCT_PREFERENCES_VIEW_ID,
			name: localize2('sqlProductPreferencesView', 'Preferences'),
			ctorDescriptor: new SyncDescriptor(SqlProductPreferencesView),
			order: 2,
			canMoveView: false,
			canToggleVisibility: true,
			focusCommand: {
				id: `${SQL_PRODUCT_PREFERENCES_VIEW_ID}.focus`
			}
		}
	],
	SQL_RESULT_VIEW_CONTAINER
);

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution2(
	'workbench.contrib.sqlProductBootstrap',
	SqlProductBootstrapContribution,
	WorkbenchPhase.AfterRestored
);
```

---

# 9. 单元测试：`sqlProductPreferences.test.ts`

路径：

```txt id="5ar8nn"
src/vs/workbench/contrib/sqlProduct/test/sqlProductPreferences.test.ts
```

```ts id="w232pg"
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	DEFAULT_SQL_PRODUCT_PREFERENCES,
	deserializeSqlProductPreferences,
	getSqlProductPreferenceLabel,
	normalizeSqlProductPreferences,
	resetSqlProductPreferences,
	serializeSqlProductPreferences,
	SqlProductPreferences,
	updateSqlProductPreference
} from '../common/sqlProductPreferences.js';

test('normalizeSqlProductPreferences returns defaults for invalid input', () => {
	assert.deepEqual(
		normalizeSqlProductPreferences(undefined),
		DEFAULT_SQL_PRODUCT_PREFERENCES
	);

	assert.deepEqual(
		normalizeSqlProductPreferences(null),
		DEFAULT_SQL_PRODUCT_PREFERENCES
	);
});

test('normalizeSqlProductPreferences normalizes booleans and numbers', () => {
	const preferences = normalizeSqlProductPreferences({
		restoreSqlLayoutOnStartup: false,
		openWelcomeQueryOnFirstLaunch: true,
		restoreEditorDraftsOnStartup: false,
		autoSaveEditorDrafts: false,
		resultMaxRows: 20_000,
		maxRestoredEditorDrafts: 100,
		defaultQuery: 'SELECT 2;'
	});

	assert.equal(preferences.restoreSqlLayoutOnStartup, false);
	assert.equal(preferences.openWelcomeQueryOnFirstLaunch, true);
	assert.equal(preferences.restoreEditorDraftsOnStartup, false);
	assert.equal(preferences.autoSaveEditorDrafts, false);
	assert.equal(preferences.resultMaxRows, 10_000);
	assert.equal(preferences.maxRestoredEditorDrafts, 50);
	assert.equal(preferences.defaultQuery, 'SELECT 2;');
});

test('normalizeSqlProductPreferences clamps too small values', () => {
	const preferences = normalizeSqlProductPreferences({
		resultMaxRows: 1,
		maxRestoredEditorDrafts: -1
	});

	assert.equal(preferences.resultMaxRows, 50);
	assert.equal(preferences.maxRestoredEditorDrafts, 0);
});

test('normalizeSqlProductPreferences keeps fallback for invalid values', () => {
	const preferences = normalizeSqlProductPreferences({
		restoreSqlLayoutOnStartup: 'bad',
		resultMaxRows: Number.NaN,
		maxRestoredEditorDrafts: Number.POSITIVE_INFINITY,
		defaultQuery: '   '
	});

	assert.equal(preferences.restoreSqlLayoutOnStartup, DEFAULT_SQL_PRODUCT_PREFERENCES.restoreSqlLayoutOnStartup);
	assert.equal(preferences.resultMaxRows, DEFAULT_SQL_PRODUCT_PREFERENCES.resultMaxRows);
	assert.equal(preferences.maxRestoredEditorDrafts, DEFAULT_SQL_PRODUCT_PREFERENCES.maxRestoredEditorDrafts);
	assert.equal(preferences.defaultQuery, DEFAULT_SQL_PRODUCT_PREFERENCES.defaultQuery);
});

test('serializeSqlProductPreferences and deserializeSqlProductPreferences round trip', () => {
	const preferences: SqlProductPreferences = {
		...DEFAULT_SQL_PRODUCT_PREFERENCES,
		restoreSqlLayoutOnStartup: false,
		resultMaxRows: 500
	};

	const document = serializeSqlProductPreferences(preferences);

	assert.equal(document.version, 1);

	const restored = deserializeSqlProductPreferences(document);

	assert.equal(restored.restoreSqlLayoutOnStartup, false);
	assert.equal(restored.resultMaxRows, 500);
});

test('deserializeSqlProductPreferences rejects unknown document', () => {
	assert.deepEqual(deserializeSqlProductPreferences(undefined), DEFAULT_SQL_PRODUCT_PREFERENCES);
	assert.deepEqual(deserializeSqlProductPreferences({ version: 2, preferences: {} }), DEFAULT_SQL_PRODUCT_PREFERENCES);
	assert.deepEqual(deserializeSqlProductPreferences({ version: 1, preferences: 'bad' }), DEFAULT_SQL_PRODUCT_PREFERENCES);
});

test('updateSqlProductPreference updates one preference', () => {
	const next = updateSqlProductPreference(
		DEFAULT_SQL_PRODUCT_PREFERENCES,
		'restoreSqlLayoutOnStartup',
		false
	);

	assert.equal(next.restoreSqlLayoutOnStartup, false);
	assert.equal(next.openWelcomeQueryOnFirstLaunch, DEFAULT_SQL_PRODUCT_PREFERENCES.openWelcomeQueryOnFirstLaunch);
});

test('resetSqlProductPreferences returns defaults', () => {
	assert.deepEqual(resetSqlProductPreferences(), DEFAULT_SQL_PRODUCT_PREFERENCES);
});

test('getSqlProductPreferenceLabel returns labels', () => {
	assert.equal(getSqlProductPreferenceLabel('restoreSqlLayoutOnStartup'), 'Restore SQL layout on startup');
	assert.equal(getSqlProductPreferenceLabel('openWelcomeQueryOnFirstLaunch'), 'Open welcome query on first launch');
	assert.equal(getSqlProductPreferenceLabel('restoreEditorDraftsOnStartup'), 'Restore editor drafts on startup');
	assert.equal(getSqlProductPreferenceLabel('autoSaveEditorDrafts'), 'Auto save editor drafts');
	assert.equal(getSqlProductPreferenceLabel('resultMaxRows'), 'Max result rows');
	assert.equal(getSqlProductPreferenceLabel('maxRestoredEditorDrafts'), 'Max restored editor drafts');
	assert.equal(getSqlProductPreferenceLabel('defaultQuery'), 'Default query');
});
```

---

# 10. 单元测试：`sqlProductPreferencesService.test.ts`

路径：

```txt id="yz4af6"
src/vs/workbench/contrib/sqlProduct/test/sqlProductPreferencesService.test.ts
```

```ts id="8oswdk"
import assert from 'node:assert/strict';
import test from 'node:test';

import { Event } from '../../../../base/common/event.js';
import {
	IStorageService,
	StorageScope,
	StorageTarget
} from '../../../../platform/storage/common/storage.js';
import {
	DEFAULT_SQL_PRODUCT_PREFERENCES,
	SerializedSqlProductPreferencesDocument,
	SQL_PRODUCT_PREFERENCES_STORAGE_KEY
} from '../common/sqlProductPreferences.js';
import { SqlProductPreferencesService } from '../common/sqlProductPreferencesService.js';

class MinimalStorageService {
	private readonly values = new Map<string, unknown>();

	readonly onDidChangeTarget = Event.None;
	readonly onWillSaveState = Event.None;

	onDidChangeValue() {
		return Event.None;
	}

	getBoolean(key: string, _scope: StorageScope, fallbackValue?: boolean): boolean | undefined {
		const value = this.values.get(key);

		if (typeof value === 'boolean') {
			return value;
		}

		if (typeof value === 'string') {
			return value === 'true';
		}

		return fallbackValue;
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

test('SqlProductPreferencesService starts with defaults', () => {
	const service = new SqlProductPreferencesService(createStorage());

	assert.deepEqual(service.preferences, DEFAULT_SQL_PRODUCT_PREFERENCES);

	service.dispose();
});

test('SqlProductPreferencesService updates one preference', () => {
	const storage = createStorage();
	const service = new SqlProductPreferencesService(storage);

	service.updatePreference('restoreSqlLayoutOnStartup', false);

	assert.equal(service.preferences.restoreSqlLayoutOnStartup, false);

	const stored = storage.getObject<SerializedSqlProductPreferencesDocument>(
		SQL_PRODUCT_PREFERENCES_STORAGE_KEY,
		StorageScope.PROFILE
	);

	assert.ok(stored);
	assert.equal(stored.version, 1);
	assert.equal(stored.preferences.restoreSqlLayoutOnStartup, false);

	service.dispose();
});

test('SqlProductPreferencesService updates multiple preferences', () => {
	const service = new SqlProductPreferencesService(createStorage());

	service.updatePreferences({
		restoreSqlLayoutOnStartup: false,
		resultMaxRows: 500
	});

	assert.equal(service.preferences.restoreSqlLayoutOnStartup, false);
	assert.equal(service.preferences.resultMaxRows, 500);

	service.dispose();
});

test('SqlProductPreferencesService resets preferences', () => {
	const service = new SqlProductPreferencesService(createStorage());

	service.updatePreference('restoreSqlLayoutOnStartup', false);
	service.reset();

	assert.deepEqual(service.preferences, DEFAULT_SQL_PRODUCT_PREFERENCES);

	service.dispose();
});

test('SqlProductPreferencesService fires change events', () => {
	const service = new SqlProductPreferencesService(createStorage());
	let count = 0;

	const disposable = service.onDidChangePreferences(() => {
		count++;
	});

	service.updatePreference('restoreSqlLayoutOnStartup', false);

	assert.equal(count, 1);

	disposable.dispose();
	service.dispose();
});

test('SqlProductPreferencesService loads persisted preferences', () => {
	const storage = createStorage();
	const first = new SqlProductPreferencesService(storage);

	first.updatePreference('resultMaxRows', 500);
	first.dispose();

	const second = new SqlProductPreferencesService(storage);

	assert.equal(second.preferences.resultMaxRows, 500);

	second.dispose();
});
```

---

# 11. 修改 `sqlProductBootstrapModel.test.ts`

路径：

```txt id="lzd67d"
src/vs/workbench/contrib/sqlProduct/test/sqlProductBootstrapModel.test.ts
```

把旧的 `restoreSqlLayout / openWelcomeQuery` 参数用法换成 preferences。

核心替换后的完整测试：

```ts id="pvx2xh"
import assert from 'node:assert/strict';
import test from 'node:test';

import { SQL_CONNECTIONS_FOCUS_COMMAND_ID } from '../../sqlConnections/common/sqlConnections.js';
import { SQL_NEW_QUERY_COMMAND_ID } from '../../sqlEditor/common/sqlEditor.js';
import { SQL_RESULT_OPEN_COMMAND_ID } from '../../sqlResult/common/sqlResult.js';
import {
	createSqlProductStartupPlan,
	dedupeStartupCommands,
	shouldRunSqlProductBootstrap,
	SqlProductStartupCommandKind
} from '../common/sqlProductBootstrapModel.js';
import { DEFAULT_SQL_PRODUCT_PREFERENCES } from '../common/sqlProductPreferences.js';

test('shouldRunSqlProductBootstrap runs on first launch', () => {
	assert.equal(
		shouldRunSqlProductBootstrap({
			alreadyBootstrapped: false
		}),
		true
	);
});

test('shouldRunSqlProductBootstrap skips after bootstrapped', () => {
	assert.equal(
		shouldRunSqlProductBootstrap({
			alreadyBootstrapped: true
		}),
		false
	);
});

test('shouldRunSqlProductBootstrap respects force', () => {
	assert.equal(
		shouldRunSqlProductBootstrap({
			alreadyBootstrapped: true,
			force: true
		}),
		true
	);
});

test('createSqlProductStartupPlan creates SQL layout plan from preferences', () => {
	const plan = createSqlProductStartupPlan({
		alreadyBootstrapped: false,
		preferences: DEFAULT_SQL_PRODUCT_PREFERENCES
	});

	assert.deepEqual(
		plan.map(item => item.kind),
		[
			SqlProductStartupCommandKind.FocusConnections,
			SqlProductStartupCommandKind.OpenResults
		]
	);

	assert.deepEqual(
		plan.map(item => item.commandId),
		[
			SQL_CONNECTIONS_FOCUS_COMMAND_ID,
			SQL_RESULT_OPEN_COMMAND_ID
		]
	);
});

test('createSqlProductStartupPlan skips when already bootstrapped', () => {
	const plan = createSqlProductStartupPlan({
		alreadyBootstrapped: true,
		preferences: DEFAULT_SQL_PRODUCT_PREFERENCES
	});

	assert.deepEqual(plan, []);
});

test('createSqlProductStartupPlan can skip layout restore through preferences', () => {
	const plan = createSqlProductStartupPlan({
		alreadyBootstrapped: false,
		preferences: {
			...DEFAULT_SQL_PRODUCT_PREFERENCES,
			restoreSqlLayoutOnStartup: false
		}
	});

	assert.deepEqual(plan, []);
});

test('createSqlProductStartupPlan can open welcome query through preferences', () => {
	const plan = createSqlProductStartupPlan({
		alreadyBootstrapped: false,
		preferences: {
			...DEFAULT_SQL_PRODUCT_PREFERENCES,
			restoreSqlLayoutOnStartup: false,
			openWelcomeQueryOnFirstLaunch: true,
			defaultQuery: 'SELECT 42;'
		}
	});

	assert.equal(plan.length, 1);
	assert.equal(plan[0].kind, SqlProductStartupCommandKind.NewQuery);
	assert.equal(plan[0].commandId, SQL_NEW_QUERY_COMMAND_ID);
	assert.deepEqual(plan[0].args, [
		{
			initialSql: 'SELECT 42;'
		}
	]);
});

test('dedupeStartupCommands removes duplicate command args pairs', () => {
	const plan = dedupeStartupCommands([
		{
			kind: SqlProductStartupCommandKind.FocusConnections,
			commandId: SQL_CONNECTIONS_FOCUS_COMMAND_ID
		},
		{
			kind: SqlProductStartupCommandKind.FocusConnections,
			commandId: SQL_CONNECTIONS_FOCUS_COMMAND_ID
		},
		{
			kind: SqlProductStartupCommandKind.OpenResults,
			commandId: SQL_RESULT_OPEN_COMMAND_ID
		}
	]);

	assert.deepEqual(
		plan.map(item => item.commandId),
		[
			SQL_CONNECTIONS_FOCUS_COMMAND_ID,
			SQL_RESULT_OPEN_COMMAND_ID
		]
	);
});
```

---

# 12. 修改 `package.json`

当前总测试已经有 `test:sql-product`。

把 `test:sql-product` 改成：

```json id="21d3yi"
{
  "scripts": {
    "test:sql-product": "node --test --import tsx src/vs/workbench/contrib/sqlProduct/test/sqlProductProfile.test.ts src/vs/workbench/contrib/sqlProduct/test/sqlProductBootstrapModel.test.ts src/vs/workbench/contrib/sqlProduct/test/sqlProductPreferences.test.ts src/vs/workbench/contrib/sqlProduct/test/sqlProductPreferencesService.test.ts"
  }
}
```

总 `test` 不用改。

---

# 13. 验收命令

```bash id="pc1b58"
pnpm run test:sql-product
pnpm run test
pnpm run lint
pnpm run build
```

---

# 14. 手动验收

```txt id="2p4j3e"
1. 启动应用
2. Command Palette 执行 SQL Studio: Preferences
3. SQL Results Panel 下出现 Preferences View
4. 修改 Restore SQL layout on startup
5. 重启应用，布局恢复行为按偏好变化
6. 修改 Open welcome query on first launch
7. Reset Preferences 后恢复默认值
8. SQL Studio: New Query 使用 Preferences 里的 defaultQuery
9. 不出现 VS Code Settings JSON / 多数据库 / AI / 插件入口
```

---

# Phase 8.5 完成标准

```txt id="dmmp7m"
1. 有 SQL Studio 独立本地偏好模型
2. 偏好持久化到 profile storage
3. 启动布局读取偏好
4. New Query 读取 defaultQuery 偏好
5. 有 Preferences View
6. 有 Reset / Toggle 命令
7. 有完整单元测试
8. 不接入全局 Settings，不引入新产品范围
```

---

# 后续 Phase 8.6

```txt id="p6f5st"
Phase 8.6：物理 Workbench 裁剪试点

1. 从 Explorer/Search/SCM/Debug/Extensions 中选择一个最独立模块先裁
2. 观察启动命令、菜单、服务依赖
3. 建立裁剪 guard 测试
4. 再逐步扩大裁剪范围
```
