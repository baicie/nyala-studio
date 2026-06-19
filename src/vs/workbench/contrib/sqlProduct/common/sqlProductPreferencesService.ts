/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product preferences service.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	IStorageService,
	StorageScope,
	StorageTarget
} from '../../../../platform/storage/common/storage.js';
import {
	deserializeSqlProductPreferences,
	resetSqlProductPreferences,
	serializeSqlProductPreferences,
	SerializedSqlProductPreferencesDocument,
	SqlProductPreferenceKey,
	SqlProductPreferences,
	SQL_PRODUCT_PREFERENCES_STORAGE_KEY,
	updateSqlProductPreference
} from './sqlProductPreferences.js';

export const ISqlProductPreferencesService = createDecorator<ISqlProductPreferencesService>('sqlProductPreferencesService');

export interface ISqlProductPreferencesService {
	readonly _serviceBrand: undefined;

	readonly onDidChangePreferences: Event<SqlProductPreferences>;

	readonly preferences: SqlProductPreferences;

	updatePreference<K extends SqlProductPreferenceKey>(key: K, value: SqlProductPreferences[K]): void;
	updatePreferences(value: Partial<SqlProductPreferences>): void;
	reset(): void;
}

export class SqlProductPreferencesService extends Disposable implements ISqlProductPreferencesService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangePreferences = this._register(new Emitter<SqlProductPreferences>());
	readonly onDidChangePreferences = this._onDidChangePreferences.event;

	private _preferences: SqlProductPreferences;

	constructor(
		@IStorageService private readonly storageService: IStorageService
	) {
		super();

		this._preferences = this.load();
	}

	get preferences(): SqlProductPreferences {
		return this._preferences;
	}

	updatePreference<K extends SqlProductPreferenceKey>(key: K, value: SqlProductPreferences[K]): void {
		this.setPreferences(updateSqlProductPreference(this._preferences, key, value));
	}

	updatePreferences(value: Partial<SqlProductPreferences>): void {
		this.setPreferences({
			...this._preferences,
			...value
		});
	}

	reset(): void {
		this.setPreferences(resetSqlProductPreferences());
	}

	private load(): SqlProductPreferences {
		const raw = this.storageService.getObject<SerializedSqlProductPreferencesDocument>(
			SQL_PRODUCT_PREFERENCES_STORAGE_KEY,
			StorageScope.PROFILE,
			undefined
		);

		return deserializeSqlProductPreferences(raw);
	}

	private setPreferences(preferences: SqlProductPreferences): void {
		this._preferences = deserializeSqlProductPreferences(serializeSqlProductPreferences(preferences));
		this.persist();
		this._onDidChangePreferences.fire(this._preferences);
	}

	private persist(): void {
		this.storageService.store(
			SQL_PRODUCT_PREFERENCES_STORAGE_KEY,
			JSON.stringify(serializeSqlProductPreferences(this._preferences)),
			StorageScope.PROFILE,
			StorageTarget.USER
		);
	}
}
