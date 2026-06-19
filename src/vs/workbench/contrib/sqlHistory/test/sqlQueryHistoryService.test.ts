import assert from 'node:assert/strict';
import test from 'node:test';

import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import {
	IStorageEntry,
	IStorageService,
	IStorageTargetChangeEvent,
	IStorageValueChangeEvent,
	IWillSaveStateEvent,
	StorageScope,
	StorageTarget,
	WillSaveStateReason
} from '../../../../platform/storage/common/storage.js';
import { IAnyWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';
import { IUserDataProfile } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { SqlCellKind } from '../../../services/sql/common/sqlTypes.js';
import { SQL_QUERY_HISTORY_STORAGE_KEY } from '../common/sqlQueryHistory.js';
import { SerializedSqlQueryHistoryDocument } from '../common/sqlQueryHistoryModel.js';
import { SqlQueryHistoryService } from '../common/sqlQueryHistoryService.js';

class InMemoryStorageService implements IStorageService {
	declare readonly _serviceBrand: undefined;

	readonly onDidChangeTarget: Event<IStorageTargetChangeEvent> = Event.None;
	readonly onWillSaveState: Event<IWillSaveStateEvent> = Event.None;

	private readonly values = new Map<string, unknown>();

	onDidChangeValue(
		_scope: StorageScope,
		_key: string | undefined,
		_disposable: DisposableStore
	): Event<IStorageValueChangeEvent> {
		return Event.None;
	}

	get(key: string, _scope: StorageScope, fallbackValue?: string): string | undefined {
		const value = this.values.get(key);
		return typeof value === 'string' ? value : fallbackValue;
	}

	getBoolean(key: string, _scope: StorageScope, fallbackValue?: boolean): boolean | undefined {
		const value = this.values.get(key);

		if (typeof value === 'boolean') {
			return value;
		}

		if (typeof value === 'string') {
			return value === 'true';
		}

		return fallbackValue;
	}

	getNumber(key: string, _scope: StorageScope, fallbackValue?: number): number | undefined {
		const value = this.values.get(key);

		if (typeof value === 'number') {
			return value;
		}

		if (typeof value === 'string') {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : fallbackValue;
		}

		return fallbackValue;
	}

	getObject<T extends object>(key: string, _scope: StorageScope, fallbackValue?: T): T | undefined {
		const value = this.values.get(key);

		if (typeof value === 'string') {
			return JSON.parse(value) as T;
		}

		return value as T ?? fallbackValue;
	}

	store(key: string, value: unknown, _scope: StorageScope, _target: StorageTarget): void {
		if (value === undefined || value === null) {
			this.values.delete(key);
			return;
		}

		this.values.set(key, value);
	}

	storeAll(entries: IStorageEntry[], _external: boolean): void {
		for (const entry of entries) {
			this.store(entry.key, entry.value, entry.scope, entry.target);
		}
	}

	remove(key: string, _scope: StorageScope): void {
		this.values.delete(key);
	}

	keys(_scope: StorageScope, _target: StorageTarget): string[] {
		return [...this.values.keys()];
	}

	log(): void {}

	hasScope(_scope: IAnyWorkspaceIdentifier | IUserDataProfile): boolean {
		return true;
	}

	async switch(_to: IAnyWorkspaceIdentifier | IUserDataProfile, _preserveData: boolean): Promise<void> {}

	isNew(_scope: StorageScope): boolean {
		return false;
	}

	async optimize(_scope: StorageScope): Promise<void> {}

	async flush(_reason?: WillSaveStateReason): Promise<void> {}
}

function createCompletedEvent(sql = 'SELECT 1 AS value;') {
	return {
		editorId: 'editor-1',
		connectionId: 'local',
		sql,
		startedAt: 1000,
		completedAt: 1042,
		result: {
			columns: [{ name: 'value', ordinal: 0 }],
			rows: [[{ kind: SqlCellKind.Integer, value: 1 }]],
			rowCount: 1,
			elapsedMs: 12,
			truncated: false
		}
	};
}

function createFailedEvent() {
	return {
		editorId: 'editor-1',
		connectionId: 'local',
		sql: 'SELECT * FROM missing_table;',
		startedAt: 2000,
		completedAt: 2030,
		error: new Error('no such table: missing_table')
	};
}

test('SqlQueryHistoryService starts empty', () => {
	const service = new SqlQueryHistoryService(new InMemoryStorageService());

	assert.equal(service.entries.length, 0);
	service.dispose();
});

test('SqlQueryHistoryService records completed query', () => {
	const storage = new InMemoryStorageService();
	const service = new SqlQueryHistoryService(storage);

	service.addCompletedQuery(createCompletedEvent());

	assert.equal(service.entries.length, 1);
	assert.equal(service.entries[0].sql, 'SELECT 1 AS value;');
	assert.equal(service.entries[0].rowCount, 1);

	const stored = storage.getObject<SerializedSqlQueryHistoryDocument>(
		SQL_QUERY_HISTORY_STORAGE_KEY,
		StorageScope.PROFILE
	);

	assert.ok(stored);
	assert.equal(stored.version, 1);
	assert.equal(stored.entries.length, 1);

	service.dispose();
});

test('SqlQueryHistoryService records failed query', () => {
	const service = new SqlQueryHistoryService(new InMemoryStorageService());

	service.addFailedQuery(createFailedEvent());

	assert.equal(service.entries.length, 1);
	assert.equal(service.entries[0].errorMessage, 'no such table: missing_table');

	service.dispose();
});

test('SqlQueryHistoryService fires change events', () => {
	const service = new SqlQueryHistoryService(new InMemoryStorageService());
	let changeCount = 0;

	const disposable = service.onDidChangeHistory(() => {
		changeCount++;
	});

	service.addCompletedQuery(createCompletedEvent());

	assert.equal(changeCount, 1);

	disposable.dispose();
	service.dispose();
});

test('SqlQueryHistoryService removes entry', () => {
	const service = new SqlQueryHistoryService(new InMemoryStorageService());

	service.addCompletedQuery(createCompletedEvent());
	const id = service.entries[0].id;

	service.remove(id);

	assert.equal(service.entries.length, 0);

	service.dispose();
});

test('SqlQueryHistoryService clears entries', () => {
	const service = new SqlQueryHistoryService(new InMemoryStorageService());

	service.addCompletedQuery(createCompletedEvent('SELECT 1;'));
	service.addCompletedQuery(createCompletedEvent('SELECT 2;'));

	assert.equal(service.entries.length, 2);

	service.clear();

	assert.equal(service.entries.length, 0);

	service.dispose();
});

test('SqlQueryHistoryService loads persisted entries', () => {
	const storage = new InMemoryStorageService();
	const first = new SqlQueryHistoryService(storage);

	first.addCompletedQuery(createCompletedEvent());
	first.dispose();

	const second = new SqlQueryHistoryService(storage);

	assert.equal(second.entries.length, 1);
	assert.equal(second.entries[0].sql, 'SELECT 1 AS value;');

	second.dispose();
});
