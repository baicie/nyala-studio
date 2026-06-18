import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createTablePreviewSql,
	formatQualifiedName,
	getDialectForConnectionKind,
	normalizePreviewLimit,
	quoteSqlIdentifier,
	SqlDialect,
	SQL_DEFAULT_TABLE_PREVIEW_LIMIT,
	SQL_MAX_TABLE_PREVIEW_LIMIT
} from '../common/sqlDialect.js';
import { SqlConnectionKind } from '../common/sqlTypes.js';

test('getDialectForConnectionKind maps sqlite to sqlite dialect', () => {
	assert.equal(getDialectForConnectionKind(SqlConnectionKind.Sqlite), SqlDialect.Sqlite);
});

test('quoteSqlIdentifier quotes sqlite identifiers with double quotes', () => {
	assert.equal(quoteSqlIdentifier(SqlDialect.Sqlite, 'users'), '"users"');
	assert.equal(quoteSqlIdentifier(SqlDialect.Sqlite, 'weird"name'), '"weird""name"');
});

test('quoteSqlIdentifier quotes postgres identifiers with double quotes', () => {
	assert.equal(quoteSqlIdentifier(SqlDialect.Postgres, 'public'), '"public"');
	assert.equal(quoteSqlIdentifier(SqlDialect.Postgres, 'user"name'), '"user""name"');
});

test('quoteSqlIdentifier quotes mysql identifiers with backticks', () => {
	assert.equal(quoteSqlIdentifier(SqlDialect.MySql, 'users'), '`users`');
	assert.equal(quoteSqlIdentifier(SqlDialect.MySql, 'weird`name'), '`weird``name`');
});

test('quoteSqlIdentifier rejects empty and NUL identifiers', () => {
	assert.throws(() => quoteSqlIdentifier(SqlDialect.Sqlite, '  '), /identifier must not be empty/);
	assert.throws(() => quoteSqlIdentifier(SqlDialect.Sqlite, 'bad\0name'), /NUL/);
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

test('formatQualifiedName includes sqlite attached schema', () => {
	assert.equal(
		formatQualifiedName(SqlDialect.Sqlite, {
			schema: 'analytics',
			name: 'events'
		}),
		'"analytics"."events"'
	);
});

test('formatQualifiedName includes postgres schema', () => {
	assert.equal(
		formatQualifiedName(SqlDialect.Postgres, {
			schema: 'public',
			name: 'users'
		}),
		'"public"."users"'
	);
});

test('formatQualifiedName includes mysql schema', () => {
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
LIMIT ${SQL_DEFAULT_TABLE_PREVIEW_LIMIT};
`
	);
});

test('createTablePreviewSql creates postgres preview SQL', () => {
	assert.equal(
		createTablePreviewSql({
			dialect: SqlDialect.Postgres,
			schema: 'public',
			tableName: 'users',
			limit: 50
		}),
		`SELECT *
FROM "public"."users"
LIMIT 50;
`
	);
});

test('createTablePreviewSql creates mysql preview SQL', () => {
	assert.equal(
		createTablePreviewSql({
			dialect: SqlDialect.MySql,
			schema: 'app',
			tableName: 'users',
			limit: 50
		}),
		`SELECT *
FROM \`app\`.\`users\`
LIMIT 50;
`
	);
});

test('normalizePreviewLimit clamps large limit', () => {
	assert.equal(normalizePreviewLimit(999_999), SQL_MAX_TABLE_PREVIEW_LIMIT);
});

test('normalizePreviewLimit rejects invalid limit', () => {
	assert.throws(() => normalizePreviewLimit(0), /positive integer/);
	assert.throws(() => normalizePreviewLimit(1.5), /positive integer/);
});
