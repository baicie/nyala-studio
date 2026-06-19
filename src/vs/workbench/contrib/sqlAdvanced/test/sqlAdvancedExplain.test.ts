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
