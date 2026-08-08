import assert from 'node:assert/strict';
import test from 'node:test';

import {
	canSaveSqlConnectionForm,
	canSubmitSqlConnectionForm,
	createDefaultSqlConnectionFormState,
	createSafeSqlConnectionFormDraft,
	createSqlConnectionFormPreview,
	createSqlConnectionFormStateForConnector,
	createSqlConnectionFormStateForReset,
	createSqlConnectionFormStateFromSavedConnection,
	createSqlConnectionInputFromFormState,
	getSqlConnectionFormFieldRequirements,
	getSqliteConnectionMode,
	getSqlConnectionFormStatus,
	maskSqlConnectionInput,
	normalizeSqlConnectionFormState,
	setSqliteConnectionMode,
	shouldPersistSqlConnectionForm,
	SQL_CONNECTION_PREVIEW_KINDS,
	SqliteConnectionMode
} from '../common/sqlConnectionFormModel.js';
import { openAndSaveMysqlConnection } from '../common/sqlConnectionSubmission.js';
import { setSqlConnectionFormTextControlsBusy } from '../common/sqlConnectionFormBusyState.js';
import { SqlDriverAvailability } from '../../../services/sql/common/sqlDrivers.js';
import {
	SqlConnection,
	SqlConnectionInput,
	SqlConnectionKind,
	SqlSavedConnection,
	SqlSaveConnectionRequest,
	SqlSslMode
} from '../../../services/sql/common/sqlTypes.js';

test('connection form busy state locks and restores every text control', () => {
	const controls = [{ disabled: false }, { disabled: false }, { disabled: false }];

	setSqlConnectionFormTextControlsBusy(controls, true);
	assert.deepEqual(
		controls.map(control => control.disabled),
		[true, true, true]
	);

	setSqlConnectionFormTextControlsBusy(controls, false);
	assert.deepEqual(
		controls.map(control => control.disabled),
		[false, false, false]
	);
});

test('SQL_CONNECTION_PREVIEW_KINDS exposes stable and preview drivers before planned drivers', () => {
	assert.deepEqual(SQL_CONNECTION_PREVIEW_KINDS, [
		SqlConnectionKind.Sqlite,
		SqlConnectionKind.MySql,
		SqlConnectionKind.PostgreSql
	]);
});

test('createDefaultSqlConnectionFormState creates SQLite defaults', () => {
	assert.deepEqual(createDefaultSqlConnectionFormState(SqlConnectionKind.Sqlite), {
		kind: SqlConnectionKind.Sqlite,
		name: undefined,
		sqliteMode: SqliteConnectionMode.File,
		databasePath: '',
		readOnly: true,
		createIfMissing: false,
		saveConnection: false,
		autoConnect: false
	});
});

test('createDefaultSqlConnectionFormState creates explicit SQLite memory defaults', () => {
	assert.deepEqual(createDefaultSqlConnectionFormState(SqlConnectionKind.Sqlite, SqliteConnectionMode.Memory), {
		kind: SqlConnectionKind.Sqlite,
		name: undefined,
		sqliteMode: SqliteConnectionMode.Memory,
		databasePath: ':memory:',
		readOnly: true,
		createIfMissing: false,
		saveConnection: false,
		autoConnect: false
	});
});

test('createDefaultSqlConnectionFormState creates PostgreSQL planned defaults', () => {
	assert.deepEqual(createDefaultSqlConnectionFormState(SqlConnectionKind.PostgreSql), {
		kind: SqlConnectionKind.PostgreSql,
		name: undefined,
		host: 'localhost',
		port: 5432,
		database: 'postgres',
		username: undefined,
		password: undefined,
		sslMode: SqlSslMode.Prefer,
		readOnly: true,
		createIfMissing: false,
		saveConnection: false,
		autoConnect: false
	});
});

test('createDefaultSqlConnectionFormState creates MySQL defaults', () => {
	assert.deepEqual(createDefaultSqlConnectionFormState(SqlConnectionKind.MySql), {
		kind: SqlConnectionKind.MySql,
		name: undefined,
		host: 'localhost',
		port: 3306,
		database: 'mysql',
		username: undefined,
		password: undefined,
		sslMode: SqlSslMode.Prefer,
		readOnly: true,
		createIfMissing: false,
		saveConnection: false,
		autoConnect: false
	});
});

test('connector switching keeps the saved profile id and persistence intent', () => {
	const state = createSqlConnectionFormStateForConnector(SqlConnectionKind.MySql, 'saved-connection');

	assert.equal(state.id, 'saved-connection');
	assert.equal(state.kind, SqlConnectionKind.MySql);
	assert.equal(state.saveConnection, true);
	assert.equal(state.database, 'mysql');
});

test('resetting a saved form restores its safe saved profile instead of creating a new one', () => {
	const saved: SqlSavedConnection = {
		id: 'saved-connection',
		name: 'Saved SQLite',
		kind: SqlConnectionKind.Sqlite,
		databasePath: '/tmp/saved.db',
		readOnly: true,
		createIfMissing: false,
		autoConnect: false
	};

	const state = createSqlConnectionFormStateForReset(SqlConnectionKind.MySql, saved);

	assert.equal(state.id, saved.id);
	assert.equal(state.kind, saved.kind);
	assert.equal(state.databasePath, saved.databasePath);
	assert.equal(state.saveConnection, true);
});

test('normalizeSqlConnectionFormState normalizes SQLite fields', () => {
	const state = normalizeSqlConnectionFormState({
		kind: SqlConnectionKind.Sqlite,
		name: ' Local ',
		databasePath: ' /tmp/app.db ',
		readOnly: true,
		createIfMissing: false,
		saveConnection: true,
		autoConnect: true
	});

	assert.deepEqual(state, {
		kind: SqlConnectionKind.Sqlite,
		name: 'Local',
		sqliteMode: SqliteConnectionMode.File,
		databasePath: '/tmp/app.db',
		readOnly: true,
		createIfMissing: false,
		saveConnection: true,
		autoConnect: true
	});
});

test('normalizeSqlConnectionFormState infers memory mode for legacy SQLite drafts', () => {
	const state = normalizeSqlConnectionFormState({
		kind: SqlConnectionKind.Sqlite,
		databasePath: ':memory:',
		createIfMissing: true,
		saveConnection: true,
		autoConnect: true
	});

	assert.equal(state.sqliteMode, SqliteConnectionMode.Memory);
	assert.equal(state.databasePath, ':memory:');
	assert.equal(state.createIfMissing, false);
	assert.equal(state.saveConnection, false);
	assert.equal(state.autoConnect, false);
});

test('SQLite mode helpers switch between file and memory without mutating the source state', () => {
	const fileState = normalizeSqlConnectionFormState({
		kind: SqlConnectionKind.Sqlite,
		databasePath: '/tmp/app.db',
		createIfMissing: true,
		saveConnection: true,
		autoConnect: true
	});
	const memoryState = setSqliteConnectionMode(fileState, SqliteConnectionMode.Memory);

	assert.equal(getSqliteConnectionMode(fileState), SqliteConnectionMode.File);
	assert.equal(fileState.databasePath, '/tmp/app.db');
	assert.equal(memoryState.sqliteMode, SqliteConnectionMode.Memory);
	assert.equal(memoryState.databasePath, ':memory:');
	assert.equal(memoryState.createIfMissing, false);
	assert.equal(memoryState.saveConnection, false);
	assert.equal(memoryState.autoConnect, false);

	const nextFileState = setSqliteConnectionMode(memoryState, SqliteConnectionMode.File);

	assert.equal(nextFileState.sqliteMode, SqliteConnectionMode.File);
	assert.equal(nextFileState.databasePath, '');
	assert.equal(memoryState.databasePath, ':memory:');
});

test('SQLite field requirements follow file and in-memory modes', () => {
	assert.deepEqual(
		getSqlConnectionFormFieldRequirements({
			kind: SqlConnectionKind.Sqlite,
			sqliteMode: SqliteConnectionMode.File,
			databasePath: ''
		}),
		{ databasePath: true, host: false, port: false, database: false, username: false }
	);
	assert.deepEqual(
		getSqlConnectionFormFieldRequirements({
			kind: SqlConnectionKind.Sqlite,
			sqliteMode: SqliteConnectionMode.Memory,
			databasePath: ':memory:'
		}),
		{ databasePath: false, host: false, port: false, database: false, username: false }
	);
});

test('network field requirements keep password optional', () => {
	const mysql = getSqlConnectionFormFieldRequirements({ kind: SqlConnectionKind.MySql });
	const postgres = getSqlConnectionFormFieldRequirements({ kind: SqlConnectionKind.PostgreSql });

	assert.deepEqual(mysql, { databasePath: false, host: true, port: true, database: true, username: true });
	assert.deepEqual(postgres, { databasePath: false, host: true, port: true, database: true, username: false });
	assert.equal('password' in mysql, false);
});

test('normalizeSqlConnectionFormState disables save and autoConnect for PostgreSQL planned driver', () => {
	const state = normalizeSqlConnectionFormState({
		kind: SqlConnectionKind.PostgreSql,
		name: ' PG ',
		host: ' db.local ',
		port: 15432,
		database: ' app ',
		username: ' user ',
		password: ' secret ',
		sslMode: SqlSslMode.Require,
		saveConnection: true,
		autoConnect: true,
		readOnly: true,
		createIfMissing: true
	});

	assert.deepEqual(state, {
		kind: SqlConnectionKind.PostgreSql,
		name: 'PG',
		host: 'db.local',
		port: 15432,
		database: 'app',
		username: 'user',
		password: ' secret ',
		sslMode: SqlSslMode.Require,
		readOnly: true,
		createIfMissing: false,
		saveConnection: false,
		autoConnect: false
	});
});

test('createSqlConnectionInputFromFormState creates SQLite input', () => {
	assert.deepEqual(
		createSqlConnectionInputFromFormState({
			kind: SqlConnectionKind.Sqlite,
			name: 'Local',
			databasePath: '/tmp/app.db',
			readOnly: true,
			createIfMissing: false
		}),
		{
			name: 'Local',
			kind: SqlConnectionKind.Sqlite,
			databasePath: '/tmp/app.db',
			readOnly: true,
			createIfMissing: false
		}
	);
});

test('normalizeSqlConnectionFormState preserves a trimmed connection id in runtime input', () => {
	const state = normalizeSqlConnectionFormState({
		id: ' saved-connection ',
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: 'app',
		username: 'root'
	});

	assert.equal(state.id, 'saved-connection');
	assert.equal(createSqlConnectionInputFromFormState(state).id, 'saved-connection');
});

test('normalizeSqlConnectionFormState preserves an explicit network write mode', () => {
	const state = normalizeSqlConnectionFormState({
		kind: SqlConnectionKind.MySql,
		readOnly: false
	});

	assert.equal(state.readOnly, false);
	assert.equal(createSqlConnectionInputFromFormState(state).readOnly, false);
});

test('createSqlConnectionInputFromFormState creates PostgreSQL planned input', () => {
	assert.deepEqual(
		createSqlConnectionInputFromFormState({
			kind: SqlConnectionKind.PostgreSql,
			name: 'App PG',
			host: 'localhost',
			port: 5432,
			database: 'app',
			username: 'user',
			password: 'secret',
			sslMode: SqlSslMode.Require
		}),
		{
			name: 'App PG',
			kind: SqlConnectionKind.PostgreSql,
			host: 'localhost',
			port: 5432,
			database: 'app',
			username: 'user',
			password: 'secret',
			sslMode: SqlSslMode.Require,
			readOnly: true,
			createIfMissing: false
		}
	);
});

test('createSqlConnectionInputFromFormState preserves password whitespace', () => {
	const input = createSqlConnectionInputFromFormState({
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: 'app',
		username: 'root',
		password: ' secret '
	});

	assert.equal(input.password, ' secret ');
});

test('normalizeSqlConnectionFormState preserves a whitespace-only password', () => {
	const state = normalizeSqlConnectionFormState({
		kind: SqlConnectionKind.MySql,
		password: '   '
	});

	assert.equal(state.password, '   ');
});

test('normalizeSqlConnectionFormState omits an empty password', () => {
	const state = normalizeSqlConnectionFormState({
		kind: SqlConnectionKind.MySql,
		password: ''
	});

	assert.equal(state.password, undefined);
});

test('maskSqlConnectionInput removes password', () => {
	assert.deepEqual(
		maskSqlConnectionInput({
			kind: SqlConnectionKind.PostgreSql,
			host: 'localhost',
			port: 5432,
			database: 'app',
			username: 'user',
			password: 'secret',
			sslMode: SqlSslMode.Prefer
		}),
		{
			kind: SqlConnectionKind.PostgreSql,
			host: 'localhost',
			port: 5432,
			database: 'app',
			username: 'user',
			sslMode: SqlSslMode.Prefer
		}
	);
});

test('createSafeSqlConnectionFormDraft structurally removes password', () => {
	const draft = createSafeSqlConnectionFormDraft({
		id: ' saved-connection ',
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: 'app',
		username: 'root',
		password: 'secret'
	});

	assert.equal(draft.id, 'saved-connection');
	assert.equal('password' in draft, false);
});

test('saved MySQL connection becomes a password-free reconnect draft', () => {
	const draft = createSqlConnectionFormStateFromSavedConnection({
		id: 'saved-mysql',
		name: 'Local MySQL',
		kind: SqlConnectionKind.MySql,
		host: '127.0.0.1',
		port: 3307,
		database: 'app',
		username: 'root',
		sslMode: SqlSslMode.Require,
		readOnly: true,
		createIfMissing: false,
		autoConnect: true
	});

	assert.deepEqual(draft, {
		id: 'saved-mysql',
		kind: SqlConnectionKind.MySql,
		name: 'Local MySQL',
		host: '127.0.0.1',
		port: 3307,
		database: 'app',
		username: 'root',
		sslMode: SqlSslMode.Require,
		readOnly: true,
		createIfMissing: false,
		saveConnection: true,
		autoConnect: false
	});
	assert.equal('password' in draft, false);
});

test('createSqlConnectionFormPreview allows SQLite connect', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.Sqlite,
		databasePath: '/tmp/app.db'
	});

	assert.equal(preview.label, 'SQLite');
	assert.equal(preview.availability, SqlDriverAvailability.Enabled);
	assert.equal(preview.canConnect, true);
	assert.deepEqual(preview.missingFields, []);
	assert.equal(preview.summary, 'SQLite · /tmp/app.db');
});

test('createSqlConnectionFormPreview prevents saving memory SQLite connection', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.Sqlite,
		databasePath: ':memory:',
		saveConnection: true
	});

	assert.equal(preview.canConnect, true);
	assert.equal(preview.canSave, false);
});

test('createSqlConnectionFormPreview blocks PostgreSQL connect', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.PostgreSql,
		host: 'localhost',
		port: 5432,
		database: 'app',
		username: 'user',
		password: 'secret'
	});

	assert.equal(preview.label, 'PostgreSQL');
	assert.equal(preview.availability, SqlDriverAvailability.Planned);
	assert.equal(preview.canConnect, false);
	assert.equal(preview.canSave, false);
	assert.equal(preview.input.password, undefined);
	assert.equal(preview.maskedInput.password, undefined);
	assert.match(preview.message, /planned/);
});

test('canSubmitSqlConnectionForm returns false for PostgreSQL planned driver', () => {
	assert.equal(
		canSubmitSqlConnectionForm({
			kind: SqlConnectionKind.PostgreSql,
			host: 'localhost',
			database: 'app'
		}),
		false
	);
});

test('canSaveSqlConnectionForm returns true only for persistable SQLite', () => {
	assert.equal(
		canSaveSqlConnectionForm({
			kind: SqlConnectionKind.Sqlite,
			databasePath: '/tmp/app.db',
			saveConnection: true
		}),
		true
	);

	assert.equal(
		canSaveSqlConnectionForm({
			kind: SqlConnectionKind.Sqlite,
			databasePath: ':memory:',
			saveConnection: true
		}),
		false
	);
});

test('existing data source remains persisted when its save checkbox is cleared', () => {
	assert.equal(
		shouldPersistSqlConnectionForm({
			id: 'saved-sqlite',
			kind: SqlConnectionKind.Sqlite,
			databasePath: '/tmp/app.db',
			saveConnection: false
		}),
		true
	);

	assert.equal(
		shouldPersistSqlConnectionForm({
			kind: SqlConnectionKind.Sqlite,
			databasePath: '/tmp/app.db',
			saveConnection: false
		}),
		false
	);
});

test('getSqlConnectionFormStatus returns preview status', () => {
	assert.equal(
		getSqlConnectionFormStatus({
			kind: SqlConnectionKind.PostgreSql,
			host: 'localhost',
			port: 5432,
			database: 'app'
		}),
		'PostgreSQL Planned · localhost:5432/app · PostgreSQL is planned. Runtime connection is not enabled yet.'
	);
});

test('blank SQLite database path stays blank instead of falling back to memory database', () => {
	const state = normalizeSqlConnectionFormState({
		kind: SqlConnectionKind.Sqlite,
		databasePath: '   '
	});

	assert.equal(state.databasePath, '');

	const preview = createSqlConnectionFormPreview(state);

	assert.equal(preview.canConnect, false);
	assert.equal(preview.canSave, false);
	assert.deepEqual(preview.missingFields, ['databasePath']);
	assert.equal(preview.summary, 'SQLite · missing database path');
	assert.equal(preview.message, 'SQLite database path is required.');
});

test('undefined SQLite database path uses blank file mode and cannot connect', () => {
	const state = normalizeSqlConnectionFormState({
		kind: SqlConnectionKind.Sqlite
	});

	assert.equal(state.sqliteMode, SqliteConnectionMode.File);
	assert.equal(state.databasePath, '');
	assert.equal(state.createIfMissing, false);

	const preview = createSqlConnectionFormPreview(state);

	assert.equal(preview.canConnect, false);
	assert.equal(preview.canSave, false);
	assert.deepEqual(preview.missingFields, ['databasePath']);
	assert.equal(preview.summary, 'SQLite · missing database path');
});

test('PostgreSQL planned input is masked and does not expose password', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.PostgreSql,
		host: 'localhost',
		port: 5432,
		database: 'app',
		username: 'user',
		password: 'secret'
	});

	assert.equal(preview.input.password, undefined);
	assert.equal(preview.maskedInput.password, undefined);
	assert.deepEqual(preview.input, preview.maskedInput);
});

test('PostgreSQL preview reports missing host and database', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.PostgreSql,
		host: '   ',
		database: '   ',
		port: 5432
	});

	assert.equal(preview.canConnect, false);
	assert.equal(preview.canSave, false);
	assert.deepEqual(preview.missingFields, ['host', 'database']);
	assert.equal(preview.summary, 'PostgreSQL Planned · missing host, database');
	assert.equal(preview.message, 'PostgreSQL Planned is missing host, database. Runtime connection is not enabled yet.');
});

test('createSqlConnectionFormPreview allows MySQL connect', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: 'app',
		username: 'root',
		password: 'secret'
	});

	assert.equal(preview.label, 'MySQL');
	assert.equal(preview.availability, SqlDriverAvailability.Enabled);
	assert.equal(preview.canConnect, true);
	assert.equal(preview.canSave, false);
	assert.deepEqual(preview.missingFields, []);
	assert.equal(preview.message, 'MySQL Preview runtime is ready. Query cancellation is not supported yet.');
	assert.equal(preview.summary, 'MySQL Preview · localhost:3306/app');
	assert.equal(preview.input.password, undefined);
});

test('MySQL preview allows accounts without a password', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: 'app',
		username: 'root'
	});

	assert.equal(preview.canConnect, true);
	assert.deepEqual(preview.missingFields, []);
});

test('canSaveSqlConnectionForm allows MySQL public profile save without auto connect', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: 'app',
		username: 'root',
		saveConnection: true,
		autoConnect: true
	});

	assert.equal(preview.canConnect, true);
	assert.equal(preview.canSave, true);

	const state = normalizeSqlConnectionFormState({
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: 'app',
		username: 'root',
		saveConnection: true,
		autoConnect: true
	});

	assert.equal(state.saveConnection, true);
	assert.equal(state.autoConnect, false);
});

test('MySQL preview reports missing database', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: '',
		username: 'root'
	});

	assert.equal(preview.canConnect, false);
	assert.deepEqual(preview.missingFields, ['database']);
	assert.equal(preview.summary, 'MySQL Preview · missing database');
	assert.equal(preview.message, 'MySQL connection is missing database. Query cancellation is not supported yet.');
});

test('MySQL preview requires a username', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: 'app'
	});

	assert.equal(preview.canConnect, false);
	assert.deepEqual(preview.missingFields, ['username']);
	assert.equal(preview.message, 'MySQL connection is missing username. Query cancellation is not supported yet.');
});

test('MySQL preview keeps explicit invalid ports missing instead of applying the default', () => {
	for (const port of [Number.NaN, 0, 65_536, 3306.5]) {
		const state = normalizeSqlConnectionFormState({
			kind: SqlConnectionKind.MySql,
			host: 'localhost',
			port,
			database: 'app',
			username: 'root'
		});
		const preview = createSqlConnectionFormPreview(state);

		assert.equal(state.port, undefined, `port=${port}`);
		assert.equal(preview.canConnect, false, `port=${port}`);
		assert.deepEqual(preview.missingFields, ['port'], `port=${port}`);
	}
});

test('MySQL preview applies the driver default only when port is omitted', () => {
	const state = normalizeSqlConnectionFormState({
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		database: 'app',
		username: 'root'
	});
	const preview = createSqlConnectionFormPreview(state);

	assert.equal(state.port, 3306);
	assert.equal(preview.canConnect, true);
	assert.deepEqual(preview.missingFields, []);
});

test('MySQL preview input is masked and does not expose password', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: 'app',
		username: 'root',
		password: 'secret'
	});

	assert.equal(preview.input.password, undefined);
	assert.equal(preview.maskedInput.password, undefined);
	assert.deepEqual(preview.input, preview.maskedInput);
});

class RecordingSubmissionService {
	readonly openInputs: SqlConnectionInput[] = [];
	readonly saveRequests: SqlSaveConnectionRequest[] = [];
	readonly closedIds: string[] = [];
	saveError: Error | undefined;

	async openConnection(input: SqlConnectionInput): Promise<SqlConnection> {
		this.openInputs.push(input);
		return {
			id: 'opened-mysql-id',
			name: input.name ?? 'MySQL',
			kind: SqlConnectionKind.MySql,
			host: input.host,
			port: input.port,
			database: input.database,
			username: input.username,
			sslMode: input.sslMode,
			readOnly: false
		};
	}

	async closeConnection(connectionId: string): Promise<void> {
		this.closedIds.push(connectionId);
	}

	async saveConnection(request: SqlSaveConnectionRequest): Promise<SqlSavedConnection> {
		this.saveRequests.push(request);
		if (this.saveError) {
			throw this.saveError;
		}
		return {
			id: request.input.id ?? '',
			name: request.input.name ?? 'MySQL',
			kind: SqlConnectionKind.MySql,
			host: request.input.host,
			port: request.input.port,
			database: request.input.database,
			username: request.input.username,
			sslMode: request.input.sslMode,
			readOnly: false,
			createIfMissing: false,
			autoConnect: false
		};
	}
}

test('openAndSaveMysqlConnection persists the opened id without the runtime password', async () => {
	const service = new RecordingSubmissionService();
	const runtimeInput: SqlConnectionInput = {
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: 'app',
		username: 'root',
		password: 'secret'
	};
	const persistedInput = maskSqlConnectionInput(runtimeInput);

	const connection = await openAndSaveMysqlConnection(service, runtimeInput, persistedInput);

	assert.equal(connection.id, 'opened-mysql-id');
	assert.equal(service.openInputs[0].password, 'secret');
	assert.equal(service.saveRequests[0].input.id, 'opened-mysql-id');
	assert.equal(service.saveRequests[0].input.password, undefined);
	assert.deepEqual(service.closedIds, []);
});

test('openAndSaveMysqlConnection closes the opened connection when save fails', async () => {
	const service = new RecordingSubmissionService();
	service.saveError = new Error('save failed');
	const input: SqlConnectionInput = {
		kind: SqlConnectionKind.MySql,
		host: 'localhost',
		port: 3306,
		database: 'app',
		username: 'root'
	};

	await assert.rejects(() => openAndSaveMysqlConnection(service, input, input), /save failed/);
	assert.deepEqual(service.closedIds, ['opened-mysql-id']);
});
