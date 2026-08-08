import assert from 'node:assert/strict';
import test from 'node:test';

import {
	filterSqlConnectorPresentations,
	getSqlConnectorPresentation,
	SQL_CONNECTOR_CATEGORIES,
	SQL_CONNECTOR_PRESENTATIONS,
	SqlConnectorCategory,
	SqlConnectorDelivery
} from '../common/sqlConnectorPresentationModel.js';
import { SqlConnectionKind } from '../../../services/sql/common/sqlTypes.js';

test('connector presentations use the product order and picker metadata', () => {
	assert.deepEqual(
		SQL_CONNECTOR_PRESENTATIONS.map(({ kind, label, icon, brandIcon, category, delivery, description }) => ({
			kind,
			label,
			icon,
			brandIcon,
			category,
			delivery,
			description
		})),
		[
			{
				kind: SqlConnectionKind.Sqlite,
				label: 'SQLite',
				icon: 'database',
				brandIcon: 'sqlite',
				category: SqlConnectorCategory.Embedded,
				delivery: SqlConnectorDelivery.Bundled,
				description: 'Connect to a local SQLite database file.'
			},
			{
				kind: SqlConnectionKind.MySql,
				label: 'MySQL',
				icon: 'server',
				brandIcon: 'mysql',
				category: SqlConnectorCategory.Server,
				delivery: SqlConnectorDelivery.Bundled,
				description: 'Connect to a MySQL server.'
			},
			{
				kind: SqlConnectionKind.PostgreSql,
				label: 'PostgreSQL',
				icon: 'server-environment',
				brandIcon: 'postgresql',
				category: SqlConnectorCategory.Server,
				delivery: SqlConnectorDelivery.Planned,
				description: 'Connect to a PostgreSQL server.'
			}
		]
	);
});

test('connector categories provide the left navigation order', () => {
	assert.deepEqual(
		SQL_CONNECTOR_CATEGORIES.map(category => ({ id: category.id, label: category.label })),
		[
			{ id: SqlConnectorCategory.All, label: 'All' },
			{ id: SqlConnectorCategory.Embedded, label: 'Embedded' },
			{ id: SqlConnectorCategory.Server, label: 'Server' }
		]
	);
});

test('connector presentations use distinct product icons', () => {
	assert.deepEqual(
		SQL_CONNECTOR_PRESENTATIONS.map(({ icon }) => icon),
		['database', 'server', 'server-environment']
	);
});

test('filterSqlConnectorPresentations filters by category', () => {
	assert.deepEqual(
		filterSqlConnectorPresentations({ category: SqlConnectorCategory.Embedded }).map(({ kind }) => kind),
		[SqlConnectionKind.Sqlite]
	);
	assert.deepEqual(
		filterSqlConnectorPresentations({ category: SqlConnectorCategory.Server }).map(({ kind }) => kind),
		[SqlConnectionKind.MySql, SqlConnectionKind.PostgreSql]
	);
});

test('filterSqlConnectorPresentations searches labels descriptions and keywords', () => {
	assert.deepEqual(
		filterSqlConnectorPresentations({ text: '  MYSQL  ' }).map(({ kind }) => kind),
		[SqlConnectionKind.MySql]
	);
	assert.deepEqual(
		filterSqlConnectorPresentations({ text: 'local file' }).map(({ kind }) => kind),
		[SqlConnectionKind.Sqlite]
	);
	assert.deepEqual(
		filterSqlConnectorPresentations({ text: 'pg' }).map(({ kind }) => kind),
		[SqlConnectionKind.PostgreSql]
	);
	assert.deepEqual(filterSqlConnectorPresentations({ text: 'oracle' }), []);
});

test('filterSqlConnectorPresentations combines category and search without mutating the catalog', () => {
	const snapshot = [...SQL_CONNECTOR_PRESENTATIONS];

	assert.deepEqual(
		filterSqlConnectorPresentations({ category: SqlConnectorCategory.Server, text: 'sql' }).map(({ kind }) => kind),
		[SqlConnectionKind.MySql, SqlConnectionKind.PostgreSql]
	);
	assert.deepEqual(filterSqlConnectorPresentations({ category: SqlConnectorCategory.Embedded, text: 'mysql' }), []);
	assert.deepEqual(SQL_CONNECTOR_PRESENTATIONS, snapshot);
});

test('connector presentations leave runtime availability to the driver catalog', () => {
	for (const presentation of SQL_CONNECTOR_PRESENTATIONS) {
		assert.equal('planned' in presentation, false);
		assert.equal('disabled' in presentation, false);
	}
});

test('getSqlConnectorPresentation finds a connector by connection kind', () => {
	assert.equal(getSqlConnectorPresentation(SqlConnectionKind.MySql), SQL_CONNECTOR_PRESENTATIONS[1]);
	assert.throws(
		() => getSqlConnectorPresentation('unknown' as SqlConnectionKind),
		/Unsupported SQL connector: unknown/
	);
});
