import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createTablePreviewSql,
	formatQualifiedName,
	getDialectForConnectionKind,
	normalizePreviewLimit,
	quoteSqlIdentifier,
	SqlDialect
} from '../common/sqlDialect.js';
import { SqlConnectionKind } from '../common/sqlTypes.js';

test('getDialectForConnectionKind maps all known connection kinds', () => {
	assert.equal(getDialectForConnectionKind(SqlConnectionKind.Sqlite), SqlDialect.Sqlite);
	assert.equal(getDialectForConnectionKind(SqlConnectionKind.PostgreSql), SqlDialect.PostgreSql);
	assert.equal(getDialectForConnectionKind(SqlConnectionKind.MySql), SqlDialect.MySql);
});

test('quoteSqlIdentifier quotes sqlite identifiers', () => {
	assert.equal(quoteSqlIdentifier(SqlDialect.Sqlite, 'users'), '"users"');
	assert.equal(quoteSqlIdentifier(SqlDialect.Sqlite, 'a"b'), '"a""b"');
});

test('quoteSqlIdentifier quotes postgresql identifiers', () => {
	assert.equal(quoteSqlIdentifier(SqlDialect.PostgreSql, 'users'), '"users"');
	assert.equal(quoteSqlIdentifier(SqlDialect.PostgreSql, 'a"b'), '"a""b"');
});

test('quoteSqlIdentifier quotes mysql identifiers', () => {
	assert.equal(quoteSqlIdentifier(SqlDialect.MySql, 'users'), '`users`');
	assert.equal(quoteSqlIdentifier(SqlDialect.MySql, 'a`b'), '`a``b`');
});

test('formatQualifiedName omits sqlite main schema', () => {
	assert.equal(
		formatQualifiedName(SqlDialect.Sqlite, {
			schema: 'main',
			name: 'users'
		}),
		'"users"'
	);
});

test('formatQualifiedName omits postgresql public schema', () => {
	assert.equal(
		formatQualifiedName(SqlDialect.PostgreSql, {
			schema: 'public',
			name: 'users'
		}),
		'"users"'
	);
});

test('formatQualifiedName includes mysql database qualifier', () => {
	assert.equal(
		formatQualifiedName(SqlDialect.MySql, {
			schema: 'app',
			name: 'users'
		}),
		'`app`.`users`'
	);
});

test('createTablePreviewSql creates sqlite preview SQL', () => {
	assert.equal(
		createTablePreviewSql({
			dialect: SqlDialect.Sqlite,
			schema: 'main',
			tableName: 'users'
		}),
		`SELECT *
FROM "users"
LIMIT 100;
`
	);
});

test('createTablePreviewSql creates postgresql preview SQL', () => {
	assert.equal(
		createTablePreviewSql({
			dialect: SqlDialect.PostgreSql,
			schema: 'public',
			tableName: 'users',
			limit: 25
		}),
		`SELECT *
FROM "users"
LIMIT 25;
`
	);
});

test('createTablePreviewSql creates mysql preview SQL', () => {
	assert.equal(
		createTablePreviewSql({
			dialect: SqlDialect.MySql,
			schema: 'app',
			tableName: 'users',
			limit: 25
		}),
		`SELECT *
FROM \`app\`.\`users\`
LIMIT 25;
`
	);
});

test('normalizePreviewLimit clamps limit', () => {
	assert.equal(normalizePreviewLimit(undefined), 100);
	assert.equal(normalizePreviewLimit(100_000), 10_000);
	assert.throws(() => normalizePreviewLimit(0), /positive integer/);
});
