/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - lightweight SQL formatter.
 * This is not a full SQL AST formatter. It is a deterministic MVP formatter.
 *--------------------------------------------------------------------------------------------*/

import { SqlDialect } from '../../../services/sql/common/sqlDialect.js';

export interface SqlFormatOptions {
	readonly dialect?: SqlDialect;
	readonly keywordCase?: 'upper' | 'lower';
	readonly indent?: string;
}

const DEFAULT_INDENT = '  ';

const LINE_BREAK_BEFORE = new Set([
	'from',
	'where',
	'group by',
	'order by',
	'having',
	'limit',
	'offset',
	'values',
	'returning'
]);

const CLAUSE_KEYWORDS = [
	'group by',
	'order by',
	'left join',
	'right join',
	'inner join',
	'outer join',
	'cross join',
	'full join',
	'union all'
];

const SINGLE_KEYWORDS = [
	'select',
	'from',
	'where',
	'join',
	'on',
	'and',
	'or',
	'insert',
	'into',
	'values',
	'update',
	'set',
	'delete',
	'create',
	'table',
	'view',
	'group',
	'by',
	'order',
	'having',
	'limit',
	'offset',
	'union',
	'all',
	'as',
	'returning',
	'explain'
];

export function formatSql(sql: string, options: SqlFormatOptions = {}): string {
	const trimmed = normalizeSql(sql);

	if (!trimmed) {
		return '';
	}

	const keywordCase = options.keywordCase ?? 'upper';
	const indent = options.indent ?? DEFAULT_INDENT;

	const normalized = protectStringLiterals(trimmed, protectedSql => {
		let result = protectedSql
			.replace(/\s+/g, ' ')
			.replace(/\s*,\s*/g, ', ')
			.replace(/\s*;\s*/g, ';\n')
			.trim();

		for (const keyword of CLAUSE_KEYWORDS) {
			result = replaceKeyword(result, keyword, keywordCase);
		}

		for (const keyword of SINGLE_KEYWORDS) {
			result = replaceKeyword(result, keyword, keywordCase);
		 }

		result = breakClauses(result, keywordCase);
		result = indentLogicalOperators(result, indent, keywordCase);
		result = breakCommaLists(result, indent);

		return result;
	});

	return ensureTrailingSemicolon(normalized);
}

export function minifySql(sql: string): string {
	return normalizeSql(sql)
		.replace(/\s+/g, ' ')
		.replace(/\s*;\s*/g, '; ')
		.trim();
}

export function formatSqlSelectionOrDocument(selection: string | undefined, document: string, options: SqlFormatOptions = {}): string {
	const source = selection?.trim() ? selection : document;
	return formatSql(source, options);
}

function normalizeSql(sql: string): string {
	return typeof sql === 'string' ? sql.trim() : '';
}

function ensureTrailingSemicolon(sql: string): string {
	const trimmed = sql.trim();

	if (!trimmed) {
		return '';
	}

	if (trimmed.endsWith(';')) {
		return trimmed;
	}

	return `${trimmed};`;
}

function replaceKeyword(sql: string, keyword: string, keywordCase: 'upper' | 'lower'): string {
	const escaped = keyword.replace(/\s+/g, '\\s+');
	const pattern = new RegExp(`\\b${escaped}\\b`, 'gi');
	const replacement = keywordCase === 'upper' ? keyword.toUpperCase() : keyword.toLowerCase();

	return sql.replace(pattern, replacement);
}

function breakClauses(sql: string, keywordCase: 'upper' | 'lower'): string {
	let result = sql;

	for (const keyword of LINE_BREAK_BEFORE) {
		const replacement = keywordCase === 'upper' ? keyword.toUpperCase() : keyword.toLowerCase();
		const pattern = new RegExp(`\\s+${keyword.replace(/\s+/g, '\\s+')}\\b`, 'gi');

		result = result.replace(pattern, `\n${replacement}`);
	}

	return result;
}

function indentLogicalOperators(sql: string, indent: string, keywordCase: 'upper' | 'lower'): string {
	const andKeyword = keywordCase === 'upper' ? 'AND' : 'and';
	const orKeyword = keywordCase === 'upper' ? 'OR' : 'or';

	return sql
		.replace(/\s+AND\s+/gi, `\n${indent}${andKeyword} `)
		.replace(/\s+OR\s+/gi, `\n${indent}${orKeyword} `);
}

function breakCommaLists(sql: string, indent: string): string {
	const lines = sql.split('\n');

	return lines
		.map(line => {
			if (!line.trim().toLowerCase().startsWith('select ')) {
				return line;
			}

			const prefix = line.slice(0, line.toLowerCase().indexOf('select') + 'select'.length);
			const rest = line.slice(prefix.length).trim();

			if (!rest.includes(',')) {
				return line;
			}

			return `${prefix}\n${indent}${rest.replace(/,\s*/g, `,\n${indent}`)}`;
		})
		.join('\n');
}

function protectStringLiterals(sql: string, transform: (sql: string) => string): string {
	const literals: string[] = [];
	const placeholderPrefix = '__SQL_STUDIO_LITERAL_';

	const protectedSql = sql.replace(/'([^']|'')*'/g, match => {
		const index = literals.push(match) - 1;
		return `${placeholderPrefix}${index}__`;
	});

	const transformed = transform(protectedSql);

	return transformed.replace(new RegExp(`${placeholderPrefix}(\\d+)__`, 'g'), (_match, rawIndex) => {
		const index = Number(rawIndex);
		return literals[index] ?? '';
	});
}
