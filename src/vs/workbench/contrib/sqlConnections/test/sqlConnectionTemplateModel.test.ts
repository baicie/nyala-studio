import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlColumn } from '../../../services/sql/common/sqlTypes.js';
import {
	createCopyQualifiedNameText,
	createCopyTableNameText,
	createCountTemplate,
	createInsertTemplate,
	createSelectTemplate,
	createSqlParameterName,
	createUpdateTemplate,
	normalizeTemplateColumns
} from '../common/sqlConnectionTemplateModel.js';

const columns: SqlColumn[] = [
	{
		name: 'id',
		dataType: 'INTEGER',
		ordinal: 0,
		primaryKey: true,
		notNull: true,
		defaultValue: undefined
	},
	{
		name: 'name',
		dataType: 'TEXT',
		ordinal: 1,
		primaryKey: false,
		notNull: false,
		defaultValue: undefined
	},
	{
		name: 'created_at',
		dataType: 'TEXT',
		ordinal: 2,
		primaryKey: false,
		notNull: false,
		defaultValue: undefined
	}
];

test('createSelectTemplate creates SQLite preview SQL', () => {
	assert.equal(
		createSelectTemplate({
			schema: 'main',
			tableName: 'users'
		}).sql,
		`SELECT *
FROM "users"
LIMIT 100;
`
	);
});

test('createSelectTemplate supports custom limit', () => {
	assert.equal(
		createSelectTemplate(
			{
				schema: 'analytics',
				tableName: 'events'
			},
			50
		).sql,
		`SELECT *
FROM "analytics"."events"
LIMIT 50;
`
	);
});

test('createCountTemplate creates count SQL', () => {
	assert.equal(
		createCountTemplate({
			schema: 'main',
			tableName: 'users'
		}).sql,
		`SELECT COUNT(*) AS "count"
FROM "users";
`
	);
});

test('createInsertTemplate creates insert template with columns', () => {
	assert.equal(
		createInsertTemplate({
			schema: 'main',
			tableName: 'users',
			columns
		}).sql,
		`INSERT INTO "users" ("id", "name", "created_at")
VALUES (:id, :name, :created_at);
`
	);
});

test('createInsertTemplate creates default values template without columns', () => {
	assert.equal(
		createInsertTemplate({
			schema: 'main',
			tableName: 'users',
			columns: []
		}).sql,
		`INSERT INTO "users"
DEFAULT VALUES;
`
	);
});

test('createUpdateTemplate uses primary key in WHERE clause', () => {
	assert.equal(
		createUpdateTemplate({
			schema: 'main',
			tableName: 'users',
			columns
		}).sql,
		`UPDATE "users"
SET "name" = :name,
    "created_at" = :created_at
WHERE "id" = :id;
`
	);
});

test('createUpdateTemplate falls back to first column when no primary key exists', () => {
	const noPrimaryKeyColumns = columns.map(column => ({
		...column,
		primaryKey: false
	}));

	assert.equal(
		createUpdateTemplate({
			schema: 'main',
			tableName: 'users',
			columns: noPrimaryKeyColumns
		}).sql,
		`UPDATE "users"
SET "name" = :name,
    "created_at" = :created_at
WHERE "id" = :id;
`
	);
});

test('createUpdateTemplate creates placeholder when no columns exist', () => {
	assert.equal(
		createUpdateTemplate({
			schema: 'main',
			tableName: 'users',
			columns: []
		}).sql,
		`UPDATE "users"
SET -- column = value
WHERE -- condition;
`
	);
});

test('createCopyTableNameText returns raw table name', () => {
	assert.equal(
		createCopyTableNameText({
			schema: 'main',
			tableName: ' users '
		}),
		'users'
	);
});

test('createCopyQualifiedNameText returns quoted qualified name', () => {
	assert.equal(
		createCopyQualifiedNameText({
			schema: 'analytics',
			tableName: 'events'
		}),
		'"analytics"."events"'
	);
});

test('normalizeTemplateColumns sorts trims and removes duplicates', () => {
	const result = normalizeTemplateColumns([
		{
			name: ' name ',
			dataType: 'TEXT',
			ordinal: 2,
			primaryKey: false,
			notNull: false,
			defaultValue: undefined
		},
		{
			name: 'id',
			dataType: 'INTEGER',
			ordinal: 1,
			primaryKey: true,
			notNull: true,
			defaultValue: undefined
		},
		{
			name: 'id',
			dataType: 'INTEGER',
			ordinal: 3,
			primaryKey: false,
			notNull: false,
			defaultValue: undefined
		}
	]);

	assert.deepEqual(
		result.map(column => column.name),
		['id', 'name']
	);
});

test('createSqlParameterName sanitizes invalid characters', () => {
	assert.equal(createSqlParameterName('created at', 0), ':created_at');
	assert.equal(createSqlParameterName('123 name', 0), ':_123_name');
	assert.equal(createSqlParameterName('---', 1), ':value2');
});

test('template helpers reject empty table name', () => {
	assert.throws(
		() =>
			createCopyQualifiedNameText({
				schema: 'main',
				tableName: '   '
			}),
		/tableName must not be empty/
	);
});
