/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL AI context builder.
 *
 * Phase 06 introduces a single place that turns editor / connection /
 * result state into a `SqlAiContext`. The AI service layer only deals
 * with the resulting context; the deterministic AI provider is context
 * shape only, so this boundary keeps the service free of UI knowledge.
 *
 * All inputs are optional and `undefined`/whitespace values are normalized
 * away so the downstream `createAiPrompt` never sees confusing empty
 * strings. Schema ordering is stable so unit tests / snapshots stay
 * deterministic.
 *--------------------------------------------------------------------------------------------*/

import { SqlDialect } from '../../../services/sql/common/sqlDialect.js';
import { SqlColumn, SqlConnection, SqlTable } from '../../../services/sql/common/sqlTypes.js';
import { SqlAiContext, SqlAiSchemaTable } from './sqlAdvancedAi.js';

export interface SqlAiContextBuilderInput {
	readonly dialect: SqlDialect;
	readonly connection?: Pick<SqlConnection, 'name'>;
	readonly sql?: string;
	readonly selectedSql?: string;
	readonly errorMessage?: string;
	readonly userPrompt?: string;
	readonly explainPlan?: string;
	readonly tables?: readonly SqlTable[];
	readonly columnsByTableKey?: Readonly<Record<string, readonly SqlColumn[]>>;
}

export function buildSqlAiContext(input: SqlAiContextBuilderInput): SqlAiContext {
	return {
		dialect: input.dialect,
		connectionName: normalizeOptional(input.connection?.name),
		sql: normalizeOptional(input.sql),
		selectedSql: normalizeOptional(input.selectedSql),
		errorMessage: normalizeOptional(input.errorMessage),
		userPrompt: normalizeOptional(input.userPrompt),
		explainPlan: normalizeOptional(input.explainPlan),
		schema: buildSchemaContext(input.tables ?? [], input.columnsByTableKey ?? {})
	};
}

export function buildSchemaContext(
	tables: readonly SqlTable[],
	columnsByTableKey: Readonly<Record<string, readonly SqlColumn[]>>
): readonly SqlAiSchemaTable[] {
	return [...tables]
		.sort((left, right) => (left.schema ?? '').localeCompare(right.schema ?? '') || left.name.localeCompare(right.name))
		.map(table => ({
			schema: table.schema,
			name: table.name,
			columns: [...(columnsByTableKey[getAiTableKey(table)] ?? [])]
				.sort((left, right) => left.ordinal - right.ordinal || left.name.localeCompare(right.name))
				.map(column => column.name)
		}));
}

export function getAiTableKey(table: Pick<SqlTable, 'schema' | 'name'>): string {
	return `${table.schema ?? 'main'}.${table.name}`;
}

export function createSqlAiMarkdown(response: { readonly title: string; readonly content: string; readonly sql?: string }): string {
	const parts = [`# ${response.title}`, '', response.content.trim()];
	if (response.sql?.trim()) {
		parts.push('', '```sql', response.sql.trim(), '```');
	}
	return parts.join('\n');
}

function normalizeOptional(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}
