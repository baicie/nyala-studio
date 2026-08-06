import assert from 'node:assert/strict';
import test from 'node:test';

import { getSqlConnectorPresentation, SQL_CONNECTOR_PRESENTATIONS } from '../common/sqlConnectorPresentationModel.js';
import { SqlConnectionKind } from '../../../services/sql/common/sqlTypes.js';

test('connector presentations use the product order and concise user-facing summaries', () => {
	assert.deepEqual(
		SQL_CONNECTOR_PRESENTATIONS.map(({ kind, label, icon, description }) => ({
			kind,
			label,
			icon,
			description
		})),
		[
			{
				kind: SqlConnectionKind.Sqlite,
				label: 'SQLite',
				icon: 'database',
				description: 'Connect to a local SQLite database file.'
			},
			{
				kind: SqlConnectionKind.MySql,
				label: 'MySQL',
				icon: 'server',
				description: 'Connect to a MySQL server.'
			},
			{
				kind: SqlConnectionKind.PostgreSql,
				label: 'PostgreSQL',
				icon: 'server-environment',
				description: 'Connect to a PostgreSQL server.'
			}
		]
	);
});

test('connector presentations use distinct product icons', () => {
	assert.deepEqual(
		SQL_CONNECTOR_PRESENTATIONS.map(({ icon }) => icon),
		['database', 'server', 'server-environment']
	);
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
