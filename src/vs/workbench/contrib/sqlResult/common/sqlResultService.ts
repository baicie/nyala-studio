/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Result service.
 *
 * The service owns two parallel state shapes:
 *   - `state` / `onDidChangeResult` describe the in-flight query
 *     (Idle / Running / Success / Error / Cancelled). The Result View
 *     renders it directly as the live indicator.
 *   - `panelState` / `onDidChangePanelState` describe the history of
 *     terminal queries (Success / Error / Cancelled snapshots, capped
 *     to SQL_RESULT_MAX_SNAPSHOTS). The Result View renders it as a
 *     history list with the latest entry active.
 *
 * Both states are updated together on every terminal event so the
 * live indicator and the history list never disagree about which
 * query just finished.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	SqlEditorQueryCancelledEvent,
	SqlEditorQueryCompletedEvent,
	SqlEditorQueryFailedEvent,
	SqlEditorQueryStartedEvent
} from '../../sqlEditor/common/sqlEditorEvents.js';
import {
	addSqlResultSnapshot,
	createCancelledResultSnapshotFromEvent,
	createCancelledSqlResultState,
	createEmptySqlResultPanelState,
	createErrorResultSnapshotFromEvent,
	createErrorSqlResultState,
	createIdleSqlResultState,
	createRunningSqlResultState,
	createSuccessResultSnapshotFromEvent,
	createSuccessSqlResultState,
	removeSqlResultSnapshot,
	SqlResultPanelState,
	SqlResultSnapshot,
	SqlResultState
} from './sqlResultModel.js';

export const ISqlResultService = createDecorator<ISqlResultService>('sqlResultService');

export interface ISqlResultService {
	readonly _serviceBrand: undefined;

	readonly state: SqlResultState;
	readonly panelState: SqlResultPanelState;

	readonly onDidChangeResult: Event<SqlResultState>;
	readonly onDidChangePanelState: Event<SqlResultPanelState>;

	setRunning(event: SqlEditorQueryStartedEvent): void;
	setSuccess(event: SqlEditorQueryCompletedEvent): void;
	setError(event: SqlEditorQueryFailedEvent): void;
	setCancelled(event: SqlEditorQueryCancelledEvent): void;
	removeSnapshot(snapshotId: string): void;
	clear(): void;
}

export class SqlResultService extends Disposable implements ISqlResultService {
	declare readonly _serviceBrand: undefined;

	private _state: SqlResultState = createIdleSqlResultState();
	private _panelState: SqlResultPanelState = createEmptySqlResultPanelState();

	private readonly _onDidChangeResult = this._register(new Emitter<SqlResultState>());
	readonly onDidChangeResult = this._onDidChangeResult.event;

	private readonly _onDidChangePanelState = this._register(new Emitter<SqlResultPanelState>());
	readonly onDidChangePanelState = this._onDidChangePanelState.event;

	get state(): SqlResultState {
		return this._state;
	}

	get panelState(): SqlResultPanelState {
		return this._panelState;
	}

	setRunning(event: SqlEditorQueryStartedEvent): void {
		this.setState(createRunningSqlResultState(event));
	}

	setSuccess(event: SqlEditorQueryCompletedEvent): void {
		this.setState(createSuccessSqlResultState(event));
		this.addSnapshot(createSuccessResultSnapshotFromEvent(event));
	}

	setError(event: SqlEditorQueryFailedEvent): void {
		this.setState(createErrorSqlResultState(event));
		this.addSnapshot(createErrorResultSnapshotFromEvent(event));
	}

	setCancelled(event: SqlEditorQueryCancelledEvent): void {
		this.setState(createCancelledSqlResultState(event));
		this.addSnapshot(createCancelledResultSnapshotFromEvent(event));
	}

	removeSnapshot(snapshotId: string): void {
		this.setPanelState(removeSqlResultSnapshot(this._panelState, snapshotId));
	}

	clear(): void {
		this.setState(createIdleSqlResultState());
		this.setPanelState(createEmptySqlResultPanelState());
	}

	private addSnapshot(snapshot: SqlResultSnapshot): void {
		this.setPanelState(addSqlResultSnapshot(this._panelState, snapshot));
	}

	private setState(state: SqlResultState): void {
		this._state = state;
		this._onDidChangeResult.fire(state);
	}

	private setPanelState(state: SqlResultPanelState): void {
		this._panelState = state;
		this._onDidChangePanelState.fire(state);
	}
}