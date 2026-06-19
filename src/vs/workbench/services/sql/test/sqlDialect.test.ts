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

test('quoteSqlIdentifier trims identifiers', () => {
	assert.equal(quoteSqlIdentifier(SqlDialect.Sqlite, ' users '), '"users"');
});

test('quoteSqlIdentifier rejects empty identifiers', () => {
	assert.throws(() => quoteSqlIdentifier(SqlDialect.Sqlite, '  '), /identifier must not be empty/);
});

test('quoteSqlIdentifier rejects NUL identifiers', () => {
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

test('formatQualifiedName ignores empty schema', () => {
	assert.equal(
		formatQualifiedName(SqlDialect.Sqlite, {
			schema: '   ',
			name: 'users'
		}),
		'"users"'
	);
});

test('createTablePreviewSql creates sqlite preview SQL with default limit', () => {
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

test('createTablePreviewSql creates sqlite preview SQL with custom limit', () => {
	assert.equal(
		createTablePreviewSql({
			dialect: SqlDialect.Sqlite,
			schema: 'analytics',
			tableName: 'events',
			limit: 50
		}),
		`SELECT *
FROM "analytics"."events"
LIMIT 50;
`
	);
});

test('normalizePreviewLimit clamps large limit', () => {
	assert.equal(normalizePreviewLimit(999_999), SQL_MAX_TABLE_PREVIEW_LIMIT);
});

test('normalizePreviewLimit rejects invalid limit', () => {
	assert.throws(() => normalizePreviewLimit(0), /positive integer/);
	assert.throws(() => normalizePreviewLimit(-1), /positive integer/);
	assert.throws(() => normalizePreviewLimit(1.5), /positive integer/);
});
