下面给出 **Phase 7.4：Schema Tree UX Enhancement** 的完整设计与代码。

当前 Connections Tree 只有全局 Refresh、节点上的 `SQL / SELECT / Close` 这些基础动作。
Phase 7.4 就在这个基础上补齐：

```txt id="xuozit"
1. Refresh Connection
2. Refresh Table/View Columns
3. Copy Table Name
4. Copy Qualified Name
5. Generate SELECT
6. Generate COUNT
7. Generate INSERT template
8. Generate UPDATE template
```

仍然只服务 SQLite，不做多数据库 UI。

---

# Phase 7.4：Schema Tree UX Enhancement

## 文件变更

新增：

```txt id="z2usmc"
src/vs/workbench/contrib/sqlConnections/common/sqlConnectionTemplateModel.ts
src/vs/workbench/contrib/sqlConnections/test/sqlConnectionTemplateModel.test.ts
```

替换：

```txt id="zsdjpm"
src/vs/workbench/contrib/sqlConnections/common/sqlConnectionQueryModel.ts
src/vs/workbench/contrib/sqlConnections/browser/sqlConnectionsView.ts
```

追加修改：

```txt id="tubcr2"
src/vs/workbench/contrib/sqlConnections/browser/media/sqlConnections.css
package.json
```

---

# 1. 新增 `sqlConnectionTemplateModel.ts`

路径：

```txt id="awy5ma"
src/vs/workbench/contrib/sqlConnections/common/sqlConnectionTemplateModel.ts
```

```ts id="d6e6xr"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL connection tree SQL template model.
 * Phase 7.4 intentionally supports SQLite only through SqlDialect helpers.
 *--------------------------------------------------------------------------------------------*/

import { SqlColumn } from '../../../services/sql/common/sqlTypes.js';
import {
	createTablePreviewSql,
	formatQualifiedName,
	quoteSqlIdentifier,
	SqlDialect,
	SQL_DEFAULT_TABLE_PREVIEW_LIMIT
} from '../../../services/sql/common/sqlDialect.js';

export interface SqlTableTemplateTarget {
	readonly schema?: string;
	readonly tableName: string;
	readonly columns?: readonly SqlColumn[];
	readonly dialect?: SqlDialect;
}

export interface SqlGeneratedTemplate {
	readonly title: string;
	readonly sql: string;
}

export const SQL_CONNECTION_COUNT_ALIAS = 'count';

export function createSelectTemplate(target: SqlTableTemplateTarget, limit = SQL_DEFAULT_TABLE_PREVIEW_LIMIT): SqlGeneratedTemplate {
	return {
		title: 'SELECT',
		sql: createTablePreviewSql({
			dialect: target.dialect ?? SqlDialect.Sqlite,
			schema: target.schema,
			tableName: target.tableName,
			limit
		})
	};
}

export function createCountTemplate(target: SqlTableTemplateTarget): SqlGeneratedTemplate {
	const dialect = target.dialect ?? SqlDialect.Sqlite;
	const tableName = createQualifiedTableName(target);

	return {
		title: 'COUNT',
		sql: `SELECT COUNT(*) AS ${quoteSqlIdentifier(dialect, SQL_CONNECTION_COUNT_ALIAS)}
FROM ${tableName};
`
	};
}

export function createInsertTemplate(target: SqlTableTemplateTarget): SqlGeneratedTemplate {
	const dialect = target.dialect ?? SqlDialect.Sqlite;
	const tableName = createQualifiedTableName(target);
	const columns = normalizeTemplateColumns(target.columns);

	if (columns.length === 0) {
		return {
			title: 'INSERT',
			sql: `INSERT INTO ${tableName}
DEFAULT VALUES;
`
		};
	}

	const columnList = columns
		.map(column => quoteSqlIdentifier(dialect, column.name))
		.join(', ');

	const valueList = columns
		.map((column, index) => createSqlParameterName(column.name, index))
		.join(', ');

	return {
		title: 'INSERT',
		sql: `INSERT INTO ${tableName} (${columnList})
VALUES (${valueList});
`
	};
}

export function createUpdateTemplate(target: SqlTableTemplateTarget): SqlGeneratedTemplate {
	const dialect = target.dialect ?? SqlDialect.Sqlite;
	const tableName = createQualifiedTableName(target);
	const columns = normalizeTemplateColumns(target);

	if (columns.length === 0) {
		return {
			title: 'UPDATE',
			sql: `UPDATE ${tableName}
SET -- column = value
WHERE -- condition;
`
		};
	}

	const whereColumn = pickWhereColumn(columns);
	const setColumns = columns.filter(column => column.name !== whereColumn.name);

	const effectiveSetColumns = setColumns.length > 0 ? setColumns : [whereColumn];

	const setClause = effectiveSetColumns
		.map((column, index) => {
			const prefix = index === 0 ? 'SET ' : '    ';
			return `${prefix}${quoteSqlIdentifier(dialect, column.name)} = ${createSqlParameterName(column.name, index)}`;
		})
		.join(',\n');

	return {
		title: 'UPDATE',
		sql: `UPDATE ${tableName}
${setClause}
WHERE ${quoteSqlIdentifier(dialect, whereColumn.name)} = ${createSqlParameterName(whereColumn.name, effectiveSetColumns.length)};
`
	};
}

export function createCopyTableNameText(target: SqlTableTemplateTarget): string {
	return normalizeTableName(target.tableName);
}

export function createCopyQualifiedNameText(target: SqlTableTemplateTarget): string {
	return createQualifiedTableName(target);
}

export function createQualifiedTableName(target: SqlTableTemplateTarget): string {
	return formatQualifiedName(target.dialect ?? SqlDialect.Sqlite, {
		schema: normalizeOptionalIdentifier(target.schema),
		name: normalizeTableName(target.tableName)
	});
}

export function normalizeTemplateColumns(columns: readonly SqlColumn[] | undefined): SqlColumn[] {
	if (!columns) {
		return [];
	}

	const seen = new Set<string>();
	const result: SqlColumn[] = [];

	for (const column of [...columns].sort((left, right) => left.ordinal - right.ordinal || left.name.localeCompare(right.name))) {
		const normalizedName = normalizeOptionalIdentifier(column.name);

		if (!normalizedName || seen.has(normalizedName)) {
			continue;
		}

		seen.add(normalizedName);
		result.push({
			...column,
			name: normalizedName
		});
	}

	return result;
}

export function createSqlParameterName(columnName: string, index: number): string {
	const normalized = normalizeOptionalIdentifier(columnName) ?? `value${index + 1}`;
	const safe = normalized
		.replace(/[^A-Za-z0-9_]+/g, '_')
		.replace(/^([0-9])/, '_$1')
		.replace(/^_+$/, '');

	if (!safe) {
		return `:value${index + 1}`;
	}

	return `:${safe}`;
}

function pickWhereColumn(columns: readonly SqlColumn[]): SqlColumn {
	return columns.find(column => column.primaryKey) ?? columns[0];
}

function normalizeTableName(tableName: string): string {
	const normalized = normalizeOptionalIdentifier(tableName);

	if (!normalized) {
		throw new Error('tableName must not be empty');
	}

	return normalized;
}

function normalizeOptionalIdentifier(value: string | undefined): string | undefined {
	const normalized = value?.trim();

	if (!normalized) {
		return undefined;
	}

	if (normalized.includes('\0')) {
		throw new Error('identifier must not contain NUL bytes');
	}

	return normalized;
}
```

---

# 2. 替换 `sqlConnectionQueryModel.ts`

路径：

```txt id="b3d31v"
src/vs/workbench/contrib/sqlConnections/common/sqlConnectionQueryModel.ts
```

```ts id="y1cdph"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL query draft helpers for connection tree nodes.
 *--------------------------------------------------------------------------------------------*/

import { SqlColumn, SqlTableType } from '../../../services/sql/common/sqlTypes.js';
import {
	createTablePreviewSql,
	formatQualifiedName,
	quoteSqlIdentifier,
	SqlDialect,
	SQL_DEFAULT_TABLE_PREVIEW_LIMIT,
	SQL_MAX_TABLE_PREVIEW_LIMIT
} from '../../../services/sql/common/sqlDialect.js';
import { SqlConnectionTreeNode, SqlConnectionTreeNodeType } from './sqlConnectionTreeModel.js';
import {
	createCopyQualifiedNameText,
	createCopyTableNameText,
	createCountTemplate,
	createInsertTemplate,
	createSelectTemplate,
	createUpdateTemplate,
	SqlGeneratedTemplate,
	SqlTableTemplateTarget
} from './sqlConnectionTemplateModel.js';

export const SQL_CONNECTION_TABLE_PREVIEW_LIMIT = SQL_DEFAULT_TABLE_PREVIEW_LIMIT;

export interface SqlEditorDraft {
	readonly connectionId: string;
	readonly connectionName?: string;
	readonly initialSql: string;
}

export interface SqlEditorDraftOptions {
	readonly connectionName?: string;
	readonly dialect?: SqlDialect;
	readonly limit?: number;
	readonly columns?: readonly SqlColumn[];
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
	const normalizedConnectionName = normalizeOptionalString(connectionName);

	return {
		connectionId: normalizedConnectionId,
		connectionName: normalizedConnectionName,
		initialSql: `-- SQL Studio Query
-- Connection: ${normalizedConnectionName ?? normalizedConnectionId}

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

	return {
		connectionId,
		connectionName: normalizeOptionalString(options.connectionName),
		initialSql: createTablePreviewSql({
			dialect: options.dialect ?? SqlDialect.Sqlite,
			schema: normalizeOptionalString(node.schema),
			tableName,
			limit: options.limit
		})
	};
}

export function createSelectDraftFromTreeNode(
	node: SqlConnectionTreeNode,
	options: SqlEditorDraftOptions = {}
): SqlEditorDraft {
	return createTemplateDraft(node, createSelectTemplate(createTemplateTarget(node, options), options.limit));
}

export function createCountDraftFromTreeNode(
	node: SqlConnectionTreeNode,
	options: SqlEditorDraftOptions = {}
): SqlEditorDraft {
	return createTemplateDraft(node, createCountTemplate(createTemplateTarget(node, options)));
}

export function createInsertDraftFromTreeNode(
	node: SqlConnectionTreeNode,
	options: SqlEditorDraftOptions = {}
): SqlEditorDraft {
	return createTemplateDraft(node, createInsertTemplate(createTemplateTarget(node, options)));
}

export function createUpdateDraftFromTreeNode(
	node: SqlConnectionTreeNode,
	options: SqlEditorDraftOptions = {}
): SqlEditorDraft {
	return createTemplateDraft(node, createUpdateTemplate(createTemplateTarget(node, options)));
}

export function createCopyTableNameTextFromTreeNode(node: SqlConnectionTreeNode): string {
	return createCopyTableNameText(createTemplateTarget(node));
}

export function createCopyQualifiedNameTextFromTreeNode(node: SqlConnectionTreeNode): string {
	return createCopyQualifiedNameText(createTemplateTarget(node));
}

export function isSqlTableLikeNode(node: SqlConnectionTreeNode): boolean {
	return node.type === SqlConnectionTreeNodeType.Table || node.type === SqlConnectionTreeNodeType.View;
}

export function isSqlMutableTableNode(node: SqlConnectionTreeNode): boolean {
	return node.type === SqlConnectionTreeNodeType.Table;
}

export function getSqlTableTypeFromNode(node: SqlConnectionTreeNode): SqlTableType {
	return node.type === SqlConnectionTreeNodeType.View ? SqlTableType.View : SqlTableType.Table;
}

/**
 * Backward-compatible export for Phase 4.5 tests/callers.
 * New code should use quoteSqlIdentifier(SqlDialect.Sqlite, value).
 */
export function quoteSqliteIdentifier(value: string): string {
	return quoteSqlIdentifier(SqlDialect.Sqlite, value);
}

/**
 * Backward-compatible export for Phase 4.5 tests/callers.
 * New code should use formatQualifiedName(SqlDialect.Sqlite, ...).
 */
export function formatSqliteQualifiedName(schema: string | undefined, name: string): string {
	return formatQualifiedName(SqlDialect.Sqlite, {
		schema,
		name
	});
}

function createTemplateDraft(node: SqlConnectionTreeNode, template: SqlGeneratedTemplate): SqlEditorDraft {
	const connectionId = normalizeRequiredString(node.connectionId, 'connectionId');

	return {
		connectionId,
		connectionName: undefined,
		initialSql: template.sql
	};
}

function createTemplateTarget(node: SqlConnectionTreeNode, options: SqlEditorDraftOptions = {}): SqlTableTemplateTarget {
	if (!isSqlTableLikeNode(node)) {
		throw new Error(`Cannot create SQL template from node type: ${node.type}`);
	}

	return {
		schema: normalizeOptionalString(node.schema),
		tableName: normalizeRequiredString(node.tableName ?? node.label, 'tableName'),
		columns: options.columns,
		dialect: options.dialect ?? SqlDialect.Sqlite
	};
}

function normalizeRequiredString(value: string | undefined, fieldName: string): string {
	const normalized = normalizeOptionalString(value);

	if (!normalized) {
		throw new Error(`${fieldName} must not be empty`);
	}

	if (normalized.includes('\0')) {
		throw new Error(`${fieldName} must not contain NUL bytes`);
	}

	return normalized;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

export { SQL_MAX_TABLE_PREVIEW_LIMIT };
```

---

# 3. 替换 `sqlConnectionsView.ts`

路径：

```txt id="amw8bi"
src/vs/workbench/contrib/sqlConnections/browser/sqlConnectionsView.ts
```

```ts id="y4kqfd"
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
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ISqlConnectionService } from '../../../services/sql/common/sqlConnection.js';
import { ISqlMetadataService } from '../../../services/sql/common/sqlMetadata.js';
import {
	SqlColumn,
	SqlConnection,
	SqlConnectionInput,
	SqlConnectionKind,
	SqlSavedConnection,
	SqlTable,
	SqlTableType
} from '../../../services/sql/common/sqlTypes.js';
import { SQL_NEW_QUERY_COMMAND_ID } from '../../sqlEditor/common/sqlEditor.js';
import {
	buildSqlConnectionTree,
	getColumnsKey,
	SqlConnectionTreeNode,
	SqlConnectionTreeNodeType
} from '../common/sqlConnectionTreeModel.js';
import {
	createCopyQualifiedNameTextFromTreeNode,
	createCopyTableNameTextFromTreeNode,
	createCountDraftFromTreeNode,
	createInsertDraftFromTreeNode,
	createSelectDraftFromTreeNode,
	createSqlEditorDraftFromTreeNode,
	createUpdateDraftFromTreeNode,
	getSqlTableTypeFromNode,
	isSqlMutableTableNode,
	isSqlTableLikeNode,
	SqlEditorDraft
} from '../common/sqlConnectionQueryModel.js';
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
	private readonly savedRenderDisposables = this._register(new DisposableStore());

	private body!: HTMLElement;
	private form!: HTMLFormElement;
	private nameInput!: HTMLInputElement;
	private databasePathInput!: HTMLInputElement;
	private readOnlyInput!: HTMLInputElement;
	private createIfMissingInput!: HTMLInputElement;
	private saveConnectionInput!: HTMLInputElement;
	private autoConnectInput!: HTMLInputElement;
	private messageElement!: HTMLElement;
	private treeElement!: HTMLElement;
	private savedConnectionsElement!: HTMLElement;

	private readonly collapsedNodes = new Set<string>();

	private readonly state: SqlConnectionTreeSnapshotState = {
		connections: [],
		tablesByConnectionId: Object.create(null),
		columnsByTableId: Object.create(null),
		errorsByConnectionId: Object.create(null)
	};

	private savedConnections: SqlSavedConnection[] = [];
	private didRestoreSavedConnections = false;

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
		@ICommandService private readonly commandService: ICommandService,
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
		this.body = append(container, $('.sql-connections-view'));
		this.renderConnectionForm(this.body);
		this.savedConnectionsElement = append(this.body, $('.sql-saved-connections'));
		this.messageElement = append(this.body, $('.sql-connections-message'));
		this.treeElement = append(this.body, $('.sql-connections-tree', { role: 'tree', tabIndex: 0 }));

		this.databasePathInput.value = ':memory:';
		this.createIfMissingInput.checked = true;
		this.saveConnectionInput.checked = false;
		this.autoConnectInput.checked = false;
		this.autoConnectInput.disabled = true;

		this.refresh().catch(error => this.showError(error));
	}

	override focus(): void {
		this.treeElement?.focus();
		super.focus();
	}

	async refresh(): Promise<void> {
		this.showInfo('Loading connections...');

		try {
			if (!this.didRestoreSavedConnections) {
				this.didRestoreSavedConnections = true;
				try {
					await this.sqlConnectionService.restoreSavedConnections();
				} catch (error) {
					this.showError(error);
				}
			}

			const [connections, saved] = await Promise.all([
				this.sqlConnectionService.listConnections(),
				this.sqlConnectionService.listSavedConnections()
			]);

			this.state.connections = connections;
			this.state.tablesByConnectionId = Object.create(null);
			this.state.columnsByTableId = Object.create(null);
			this.state.errorsByConnectionId = Object.create(null);
			this.savedConnections = saved;

			for (const connection of connections) {
				await this.loadConnectionMetadata(connection);
			}

			this.showInfo(connections.length === 0 ? 'No connections yet.' : '');
			this.renderTree();
			this.renderSavedConnections();
		} catch (error) {
			this.state.connections = [];
			this.state.tablesByConnectionId = Object.create(null);
			this.state.columnsByTableId = Object.create(null);
			this.state.errorsByConnectionId = Object.create(null);
			this.savedConnections = [];
			this.renderTree();
			this.renderSavedConnections();
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
			const input: SqlConnectionInput = {
				name: name || undefined,
				kind: SqlConnectionKind.Sqlite,
				databasePath,
				readOnly: this.readOnlyInput.checked,
				createIfMissing: this.createIfMissingInput.checked
			};

			let connectionId: string;
			let connectionName: string;

			const shouldSave = this.saveConnectionInput.checked && isPersistableDatabasePath(databasePath);

			if (this.saveConnectionInput.checked && !shouldSave) {
				this.showInfo('In-memory SQLite connections are temporary and will not be saved.');
			}

			if (shouldSave) {
				const saved = await this.sqlConnectionService.saveConnection({
					input,
					autoConnect: this.autoConnectInput.checked,
					openNow: true
				});

				connectionId = saved.id;
				connectionName = saved.name;
			} else {
				const connection = await this.sqlConnectionService.openConnection(input);

				connectionId = connection.id;
				connectionName = connection.name;
			}

			this.collapsedNodes.delete(getConnectionNodeId(connectionId));
			this.showInfo(`Connected to ${connectionName}.`);
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

		const saveLabel = append(options, $('label.sql-connections-checkbox'));
		this.saveConnectionInput = append(saveLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
		append(saveLabel, $('span', undefined, 'Save'));

		const autoConnectLabel = append(options, $('label.sql-connections-checkbox'));
		this.autoConnectInput = append(autoConnectLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
		append(autoConnectLabel, $('span', undefined, 'Auto connect'));

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

		this.formDisposables.add(
			addDisposableListener(this.saveConnectionInput, EventType.CHANGE, () => {
				this.autoConnectInput.disabled = !this.saveConnectionInput.checked;

				if (!this.saveConnectionInput.checked) {
					this.autoConnectInput.checked = false;
				}
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

			delete this.state.errorsByConnectionId[connection.id];
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

		twisty.textContent = hasChildren ? (isExpanded ? '\u25be' : '\u25b8') : '';

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
		if (!isActionableNode(node)) {
			return;
		}

		const actions = append(row, $('.sql-connection-node-actions'));

		if (node.type === SqlConnectionTreeNodeType.Connection && node.connectionId) {
			this.appendActionButton(actions, 'SQL', 'Open SQL query', event => {
				event.preventDefault();
				event.stopPropagation();
				this.openQueryForNode(node).catch(error => this.showError(error));
			});

			this.appendActionButton(actions, 'Refresh', 'Refresh connection metadata', event => {
				event.preventDefault();
				event.stopPropagation();
				this.refreshConnection(node.connectionId!).catch(error => this.showError(error));
			});

			this.appendActionButton(actions, '\u00d7', 'Close connection', event => {
				event.preventDefault();
				event.stopPropagation();
				this.closeConnection(node.connectionId!).catch(error => this.showError(error));
			}, 'danger');

			return;
		}

		if (isSqlTableLikeNode(node)) {
			this.appendActionButton(actions, 'SELECT', 'Generate SELECT query', event => {
				event.preventDefault();
				event.stopPropagation();
				this.openDraft(createSelectDraftFromTreeNode(node, {
					connectionName: node.connectionId ? this.getConnectionName(node.connectionId) : undefined,
					columns: this.getColumnsForNode(node)
				})).catch(error => this.showError(error));
			});

			this.appendActionButton(actions, 'COUNT', 'Generate COUNT query', event => {
				event.preventDefault();
				event.stopPropagation();
				this.openDraft(createCountDraftFromTreeNode(node, {
					columns: this.getColumnsForNode(node)
				})).catch(error => this.showError(error));
			});

			if (isSqlMutableTableNode(node)) {
				this.appendActionButton(actions, 'INSERT', 'Generate INSERT template', event => {
					event.preventDefault();
					event.stopPropagation();
					this.openDraft(createInsertDraftFromTreeNode(node, {
						columns: this.getColumnsForNode(node)
					})).catch(error => this.showError(error));
				});

				this.appendActionButton(actions, 'UPDATE', 'Generate UPDATE template', event => {
					event.preventDefault();
					event.stopPropagation();
					this.openDraft(createUpdateDraftFromTreeNode(node, {
						columns: this.getColumnsForNode(node)
					})).catch(error => this.showError(error));
				});
			}

			this.appendActionButton(actions, 'Copy', 'Copy qualified name', event => {
				event.preventDefault();
				event.stopPropagation();
				this.copyQualifiedName(node).catch(error => this.showError(error));
			});

			this.appendActionButton(actions, 'Refresh', 'Refresh columns', event => {
				event.preventDefault();
				event.stopPropagation();
				this.refreshTable(node).catch(error => this.showError(error));
			});
		}
	}

	private appendActionButton(
		parent: HTMLElement,
		label: string,
		title: string,
		listener: (event: MouseEvent) => void,
		variant?: 'danger'
	): HTMLButtonElement {
		const button = append(
			parent,
			$('button.sql-connection-node-action', {
				type: 'button',
				title
			}, label)
		) as HTMLButtonElement;

		if (variant) {
			button.classList.add(variant);
		}

		this.treeRenderDisposables.add(addDisposableListener(button, EventType.CLICK, listener));

		return button;
	}

	private renderSavedConnections(): void {
		this.savedRenderDisposables.clear();
		clearNode(this.savedConnectionsElement);

		if (this.savedConnections.length === 0) {
			return;
		}

		const title = append(this.savedConnectionsElement, $('.sql-saved-connections-title'));
		title.textContent = 'Saved Connections';

		for (const saved of this.savedConnections) {
			const row = append(this.savedConnectionsElement, $('.sql-saved-connection-row'));

			append(row, $('span.sql-saved-connection-name', undefined, saved.name));

			const openButton = append(
				row,
				$('button.sql-saved-connection-action', { type: 'button' }, 'Open')
			) as HTMLButtonElement;

			const removeButton = append(
				row,
				$('button.sql-saved-connection-action.danger', { type: 'button' }, 'Remove')
			) as HTMLButtonElement;

			this.savedRenderDisposables.add(
				addDisposableListener(openButton, EventType.CLICK, event => {
					event.preventDefault();
					event.stopPropagation();
					this.openSavedConnection(saved).catch(error => this.showError(error));
				})
			);

			this.savedRenderDisposables.add(
				addDisposableListener(removeButton, EventType.CLICK, event => {
					event.preventDefault();
					event.stopPropagation();
					this.removeSavedConnection(saved.id).catch(error => this.showError(error));
				})
			);
		}
	}

	private async openQueryForNode(node: SqlConnectionTreeNode): Promise<void> {
		const draft = createSqlEditorDraftFromTreeNode(node, {
			connectionName: node.connectionId ? this.getConnectionName(node.connectionId) : undefined,
			columns: this.getColumnsForNode(node)
		});

		await this.openDraft(draft);
	}

	private async openDraft(draft: SqlEditorDraft): Promise<void> {
		await this.commandService.executeCommand(SQL_NEW_QUERY_COMMAND_ID, draft);
	}

	private getConnectionName(connectionId: string): string | undefined {
		return this.state.connections.find(connection => connection.id === connectionId)?.name;
	}

	private getColumnsForNode(node: SqlConnectionTreeNode): SqlColumn[] {
		if (!node.connectionId || !isSqlTableLikeNode(node)) {
			return [];
		}

		const table = tableFromNode(node);
		return this.state.columnsByTableId[getColumnsKey(node.connectionId, table)] ?? [];
	}

	private async refreshConnection(connectionId: string): Promise<void> {
		const connection = this.state.connections.find(item => item.id === connectionId);

		if (!connection) {
			throw new Error(`Connection '${connectionId}' is not open.`);
		}

		this.showInfo(`Refreshing ${connection.name}...`);
		this.removeMetadataForConnection(connectionId);
		await this.loadConnectionMetadata(connection);
		this.collapsedNodes.delete(getConnectionNodeId(connectionId));
		this.renderTree();
		this.showInfo(`Refreshed ${connection.name}.`);
	}

	private async refreshTable(node: SqlConnectionTreeNode): Promise<void> {
		if (!node.connectionId || !isSqlTableLikeNode(node)) {
			throw new Error('Cannot refresh columns for this node.');
		}

		const table = tableFromNode(node);

		this.showInfo(`Refreshing ${table.name}...`);

		const columns = await this.sqlMetadataService.listColumns({
			connectionId: node.connectionId,
			schema: table.schema,
			tableName: table.name
		});

		this.state.columnsByTableId[getColumnsKey(node.connectionId, table)] = columns;
		this.collapsedNodes.delete(node.id);
		this.renderTree();
		this.showInfo(`Refreshed ${table.name}.`);
	}

	private removeMetadataForConnection(connectionId: string): void {
		delete this.state.tablesByConnectionId[connectionId];
		delete this.state.errorsByConnectionId[connectionId];

		const prefix = `${getConnectionNodeId(connectionId)}/`;

		for (const key of Object.keys(this.state.columnsByTableId)) {
			if (key.startsWith(prefix)) {
				delete this.state.columnsByTableId[key];
			}
		}
	}

	private async copyQualifiedName(node: SqlConnectionTreeNode): Promise<void> {
		const text = createCopyQualifiedNameTextFromTreeNode(node);
		await writeClipboardText(text);
		this.showInfo(`Copied ${text}.`);
	}

	private async openSavedConnection(saved: SqlSavedConnection): Promise<void> {
		const alreadyOpen = this.state.connections.some(connection => connection.id === saved.id);

		if (alreadyOpen) {
			this.collapsedNodes.delete(getConnectionNodeId(saved.id));
			this.showInfo(`${saved.name} is already connected.`);
			this.renderTree();
			return;
		}

		await this.sqlConnectionService.openConnection({
			id: saved.id,
			name: saved.name,
			kind: saved.kind,
			databasePath: saved.databasePath,
			readOnly: saved.readOnly,
			createIfMissing: saved.createIfMissing
		});

		this.collapsedNodes.delete(getConnectionNodeId(saved.id));
		this.showInfo(`Connected to ${saved.name}.`);
		await this.refresh();
	}

	private async removeSavedConnection(connectionId: string): Promise<void> {
		await this.sqlConnectionService.removeSavedConnection({
			connectionId,
			closeIfOpen: false
		});

		this.showInfo('Saved connection removed.');
		await this.refresh();
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

		const message = error instanceof Error ? error.message : String(error);
		this.messageElement.classList.add('error');
		this.messageElement.textContent = message;
		this.notificationService.error(message);
	}
}

function getConnectionNodeId(connectionId: string): string {
	return `sql/connection/${encodeURIComponent(connectionId)}`;
}

function isActionableNode(node: SqlConnectionTreeNode): boolean {
	return node.type === SqlConnectionTreeNodeType.Connection || isSqlTableLikeNode(node);
}

function tableFromNode(node: SqlConnectionTreeNode): Pick<SqlTable, 'schema' | 'name' | 'tableType'> {
	return {
		schema: node.schema,
		name: node.tableName ?? node.label,
		tableType: getSqlTableTypeFromNode(node)
	};
}

function getNodeIcon(node: SqlConnectionTreeNode): string {
	switch (node.type) {
		case SqlConnectionTreeNodeType.Connection:
			return '\u25c9';
		case SqlConnectionTreeNodeType.Group:
			return '\u25a3';
		case SqlConnectionTreeNodeType.Table:
			return '\u25a6';
		case SqlConnectionTreeNodeType.View:
			return '\u25eb';
		case SqlConnectionTreeNodeType.Column:
			return '\u2022';
		case SqlConnectionTreeNodeType.Error:
			return '!';
		case SqlConnectionTreeNodeType.Empty:
		default:
			return '\u00b7';
	}
}

function isPersistableDatabasePath(databasePath: string): boolean {
	return databasePath.trim() !== ':memory:';
}

async function writeClipboardText(text: string): Promise<void> {
	if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}

	throw new Error('Clipboard API is not available.');
}
```

---

# 4. CSS 追加

路径：

```txt id="orp7ez"
src/vs/workbench/contrib/sqlConnections/browser/media/sqlConnections.css
```

追加或合并下面样式：

```css id="h9j2mj"
.sql-connection-node-actions {
	margin-left: auto;
	display: flex;
	align-items: center;
	gap: 4px;
	opacity: 0;
	transition: opacity 80ms ease-out;
}

.sql-connection-node:hover .sql-connection-node-actions,
.sql-connection-node:focus-within .sql-connection-node-actions {
	opacity: 1;
}

.sql-connection-node-action {
	height: 20px;
	padding: 0 6px;
	border: 1px solid var(--vscode-button-border);
	color: var(--vscode-button-secondaryForeground);
	background: var(--vscode-button-secondaryBackground);
	cursor: pointer;
	font-size: 11px;
	line-height: 18px;
	border-radius: 2px;
}

.sql-connection-node-action:hover {
	background: var(--vscode-button-hoverBackground);
}

.sql-connection-node-action.danger {
	color: var(--vscode-errorForeground);
}

.sql-connection-node-label {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.sql-connection-node-description {
	flex: 0 0 auto;
}
```

---

# 5. 新增 `sqlConnectionTemplateModel.test.ts`

路径：

```txt id="0upe23"
src/vs/workbench/contrib/sqlConnections/test/sqlConnectionTemplateModel.test.ts
```

```ts id="ry2g3j"
import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlColumn } from '../../../services/sql/common/sqlTypes.js';
import {
	createCopyQualifiedNameText,
	createCopyTableNameText,
	createCountTemplate,
	createInsertTemplate,
	createSelectTemplate,
	createSqlParameterName,
	createUpdateTemplate,
	normalizeTemplateColumns
} from '../common/sqlConnectionTemplateModel.js';

const columns: SqlColumn[] = [
	{
		name: 'id',
		dataType: 'INTEGER',
		ordinal: 0,
		primaryKey: true,
		notNull: true,
		defaultValue: undefined
	},
	{
		name: 'name',
		dataType: 'TEXT',
		ordinal: 1,
		primaryKey: false,
		notNull: false,
		defaultValue: undefined
	},
	{
		name: 'created_at',
		dataType: 'TEXT',
		ordinal: 2,
		primaryKey: false,
		notNull: false,
		defaultValue: undefined
	}
];

test('createSelectTemplate creates SQLite preview SQL', () => {
	assert.equal(
		createSelectTemplate({
			schema: 'main',
			tableName: 'users'
		}).sql,
		`SELECT *
FROM "users"
LIMIT 100;
`
	);
});

test('createSelectTemplate supports custom limit', () => {
	assert.equal(
		createSelectTemplate(
			{
				schema: 'analytics',
				tableName: 'events'
			},
			50
		).sql,
		`SELECT *
FROM "analytics"."events"
LIMIT 50;
`
	);
});

test('createCountTemplate creates count SQL', () => {
	assert.equal(
		createCountTemplate({
			schema: 'main',
			tableName: 'users'
		}).sql,
		`SELECT COUNT(*) AS "count"
FROM "users";
`
	);
});

test('createInsertTemplate creates insert template with columns', () => {
	assert.equal(
		createInsertTemplate({
			schema: 'main',
			tableName: 'users',
			columns
		}).sql,
		`INSERT INTO "users" ("id", "name", "created_at")
VALUES (:id, :name, :created_at);
`
	);
});

test('createInsertTemplate creates default values template without columns', () => {
	assert.equal(
		createInsertTemplate({
			schema: 'main',
			tableName: 'users',
			columns: []
		}).sql,
		`INSERT INTO "users"
DEFAULT VALUES;
`
	);
});

test('createUpdateTemplate uses primary key in WHERE clause', () => {
	assert.equal(
		createUpdateTemplate({
			schema: 'main',
			tableName: 'users',
			columns
		}).sql,
		`UPDATE "users"
SET "name" = :name,
    "created_at" = :created_at
WHERE "id" = :id;
`
	);
});

test('createUpdateTemplate falls back to first column when no primary key exists', () => {
	const noPrimaryKeyColumns = columns.map(column => ({
		...column,
		primaryKey: false
	}));

	assert.equal(
		createUpdateTemplate({
			schema: 'main',
			tableName: 'users',
			columns: noPrimaryKeyColumns
		}).sql,
		`UPDATE "users"
SET "name" = :name,
    "created_at" = :created_at
WHERE "id" = :id;
`
	);
});

test('createUpdateTemplate creates placeholder when no columns exist', () => {
	assert.equal(
		createUpdateTemplate({
			schema: 'main',
			tableName: 'users',
			columns: []
		}).sql,
		`UPDATE "users"
SET -- column = value
WHERE -- condition;
`
	);
});

test('createCopyTableNameText returns raw table name', () => {
	assert.equal(
		createCopyTableNameText({
			schema: 'main',
			tableName: ' users '
		}),
		'users'
	);
});

test('createCopyQualifiedNameText returns quoted qualified name', () => {
	assert.equal(
		createCopyQualifiedNameText({
			schema: 'analytics',
			tableName: 'events'
		}),
		'"analytics"."events"'
	);
});

test('normalizeTemplateColumns sorts trims and removes duplicates', () => {
	const result = normalizeTemplateColumns([
		{
			name: ' name ',
			dataType: 'TEXT',
			ordinal: 2,
			primaryKey: false,
			notNull: false,
			defaultValue: undefined
		},
		{
			name: 'id',
			dataType: 'INTEGER',
			ordinal: 1,
			primaryKey: true,
			notNull: true,
			defaultValue: undefined
		},
		{
			name: 'id',
			dataType: 'INTEGER',
			ordinal: 3,
			primaryKey: false,
			notNull: false,
			defaultValue: undefined
		}
	]);

	assert.deepEqual(
		result.map(column => column.name),
		['id', 'name']
	);
});

test('createSqlParameterName sanitizes invalid characters', () => {
	assert.equal(createSqlParameterName('created at', 0), ':created_at');
	assert.equal(createSqlParameterName('123 name', 0), ':_123_name');
	assert.equal(createSqlParameterName('---', 1), ':value2');
});

test('template helpers reject empty table name', () => {
	assert.throws(
		() =>
			createCopyQualifiedNameText({
				schema: 'main',
				tableName: '   '
			}),
		/tableName must not be empty/
	);
});
```

---

# 6. 修改 `sqlConnectionQueryModel.test.ts`

路径：

```txt id="8n8zm9"
src/vs/workbench/contrib/sqlConnections/test/sqlConnectionQueryModel.test.ts
```

追加以下测试：

```ts id="7r2tjq"
import {
	createCopyQualifiedNameTextFromTreeNode,
	createCopyTableNameTextFromTreeNode,
	createCountDraftFromTreeNode,
	createInsertDraftFromTreeNode,
	createSelectDraftFromTreeNode,
	createUpdateDraftFromTreeNode,
	isSqlMutableTableNode,
	isSqlTableLikeNode
} from '../common/sqlConnectionQueryModel.js';

test('createSelectDraftFromTreeNode creates SELECT draft', () => {
	const draft = createSelectDraftFromTreeNode({
		id: 'table-users',
		type: SqlConnectionTreeNodeType.Table,
		label: 'users',
		connectionId: 'local',
		schema: 'main',
		tableName: 'users'
	});

	assert.equal(
		draft.initialSql,
		`SELECT *
FROM "users"
LIMIT 100;
`
	);
});

test('createCountDraftFromTreeNode creates COUNT draft', () => {
	const draft = createCountDraftFromTreeNode({
		id: 'table-users',
		type: SqlConnectionTreeNodeType.Table,
		label: 'users',
		connectionId: 'local',
		schema: 'main',
		tableName: 'users'
	});

	assert.equal(
		draft.initialSql,
		`SELECT COUNT(*) AS "count"
FROM "users";
`
	);
});

test('createInsertDraftFromTreeNode creates INSERT draft', () => {
	const draft = createInsertDraftFromTreeNode(
		{
			id: 'table-users',
			type: SqlConnectionTreeNodeType.Table,
			label: 'users',
			connectionId: 'local',
			schema: 'main',
			tableName: 'users'
		},
		{
			columns: [
				{
					name: 'id',
					dataType: 'INTEGER',
					ordinal: 0,
					primaryKey: true,
					notNull: true,
					defaultValue: undefined
				},
				{
					name: 'name',
					dataType: 'TEXT',
					ordinal: 1,
					primaryKey: false,
					notNull: false,
					defaultValue: undefined
				}
			]
		}
	);

	assert.equal(
		draft.initialSql,
		`INSERT INTO "users" ("id", "name")
VALUES (:id, :name);
`
	);
});

test('createUpdateDraftFromTreeNode creates UPDATE draft', () => {
	const draft = createUpdateDraftFromTreeNode(
		{
			id: 'table-users',
			type: SqlConnectionTreeNodeType.Table,
			label: 'users',
			connectionId: 'local',
			schema: 'main',
			tableName: 'users'
		},
		{
			columns: [
				{
					name: 'id',
					dataType: 'INTEGER',
					ordinal: 0,
					primaryKey: true,
					notNull: true,
					defaultValue: undefined
				},
				{
					name: 'name',
					dataType: 'TEXT',
					ordinal: 1,
					primaryKey: false,
					notNull: false,
					defaultValue: undefined
				}
			]
		}
	);

	assert.equal(
		draft.initialSql,
		`UPDATE "users"
SET "name" = :name
WHERE "id" = :id;
`
	);
});

test('copy helpers create table name text', () => {
	const node = {
		id: 'table-events',
		type: SqlConnectionTreeNodeType.Table,
		label: 'events',
		connectionId: 'local',
		schema: 'analytics',
		tableName: 'events'
	};

	assert.equal(createCopyTableNameTextFromTreeNode(node), 'events');
	assert.equal(createCopyQualifiedNameTextFromTreeNode(node), '"analytics"."events"');
});

test('table like node guards work', () => {
	assert.equal(
		isSqlTableLikeNode({
			id: 'table-users',
			type: SqlConnectionTreeNodeType.Table,
			label: 'users'
		}),
		true
	);

	assert.equal(
		isSqlTableLikeNode({
			id: 'views',
			type: SqlConnectionTreeNodeType.Group,
			label: 'Views'
		}),
		false
	);

	assert.equal(
		isSqlMutableTableNode({
			id: 'table-users',
			type: SqlConnectionTreeNodeType.Table,
			label: 'users'
		}),
		true
	);

	assert.equal(
		isSqlMutableTableNode({
			id: 'view-users',
			type: SqlConnectionTreeNodeType.View,
			label: 'users'
		}),
		false
	);
});
```

---

# 7. 修改 `package.json`

当前 `test:sql-connections` 只跑 TreeModel 和 QueryModel。
改为：

```json id="ak7p4c"
{
  "scripts": {
    "test:sql-connections": "node --test --import tsx src/vs/workbench/contrib/sqlConnections/test/sqlConnectionTreeModel.test.ts src/vs/workbench/contrib/sqlConnections/test/sqlConnectionQueryModel.test.ts src/vs/workbench/contrib/sqlConnections/test/sqlConnectionTemplateModel.test.ts"
  }
}
```

总 `test` 不用改，因为已经包含 `test:sql-connections`。

---

# 8. 验收命令

```bash id="jlxqag"
pnpm run test:sql-connections
pnpm run test
pnpm run lint
pnpm run build
```

---

# 9. 手动验收

```txt id="vq2tky"
1. 启动应用
2. 添加 SQLite 连接
3. 展开 Tables
4. 表节点能看到：
   SELECT / COUNT / INSERT / UPDATE / Copy / Refresh
5. 视图节点能看到：
   SELECT / COUNT / Copy / Refresh
6. 点击 SELECT：
   打开 SQL Editor，生成 SELECT * FROM "table" LIMIT 100;
7. 点击 COUNT：
   打开 SQL Editor，生成 SELECT COUNT(*) AS "count" FROM "table";
8. 点击 INSERT：
   根据列生成 INSERT INTO 模板
9. 点击 UPDATE：
   根据主键生成 WHERE 条件
10. 点击 Copy：
    复制 qualified table name
11. 点击 Refresh：
    只刷新该表 columns
12. 点击连接节点 Refresh：
    只刷新该连接 metadata
```

---

# Phase 7.4 完成标准

```txt id="sa0cg0"
Schema Tree 支持局部刷新
表/视图支持 Copy qualified name
表/视图支持 SELECT / COUNT 生成
表支持 INSERT / UPDATE 模板生成
模板生成逻辑有完整单元测试
不引入多数据库 UI
不引入 AI
不引入插件
```

下一阶段：

```txt id="d2yj3i"
Phase 8：产品收口 / Workbench 裁剪
```
