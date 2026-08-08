import assert from 'node:assert/strict';
import test from 'node:test';

import { IDisposable } from '../../../../base/common/lifecycle.js';
import { SqlConnectionKind } from '../../../services/sql/common/sqlTypes.js';
import {
	ISqlDriverCatalogService,
	SqlRuntimeDriverEntry,
	SqlRuntimeDriverId,
	SqlRuntimeStatus
} from '../../../services/sql/common/sqlDriverCatalog.js';
import {
	formatSqlConnectionOperationError,
	runSqlConnectionFormOperation
} from '../common/sqlConnectionFormOperation.js';
import { createDefaultSqlConnectionFormState } from '../common/sqlConnectionFormModel.js';

class RecordingCatalog implements ISqlDriverCatalogService {
	readonly _serviceBrand = undefined;
	readonly assertions: Array<{ id: SqlRuntimeDriverId; minimum: SqlRuntimeStatus }> = [];
	loadCount = 0;
	error: Error | undefined;

	constructor(
		private readonly id: SqlRuntimeDriverId,
		private readonly status: SqlRuntimeStatus
	) {}

	async getRuntimeStatus(): Promise<SqlRuntimeDriverEntry[]> {
		this.loadCount++;
		if (this.error) {
			throw this.error;
		}
		return [this.entry()];
	}

	refreshRuntimeStatus(): Promise<SqlRuntimeDriverEntry[]> {
		return this.getRuntimeStatus();
	}

	getCachedRuntimeStatus(): SqlRuntimeDriverEntry[] {
		return [this.entry()];
	}

	findRuntimeStatus(id: SqlRuntimeDriverId): SqlRuntimeDriverEntry | undefined {
		return id === this.id ? this.entry() : undefined;
	}

	isDriverRunnable(id: SqlRuntimeDriverId): boolean {
		return id === this.id && (this.status === SqlRuntimeStatus.Stable || this.status === SqlRuntimeStatus.Preview);
	}

	assertAtLeast(id: SqlRuntimeDriverId, minimum: SqlRuntimeStatus): void {
		this.assertions.push({ id, minimum });
		if (!this.isDriverRunnable(id)) {
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
			id: this.id,
			displayName: this.id,
			status: this.status,
			summary: '',
			notes: []
		};
	}
}

const runnableCases = [
	[SqlConnectionKind.Sqlite, SqlRuntimeDriverId.Sqlite, SqlRuntimeStatus.Stable],
	[SqlConnectionKind.MySql, SqlRuntimeDriverId.MySql, SqlRuntimeStatus.Preview],
	[SqlConnectionKind.PostgreSql, SqlRuntimeDriverId.Postgres, SqlRuntimeStatus.Preview]
] as const;

for (const [kind, driverId, status] of runnableCases) {
	test(`guarded form operation maps and allows ${kind} ${status}`, async () => {
		const catalog = new RecordingCatalog(driverId, status);
		let operationCount = 0;
		let cleanupCount = 0;
		const errors: unknown[] = [];

		await runSqlConnectionFormOperation({
			state: createDefaultSqlConnectionFormState(kind),
			catalog,
			loadCatalog: async () => {
				await catalog.getRuntimeStatus();
			},
			operation: async state => {
				operationCount++;
				assert.equal(state.kind, kind);
				assert.deepEqual(catalog.assertions, [{ id: driverId, minimum: SqlRuntimeStatus.Preview }]);
			},
			onError: error => errors.push(error),
			clearSecret: () => cleanupCount++
		});

		assert.equal(operationCount, 1);
		assert.equal(cleanupCount, 1);
		assert.deepEqual(errors, []);
		assert.deepEqual(catalog.assertions, [{ id: driverId, minimum: SqlRuntimeStatus.Preview }]);
	});
}

for (const [status, kind, driverId] of [
	[SqlRuntimeStatus.Planned, SqlConnectionKind.PostgreSql, SqlRuntimeDriverId.Postgres],
	[SqlRuntimeStatus.Disabled, SqlConnectionKind.MySql, SqlRuntimeDriverId.MySql]
] as const) {
	test(`guarded form operation rejects ${status} connectors and clears once`, async () => {
		const catalog = new RecordingCatalog(driverId, status);
		let operationCount = 0;
		let cleanupCount = 0;
		const errors: unknown[] = [];

		await runSqlConnectionFormOperation({
			state: createDefaultSqlConnectionFormState(kind),
			catalog,
			loadCatalog: async () => {
				await catalog.getRuntimeStatus();
			},
			operation: async () => {
				operationCount++;
			},
			onError: error => errors.push(error),
			clearSecret: () => cleanupCount++
		});

		assert.equal(operationCount, 0);
		assert.equal(cleanupCount, 1);
		assert.equal(errors.length, 1);
		assert.match(String(errors[0]), new RegExp(status));
		assert.deepEqual(catalog.assertions, [{ id: driverId, minimum: SqlRuntimeStatus.Preview }]);
	});
}

test('guarded form operation forwards catalog rejection and clears once', async () => {
	const catalog = new RecordingCatalog(SqlRuntimeDriverId.Sqlite, SqlRuntimeStatus.Stable);
	catalog.error = new Error('catalog unavailable');
	let operationCount = 0;
	let cleanupCount = 0;
	const errors: unknown[] = [];

	await runSqlConnectionFormOperation({
		state: createDefaultSqlConnectionFormState(SqlConnectionKind.Sqlite),
		catalog,
		loadCatalog: async () => {
			await catalog.getRuntimeStatus();
		},
		operation: async () => {
			operationCount++;
		},
		onError: error => errors.push(error),
		clearSecret: () => cleanupCount++
	});

	assert.equal(operationCount, 0);
	assert.equal(cleanupCount, 1);
	assert.equal(errors.length, 1);
	assert.match(String(errors[0]), /catalog unavailable/);
	assert.deepEqual(catalog.assertions, []);
});

test('guarded form operation forwards operation rejection and clears once', async () => {
	const catalog = new RecordingCatalog(SqlRuntimeDriverId.MySql, SqlRuntimeStatus.Preview);
	let cleanupCount = 0;
	const errors: unknown[] = [];

	await runSqlConnectionFormOperation({
		state: createDefaultSqlConnectionFormState(SqlConnectionKind.MySql),
		catalog,
		loadCatalog: async () => {
			await catalog.getRuntimeStatus();
		},
		operation: async () => {
			throw new Error('operation failed');
		},
		onError: error => errors.push(error),
		clearSecret: () => cleanupCount++
	});

	assert.equal(cleanupCount, 1);
	assert.equal(errors.length, 1);
	assert.match(String(errors[0]), /operation failed/);
});

test('connection form error formatting preserves structured error codes', () => {
	assert.equal(
		formatSqlConnectionOperationError({ code: 'connection_failed', message: 'Authentication rejected' }),
		'connection_failed: Authentication rejected'
	);
});
