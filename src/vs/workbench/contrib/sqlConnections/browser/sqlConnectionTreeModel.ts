/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL Connections tree model (Phase 02).
 *
 * Builds a three-level tree (datasource → schema → table) on top of
 * `ISqlConnectionServiceV2` + `ISqlMetadataService`. Each node carries a
 * state machine so the view layer can render loading / error / loaded
 * states without re-fetching.
 *
 * Design notes:
 *
 *   * Planned drivers are filtered out at `rebuild()` time. Future
 *     phases can re-introduce them as disabled chips.
 *   * Refresh is per-node — calling `refresh(node)` re-runs the
 *     corresponding expand after invalidating frontend and Agent metadata.
 *   * Tree node shapes are discriminated unions so consumers can rely
 *     on exhaustive `switch (node.kind)`.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { Emitter } from 'vs/base/common/event';

import { ColumnDto, ISqlMetadataService } from 'vs/workbench/services/sql/common/sqlMetadata';
import { ISqlConnectionServiceV2 } from 'vs/workbench/services/sql/common/sqlConnection';
import { ISqlDriverCatalogService } from 'vs/workbench/services/sql/common/sqlDriverCatalog';

export type NodeState =
	| { readonly kind: 'idle' }
	| { readonly kind: 'loading' }
	| { readonly kind: 'loaded'; readonly at: number }
	| { readonly kind: 'error'; readonly message: string };

export interface DatasourceNode {
	readonly kind: 'datasource';
	readonly profileId: string;
	readonly label: string;
	state: NodeState;
	schemas: SchemaNode[];
}

export interface SchemaNode {
	readonly kind: 'schema';
	readonly profileId: string;
	readonly schema: string;
	state: NodeState;
	tables: TableNode[];
}

export interface TableNode {
	readonly kind: 'table';
	readonly profileId: string;
	readonly schema: string;
	readonly table: string;
	readonly objectKind: 'table' | 'view';
	state: NodeState;
	columns: ColumnDto[];
	primaryKey: string[];
}

export type TreeNode = DatasourceNode | SchemaNode | TableNode;

export class SqlConnectionTreeModel extends Disposable {
	declare readonly _brand: 'SqlConnectionTreeModel';
	private readonly _onDidChange = this._register(new Emitter<void>());
	private nodes: DatasourceNode[] = [];
	private readonly metadataEpochs = new Map<string, number>();
	private readonly nodeOperationRevisions = new WeakMap<TreeNode, number>();

	constructor(
		private readonly connections: ISqlConnectionServiceV2,
		private readonly metadata: ISqlMetadataService,
		private readonly catalog: ISqlDriverCatalogService
	) {
		super();
		this._register(
			this.connections.onChange(() => {
				for (const node of this.nodes) {
					this.advanceMetadataEpoch(node.profileId);
					this.metadata.invalidate(node.profileId);
				}
				void this.rebuild();
			})
		);
		this._register(
			this.catalog.onChange(() => {
				void this.rebuild();
			})
		);
	}

	readonly onDidChange = this._onDidChange.event;

	async rebuild(): Promise<void> {
		const list = await this.connections.list();
		this.nodes = list
			.filter(c => {
				try {
					const status = this.catalog.findRuntimeStatus(c.profile.driver)?.status;
					return status !== 'planned' && status !== 'disabled';
				} catch {
					return true;
				}
			})
			.map<DatasourceNode>(c => ({
				kind: 'datasource',
				profileId: c.profile.id,
				label: c.profile.label,
				state: { kind: 'idle' },
				schemas: []
			}));
		this._onDidChange.fire();
	}

	async expandDatasource(profileId: string): Promise<void> {
		const node = this.findDatasource(profileId);
		if (!node) {
			return;
		}
		const epoch = this.metadataEpoch(profileId);
		const previousState = node.state;
		const operationRevision = this.beginNodeOperation(node);
		node.state = { kind: 'loading' };
		this._onDidChange.fire();
		try {
			const schemas = await this.metadata.listSchemas(profileId);
			if (!this.isCurrentOperation(node, epoch, operationRevision)) {
				this.restoreStaleOperation(node, operationRevision, previousState);
				return;
			}
			node.schemas = schemas.map<SchemaNode>(s => ({
				kind: 'schema',
				profileId,
				schema: s.schema,
				state: { kind: 'idle' },
				tables: []
			}));
			node.state = { kind: 'loaded', at: Date.now() };
		} catch (error) {
			if (!this.isCurrentOperation(node, epoch, operationRevision)) {
				this.restoreStaleOperation(node, operationRevision, previousState);
				return;
			}
			node.state = { kind: 'error', message: this.formatError(error) };
		}
		this._onDidChange.fire();
	}

	async expandSchema(profileId: string, schema: string): Promise<void> {
		const ds = this.findDatasource(profileId);
		if (!ds) {
			return;
		}
		const node = ds.schemas.find(s => s.schema === schema);
		if (!node) {
			return;
		}
		const epoch = this.metadataEpoch(profileId);
		const previousState = node.state;
		const operationRevision = this.beginNodeOperation(node);
		node.state = { kind: 'loading' };
		this._onDidChange.fire();
		try {
			const tables = await this.metadata.listTablesV2(profileId, schema);
			if (!this.isCurrentOperation(node, epoch, operationRevision)) {
				this.restoreStaleOperation(node, operationRevision, previousState);
				return;
			}
			node.tables = tables.map<TableNode>(t => ({
				kind: 'table',
				profileId,
				schema,
				table: t.name,
				objectKind: t.kind === 'view' ? 'view' : 'table',
				state: { kind: 'idle' },
				columns: [],
				primaryKey: [...t.primaryKey]
			}));
			node.state = { kind: 'loaded', at: Date.now() };
		} catch (error) {
			if (!this.isCurrentOperation(node, epoch, operationRevision)) {
				this.restoreStaleOperation(node, operationRevision, previousState);
				return;
			}
			node.state = { kind: 'error', message: this.formatError(error) };
		}
		this._onDidChange.fire();
	}

	async expandTable(profileId: string, schema: string, table: string): Promise<void> {
		const ds = this.findDatasource(profileId);
		const sn = ds?.schemas.find(s => s.schema === schema);
		const tn = sn?.tables.find(t => t.table === table);
		if (!tn) {
			return;
		}
		const epoch = this.metadataEpoch(profileId);
		const previousState = tn.state;
		const operationRevision = this.beginNodeOperation(tn);
		tn.state = { kind: 'loading' };
		this._onDidChange.fire();
		try {
			const cols = await this.metadata.listColumnsV2(profileId, schema, table);
			if (!this.isCurrentOperation(tn, epoch, operationRevision)) {
				this.restoreStaleOperation(tn, operationRevision, previousState);
				return;
			}
			tn.columns = cols;
			tn.state = { kind: 'loaded', at: Date.now() };
		} catch (error) {
			if (!this.isCurrentOperation(tn, epoch, operationRevision)) {
				this.restoreStaleOperation(tn, operationRevision, previousState);
				return;
			}
			tn.state = { kind: 'error', message: this.formatError(error) };
		}
		this._onDidChange.fire();
	}

	async refresh(node: TreeNode): Promise<void> {
		const epoch = this.advanceMetadataEpoch(node.profileId);
		const operationRevision = this.beginNodeOperation(node);
		try {
			await this.metadata.refresh(node.profileId);
		} catch (error) {
			if (!this.isCurrentOperation(node, epoch, operationRevision)) {
				return;
			}
			node.state = { kind: 'error', message: this.formatError(error) };
			this._onDidChange.fire();
			return;
		}
		if (!this.isCurrentOperation(node, epoch, operationRevision)) {
			return;
		}
		switch (node.kind) {
			case 'datasource':
				await this.expandDatasource(node.profileId);
				return;
			case 'schema':
				await this.expandSchema(node.profileId, node.schema);
				return;
			case 'table':
				await this.expandTable(node.profileId, node.schema, node.table);
				return;
		}
	}

	list(): readonly DatasourceNode[] {
		return this.nodes;
	}

	private findDatasource(profileId: string): DatasourceNode | undefined {
		return this.nodes.find((n): n is DatasourceNode => n.kind === 'datasource' && n.profileId === profileId);
	}

	private metadataEpoch(profileId: string): number {
		return this.metadataEpochs.get(profileId) ?? 0;
	}

	private advanceMetadataEpoch(profileId: string): number {
		const epoch = this.metadataEpoch(profileId) + 1;
		this.metadataEpochs.set(profileId, epoch);
		return epoch;
	}

	private isCurrentMetadataEpoch(profileId: string, epoch: number): boolean {
		return this.metadataEpoch(profileId) === epoch;
	}

	private beginNodeOperation(node: TreeNode): number {
		const revision = (this.nodeOperationRevisions.get(node) ?? 0) + 1;
		this.nodeOperationRevisions.set(node, revision);
		return revision;
	}

	private isCurrentOperation(node: TreeNode, metadataEpoch: number, operationRevision: number): boolean {
		return (
			this.isCurrentMetadataEpoch(node.profileId, metadataEpoch) &&
			this.nodeOperationRevisions.get(node) === operationRevision
		);
	}

	private restoreStaleOperation(node: TreeNode, operationRevision: number, previousState: NodeState): void {
		if (this.nodeOperationRevisions.get(node) !== operationRevision || node.state.kind !== 'loading') {
			return;
		}
		node.state = previousState;
		this._onDidChange.fire();
	}

	private formatError(error: unknown): string {
		if (error instanceof Error) {
			return error.message;
		}
		if (typeof error === 'string') {
			return error;
		}
		return 'metadata request failed';
	}
}
