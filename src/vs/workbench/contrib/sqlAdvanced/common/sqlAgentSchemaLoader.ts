/*---------------------------------------------------------------------------------------------
 * SQL Workspace Agent schema loader.
 *--------------------------------------------------------------------------------------------*/

import { SqlAgentSchemaTable } from '../../../services/sql/common/sqlAgent.js';
import { ISqlMetadataService } from '../../../services/sql/common/sqlMetadata.js';

const MAX_AGENT_SCHEMA_TABLES = 24;
const MAX_AGENT_SCHEMA_COLUMNS = 64;

type SqlAgentMetadataReader = Pick<ISqlMetadataService, 'listTables' | 'listColumns'>;

export async function loadAgentSchema(
	metadataService: SqlAgentMetadataReader,
	connectionId: string
): Promise<SqlAgentSchemaTable[]> {
	const tables = (await metadataService.listTables(connectionId))
		.filter(table => table.name.trim())
		.sort((left, right) => (left.schema ?? '').localeCompare(right.schema ?? '') || left.name.localeCompare(right.name))
		.slice(0, MAX_AGENT_SCHEMA_TABLES);
	return Promise.all(
		tables.map(async table => {
			let columns: string[] = [];
			try {
				columns = (await metadataService.listColumns({ connectionId, tableName: table.name, schema: table.schema }))
					.sort((left, right) => left.ordinal - right.ordinal || left.name.localeCompare(right.name))
					.slice(0, MAX_AGENT_SCHEMA_COLUMNS)
					.map(column => column.name);
			} catch {
				// Keep the real table reference when optional column metadata is unavailable.
			}
			return { schema: table.schema, name: table.name, columns };
		})
	);
}
