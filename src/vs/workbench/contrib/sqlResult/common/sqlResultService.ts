/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Result service.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	SqlEditorQueryCompletedEvent,
	SqlEditorQueryFailedEvent,
	SqlEditorQueryStartedEvent
} from '../../sqlEditor/common/sqlEditorEvents.js';
import {
	createErrorSqlResultState,
	createIdleSqlResultState,
	createRunningSqlResultState,
	createSuccessSqlResultState,
	SqlResultState
} from './sqlResultModel.js';

export const ISqlResultService = createDecorator<ISqlResultService>('sqlResultService');

export interface ISqlResultService {
	readonly _serviceBrand: undefined;

	readonly state: SqlResultState;
	readonly onDidChangeResult: Event<SqlResultState>;

	setRunning(event: SqlEditorQueryStartedEvent): void;
	setSuccess(event: SqlEditorQueryCompletedEvent): void;
	setError(event: SqlEditorQueryFailedEvent): void;
	clear(): void;
}

export class SqlResultService extends Disposable implements ISqlResultService {
	declare readonly _serviceBrand: undefined;

	private _state: SqlResultState = createIdleSqlResultState();

	private readonly _onDidChangeResult = this._register(new Emitter<SqlResultState>());
	readonly onDidChangeResult = this._onDidChangeResult.event;

	get state(): SqlResultState {
		return this._state;
	}

	setRunning(event: SqlEditorQueryStartedEvent): void {
		this.setState(createRunningSqlResultState(event));
	}

	setSuccess(event: SqlEditorQueryCompletedEvent): void {
		this.setState(createSuccessSqlResultState(event));
	}

	setError(event: SqlEditorQueryFailedEvent): void {
		this.setState(createErrorSqlResultState(event));
	}

	clear(): void {
		this.setState(createIdleSqlResultState());
	}

	private setState(state: SqlResultState): void {
		this._state = state;
		this._onDidChangeResult.fire(state);
	}
}
