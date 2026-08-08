/*---------------------------------------------------------------------------------------------
 * Nyala Studio - Phase 02 SQL Explorer view.
 *
 * Side-by-side companion to the legacy `SqlConnectionsView`. Consumes
 * the Phase 02 `SqlConnectionTreeModel` directly:
 *
 *   * datasource level -> click to load schemas via ConnectionManager
 *   * schema level     -> click to load tables
 *   * table level      -> click to load columns
 *
 * Per-node state (idle / loading / loaded / error) is rendered inline.
 * Planned drivers are filtered out by the model itself.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlConnections.css';

import { $, addDisposableListener, append, clearNode, EventType } from 'vs/base/browser/dom';
import { DisposableStore } from 'vs/base/common/lifecycle';
import { localize } from 'vs/nls';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IHoverService } from 'vs/platform/hover/browser/hover';
import { IViewDescriptorService } from 'vs/workbench/common/views';
import { ViewPane, IViewPaneOptions } from 'vs/workbench/browser/parts/views/viewPane';

import { ISqlConnectionServiceV2 } from 'vs/workbench/services/sql/common/sqlConnection';
import { ISqlMetadataService } from 'vs/workbench/services/sql/common/sqlMetadata';
import { ISqlDriverCatalogService } from 'vs/workbench/services/sql/common/sqlDriverCatalog';

import {
	DatasourceNode,
	SchemaNode,
	SqlConnectionTreeModel,
	TableNode,
	TreeNode
} from 'vs/workbench/contrib/sqlConnections/browser/sqlConnectionTreeModel';

export const SQL_EXPLORER_VIEW_ID = 'sqlStudio.connectionsExplorer';

const TWISTY_EXPANDED = '\u25be';
const TWISTY_COLLAPSED = '\u25b8';

type VisualState = 'idle' | 'collapsed' | 'expanded';

interface RowRenderState {
	readonly ds: VisualState;
	readonly schemas: Map<string, VisualState>;
	readonly tables: Map<string, VisualState>;
}

export class SqlExplorerView extends ViewPane {
	static readonly ID = SQL_EXPLORER_VIEW_ID;
	static readonly NAME = localize('sqlExplorerViewName', 'SQL Explorer');

	private bodyContainer!: HTMLElement;
	private treeElement!: HTMLElement;
	private messageElement!: HTMLElement;
	private readonly treeRenderDisposables = this._register(new DisposableStore());
	private readonly rowStates = new Map<string, RowRenderState>();

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
		@ISqlConnectionServiceV2 private readonly connections: ISqlConnectionServiceV2,
		@ISqlMetadataService private readonly metadata: ISqlMetadataService,
		@ISqlDriverCatalogService private readonly catalog: ISqlDriverCatalogService
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
		this.bodyContainer = append(container, $('.sql-connections-view'));
		this.messageElement = append(this.bodyContainer, $('.sql-connections-message'));
		this.treeElement = append(this.bodyContainer, $('.sql-connections-tree', { role: 'tree', tabIndex: 0 }));

		const model = new SqlConnectionTreeModel(this.connections, this.metadata, this.catalog);
		void model.rebuild();
		this._register(model.onDidChange(() => this.renderTree(model)));

		void this.renderTree(model);
	}

	private async renderTree(model: SqlConnectionTreeModel): Promise<void> {
		this.treeRenderDisposables.clear();
		clearNode(this.treeElement);

		const datasources = model.list();
		this.renderMessage(
			datasources.length === 0 ? localize('sqlExplorerEmpty', 'No connections yet. Add one in SQL Connections.') : ''
		);

		for (const ds of datasources) {
			const row = this.ensureRowState(ds.profileId, 'collapsed');
			this.treeElement.appendChild(this.renderDatasource(ds, row.ds, model));
		}
	}

	private renderDatasource(node: DatasourceNode, visual: VisualState, model: SqlConnectionTreeModel): HTMLElement {
		const rowState = this.ensureRowState(node.profileId, visual);
		const wrapper = $('.sql-connection-node-wrapper');
		const row = append(wrapper, $('.sql-connection-node', { role: 'treeitem' }));
		row.style.paddingLeft = '8px';
		row.classList.add('type-connection');

		const twisty = this.renderTwisty(row, visual === 'expanded', () => {
			void this.toggleDatasource(node.profileId, model);
		});

		const icon = append(row, $('span.sql-connection-node-icon'));
		icon.textContent = '\u25c6';
		const label = append(row, $('span.sql-connection-node-label'));
		label.textContent = node.label;
		const description = append(row, $('span.sql-connection-node-description'));
		description.textContent = this.formatState(node.state.kind);

		if (node.state.kind === 'error') {
			row.classList.add('has-error');
			const errEl = append(row, $('span.sql-connection-node-error'));
			errEl.textContent = node.state.message;
		}

		const refresh = append(
			row,
			$('button.sql-connection-node-refresh', {
				type: 'button',
				title: localize('sqlExplorerRefresh', 'Refresh')
			})
		);
		refresh.textContent = '\u21bb';
		this.treeRenderDisposables.add(
			addDisposableListener(refresh, EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				void model.refresh(node);
			})
		);

		if (visual === 'expanded') {
			for (const schema of node.schemas) {
				const visualSchema = rowState.schemas.get(schema.schema) ?? 'collapsed';
				wrapper.appendChild(this.renderSchema(schema, visualSchema, model));
			}
		}

		void twisty;
		return wrapper;
	}

	private renderSchema(node: SchemaNode, visual: VisualState, model: SqlConnectionTreeModel): HTMLElement {
		const rowState = this.ensureRowState(node.profileId, 'collapsed');
		const wrapper = $('.sql-connection-node-wrapper');
		const row = append(wrapper, $('.sql-connection-node', { role: 'treeitem' }));
		row.style.paddingLeft = '22px';
		row.classList.add('type-schema');

		const twisty = this.renderTwisty(row, visual === 'expanded', () => {
			void this.toggleSchema(node.profileId, node.schema, model);
		});

		const icon = append(row, $('span.sql-connection-node-icon'));
		icon.textContent = '\u25a4';
		const label = append(row, $('span.sql-connection-node-label'));
		label.textContent = node.schema;
		const description = append(row, $('span.sql-connection-node-description'));
		description.textContent = this.formatState(node.state.kind);

		if (node.state.kind === 'error') {
			row.classList.add('has-error');
			const errEl = append(row, $('span.sql-connection-node-error'));
			errEl.textContent = node.state.message;
		}

		const refresh = append(
			row,
			$('button.sql-connection-node-refresh', {
				type: 'button',
				title: localize('sqlExplorerRefresh', 'Refresh')
			})
		);
		refresh.textContent = '\u21bb';
		this.treeRenderDisposables.add(
			addDisposableListener(refresh, EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				void model.refresh(node);
			})
		);

		if (visual === 'expanded') {
			for (const table of node.tables) {
				const key = `${node.profileId}|${node.schema}|${table.table}`;
				const visualTable = rowState.tables.get(key) ?? 'collapsed';
				wrapper.appendChild(this.renderTable(table, visualTable, model));
			}
		}

		void twisty;
		return wrapper;
	}

	private renderTable(node: TableNode, visual: VisualState, model: SqlConnectionTreeModel): HTMLElement {
		const wrapper = $('.sql-connection-node-wrapper');
		const row = append(wrapper, $('.sql-connection-node', { role: 'treeitem' }));
		row.style.paddingLeft = '36px';
		row.classList.add(node.objectKind === 'view' ? 'type-view' : 'type-table');

		const twisty = this.renderTwisty(row, visual === 'expanded', () => {
			void this.toggleTable(node.profileId, node.schema, node.table, model);
		});

		const icon = append(row, $('span.sql-connection-node-icon'));
		icon.textContent = node.objectKind === 'view' ? '\u25ce' : '\u25ab';
		const label = append(row, $('span.sql-connection-node-label'));
		label.textContent = node.table;
		const description = append(row, $('span.sql-connection-node-description'));
		description.textContent = this.formatState(node.state.kind);

		if (node.state.kind === 'error') {
			row.classList.add('has-error');
			const errEl = append(row, $('span.sql-connection-node-error'));
			errEl.textContent = node.state.message;
		}

		const refresh = append(
			row,
			$('button.sql-connection-node-refresh', {
				type: 'button',
				title: localize('sqlExplorerRefresh', 'Refresh')
			})
		);
		refresh.textContent = '\u21bb';
		this.treeRenderDisposables.add(
			addDisposableListener(refresh, EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				void model.refresh(node);
			})
		);

		if (visual === 'expanded') {
			if (node.columns.length === 0) {
				const empty = append(wrapper, $('.sql-connection-column-row.empty'));
				empty.textContent = this.formatState(node.state.kind);
				return wrapper;
			}
			for (const col of node.columns) {
				const colRow = append(wrapper, $('.sql-connection-column-row'));
				colRow.style.paddingLeft = '50px';
				const name = append(colRow, $('span.sql-connection-column-name'));
				name.textContent = col.name;
				if (col.isPrimaryKey) {
					name.classList.add('is-primary-key');
				}
				const type = append(colRow, $('span.sql-connection-column-type'));
				type.textContent = col.dataType;
				const flags = append(colRow, $('span.sql-connection-column-flags'));
				flags.textContent = [col.isPrimaryKey ? 'PK' : '', col.isNullable ? '' : 'NOT NULL']
					.filter(Boolean)
					.join(' · ');
			}
		}

		void twisty;
		return wrapper;
	}

	private renderTwisty(parent: HTMLElement, expanded: boolean, onClick: () => void): HTMLButtonElement {
		const twisty = append(
			parent,
			$('button.sql-connection-node-twisty', {
				type: 'button',
				tabIndex: 0,
				'aria-label': expanded ? 'Collapse' : 'Expand',
				'aria-expanded': String(expanded)
			})
		) as HTMLButtonElement;
		twisty.textContent = expanded ? TWISTY_EXPANDED : TWISTY_COLLAPSED;
		this.treeRenderDisposables.add(
			addDisposableListener(twisty, EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				onClick();
			})
		);
		return twisty;
	}

	private async toggleDatasource(profileId: string, model: SqlConnectionTreeModel): Promise<void> {
		const state = this.rowStates.get(profileId);
		if (!state) {
			return;
		}
		const next = state.ds === 'expanded' ? 'collapsed' : 'expanded';
		this.rowStates.set(profileId, { ...state, ds: next });
		if (next === 'expanded') {
			await model.expandDatasource(profileId);
		}
		void this.renderTree(model);
	}

	private async toggleSchema(profileId: string, schema: string, model: SqlConnectionTreeModel): Promise<void> {
		const state = this.rowStates.get(profileId);
		if (!state) {
			return;
		}
		const current = state.schemas.get(schema) ?? 'collapsed';
		const next = current === 'expanded' ? 'collapsed' : 'expanded';
		const nextSchemas = new Map(state.schemas);
		nextSchemas.set(schema, next);
		this.rowStates.set(profileId, { ...state, schemas: nextSchemas });
		if (next === 'expanded') {
			await model.expandSchema(profileId, schema);
		}
		void this.renderTree(model);
	}

	private async toggleTable(
		profileId: string,
		schema: string,
		table: string,
		model: SqlConnectionTreeModel
	): Promise<void> {
		const state = this.rowStates.get(profileId);
		if (!state) {
			return;
		}
		const key = `${profileId}|${schema}|${table}`;
		const current = state.tables.get(key) ?? 'collapsed';
		const next = current === 'expanded' ? 'collapsed' : 'expanded';
		const nextTables = new Map(state.tables);
		nextTables.set(key, next);
		this.rowStates.set(profileId, { ...state, tables: nextTables });
		if (next === 'expanded') {
			await model.expandTable(profileId, schema, table);
		}
		void this.renderTree(model);
	}

	private renderMessage(text: string): void {
		if (!this.messageElement) {
			return;
		}
		clearNode(this.messageElement);
		if (text.length === 0) {
			this.messageElement.style.display = 'none';
			return;
		}
		this.messageElement.style.display = '';
		this.messageElement.textContent = text;
	}

	private ensureRowState(profileId: string, ds: VisualState): RowRenderState {
		const existing = this.rowStates.get(profileId);
		if (existing) {
			return existing;
		}
		const state: RowRenderState = {
			ds,
			schemas: new Map(),
			tables: new Map()
		};
		this.rowStates.set(profileId, state);
		return state;
	}

	private formatState(kind: 'idle' | 'loading' | 'loaded' | 'error'): string {
		switch (kind) {
			case 'idle':
				return '';
			case 'loading':
				return 'loading...';
			case 'loaded':
				return '';
			case 'error':
				return '';
		}
	}

	/** Test helper exposed for node tests. */
	static buildTreeArgs(node: TreeNode): string {
		switch (node.kind) {
			case 'datasource':
				return `datasource:${node.profileId}`;
			case 'schema':
				return `schema:${node.profileId}/${node.schema}`;
			case 'table':
				return `table:${node.profileId}/${node.schema}/${node.table}`;
		}
	}
}
