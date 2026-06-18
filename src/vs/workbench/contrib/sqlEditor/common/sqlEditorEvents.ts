/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor event bridge.
 * Phase 6 Result Panel will subscribe to this service.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SqlQueryResult } from '../../../services/sql/common/sqlTypes.js';

export const ISqlEditorEventService = createDecorator<ISqlEditorEventService>('sqlEditorEventService');

export interface SqlEditorQueryStartedEvent {
	readonly editorId: string;
	readonly connectionId: string;
	readonly sql: string;
	readonly startedAt: number;
}

export interface SqlEditorQueryCompletedEvent extends SqlEditorQueryStartedEvent {
	readonly result: SqlQueryResult;
	readonly completedAt: number;
}

export interface SqlEditorQueryFailedEvent extends SqlEditorQueryStartedEvent {
	readonly error: Error;
	readonly completedAt: number;
}

export interface ISqlEditorEventService {
	readonly _serviceBrand: undefined;

	readonly onDidStartQuery: Event<SqlEditorQueryStartedEvent>;
	readonly onDidCompleteQuery: Event<SqlEditorQueryCompletedEvent>;
	readonly onDidFailQuery: Event<SqlEditorQueryFailedEvent>;

	fireQueryStarted(event: SqlEditorQueryStartedEvent): void;
	fireQueryCompleted(event: SqlEditorQueryCompletedEvent): void;
	fireQueryFailed(event: SqlEditorQueryFailedEvent): void;
}

export class SqlEditorEventService extends Disposable implements ISqlEditorEventService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidStartQuery = this._register(new Emitter<SqlEditorQueryStartedEvent>());
	readonly onDidStartQuery = this._onDidStartQuery.event;

	private readonly _onDidCompleteQuery = this._register(new Emitter<SqlEditorQueryCompletedEvent>());
	readonly onDidCompleteQuery = this._onDidCompleteQuery.event;

	private readonly _onDidFailQuery = this._register(new Emitter<SqlEditorQueryFailedEvent>());
	readonly onDidFailQuery = this._onDidFailQuery.event;

	fireQueryStarted(event: SqlEditorQueryStartedEvent): void {
		this._onDidStartQuery.fire(event);
	}

	fireQueryCompleted(event: SqlEditorQueryCompletedEvent): void {
		this._onDidCompleteQuery.fire(event);
	}

	fireQueryFailed(event: SqlEditorQueryFailedEvent): void {
		this._onDidFailQuery.fire(event);
	}
}
