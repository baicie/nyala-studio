import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlDialect } from '../../../services/sql/common/sqlDialect.js';
import {
	createAiPrompt,
	createDeterministicAiResponse,
	createExplainErrorRequest,
	createGenerateQueryRequest,
	createOptimizeQueryRequest,
	DeterministicSqlAiProvider,
	SqlAiTaskKind
} from '../common/sqlAdvancedAi.js';

test('createAiPrompt creates assistant prompt', () => {
	const prompt = createAiPrompt({
		kind: SqlAiTaskKind.Assistant,
		context: {
			dialect: SqlDialect.Sqlite,
			sql: 'SELECT * FROM users;',
			userPrompt: 'Explain this'
		}
	});

	assert.match(prompt, /Nyala SQL assistant/);
	assert.match(prompt, /SELECT \* FROM users/);
});

test('createExplainErrorRequest creates request', () => {
	const request = createExplainErrorRequest({
		dialect: SqlDialect.MySql,
		sql: 'SELECT * FROM users',
		errorMessage: 'Unknown table'
	});

	assert.equal(request.kind, SqlAiTaskKind.ExplainError);
	assert.match(createAiPrompt(request), /Unknown table/);
});

test('createGenerateQueryRequest creates deterministic SQL', () => {
	const response = createDeterministicAiResponse(
		createGenerateQueryRequest({
			dialect: SqlDialect.Sqlite,
			userPrompt: 'list users',
			schema: [
				{
					name: 'users',
					columns: ['id', 'name']
				}
			]
		})
	);

	assert.equal(response.sql, `SELECT id, name
FROM users
LIMIT 100;`);
});

test('deterministic query without schema preserves the user request as context', () => {
	const response = createDeterministicAiResponse(
		createGenerateQueryRequest({
			dialect: SqlDialect.Sqlite,
			userPrompt: 'list recent orders'
		})
	);

	assert.equal(response.sql, `-- list recent orders
SELECT 1 AS value;`);
});

test('createOptimizeQueryRequest keeps source SQL', () => {
	const response = createDeterministicAiResponse(
		createOptimizeQueryRequest({
			dialect: SqlDialect.MySql,
			sql: 'SELECT * FROM users;',
			explainPlan: 'full scan'
		})
	);

	assert.equal(response.sql, 'SELECT * FROM users;');
});

test('DeterministicSqlAiProvider returns response', async () => {
	const provider = new DeterministicSqlAiProvider();

	const response = await provider.complete({
		kind: SqlAiTaskKind.Assistant,
		context: {
			dialect: SqlDialect.Sqlite
		}
	});

	assert.equal(response.kind, SqlAiTaskKind.Assistant);
});
