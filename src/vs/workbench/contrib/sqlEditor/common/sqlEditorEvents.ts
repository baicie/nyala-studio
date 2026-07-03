/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor event bridge.
 *
 * Phase 03 SQL Editor execution loop exposes four lifecycle events through
 * `ISqlEditorEventService`: Started / Completed / Failed / Cancelled. The
 * controller emits them by returning event objects from `execute` and
 * `cancel`; the editor pane or workbench contribution then forwards them
 * through the service so the Result Panel, History, and Status Bar can
 * subscribe in a single place.
 *
 * Each event carries `SqlEditorExecutionSource` so downstream consumers
 * can disambiguate Run All / Run Selection / Run Statement / Explain Plan.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SqlQueryResult } from '../../../services/sql/common/sqlTypes.js';
import { SqlEditorExecutionSource } from './sqlEditorModel.js';

export const ISqlEditorEventService = createDecorator<ISqlEditorEventService>('sqlEditorEventService');

export interface SqlEditorQueryStartedEvent {
	readonly editorId: string;
	readonly connectionId: string;
	readonly sql: string;
	readonly source: SqlEditorExecutionSource;
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

export interface SqlEditorQueryCancelledEvent extends SqlEditorQueryStartedEvent {
	readonly message: string;
	readonly completedAt: number;
}

export type SqlEditorExecutionEvent =
	| SqlEditorQueryStartedEvent
	| SqlEditorQueryCompletedEvent
	| SqlEditorQueryFailedEvent
	| SqlEditorQueryCancelledEvent;

export interface ISqlEditorEventService {
	readonly _serviceBrand: undefined;

	readonly onDidStartQuery: Event<SqlEditorQueryStartedEvent>;
	readonly onDidCompleteQuery: Event<SqlEditorQueryCompletedEvent>;
	readonly onDidFailQuery: Event<SqlEditorQueryFailedEvent>;
	readonly onDidCancelQuery: Event<SqlEditorQueryCancelledEvent>;

	fireQueryStarted(event: SqlEditorQueryStartedEvent): void;
	fireQueryCompleted(event: SqlEditorQueryCompletedEvent): void;
	fireQueryFailed(event: SqlEditorQueryFailedEvent): void;
	fireQueryCancelled(event: SqlEditorQueryCancelledEvent): void;
}

export class SqlEditorEventService extends Disposable implements ISqlEditorEventService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidStartQuery = this._register(new Emitter<SqlEditorQueryStartedEvent>());
	readonly onDidStartQuery = this._onDidStartQuery.event;

	private readonly _onDidCompleteQuery = this._register(new Emitter<SqlEditorQueryCompletedEvent>());
	readonly onDidCompleteQuery = this._onDidCompleteQuery.event;

	private readonly _onDidFailQuery = this._register(new Emitter<SqlEditorQueryFailedEvent>());
	readonly onDidFailQuery = this._onDidFailQuery.event;

	private readonly _onDidCancelQuery = this._register(new Emitter<SqlEditorQueryCancelledEvent>());
	readonly onDidCancelQuery = this._onDidCancelQuery.event;

	fireQueryStarted(event: SqlEditorQueryStartedEvent): void {
		this._onDidStartQuery.fire(event);
	}

	fireQueryCompleted(event: SqlEditorQueryCompletedEvent): void {
		this._onDidCompleteQuery.fire(event);
	}

	fireQueryFailed(event: SqlEditorQueryFailedEvent): void {
		this._onDidFailQuery.fire(event);
	}

	fireQueryCancelled(event: SqlEditorQueryCancelledEvent): void {
		this._onDidCancelQuery.fire(event);
	}
}