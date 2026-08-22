/*---------------------------------------------------------------------------------------------
 * SQL Workspace Agent fix-context guards.
 *--------------------------------------------------------------------------------------------*/

import { SqlAgentArtifactTarget } from '../../../services/sql/common/sqlAgentArtifacts.js';
import { SqlEditorExecutionSource, splitSqlStatements } from '../../sqlEditor/common/sqlEditorModel.js';

export interface SqlAgentFixQueryContext {
	readonly editorId: string;
	readonly editorVersionId?: number;
	readonly connectionId: string;
	readonly sql: string;
	readonly source?: SqlEditorExecutionSource;
}

export function canApplyAgentFixToEditor(
	query: SqlAgentFixQueryContext,
	target: SqlAgentArtifactTarget | undefined,
	activeConnectionId: string | undefined
): boolean {
	if (
		!target ||
		query.source !== SqlEditorExecutionSource.All ||
		query.editorId !== target.editorId ||
		query.editorVersionId !== target.versionId ||
		query.connectionId !== activeConnectionId
	) {
		return false;
	}

	const failedSql = normalizeSingleStatement(query.sql);
	const editorSql = normalizeSingleStatement(target.sql);
	return failedSql !== undefined && failedSql === editorSql;
}

function normalizeSingleStatement(sql: string): string | undefined {
	const statements = splitSqlStatements(sql);
	return statements.length === 1 ? statements[0].sql : undefined;
}
