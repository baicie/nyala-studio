/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL query draft helpers for connection tree nodes.
 *--------------------------------------------------------------------------------------------*/

import {
	createTablePreviewSql,
	SqlDialect,
	SQL_DEFAULT_TABLE_PREVIEW_LIMIT,
	SQL_MAX_TABLE_PREVIEW_LIMIT
} from '../../../services/sql/common/sqlDialect.js';
import { SqlConnectionTreeNode, SqlConnectionTreeNodeType } from './sqlConnectionTreeModel.js';

export const SQL_CONNECTION_TABLE_PREVIEW_LIMIT = SQL_DEFAULT_TABLE_PREVIEW_LIMIT;

export interface SqlEditorDraft {
	connectionId: string;
	connectionName?: string;
	initialSql: string;
}

export interface SqlEditorDraftOptions {
	connectionName?: string;
	dialect?: SqlDialect;
	limit?: number;
}

export function createSqlEditorDraftFromTreeNode(
	node: SqlConnectionTreeNode,
	options: SqlEditorDraftOptions = {}
): SqlEditorDraft {
	if (!node.connectionId) {
		throw new Error('Cannot open SQL query because the tree node has no connection id.');
	}

	switch (node.type) {
		case SqlConnectionTreeNodeType.Connection:
			return createConnectionQueryDraft(node.connectionId, options.connectionName ?? node.label);

		case SqlConnectionTreeNodeType.Table:
		case SqlConnectionTreeNodeType.View:
			return createTablePreviewDraft(node, options);

		default:
			throw new Error(`Cannot open SQL query from node type: ${node.type}`);
	}
}

export function createConnectionQueryDraft(connectionId: string, connectionName?: string): SqlEditorDraft {
	const normalizedConnectionId = normalizeRequiredString(connectionId, 'connectionId');

	return {
		connectionId: normalizedConnectionId,
		connectionName: normalizeOptionalString(connectionName),
		initialSql: `-- SQL Studio Query
-- Connection: ${normalizeOptionalString(connectionName) ?? normalizedConnectionId}

SELECT 1 AS value;
`
	};
}

export function createTablePreviewDraft(
	node: Pick<SqlConnectionTreeNode, 'connectionId' | 'schema' | 'tableName' | 'label' | 'type'>,
	options: SqlEditorDraftOptions = {}
): SqlEditorDraft {
	const connectionId = normalizeRequiredString(node.connectionId, 'connectionId');
	const tableName = normalizeRequiredString(node.tableName ?? node.label, 'tableName');

	return {
		connectionId,
		connectionName: normalizeOptionalString(options.connectionName),
		initialSql: createTablePreviewSql({
			dialect: options.dialect ?? SqlDialect.Sqlite,
			schema: normalizeOptionalString(node.schema),
			tableName,
			limit: options.limit
		})
	};
}

/**
 * Backward-compatible export for Phase 4.5 tests/callers.
 * New code should use quoteSqlIdentifier(SqlDialect.Sqlite, value).
 */
export function quoteSqliteIdentifier(value: string): string {
	return `"${normalizeRequiredString(value, 'identifier').replaceAll('"', '""')}"`;
}

/**
 * Backward-compatible export for Phase 4.5 tests/callers.
 * New code should use formatQualifiedName(SqlDialect.Sqlite, ...).
 */
export function formatSqliteQualifiedName(schema: string | undefined, name: string): string {
	const normalizedName = normalizeRequiredString(name, 'name');
	const normalizedSchema = normalizeOptionalString(schema);

	if (!normalizedSchema || normalizedSchema === 'main') {
		return quoteSqliteIdentifier(normalizedName);
	}

	return `${quoteSqliteIdentifier(normalizedSchema)}.${quoteSqliteIdentifier(normalizedName)}`;
}

function normalizeRequiredString(value: string | undefined, fieldName: string): string {
	const normalized = normalizeOptionalString(value);

	if (!normalized) {
		throw new Error(`${fieldName} must not be empty`);
	}

	if (normalized.includes('\0')) {
		throw new Error(`${fieldName} must not contain NUL bytes`);
	}

	return normalized;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

export { SQL_MAX_TABLE_PREVIEW_LIMIT };
