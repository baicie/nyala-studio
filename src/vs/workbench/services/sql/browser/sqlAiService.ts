/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL AI service implementation.
 *
 * Phase 06 default provider is the deterministic foundation that already
 * lived in `sqlAdvancedAi.ts`. A real LLM provider can be plugged in by
 * implementing `ISqlAiProvider` and passing it to `SqlAiService`. The
 * service never executes SQL: callers receive a `SqlAiResponse` whose
 * `sql` field is always a draft that must be confirmed by the user.
 *
 * `validateSqlAiRequest` is the workbench-side boundary guard. It runs
 * before the provider gets a chance to see the request so that a bad
 * `kind` or missing / malformed `dialect` cannot produce a
 * `Dialect: undefined` prompt or crash the deterministic provider.
 *--------------------------------------------------------------------------------------------*/

import { SqlDialect } from '../common/sqlDialect.js';
import { ISqlAiService } from '../common/sqlAi.js';
import {
	DeterministicSqlAiProvider,
	ISqlAiProvider,
	SqlAiRequest,
	SqlAiResponse,
	SqlAiTaskKind
} from '../../../contrib/sqlAdvanced/common/sqlAdvancedAi.js';

export class SqlAiService implements ISqlAiService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly provider: ISqlAiProvider = new DeterministicSqlAiProvider()) {}

	async complete(request: SqlAiRequest): Promise<SqlAiResponse> {
		validateSqlAiRequest(request);
		return this.provider.complete(request);
	}
}

export function validateSqlAiRequest(request: unknown): asserts request is SqlAiRequest {
	if (!isRecord(request)) {
		throw new Error('AI request is required.');
	}

	if (!isSqlAiTaskKind(request.kind)) {
		throw new Error('AI request kind is required.');
	}

	if (!isRecord(request.context)) {
		throw new Error('AI context is required.');
	}

	if (!isSqlDialect(request.context.dialect)) {
		throw new Error('AI context dialect is required.');
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object';
}

function isSqlAiTaskKind(value: unknown): value is SqlAiTaskKind {
	switch (value) {
		case SqlAiTaskKind.Assistant:
		case SqlAiTaskKind.ExplainError:
		case SqlAiTaskKind.GenerateQuery:
		case SqlAiTaskKind.OptimizeQuery:
			return true;
		default:
			return false;
	}
}

function isSqlDialect(value: unknown): value is SqlDialect {
	switch (value) {
		case SqlDialect.Sqlite:
		case SqlDialect.MySql:
		case SqlDialect.PostgreSql:
			return true;
		default:
			return false;
	}
}
