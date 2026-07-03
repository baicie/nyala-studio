/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - plugin API tests.
 *
 * Phase 07 extends the registry contract: sqlActions must reference an
 * existing command, capability / activation lists are deduped, and every
 * registered contribution carries its `pluginId` so the Workbench bridge
 * can attribute it back to a manifest.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	SqlStudioPluginCapability,
	SqlStudioPluginRegistry,
	normalizePluginManifest,
	normalizeStringArray
} from '../common/sqlAdvancedPluginApi.js';

test('SqlStudioPluginRegistry registers plugin contributions', () => {
	const registry = new SqlStudioPluginRegistry();

	registry.registerPlugin({
		id: 'demo',
		name: 'Demo',
		version: '1.0.0',
		contributes: {
			commands: [
				{
					id: 'demo.hello',
					title: 'Hello'
				}
			],
			sqlActions: [
				{
					id: 'demo.action',
					title: 'Action',
					command: 'demo.hello',
					when: 'editor'
				}
			]
		}
	});

	assert.equal(registry.listPlugins().length, 1);
	assert.equal(registry.listCommands()[0].id, 'demo.hello');
	assert.equal(registry.listSqlActions()[0].id, 'demo.action');
	assert.equal(registry.listSqlActions()[0].command, 'demo.hello');
});

test('SqlStudioPluginRegistry rejects duplicate plugin', () => {
	const registry = new SqlStudioPluginRegistry();

	registry.registerPlugin({
		id: 'demo',
		name: 'Demo',
		version: '1.0.0'
	});

	assert.throws(
		() =>
			registry.registerPlugin({
				id: 'demo',
				name: 'Demo',
				version: '1.0.0'
			}),
		/already registered/
	);
});

test('SqlStudioPluginRegistry activates plugin', () => {
	const registry = new SqlStudioPluginRegistry();

	registry.registerPlugin({
		id: 'demo',
		name: 'Demo',
		version: '1.0.0'
	});

	assert.equal(registry.activatePlugin('demo').activated, true);
});

test('SqlStudioPluginRegistry rejects duplicate command across plugins', () => {
	const registry = new SqlStudioPluginRegistry();

	registry.registerPlugin({
		id: 'plugin.a',
		name: 'Plugin A',
		version: '1.0.0',
		contributes: {
			commands: [{ id: 'shared.command', title: 'Shared' }]
		}
	});

	assert.throws(
		() =>
			registry.registerPlugin({
				id: 'plugin.b',
				name: 'Plugin B',
				version: '1.0.0',
				contributes: {
					commands: [{ id: 'shared.command', title: 'Conflict' }]
				}
			}),
		/already registered/
	);
});

test('SqlStudioPluginRegistry rejects duplicate sql action', () => {
	const registry = new SqlStudioPluginRegistry();

	registry.registerPlugin({
		id: 'plugin.a',
		name: 'Plugin A',
		version: '1.0.0',
		contributes: {
			commands: [{ id: 'sql.command', title: 'Command' }],
			sqlActions: [{ id: 'sql.action', title: 'Action', command: 'sql.command' }]
		}
	});

	assert.throws(
		() =>
			registry.registerPlugin({
				id: 'plugin.b',
				name: 'Plugin B',
				version: '1.0.0',
				contributes: {
					commands: [{ id: 'sql.command.other', title: 'Other Command' }],
					sqlActions: [{ id: 'sql.action', title: 'Conflict', command: 'sql.command.other' }]
				}
			}),
		/already registered/
	);
});

test('SqlStudioPluginRegistry rejects sql action referencing unknown command', () => {
	const registry = new SqlStudioPluginRegistry();

	assert.throws(
		() =>
			registry.registerPlugin({
				id: 'plugin.a',
				name: 'Plugin A',
				version: '1.0.0',
				contributes: {
					sqlActions: [{ id: 'sql.action', title: 'Action', command: 'sql.unknown' }]
				}
			}),
		/unknown command/
	);
});

test('SqlStudioPluginRegistry attributes commands and actions to pluginId', () => {
	const registry = new SqlStudioPluginRegistry();

	registry.registerPlugin({
		id: 'plugin.a',
		name: 'Plugin A',
		version: '1.0.0',
		contributes: {
			commands: [{ id: 'a.command', title: 'A Command', category: 'A' }],
			sqlActions: [{ id: 'a.action', title: 'A Action', command: 'a.command' }]
		}
	});

	const command = registry.listCommands().find(entry => entry.id === 'a.command');
	const action = registry.listSqlActions().find(entry => entry.id === 'a.action');

	assert.ok(command);
	assert.equal(command.pluginId, 'plugin.a');
	assert.equal(command.category, 'A');
	assert.ok(action);
	assert.equal(action.pluginId, 'plugin.a');
	assert.equal(action.command, 'a.command');
});

test('normalizePluginManifest dedupes capabilities and activation events', () => {
	const manifest = normalizePluginManifest({
		id: 'plugin.a',
		name: 'Plugin A',
		version: '1.0.0',
		activationEvents: ['onSqlEditor', ' onSqlEditor ', 'onCommand:sql.format'],
		capabilities: [
			SqlStudioPluginCapability.DatabaseReadMetadata,
			SqlStudioPluginCapability.DatabaseReadMetadata,
			SqlStudioPluginCapability.AgentTool
		]
	});

	assert.deepEqual(manifest.activationEvents, ['onSqlEditor', 'onCommand:sql.format']);
	assert.deepEqual(manifest.capabilities, [
		SqlStudioPluginCapability.DatabaseReadMetadata,
		SqlStudioPluginCapability.AgentTool
	]);
	assert.equal(manifest.contributes.commands.length, 0);
	assert.equal(manifest.contributes.sqlActions.length, 0);
	assert.equal(manifest.contributes.views.length, 0);
	assert.equal(manifest.contributes.panels.length, 0);
});

test('normalizePluginManifest normalizes views and panels', () => {
	const manifest = normalizePluginManifest({
		id: 'plugin.ui',
		name: 'UI Plugin',
		version: '1.0.0',
		contributes: {
			views: [{ id: 'plugin.view', title: 'Plugin View', when: 'editor' }],
			panels: [{ id: 'plugin.panel', title: ' Plugin Panel ', when: ' panelFocus ' }]
		}
	});

	assert.deepEqual(manifest.contributes.views, [
		{ id: 'plugin.view', title: 'Plugin View', when: 'editor' }
	]);
	assert.deepEqual(manifest.contributes.panels, [
		{ id: 'plugin.panel', title: 'Plugin Panel', when: 'panelFocus' }
	]);
});

test('normalizeStringArray drops blank entries and dedupes', () => {
	assert.deepEqual(normalizeStringArray(['a', ' a ', '', 'b']), ['a', 'b']);
	assert.deepEqual(normalizeStringArray(undefined), []);
});