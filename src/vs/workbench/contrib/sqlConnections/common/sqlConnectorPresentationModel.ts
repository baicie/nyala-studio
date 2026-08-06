import { SqlConnectionKind } from '../../../services/sql/common/sqlTypes.js';

export type SqlConnectorCodiconName = 'database' | 'server' | 'server-environment';
export type SqlConnectorBrandIcon = 'sqlite' | 'mysql' | 'postgresql';

export const enum SqlConnectorCategory {
	All = 'all',
	Embedded = 'embedded',
	Server = 'server'
}

export const enum SqlConnectorDelivery {
	Bundled = 'bundled',
	Planned = 'planned'
}

export interface SqlConnectorCategoryPresentation {
	readonly id: SqlConnectorCategory;
	readonly label: string;
	readonly description: string;
}

export interface SqlConnectorPresentationQuery {
	readonly category?: SqlConnectorCategory;
	readonly text?: string;
}

export interface SqlConnectorPresentation {
	readonly kind: SqlConnectionKind;
	readonly label: string;
	readonly icon: SqlConnectorCodiconName;
	readonly brandIcon: SqlConnectorBrandIcon;
	readonly category: Exclude<SqlConnectorCategory, SqlConnectorCategory.All>;
	readonly delivery: SqlConnectorDelivery;
	readonly description: string;
	readonly keywords: readonly string[];
}

export const SQL_CONNECTOR_CATEGORIES: readonly SqlConnectorCategoryPresentation[] = [
	{
		id: SqlConnectorCategory.All,
		label: 'All',
		description: 'Every database connector in this build.'
	},
	{
		id: SqlConnectorCategory.Embedded,
		label: 'Embedded',
		description: 'Databases stored and opened on this device.'
	},
	{
		id: SqlConnectorCategory.Server,
		label: 'Server',
		description: 'Databases reached over the network.'
	}
];

export const SQL_CONNECTOR_PRESENTATIONS: readonly SqlConnectorPresentation[] = [
	{
		kind: SqlConnectionKind.Sqlite,
		label: 'SQLite',
		icon: 'database',
		brandIcon: 'sqlite',
		category: SqlConnectorCategory.Embedded,
		delivery: SqlConnectorDelivery.Bundled,
		description: 'Connect to a local SQLite database file.',
		keywords: ['local', 'file', 'memory', 'embedded']
	},
	{
		kind: SqlConnectionKind.MySql,
		label: 'MySQL',
		icon: 'server',
		brandIcon: 'mysql',
		category: SqlConnectorCategory.Server,
		delivery: SqlConnectorDelivery.Bundled,
		description: 'Connect to a MySQL server.',
		keywords: ['maria', 'network', 'server']
	},
	{
		kind: SqlConnectionKind.PostgreSql,
		label: 'PostgreSQL',
		icon: 'server-environment',
		brandIcon: 'postgresql',
		category: SqlConnectorCategory.Server,
		delivery: SqlConnectorDelivery.Planned,
		description: 'Connect to a PostgreSQL server.',
		keywords: ['postgres', 'pg', 'network', 'server']
	}
];

export function filterSqlConnectorPresentations(
	query: SqlConnectorPresentationQuery = {}
): SqlConnectorPresentation[] {
	const category = query.category ?? SqlConnectorCategory.All;
	const terms = query.text
		?.trim()
		.toLocaleLowerCase()
		.split(/\s+/)
		.filter(Boolean);

	return SQL_CONNECTOR_PRESENTATIONS.filter(presentation => {
		if (category !== SqlConnectorCategory.All && presentation.category !== category) {
			return false;
		}

		if (!terms?.length) {
			return true;
		}

		const searchableText = [presentation.label, presentation.description, ...presentation.keywords]
			.join(' ')
			.toLocaleLowerCase();
		return terms.every(term => searchableText.includes(term));
	});
}

export function getSqlConnectorPresentation(kind: SqlConnectionKind): SqlConnectorPresentation {
	const presentation = SQL_CONNECTOR_PRESENTATIONS.find(candidate => candidate.kind === kind);

	if (!presentation) {
		throw new Error(`Unsupported SQL connector: ${kind}`);
	}

	return presentation;
}
