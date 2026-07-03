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

test('validateSqlAiRequest rejects unsupported kind and missing dialect', () => {
	assert.throws(
		() => validateSqlAiRequest({ kind: 'bad', context: { dialect: SqlDialect.Sqlite } }),
		/kind/
	);

	assert.throws(
		() => validateSqlAiRequest({ kind: SqlAiTaskKind.GenerateQuery, context: {} }),
		/dialect/
	);

	assert.throws(
		() => validateSqlAiRequest({
			kind: SqlAiTaskKind.GenerateQuery,
			context: { dialect: 'bad' }
		}),
		/dialect/
	);
});

test('SqlAiService delegates valid requests to custom provider', async () => {
	let called = false;
	const service = new SqlAiService({
		async complete(request) {
			called = true;
			return {
				kind: request.kind,
				title: 'Custom',
				content: 'ok'
			};
		}
	});

	const response = await service.complete({
		kind: SqlAiTaskKind.Assistant,
		context: {
			dialect: SqlDialect.Sqlite,
			userPrompt: 'help'
		}
	});

	assert.equal(called, true);
	assert.equal(response.title, 'Custom');
});
