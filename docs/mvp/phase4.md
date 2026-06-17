# Phase 4：SQL Connections Activity + Connection Tree

本阶段目标是把 Phase 3 的 SQL Service 暴露到 Workbench UI 里，形成第一个 SQL Studio 专属入口：

```txt
Activity Bar
└─ SQL Connections

Side Bar
└─ Connections View
   ├─ 连接表单
   ├─ Refresh
   └─ Connection Tree
      ├─ SQLite connection
      │  ├─ Tables
      │  │  └─ table
      │  │     └─ columns
      │  └─ Views
      └─ error / empty state
```

当前项目已经在 `workbench.common.main.ts` 中引入了 SQL service contribution，说明 Phase 3 的服务注册已经进入 Workbench 启动链路。
SideX/VS Code 现有的 ViewContainer 注册模式可以参考 Explorer：通过 `IViewContainersRegistry.registerViewContainer(...)` 注册 Activity Bar 入口，再通过 `IViewsRegistry.registerViews(...)` 注册具体 View。
自定义 View 的主体可以继承 `ViewPane`，它提供 `renderBody(container)` 作为内容渲染入口。

---

# Phase 4 边界

本阶段做：

```txt
1. 注册 SQL Connections Activity
2. 注册 SQL Connections View
3. 提供 SQLite 连接表单
4. 调用 ISqlConnectionService 打开/关闭连接
5. 调用 ISqlMetadataService 拉取 tables / columns
6. 渲染 Connection Tree
7. 补纯模型单元测试
```

本阶段不做：

```txt
1. SQL EditorInput
2. Result Panel
3. 查询执行按钮
4. 右键菜单
5. Native file picker
6. MySQL / Postgres
7. AI Agent
```

---

# 文件结构

新增：

```txt
src/vs/workbench/contrib/sqlConnections/
├─ common/
│  ├─ sqlConnections.ts
│  └─ sqlConnectionTreeModel.ts
├─ browser/
│  ├─ sqlConnections.contribution.ts
│  ├─ sqlConnectionsView.ts
│  └─ media/
│     └─ sqlConnections.css
└─ test/
   └─ sqlConnectionTreeModel.test.ts
```

修改：

```txt
src/vs/workbench/workbench.common.main.ts
package.json
```

---

# 1. 新增 `src/vs/workbench/contrib/sqlConnections/common/sqlConnections.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Connections contribution constants.
 *--------------------------------------------------------------------------------------------*/

export const SQL_CONNECTIONS_VIEWLET_ID = 'workbench.view.sqlConnections';
export const SQL_CONNECTIONS_VIEW_ID = 'sqlStudio.connections';

export const SQL_CONNECTIONS_STORAGE_ID = 'workbench.sqlConnections.views.state';

export const SQL_CONNECTIONS_FOCUS_COMMAND_ID = SQL_CONNECTIONS_VIEWLET_ID;
```

---

# 2. 新增 `src/vs/workbench/contrib/sqlConnections/common/sqlConnectionTreeModel.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL connection tree model.
 *--------------------------------------------------------------------------------------------*/

import { SqlColumn, SqlConnection, SqlTable, SqlTableType } from '../../../services/sql/common/sqlTypes.js';

export const enum SqlConnectionTreeNodeType {
	Empty = 'empty',
	Error = 'error',
	Connection = 'connection',
	Group = 'group',
	Table = 'table',
	View = 'view',
	Column = 'column'
}

export interface SqlConnectionTreeNode {
	id: string;
	type: SqlConnectionTreeNodeType;
	label: string;
	description?: string;
	connectionId?: string;
	schema?: string;
	tableName?: string;
	columnName?: string;
	children?: SqlConnectionTreeNode[];
}

export interface SqlConnectionTreeSnapshot {
	connections: SqlConnection[];
	tablesByConnectionId?: Record<string, SqlTable[]>;
	columnsByTableId?: Record<string, SqlColumn[]>;
	errorsByConnectionId?: Record<string, string>;
}

export function buildSqlConnectionTree(snapshot: SqlConnectionTreeSnapshot): SqlConnectionTreeNode[] {
	const connections = [...snapshot.connections].sort(compareConnections);

	if (connections.length === 0) {
		return [
			{
				id: 'sql.empty',
				type: SqlConnectionTreeNodeType.Empty,
				label: 'No database connections',
				description: 'Add a SQLite connection to start browsing schemas.'
			}
		];
	}

	return connections.map(connection =>
		buildConnectionNode(
			connection,
			snapshot.tablesByConnectionId?.[connection.id] ?? [],
			snapshot.columnsByTableId ?? {},
			snapshot.errorsByConnectionId?.[connection.id]
		)
	);
}

export function getTableNodeId(connectionId: string, table: Pick<SqlTable, 'schema' | 'name' | 'tableType'>): string {
	return [
		'sql',
		'connection',
		escapeNodeId(connectionId),
		table.tableType,
		escapeNodeId(table.schema ?? 'main'),
		escapeNodeId(table.name)
	].join('/');
}

export function getColumnNodeId(
	connectionId: string,
	table: Pick<SqlTable, 'schema' | 'name' | 'tableType'>,
	column: Pick<SqlColumn, 'name'>
): string {
	return [getTableNodeId(connectionId, table), 'column', escapeNodeId(column.name)].join('/');
}

export function getColumnsKey(connectionId: string, table: Pick<SqlTable, 'schema' | 'name' | 'tableType'>): string {
	return getTableNodeId(connectionId, table);
}

function buildConnectionNode(
	connection: SqlConnection,
	tables: SqlTable[],
	columnsByTableId: Record<string, SqlColumn[]>,
	error?: string
): SqlConnectionTreeNode {
	const children: SqlConnectionTreeNode[] = [];

	if (error) {
		children.push({
			id: `sql/connection/${escapeNodeId(connection.id)}/error`,
			type: SqlConnectionTreeNodeType.Error,
			label: 'Failed to load metadata',
			description: error,
			connectionId: connection.id
		});
	}

	const tableNodes = buildTableNodes(connection.id, tables, SqlTableType.Table, columnsByTableId);
	const viewNodes = buildTableNodes(connection.id, tables, SqlTableType.View, columnsByTableId);

	if (tableNodes.length > 0) {
		children.push({
			id: `sql/connection/${escapeNodeId(connection.id)}/tables`,
			type: SqlConnectionTreeNodeType.Group,
			label: 'Tables',
			description: String(tableNodes.length),
			connectionId: connection.id,
			children: tableNodes
		});
	}

	if (viewNodes.length > 0) {
		children.push({
			id: `sql/connection/${escapeNodeId(connection.id)}/views`,
			type: SqlConnectionTreeNodeType.Group,
			label: 'Views',
			description: String(viewNodes.length),
			connectionId: connection.id,
			children: viewNodes
		});
	}

	if (children.length === 0) {
		children.push({
			id: `sql/connection/${escapeNodeId(connection.id)}/empty`,
			type: SqlConnectionTreeNodeType.Empty,
			label: 'No tables or views',
			description: 'The database is empty or metadata has not been loaded.',
			connectionId: connection.id
		});
	}

	return {
		id: `sql/connection/${escapeNodeId(connection.id)}`,
		type: SqlConnectionTreeNodeType.Connection,
		label: connection.name,
		description: connection.readOnly ? 'SQLite · read-only' : 'SQLite',
		connectionId: connection.id,
		children
	};
}

function buildTableNodes(
	connectionId: string,
	tables: SqlTable[],
	tableType: SqlTableType,
	columnsByTableId: Record<string, SqlColumn[]>
): SqlConnectionTreeNode[] {
	return tables
		.filter(table => table.tableType === tableType)
		.sort(compareTables)
		.map(table => {
			const tableNodeId = getTableNodeId(connectionId, table);
			const columns = [...(columnsByTableId[tableNodeId] ?? [])].sort(compareColumns);

			return {
				id: tableNodeId,
				type: table.tableType === SqlTableType.View ? SqlConnectionTreeNodeType.View : SqlConnectionTreeNodeType.Table,
				label: table.name,
				description: table.schema,
				connectionId,
				schema: table.schema,
				tableName: table.name,
				children: columns.map(column => ({
					id: getColumnNodeId(connectionId, table, column),
					type: SqlConnectionTreeNodeType.Column,
					label: column.name,
					description: describeColumn(column),
					connectionId,
					schema: table.schema,
					tableName: table.name,
					columnName: column.name
				}))
			};
		});
}

function describeColumn(column: SqlColumn): string {
	const parts: string[] = [];

	if (column.dataType) {
		parts.push(column.dataType);
	}

	if (column.primaryKey) {
		parts.push('PK');
	}

	if (column.notNull) {
		parts.push('NOT NULL');
	}

	if (column.defaultValue) {
		parts.push(`DEFAULT ${column.defaultValue}`);
	}

	return parts.join(' · ');
}

function compareConnections(left: SqlConnection, right: SqlConnection): number {
	return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function compareTables(left: SqlTable, right: SqlTable): number {
	return (left.schema ?? '').localeCompare(right.schema ?? '') || left.name.localeCompare(right.name);
}

function compareColumns(left: SqlColumn, right: SqlColumn): number {
	return left.ordinal - right.ordinal || left.name.localeCompare(right.name);
}

function escapeNodeId(value: string): string {
	return encodeURIComponent(value);
}
```

---

# 3. 新增 `src/vs/workbench/contrib/sqlConnections/browser/sqlConnectionsView.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Connections View.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlConnections.css';

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ISqlConnectionService } from '../../../services/sql/common/sqlConnection.js';
import { ISqlMetadataService } from '../../../services/sql/common/sqlMetadata.js';
import { SqlColumn, SqlConnection, SqlConnectionKind, SqlTable } from '../../../services/sql/common/sqlTypes.js';
import {
	buildSqlConnectionTree,
	getColumnsKey,
	SqlConnectionTreeNode,
	SqlConnectionTreeNodeType
} from '../common/sqlConnectionTreeModel.js';
import { SQL_CONNECTIONS_VIEW_ID } from '../common/sqlConnections.js';

interface SqlConnectionTreeSnapshotState {
	connections: SqlConnection[];
	tablesByConnectionId: Record<string, SqlTable[]>;
	columnsByTableId: Record<string, SqlColumn[]>;
	errorsByConnectionId: Record<string, string>;
}

export class SqlConnectionsView extends ViewPane {
	static readonly ID = SQL_CONNECTIONS_VIEW_ID;
	static readonly NAME = localize('sqlConnectionsViewName', 'Connections');

	private readonly viewDisposables = this._register(new DisposableStore());

	private body!: HTMLElement;
	private form!: HTMLFormElement;
	private nameInput!: HTMLInputElement;
	private databasePathInput!: HTMLInputElement;
	private readOnlyInput!: HTMLInputElement;
	private createIfMissingInput!: HTMLInputElement;
	private messageElement!: HTMLElement;
	private treeElement!: HTMLElement;

	private readonly expandedNodes = new Set<string>();

	private readonly state: SqlConnectionTreeSnapshotState = {
		connections: [],
		tablesByConnectionId: Object.create(null),
		columnsByTableId: Object.create(null),
		errorsByConnectionId: Object.create(null)
	};

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
		@ISqlConnectionService private readonly sqlConnectionService: ISqlConnectionService,
		@ISqlMetadataService private readonly sqlMetadataService: ISqlMetadataService
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
		this.body = append(container, $('.sql-connections-view'));
		this.renderConnectionForm(this.body);
		this.messageElement = append(this.body, $('.sql-connections-message'));
		this.treeElement = append(this.body, $('.sql-connections-tree', { role: 'tree' }));

		this.databasePathInput.value = ':memory:';
		this.createIfMissingInput.checked = true;

		this.refresh().catch(error => this.showError(error));
	}

	override focus(): void {
		this.treeElement?.focus();
		super.focus();
	}

	async refresh(): Promise<void> {
		this.showInfo('Loading connections...');

		try {
			const connections = await this.sqlConnectionService.listConnections();

			this.state.connections = connections;
			this.state.tablesByConnectionId = Object.create(null);
			this.state.columnsByTableId = Object.create(null);
			this.state.errorsByConnectionId = Object.create(null);

			for (const connection of connections) {
				await this.loadConnectionMetadata(connection);
			}

			this.showInfo(connections.length === 0 ? 'No connections yet.' : '');
			this.renderTree();
		} catch (error) {
			this.showError(error);
		}
	}

	async addConnectionFromForm(): Promise<void> {
		const databasePath = this.databasePathInput.value.trim();
		const name = this.nameInput.value.trim();

		if (!databasePath) {
			this.showInfo('Database path is required.');
			this.databasePathInput.focus();
			return;
		}

		this.showInfo('Opening SQLite connection...');

		try {
			const connection = await this.sqlConnectionService.openConnection({
				name: name || undefined,
				kind: SqlConnectionKind.Sqlite,
				databasePath,
				readOnly: this.readOnlyInput.checked,
				createIfMissing: this.createIfMissingInput.checked
			});

			this.expandedNodes.add(`sql/connection/${encodeURIComponent(connection.id)}`);
			this.showInfo(`Connected to ${connection.name}.`);
			await this.refresh();
		} catch (error) {
			this.showError(error);
		}
	}

	private renderConnectionForm(container: HTMLElement): void {
		this.form = append(container, $('form.sql-connections-form'));

		const nameLabel = append(this.form, $('label.sql-connections-field'));
		append(nameLabel, $('span', undefined, 'Name'));
		this.nameInput = append(
			nameLabel,
			$('input.sql-connections-input', {
				type: 'text',
				placeholder: 'Local SQLite'
			})
		) as HTMLInputElement;

		const pathLabel = append(this.form, $('label.sql-connections-field'));
		append(pathLabel, $('span', undefined, 'Database path'));
		this.databasePathInput = append(
			pathLabel,
			$('input.sql-connections-input', {
				type: 'text',
				placeholder: '/absolute/path/to/database.db or :memory:'
			})
		) as HTMLInputElement;

		const options = append(this.form, $('.sql-connections-options'));

		const readOnlyLabel = append(options, $('label.sql-connections-checkbox'));
		this.readOnlyInput = append(readOnlyLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
		append(readOnlyLabel, $('span', undefined, 'Read-only'));

		const createLabel = append(options, $('label.sql-connections-checkbox'));
		this.createIfMissingInput = append(createLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
		append(createLabel, $('span', undefined, 'Create if missing'));

		const actions = append(this.form, $('.sql-connections-actions'));
		const connectButton = append(
			actions,
			$('button.sql-connections-button.primary', { type: 'submit' }, 'Connect')
		) as HTMLButtonElement;
		const refreshButton = append(
			actions,
			$('button.sql-connections-button', { type: 'button' }, 'Refresh')
		) as HTMLButtonElement;

		this.viewDisposables.add(
			addDisposableListener(this.form, EventType.SUBMIT, event => {
				event.preventDefault();
				this.addConnectionFromForm().catch(error => this.showError(error));
			})
		);

		this.viewDisposables.add(
			addDisposableListener(refreshButton, EventType.CLICK, () => {
				this.refresh().catch(error => this.showError(error));
			})
		);

		this.viewDisposables.add(
			addDisposableListener(connectButton, EventType.CLICK, () => {
				// The submit listener performs the actual work. This keeps Enter and click behavior aligned.
			})
		);
	}

	private async loadConnectionMetadata(connection: SqlConnection): Promise<void> {
		try {
			const tables = await this.sqlMetadataService.listTables(connection.id);
			this.state.tablesByConnectionId[connection.id] = tables;

			for (const table of tables) {
				const columns = await this.sqlMetadataService.listColumns({
					connectionId: connection.id,
					schema: table.schema,
					tableName: table.name
				});

				this.state.columnsByTableId[getColumnsKey(connection.id, table)] = columns;
			}
		} catch (error) {
			this.state.errorsByConnectionId[connection.id] = error instanceof Error ? error.message : String(error);
		}
	}

	private renderTree(): void {
		clearNode(this.treeElement);

		const nodes = buildSqlConnectionTree(this.state);

		for (const node of nodes) {
			this.treeElement.appendChild(this.renderNode(node, 0));
		}
	}

	private renderNode(node: SqlConnectionTreeNode, depth: number): HTMLElement {
		const wrapper = $('.sql-connection-node-wrapper');
		const row = append(wrapper, $('.sql-connection-node', { role: 'treeitem' }));

		row.style.paddingLeft = `${8 + depth * 14}px`;
		row.classList.add(`type-${node.type}`);

		const hasChildren = Boolean(node.children?.length);
		const isExpanded = this.isExpanded(node);

		const twisty = append(
			row,
			$('button.sql-connection-node-twisty', {
				type: 'button',
				tabIndex: hasChildren ? 0 : -1,
				'aria-label': isExpanded ? 'Collapse' : 'Expand'
			})
		) as HTMLButtonElement;
		twisty.textContent = hasChildren ? (isExpanded ? '▾' : '▸') : '';

		if (hasChildren) {
			this.viewDisposables.add(
				addDisposableListener(twisty, EventType.CLICK, event => {
					event.preventDefault();
					event.stopPropagation();
					this.toggleNode(node.id);
				})
			);
		}

		const icon = append(row, $('span.sql-connection-node-icon'));
		icon.textContent = getNodeIcon(node);

		const label = append(row, $('span.sql-connection-node-label'));
		label.textContent = node.label;

		if (node.description) {
			const description = append(row, $('span.sql-connection-node-description'));
			description.textContent = node.description;
		}

		if (node.type === SqlConnectionTreeNodeType.Connection && node.connectionId) {
			const closeButton = append(
				row,
				$('button.sql-connection-node-action', {
					type: 'button',
					title: 'Close connection'
				})
			) as HTMLButtonElement;
			closeButton.textContent = '×';

			this.viewDisposables.add(
				addDisposableListener(closeButton, EventType.CLICK, event => {
					event.preventDefault();
					event.stopPropagation();
					this.closeConnection(node.connectionId!).catch(error => this.showError(error));
				})
			);
		}

		if (hasChildren && isExpanded) {
			const children = append(wrapper, $('.sql-connection-node-children', { role: 'group' }));
			for (const child of node.children!) {
				children.appendChild(this.renderNode(child, depth + 1));
			}
		}

		return wrapper;
	}

	private async closeConnection(connectionId: string): Promise<void> {
		await this.sqlConnectionService.closeConnection(connectionId);
		this.showInfo('Connection closed.');
		await this.refresh();
	}

	private toggleNode(nodeId: string): void {
		if (this.expandedNodes.has(nodeId)) {
			this.expandedNodes.delete(nodeId);
		} else {
			this.expandedNodes.add(nodeId);
		}

		this.renderTree();
	}

	private isExpanded(node: SqlConnectionTreeNode): boolean {
		if (node.type === SqlConnectionTreeNodeType.Connection || node.type === SqlConnectionTreeNodeType.Group) {
			return !this.expandedNodes.has(node.id) || this.expandedNodes.has(node.id);
		}

		return this.expandedNodes.has(node.id);
	}

	private showInfo(message: string): void {
		if (!this.messageElement) {
			return;
		}

		this.messageElement.classList.remove('error');
		this.messageElement.textContent = message;
	}

	private showError(error: unknown): void {
		if (!this.messageElement) {
			return;
		}

		this.messageElement.classList.add('error');
		this.messageElement.textContent = error instanceof Error ? error.message : String(error);
	}
}

function getNodeIcon(node: SqlConnectionTreeNode): string {
	switch (node.type) {
		case SqlConnectionTreeNodeType.Connection:
			return '◉';
		case SqlConnectionTreeNodeType.Group:
			return '▣';
		case SqlConnectionTreeNodeType.Table:
			return '▦';
		case SqlConnectionTreeNodeType.View:
			return '◫';
		case SqlConnectionTreeNodeType.Column:
			return '•';
		case SqlConnectionTreeNodeType.Error:
			return '!';
		case SqlConnectionTreeNodeType.Empty:
		default:
			return '·';
	}
}
```

> 这里先用轻量 DOM 渲染树，不引入复杂 `WorkbenchTree`。Phase 4 的核心是打通 Activity + View + Service，Phase 5/6 后再替换成 VS Code 原生 Tree 也不迟。

---

# 4. 新增 `src/vs/workbench/contrib/sqlConnections/browser/sqlConnections.contribution.ts`

```ts
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Connections workbench contribution.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlConnections.css';

import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
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
	Extensions,
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainer,
	ViewContainerLocation
} from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { SqlConnectionsView } from './sqlConnectionsView.js';
import {
	SQL_CONNECTIONS_FOCUS_COMMAND_ID,
	SQL_CONNECTIONS_STORAGE_ID,
	SQL_CONNECTIONS_VIEW_ID,
	SQL_CONNECTIONS_VIEWLET_ID
} from '../common/sqlConnections.js';

const sqlConnectionsIcon = registerIcon(
	'sql-connections-view-icon',
	Codicon.repo,
	localize('sqlConnectionsViewIcon', 'View icon of the SQL Connections view.')
);

export class SqlConnectionsViewPaneContainer extends ViewPaneContainer {
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
			SQL_CONNECTIONS_VIEWLET_ID,
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
		parent.classList.add('sql-connections-viewlet');
	}
}

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry);

export const SQL_CONNECTIONS_VIEW_CONTAINER: ViewContainer = viewContainerRegistry.registerViewContainer(
	{
		id: SQL_CONNECTIONS_VIEWLET_ID,
		title: localize2('sqlConnections', 'SQL Connections'),
		ctorDescriptor: new SyncDescriptor(SqlConnectionsViewPaneContainer),
		storageId: SQL_CONNECTIONS_STORAGE_ID,
		icon: sqlConnectionsIcon,
		alwaysUseContainerInfo: true,
		hideIfEmpty: false,
		order: 1,
		openCommandActionDescriptor: {
			id: SQL_CONNECTIONS_FOCUS_COMMAND_ID,
			title: localize2('sqlConnections', 'SQL Connections'),
			mnemonicTitle: localize({ key: 'miViewSqlConnections', comment: ['&& denotes a mnemonic'] }, 'SQL &&Connections'),
			order: 1
		}
	},
	ViewContainerLocation.Sidebar
);

const viewsRegistry = Registry.as<IViewsRegistry>(Extensions.ViewsRegistry);

viewsRegistry.registerViews(
	[
		{
			id: SQL_CONNECTIONS_VIEW_ID,
			name: localize2('sqlConnectionsView', 'Connections'),
			containerIcon: sqlConnectionsIcon,
			ctorDescriptor: new SyncDescriptor(SqlConnectionsView),
			order: 0,
			canMoveView: false,
			canToggleVisibility: false,
			focusCommand: {
				id: SQL_CONNECTIONS_FOCUS_COMMAND_ID
			}
		}
	],
	SQL_CONNECTIONS_VIEW_CONTAINER
);
```

---

# 5. 新增 `src/vs/workbench/contrib/sqlConnections/browser/media/sqlConnections.css`

```css
.sql-connections-viewlet {
	min-width: 0;
}

.sql-connections-view {
	box-sizing: border-box;
	height: 100%;
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 8px;
	overflow: hidden;
}

.sql-connections-form {
	display: flex;
	flex-direction: column;
	gap: 8px;
	flex: 0 0 auto;
}

.sql-connections-field {
	display: flex;
	flex-direction: column;
	gap: 4px;
	font-size: 11px;
	opacity: 0.95;
}

.sql-connections-input {
	box-sizing: border-box;
	width: 100%;
	height: 26px;
	padding: 3px 6px;
	border: 1px solid var(--vscode-input-border);
	color: var(--vscode-input-foreground);
	background: var(--vscode-input-background);
	outline: none;
}

.sql-connections-input:focus {
	border-color: var(--vscode-focusBorder);
}

.sql-connections-options {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	font-size: 11px;
}

.sql-connections-checkbox {
	display: inline-flex;
	align-items: center;
	gap: 4px;
}

.sql-connections-actions {
	display: flex;
	gap: 6px;
}

.sql-connections-button {
	height: 26px;
	padding: 0 10px;
	border: 1px solid var(--vscode-button-border);
	color: var(--vscode-button-secondaryForeground);
	background: var(--vscode-button-secondaryBackground);
	cursor: pointer;
}

.sql-connections-button.primary {
	color: var(--vscode-button-foreground);
	background: var(--vscode-button-background);
}

.sql-connections-button:hover {
	background: var(--vscode-button-hoverBackground);
}

.sql-connections-message {
	min-height: 18px;
	font-size: 11px;
	opacity: 0.85;
	white-space: pre-wrap;
}

.sql-connections-message.error {
	color: var(--vscode-errorForeground);
	opacity: 1;
}

.sql-connections-tree {
	flex: 1 1 auto;
	overflow: auto;
	outline: none;
	font-size: 12px;
}

.sql-connection-node-wrapper {
	min-width: 0;
}

.sql-connection-node {
	display: flex;
	align-items: center;
	min-height: 22px;
	gap: 4px;
	white-space: nowrap;
	user-select: none;
}

.sql-connection-node:hover {
	background: var(--vscode-list-hoverBackground);
}

.sql-connection-node-twisty {
	width: 16px;
	height: 20px;
	padding: 0;
	border: 0;
	color: inherit;
	background: transparent;
	cursor: pointer;
}

.sql-connection-node-icon {
	width: 16px;
	text-align: center;
	opacity: 0.85;
}

.sql-connection-node-label {
	overflow: hidden;
	text-overflow: ellipsis;
}

.sql-connection-node-description {
	margin-left: 4px;
	opacity: 0.62;
	overflow: hidden;
	text-overflow: ellipsis;
}

.sql-connection-node-action {
	margin-left: auto;
	width: 20px;
	height: 20px;
	padding: 0;
	border: 0;
	color: inherit;
	background: transparent;
	cursor: pointer;
	opacity: 0;
}

.sql-connection-node:hover .sql-connection-node-action {
	opacity: 0.8;
}

.sql-connection-node.type-error .sql-connection-node-label,
.sql-connection-node.type-error .sql-connection-node-description {
	color: var(--vscode-errorForeground);
}

.sql-connection-node.type-empty {
	opacity: 0.75;
}
```

---

# 6. 修改 `src/vs/workbench/workbench.common.main.ts`

在 workbench contributions 区域追加 SQL Connections contribution。

建议放在 Explorer 之后：

```ts
// Explorer
import './contrib/files/browser/explorerViewlet.js';
import './contrib/files/browser/fileActions.contribution.js';
import './contrib/files/browser/files.contribution.js';

// SQL Studio
import './contrib/sqlConnections/browser/sqlConnections.contribution.js';
```

这和当前 `workbench.common.main.ts` 的集中 import 风格一致，现有文件也是通过 import contribution 文件触发注册。

---

# 7. 新增单元测试 `src/vs/workbench/contrib/sqlConnections/test/sqlConnectionTreeModel.test.ts`

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildSqlConnectionTree,
	getColumnNodeId,
	getColumnsKey,
	getTableNodeId,
	SqlConnectionTreeNodeType
} from '../common/sqlConnectionTreeModel.js';
import { SqlConnectionKind, SqlTableType } from '../../../services/sql/common/sqlTypes.js';

test('buildSqlConnectionTree returns empty node when there are no connections', () => {
	const nodes = buildSqlConnectionTree({
		connections: []
	});

	assert.equal(nodes.length, 1);
	assert.equal(nodes[0].type, SqlConnectionTreeNodeType.Empty);
	assert.equal(nodes[0].label, 'No database connections');
});

test('buildSqlConnectionTree sorts connections by name', () => {
	const nodes = buildSqlConnectionTree({
		connections: [
			{
				id: 'b',
				name: 'Beta',
				kind: SqlConnectionKind.Sqlite,
				databasePath: '/tmp/b.db',
				readOnly: false
			},
			{
				id: 'a',
				name: 'Alpha',
				kind: SqlConnectionKind.Sqlite,
				databasePath: '/tmp/a.db',
				readOnly: false
			}
		]
	});

	assert.equal(nodes.length, 2);
	assert.equal(nodes[0].label, 'Alpha');
	assert.equal(nodes[1].label, 'Beta');
});

test('buildSqlConnectionTree groups tables and views with columns', () => {
	const usersTable = {
		schema: 'main',
		name: 'users',
		tableType: SqlTableType.Table
	};

	const activeUsersView = {
		schema: 'main',
		name: 'active_users',
		tableType: SqlTableType.View
	};

	const usersKey = getColumnsKey('local', usersTable);

	const nodes = buildSqlConnectionTree({
		connections: [
			{
				id: 'local',
				name: 'Local SQLite',
				kind: SqlConnectionKind.Sqlite,
				databasePath: '/tmp/app.db',
				readOnly: false
			}
		],
		tablesByConnectionId: {
			local: [activeUsersView, usersTable]
		},
		columnsByTableId: {
			[usersKey]: [
				{
					name: 'name',
					ordinal: 1,
					dataType: 'TEXT',
					notNull: true,
					primaryKey: false
				},
				{
					name: 'id',
					ordinal: 0,
					dataType: 'INTEGER',
					notNull: false,
					primaryKey: true
				}
			]
		}
	});

	const connection = nodes[0];
	assert.equal(connection.type, SqlConnectionTreeNodeType.Connection);
	assert.equal(connection.children?.length, 2);

	const tablesGroup = connection.children![0];
	assert.equal(tablesGroup.label, 'Tables');
	assert.equal(tablesGroup.description, '1');

	const table = tablesGroup.children![0];
	assert.equal(table.type, SqlConnectionTreeNodeType.Table);
	assert.equal(table.label, 'users');

	assert.equal(table.children?.length, 2);
	assert.equal(table.children![0].label, 'id');
	assert.equal(table.children![0].description, 'INTEGER · PK');
	assert.equal(table.children![1].label, 'name');
	assert.equal(table.children![1].description, 'TEXT · NOT NULL');

	const viewsGroup = connection.children![1];
	assert.equal(viewsGroup.label, 'Views');
	assert.equal(viewsGroup.children![0].type, SqlConnectionTreeNodeType.View);
	assert.equal(viewsGroup.children![0].label, 'active_users');
});

test('buildSqlConnectionTree renders connection metadata error', () => {
	const nodes = buildSqlConnectionTree({
		connections: [
			{
				id: 'broken',
				name: 'Broken DB',
				kind: SqlConnectionKind.Sqlite,
				databasePath: '/tmp/broken.db',
				readOnly: false
			}
		],
		errorsByConnectionId: {
			broken: 'database is locked'
		}
	});

	const connection = nodes[0];
	const error = connection.children![0];

	assert.equal(error.type, SqlConnectionTreeNodeType.Error);
	assert.equal(error.label, 'Failed to load metadata');
	assert.equal(error.description, 'database is locked');
});

test('getTableNodeId and getColumnNodeId escape special characters', () => {
	const table = {
		schema: 'main schema',
		name: 'user/profile',
		tableType: SqlTableType.Table
	};

	const tableId = getTableNodeId('local connection', table);
	const columnId = getColumnNodeId('local connection', table, {
		name: 'display name'
	});

	assert.equal(tableId, 'sql/connection/local%20connection/table/main%20schema/user%2Fprofile');
	assert.equal(columnId, 'sql/connection/local%20connection/table/main%20schema/user%2Fprofile/column/display%20name');
});
```

---

# 8. 修改 `package.json`

当前测试脚本已有 `test:branding / test:rust / test:sql-services / test`。

追加 Phase 4 测试脚本：

```json
{
	"scripts": {
		"test:sql-services": "node --test --import tsx src/vs/workbench/services/sql/test/sqlServices.test.ts",
		"test:sql-connections": "node --test --import tsx src/vs/workbench/contrib/sqlConnections/test/sqlConnectionTreeModel.test.ts",
		"test": "pnpm run test:branding && pnpm run test:rust && pnpm run test:sql-services && pnpm run test:sql-connections"
	}
}
```

只需要改对应 scripts，不需要新增依赖；项目已有 `tsx`。

---

# 9. 验收方式

运行：

```bash
pnpm run test:sql-connections
pnpm run test
pnpm run lint
pnpm run build
```

手动验证：

```txt
1. pnpm tauri dev
2. Activity Bar 出现 SQL Connections
3. 点击 SQL Connections
4. Database path 默认 :memory:
5. 点击 Connect
6. Tree 出现 In-memory SQLite / SQLite 连接
7. 点击 Refresh 无报错
8. 点击连接行右侧 × 可以关闭连接
```

---

# 10. Phase 4 完成后的状态

完成后，产品结构会变成：

```txt
SQL Studio Next
├─ Rust SQL commands        # Phase 2
├─ Workbench SQL services   # Phase 3
└─ SQL Connections Activity # Phase 4
```

下一步 Phase 5 就可以做：

```txt
SQL EditorInput / SQL EditorPane
├─ New SQL Query
├─ Monaco SQL Editor
├─ 绑定当前 connectionId
└─ Ctrl/Cmd + Enter 调用 ISqlQueryService.executeQuery()
```

Phase 4 不应该继续扩散到 Editor 和 Result Panel，否则边界会变大。当前只要把 **Activity + Connection Tree** 做稳，就可以进入 SQL 编辑器阶段。
