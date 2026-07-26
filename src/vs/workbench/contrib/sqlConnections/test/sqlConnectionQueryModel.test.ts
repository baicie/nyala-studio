/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection query model tests (Phase 01).
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlConnectionQueryModel } from '../browser/sqlConnectionQueryModel.js';
import { IConnectionWithStatus } from '../../../services/sql/common/sqlConnection.js';
import {
	SqlRuntimeDriverId,
	SqlRuntimeStatus,
	ISqlDriverCatalogService,
	SqlRuntimeDriverEntry
} from '../../../services/sql/common/sqlDriverCatalog.js';

class StubCatalog implements ISqlDriverCatalogService {
	declare readonly _serviceBrand: undefined;
	private readonly entries: Map<string, SqlRuntimeDriverEntry> = new Map();
	constructor(entries: SqlRuntimeDriverEntry[]) {
		for (const entry of entries) {
			this.entries.set(entry.id, entry);
		}
	}
	getRuntimeStatus(): Promise<SqlRuntimeDriverEntry[]> {
		return Promise.resolve([...this.entries.values()]);
	}
	getCachedRuntimeStatus(): SqlRuntimeDriverEntry[] {
		return [...this.entries.values()];
	}
	findRuntimeStatus(id: SqlRuntimeDriverId): SqlRuntimeDriverEntry | undefined {
		return this.entries.get(id);
	}
	isDriverRunnable(id: SqlRuntimeDriverId): boolean {
		const s = this.entries.get(id)?.status;
		return s === SqlRuntimeStatus.Stable || s === SqlRuntimeStatus.Preview;
	}
	assertAtLeast(): void {}
	labelFor(id: SqlRuntimeDriverId): string {
		return id;
	}
	onChange(): { dispose(): void } {
		return { dispose() {} };
	}
}

function profile(id: string, label: string, driver: SqlRuntimeDriverId): IConnectionWithStatus {
	return {
		profile: { id, label, driver, readOnly: false, createdAtMs: 0 },
		status: { kind: 'idle' }
	};
}

test('query model filters by label substring', () => {
	const source: IConnectionWithStatus[] = [
		profile('1', 'prod-sqlite', SqlRuntimeDriverId.Sqlite),
		profile('2', 'dev-mysql', SqlRuntimeDriverId.MySql)
	];
	const model = new SqlConnectionQueryModel(
		source,
		{},
		new StubCatalog([
			{ id: SqlRuntimeDriverId.Sqlite, displayName: 'SQLite', status: SqlRuntimeStatus.Stable, summary: '', notes: [] },
			{ id: SqlRuntimeDriverId.MySql, displayName: 'MySQL', status: SqlRuntimeStatus.Preview, summary: '', notes: [] }
		])
	);
	const r = model.query({ text: 'mysql' });
	assert.equal(r.length, 1);
	assert.equal(r[0].profile.id, '2');
});

test('query model filters by driver', () => {
	const source: IConnectionWithStatus[] = [
		profile('1', 'a', SqlRuntimeDriverId.Sqlite),
		profile('2', 'b', SqlRuntimeDriverId.MySql)
	];
	const model = new SqlConnectionQueryModel(
		source,
		{},
		new StubCatalog([
			{ id: SqlRuntimeDriverId.Sqlite, displayName: 'SQLite', status: SqlRuntimeStatus.Stable, summary: '', notes: [] },
			{ id: SqlRuntimeDriverId.MySql, displayName: 'MySQL', status: SqlRuntimeStatus.Preview, summary: '', notes: [] }
		])
	);
	assert.equal(model.query({ driver: SqlRuntimeDriverId.Sqlite }).length, 1);
});

test('onlyEnabled excludes planned drivers', () => {
	const source: IConnectionWithStatus[] = [
		profile('1', 'a', SqlRuntimeDriverId.Sqlite),
		profile('2', 'b', SqlRuntimeDriverId.Postgres)
	];
	const model = new SqlConnectionQueryModel(
		source,
		{},
		new StubCatalog([
			{ id: SqlRuntimeDriverId.Sqlite, displayName: 'SQLite', status: SqlRuntimeStatus.Stable, summary: '', notes: [] },
			{
				id: SqlRuntimeDriverId.Postgres,
				displayName: 'Postgres',
				status: SqlRuntimeStatus.Planned,
				summary: '',
				notes: []
			}
		])
	);
	assert.equal(model.query({ onlyEnabled: true }).length, 1);
});

test('query model returns empty when filter mismatches', () => {
	const model = new SqlConnectionQueryModel([], {}, new StubCatalog([]));
	assert.equal(model.query({ text: 'x' }).length, 0);
});

test('list returns source as readonly snapshot', () => {
	const source: IConnectionWithStatus[] = [profile('1', 'a', SqlRuntimeDriverId.Sqlite)];
	const model = new SqlConnectionQueryModel(
		source,
		{},
		new StubCatalog([
			{ id: SqlRuntimeDriverId.Sqlite, displayName: 'SQLite', status: SqlRuntimeStatus.Stable, summary: '', notes: [] }
		])
	);
	const snap = model.list();
	assert.equal(snap.length, 1);
});
