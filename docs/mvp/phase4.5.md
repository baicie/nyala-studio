# Phase 4.5：Connection Tree -> SQL Editor 打通

当前 Phase 4/5 的缺口是：

```txt id="e761o0"
SQL Connections View 已经能展示连接、表、字段
SQL Editor 已经有 sql.newQuery 命令
但 Connection Tree 还不能直接打开 SQL Editor
```

当前 `SqlConnectionsView` 只做了连接、刷新、关闭连接；表/视图节点没有生成 SQL 的入口。
当前树模型已经有 `connectionId / schema / tableName / columnName` 等字段，足够从 table/view 节点生成 SQL。
当前 SQL Editor 已经定义了 `SQL_NEW_QUERY_COMMAND_ID = 'sql.newQuery'`，`NewSqlQueryAction` 也支持传入 `connectionId / connectionName / initialSql`。

---

# Phase 4.5 目标

```txt id="65m1sa"
Connection 节点
  -> Open Query
  -> 打开空 SQL Editor，并绑定 connectionId

Table 节点
  -> SELECT
  -> 打开 SQL Editor，生成 SELECT * FROM table LIMIT 100;

View 节点
  -> SELECT
  -> 打开 SQL Editor，生成 SELECT * FROM view LIMIT 100;
```

本阶段不做：

```txt id="83q6ys"
- Result Panel
- 右键菜单系统
- Browse Table 数据展示
- SQL formatter
- Query History
- 多数据库
```

---

# 文件变化

新增：

```txt id="y4g4ke"
src/vs/workbench/contrib/sqlConnections/common/sqlConnectionQueryModel.ts
src/vs/workbench/contrib/sqlConnections/test/sqlConnectionQueryModel.test.ts
```

修改：

```txt id="k8k3nn"
src/vs/workbench/contrib/sqlConnections/browser/sqlConnectionsView.ts
src/vs/workbench/contrib/sqlConnections/browser/media/sqlConnections.css
package.json
```

---

# 1. 新增 `src/vs/workbench/contrib/sqlConnections/common/sqlConnectionQueryModel.ts`

```ts id="7ayxao"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL query draft helpers for connection tree nodes.
 *--------------------------------------------------------------------------------------------*/

import { SqlConnectionTreeNode, SqlConnectionTreeNodeType } from './sqlConnectionTreeModel.js';

export const SQL_CONNECTION_TABLE_PREVIEW_LIMIT = 100;

export interface SqlEditorDraft {
	connectionId: string;
	connectionName?: string;
	initialSql: string;
}

export interface SqlEditorDraftOptions {
	connectionName?: string;
	limit?: number;
}

export function createSqlEditorDraftFromTreeNode(
	node: SqlConnectionTreeNode,
	options: SqlEditorDraftOptions = {}
): SqlEditorDraft {
	if (!node.connectionId) {
		throw new Error('Cannot open SQL query because the tree node has no connection id.');
	}

	switch (node.type) {
		case SqlConnectionTreeNodeType.Connection:
			return createConnectionQueryDraft(node.connectionId, options.connectionName ?? node.label);

		case SqlConnectionTreeNodeType.Table:
		case SqlConnectionTreeNodeType.View:
			return createTablePreviewDraft(node, options);

		default:
			throw new Error(`Cannot open SQL query from node type: ${node.type}`);
	}
}

export function createConnectionQueryDraft(connectionId: string, connectionName?: string): SqlEditorDraft {
	const normalizedConnectionId = normalizeRequiredString(connectionId, 'connectionId');

	return {
		connectionId: normalizedConnectionId,
		connectionName: normalizeOptionalString(connectionName),
		initialSql: `-- SQL Studio Query
-- Connection: ${normalizeOptionalString(connectionName) ?? normalizedConnectionId}

SELECT 1 AS value;
`
	};
}

export function createTablePreviewDraft(
	node: Pick<SqlConnectionTreeNode, 'connectionId' | 'schema' | 'tableName' | 'label' | 'type'>,
	options: SqlEditorDraftOptions = {}
): SqlEditorDraft {
	const connectionId = normalizeRequiredString(node.connectionId, 'connectionId');
	const tableName = normalizeRequiredString(node.tableName ?? node.label, 'tableName');
	const schema = normalizeOptionalString(node.schema);
	const limit = normalizeLimit(options.limit);

	return {
		connectionId,
		connectionName: normalizeOptionalString(options.connectionName),
		initialSql: `SELECT *
FROM ${formatSqliteQualifiedName(schema, tableName)}
LIMIT ${limit};
`
	};
}

export function formatSqliteQualifiedName(schema: string | undefined, name: string): string {
	const normalizedName = normalizeRequiredString(name, 'name');
	const normalizedSchema = normalizeOptionalString(schema);

	if (!normalizedSchema || normalizedSchema === 'main') {
		return quoteSqliteIdentifier(normalizedName);
	}

	return `${quoteSqliteIdentifier(normalizedSchema)}.${quoteSqliteIdentifier(normalizedName)}`;
}

export function quoteSqliteIdentifier(value: string): string {
	const normalized = normalizeRequiredString(value, 'identifier');

	if (normalized.includes('\0')) {
		throw new Error('identifier must not contain NUL bytes');
	}

	return `"${normalized.replaceAll('"', '""')}"`;
}

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined) {
		return SQL_CONNECTION_TABLE_PREVIEW_LIMIT;
	}

	if (!Number.isInteger(limit) || limit <= 0) {
		throw new Error('limit must be a positive integer');
	}

	return Math.min(limit, 10_000);
}

function normalizeRequiredString(value: string | undefined, fieldName: string): string {
	const normalized = normalizeOptionalString(value);

	if (!normalized) {
		throw new Error(`${fieldName} must not be empty`);
	}

	return normalized;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}
```

---

# 2. 替换 `src/vs/workbench/contrib/sqlConnections/browser/sqlConnectionsView.ts`

```ts id="pim7ak"
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
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ISqlConnectionService } from '../../../services/sql/common/sqlConnection.js';
import { ISqlMetadataService } from '../../../services/sql/common/sqlMetadata.js';
import { SqlColumn, SqlConnection, SqlConnectionKind, SqlTable } from '../../../services/sql/common/sqlTypes.js';
import { SQL_NEW_QUERY_COMMAND_ID } from '../../sqlEditor/common/sqlEditor.js';
import {
	buildSqlConnectionTree,
	getColumnsKey,
	SqlConnectionTreeNode,
	SqlConnectionTreeNodeType
} from '../common/sqlConnectionTreeModel.js';
import { createSqlEditorDraftFromTreeNode } from '../common/sqlConnectionQueryModel.js';
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

	private readonly formDisposables = this._register(new DisposableStore());
	private readonly treeRenderDisposables = this._register(new DisposableStore());

	private body!: HTMLElement;
	private form!: HTMLFormElement;
	private nameInput!: HTMLInputElement;
	private databasePathInput!: HTMLInputElement;
	private readOnlyInput!: HTMLInputElement;
	private createIfMissingInput!: HTMLInputElement;
	private messageElement!: HTMLElement;
	private treeElement!: HTMLElement;

	private readonly collapsedNodes = new Set<string>();

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
		@ISqlMetadataService private readonly sqlMetadataService: ISqlMetadataService,
		@ICommandService private readonly commandService: ICommandService
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
		this.treeElement = append(this.body, $('.sql-connections-tree', { role: 'tree', tabIndex: 0 }));

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
			this.state.connections = [];
			this.state.tablesByConnectionId = Object.create(null);
			this.state.columnsByTableId = Object.create(null);
			this.state.errorsByConnectionId = Object.create(null);
			this.renderTree();
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

			this.collapsedNodes.delete(getConnectionNodeId(connection.id));
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
		append(actions, $('button.sql-connections-button.primary', { type: 'submit' }, 'Connect'));

		const refreshButton = append(
			actions,
			$('button.sql-connections-button', { type: 'button' }, 'Refresh')
		) as HTMLButtonElement;

		this.formDisposables.add(
			addDisposableListener(this.form, EventType.SUBMIT, event => {
				event.preventDefault();
				this.addConnectionFromForm().catch(error => this.showError(error));
			})
		);

		this.formDisposables.add(
			addDisposableListener(refreshButton, EventType.CLICK, () => {
				this.refresh().catch(error => this.showError(error));
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
		this.treeRenderDisposables.clear();
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
				'aria-label': isExpanded ? 'Collapse' : 'Expand',
				'aria-expanded': hasChildren ? String(isExpanded) : undefined
			})
		) as HTMLButtonElement;

		twisty.textContent = hasChildren ? (isExpanded ? '▾' : '▸') : '';

		if (hasChildren) {
			this.treeRenderDisposables.add(
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

		this.renderNodeActions(row, node);

		if (hasChildren && isExpanded) {
			const children = append(wrapper, $('.sql-connection-node-children', { role: 'group' }));
			for (const child of node.children!) {
				children.appendChild(this.renderNode(child, depth + 1));
			}
		}

		return wrapper;
	}

	private renderNodeActions(row: HTMLElement, node: SqlConnectionTreeNode): void {
		if (!isQueryOpenableNode(node) && node.type !== SqlConnectionTreeNodeType.Connection) {
			return;
		}

		const actions = append(row, $('.sql-connection-node-actions'));

		if (isQueryOpenableNode(node)) {
			const openQueryButton = append(
				actions,
				$('button.sql-connection-node-action', {
					type: 'button',
					title: node.type === SqlConnectionTreeNodeType.Connection ? 'Open SQL query' : 'Select top 100'
				})
			) as HTMLButtonElement;

			openQueryButton.textContent = node.type === SqlConnectionTreeNodeType.Connection ? 'SQL' : 'SELECT';

			this.treeRenderDisposables.add(
				addDisposableListener(openQueryButton, EventType.CLICK, event => {
					event.preventDefault();
					event.stopPropagation();
					this.openQueryForNode(node).catch(error => this.showError(error));
				})
			);
		}

		if (node.type === SqlConnectionTreeNodeType.Connection && node.connectionId) {
			const closeButton = append(
				actions,
				$('button.sql-connection-node-action.danger', {
					type: 'button',
					title: 'Close connection'
				})
			) as HTMLButtonElement;

			closeButton.textContent = '×';

			this.treeRenderDisposables.add(
				addDisposableListener(closeButton, EventType.CLICK, event => {
					event.preventDefault();
					event.stopPropagation();
					this.closeConnection(node.connectionId!).catch(error => this.showError(error));
				})
			);
		}
	}

	private async openQueryForNode(node: SqlConnectionTreeNode): Promise<void> {
		const draft = createSqlEditorDraftFromTreeNode(node, {
			connectionName: node.connectionId ? this.getConnectionName(node.connectionId) : undefined
		});

		await this.commandService.executeCommand(SQL_NEW_QUERY_COMMAND_ID, draft);
	}

	private getConnectionName(connectionId: string): string | undefined {
		return this.state.connections.find(connection => connection.id === connectionId)?.name;
	}

	private async closeConnection(connectionId: string): Promise<void> {
		await this.sqlConnectionService.closeConnection(connectionId);
		this.collapsedNodes.delete(getConnectionNodeId(connectionId));
		this.showInfo('Connection closed.');
		await this.refresh();
	}

	private toggleNode(nodeId: string): void {
		if (this.collapsedNodes.has(nodeId)) {
			this.collapsedNodes.delete(nodeId);
		} else {
			this.collapsedNodes.add(nodeId);
		}

		this.renderTree();
	}

	private isExpanded(node: SqlConnectionTreeNode): boolean {
		return !this.collapsedNodes.has(node.id);
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

function getConnectionNodeId(connectionId: string): string {
	return `sql/connection/${encodeURIComponent(connectionId)}`;
}

function isQueryOpenableNode(node: SqlConnectionTreeNode): boolean {
	return (
		node.type === SqlConnectionTreeNodeType.Connection ||
		node.type === SqlConnectionTreeNodeType.Table ||
		node.type === SqlConnectionTreeNodeType.View
	);
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

---

# 3. 修改 `src/vs/workbench/contrib/sqlConnections/browser/media/sqlConnections.css`

把现有 `.sql-connection-node-action` 相关样式替换为下面这一组：

```css id="5xqebh"
.sql-connection-node-actions {
	margin-left: auto;
	display: inline-flex;
	align-items: center;
	gap: 4px;
	opacity: 0;
}

.sql-connection-node:hover .sql-connection-node-actions,
.sql-connection-node:focus-within .sql-connection-node-actions {
	opacity: 1;
}

.sql-connection-node-action {
	height: 20px;
	min-width: 22px;
	padding: 0 6px;
	border: 0;
	border-radius: 2px;
	color: inherit;
	background: transparent;
	cursor: pointer;
	font-size: 11px;
	line-height: 20px;
}

.sql-connection-node-action:hover {
	background: var(--vscode-toolbar-hoverBackground);
}

.sql-connection-node-action.danger {
	font-size: 14px;
	padding: 0 5px;
}

.sql-connection-node-action.danger:hover {
	color: var(--vscode-errorForeground);
}
```

如果文件里原来还有旧版：

```css id="zgeecv"
.sql-connection-node-action {
	margin-left: auto;
	width: 20px;
	...
}
```

需要删除，避免冲突。

---

# 4. 新增测试 `src/vs/workbench/contrib/sqlConnections/test/sqlConnectionQueryModel.test.ts`

```ts id="g6uqle"
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createConnectionQueryDraft,
	createSqlEditorDraftFromTreeNode,
	createTablePreviewDraft,
	formatSqliteQualifiedName,
	quoteSqliteIdentifier,
	SQL_CONNECTION_TABLE_PREVIEW_LIMIT
} from '../common/sqlConnectionQueryModel.js';
import { SqlConnectionTreeNodeType } from '../common/sqlConnectionTreeModel.js';
import { SqlTableType } from '../../../services/sql/common/sqlTypes.js';

test('quoteSqliteIdentifier quotes simple identifier', () => {
	assert.equal(quoteSqliteIdentifier('users'), '"users"');
});

test('quoteSqliteIdentifier escapes double quotes', () => {
	assert.equal(quoteSqliteIdentifier('weird"name'), '"weird""name"');
});

test('quoteSqliteIdentifier rejects empty identifier', () => {
	assert.throws(() => quoteSqliteIdentifier('  '), /identifier must not be empty/);
});

test('quoteSqliteIdentifier rejects NUL bytes', () => {
	assert.throws(() => quoteSqliteIdentifier('bad\0name'), /NUL/);
});

test('formatSqliteQualifiedName omits main schema', () => {
	assert.equal(formatSqliteQualifiedName('main', 'users'), '"users"');
});

test('formatSqliteQualifiedName includes non-main schema', () => {
	assert.equal(formatSqliteQualifiedName('analytics', 'events'), '"analytics"."events"');
});

test('createConnectionQueryDraft creates default query bound to connection', () => {
	const draft = createConnectionQueryDraft(' local ', ' Local SQLite ');

	assert.equal(draft.connectionId, 'local');
	assert.equal(draft.connectionName, 'Local SQLite');
	assert.match(draft.initialSql, /Connection: Local SQLite/);
	assert.match(draft.initialSql, /SELECT 1 AS value;/);
});

test('createTablePreviewDraft creates select top SQL for table node', () => {
	const draft = createTablePreviewDraft(
		{
			type: SqlConnectionTreeNodeType.Table,
			connectionId: 'local',
			schema: 'main',
			tableName: 'users',
			label: 'users'
		},
		{
			connectionName: 'Local SQLite'
		}
	);

	assert.equal(draft.connectionId, 'local');
	assert.equal(draft.connectionName, 'Local SQLite');
	assert.equal(
		draft.initialSql,
		`SELECT *
FROM "users"
LIMIT ${SQL_CONNECTION_TABLE_PREVIEW_LIMIT};
`
	);
});

test('createTablePreviewDraft creates select top SQL for attached schema', () => {
	const draft = createTablePreviewDraft(
		{
			type: SqlConnectionTreeNodeType.Table,
			connectionId: 'local',
			schema: 'analytics',
			tableName: 'events',
			label: 'events'
		},
		{
			limit: 50
		}
	);

	assert.equal(
		draft.initialSql,
		`SELECT *
FROM "analytics"."events"
LIMIT 50;
`
	);
});

test('createTablePreviewDraft clamps large limit', () => {
	const draft = createTablePreviewDraft(
		{
			type: SqlConnectionTreeNodeType.Table,
			connectionId: 'local',
			schema: 'main',
			tableName: 'users',
			label: 'users'
		},
		{
			limit: 20_000
		}
	);

	assert.match(draft.initialSql, /LIMIT 10000;/);
});

test('createTablePreviewDraft rejects invalid limit', () => {
	assert.throws(
		() =>
			createTablePreviewDraft(
				{
					type: SqlConnectionTreeNodeType.Table,
					connectionId: 'local',
					schema: 'main',
					tableName: 'users',
					label: 'users'
				},
				{
					limit: 0
				}
			),
		/limit must be a positive integer/
	);
});

test('createSqlEditorDraftFromTreeNode supports connection node', () => {
	const draft = createSqlEditorDraftFromTreeNode(
		{
			id: 'sql/connection/local',
			type: SqlConnectionTreeNodeType.Connection,
			label: 'Local SQLite',
			connectionId: 'local'
		},
		{
			connectionName: 'Local SQLite'
		}
	);

	assert.equal(draft.connectionId, 'local');
	assert.equal(draft.connectionName, 'Local SQLite');
	assert.match(draft.initialSql, /SELECT 1 AS value;/);
});

test('createSqlEditorDraftFromTreeNode supports table node', () => {
	const draft = createSqlEditorDraftFromTreeNode({
		id: 'sql/connection/local/table/main/users',
		type: SqlConnectionTreeNodeType.Table,
		label: 'users',
		connectionId: 'local',
		schema: 'main',
		tableName: 'users'
	});

	assert.equal(draft.connectionId, 'local');
	assert.match(draft.initialSql, /FROM "users"/);
});

test('createSqlEditorDraftFromTreeNode supports view node', () => {
	const draft = createSqlEditorDraftFromTreeNode({
		id: 'sql/connection/local/view/main/active_users',
		type: SqlConnectionTreeNodeType.View,
		label: 'active_users',
		connectionId: 'local',
		schema: 'main',
		tableName: 'active_users'
	});

	assert.equal(draft.connectionId, 'local');
	assert.match(draft.initialSql, /FROM "active_users"/);
});

test('createSqlEditorDraftFromTreeNode rejects column node', () => {
	assert.throws(
		() =>
			createSqlEditorDraftFromTreeNode({
				id: 'column',
				type: SqlConnectionTreeNodeType.Column,
				label: 'id',
				connectionId: 'local',
				tableName: 'users',
				columnName: 'id'
			}),
		/Cannot open SQL query from node type/
	);
});

test('createSqlEditorDraftFromTreeNode rejects node without connection id', () => {
	assert.throws(
		() =>
			createSqlEditorDraftFromTreeNode({
				id: 'empty',
				type: SqlConnectionTreeNodeType.Empty,
				label: 'Empty'
			}),
		/no connection id/
	);
});
```

---

# 5. 修改 `package.json`

当前已经有 `test:sql-connections` 和 `test:sql-editor`，总测试也已经串起来了。

把：

```json id="zo23cu"
"test:sql-connections": "node --test --import tsx src/vs/workbench/contrib/sqlConnections/test/sqlConnectionTreeModel.test.ts"
```

改成：

```json id="stzpg2"
"test:sql-connections": "node --test --import tsx src/vs/workbench/contrib/sqlConnections/test/sqlConnectionTreeModel.test.ts src/vs/workbench/contrib/sqlConnections/test/sqlConnectionQueryModel.test.ts"
```

总测试不需要改，因为它已经引用了 `test:sql-connections`。

---

# 6. 验收方式

```bash id="nk56qz"
pnpm run test:sql-connections
pnpm run test
pnpm run lint
pnpm run build
```

手动验收：

```txt id="530okg"
1. pnpm tauri dev
2. 添加 SQLite 连接
3. 展开 SQL Connections
4. 点击 Connection 行的 SQL
   -> 打开 SQL Query editor
   -> 绑定当前 connectionId
5. 点击 table 行的 SELECT
   -> 打开 SQL Query editor
   -> 自动生成 SELECT * FROM "table" LIMIT 100;
6. 点击 view 行的 SELECT
   -> 自动生成 SELECT * FROM "view" LIMIT 100;
```

---

# 7. Phase 4.5 完成后的状态

完成后产品流就变成：

```txt id="ujekph"
SQL Connections
  -> SQLite connection
    -> SQL
       -> SQL Editor
    -> Tables
       -> users
          -> SELECT
             -> SQL Editor with SELECT * FROM "users" LIMIT 100;
```

下一步就应该做：

```txt id="x98tdr"
Phase 6：Query Result Panel
```

不要继续补复杂右键菜单，也不要现在做 MySQL/Postgres。Phase 4.5 的唯一目标就是把 **Connection Tree 和 SQL Editor 串起来**。
