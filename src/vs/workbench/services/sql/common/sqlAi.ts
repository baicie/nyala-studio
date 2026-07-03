/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL AI service contract.
 *
 * Phase 06 wires the deterministic AI foundation that already lives in
 * `contrib/sqlAdvanced/common/sqlAdvancedAi.ts` behind a Workbench
 * service so UI surfaces do not import the AI module directly.
 * The service only validates the request shape and delegates to the
 * provider; building a `SqlAiContext` from editor / connection / schema
 * state is the job of `contrib/sqlAdvanced/common/sqlAiContextBuilder.ts`.
 *
 * SECURITY: This service never executes SQL. AI generated drafts must
 * still be confirmed by the user through the editor.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SqlAiRequest, SqlAiResponse } from '../../../contrib/sqlAdvanced/common/sqlAdvancedAi.js';

export const ISqlAiService = createDecorator<ISqlAiService>('sqlAiService');

export interface ISqlAiService {
	readonly _serviceBrand: undefined;
	complete(request: SqlAiRequest): Promise<SqlAiResponse>;
}
