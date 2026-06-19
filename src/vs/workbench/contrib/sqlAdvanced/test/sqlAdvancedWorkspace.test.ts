import assert from 'node:assert/strict';
import test from 'node:test';

import {
	addWorkspaceConnection,
	addWorkspaceQuery,
	addWorkspaceSnippet,
	createDefaultWorkspaceProject,
	deserializeWorkspaceProject,
	normalizeWorkspaceProject,
	serializeWorkspaceProject
} from '../common/sqlAdvancedWorkspace.js';

test('createDefaultWorkspaceProject creates workspace', () => {
	const workspace = createDefaultWorkspaceProject('App');

	assert.equal(workspace.version, 1);
	assert.equal(workspace.name, 'App');
	assert.equal(workspace.metadataCacheEnabled, true);
});

test('normalizeWorkspaceProject normalizes malformed object', () => {
	const workspace = normalizeWorkspaceProject({
		version: 9,
		name: '  App  ',
		connections: [
			{
				connectionId: ' local ',
				alias: ' Local '
			}
		],
		queries: [],
		snippets: []
	});

	assert.equal(workspace.version, 1);
	assert.equal(workspace.name, 'App');
	assert.equal(workspace.connections[0].connectionId, 'local');
});

test('addWorkspaceConnection replaces same connection', () => {
	let workspace = createDefaultWorkspaceProject('App');

	workspace = addWorkspaceConnection(workspace, {
		connectionId: 'local',
		alias: 'A'
	});

	workspace = addWorkspaceConnection(workspace, {
		connectionId: 'local',
		alias: 'B'
	});

	assert.equal(workspace.connections.length, 1);
	assert.equal(workspace.connections[0].alias, 'B');
});

test('addWorkspaceQuery and addWorkspaceSnippet append project files', () => {
	let workspace = createDefaultWorkspaceProject('App');

	workspace = addWorkspaceQuery(workspace, {
		path: 'queries/users.sql',
		title: 'Users'
	});

	workspace = addWorkspaceSnippet(workspace, {
		path: 'snippets/select.sql',
		title: 'Select'
	});

	assert.equal(workspace.queries[0].path, 'queries/users.sql');
	assert.equal(workspace.snippets[0].path, 'snippets/select.sql');
});

test('serializeWorkspaceProject round trips', () => {
	const workspace = createDefaultWorkspaceProject('App');
	const restored = deserializeWorkspaceProject(serializeWorkspaceProject(workspace));

	assert.equal(restored.name, 'App');
});
