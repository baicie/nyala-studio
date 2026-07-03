import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildSchemaContext,
	buildSqlAiContext,
	createSqlAiMarkdown,
	getAiTableKey
} from '../common/sqlAiContextBuilder.js';
import { SqlDialect } from '../../../services/sql/common/sqlDialect.js';
import { SqlTableType } from '../../../services/sql/common/sqlTypes.js';

test('buildSqlAiContext normalizes editor and connection context', () => {
	const context = buildSqlAiContext({
		dialect: SqlDialect.Sqlite,
		connection: { name: ' Local DB ' },
		sql: ' select 1 ',
		selectedSql: ' ',
		userPrompt: ' explain '
	});

	assert.equal(context.connectionName, 'Local DB');
	assert.equal(context.sql, 'select 1');
	assert.equal(context.selectedSql, undefined);
	assert.equal(context.userPrompt, 'explain');
});

test('buildSchemaContext sorts tables and columns', () => {
	const users = { schema: 'main', name: 'users', tableType: SqlTableType.Table };
	const context = buildSchemaContext([users], {
		[getAiTableKey(users)]: [
			{ name: 'name', ordinal: 1, notNull: false, primaryKey: false },
			{ name: 'id', ordinal: 0, notNull: true, primaryKey: true }
		]
	});

	assert.deepEqual(context, [{ schema: 'main', name: 'users', columns: ['id', 'name'] }]);
});

test('createSqlAiMarkdown includes sql draft when present', () => {
	const markdown = createSqlAiMarkdown({ title: 'AI Generate Query', content: 'Draft ready.', sql: 'SELECT 1;' });
	assert.ok(markdown.includes('# AI Generate Query'));
	assert.ok(markdown.includes('```sql'));
	assert.ok(markdown.includes('SELECT 1;'));
});
