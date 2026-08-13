import assert from 'node:assert/strict';
import test from 'node:test';

import { loadAgentSchema } from '../common/sqlAgentSchemaLoader.js';
import { SqlTableType } from '../../../services/sql/common/sqlTypes.js';

test('loadAgentSchema returns tables in stable schema and name order', async () => {
	const schema = await loadAgentSchema(
		{
			async listTables() {
				return [
					{ schema: 'main', name: 'users', tableType: SqlTableType.Table },
					{ schema: 'analytics', name: 'visits', tableType: SqlTableType.View },
					{ schema: 'main', name: 'orders', tableType: SqlTableType.Table },
					{ name: 'local_events', tableType: SqlTableType.Table }
				];
			},
			async listColumns() {
				return [];
			}
		},
		'connection-1'
	);

	assert.deepEqual(
		schema.map(table => `${table.schema ?? ''}.${table.name}`),
		['.local_events', 'analytics.visits', 'main.orders', 'main.users']
	);
});

test('loadAgentSchema orders real columns by ordinal and then name', async () => {
	const schema = await loadAgentSchema(
		{
			async listTables() {
				return [{ schema: 'main', name: 'users', tableType: SqlTableType.Table }];
			},
			async listColumns() {
				return [
					{ name: 'display_name', ordinal: 2, notNull: false, primaryKey: false },
					{ name: 'email', ordinal: 1, notNull: true, primaryKey: false },
					{ name: 'created_at', ordinal: 2, notNull: true, primaryKey: false },
					{ name: 'id', ordinal: 0, notNull: true, primaryKey: true }
				];
			}
		},
		'connection-1'
	);

	assert.deepEqual(schema, [{ schema: 'main', name: 'users', columns: ['id', 'email', 'created_at', 'display_name'] }]);
});

test('loadAgentSchema caps context at 24 tables and 64 columns per table', async () => {
	const tables = Array.from({ length: 30 }, (_, index) => ({
		schema: 'main',
		name: `table_${String(29 - index).padStart(2, '0')}`,
		tableType: SqlTableType.Table
	}));
	const columns = Array.from({ length: 70 }, (_, index) => ({
		name: `column_${String(69 - index).padStart(2, '0')}`,
		ordinal: 69 - index,
		notNull: false,
		primaryKey: false
	}));

	const schema = await loadAgentSchema(
		{
			async listTables() {
				return tables;
			},
			async listColumns() {
				return columns;
			}
		},
		'connection-1'
	);

	assert.equal(schema.length, 24);
	assert.equal(schema[0].name, 'table_00');
	assert.equal(schema[23].name, 'table_23');
	assert.equal(
		schema.every(table => table.columns.length === 64),
		true
	);
	assert.equal(schema[0].columns[0], 'column_00');
	assert.equal(schema[0].columns[63], 'column_63');
});

test('loadAgentSchema retains a table with no columns when its column lookup fails', async () => {
	const schema = await loadAgentSchema(
		{
			async listTables() {
				return [
					{ schema: 'main', name: 'broken', tableType: SqlTableType.Table },
					{ schema: 'main', name: 'healthy', tableType: SqlTableType.Table }
				];
			},
			async listColumns(request) {
				if (request.tableName === 'broken') {
					throw new Error('metadata lookup failed');
				}
				return [{ name: 'id', ordinal: 0, notNull: true, primaryKey: true }];
			}
		},
		'connection-1'
	);

	assert.deepEqual(schema, [
		{ schema: 'main', name: 'broken', columns: [] },
		{ schema: 'main', name: 'healthy', columns: ['id'] }
	]);
});
