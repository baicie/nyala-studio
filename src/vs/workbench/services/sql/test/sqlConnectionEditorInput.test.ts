/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection editor input tests.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { Codicon } from '../../../../base/common/codicons.js';
import { EditorInputCapabilities } from '../../../common/editor.js';
import {
	SqlConnectionDialogMode,
	createNewSqlConnectionDialogRequest,
	createSavedSqlConnectionDialogRequest
} from '../common/sqlConnectionDialog.js';
import { SqlConnectionEditorInput } from '../common/sqlConnectionEditorInput.js';
import { SqlConnectionKind, SqlSavedConnection } from '../common/sqlTypes.js';

const saved: SqlSavedConnection = {
	id: 'mysql-prod',
	name: 'Production MySQL',
	kind: SqlConnectionKind.MySql,
	host: 'db.example.test',
	port: 3306,
	database: 'app',
	username: 'app_user',
	readOnly: false,
	createIfMissing: false,
	autoConnect: false
};

test('connection editor input is modal, singleton, and non-reopenable', () => {
	const input = new SqlConnectionEditorInput(createNewSqlConnectionDialogRequest(SqlConnectionKind.MySql));

	assert.equal(input.hasCapability(EditorInputCapabilities.RequiresModal), true);
	assert.equal(input.hasCapability(EditorInputCapabilities.Singleton), true);
	assert.equal(input.hasCapability(EditorInputCapabilities.Readonly), true);
	assert.equal(input.getName(), 'New Data Source');
	assert.equal(input.getDescription(), 'MySQL');
	assert.equal(input.getIcon(), Codicon.database);
	assert.equal(input.typeId, 'workbench.input.sqlConnectionEditor');
	assert.equal(input.editorId, 'workbench.editor.sqlConnection');
	assert.equal(input.canReopen(), false);
	assert.equal(input.toUntyped(), undefined);
	assert.equal(Object.isFrozen(input.request), true);
	assert.equal(input.request.mode, SqlConnectionDialogMode.New);
	assert.equal(input.request.initialKind, SqlConnectionKind.MySql);

	input.dispose();
});

test('connection editor input updates its connector description when the picker changes', () => {
	const input = new SqlConnectionEditorInput(createNewSqlConnectionDialogRequest(SqlConnectionKind.Sqlite));
	let changes = 0;
	const disposable = input.onDidChangeLabel(() => changes++);

	input.setConnectorKind(SqlConnectionKind.MySql);

	assert.equal(input.getDescription(), 'MySQL');
	assert.equal(changes, 1);

	input.setConnectorKind(SqlConnectionKind.MySql);
	assert.equal(changes, 1);
	disposable.dispose();
	input.dispose();
});

test('saved input identity and state never include a runtime password', () => {
	const unsafeSaved = {
		...saved,
		password: 'do-not-store',
		connectionString: 'mysql://app_user:do-not-store@db.example.test/app'
	} as SqlSavedConnection & { password: string; connectionString: string };
	const input = new SqlConnectionEditorInput(createSavedSqlConnectionDialogRequest(unsafeSaved));
	const serialized = JSON.stringify(input.request);

	assert.equal(input.getName(), 'Edit Data Source');
	assert.equal(input.getDescription(), 'MySQL');
	assert.equal('password' in input.request.saved, false);
	assert.equal('connectionString' in input.request.saved, false);
	assert.equal(Object.isFrozen(input.request.saved), true);
	assert.equal(serialized.includes('do-not-store'), false);
	assert.equal(input.resource.toString().includes('do-not-store'), false);
	assert.equal(input.resource.toString().includes(saved.id), false);

	input.dispose();
});

test('connection editor inputs use stable safe identity', () => {
	const first = new SqlConnectionEditorInput(createNewSqlConnectionDialogRequest(SqlConnectionKind.Sqlite));
	const second = new SqlConnectionEditorInput(createNewSqlConnectionDialogRequest(SqlConnectionKind.MySql));

	assert.equal(first.resource.scheme, 'nyala-sql-connection');
	assert.equal(first.resource.path, '/data-source');
	assert.equal(first.matches(second), true);

	first.dispose();
	second.dispose();
});
