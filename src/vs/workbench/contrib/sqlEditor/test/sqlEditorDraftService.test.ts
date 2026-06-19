import assert from 'node:assert/strict';
import test from 'node:test';

import { Event } from '../../../../base/common/event.js';
import {
	IStorageService,
	StorageScope,
	StorageTarget
} from '../../../../platform/storage/common/storage.js';
import {
	deserializeDrafts,
	normalizeDraftEntries,
	serializeDrafts,
	SerializedSqlEditorDraftDocument,
	SqlEditorDraftEntry,
	SqlEditorDraftService
} from '../common/sqlEditorDraftService.js';
import { SQL_EDITOR_DRAFT_STORAGE_KEY } from '../common/sqlEditor.js';

class MinimalStorageService {
	private readonly values = new Map<string, unknown>();

	readonly onDidChangeTarget = Event.None;
	readonly onWillSaveState = Event.None;

	onDidChangeValue() {
		return Event.None;
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
}

function createStorage(): IStorageService {
	return new MinimalStorageService() as unknown as IStorageService;
}

function createDraft(id: string, updatedAt: number): SqlEditorDraftEntry {
	return {
		id,
		connectionId: 'local',
		connectionName: 'Local SQLite',
		sql: `SELECT ${updatedAt};`,
		updatedAt
	};
}

test('serializeDrafts and deserializeDrafts round trip', () => {
	const draft = createDraft('query-1', 1000);
	const document = serializeDrafts([draft]);

	assert.equal(document.version, 1);

	const entries = deserializeDrafts(document);

	assert.equal(entries.length, 1);
	assert.equal(entries[0].id, 'query-1');
	assert.equal(entries[0].sql, 'SELECT 1000;');
});

test('deserializeDrafts rejects invalid document', () => {
	assert.deepEqual(deserializeDrafts(undefined), []);
	assert.deepEqual(deserializeDrafts({ version: 2, entries: [] }), []);
	assert.deepEqual(deserializeDrafts({ version: 1, entries: 'bad' }), []);
});

test('normalizeDraftEntries removes duplicate IDs keeping the latest', () => {
	const entries = normalizeDraftEntries(
		[
			createDraft('query-2', 3000),
			createDraft('query-1', 1000),
			createDraft('query-1', 4000)
		],
		10
	);

	assert.equal(entries.length, 2);
	assert.equal(entries[0].id, 'query-1');
	assert.equal(entries[0].updatedAt, 4000);
	assert.equal(entries[1].id, 'query-2');
});

test('normalizeDraftEntries sorts by updatedAt desc and caps entries', () => {
	const entries = normalizeDraftEntries(
		[
			createDraft('query-3', 2000),
			createDraft('query-1', 1000),
			createDraft('query-2', 3000)
		],
		2
	);

	assert.deepEqual(entries.map(entry => entry.id), ['query-2', 'query-3']);
});

test('SqlEditorDraftService starts empty', () => {
	const service = new SqlEditorDraftService(createStorage());

	assert.equal(service.entries.length, 0);

	service.dispose();
});

test('SqlEditorDraftService saves draft', () => {
	const storage = createStorage();
	const service = new SqlEditorDraftService(storage);

	service.saveDraft(createDraft('query-1', 1000));

	assert.equal(service.entries.length, 1);
	assert.equal(service.entries[0].id, 'query-1');

	const stored = storage.getObject<SerializedSqlEditorDraftDocument>(
		SQL_EDITOR_DRAFT_STORAGE_KEY,
		StorageScope.PROFILE
	);

	assert.ok(stored);
	assert.equal(stored.version, 1);
	assert.equal(stored.entries.length, 1);

	service.dispose();
});

test('SqlEditorDraftService updates existing draft', () => {
	const service = new SqlEditorDraftService(createStorage());

	service.saveDraft(createDraft('query-1', 1000));
	service.saveDraft({
		...createDraft('query-1', 2000),
		sql: 'SELECT 2;'
	});

	assert.equal(service.entries.length, 1);
	assert.equal(service.entries[0].sql, 'SELECT 2;');

	service.dispose();
});

test('SqlEditorDraftService removes draft', () => {
	const service = new SqlEditorDraftService(createStorage());

	service.saveDraft(createDraft('query-1', 1000));
	service.removeDraft('query-1');

	assert.equal(service.entries.length, 0);

	service.dispose();
});

test('SqlEditorDraftService clears drafts', () => {
	const service = new SqlEditorDraftService(createStorage());

	service.saveDraft(createDraft('query-1', 1000));
	service.saveDraft(createDraft('query-2', 2000));

	assert.equal(service.entries.length, 2);

	service.clear();

	assert.equal(service.entries.length, 0);

	service.dispose();
});

test('SqlEditorDraftService fires change event', () => {
	const service = new SqlEditorDraftService(createStorage());
	let count = 0;

	const disposable = service.onDidChangeDrafts(() => {
		count++;
	});

	service.saveDraft(createDraft('query-1', 1000));

	assert.equal(count, 1);

	disposable.dispose();
	service.dispose();
});

test('SqlEditorDraftService loads persisted draft', () => {
	const storage = createStorage();
	const first = new SqlEditorDraftService(storage);

	first.saveDraft(createDraft('query-1', 1000));
	first.dispose();

	const second = new SqlEditorDraftService(storage);

	assert.equal(second.entries.length, 1);
	assert.equal(second.entries[0].id, 'query-1');

	second.dispose();
});
