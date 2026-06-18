/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL query draft helpers for connection tree nodes.
 *--------------------------------------------------------------------------------------------*/

import { SqlConnectionTreeNode, SqlConnectionTreeNodeType } from './sqlConnectionTreeModel.js';

export const SQL_CONNECTION_TABLE_PREVIEW_LIMIT = 100;

export interface SqlEditorDraft {
	connectionId: string;
	connectionName?: string;
	initialSql: string;
}

export interface SqlEditorDraftOptions {
	connectionName?: string;
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
	const schema = normalizeOptionalString(node.schema);
	const limit = normalizeLimit(options.limit);

	return {
		connectionId,
		connectionName: normalizeOptionalString(options.connectionName),
		initialSql: `SELECT *
FROM ${formatSqliteQualifiedName(schema, tableName)}
LIMIT ${limit};
`
	};
}

export function formatSqliteQualifiedName(schema: string | undefined, name: string): string {
	const normalizedName = normalizeRequiredString(name, 'name');
	const normalizedSchema = normalizeOptionalString(schema);

	if (!normalizedSchema || normalizedSchema === 'main') {
		return quoteSqliteIdentifier(normalizedName);
	}

	return `${quoteSqliteIdentifier(normalizedSchema)}.${quoteSqliteIdentifier(normalizedName)}`;
}

export function quoteSqliteIdentifier(value: string): string {
	const normalized = normalizeRequiredString(value, 'identifier');

	if (normalized.includes('\0')) {
		throw new Error('identifier must not contain NUL bytes');
	}

	return `"${normalized.replaceAll('"', '""')}"`;
}

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined) {
		return SQL_CONNECTION_TABLE_PREVIEW_LIMIT;
	}

	if (!Number.isInteger(limit) || limit <= 0) {
		throw new Error('limit must be a positive integer');
	}

	return Math.min(limit, 10_000);
}

function normalizeRequiredString(value: string | undefined, fieldName: string): string {
	const normalized = normalizeOptionalString(value);

	if (!normalized) {
		throw new Error(`${fieldName} must not be empty`);
	}

	return normalized;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}
