import assert from 'node:assert/strict';
import test from 'node:test';

import { SQL_CAPABILITY_VALUES, SqlCapability, isSqlCapability } from '../../../services/sql/common/sqlCapabilities.js';
import { normalizePluginManifest } from '../common/sqlAdvancedPluginApi.js';

test('canonical SQL capability vocabulary has stable wire strings', () => {
	assert.equal(SqlCapability.WorkspaceReadSql, 'workspace.readSql');
	assert.equal(SqlCapability.DatabaseReadResultShape, 'database.readResultShape');
	assert.equal(SqlCapability.DatabaseReadResultSample, 'database.readResultSample');
	assert.equal(SqlCapability.DatabaseExplain, 'database.explain');
	assert.equal(SqlCapability.HistoryRead, 'history.read');
	assert.equal(SQL_CAPABILITY_VALUES.length, 12);
	assert.equal(new Set(SQL_CAPABILITY_VALUES).size, SQL_CAPABILITY_VALUES.length);
});

test('canonical SQL capability parser rejects model or manifest strings outside the vocabulary', () => {
	assert.equal(isSqlCapability(SqlCapability.AgentTool), true);
	assert.equal(isSqlCapability('database.executeAnything'), false);
	assert.equal(isSqlCapability('database.executeWrite '), false);
	assert.throws(
		() =>
			normalizePluginManifest({
				id: 'plugin.invalid',
				name: 'Invalid Plugin',
				version: '1.0.0',
				capabilities: ['agent.all'] as never
			}),
		/Unsupported SQL capability/
	);
});
