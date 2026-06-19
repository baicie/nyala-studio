/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Query History service.
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
	SqlEditorQueryCompletedEvent,
	SqlEditorQueryFailedEvent
} from '../../sqlEditor/common/sqlEditorEvents.js';
import { SQL_QUERY_HISTORY_MAX_ENTRIES, SQL_QUERY_HISTORY_STORAGE_KEY } from './sqlQueryHistory.js';
import {
	addHistoryEntry,
	createCompletedQueryHistoryEntry,
	createFailedQueryHistoryEntry,
	deserializeHistory,
	removeHistoryEntry,
	SerializedSqlQueryHistoryDocument,
	serializeHistory,
	SqlQueryHistoryEntry
} from './sqlQueryHistoryModel.js';

export const ISqlQueryHistoryService = createDecorator<ISqlQueryHistoryService>('sqlQueryHistoryService');

export interface ISqlQueryHistoryService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeHistory: Event<readonly SqlQueryHistoryEntry[]>;

	readonly entries: readonly SqlQueryHistoryEntry[];

	addCompletedQuery(event: SqlEditorQueryCompletedEvent): void;
	addFailedQuery(event: SqlEditorQueryFailedEvent): void;
	remove(entryId: string): void;
	clear(): void;
}

export class SqlQueryHistoryService extends Disposable implements ISqlQueryHistoryService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeHistory = this._register(new Emitter<readonly SqlQueryHistoryEntry[]>());
	readonly onDidChangeHistory = this._onDidChangeHistory.event;

	private _entries: SqlQueryHistoryEntry[];

	constructor(
		@IStorageService private readonly storageService: IStorageService
	) {
		super();

		this._entries = this.load();
	}

	get entries(): readonly SqlQueryHistoryEntry[] {
		return this._entries;
	}

	addCompletedQuery(event: SqlEditorQueryCompletedEvent): void {
		const entry = createCompletedQueryHistoryEntry(event);
		this.setEntries(addHistoryEntry(this._entries, entry, SQL_QUERY_HISTORY_MAX_ENTRIES));
	}

	addFailedQuery(event: SqlEditorQueryFailedEvent): void {
		const entry = createFailedQueryHistoryEntry(event);
		this.setEntries(addHistoryEntry(this._entries, entry, SQL_QUERY_HISTORY_MAX_ENTRIES));
	}

	remove(entryId: string): void {
		this.setEntries(removeHistoryEntry(this._entries, entryId));
	}

	clear(): void {
		this.setEntries([]);
	}

	private load(): SqlQueryHistoryEntry[] {
		const raw = this.storageService.getObject<SerializedSqlQueryHistoryDocument>(
			SQL_QUERY_HISTORY_STORAGE_KEY,
			StorageScope.PROFILE,
			undefined
		);

		return deserializeHistory(raw);
	}

	private setEntries(entries: SqlQueryHistoryEntry[]): void {
		this._entries = entries;
		this.persist();
		this._onDidChangeHistory.fire(this._entries);
	}

	private persist(): void {
		this.storageService.store(
			SQL_QUERY_HISTORY_STORAGE_KEY,
			JSON.stringify(serializeHistory(this._entries)),
			StorageScope.PROFILE,
			StorageTarget.USER
		);
	}
}
