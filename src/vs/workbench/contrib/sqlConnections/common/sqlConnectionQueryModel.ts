/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL query draft helpers for connection tree nodes.
 *--------------------------------------------------------------------------------------------*/

import { SqlColumn, SqlTableType } from '../../../services/sql/common/sqlTypes.js';
import {
	createTablePreviewSql,
	formatQualifiedName,
	quoteSqlIdentifier,
	SqlDialect,
	SQL_DEFAULT_TABLE_PREVIEW_LIMIT,
	SQL_MAX_TABLE_PREVIEW_LIMIT
} from '../../../services/sql/common/sqlDialect.js';
import { SqlConnectionTreeNode, SqlConnectionTreeNodeType } from './sqlConnectionTreeModel.js';
import {
	createCopyQualifiedNameText,
	createCopyTableNameText,
	createCountTemplate,
	createInsertTemplate,
	createSelectTemplate,
	createUpdateTemplate,
	SqlGeneratedTemplate,
	SqlTableTemplateTarget
} from './sqlConnectionTemplateModel.js';

export const SQL_CONNECTION_TABLE_PREVIEW_LIMIT = SQL_DEFAULT_TABLE_PREVIEW_LIMIT;

export interface SqlEditorDraft {
	readonly connectionId: string;
	readonly connectionName?: string;
	readonly initialSql: string;
}

export interface SqlEditorDraftOptions {
	readonly connectionName?: string;
	readonly dialect?: SqlDialect;
	readonly limit?: number;
	readonly columns?: readonly SqlColumn[];
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
	const normalizedConnectionName = normalizeOptionalString(connectionName);

	return {
		connectionId: normalizedConnectionId,
		connectionName: normalizedConnectionName,
		initialSql: `-- Nyala Query
-- Connection: ${normalizedConnectionName ?? normalizedConnectionId}

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

export function createSelectDraftFromTreeNode(
	node: SqlConnectionTreeNode,
	options: SqlEditorDraftOptions = {}
): SqlEditorDraft {
	const target = createTemplateTarget(node, options);
	const template = createSelectTemplate(target, options.limit);
	return createTemplateDraft(node, template, options);
}

export function createCountDraftFromTreeNode(
	node: SqlConnectionTreeNode,
	options: SqlEditorDraftOptions = {}
): SqlEditorDraft {
	const target = createTemplateTarget(node, options);
	const template = createCountTemplate(target);
	return createTemplateDraft(node, template, options);
}

export function createInsertDraftFromTreeNode(
	node: SqlConnectionTreeNode,
	options: SqlEditorDraftOptions = {}
): SqlEditorDraft {
	const target = createTemplateTarget(node, options);
	const template = createInsertTemplate(target);
	return createTemplateDraft(node, template, options);
}

export function createUpdateDraftFromTreeNode(
	node: SqlConnectionTreeNode,
	options: SqlEditorDraftOptions = {}
): SqlEditorDraft {
	const target = createTemplateTarget(node, options);
	const template = createUpdateTemplate(target);
	return createTemplateDraft(node, template, options);
}

export function createCopyTableNameTextFromTreeNode(node: SqlConnectionTreeNode): string {
	return createCopyTableNameText(createTemplateTarget(node));
}

export function createCopyQualifiedNameTextFromTreeNode(node: SqlConnectionTreeNode): string {
	return createCopyQualifiedNameText(createTemplateTarget(node));
}

export function isSqlTableLikeNode(node: SqlConnectionTreeNode): boolean {
	return node.type === SqlConnectionTreeNodeType.Table || node.type === SqlConnectionTreeNodeType.View;
}

export function isSqlMutableTableNode(node: SqlConnectionTreeNode): boolean {
	return node.type === SqlConnectionTreeNodeType.Table;
}

export function getSqlTableTypeFromNode(node: SqlConnectionTreeNode): SqlTableType {
	return node.tableType ?? (node.type === SqlConnectionTreeNodeType.View ? SqlTableType.View : SqlTableType.Table);
}

/**
 * Backward-compatible export for Phase 4.5 tests/callers.
 * New code should use quoteSqlIdentifier(SqlDialect.Sqlite, value).
 */
export function quoteSqliteIdentifier(value: string): string {
	return quoteSqlIdentifier(SqlDialect.Sqlite, value);
}

/**
 * Backward-compatible export for Phase 4.5 tests/callers.
 * New code should use formatQualifiedName(SqlDialect.Sqlite, ...).
 */
export function formatSqliteQualifiedName(schema: string | undefined, name: string): string {
	return formatQualifiedName(SqlDialect.Sqlite, {
		schema,
		name
	});
}

function createTemplateDraft(
	node: SqlConnectionTreeNode,
	template: SqlGeneratedTemplate,
	options: SqlEditorDraftOptions
): SqlEditorDraft {
	const connectionId = normalizeRequiredString(node.connectionId, 'connectionId');

	return {
		connectionId,
		connectionName: normalizeOptionalString(options.connectionName),
		initialSql: template.sql
	};
}

function createTemplateTarget(
	node: SqlConnectionTreeNode,
	options: SqlEditorDraftOptions = {}
): SqlTableTemplateTarget {
	if (!isSqlTableLikeNode(node)) {
		throw new Error(`Cannot create SQL template from node type: ${node.type}`);
	}

	return {
		schema: normalizeOptionalString(node.schema),
		tableName: normalizeRequiredString(node.tableName ?? node.label, 'tableName'),
		columns: options.columns,
		dialect: options.dialect ?? SqlDialect.Sqlite
	};
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
