/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - workspace project model.
 *--------------------------------------------------------------------------------------------*/

export interface SqlWorkspaceConnectionRef {
	readonly connectionId: string;
	readonly alias?: string;
}

export interface SqlWorkspaceQueryFile {
	readonly path: string;
	readonly title: string;
	readonly connectionId?: string;
}

export interface SqlWorkspaceSnippetFile {
	readonly path: string;
	readonly title: string;
}

export interface SqlWorkspaceProject {
	readonly version: 1;
	readonly name: string;
	readonly rootUri?: string;
	readonly connections: readonly SqlWorkspaceConnectionRef[];
	readonly queries: readonly SqlWorkspaceQueryFile[];
	readonly snippets: readonly SqlWorkspaceSnippetFile[];
	readonly metadataCacheEnabled: boolean;
	readonly updatedAt: number;
}

export function createDefaultWorkspaceProject(name = 'SQL Studio Workspace'): SqlWorkspaceProject {
	return {
		version: 1,
		name: normalizeRequiredString(name, 'name'),
		rootUri: undefined,
		connections: [],
		queries: [],
		snippets: [],
		metadataCacheEnabled: true,
		updatedAt: Date.now()
	};
}

export function normalizeWorkspaceProject(raw: unknown): SqlWorkspaceProject {
	if (!raw || typeof raw !== 'object') {
		return createDefaultWorkspaceProject();
	}

	const value = raw as Partial<SqlWorkspaceProject>;

	return {
		version: 1,
		name: normalizeRequiredString(value.name ?? 'SQL Studio Workspace', 'name'),
		rootUri: normalizeOptionalString(value.rootUri),
		connections: normalizeConnectionRefs(value.connections ?? []),
		queries: normalizeQueryFiles(value.queries ?? []),
		snippets: normalizeSnippetFiles(value.snippets ?? []),
		metadataCacheEnabled: value.metadataCacheEnabled !== false,
		updatedAt: normalizeTimestamp(value.updatedAt)
	};
}

export function addWorkspaceConnection(project: SqlWorkspaceProject, ref: SqlWorkspaceConnectionRef): SqlWorkspaceProject {
	const normalized = normalizeConnectionRef(ref);
	const connections = project.connections.filter(item => item.connectionId !== normalized.connectionId);

	return touchWorkspace({
		...project,
		connections: [...connections, normalized]
	});
}

export function addWorkspaceQuery(project: SqlWorkspaceProject, query: SqlWorkspaceQueryFile): SqlWorkspaceProject {
	const normalized = normalizeQueryFile(query);
	const queries = project.queries.filter(item => item.path !== normalized.path);

	return touchWorkspace({
		...project,
		queries: [...queries, normalized]
	});
}

export function addWorkspaceSnippet(project: SqlWorkspaceProject, snippet: SqlWorkspaceSnippetFile): SqlWorkspaceProject {
	const normalized = normalizeSnippetFile(snippet);
	const snippets = project.snippets.filter(item => item.path !== normalized.path);

	return touchWorkspace({
		...project,
		snippets: [...snippets, normalized]
	});
}

export function serializeWorkspaceProject(project: SqlWorkspaceProject): string {
	return JSON.stringify(normalizeWorkspaceProject(project), null, 2);
}

export function deserializeWorkspaceProject(source: string): SqlWorkspaceProject {
	return normalizeWorkspaceProject(JSON.parse(source));
}

function touchWorkspace(project: SqlWorkspaceProject): SqlWorkspaceProject {
	return {
		...project,
		updatedAt: Date.now()
	};
}

function normalizeConnectionRefs(refs: readonly SqlWorkspaceConnectionRef[]): SqlWorkspaceConnectionRef[] {
	const byId = new Map<string, SqlWorkspaceConnectionRef>();

	for (const ref of refs) {
		const normalized = normalizeConnectionRef(ref);
		byId.set(normalized.connectionId, normalized);
	}

	return [...byId.values()];
}

function normalizeConnectionRef(ref: SqlWorkspaceConnectionRef): SqlWorkspaceConnectionRef {
	return {
		connectionId: normalizeRequiredString(ref.connectionId, 'connectionId'),
		alias: normalizeOptionalString(ref.alias)
	};
}

function normalizeQueryFiles(files: readonly SqlWorkspaceQueryFile[]): SqlWorkspaceQueryFile[] {
	const byPath = new Map<string, SqlWorkspaceQueryFile>();

	for (const file of files) {
		const normalized = normalizeQueryFile(file);
		byPath.set(normalized.path, normalized);
	}

	return [...byPath.values()];
}

function normalizeQueryFile(file: SqlWorkspaceQueryFile): SqlWorkspaceQueryFile {
	return {
		path: normalizeRequiredString(file.path, 'query path'),
		title: normalizeRequiredString(file.title, 'query title'),
		connectionId: normalizeOptionalString(file.connectionId)
	};
}

function normalizeSnippetFiles(files: readonly SqlWorkspaceSnippetFile[]): SqlWorkspaceSnippetFile[] {
	const byPath = new Map<string, SqlWorkspaceSnippetFile>();

	for (const file of files) {
		const normalized = normalizeSnippetFile(file);
		byPath.set(normalized.path, normalized);
	}

	return [...byPath.values()];
}

function normalizeSnippetFile(file: SqlWorkspaceSnippetFile): SqlWorkspaceSnippetFile {
	return {
		path: normalizeRequiredString(file.path, 'snippet path'),
		title: normalizeRequiredString(file.title, 'snippet title')
	};
}

function normalizeTimestamp(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : Date.now();
}

function normalizeRequiredString(value: string, field: string): string {
	const normalized = value?.trim();

	if (!normalized) {
		throw new Error(`${field} must not be empty`);
	}

	return normalized;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}
