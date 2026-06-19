/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor draft service.
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
	SQL_EDITOR_DRAFT_STORAGE_KEY,
	SQL_EDITOR_MAX_RESTORED_DRAFTS
} from './sqlEditor.js';

export const ISqlEditorDraftService = createDecorator<ISqlEditorDraftService>('sqlEditorDraftService');

export interface SqlEditorDraftEntry {
	readonly id: string;
	readonly connectionId?: string;
	readonly connectionName?: string;
	readonly sql: string;
	readonly updatedAt: number;
}

export interface SerializedSqlEditorDraftDocument {
	readonly version: 1;
	readonly entries: SqlEditorDraftEntry[];
}

export interface ISqlEditorDraftService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeDrafts: Event<readonly SqlEditorDraftEntry[]>;

	readonly entries: readonly SqlEditorDraftEntry[];

	saveDraft(entry: SqlEditorDraftEntry): void;
	removeDraft(id: string): void;
	clear(): void;
}

export class SqlEditorDraftService extends Disposable implements ISqlEditorDraftService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeDrafts = this._register(new Emitter<readonly SqlEditorDraftEntry[]>());
	readonly onDidChangeDrafts = this._onDidChangeDrafts.event;

	private _entries: SqlEditorDraftEntry[];

	constructor(
		@IStorageService private readonly storageService: IStorageService
	) {
		super();

		this._entries = this.load();
	}

	get entries(): readonly SqlEditorDraftEntry[] {
		return this._entries;
	}

	saveDraft(entry: SqlEditorDraftEntry): void {
		const normalized = normalizeDraftEntry(entry);

		if (!normalized) {
			return;
		}

		const next = [
			normalized,
			...this._entries.filter(item => item.id !== normalized.id)
		];

		this.setEntries(normalizeDraftEntries(next));
	}

	removeDraft(id: string): void {
		const normalizedId = id.trim();

		if (!normalizedId) {
			return;
		}

		this.setEntries(this._entries.filter(entry => entry.id !== normalizedId));
	}

	clear(): void {
		this.setEntries([]);
	}

	private load(): SqlEditorDraftEntry[] {
		const raw = this.storageService.getObject<SerializedSqlEditorDraftDocument>(
			SQL_EDITOR_DRAFT_STORAGE_KEY,
			StorageScope.PROFILE,
			undefined
		);

		return deserializeDrafts(raw);
	}

	private setEntries(entries: SqlEditorDraftEntry[]): void {
		this._entries = entries;
		this.persist();
		this._onDidChangeDrafts.fire(this._entries);
	}

	private persist(): void {
		this.storageService.store(
			SQL_EDITOR_DRAFT_STORAGE_KEY,
			JSON.stringify(serializeDrafts(this._entries)),
			StorageScope.PROFILE,
			StorageTarget.USER
		);
	}
}

export function serializeDrafts(entries: readonly SqlEditorDraftEntry[]): SerializedSqlEditorDraftDocument {
	return {
		version: 1,
		entries: normalizeDraftEntries(entries)
	};
}

export function deserializeDrafts(raw: unknown): SqlEditorDraftEntry[] {
	if (!raw || typeof raw !== 'object') {
		return [];
	}

	const document = raw as Partial<SerializedSqlEditorDraftDocument>;

	if (document.version !== 1 || !Array.isArray(document.entries)) {
		return [];
	}

	return normalizeDraftEntries(document.entries);
}

export function normalizeDraftEntries(
	entries: readonly SqlEditorDraftEntry[],
	maxEntries = SQL_EDITOR_MAX_RESTORED_DRAFTS
): SqlEditorDraftEntry[] {
	if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
		throw new Error('maxEntries must be a positive integer');
	}

	return entries
		.filter((entry): entry is SqlEditorDraftEntry => {
			const normalized = normalizeDraftEntry(entry);
			return normalized !== undefined;
		})
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.filter((entry, index, sorted) => {
			const firstIndex = sorted.findIndex(e => e.id === entry.id);
			return firstIndex === index;
		})
		.slice(0, maxEntries);
}

export function normalizeDraftEntry(entry: SqlEditorDraftEntry): SqlEditorDraftEntry | undefined {
	if (!entry || typeof entry !== 'object') {
		return undefined;
	}

	const id = normalizeOptionalString(entry.id);
	const sql = typeof entry.sql === 'string' ? entry.sql : '';

	if (!id || !sql.trim()) {
		return undefined;
	}

	return {
		id,
		connectionId: normalizeOptionalString(entry.connectionId),
		connectionName: normalizeOptionalString(entry.connectionName),
		sql,
		updatedAt: normalizeTimestamp(entry.updatedAt)
	};
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function normalizeTimestamp(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : Date.now();
}
