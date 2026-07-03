import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlAiService, validateSqlAiRequest } from '../browser/sqlAiService.js';
import { SqlAiTaskKind } from '../../../contrib/sqlAdvanced/common/sqlAdvancedAi.js';
import { SqlDialect } from '../common/sqlDialect.js';

test('SqlAiService uses deterministic provider by default', async () => {
	const service = new SqlAiService();
	const response = await service.complete({
		kind: SqlAiTaskKind.GenerateQuery,
		context: {
			dialect: SqlDialect.Sqlite,
			userPrompt: 'show one row',
			schema: [{ schema: 'main', name: 'users', columns: ['id'] }]
		}
	});

	assert.equal(response.kind, SqlAiTaskKind.GenerateQuery);
	assert.ok(response.sql?.includes('FROM main.users'));
});

test('validateSqlAiRequest rejects invalid request', () => {
	assert.throws(() => validateSqlAiRequest(undefined as never), /required/);
	assert.throws(() => validateSqlAiRequest({ kind: SqlAiTaskKind.Assistant } as never), /context/);
});
