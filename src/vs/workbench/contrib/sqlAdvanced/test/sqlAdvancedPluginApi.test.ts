import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlStudioPluginRegistry } from '../common/sqlAdvancedPluginApi.js';

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
					when: 'editor'
				}
			]
		}
	});

	assert.equal(registry.listPlugins().length, 1);
	assert.equal(registry.listCommands()[0].id, 'demo.hello');
	assert.equal(registry.listSqlActions()[0].id, 'demo.action');
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
