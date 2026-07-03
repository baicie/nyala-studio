/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Advanced command results.
 *
 * Phase 05 wires format / snippet / explain / explain-summary commands
 * into a command-ready pure model layer. Every command returns a
 * `SqlAdvancedCommandResult` (which can carry either a draft `sql` or a
 * free-form `content` such as a markdown summary). The command layer
 * never touches the UI; it just hands the result back to the caller
 * (keybinding handler, action menu, etc.) for rendering / execution.
 *
 * This module is intentionally narrower than `sqlAdvancedExplain.ts`,
 * which produces a structured plan rows summary. Here we generate the
 * EXPLAIN SQL that the user actually executes in the editor, plus a
 * plain-text summary of the returned plan rows for the status bar.
 *--------------------------------------------------------------------------------------------*/

import { SqlDialect } from '../../../services/sql/common/sqlDialect.js';

export const enum SqlAdvancedCommandKind {
	Format = 'format',
	InsertSnippet = 'insertSnippet',
	Explain = 'explain',
	ExplainSummary = 'explainSummary'
}

export interface SqlAdvancedCommandResult {
	readonly kind: SqlAdvancedCommandKind;
	readonly title: string;
	readonly sql?: string;
	readonly content?: string;
}

export function createFormatCommandResult(sql: string, formattedSql: string): SqlAdvancedCommandResult {
	return {
		kind: SqlAdvancedCommandKind.Format,
		title: 'Format SQL',
		sql: formattedSql || sql
	};
}

export function createSnippetCommandResult(title: string, sql: string): SqlAdvancedCommandResult {
	return {
		kind: SqlAdvancedCommandKind.InsertSnippet,
		title,
		sql
	};
}

export function createExplainCommandResult(dialect: SqlDialect, sql: string): SqlAdvancedCommandResult {
	return {
		kind: SqlAdvancedCommandKind.Explain,
		title: 'Explain Query',
		sql: createExplainSql(dialect, sql)
	};
}

export function createExplainSummaryCommandResult(planText: string): SqlAdvancedCommandResult {
	return {
		kind: SqlAdvancedCommandKind.ExplainSummary,
		title: 'Explain Summary',
		content: summarizeExplainPlan(planText)
	};
}

export function createExplainSql(dialect: SqlDialect, sql: string): string {
	const normalized = sql.trim().replace(/;+$/, '');

	if (!normalized) {
		throw new Error('SQL is empty.');
	}

	switch (dialect) {
		case SqlDialect.Sqlite:
			return `EXPLAIN QUERY PLAN ${normalized};`;

		case SqlDialect.MySql:
			return `EXPLAIN ${normalized};`;

		case SqlDialect.PostgreSql:
			return `EXPLAIN ${normalized};`;

		default:
			throw new Error(`Unsupported SQL explain dialect: ${String(dialect)}`);
	}
}

const EXPLAIN_PLAN_PREVIEW_ROWS = 50;

export function summarizeExplainPlan(planText: string): string {
	const lines = planText
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean);

	if (lines.length === 0) {
		return 'No explain plan rows were returned.';
	}

	const warnings: string[] = [];

	if (lines.some(line => /scan/i.test(line))) {
		warnings.push('- Contains scan operation. Review filters and indexes.');
	}

	if (lines.some(line => /temporary|filesort/i.test(line))) {
		warnings.push('- Contains temporary/filesort operation. Review order/group strategy.');
	}

	return [
		`Explain plan rows: ${lines.length}`,
		...warnings,
		'',
		'Raw plan:',
		...lines.slice(0, EXPLAIN_PLAN_PREVIEW_ROWS)
	].join('\n');
}