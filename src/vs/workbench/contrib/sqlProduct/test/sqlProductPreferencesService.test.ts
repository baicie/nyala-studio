import assert from 'node:assert/strict';
import test from 'node:test';

import { Event } from '../../../../base/common/event.js';
import {
	IStorageService,
	StorageScope,
	StorageTarget
} from '../../../../platform/storage/common/storage.js';
import {
	DEFAULT_SQL_PRODUCT_PREFERENCES,
	SerializedSqlProductPreferencesDocument,
	SQL_PRODUCT_PREFERENCES_STORAGE_KEY
} from '../common/sqlProductPreferences.js';
import { SqlProductPreferencesService } from '../common/sqlProductPreferencesService.js';

class MinimalStorageService {
	private readonly values = new Map<string, unknown>();

	readonly onDidChangeTarget = Event.None;
	readonly onWillSaveState = Event.None;

	onDidChangeValue() {
		return Event.None;
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

test('SqlProductPreferencesService starts with defaults', () => {
	const service = new SqlProductPreferencesService(createStorage());

	assert.deepEqual(service.preferences, DEFAULT_SQL_PRODUCT_PREFERENCES);

	service.dispose();
});

test('SqlProductPreferencesService updates one preference', () => {
	const storage = createStorage();
	const service = new SqlProductPreferencesService(storage);

	service.updatePreference('restoreSqlLayoutOnStartup', false);

	assert.equal(service.preferences.restoreSqlLayoutOnStartup, false);

	const stored = storage.getObject<SerializedSqlProductPreferencesDocument>(
		SQL_PRODUCT_PREFERENCES_STORAGE_KEY,
		StorageScope.PROFILE
	);

	assert.ok(stored);
	assert.equal(stored.version, 1);
	assert.equal(stored.preferences.restoreSqlLayoutOnStartup, false);

	service.dispose();
});

test('SqlProductPreferencesService updates multiple preferences', () => {
	const service = new SqlProductPreferencesService(createStorage());

	service.updatePreferences({
		restoreSqlLayoutOnStartup: false,
		resultMaxRows: 500
	});

	assert.equal(service.preferences.restoreSqlLayoutOnStartup, false);
	assert.equal(service.preferences.resultMaxRows, 500);

	service.dispose();
});

test('SqlProductPreferencesService resets preferences', () => {
	const service = new SqlProductPreferencesService(createStorage());

	service.updatePreference('restoreSqlLayoutOnStartup', false);
	service.reset();

	assert.deepEqual(service.preferences, DEFAULT_SQL_PRODUCT_PREFERENCES);

	service.dispose();
});

test('SqlProductPreferencesService fires change events', () => {
	const service = new SqlProductPreferencesService(createStorage());
	let count = 0;

	const disposable = service.onDidChangePreferences(() => {
		count++;
	});

	service.updatePreference('restoreSqlLayoutOnStartup', false);

	assert.equal(count, 1);

	disposable.dispose();
	service.dispose();
});

test('SqlProductPreferencesService loads persisted preferences', () => {
	const storage = createStorage();
	const first = new SqlProductPreferencesService(storage);

	first.updatePreference('resultMaxRows', 500);
	first.dispose();

	const second = new SqlProductPreferencesService(storage);

	assert.equal(second.preferences.resultMaxRows, 500);

	second.dispose();
});
