/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - built-in plugin manifests.
 *
 * Phase 07 introduces the Phase 6 formatter / explain / AI helper commands
 * through the plugin manifest layer so:
 *
 * - The Workbench command registry can iterate over `builtinSqlPlugins`
 *   and register commands uniformly with future plugins.
 * - Capabilities (database.executeRead, agent.tool, ...) are declared in
 *   one place and surfaced through the bridge to any future policy layer.
 *
 * Capabilities are intentionally minimal in MVP:
 *
 * - formatter: no capabilities (pure client-side work).
 * - explain: declares database.executeRead because EXPLAIN runs against
 *   the active connection through ISqlQueryService.
 * - ai: declares database.readMetadata (it needs the schema context) and
 *   agent.tool (it produces AI drafts). It does NOT declare executeWrite
 *   because Generate / Optimize output drafts only.
 *--------------------------------------------------------------------------------------------*/

import {
	SqlStudioPluginCapability,
	SqlStudioPluginManifest
} from './sqlAdvancedPluginApi.js';

export const builtinSqlPlugins: readonly SqlStudioPluginManifest[] = [
	{
		id: 'nyala.sql.formatter',
		name: 'Nyala SQL Formatter',
		version: '0.1.0',
		activationEvents: ['onSqlEditor'],
		capabilities: [],
		contributes: {
			commands: [{ id: 'sql.format', title: 'Format SQL', category: 'SQL' }],
			sqlActions: [{ id: 'sql.action.format', title: 'Format SQL', command: 'sql.format', when: 'sqlEditorFocus' }]
		}
	},
	{
		id: 'nyala.sql.explain',
		name: 'Nyala SQL Explain',
		version: '0.1.0',
		activationEvents: ['onSqlEditor'],
		capabilities: [SqlStudioPluginCapability.DatabaseExecuteRead],
		contributes: {
			commands: [{ id: 'sql.explain', title: 'Explain Query', category: 'SQL' }],
			sqlActions: [{
				id: 'sql.action.explain',
				title: 'Explain Query',
				command: 'sql.explain',
				when: 'sqlEditorHasSelection || sqlEditorHasText'
			}]
		}
	},
	{
		id: 'nyala.sql.ai',
		name: 'Nyala SQL AI Helper',
		version: '0.1.0',
		activationEvents: ['onSqlEditor'],
		capabilities: [
			SqlStudioPluginCapability.DatabaseReadMetadata,
			SqlStudioPluginCapability.AgentTool
		],
		contributes: {
			commands: [
				{ id: 'sql.ai.explainError', title: 'AI: Explain Error', category: 'SQL AI' },
				{ id: 'sql.ai.generateQuery', title: 'AI: Generate Query', category: 'SQL AI' },
				{ id: 'sql.ai.optimizeQuery', title: 'AI: Optimize Query', category: 'SQL AI' }
			],
			sqlActions: [
				{
					id: 'sql.action.ai.explainError',
					title: 'AI: Explain Error',
					command: 'sql.ai.explainError',
					when: 'sqlEditorHasError'
				},
				{
					id: 'sql.action.ai.optimizeQuery',
					title: 'AI: Optimize Query',
					command: 'sql.ai.optimizeQuery',
					when: 'sqlEditorHasSelection || sqlEditorHasText'
				}
			]
		}
	}
];