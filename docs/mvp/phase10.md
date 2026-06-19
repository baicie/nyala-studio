你说的“这一坨一起给”我按 **一个 Phase 10 整体交付包** 来写，不再拆 10.0/10.1 这种路线。Phase 10 这次一次性覆盖：

```txt id="fgdzgr"
SQL formatter
Explain Plan
Query snippets
Workspace project
插件 API
AI SQL assistant
AI explain error
AI generate query
AI optimize query
```

当前代码里已经有 `SQL_FORMAT_QUERY_COMMAND_ID`，但 `SqlEditorPane.formatQuery()` 还是 placeholder，会提示 “SQL formatter is reserved for a future phase.”，这正好在 Phase 10 替换为真实 formatter。
当前 SQL Studio contribution 也集中在 `workbench.common.main.ts` 的 SQL Studio 区域，Phase 10 新增一个 `sqlAdvanced` contribution 接进去即可。
同时现有 `package.json` 已经有各 SQL 模块测试脚本，Phase 10 追加 `test:sql-advanced` 并接入总测试。

---

# Phase 10：高级能力

## 目标

```txt id="zxgvsa"
1. SQL formatter 从 placeholder 变成可用能力
2. Explain Plan 支持 SQLite / MySQL / PostgreSQL SQL 生成
3. Query snippets 支持内置片段、变量替换、插入编辑器
4. Workspace project 支持本地项目模型、queries/snippets/connections 引用
5. 插件 API 支持插件 manifest、命令注册、SQL action 注册
6. AI SQL assistant 支持 prompt 生成、mock provider、上下文结构
7. AI explain error 支持错误解释 prompt
8. AI generate query 支持自然语言生成 SQL prompt
9. AI optimize query 支持 SQL + explain + schema 上下文 prompt
10. 全部能力提供纯模型单元测试
```

## 不做

```txt id="e5w61u"
1. 不接真实 OpenAI / Anthropic API
2. 不做 marketplace
3. 不加载远程不可信插件
4. 不做完整 Workspace 文件系统 UI
5. 不做复杂 SQL AST formatter
6. 不做 Explain Plan 可视化图
```

---

# 文件变化

新增：

```txt id="r6sysy"
src/vs/workbench/contrib/sqlAdvanced/common/sqlAdvanced.ts
src/vs/workbench/contrib/sqlAdvanced/common/sqlAdvancedFormatter.ts
src/vs/workbench/contrib/sqlAdvanced/common/sqlAdvancedExplain.ts
src/vs/workbench/contrib/sqlAdvanced/common/sqlAdvancedSnippets.ts
src/vs/workbench/contrib/sqlAdvanced/common/sqlAdvancedWorkspace.ts
src/vs/workbench/contrib/sqlAdvanced/common/sqlAdvancedPluginApi.ts
src/vs/workbench/contrib/sqlAdvanced/common/sqlAdvancedAi.ts
src/vs/workbench/contrib/sqlAdvanced/common/sqlAdvancedService.ts
src/vs/workbench/contrib/sqlAdvanced/browser/sqlAdvancedActions.ts
src/vs/workbench/contrib/sqlAdvanced/browser/sqlAdvanced.contribution.ts
src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedFormatter.test.ts
src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedExplain.test.ts
src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedSnippets.test.ts
src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedWorkspace.test.ts
src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedPluginApi.test.ts
src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedAi.test.ts
```

修改：

```txt id="ctw3vj"
src/vs/workbench/contrib/sqlEditor/browser/sqlEditorPane.ts
src/vs/workbench/contrib/sqlEditor/browser/sqlEditorActions.ts
src/vs/workbench/workbench.common.main.ts
package.json
```

---

# 1. 新增 `sqlAdvanced.ts`

路径：

```txt id="qktbsu"
src/vs/workbench/contrib/sqlAdvanced/common/sqlAdvanced.ts
```

```ts id="r881ko"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Advanced capability constants.
 *--------------------------------------------------------------------------------------------*/

export const SQL_ADVANCED_STORAGE_PREFIX = 'workbench.sqlStudio.advanced';

export const SQL_ADVANCED_WORKSPACE_STORAGE_KEY = `${SQL_ADVANCED_STORAGE_PREFIX}.workspace`;
export const SQL_ADVANCED_SNIPPETS_STORAGE_KEY = `${SQL_ADVANCED_STORAGE_PREFIX}.snippets`;
export const SQL_ADVANCED_PLUGINS_STORAGE_KEY = `${SQL_ADVANCED_STORAGE_PREFIX}.plugins`;

export const SQL_EXPLAIN_PLAN_COMMAND_ID = 'sql.explainPlan';
export const SQL_INSERT_SNIPPET_COMMAND_ID = 'sql.snippet.insert';
export const SQL_CREATE_SNIPPET_COMMAND_ID = 'sql.snippet.create';
export const SQL_OPEN_WORKSPACE_COMMAND_ID = 'sql.workspace.open';
export const SQL_SAVE_WORKSPACE_COMMAND_ID = 'sql.workspace.save';
export const SQL_LIST_PLUGINS_COMMAND_ID = 'sql.plugin.list';

export const SQL_AI_ASSISTANT_COMMAND_ID = 'sql.ai.assistant';
export const SQL_AI_EXPLAIN_ERROR_COMMAND_ID = 'sql.ai.explainError';
export const SQL_AI_GENERATE_QUERY_COMMAND_ID = 'sql.ai.generateQuery';
export const SQL_AI_OPTIMIZE_QUERY_COMMAND_ID = 'sql.ai.optimizeQuery';
```

---

# 2. 新增 SQL Formatter

路径：

```txt id="smh1dq"
src/vs/workbench/contrib/sqlAdvanced/common/sqlAdvancedFormatter.ts
```

```ts id="xyc1iq"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - lightweight SQL formatter.
 * This is not a full SQL AST formatter. It is a deterministic MVP formatter.
 *--------------------------------------------------------------------------------------------*/

import { SqlDialect } from '../../../services/sql/common/sqlDialect.js';

export interface SqlFormatOptions {
	readonly dialect?: SqlDialect;
	readonly keywordCase?: 'upper' | 'lower';
	readonly indent?: string;
}

const DEFAULT_INDENT = '  ';

const LINE_BREAK_BEFORE = new Set([
	'from',
	'where',
	'group by',
	'order by',
	'having',
	'limit',
	'offset',
	'values',
	'returning'
]);

const CLAUSE_KEYWORDS = [
	'group by',
	'order by',
	'left join',
	'right join',
	'inner join',
	'outer join',
	'cross join',
	'full join',
	'union all'
];

const SINGLE_KEYWORDS = [
	'select',
	'from',
	'where',
	'join',
	'on',
	'and',
	'or',
	'insert',
	'into',
	'values',
	'update',
	'set',
	'delete',
	'create',
	'table',
	'view',
	'group',
	'by',
	'order',
	'having',
	'limit',
	'offset',
	'union',
	'all',
	'as',
	'returning',
	'explain'
];

export function formatSql(sql: string, options: SqlFormatOptions = {}): string {
	const trimmed = normalizeSql(sql);

	if (!trimmed) {
		return '';
	}

	const keywordCase = options.keywordCase ?? 'upper';
	const indent = options.indent ?? DEFAULT_INDENT;

	const normalized = protectStringLiterals(trimmed, protectedSql => {
		let result = protectedSql
			.replace(/\s+/g, ' ')
			.replace(/\s*,\s*/g, ', ')
			.replace(/\s*;\s*/g, ';\n')
			.trim();

		for (const keyword of CLAUSE_KEYWORDS) {
			result = replaceKeyword(result, keyword, keywordCase);
		}

		for (const keyword of SINGLE_KEYWORDS) {
			result = replaceKeyword(result, keyword, keywordCase);
		 }

		result = breakClauses(result, keywordCase);
		result = indentLogicalOperators(result, indent, keywordCase);
		result = breakCommaLists(result, indent);

		return result;
	});

	return ensureTrailingSemicolon(normalized);
}

export function minifySql(sql: string): string {
	return normalizeSql(sql)
		.replace(/\s+/g, ' ')
		.replace(/\s*;\s*/g, '; ')
		.trim();
}

export function formatSqlSelectionOrDocument(selection: string | undefined, document: string, options: SqlFormatOptions = {}): string {
	const source = selection?.trim() ? selection : document;
	return formatSql(source, options);
}

function normalizeSql(sql: string): string {
	return typeof sql === 'string' ? sql.trim() : '';
}

function ensureTrailingSemicolon(sql: string): string {
	const trimmed = sql.trim();

	if (!trimmed) {
		return '';
	}

	if (trimmed.endsWith(';')) {
		return trimmed;
	}

	return `${trimmed};`;
}

function replaceKeyword(sql: string, keyword: string, keywordCase: 'upper' | 'lower'): string {
	const escaped = keyword.replace(/\s+/g, '\\s+');
	const pattern = new RegExp(`\\b${escaped}\\b`, 'gi');
	const replacement = keywordCase === 'upper' ? keyword.toUpperCase() : keyword.toLowerCase();

	return sql.replace(pattern, replacement);
}

function breakClauses(sql: string, keywordCase: 'upper' | 'lower'): string {
	let result = sql;

	for (const keyword of LINE_BREAK_BEFORE) {
		const replacement = keywordCase === 'upper' ? keyword.toUpperCase() : keyword.toLowerCase();
		const pattern = new RegExp(`\\s+${keyword.replace(/\s+/g, '\\s+')}\\b`, 'gi');

		result = result.replace(pattern, `\n${replacement}`);
	}

	return result;
}

function indentLogicalOperators(sql: string, indent: string, keywordCase: 'upper' | 'lower'): string {
	const andKeyword = keywordCase === 'upper' ? 'AND' : 'and';
	const orKeyword = keywordCase === 'upper' ? 'OR' : 'or';

	return sql
		.replace(/\s+AND\s+/gi, `\n${indent}${andKeyword} `)
		.replace(/\s+OR\s+/gi, `\n${indent}${orKeyword} `);
}

function breakCommaLists(sql: string, indent: string): string {
	const lines = sql.split('\n');

	return lines
		.map(line => {
			if (!line.trim().toLowerCase().startsWith('select ')) {
				return line;
			}

			const prefix = line.slice(0, line.toLowerCase().indexOf('select') + 'select'.length);
			const rest = line.slice(prefix.length).trim();

			if (!rest.includes(',')) {
				return line;
			}

			return `${prefix}\n${indent}${rest.replace(/,\s*/g, `,\n${indent}`)}`;
		})
		.join('\n');
}

function protectStringLiterals(sql: string, transform: (sql: string) => string): string {
	const literals: string[] = [];
	const placeholderPrefix = '__SQL_STUDIO_LITERAL_';

	const protectedSql = sql.replace(/'([^']|'')*'/g, match => {
		const index = literals.push(match) - 1;
		return `${placeholderPrefix}${index}__`;
	});

	const transformed = transform(protectedSql);

	return transformed.replace(new RegExp(`${placeholderPrefix}(\\d+)__`, 'g'), (_match, rawIndex) => {
		const index = Number(rawIndex);
		return literals[index] ?? '';
	});
}
```

---

# 3. 新增 Explain Plan

路径：

```txt id="ff9m38"
src/vs/workbench/contrib/sqlAdvanced/common/sqlAdvancedExplain.ts
```

```ts id="nvfyld"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - explain plan helpers.
 *--------------------------------------------------------------------------------------------*/

import { SqlDialect } from '../../../services/sql/common/sqlDialect.js';
import { SqlCellKind, SqlQueryResult } from '../../../services/sql/common/sqlTypes.js';

export interface SqlExplainPlanRequest {
	readonly dialect: SqlDialect;
	readonly sql: string;
}

export interface SqlExplainPlanRow {
	readonly ordinal: number;
	readonly detail: string;
	readonly raw: Record<string, unknown>;
}

export interface SqlExplainPlanSummary {
	readonly dialect: SqlDialect;
	readonly sql: string;
	readonly explainSql: string;
	readonly rows: readonly SqlExplainPlanRow[];
}

export function createExplainSql(request: SqlExplainPlanRequest): string {
	const sql = normalizeStatement(request.sql);

	switch (request.dialect) {
		case SqlDialect.Sqlite:
			return `EXPLAIN QUERY PLAN ${sql}`;

		case SqlDialect.MySql:
			return `EXPLAIN ${sql}`;

		case SqlDialect.PostgreSql:
			return `EXPLAIN (FORMAT JSON) ${sql}`;

		default:
			return assertNever(request.dialect);
	}
}

export function parseExplainQueryResult(dialect: SqlDialect, sql: string, result: SqlQueryResult): SqlExplainPlanSummary {
	const rows = result.rows.map((row, index) => {
		const raw: Record<string, unknown> = {};

		for (const column of result.columns) {
			const cell = row[column.ordinal];
			raw[column.name] = cell?.kind === SqlCellKind.Null ? null : cell?.value;
		}

		return {
			ordinal: index,
			detail: getExplainRowDetail(raw),
			raw
		};
	});

	return {
		dialect,
		sql,
		explainSql: createExplainSql({ dialect, sql }),
		rows
	};
}

export function getExplainRowDetail(raw: Record<string, unknown>): string {
	const preferredKeys = ['detail', 'Extra', 'rows', 'select_type', 'table', 'type', 'key', 'possible_keys'];

	const values = preferredKeys
		.map(key => raw[key])
		.filter(value => value !== undefined && value !== null && String(value).trim().length > 0)
		.map(value => String(value));

	if (values.length > 0) {
		return values.join(' · ');
	}

	const fallback = Object.values(raw)
		.filter(value => value !== undefined && value !== null && String(value).trim().length > 0)
		.map(value => String(value));

	return fallback.join(' · ') || 'No explain details';
}

function normalizeStatement(sql: string): string {
	const normalized = sql.trim();

	if (!normalized) {
		throw new Error('sql must not be empty');
	}

	return normalized.endsWith(';') ? normalized.slice(0, -1).trim() : normalized;
}

function assertNever(value: never): never {
	throw new Error(`Unsupported explain dialect: ${String(value)}`);
}
```

---

# 4. 新增 Query Snippets

路径：

```txt id="8awe3p"
src/vs/workbench/contrib/sqlAdvanced/common/sqlAdvancedSnippets.ts
```

```ts id="2gei21"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - query snippets.
 *--------------------------------------------------------------------------------------------*/

import { SqlConnectionKind } from '../../../services/sql/common/sqlTypes.js';

export interface SqlSnippet {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly dialects: readonly SqlConnectionKind[];
	readonly body: string;
	readonly builtin?: boolean;
}

export interface SqlSnippetVariableMap {
	readonly [key: string]: string | undefined;
}

export const BUILTIN_SQL_SNIPPETS: readonly SqlSnippet[] = [
	{
		id: 'builtin.select.all',
		name: 'SELECT all',
		description: 'Select rows from a table.',
		dialects: [SqlConnectionKind.Sqlite, SqlConnectionKind.MySql, SqlConnectionKind.PostgreSql],
		body: `SELECT *
FROM {{table}}
LIMIT {{limit}};`,
		builtin: true
	},
	{
		id: 'builtin.count',
		name: 'COUNT rows',
		description: 'Count rows in a table.',
		dialects: [SqlConnectionKind.Sqlite, SqlConnectionKind.MySql, SqlConnectionKind.PostgreSql],
		body: `SELECT COUNT(*) AS count
FROM {{table}};`,
		builtin: true
	},
	{
		id: 'builtin.insert',
		name: 'INSERT row',
		description: 'Insert a row into a table.',
		dialects: [SqlConnectionKind.Sqlite, SqlConnectionKind.MySql, SqlConnectionKind.PostgreSql],
		body: `INSERT INTO {{table}} ({{columns}})
VALUES ({{values}});`,
		builtin: true
	},
	{
		id: 'builtin.update',
		name: 'UPDATE rows',
		description: 'Update rows in a table.',
		dialects: [SqlConnectionKind.Sqlite, SqlConnectionKind.MySql, SqlConnectionKind.PostgreSql],
		body: `UPDATE {{table}}
SET {{assignments}}
WHERE {{condition}};`,
		builtin: true
	},
	{
		id: 'builtin.explain',
		name: 'EXPLAIN',
		description: 'Explain a SQL statement.',
		dialects: [SqlConnectionKind.Sqlite, SqlConnectionKind.MySql, SqlConnectionKind.PostgreSql],
		body: `{{explainPrefix}} {{sql}};`,
		builtin: true
	}
];

export function listBuiltinSnippets(kind?: SqlConnectionKind): SqlSnippet[] {
	if (!kind) {
		return [...BUILTIN_SQL_SNIPPETS];
	}

	return BUILTIN_SQL_SNIPPETS.filter(snippet => snippet.dialects.includes(kind));
}

export function normalizeSnippet(snippet: SqlSnippet): SqlSnippet {
	const id = normalizeRequiredString(snippet.id, 'id');
	const name = normalizeRequiredString(snippet.name, 'name');
	const body = normalizeRequiredString(snippet.body, 'body');

	return {
		id,
		name,
		description: normalizeOptionalString(snippet.description),
		dialects: normalizeDialects(snippet.dialects),
		body,
		builtin: snippet.builtin === true
	};
}

export function applySnippetVariables(body: string, variables: SqlSnippetVariableMap): string {
	return body.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, name: string) => {
		const value = variables[name];
		return value === undefined ? `{{${name}}}` : value;
	});
}

export function createSnippetFromSelection(args: {
	readonly id: string;
	readonly name: string;
	readonly sql: string;
	readonly dialects?: readonly SqlConnectionKind[];
}): SqlSnippet {
	return normalizeSnippet({
		id: args.id,
		name: args.name,
		body: args.sql,
		dialects: args.dialects ?? [SqlConnectionKind.Sqlite, SqlConnectionKind.MySql, SqlConnectionKind.PostgreSql]
	});
}

export function mergeSnippets(builtin: readonly SqlSnippet[], custom: readonly SqlSnippet[]): SqlSnippet[] {
	const byId = new Map<string, SqlSnippet>();

	for (const snippet of builtin) {
		byId.set(snippet.id, normalizeSnippet(snippet));
	}

	for (const snippet of custom) {
		byId.set(snippet.id, normalizeSnippet({
			...snippet,
			builtin: false
		}));
	}

	return [...byId.values()];
}

function normalizeDialects(dialects: readonly SqlConnectionKind[]): SqlConnectionKind[] {
	const normalized = dialects.filter((dialect, index, list) => list.indexOf(dialect) === index);

	if (normalized.length === 0) {
		throw new Error('snippet dialects must not be empty');
	}

	return normalized;
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
```

---

# 5. 新增 Workspace Project

路径：

```txt id="mrqvvv"
src/vs/workbench/contrib/sqlAdvanced/common/sqlAdvancedWorkspace.ts
```

```ts id="3fibct"
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
```

---

# 6. 新增 Plugin API

路径：

```txt id="614728"
src/vs/workbench/contrib/sqlAdvanced/common/sqlAdvancedPluginApi.ts
```

```ts id="nwrxlr"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - lightweight plugin API.
 * No remote plugin loading in Phase 10.
 *--------------------------------------------------------------------------------------------*/

export interface SqlStudioPluginManifest {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly contributes?: {
		readonly commands?: readonly SqlStudioPluginCommandContribution[];
		readonly sqlActions?: readonly SqlStudioPluginSqlActionContribution[];
	};
}

export interface SqlStudioPluginCommandContribution {
	readonly id: string;
	readonly title: string;
}

export interface SqlStudioPluginSqlActionContribution {
	readonly id: string;
	readonly title: string;
	readonly when?: string;
}

export interface SqlStudioRegisteredPlugin {
	readonly manifest: SqlStudioPluginManifest;
	readonly activated: boolean;
}

export class SqlStudioPluginRegistry {
	private readonly plugins = new Map<string, SqlStudioRegisteredPlugin>();
	private readonly commands = new Map<string, SqlStudioPluginCommandContribution>();
	private readonly sqlActions = new Map<string, SqlStudioPluginSqlActionContribution>();

	registerPlugin(manifest: SqlStudioPluginManifest): SqlStudioRegisteredPlugin {
		const normalized = normalizePluginManifest(manifest);

		if (this.plugins.has(normalized.id)) {
			throw new Error(`Plugin '${normalized.id}' is already registered`);
		}

		const registered: SqlStudioRegisteredPlugin = {
			manifest: normalized,
			activated: false
		};

		this.plugins.set(normalized.id, registered);

		for (const command of normalized.contributes?.commands ?? []) {
			this.registerCommand(command);
		}

		for (const action of normalized.contributes?.sqlActions ?? []) {
			this.registerSqlAction(action);
		}

		return registered;
	}

	activatePlugin(id: string): SqlStudioRegisteredPlugin {
		const plugin = this.plugins.get(id);

		if (!plugin) {
			throw new Error(`Plugin '${id}' is not registered`);
		}

		const activated = {
			...plugin,
			activated: true
		};

		this.plugins.set(id, activated);
		return activated;
	}

	listPlugins(): SqlStudioRegisteredPlugin[] {
		return [...this.plugins.values()];
	}

	listCommands(): SqlStudioPluginCommandContribution[] {
		return [...this.commands.values()];
	}

	listSqlActions(): SqlStudioPluginSqlActionContribution[] {
		return [...this.sqlActions.values()];
	}

	private registerCommand(command: SqlStudioPluginCommandContribution): void {
		const normalized = normalizePluginCommand(command);

		if (this.commands.has(normalized.id)) {
			throw new Error(`Plugin command '${normalized.id}' is already registered`);
		}

		this.commands.set(normalized.id, normalized);
	}

	private registerSqlAction(action: SqlStudioPluginSqlActionContribution): void {
		const normalized = normalizeSqlAction(action);

		if (this.sqlActions.has(normalized.id)) {
			throw new Error(`Plugin SQL action '${normalized.id}' is already registered`);
		}

		this.sqlActions.set(normalized.id, normalized);
	}
}

export function normalizePluginManifest(manifest: SqlStudioPluginManifest): SqlStudioPluginManifest {
	return {
		id: normalizeRequiredString(manifest.id, 'plugin id'),
		name: normalizeRequiredString(manifest.name, 'plugin name'),
		version: normalizeRequiredString(manifest.version, 'plugin version'),
		contributes: {
			commands: (manifest.contributes?.commands ?? []).map(normalizePluginCommand),
			sqlActions: (manifest.contributes?.sqlActions ?? []).map(normalizeSqlAction)
		}
	};
}

function normalizePluginCommand(command: SqlStudioPluginCommandContribution): SqlStudioPluginCommandContribution {
	return {
		id: normalizeRequiredString(command.id, 'command id'),
		title: normalizeRequiredString(command.title, 'command title')
	};
}

function normalizeSqlAction(action: SqlStudioPluginSqlActionContribution): SqlStudioPluginSqlActionContribution {
	return {
		id: normalizeRequiredString(action.id, 'sql action id'),
		title: normalizeRequiredString(action.title, 'sql action title'),
		when: normalizeOptionalString(action.when)
	};
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
```

---

# 7. 新增 AI SQL Assistant

路径：

```txt id="b1l2k2"
src/vs/workbench/contrib/sqlAdvanced/common/sqlAdvancedAi.ts
```

```ts id="lbr1rt"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - AI SQL assistant foundation.
 * Phase 10 uses deterministic provider by default.
 *--------------------------------------------------------------------------------------------*/

import { SqlDialect } from '../../../services/sql/common/sqlDialect.js';

export const enum SqlAiTaskKind {
	Assistant = 'assistant',
	ExplainError = 'explainError',
	GenerateQuery = 'generateQuery',
	OptimizeQuery = 'optimizeQuery'
}

export interface SqlAiSchemaTable {
	readonly schema?: string;
	readonly name: string;
	readonly columns: readonly string[];
}

export interface SqlAiContext {
	readonly dialect: SqlDialect;
	readonly connectionName?: string;
	readonly sql?: string;
	readonly selectedSql?: string;
	readonly errorMessage?: string;
	readonly userPrompt?: string;
	readonly explainPlan?: string;
	readonly schema?: readonly SqlAiSchemaTable[];
}

export interface SqlAiRequest {
	readonly kind: SqlAiTaskKind;
	readonly context: SqlAiContext;
}

export interface SqlAiResponse {
	readonly kind: SqlAiTaskKind;
	readonly title: string;
	readonly content: string;
	readonly sql?: string;
}

export interface ISqlAiProvider {
	complete(request: SqlAiRequest): Promise<SqlAiResponse>;
}

export class DeterministicSqlAiProvider implements ISqlAiProvider {
	async complete(request: SqlAiRequest): Promise<SqlAiResponse> {
		return createDeterministicAiResponse(request);
	}
}

export function createAiPrompt(request: SqlAiRequest): string {
	const context = request.context;
	const schema = formatSchemaContext(context.schema ?? []);

	switch (request.kind) {
		case SqlAiTaskKind.Assistant:
			return `You are SQL Studio SQL assistant.
Dialect: ${context.dialect}
Connection: ${context.connectionName ?? 'unknown'}
Current SQL:
${context.selectedSql ?? context.sql ?? '(empty)'}

Schema:
${schema}

User request:
${context.userPrompt ?? 'Help with this SQL.'}`;

		case SqlAiTaskKind.ExplainError:
			return `Explain this SQL error and propose a fix.
Dialect: ${context.dialect}
SQL:
${context.sql ?? '(empty)'}

Error:
${context.errorMessage ?? '(unknown error)'}

Schema:
${schema}`;

		case SqlAiTaskKind.GenerateQuery:
			return `Generate a SQL query.
Dialect: ${context.dialect}
Request:
${context.userPrompt ?? '(empty request)'}

Schema:
${schema}`;

		case SqlAiTaskKind.OptimizeQuery:
			return `Optimize this SQL query.
Dialect: ${context.dialect}
SQL:
${context.sql ?? '(empty)'}

Explain plan:
${context.explainPlan ?? '(not provided)'}

Schema:
${schema}`;

		default:
			return assertNever(request.kind);
	}
}

export function createDeterministicAiResponse(request: SqlAiRequest): SqlAiResponse {
	const prompt = createAiPrompt(request);

	switch (request.kind) {
		case SqlAiTaskKind.Assistant:
			return {
				kind: request.kind,
				title: 'SQL Assistant',
				content: `Prepared assistant prompt:\n\n${prompt}`
			};

		case SqlAiTaskKind.ExplainError:
			return {
				kind: request.kind,
				title: 'AI Explain Error',
				content: `The SQL error should be reviewed with dialect-specific syntax and schema context.\n\n${prompt}`
			};

		case SqlAiTaskKind.GenerateQuery:
			return {
				kind: request.kind,
				title: 'AI Generate Query',
				content: `Generated deterministic SQL draft.`,
				sql: createDeterministicGeneratedSql(request.context)
			};

		case SqlAiTaskKind.OptimizeQuery:
			return {
				kind: request.kind,
				title: 'AI Optimize Query',
				content: `Optimization prompt prepared. Review filters, indexes, join order, and selected columns.\n\n${prompt}`,
				sql: request.context.sql
			};

		default:
			return assertNever(request.kind);
	}
}

export function createExplainErrorRequest(context: SqlAiContext): SqlAiRequest {
	return {
		kind: SqlAiTaskKind.ExplainError,
		context
	};
}

export function createGenerateQueryRequest(context: SqlAiContext): SqlAiRequest {
	return {
		kind: SqlAiTaskKind.GenerateQuery,
		context
	};
}

export function createOptimizeQueryRequest(context: SqlAiContext): SqlAiRequest {
	return {
		kind: SqlAiTaskKind.OptimizeQuery,
		context
	};
}

function createDeterministicGeneratedSql(context: SqlAiContext): string {
	const firstTable = context.schema?.[0];

	if (!firstTable) {
		return 'SELECT 1 AS value;';
	}

	const tableName = firstTable.schema ? `${firstTable.schema}.${firstTable.name}` : firstTable.name;
	const columns = firstTable.columns.length > 0 ? firstTable.columns.join(', ') : '*';

	return `SELECT ${columns}
FROM ${tableName}
LIMIT 100;`;
}

function formatSchemaContext(schema: readonly SqlAiSchemaTable[]): string {
	if (schema.length === 0) {
		return '(schema not provided)';
	}

	return schema
		.map(table => {
			const name = table.schema ? `${table.schema}.${table.name}` : table.name;
			return `- ${name}(${table.columns.join(', ') || '*'})`;
		})
		.join('\n');
}

function assertNever(value: never): never {
	throw new Error(`Unsupported AI task kind: ${String(value)}`);
}
```

---

# 8. 新增 Advanced Service

路径：

```txt id="kn8w3g"
src/vs/workbench/contrib/sqlAdvanced/common/sqlAdvancedService.ts
```

```ts id="5qhw0y"
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
```

---

# 9. 新增 Advanced Actions

路径：

```txt id="p547my"
src/vs/workbench/contrib/sqlAdvanced/browser/sqlAdvancedActions.ts
```

```ts id="7ys4mq"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - advanced command actions.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { SqlDialect } from '../../../services/sql/common/sqlDialect.js';
import {
	SQL_AI_ASSISTANT_COMMAND_ID,
	SQL_AI_EXPLAIN_ERROR_COMMAND_ID,
	SQL_AI_GENERATE_QUERY_COMMAND_ID,
	SQL_AI_OPTIMIZE_QUERY_COMMAND_ID,
	SQL_EXPLAIN_PLAN_COMMAND_ID,
	SQL_INSERT_SNIPPET_COMMAND_ID,
	SQL_LIST_PLUGINS_COMMAND_ID,
	SQL_OPEN_WORKSPACE_COMMAND_ID
} from '../common/sqlAdvanced.js';
import { ISqlAdvancedService } from '../common/sqlAdvancedService.js';
import {
	SqlAiTaskKind
} from '../common/sqlAdvancedAi.js';
import { SqlEditorPane } from '../../sqlEditor/browser/sqlEditorPane.js';
import { SQL_NEW_QUERY_COMMAND_ID } from '../../sqlEditor/common/sqlEditor.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

class ExplainPlanAction extends Action2 {
	constructor() {
		super({
			id: SQL_EXPLAIN_PLAN_COMMAND_ID,
			title: localize2('sqlExplainPlan', 'SQL: Explain Plan'),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);
		const pane = editorService.activeEditorPane;

		if (pane instanceof SqlEditorPane) {
			await pane.explainPlan();
			return;
		}

		notificationService.info('Open a SQL Query editor before explaining SQL.');
	}
}

class InsertSnippetAction extends Action2 {
	constructor() {
		super({
			id: SQL_INSERT_SNIPPET_COMMAND_ID,
			title: localize2('sqlInsertSnippet', 'SQL: Insert SELECT Snippet'),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const advancedService = accessor.get(ISqlAdvancedService);
		const commandService = accessor.get(ICommandService);
		const snippet = advancedService.listSnippets().find(item => item.id === 'builtin.select.all');

		await commandService.executeCommand(SQL_NEW_QUERY_COMMAND_ID, {
			initialSql: snippet?.body ?? 'SELECT 1 AS value;'
		});
	}
}

class OpenWorkspaceAction extends Action2 {
	constructor() {
		super({
			id: SQL_OPEN_WORKSPACE_COMMAND_ID,
			title: localize2('sqlOpenWorkspace', 'SQL: Show Workspace Project'),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const advancedService = accessor.get(ISqlAdvancedService);
		const notificationService = accessor.get(INotificationService);
		const workspace = advancedService.getWorkspace();

		notificationService.info(`Workspace: ${workspace.name}`);
	}
}

class ListPluginsAction extends Action2 {
	constructor() {
		super({
			id: SQL_LIST_PLUGINS_COMMAND_ID,
			title: localize2('sqlListPlugins', 'SQL: List Plugins'),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const advancedService = accessor.get(ISqlAdvancedService);
		const notificationService = accessor.get(INotificationService);
		const plugins = advancedService.listPlugins();

		notificationService.info(`Registered SQL plugins: ${plugins.length}`);
	}
}

class AiAssistantAction extends Action2 {
	constructor() {
		super({
			id: SQL_AI_ASSISTANT_COMMAND_ID,
			title: localize2('sqlAiAssistant', 'SQL AI: Assistant'),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openAiResult(accessor, SqlAiTaskKind.Assistant);
	}
}

class AiExplainErrorAction extends Action2 {
	constructor() {
		super({
			id: SQL_AI_EXPLAIN_ERROR_COMMAND_ID,
			title: localize2('sqlAiExplainError', 'SQL AI: Explain Error'),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openAiResult(accessor, SqlAiTaskKind.ExplainError);
	}
}

class AiGenerateQueryAction extends Action2 {
	constructor() {
		super({
			id: SQL_AI_GENERATE_QUERY_COMMAND_ID,
			title: localize2('sqlAiGenerateQuery', 'SQL AI: Generate Query'),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openAiResult(accessor, SqlAiTaskKind.GenerateQuery);
	}
}

class AiOptimizeQueryAction extends Action2 {
	constructor() {
		super({
			id: SQL_AI_OPTIMIZE_QUERY_COMMAND_ID,
			title: localize2('sqlAiOptimizeQuery', 'SQL AI: Optimize Query'),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openAiResult(accessor, SqlAiTaskKind.OptimizeQuery);
	}
}

async function openAiResult(accessor: ServicesAccessor, kind: SqlAiTaskKind): Promise<void> {
	const advancedService = accessor.get(ISqlAdvancedService);
	const commandService = accessor.get(ICommandService);

	const response = await advancedService.completeAi({
		kind,
		context: {
			dialect: SqlDialect.Sqlite,
			userPrompt: 'Help me write a SQL query.',
			schema: [
				{
					name: 'users',
					columns: ['id', 'name', 'created_at']
				}
			]
		}
	});

	await commandService.executeCommand(SQL_NEW_QUERY_COMMAND_ID, {
		initialSql: response.sql ?? `-- ${response.title}\n${response.content}`
	});
}

registerAction2(ExplainPlanAction);
registerAction2(InsertSnippetAction);
registerAction2(OpenWorkspaceAction);
registerAction2(ListPluginsAction);
registerAction2(AiAssistantAction);
registerAction2(AiExplainErrorAction);
registerAction2(AiGenerateQueryAction);
registerAction2(AiOptimizeQueryAction);
```

---

# 10. 新增 Advanced Contribution

路径：

```txt id="wpp9vp"
src/vs/workbench/contrib/sqlAdvanced/browser/sqlAdvanced.contribution.ts
```

```ts id="n6luxs"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - advanced capabilities contribution.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import {
	ISqlAdvancedService,
	SqlAdvancedService
} from '../common/sqlAdvancedService.js';
import './sqlAdvancedActions.js';

registerSingleton(ISqlAdvancedService, SqlAdvancedService, InstantiationType.Delayed);
```

---

# 11. 修改 `SqlEditorPane`

路径：

```txt id="e36hgh"
src/vs/workbench/contrib/sqlEditor/browser/sqlEditorPane.ts
```

## 11.1 修改 imports

删除：

```ts id="h2w34o"
createFormatterPlaceholderResult,
```

当前它来自 `sqlEditorModel.ts`。

新增：

```ts id="wilpeb"
import { formatSql } from '../../sqlAdvanced/common/sqlAdvancedFormatter.js';
import { createExplainSql } from '../../sqlAdvanced/common/sqlAdvancedExplain.js';
import { getDialectForConnectionKind } from '../../../services/sql/common/sqlDialect.js';
```

---

## 11.2 替换 `formatQuery()`

当前 formatter 是 placeholder。

替换为：

```ts id="x1ximh"
formatQuery(): void {
	const model = this.editor?.getModel();

	if (!model) {
		return;
	}

	const connection = this.getSelectedConnection();
	const formatted = formatSql(model.getValue(), {
		dialect: connection ? getDialectForConnectionKind(connection.kind) : undefined
	});

	if (formatted !== model.getValue()) {
		model.setValue(formatted);
		this.dirty = true;
		this.saveCurrentDraft();
	}

	this.status('SQL formatted.');
	this.notificationService.info('SQL formatted.');
}
```

---

## 11.3 新增 `explainPlan()`

放在 `formatQuery()` 后面：

```ts id="c9zw13"
async explainPlan(): Promise<void> {
	const input = this.currentInput;
	const connection = this.getSelectedConnection();

	if (!input || !connection) {
		this.notificationService.info('Select a SQL connection before explaining SQL.');
		return;
	}

	const sql = this.getCurrentStatementSql();
	const explainSql = createExplainSql({
		dialect: getDialectForConnectionKind(connection.kind),
		sql
	});

	const startedAt = Date.now();

	try {
		this.status('Running explain plan...');
		this.setRunning(true);

		this.sqlEditorEventService.fireQueryStarted({
			editorId: input.id,
			connectionId: connection.id,
			sql: explainSql,
			startedAt
		});

		const result = await this.sqlQueryService.executeQuery({
			connectionId: connection.id,
			sql: explainSql
		});

		const completedAt = Date.now();

		this.sqlEditorEventService.fireQueryCompleted({
			editorId: input.id,
			connectionId: connection.id,
			sql: explainSql,
			startedAt,
			completedAt,
			result
		});

		this.status(`Explain completed: ${result.rowCount} row(s).`);
		this.notificationService.info(`Explain completed: ${result.rowCount} row(s).`);
	} catch (error) {
		const completedAt = Date.now();
		const normalizedError = error instanceof Error ? error : new Error(String(error));

		this.sqlEditorEventService.fireQueryFailed({
			editorId: input.id,
			connectionId: connection.id,
			sql: explainSql,
			startedAt,
			completedAt,
			error: normalizedError
		});

		this.showError(normalizedError);
	} finally {
		this.setRunning(false);
	}
}
```

---

## 11.4 新增 `getSelectedConnection()`

当前 `getSelectedConnectionId()` 和 `getSelectedConnectionName()` 是 private helper。

在它们前后新增：

```ts id="h4o548"
private getSelectedConnection(): SqlConnection | undefined {
	const connectionId = this.getSelectedConnectionId();
	return this.currentConnections.find(connection => connection.id === connectionId);
}
```

---

# 12. 修改 `sqlEditorActions.ts`

路径：

```txt id="vl66ji"
src/vs/workbench/contrib/sqlEditor/browser/sqlEditorActions.ts
```

不需要重复注册 explain action，因为 Phase 10 的 `sqlAdvancedActions.ts` 已经注册 `sql.explainPlan`。
这里只建议确保 `FormatSqlQueryAction` 保持使用 `pane.formatQuery()`，现有代码已经如此。

---

# 13. 修改 `workbench.common.main.ts`

在 SQL Studio imports 里追加：

```ts id="7kqeya"
import './contrib/sqlAdvanced/browser/sqlAdvanced.contribution.js';
```

最终：

```ts id="xzddys"
// SQL Studio
import './contrib/sqlConnections/browser/sqlConnections.contribution.js';
import './contrib/sqlEditor/browser/sqlEditor.contribution.js';
import './contrib/sqlResult/browser/sqlResult.contribution.js';
import './contrib/sqlProduct/browser/sqlProduct.contribution.js';
import './contrib/sqlAdvanced/browser/sqlAdvanced.contribution.js';
```

---

# 14. 新增单元测试

## 14.1 `sqlAdvancedFormatter.test.ts`

路径：

```txt id="90vs95"
src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedFormatter.test.ts
```

```ts id="x7d54t"
import assert from 'node:assert/strict';
import test from 'node:test';

import { formatSql, formatSqlSelectionOrDocument, minifySql } from '../common/sqlAdvancedFormatter.js';

test('formatSql formats select query', () => {
	assert.equal(
		formatSql('select id, name from users where id = 1 and name = \'select from\' limit 10'),
		`SELECT
  id,
  name
FROM users
WHERE id = 1
  AND name = 'select from'
LIMIT 10;`
	);
});

test('formatSql keeps empty SQL empty', () => {
	assert.equal(formatSql('   '), '');
});

test('formatSql adds trailing semicolon', () => {
	assert.equal(formatSql('select 1'), 'SELECT 1;');
});

test('minifySql compacts whitespace', () => {
	assert.equal(minifySql('SELECT  *\nFROM users ;'), 'SELECT * FROM users;');
});

test('formatSqlSelectionOrDocument formats selection first', () => {
	assert.equal(formatSqlSelectionOrDocument('select 1', 'select 2'), 'SELECT 1;');
});
```

---

## 14.2 `sqlAdvancedExplain.test.ts`

路径：

```txt id="9h0dtf"
src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedExplain.test.ts
```

```ts id="tdm0g2"
import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlDialect } from '../../../services/sql/common/sqlDialect.js';
import { SqlCellKind, SqlQueryResult } from '../../../services/sql/common/sqlTypes.js';
import { createExplainSql, parseExplainQueryResult } from '../common/sqlAdvancedExplain.js';

test('createExplainSql creates SQLite explain SQL', () => {
	assert.equal(
		createExplainSql({
			dialect: SqlDialect.Sqlite,
			sql: 'SELECT * FROM users;'
		}),
		'EXPLAIN QUERY PLAN SELECT * FROM users'
	);
});

test('createExplainSql creates MySQL explain SQL', () => {
	assert.equal(
		createExplainSql({
			dialect: SqlDialect.MySql,
			sql: 'SELECT * FROM users;'
		}),
		'EXPLAIN SELECT * FROM users'
	);
});

test('createExplainSql creates PostgreSQL explain SQL', () => {
	assert.equal(
		createExplainSql({
			dialect: SqlDialect.PostgreSql,
			sql: 'SELECT * FROM users;'
		}),
		'EXPLAIN (FORMAT JSON) SELECT * FROM users'
	);
});

test('parseExplainQueryResult maps result rows', () => {
	const result: SqlQueryResult = {
		columns: [
			{
				name: 'detail',
				ordinal: 0
			}
		],
		rows: [
			[
				{
					kind: SqlCellKind.Text,
					value: 'SCAN users'
				}
			]
		],
		rowCount: 1,
		elapsedMs: 1,
		truncated: false
	};

	const parsed = parseExplainQueryResult(SqlDialect.Sqlite, 'SELECT * FROM users', result);

	assert.equal(parsed.rows[0].detail, 'SCAN users');
	assert.equal(parsed.explainSql, 'EXPLAIN QUERY PLAN SELECT * FROM users');
});
```

---

## 14.3 `sqlAdvancedSnippets.test.ts`

路径：

```txt id="okohk3"
src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedSnippets.test.ts
```

```ts id="p3jkv3"
import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlConnectionKind } from '../../../services/sql/common/sqlTypes.js';
import {
	applySnippetVariables,
	createSnippetFromSelection,
	listBuiltinSnippets,
	mergeSnippets
} from '../common/sqlAdvancedSnippets.js';

test('listBuiltinSnippets filters by dialect', () => {
	const snippets = listBuiltinSnippets(SqlConnectionKind.MySql);

	assert.ok(snippets.some(snippet => snippet.id === 'builtin.select.all'));
});

test('applySnippetVariables replaces variables', () => {
	assert.equal(
		applySnippetVariables('SELECT * FROM {{ table }} LIMIT {{limit}};', {
			table: 'users',
			limit: '10'
		}),
		'SELECT * FROM users LIMIT 10;'
	);
});

test('applySnippetVariables keeps unknown variables', () => {
	assert.equal(
		applySnippetVariables('SELECT * FROM {{table}};', {}),
		'SELECT * FROM {{table}};'
	);
});

test('createSnippetFromSelection creates custom snippet', () => {
	const snippet = createSnippetFromSelection({
		id: 'custom.users',
		name: 'Users',
		sql: 'SELECT * FROM users;'
	});

	assert.equal(snippet.id, 'custom.users');
	assert.equal(snippet.builtin, false);
});

test('mergeSnippets overrides custom by id', () => {
	const merged = mergeSnippets(
		[
			{
				id: 'a',
				name: 'A',
				body: 'SELECT 1;',
				dialects: [SqlConnectionKind.Sqlite],
				builtin: true
			}
		],
		[
			{
				id: 'a',
				name: 'Custom A',
				body: 'SELECT 2;',
				dialects: [SqlConnectionKind.Sqlite]
			}
		]
	);

	assert.equal(merged.length, 1);
	assert.equal(merged[0].name, 'Custom A');
	assert.equal(merged[0].builtin, false);
});
```

---

## 14.4 `sqlAdvancedWorkspace.test.ts`

路径：

```txt id="plu3eo"
src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedWorkspace.test.ts
```

```ts id="bd6vav"
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	addWorkspaceConnection,
	addWorkspaceQuery,
	addWorkspaceSnippet,
	createDefaultWorkspaceProject,
	deserializeWorkspaceProject,
	normalizeWorkspaceProject,
	serializeWorkspaceProject
} from '../common/sqlAdvancedWorkspace.js';

test('createDefaultWorkspaceProject creates workspace', () => {
	const workspace = createDefaultWorkspaceProject('App');

	assert.equal(workspace.version, 1);
	assert.equal(workspace.name, 'App');
	assert.equal(workspace.metadataCacheEnabled, true);
});

test('normalizeWorkspaceProject normalizes malformed object', () => {
	const workspace = normalizeWorkspaceProject({
		version: 9,
		name: '  App  ',
		connections: [
			{
				connectionId: ' local ',
				alias: ' Local '
			}
		],
		queries: [],
		snippets: []
	});

	assert.equal(workspace.version, 1);
	assert.equal(workspace.name, 'App');
	assert.equal(workspace.connections[0].connectionId, 'local');
});

test('addWorkspaceConnection replaces same connection', () => {
	let workspace = createDefaultWorkspaceProject('App');

	workspace = addWorkspaceConnection(workspace, {
		connectionId: 'local',
		alias: 'A'
	});

	workspace = addWorkspaceConnection(workspace, {
		connectionId: 'local',
		alias: 'B'
	});

	assert.equal(workspace.connections.length, 1);
	assert.equal(workspace.connections[0].alias, 'B');
});

test('addWorkspaceQuery and addWorkspaceSnippet append project files', () => {
	let workspace = createDefaultWorkspaceProject('App');

	workspace = addWorkspaceQuery(workspace, {
		path: 'queries/users.sql',
		title: 'Users'
	});

	workspace = addWorkspaceSnippet(workspace, {
		path: 'snippets/select.sql',
		title: 'Select'
	});

	assert.equal(workspace.queries[0].path, 'queries/users.sql');
	assert.equal(workspace.snippets[0].path, 'snippets/select.sql');
});

test('serializeWorkspaceProject round trips', () => {
	const workspace = createDefaultWorkspaceProject('App');
	const restored = deserializeWorkspaceProject(serializeWorkspaceProject(workspace));

	assert.equal(restored.name, 'App');
});
```

---

## 14.5 `sqlAdvancedPluginApi.test.ts`

路径：

```txt id="jwp6uh"
src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedPluginApi.test.ts
```

```ts id="kith52"
import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlStudioPluginRegistry } from '../common/sqlAdvancedPluginApi.js';

test('SqlStudioPluginRegistry registers plugin contributions', () => {
	const registry = new SqlStudioPluginRegistry();

	registry.registerPlugin({
		id: 'demo',
		name: 'Demo',
		version: '1.0.0',
		contributes: {
			commands: [
				{
					id: 'demo.hello',
					title: 'Hello'
				}
			],
			sqlActions: [
				{
					id: 'demo.action',
					title: 'Action',
					when: 'editor'
				}
			]
		}
	});

	assert.equal(registry.listPlugins().length, 1);
	assert.equal(registry.listCommands()[0].id, 'demo.hello');
	assert.equal(registry.listSqlActions()[0].id, 'demo.action');
});

test('SqlStudioPluginRegistry rejects duplicate plugin', () => {
	const registry = new SqlStudioPluginRegistry();

	registry.registerPlugin({
		id: 'demo',
		name: 'Demo',
		version: '1.0.0'
	});

	assert.throws(
		() =>
			registry.registerPlugin({
				id: 'demo',
				name: 'Demo',
				version: '1.0.0'
			}),
		/already registered/
	);
});

test('SqlStudioPluginRegistry activates plugin', () => {
	const registry = new SqlStudioPluginRegistry();

	registry.registerPlugin({
		id: 'demo',
		name: 'Demo',
		version: '1.0.0'
	});

	assert.equal(registry.activatePlugin('demo').activated, true);
});
```

---

## 14.6 `sqlAdvancedAi.test.ts`

路径：

```txt id="k7etgx"
src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedAi.test.ts
```

```ts id="c40ocg"
import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlDialect } from '../../../services/sql/common/sqlDialect.js';
import {
	createAiPrompt,
	createDeterministicAiResponse,
	createExplainErrorRequest,
	createGenerateQueryRequest,
	createOptimizeQueryRequest,
	DeterministicSqlAiProvider,
	SqlAiTaskKind
} from '../common/sqlAdvancedAi.js';

test('createAiPrompt creates assistant prompt', () => {
	const prompt = createAiPrompt({
		kind: SqlAiTaskKind.Assistant,
		context: {
			dialect: SqlDialect.Sqlite,
			sql: 'SELECT * FROM users;',
			userPrompt: 'Explain this'
		}
	});

	assert.match(prompt, /SQL Studio SQL assistant/);
	assert.match(prompt, /SELECT \* FROM users/);
});

test('createExplainErrorRequest creates request', () => {
	const request = createExplainErrorRequest({
		dialect: SqlDialect.MySql,
		sql: 'SELECT * FROM users',
		errorMessage: 'Unknown table'
	});

	assert.equal(request.kind, SqlAiTaskKind.ExplainError);
	assert.match(createAiPrompt(request), /Unknown table/);
});

test('createGenerateQueryRequest creates deterministic SQL', () => {
	const response = createDeterministicAiResponse(
		createGenerateQueryRequest({
			dialect: SqlDialect.Sqlite,
			userPrompt: 'list users',
			schema: [
				{
					name: 'users',
					columns: ['id', 'name']
				}
			]
		})
	);

	assert.equal(response.sql, `SELECT id, name
FROM users
LIMIT 100;`);
});

test('createOptimizeQueryRequest keeps source SQL', () => {
	const response = createDeterministicAiResponse(
		createOptimizeQueryRequest({
			dialect: SqlDialect.MySql,
			sql: 'SELECT * FROM users;',
			explainPlan: 'full scan'
		})
	);

	assert.equal(response.sql, 'SELECT * FROM users;');
});

test('DeterministicSqlAiProvider returns response', async () => {
	const provider = new DeterministicSqlAiProvider();

	const response = await provider.complete({
		kind: SqlAiTaskKind.Assistant,
		context: {
			dialect: SqlDialect.Sqlite
		}
	});

	assert.equal(response.kind, SqlAiTaskKind.Assistant);
});
```

---

# 15. 修改 `package.json`

新增：

```json id="mn48t2"
{
  "test:sql-advanced": "node --test --import tsx src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedFormatter.test.ts src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedExplain.test.ts src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedSnippets.test.ts src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedWorkspace.test.ts src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedPluginApi.test.ts src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedAi.test.ts"
}
```

总测试改成：

```json id="fafb3n"
{
  "test": "pnpm run test:branding && pnpm run test:rust && pnpm run test:sql-services && pnpm run test:sql-domain && pnpm run test:sql-connections && pnpm run test:sql-editor && pnpm run test:sql-result && pnpm run test:sql-history && pnpm run test:sql-product && pnpm run test:sql-advanced"
}
```

---

# 16. 验收命令

```bash id="ynq1ug"
pnpm run test:sql-advanced
pnpm run test:sql-editor
pnpm run test
pnpm run lint
pnpm run build

cd src-tauri
cargo test sql
cargo check
```

---

# 17. 手动验收

```txt id="ed3qso"
1. 打开 SQL Query Editor
2. 输入 select id, name from users where id = 1 and name = 'select from' limit 10
3. 点击 Format，SQL 被格式化，不再提示 future phase
4. 执行 SQL: Explain Plan，生成并执行 EXPLAIN SQL
5. 执行 SQL: Insert SELECT Snippet，打开一个包含 SELECT snippet 的新 Query
6. 执行 SQL: Show Workspace Project，提示 workspace name
7. 执行 SQL: List Plugins，提示插件数量
8. 执行 SQL AI: Generate Query，打开 deterministic generated SQL
9. 执行 SQL AI: Assistant / Explain Error / Optimize Query，打开 prompt 结果
```

---

# 18. Phase 10 完成标准

```txt id="59i6rg"
SQL formatter：可用，不再是 placeholder
Explain Plan：可生成并执行 SQLite/MySQL/PostgreSQL explain SQL
Query snippets：有内置 snippet / 变量替换 / 插入入口
Workspace project：有本地 workspace model/service
插件 API：有 manifest / commands / sqlActions registry
AI SQL assistant：有 request/context/provider/response
AI explain error：有错误解释 prompt
AI generate query：有 deterministic SQL 生成
AI optimize query：有 SQL + explain + schema prompt
单元测试：所有高级能力纯模型测试接入 test:sql-advanced
```
