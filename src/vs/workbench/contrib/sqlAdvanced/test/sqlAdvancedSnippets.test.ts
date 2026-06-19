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

test('builtin select snippet can be rendered with defaults', () => {
	const snippet = listBuiltinSnippets().find(item => item.id === 'builtin.select.all');

	assert.ok(snippet);

	assert.equal(
		applySnippetVariables(snippet.body, {
			table: 'users',
			limit: '100'
		}),
		`SELECT *
FROM users
LIMIT 100;`
	);
});
