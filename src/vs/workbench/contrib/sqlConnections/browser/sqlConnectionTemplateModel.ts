/*---------------------------------------------------------------------------------------------
 * Nyala Studio - Connection template model (Phase 01).
 *
 * Pure data: a template describes which fields the form should render
 * for a particular driver / mode combination. Templates do not know
 * about DOM or services.
 *--------------------------------------------------------------------------------------------*/

import { SqlRuntimeDriverId } from '../../../services/sql/common/sqlDriverCatalog.js';

export type ConnectionTemplateId =
	| 'sqlite-file'
	| 'sqlite-memory'
	| 'mysql'
	| 'postgres';

export interface SqlConnectionTemplate {
	readonly id: ConnectionTemplateId;
	readonly driver: SqlRuntimeDriverId;
	readonly label: string;
	readonly fields: readonly string[];
	readonly required: readonly string[];
	readonly disabled?: boolean;
}

export const SqlConnectionTemplateModel = {
	for(template: ConnectionTemplateId): SqlConnectionTemplate {
		switch (template) {
			case 'sqlite-file':
				return {
					id: 'sqlite-file',
					driver: SqlRuntimeDriverId.Sqlite,
					label: 'SQLite File',
					fields: Object.freeze(['label', 'filePath', 'readOnly']),
					required: Object.freeze(['label', 'filePath']),
				};
			case 'sqlite-memory':
				return {
					id: 'sqlite-memory',
					driver: SqlRuntimeDriverId.Sqlite,
					label: 'SQLite In-Memory',
					fields: Object.freeze(['label', 'rememberInMemory', 'readOnly']),
					required: Object.freeze(['label']),
				};
			case 'mysql':
				return {
					id: 'mysql',
					driver: SqlRuntimeDriverId.MySql,
					label: 'MySQL',
					fields: Object.freeze(['label', 'host', 'port', 'database', 'username', 'password', 'readOnly']),
					required: Object.freeze(['label', 'host', 'port', 'database', 'username']),
				};
			case 'postgres':
				return {
					id: 'postgres',
					driver: SqlRuntimeDriverId.Postgres,
					label: 'PostgreSQL (planned)',
					fields: Object.freeze(['label']),
					required: Object.freeze(['label']),
					disabled: true,
				};
		}
	},

	default(): SqlConnectionTemplate {
		return SqlConnectionTemplateModel.for('sqlite-file');
	},
};