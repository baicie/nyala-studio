import assert from 'node:assert/strict';
import test from 'node:test';

import { IDisposable } from '../../../../base/common/lifecycle.js';
import { getSqlConnectorRuntimeDriverId, requireRunnableSqlConnector } from '../common/sqlConnectorRuntimeGuard.js';
import {
	ISqlDriverCatalogService,
	SqlRuntimeDriverEntry,
	SqlRuntimeDriverId,
	SqlRuntimeStatus
} from '../common/sqlDriverCatalog.js';
import { SqlConnectionKind } from '../common/sqlTypes.js';

class FakeSqlDriverCatalog implements ISqlDriverCatalogService {
	readonly _serviceBrand = undefined;
	readonly assertions: Array<{ id: SqlRuntimeDriverId; minimum: SqlRuntimeStatus }> = [];

	constructor(
		private readonly status: SqlRuntimeStatus,
		private readonly load: () => Promise<void> = async () => {}
	) {}

	async getRuntimeStatus(): Promise<SqlRuntimeDriverEntry[]> {
		await this.load();
		return [this.entry()];
	}
	refreshRuntimeStatus(): Promise<SqlRuntimeDriverEntry[]> {
		return this.getRuntimeStatus();
	}

	getCachedRuntimeStatus(): SqlRuntimeDriverEntry[] {
		return [this.entry()];
	}

	findRuntimeStatus(id: SqlRuntimeDriverId): SqlRuntimeDriverEntry | undefined {
		return id === SqlRuntimeDriverId.Sqlite ? this.entry() : undefined;
	}

	isDriverRunnable(): boolean {
		return this.status === SqlRuntimeStatus.Stable || this.status === SqlRuntimeStatus.Preview;
	}

	assertAtLeast(id: SqlRuntimeDriverId, minimum: SqlRuntimeStatus): void {
		this.assertions.push({ id, minimum });
		if (this.status !== SqlRuntimeStatus.Stable && this.status !== SqlRuntimeStatus.Preview) {
			throw new Error(`Driver ${id} is ${this.status}`);
		}
	}

	labelFor(id: SqlRuntimeDriverId): string {
		return id;
	}

	onChange(): IDisposable {
		return { dispose() {} };
	}

	private entry(): SqlRuntimeDriverEntry {
		return {
			id: SqlRuntimeDriverId.Sqlite,
			displayName: 'SQLite',
			status: this.status,
			summary: '',
			notes: []
		};
	}
}

test('getSqlConnectorRuntimeDriverId maps every known connector kind', () => {
	assert.equal(getSqlConnectorRuntimeDriverId(SqlConnectionKind.Sqlite), SqlRuntimeDriverId.Sqlite);
	assert.equal(getSqlConnectorRuntimeDriverId(SqlConnectionKind.MySql), SqlRuntimeDriverId.MySql);
	assert.equal(getSqlConnectorRuntimeDriverId(SqlConnectionKind.PostgreSql), SqlRuntimeDriverId.Postgres);
	assert.throws(
		() => getSqlConnectorRuntimeDriverId('oracle' as SqlConnectionKind),
		/Unknown SQL connector kind: oracle/
	);
});

test('requireRunnableSqlConnector waits for runtime status before asserting', async () => {
	let resolveLoad: (() => void) | undefined;
	const load = new Promise<void>(resolve => {
		resolveLoad = resolve;
	});
	const catalog = new FakeSqlDriverCatalog(SqlRuntimeStatus.Stable, () => load);
	const result = requireRunnableSqlConnector(SqlConnectionKind.Sqlite, catalog);

	await Promise.resolve();
	assert.equal(catalog.assertions.length, 0);

	resolveLoad?.();
	assert.equal(await result, SqlRuntimeDriverId.Sqlite);
	assert.deepEqual(catalog.assertions, [{ id: SqlRuntimeDriverId.Sqlite, minimum: SqlRuntimeStatus.Preview }]);
});

test('requireRunnableSqlConnector does not assert when runtime status loading rejects', async () => {
	const catalog = new FakeSqlDriverCatalog(SqlRuntimeStatus.Stable, async () => {
		throw new Error('catalog unavailable');
	});

	await assert.rejects(() => requireRunnableSqlConnector(SqlConnectionKind.Sqlite, catalog), /catalog unavailable/);
	assert.equal(catalog.assertions.length, 0);
});

test('requireRunnableSqlConnector allows Stable and Preview connectors', async () => {
	for (const status of [SqlRuntimeStatus.Stable, SqlRuntimeStatus.Preview]) {
		const catalog = new FakeSqlDriverCatalog(status);
		assert.equal(await requireRunnableSqlConnector(SqlConnectionKind.Sqlite, catalog), SqlRuntimeDriverId.Sqlite);
		assert.deepEqual(catalog.assertions, [{ id: SqlRuntimeDriverId.Sqlite, minimum: SqlRuntimeStatus.Preview }]);
	}
});

test('requireRunnableSqlConnector rejects Planned and Disabled connectors', async () => {
	for (const status of [SqlRuntimeStatus.Planned, SqlRuntimeStatus.Disabled]) {
		const catalog = new FakeSqlDriverCatalog(status);
		await assert.rejects(
			() => requireRunnableSqlConnector(SqlConnectionKind.Sqlite, catalog),
			new RegExp(`Driver sqlite is ${status}`)
		);
		assert.deepEqual(catalog.assertions, [{ id: SqlRuntimeDriverId.Sqlite, minimum: SqlRuntimeStatus.Preview }]);
	}
});
