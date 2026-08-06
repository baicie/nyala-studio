import { SqlConnectionKind } from '../../../services/sql/common/sqlTypes.js';

export type SqlConnectorCodiconName = 'database' | 'server' | 'server-environment';

export interface SqlConnectorPresentation {
	readonly kind: SqlConnectionKind;
	readonly label: string;
	readonly icon: SqlConnectorCodiconName;
	readonly description: string;
}

export const SQL_CONNECTOR_PRESENTATIONS: readonly SqlConnectorPresentation[] = [
	{
		kind: SqlConnectionKind.Sqlite,
		label: 'SQLite',
		icon: 'database',
		description: 'Connect to a local SQLite database file.'
	},
	{
		kind: SqlConnectionKind.MySql,
		label: 'MySQL',
		icon: 'server',
		description: 'Connect to a MySQL server.'
	},
	{
		kind: SqlConnectionKind.PostgreSql,
		label: 'PostgreSQL',
		icon: 'server-environment',
		description: 'Connect to a PostgreSQL server.'
	}
];

export function getSqlConnectorPresentation(kind: SqlConnectionKind): SqlConnectorPresentation {
	const presentation = SQL_CONNECTOR_PRESENTATIONS.find(candidate => candidate.kind === kind);

	if (!presentation) {
		throw new Error(`Unsupported SQL connector: ${kind}`);
	}

	return presentation;
}
