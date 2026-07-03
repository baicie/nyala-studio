/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL AI service implementation.
 *
 * Phase 06 default provider is the deterministic foundation that already
 * lived in `sqlAdvancedAi.ts`. A real LLM provider can be plugged in by
 * implementing `ISqlAiProvider` and passing it to `SqlAiService`. The
 * service never executes SQL: callers receive a `SqlAiResponse` whose
 * `sql` field is always a draft that must be confirmed by the user.
 *--------------------------------------------------------------------------------------------*/

import { ISqlAiService } from '../common/sqlAi.js';
import {
	DeterministicSqlAiProvider,
	ISqlAiProvider,
	SqlAiRequest,
	SqlAiResponse
} from '../../../contrib/sqlAdvanced/common/sqlAdvancedAi.js';

export class SqlAiService implements ISqlAiService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly provider: ISqlAiProvider = new DeterministicSqlAiProvider()) {}

	async complete(request: SqlAiRequest): Promise<SqlAiResponse> {
		validateSqlAiRequest(request);
		return this.provider.complete(request);
	}
}

export function validateSqlAiRequest(request: SqlAiRequest): void {
	if (!request || typeof request !== 'object') {
		throw new Error('AI request is required.');
	}
	if (!request.kind) {
		throw new Error('AI request kind is required.');
	}
	if (!request.context) {
		throw new Error('AI context is required.');
	}
}
