/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - advanced capability service.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	IStorageService,
	StorageScope,
	StorageTarget
} from '../../../../platform/storage/common/storage.js';
import { SqlDialect } from '../../../services/sql/common/sqlDialect.js';
import { SQL_ADVANCED_SNIPPETS_STORAGE_KEY, SQL_ADVANCED_WORKSPACE_STORAGE_KEY } from './sqlAdvanced.js';
import { createExplainSql, SqlExplainPlanRequest } from './sqlAdvancedExplain.js';
import { formatSql, SqlFormatOptions } from './sqlAdvancedFormatter.js';
import {
	BUILTIN_SQL_SNIPPETS,
	mergeSnippets,
	normalizeSnippet,
	SqlSnippet
} from './sqlAdvancedSnippets.js';
import {
	createDefaultWorkspaceProject,
	normalizeWorkspaceProject,
	SqlWorkspaceProject
} from './sqlAdvancedWorkspace.js';
import {
	DeterministicSqlAiProvider,
	ISqlAiProvider,
	SqlAiRequest,
	SqlAiResponse
} from './sqlAdvancedAi.js';
import {
	SqlStudioPluginManifest,
	SqlStudioPluginRegistry,
	SqlStudioRegisteredPlugin
} from './sqlAdvancedPluginApi.js';

export const ISqlAdvancedService = createDecorator<ISqlAdvancedService>('sqlAdvancedService');

export interface ISqlAdvancedService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeWorkspace: Event<SqlWorkspaceProject>;
	readonly onDidChangeSnippets: Event<readonly SqlSnippet[]>;

	getWorkspace(): SqlWorkspaceProject;
	saveWorkspace(project: SqlWorkspaceProject): void;

	listSnippets(): SqlSnippet[];
	saveSnippet(snippet: SqlSnippet): void;

	format(sql: string, options?: SqlFormatOptions): string;
	createExplainSql(request: SqlExplainPlanRequest): string;

	registerPlugin(manifest: SqlStudioPluginManifest): SqlStudioRegisteredPlugin;
	listPlugins(): SqlStudioRegisteredPlugin[];

	completeAi(request: SqlAiRequest): Promise<SqlAiResponse>;
}

export class SqlAdvancedService extends Disposable implements ISqlAdvancedService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeWorkspace = this._register(new Emitter<SqlWorkspaceProject>());
	readonly onDidChangeWorkspace = this._onDidChangeWorkspace.event;

	private readonly _onDidChangeSnippets = this._register(new Emitter<readonly SqlSnippet[]>());
	readonly onDidChangeSnippets = this._onDidChangeSnippets.event;

	private readonly pluginRegistry = new SqlStudioPluginRegistry();

	private workspace: SqlWorkspaceProject;
	private snippets: SqlSnippet[];

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		private readonly aiProvider: ISqlAiProvider = new DeterministicSqlAiProvider()
	) {
		super();

		this.workspace = this.loadWorkspace();
		this.snippets = this.loadSnippets();
	}

	getWorkspace(): SqlWorkspaceProject {
		return this.workspace;
	}

	saveWorkspace(project: SqlWorkspaceProject): void {
		this.workspace = normalizeWorkspaceProject(project);
		this.storageService.store(
			SQL_ADVANCED_WORKSPACE_STORAGE_KEY,
			JSON.stringify(this.workspace),
			StorageScope.PROFILE,
			StorageTarget.USER
		);
		this._onDidChangeWorkspace.fire(this.workspace);
	}

	listSnippets(): SqlSnippet[] {
		return mergeSnippets(BUILTIN_SQL_SNIPPETS, this.snippets);
	}

	saveSnippet(snippet: SqlSnippet): void {
		const normalized = normalizeSnippet({
			...snippet,
			builtin: false
		});

		this.snippets = [
			...this.snippets.filter(item => item.id !== normalized.id),
			normalized
		];

		this.storageService.store(
			SQL_ADVANCED_SNIPPETS_STORAGE_KEY,
			JSON.stringify(this.snippets),
			StorageScope.PROFILE,
			StorageTarget.USER
		);

		this._onDidChangeSnippets.fire(this.listSnippets());
	}

	format(sql: string, options: SqlFormatOptions = {}): string {
		return formatSql(sql, options);
	}

	createExplainSql(request: SqlExplainPlanRequest): string {
		return createExplainSql(request);
	}

	registerPlugin(manifest: SqlStudioPluginManifest): SqlStudioRegisteredPlugin {
		return this.pluginRegistry.registerPlugin(manifest);
	}

	listPlugins(): SqlStudioRegisteredPlugin[] {
		return this.pluginRegistry.listPlugins();
	}

	completeAi(request: SqlAiRequest): Promise<SqlAiResponse> {
		return this.aiProvider.complete(request);
	}

	private loadWorkspace(): SqlWorkspaceProject {
		const raw = this.storageService.getObject<SqlWorkspaceProject>(
			SQL_ADVANCED_WORKSPACE_STORAGE_KEY,
			StorageScope.PROFILE,
			undefined
		);

		return raw ? normalizeWorkspaceProject(raw) : createDefaultWorkspaceProject();
	}

	private loadSnippets(): SqlSnippet[] {
		const raw = this.storageService.getObject<SqlSnippet[]>(
			SQL_ADVANCED_SNIPPETS_STORAGE_KEY,
			StorageScope.PROFILE,
			undefined
		);

		if (!Array.isArray(raw)) {
			return [];
		}

		return raw.map(normalizeSnippet);
	}
}

export function getDialectForAdvancedConnectionKind(kind: string | undefined): SqlDialect {
	switch (kind) {
		case 'mysql':
			return SqlDialect.MySql;

		case 'postgresql':
			return SqlDialect.PostgreSql;

		case 'sqlite':
		default:
			return SqlDialect.Sqlite;
	}
}
