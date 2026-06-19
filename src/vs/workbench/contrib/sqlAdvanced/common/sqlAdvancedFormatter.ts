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

	const normalized = protectSqlSegments(trimmed, protectedSql => {
		const lines = protectedSql.split('\n');
		const resultLines: string[] = [];

		for (const line of lines) {
			let processed = line
				.replace(/  +/g, ' ')
				.replace(/\s*,\s*/g, ', ')
				.trimEnd();

			for (const keyword of CLAUSE_KEYWORDS) {
				processed = replaceKeyword(processed, keyword, keywordCase);
			}

			for (const keyword of SINGLE_KEYWORDS) {
				processed = replaceKeyword(processed, keyword, keywordCase);
			}

			processed = breakClauses(processed, keywordCase);
			processed = indentLogicalOperators(processed, indent, keywordCase);
			processed = breakCommaLists(processed, indent);

			resultLines.push(processed);
		}

		const result = resultLines.join('\n').replace(/;(\s*)$/, ';');

		return result;
	});

	const withSemicolons = addSemicolonsBetweenStatements(normalized);

	return ensureTrailingSemicolon(withSemicolons);
}

export function minifySql(sql: string): string {
	const compacted = normalizeSqlForMinify(sql).replace(/;?\s*;/g, ';').trim();
	return protectSqlSegments(compacted, s => s.replace(/; *$/g, ';').trim());
}

export function formatSqlSelectionOrDocument(
	selection: string | undefined,
	document: string,
	options: SqlFormatOptions = {}
): string {
	const source = selection?.trim() ? selection : document;
	return formatSql(source, options);
}

function normalizeSql(sql: string): string {
	return typeof sql === 'string' ? sql.trim() : '';
}

function normalizeSqlForMinify(sql: string): string {
	return typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim() : '';
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

function addSemicolonsBetweenStatements(sql: string): string {
	const lines = sql.split('\n');

	return lines
		.map((line, index) => {
			const nextLine = lines[index + 1];

			if (nextLine !== undefined && line.trim() && !line.trim().endsWith(';')) {
				const nextSignificant = nextLine.trim();

				if (nextSignificant &&
					!nextSignificant.startsWith('--') &&
					!nextSignificant.startsWith('/*') &&
					!nextSignificant.startsWith('AND ') &&
					!nextSignificant.startsWith('OR ')) {
					return line.trimEnd();
				}
			}

			return line;
		})
		.join('\n');
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

function protectSqlSegments(sql: string, transform: (sql: string) => string): string {
	const segments: string[] = [];
	const placeholderPrefix = '__SQL_STUDIO_SEGMENT_';

	const protectedSql = sql.replace(
		/(--[^\n\r]*|\/\*[\s\S]*?\*\/|'([^']|'')*'|"([^"]|"")*"|`([^`]|``)*`)/g,
		match => {
			const index = segments.push(match) - 1;
			return `${placeholderPrefix}${index}__`;
		}
	);

	const transformed = transform(protectedSql);

	return transformed.replace(new RegExp(`${placeholderPrefix}(\\d+)__`, 'g'), (_match, rawIndex) => {
		const index = Number(rawIndex);
		return segments[index] ?? '';
	});
}
