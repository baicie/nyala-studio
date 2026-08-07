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
	SqlConnectionDialogNavigation
} from '../common/sqlConnectionNavigation.js';
import { SQL_CONNECTIONS_REFRESH_COMMAND_ID, SQL_CONNECTORS_OPEN_SAVED_COMMAND_ID } from '../common/sqlConnections.js';
import { SqlConnectionKind, SqlSavedConnection } from '../../../services/sql/common/sqlTypes.js';
import { SqlConnectionDialogGate } from '../../../services/sql/common/sqlConnectionDialog.js';

class RecordingConnectionDialog implements SqlConnectionDialogNavigation {
	newFormKinds: SqlConnectionKind[] = [];
	savedForms: SqlSavedConnection[] = [];

	async openNew(kind: SqlConnectionKind = SqlConnectionKind.Sqlite): Promise<void> {
		this.newFormKinds.push(kind);
	}

	async openSaved(saved: SqlSavedConnection): Promise<void> {
		this.savedForms.push(saved);
	}
}

test('new data source opens the selected connector in the modal editor', async () => {
	const dialog = new RecordingConnectionDialog();

	await openNewSqlDataSourceForm(dialog, SqlConnectionKind.MySql);

	assert.deepEqual(dialog.newFormKinds, [SqlConnectionKind.MySql]);
	assert.deepEqual(dialog.savedForms, []);
});

test('saved MySQL data source opens in the modal editor', async () => {
	const dialog = new RecordingConnectionDialog();
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

	await openSavedSqlDataSourceForm(dialog, saved);

	assert.deepEqual(dialog.newFormKinds, []);
	assert.deepEqual(dialog.savedForms, [saved]);
});

test('missing saved data source does not open the modal editor', async () => {
	const dialog = new RecordingConnectionDialog();

	await openSavedSqlDataSourceForm(dialog, undefined);

	assert.deepEqual(dialog.savedForms, []);
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

test('connection dialog gate reuses one pending dialog', async () => {
	const gate = new SqlConnectionDialogGate<SqlConnectionKind | undefined>();
	let resolveDialog!: (value: SqlConnectionKind | undefined) => void;
	let factoryCalls = 0;
	const factory = () => {
		factoryCalls++;
		return new Promise<SqlConnectionKind | undefined>(resolve => {
			resolveDialog = resolve;
		});
	};

	const first = gate.run(factory);
	const concurrent = gate.run(factory);

	assert.equal(first, concurrent);
	assert.equal(factoryCalls, 1);

	resolveDialog(SqlConnectionKind.MySql);
	assert.equal(await first, SqlConnectionKind.MySql);

	const next = gate.run(async () => SqlConnectionKind.Sqlite);
	assert.notEqual(next, first);
	assert.equal(await next, SqlConnectionKind.Sqlite);
});

test('connection dialog gate allows retry after rejection', async () => {
	const gate = new SqlConnectionDialogGate<SqlConnectionKind | undefined>();

	await assert.rejects(() => gate.run(async () => Promise.reject(new Error('dialog failed'))), /dialog failed/);
	assert.equal(await gate.run(async () => SqlConnectionKind.Sqlite), SqlConnectionKind.Sqlite);
});
