/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor execution controller.
 *
 * Phase 03 SQL Editor execution loop:
 *   Idle -> Running -> Succeeded | Failed | Cancelled -> Idle
 *
 * The controller is a pure model: it never imports UI, never writes to the
 * result panel, and never pushes history entries directly. Callers receive
 * `SqlEditorQueryStartedEvent` / `CompletedEvent` / `FailedEvent` /
 * `CancelledEvent` objects as the return value of `execute` and `cancel`,
 * and decide how to surface them (for example through ISqlEditorEventService).
 *
 * MVP does not run more than one query per editor at a time. Switching to
 * concurrent execution would require reworking the cancel handshake and the
 * state machine; defer until the SQL MVP loop is complete.
 *--------------------------------------------------------------------------------------------*/

import { SqlCancelQueryResult, SqlQueryResult } from '../../../services/sql/common/sqlTypes.js';
import { ISqlQueryService } from '../../../services/sql/common/sqlQuery.js';
import {
	createExecutePayload,
	findSqlStatementAtOffset,
	SqlEditorExecutionSource
} from './sqlEditorModel.js';

export const enum SqlEditorRunningState {
	Idle = 'idle',
	Running = 'running'
}

export interface SqlEditorExecutionControllerState {
	readonly state: SqlEditorRunningState;
	readonly editorId: string;
	readonly connectionId?: string;
	readonly startedAt?: number;
	readonly sql?: string;
	readonly source?: SqlEditorExecutionSource;
	readonly canCancel: boolean;
}

export interface SqlEditorExecutionInput {
	readonly editorId: string;
	readonly connectionId?: string;
	readonly fullSql: string;
	readonly selectedSql?: string;
	readonly cursorOffset?: number;
	readonly source: SqlEditorExecutionSource;
	readonly limit?: number;
	readonly canCancel?: boolean;
}

export interface SqlEditorQueryStartedEvent {
	readonly editorId: string;
	readonly connectionId: string;
	readonly sql: string;
	readonly source: SqlEditorExecutionSource;
	readonly startedAt: number;
}

export interface SqlEditorQueryCompletedEvent extends SqlEditorQueryStartedEvent {
	readonly completedAt: number;
	readonly result: SqlQueryResult;
}

export interface SqlEditorQueryFailedEvent extends SqlEditorQueryStartedEvent {
	readonly completedAt: number;
	readonly error: Error;
}

export interface SqlEditorQueryCancelledEvent extends SqlEditorQueryStartedEvent {
	readonly completedAt: number;
	readonly message: string;
}

/**
 * Aggregate of whatever `execute` produced. `started` is always present;
 * exactly one of `completed` or `failed` is returned alongside it.
 */
export interface SqlEditorExecutionResult {
	readonly started: SqlEditorQueryStartedEvent;
	readonly completed?: SqlEditorQueryCompletedEvent;
	readonly failed?: SqlEditorQueryFailedEvent;
}

export class SqlEditorExecutionController {
	private currentState: SqlEditorExecutionControllerState;

	constructor(
		private readonly queryService: ISqlQueryService,
		private readonly now: () => number = () => Date.now()
	) {
		this.currentState = {
			state: SqlEditorRunningState.Idle,
			editorId: '',
			canCancel: false
		};
	}

	get state(): SqlEditorExecutionControllerState {
		return this.currentState;
	}

	async execute(input: SqlEditorExecutionInput): Promise<SqlEditorExecutionResult> {
		if (this.currentState.state === SqlEditorRunningState.Running) {
			throw new Error('A SQL query is already running in this editor.');
		}

		const sql = resolveSqlToExecute(input);
		const payload = createExecutePayload(input.connectionId, sql, input.source);
		const startedAt = this.now();
		const canCancel = input.canCancel !== false;
		const started: SqlEditorQueryStartedEvent = {
			editorId: input.editorId,
			connectionId: payload.connectionId,
			sql: payload.sql,
			source: payload.source,
			startedAt
		};

		this.currentState = {
			state: SqlEditorRunningState.Running,
			editorId: input.editorId,
			connectionId: payload.connectionId,
			startedAt,
			sql: payload.sql,
			source: payload.source,
			canCancel
		};

		try {
			const result = await this.queryService.executeQuery({
				connectionId: payload.connectionId,
				sql: payload.sql,
				limit: input.limit
			});
			const completed: SqlEditorQueryCompletedEvent = {
				...started,
				completedAt: this.now(),
				result
			};
			this.reset();
			return { started, completed };
		} catch (error) {
			const failed: SqlEditorQueryFailedEvent = {
				...started,
				completedAt: this.now(),
				error: normalizeError(error)
			};
			this.reset();
			return { started, failed };
		}
	}

	async cancel(queryId?: string): Promise<SqlEditorQueryCancelledEvent | undefined> {
		const running = this.currentState;

		if (
			running.state !== SqlEditorRunningState.Running ||
			!running.connectionId ||
			!running.sql ||
			!running.source ||
			!running.startedAt
		) {
			return undefined;
		}

		if (!running.canCancel) {
			return undefined;
		}

		const result: SqlCancelQueryResult = await this.queryService.cancelQuery({
			connectionId: running.connectionId,
			queryId
		});

		if (!result.cancelled) {
			return undefined;
		}

		const cancelled: SqlEditorQueryCancelledEvent = {
			editorId: running.editorId,
			connectionId: running.connectionId,
			sql: running.sql,
			source: running.source,
			startedAt: running.startedAt,
			completedAt: this.now(),
			message: result.message
		};

		this.reset();
		return cancelled;
	}

	private reset(): void {
		this.currentState = {
			state: SqlEditorRunningState.Idle,
			editorId: '',
			canCancel: false
		};
	}
}

/**
 * Pick the SQL that should be executed for the requested source. Pure
 * function so the editor pane can preview the same SQL before the user
 * actually runs it.
 */
export function resolveSqlToExecute(input: SqlEditorExecutionInput): string {
	switch (input.source) {
		case SqlEditorExecutionSource.All:
			return input.fullSql;
		case SqlEditorExecutionSource.Selection:
			return input.selectedSql ?? '';
		case SqlEditorExecutionSource.Statement:
			return findSqlStatementAtOffset(input.fullSql, input.cursorOffset ?? 0).sql;
		default:
			return assertNever(input.source);
	}
}

function normalizeError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}
	return new Error(String(error));
}

function assertNever(value: never): never {
	throw new Error(`Unsupported SQL editor execution source: ${String(value)}`);
}