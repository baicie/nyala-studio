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

const DEFAULT_SNIPPET_VARIABLES: SqlSnippetVariableMap = {
	table: 'users',
	limit: '100',
	columns: 'id, name',
	values: ':id, :name',
	assignments: 'name = :name',
	condition: 'id = :id',
	explainPrefix: 'EXPLAIN QUERY PLAN',
	sql: 'SELECT * FROM users'
};

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

export function renderSnippetWithDefaults(
	snippet: SqlSnippet,
	dialect: SqlConnectionKind = SqlConnectionKind.Sqlite
): string {
	return applySnippetVariables(snippet.body, {
		...DEFAULT_SNIPPET_VARIABLES,
		explainPrefix: dialect === SqlConnectionKind.Sqlite ? 'EXPLAIN QUERY PLAN' : 'EXPLAIN'
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
