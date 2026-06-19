/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - AI SQL assistant foundation.
 * Phase 10 uses deterministic provider by default.
 *--------------------------------------------------------------------------------------------*/

import { SqlDialect } from '../../../services/sql/common/sqlDialect.js';

export const enum SqlAiTaskKind {
	Assistant = 'assistant',
	ExplainError = 'explainError',
	GenerateQuery = 'generateQuery',
	OptimizeQuery = 'optimizeQuery'
}

export interface SqlAiSchemaTable {
	readonly schema?: string;
	readonly name: string;
	readonly columns: readonly string[];
}

export interface SqlAiContext {
	readonly dialect: SqlDialect;
	readonly connectionName?: string;
	readonly sql?: string;
	readonly selectedSql?: string;
	readonly errorMessage?: string;
	readonly userPrompt?: string;
	readonly explainPlan?: string;
	readonly schema?: readonly SqlAiSchemaTable[];
}

export interface SqlAiRequest {
	readonly kind: SqlAiTaskKind;
	readonly context: SqlAiContext;
}

export interface SqlAiResponse {
	readonly kind: SqlAiTaskKind;
	readonly title: string;
	readonly content: string;
	readonly sql?: string;
}

export interface ISqlAiProvider {
	complete(request: SqlAiRequest): Promise<SqlAiResponse>;
}

export class DeterministicSqlAiProvider implements ISqlAiProvider {
	async complete(request: SqlAiRequest): Promise<SqlAiResponse> {
		return createDeterministicAiResponse(request);
	}
}

export function createAiPrompt(request: SqlAiRequest): string {
	const context = request.context;
	const schema = formatSchemaContext(context.schema ?? []);

	switch (request.kind) {
		case SqlAiTaskKind.Assistant:
			return `You are SQL Studio SQL assistant.
Dialect: ${context.dialect}
Connection: ${context.connectionName ?? 'unknown'}
Current SQL:
${context.selectedSql ?? context.sql ?? '(empty)'}

Schema:
${schema}

User request:
${context.userPrompt ?? 'Help with this SQL.'}`;

		case SqlAiTaskKind.ExplainError:
			return `Explain this SQL error and propose a fix.
Dialect: ${context.dialect}
SQL:
${context.sql ?? '(empty)'}

Error:
${context.errorMessage ?? '(unknown error)'}

Schema:
${schema}`;

		case SqlAiTaskKind.GenerateQuery:
			return `Generate a SQL query.
Dialect: ${context.dialect}
Request:
${context.userPrompt ?? '(empty request)'}

Schema:
${schema}`;

		case SqlAiTaskKind.OptimizeQuery:
			return `Optimize this SQL query.
Dialect: ${context.dialect}
SQL:
${context.sql ?? '(empty)'}

Explain plan:
${context.explainPlan ?? '(not provided)'}

Schema:
${schema}`;

		default:
			return assertNever(request.kind);
	}
}

export function createDeterministicAiResponse(request: SqlAiRequest): SqlAiResponse {
	const prompt = createAiPrompt(request);

	switch (request.kind) {
		case SqlAiTaskKind.Assistant:
			return {
				kind: request.kind,
				title: 'SQL Assistant',
				content: `Prepared assistant prompt:\n\n${prompt}`
			};

		case SqlAiTaskKind.ExplainError:
			return {
				kind: request.kind,
				title: 'AI Explain Error',
				content: `The SQL error should be reviewed with dialect-specific syntax and schema context.\n\n${prompt}`
			};

		case SqlAiTaskKind.GenerateQuery:
			return {
				kind: request.kind,
				title: 'AI Generate Query',
				content: `Generated deterministic SQL draft.`,
				sql: createDeterministicGeneratedSql(request.context)
			};

		case SqlAiTaskKind.OptimizeQuery:
			return {
				kind: request.kind,
				title: 'AI Optimize Query',
				content: `Optimization prompt prepared. Review filters, indexes, join order, and selected columns.\n\n${prompt}`,
				sql: request.context.sql
			};

		default:
			return assertNever(request.kind);
	}
}

export function createExplainErrorRequest(context: SqlAiContext): SqlAiRequest {
	return {
		kind: SqlAiTaskKind.ExplainError,
		context
	};
}

export function createGenerateQueryRequest(context: SqlAiContext): SqlAiRequest {
	return {
		kind: SqlAiTaskKind.GenerateQuery,
		context
	};
}

export function createOptimizeQueryRequest(context: SqlAiContext): SqlAiRequest {
	return {
		kind: SqlAiTaskKind.OptimizeQuery,
		context
	};
}

function createDeterministicGeneratedSql(context: SqlAiContext): string {
	const firstTable = context.schema?.[0];

	if (!firstTable) {
		return 'SELECT 1 AS value;';
	}

	const tableName = firstTable.schema ? `${firstTable.schema}.${firstTable.name}` : firstTable.name;
	const columns = firstTable.columns.length > 0 ? firstTable.columns.join(', ') : '*';

	return `SELECT ${columns}
FROM ${tableName}
LIMIT 100;`;
}

function formatSchemaContext(schema: readonly SqlAiSchemaTable[]): string {
	if (schema.length === 0) {
		return '(schema not provided)';
	}

	return schema
		.map(table => {
			const name = table.schema ? `${table.schema}.${table.name}` : table.name;
			return `- ${name}(${table.columns.join(', ') || '*'})`;
		})
		.join('\n');
}

function assertNever(value: never): never {
	throw new Error(`Unsupported AI task kind: ${String(value)}`);
}
