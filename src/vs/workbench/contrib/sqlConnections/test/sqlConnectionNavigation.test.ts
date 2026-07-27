/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection navigation boundaries.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	refreshDataSourcesAfterConnection,
	openNewSqlDataSourceForm,
	openSavedSqlDataSourceForm,
	requestSavedMysqlDataSourceForm,
	SqlConnectionFormView
} from '../common/sqlConnectionNavigation.js';
import {
	SQL_CONNECTIONS_REFRESH_COMMAND_ID,
	SQL_CONNECTORS_OPEN_SAVED_COMMAND_ID,
	SQL_CONNECTORS_VIEW_ID
} from '../common/sqlConnections.js';
import { SqlConnectionKind, SqlSavedConnection } from '../../../services/sql/common/sqlTypes.js';

class RecordingConnectionFormView implements SqlConnectionFormView {
	newFormCalls = 0;
	savedForms: SqlSavedConnection[] = [];

	openConnectionForm(): void {
		this.newFormCalls++;
	}

	openSavedConnectionForm(saved: SqlSavedConnection): void {
		this.savedForms.push(saved);
	}
}

test('new data source opens the connectors form with focus', async () => {
	const view = new RecordingConnectionFormView();
	const calls: Array<{ viewId: string; focus: boolean }> = [];

	await openNewSqlDataSourceForm(async (viewId, focus) => {
		calls.push({ viewId, focus });
		return view;
	});

	assert.deepEqual(calls, [{ viewId: SQL_CONNECTORS_VIEW_ID, focus: true }]);
	assert.equal(view.newFormCalls, 1);
	assert.deepEqual(view.savedForms, []);
});

test('saved MySQL data source opens its connectors form with focus', async () => {
	const view = new RecordingConnectionFormView();
	const calls: Array<{ viewId: string; focus: boolean }> = [];
	const saved: SqlSavedConnection = {
		id: 'mysql-prod',
		name: 'Production MySQL',
		kind: SqlConnectionKind.MySql,
		host: 'db.example.test',
		port: 3306,
		database: 'app',
		username: 'app_user',
		sslMode: undefined,
		readOnly: false,
		createIfMissing: false,
		autoConnect: false
	};

	await openSavedSqlDataSourceForm(async (viewId, focus) => {
		calls.push({ viewId, focus });
		return view;
	}, saved);

	assert.deepEqual(calls, [{ viewId: SQL_CONNECTORS_VIEW_ID, focus: true }]);
	assert.equal(view.newFormCalls, 0);
	assert.deepEqual(view.savedForms, [saved]);
});

test('missing saved data source does not open the connectors form', async () => {
	let openCalls = 0;

	await openSavedSqlDataSourceForm(async () => {
		openCalls++;
		return null;
	}, undefined);

	assert.equal(openCalls, 0);
});

test('connection success refreshes and reveals the data source', async () => {
	const calls: Array<{ commandId: string; args: unknown[] }> = [];

	await refreshDataSourcesAfterConnection(async (commandId, ...args) => {
		calls.push({ commandId, args });
	}, 'mysql-prod');

	assert.deepEqual(calls, [
		{
			commandId: SQL_CONNECTIONS_REFRESH_COMMAND_ID,
			args: [{ revealConnectionId: 'mysql-prod' }]
		}
	]);
});

test('saved MySQL data source routes through the connectors command', async () => {
	const saved: SqlSavedConnection = {
		id: 'mysql-prod',
		name: 'Production MySQL',
		kind: SqlConnectionKind.MySql,
		host: 'db.example.test',
		port: 3306,
		database: 'app',
		username: 'app_user',
		sslMode: undefined,
		readOnly: false,
		createIfMissing: false,
		autoConnect: false
	};
	const calls: Array<{ commandId: string; args: unknown[] }> = [];

	await requestSavedMysqlDataSourceForm(async (commandId, ...args) => {
		calls.push({ commandId, args });
	}, saved);

	assert.deepEqual(calls, [{ commandId: SQL_CONNECTORS_OPEN_SAVED_COMMAND_ID, args: [saved] }]);
});
