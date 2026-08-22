/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - plugin contribution bridge tests.
 *
 * Verifies that:
 * - all built-in plugins register cleanly and the bridge surfaces every
 *   formatter / explain / AI command + sql action;
 * - sqlAction contributions carry the declaring plugin's capabilities so
 *   a future policy layer can apply permission gates;
 * - missing command references are caught at registry time, not bridge
 *   time, so the bridge output is well-formed by construction.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { builtinSqlPlugins } from '../common/builtinSqlPlugins.js';
import { SqlStudioPluginCapability, SqlStudioPluginRegistry } from '../common/sqlAdvancedPluginApi.js';
import { buildWorkbenchPluginContributions } from '../common/sqlPluginContributionBridge.js';

function registerBuiltins(): SqlStudioPluginRegistry {
	const registry = new SqlStudioPluginRegistry();
	for (const manifest of builtinSqlPlugins) {
		registry.registerPlugin(manifest);
	}
	return registry;
}

test('buildWorkbenchPluginContributions exposes built-in commands and sql actions', () => {
	const contributions = buildWorkbenchPluginContributions(registerBuiltins());

	assert.ok(contributions.commands.some(command => command.id === 'sql.format'));
	assert.ok(contributions.commands.some(command => command.id === 'sql.explain'));
	assert.ok(contributions.commands.some(command => command.id === 'sql.ai.generateQuery'));
	assert.ok(contributions.commands.some(command => command.id === 'sql.ai.fixError'));
	assert.ok(contributions.sqlActions.some(action => action.id === 'sql.action.explain'));
	assert.ok(contributions.sqlActions.some(action => action.id === 'sql.action.ai.optimizeQuery'));
});

test('sql action bridge carries plugin capabilities', () => {
	const contributions = buildWorkbenchPluginContributions(registerBuiltins());

	const explain = contributions.sqlActions.find(item => item.id === 'sql.action.explain');
	assert.ok(explain);
	assert.deepEqual(explain.capabilities, [SqlStudioPluginCapability.DatabaseExecuteRead]);

	const optimize = contributions.sqlActions.find(item => item.id === 'sql.action.ai.optimizeQuery');
	assert.ok(optimize);
	assert.ok(optimize.capabilities.includes(SqlStudioPluginCapability.DatabaseReadMetadata));
	assert.ok(optimize.capabilities.includes(SqlStudioPluginCapability.AgentTool));
	assert.equal(optimize.command, 'sql.ai.optimizeQuery');
});

test('buildWorkbenchPluginContributions stamps pluginId on every contribution', () => {
	const contributions = buildWorkbenchPluginContributions(registerBuiltins());

	const format = contributions.commands.find(command => command.id === 'sql.format');
	assert.ok(format);
	assert.equal(format.pluginId, 'nyala.sql.formatter');
	assert.equal(format.category, 'SQL');

	const aiExplainError = contributions.sqlActions.find(action => action.id === 'sql.action.ai.explainError');
	assert.ok(aiExplainError);
	assert.equal(aiExplainError.pluginId, 'nyala.sql.ai');
	assert.equal(aiExplainError.command, 'sql.ai.explainError');
	assert.equal(aiExplainError.when, 'sqlEditorHasError');
	const aiFixError = contributions.sqlActions.find(action => action.id === 'sql.action.ai.fixError');
	assert.ok(aiFixError);
	assert.equal(aiFixError.command, 'sql.ai.fixError');
	assert.equal(aiFixError.when, 'sqlEditorHasError');
});

test('buildWorkbenchPluginContributions returns empty capabilities for actions without declarations', () => {
	const registry = new SqlStudioPluginRegistry();
	registry.registerPlugin({
		id: 'plugin.basic',
		name: 'Basic Plugin',
		version: '1.0.0',
		contributes: {
			commands: [{ id: 'basic.command', title: 'Basic Command' }],
			sqlActions: [{ id: 'basic.action', title: 'Basic Action', command: 'basic.command' }]
		}
	});

	const contributions = buildWorkbenchPluginContributions(registry);
	const action = contributions.sqlActions.find(item => item.id === 'basic.action');

	assert.ok(action);
	assert.equal(action.capabilities.length, 0);
});
