/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection form controller tests (Phase 01).
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlConnectionFormController } from '../browser/sqlConnectionFormController.js';
import { ConnectionProfile, ConnectionSecret, IConnectionWithStatus, ISqlConnectionServiceV2 } from '../../../services/sql/common/sqlConnection.js';
import { SqlRuntimeDriverId, SqlRuntimeStatus, ISqlDriverCatalogService, SqlRuntimeDriverEntry } from '../../../services/sql/common/sqlDriverCatalog.js';
import { IConnectionFormWidget } from '../browser/sqlConnectionFormWidget.js';

class StubCatalog implements ISqlDriverCatalogService {
	declare readonly _serviceBrand: undefined;
	private readonly entries: Map<string, SqlRuntimeDriverEntry> = new Map();
	constructor(entries: SqlRuntimeDriverEntry[]) {
		for (const entry of entries) {
			this.entries.set(entry.id, entry);
		}
	}
	getRuntimeStatus(): Promise<SqlRuntimeDriverEntry[]> { return Promise.resolve([...this.entries.values()]); }
	getCachedRuntimeStatus(): SqlRuntimeDriverEntry[] { return [...this.entries.values()]; }
	findRuntimeStatus(id: SqlRuntimeDriverId): SqlRuntimeDriverEntry | undefined { return this.entries.get(id); }
	isDriverRunnable(id: SqlRuntimeDriverId): boolean { return (this.entries.get(id)?.status === SqlRuntimeStatus.Stable) || (this.entries.get(id)?.status === SqlRuntimeStatus.Preview); }
	assertAtLeast(id: SqlRuntimeDriverId, minimum: SqlRuntimeStatus): void {
		const current = this.entries.get(id)?.status;
		if (!current) {
		throw new Error(`unknown driver ${id}`);
	}
		const matrix: Record<SqlRuntimeStatus, Set<SqlRuntimeStatus>> = {
			[SqlRuntimeStatus.Stable]: new Set([SqlRuntimeStatus.Stable, SqlRuntimeStatus.Preview, SqlRuntimeStatus.Planned, SqlRuntimeStatus.Disabled]),
			[SqlRuntimeStatus.Preview]: new Set([SqlRuntimeStatus.Preview, SqlRuntimeStatus.Planned, SqlRuntimeStatus.Disabled]),
			[SqlRuntimeStatus.Planned]: new Set([SqlRuntimeStatus.Planned, SqlRuntimeStatus.Disabled]),
			[SqlRuntimeStatus.Disabled]: new Set([SqlRuntimeStatus.Disabled]),
		};
		if (!matrix[minimum].has(current)) {
			throw new Error(`driver ${id} does not meet status: current=${current}, minimum=${minimum}`);
		}
	}
	labelFor(id: SqlRuntimeDriverId): string { return `${id} · ${this.entries.get(id)?.status ?? 'unknown'}`; }
	onChange(): () => void { return () => {}; }
}

class RecordingWidget implements IConnectionFormWidget {
	errors: { code: string; message: string }[] = [];
	oks: { code: string; message: string }[] = [];
	clears = 0;
	closed = 0;
	capturedSecret: ConnectionSecret;
	constructor(public profileFields: Partial<ConnectionProfile>, secret: ConnectionSecret = { password: 'x' }) {
		this.capturedSecret = secret;
	}
	readProfile(): ConnectionProfile {
		return {
			id: this.profileFields.label ?? 'p',
			label: this.profileFields.label ?? 'p',
			driver: this.profileFields.driver ?? SqlRuntimeDriverId.Sqlite,
			readOnly: this.profileFields.readOnly ?? false,
			host: this.profileFields.host,
			port: this.profileFields.port,
			database: this.profileFields.database,
			username: this.profileFields.username,
			filePath: this.profileFields.filePath,
			rememberInMemory: this.profileFields.rememberInMemory,
			createdAtMs: 0,
		};
	}
	readSecret(): ConnectionSecret { return this.capturedSecret; }
	clearSecret(): void { this.capturedSecret = {}; this.clears++; }
	flashOk(code: string, message: string): void { this.oks.push({ code, message }); }
	flashError(code: string, message: string): void { this.errors.push({ code, message }); }
	close(): void { this.closed++; }
}

class StubConnections implements ISqlConnectionServiceV2 {
	declare readonly _serviceBrand: undefined;
	readonly testCalls: Array<{ profile: ConnectionProfile; secret: ConnectionSecret }> = [];
	readonly openCalls: Array<{ profile: ConnectionProfile; secret: ConnectionSecret }> = [];
	private throwOnTest: Error | undefined;
	async list(): Promise<IConnectionWithStatus[]> { return []; }
	async test(profile: ConnectionProfile, secret: ConnectionSecret): Promise<void> {
		this.testCalls.push({ profile, secret });
		if (this.throwOnTest) {
			throw this.throwOnTest;
		}
	}
	async open(profile: ConnectionProfile, secret: ConnectionSecret): Promise<string> {
		this.openCalls.push({ profile, secret });
		return profile.id;
	}
	async close(): Promise<void> {}
	async forgetAllSecrets(): Promise<void> {}
	onChange(): import('vs/base/common/event').Event<void> { return () => {}; }
}

test('submit test calls backend with secret then clears', async () => {
	const connections = new StubConnections();
	const catalog = new StubCatalog([
		{ id: SqlRuntimeDriverId.Sqlite, displayName: 'SQLite', status: SqlRuntimeStatus.Stable, summary: '', notes: [] },
	]);
	const ctrl = new SqlConnectionFormController(connections, catalog);
	const widget = new RecordingWidget({ label: 'demo', driver: SqlRuntimeDriverId.Sqlite });

	await ctrl.submit('test', widget);

	assert.equal(connections.testCalls.length, 1);
	assert.equal(widget.clears, 1);
	assert.equal(widget.errors.length, 0);
	assert.equal(widget.oks.length, 1);
});

test('submit open for postgres is rejected client-side', async () => {
	const connections = new StubConnections();
	const catalog = new StubCatalog([
		{ id: SqlRuntimeDriverId.Postgres, displayName: 'Postgres', status: SqlRuntimeStatus.Planned, summary: '', notes: [] },
	]);
	const ctrl = new SqlConnectionFormController(connections, catalog);
	const widget = new RecordingWidget({ label: 'pg', driver: SqlRuntimeDriverId.Postgres });

	await ctrl.submit('open', widget);

	assert.equal(connections.openCalls.length, 0);
	assert.equal(widget.errors.length, 1);
	assert.match(widget.errors[0].message, /planned/);
});

test('clearSecret is always invoked even when backend rejects', async () => {
	const connections = new StubConnections();
	connections.throwOnTest = new Error('boom');
	const catalog = new StubCatalog([
		{ id: SqlRuntimeDriverId.Sqlite, displayName: 'SQLite', status: SqlRuntimeStatus.Stable, summary: '', notes: [] },
	]);
	const ctrl = new SqlConnectionFormController(connections, catalog);
	const widget = new RecordingWidget({ label: 'm', driver: SqlRuntimeDriverId.Sqlite });

	await ctrl.submit('test', widget);

	assert.equal(widget.clears, 1);
	assert.equal(widget.errors.length, 1);
	assert.match(widget.errors[0].message, /boom/);
});

test('submit open for mysql calls backend with secret', async () => {
	const connections = new StubConnections();
	const catalog = new StubCatalog([
		{ id: SqlRuntimeDriverId.MySql, displayName: 'MySQL', status: SqlRuntimeStatus.Preview, summary: '', notes: [] },
	]);
	const ctrl = new SqlConnectionFormController(connections, catalog);
	const widget = new RecordingWidget({
		label: 'm', driver: SqlRuntimeDriverId.MySql, host: '127.0.0.1', port: 3306, database: 'd', username: 'u',
	});

	await ctrl.submit('open', widget);

	assert.equal(connections.openCalls.length, 1);
	assert.equal(widget.closed, 1);
	assert.equal(widget.clears, 1);
});