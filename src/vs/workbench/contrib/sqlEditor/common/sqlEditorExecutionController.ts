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
 *
 * Cancellation race:
 *   `cancel` is allowed to resolve before the underlying `executeQuery`
 *   promise settles (for example SQLite returns immediately while the
 *   Tokio task is still draining). When that happens the original
 *   `execute()` must not surface a stale Completed/Failed event, and it
 *   must not disturb the state of a later `execute()` that the user
 *   started in the meantime. Each `execute()` runs under a `runId`;
 *   `cancel` stores the cancelled event under that id, and the
 *   `execute()` awaiter checks the map before reporting a terminal
 *   event so only the cancelled event reaches the caller.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { ISqlQueryService } from '../../../services/sql/common/sqlQuery.js';
import { SqlCancelQueryResult } from '../../../services/sql/common/sqlTypes.js';
import {
	createExecutePayload,
	findSqlStatementAtOffset,
	splitSqlStatements,
	SqlEditorExecutionSource
} from './sqlEditorModel.js';
import {
	SqlEditorQueryCancelledEvent,
	SqlEditorQueryCompletedEvent,
	SqlEditorQueryFailedEvent,
	SqlEditorQueryStartedEvent,
	SqlEditorStatementResult
} from './sqlEditorEvents.js';

export const enum SqlEditorRunningState {
	Idle = 'idle',
	Running = 'running'
}

export interface SqlEditorExecutionControllerState {
	readonly state: SqlEditorRunningState;
	readonly editorId: string;
	readonly executionId?: string;
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

/**
 * Aggregate of whatever `execute` produced. `started` is always present;
 * exactly one of `completed` / `failed` / `cancelled` is returned alongside it.
 */
export interface SqlEditorExecutionResult {
	readonly started: SqlEditorQueryStartedEvent;
	readonly completed?: SqlEditorQueryCompletedEvent;
	readonly failed?: SqlEditorQueryFailedEvent;
	readonly cancelled?: SqlEditorQueryCancelledEvent;
}

interface ActiveSqlEditorRun {
	readonly id: number;
	readonly executionId: string;
	readonly started: SqlEditorQueryStartedEvent;
	readonly canCancel: boolean;
	readonly statementResults: SqlEditorStatementResult[];
}

export class SqlEditorExecutionController {
	private currentState: SqlEditorExecutionControllerState = createIdleState();
	private activeRun: ActiveSqlEditorRun | undefined;
	private nextRunId = 1;

	/**
	 * Cancelled events are stashed here so the original `execute()` promise
	 * can still resolve as cancelled even when the underlying
	 * `queryService.executeQuery()` settles after `cancel()` returned.
	 * Keyed by run id so older runs do not leak.
	 */
	private readonly cancelledRuns = new Map<number, SqlEditorQueryCancelledEvent>();

	constructor(
		private readonly queryService: ISqlQueryService,
		private readonly now: () => number = () => Date.now()
	) {}

	get state(): SqlEditorExecutionControllerState {
		return this.currentState;
	}

	async execute(input: SqlEditorExecutionInput): Promise<SqlEditorExecutionResult> {
		if (this.activeRun) {
			throw new Error('A SQL query is already running in this editor.');
		}

		const sql = resolveSqlToExecute(input);
		const payload = createExecutePayload(input.connectionId, sql, input.source);
		const startedAt = this.now();
		const runId = this.nextRunId++;
		const executionId = createSqlEditorExecutionId();

		const started: SqlEditorQueryStartedEvent = {
			editorId: input.editorId,
			connectionId: payload.connectionId,
			sql: payload.sql,
			source: payload.source,
			startedAt,
			executionId
		};

		const run: ActiveSqlEditorRun = {
			id: runId,
			executionId,
			started,
			canCancel: input.canCancel !== false,
			statementResults: []
		};

		this.activeRun = run;
		this.currentState = {
			state: SqlEditorRunningState.Running,
			editorId: input.editorId,
			executionId,
			connectionId: payload.connectionId,
			startedAt,
			sql: payload.sql,
			source: payload.source,
			canCancel: run.canCancel
		};

		try {
			const statements =
				input.source === SqlEditorExecutionSource.Statement
					? [payload.sql]
					: splitSqlStatements(payload.sql).map(statement => statement.sql);
			const statementCount = statements.length;

			for (const [statementIndex, statement] of statements.entries()) {
				const statementStartedAt = statementIndex === 0 ? startedAt : this.now();

				try {
					const result = await this.queryService.executeQuery({
						connectionId: payload.connectionId,
						sql: statement,
						limit: input.limit
					});

					const cancelled = this.takeCancelledRun(run.id);
					if (cancelled) {
						return { started, cancelled };
					}

					run.statementResults.push({
						resultId: createSqlEditorStatementResultId(executionId, statementIndex),
						executionId,
						statementIndex,
						statementCount,
						sql: statement,
						startedAt: statementStartedAt,
						completedAt: this.now(),
						result
					});
				} catch (error) {
					const cancelled = this.takeCancelledRun(run.id);
					if (cancelled) {
						return { started, cancelled };
					}

					const failedStatement = {
						resultId: createSqlEditorStatementResultId(executionId, statementIndex),
						executionId,
						statementIndex,
						statementCount,
						sql: statement,
						startedAt: statementStartedAt,
						completedAt: this.now(),
						error: normalizeError(error)
					};
					const failed: SqlEditorQueryFailedEvent = {
						...started,
						completedAt: failedStatement.completedAt,
						error: failedStatement.error,
						statementResults: [...run.statementResults],
						failedStatement
					};

					this.finishRun(run.id);
					return { started, failed };
				}
			}

			const finalStatement = run.statementResults[run.statementResults.length - 1];
			if (!finalStatement) {
				throw new Error('No SQL statement to execute.');
			}

			const completed: SqlEditorQueryCompletedEvent = {
				...started,
				completedAt: finalStatement.completedAt,
				result: finalStatement.result,
				statementResults: [...run.statementResults]
			};

			this.finishRun(run.id);
			return { started, completed };
		} catch (error) {
			const cancelled = this.takeCancelledRun(run.id);
			if (cancelled) {
				return { started, cancelled };
			}

			const failed: SqlEditorQueryFailedEvent = {
				...started,
				completedAt: this.now(),
				error: normalizeError(error),
				statementResults: [...run.statementResults]
			};

			this.finishRun(run.id);
			return { started, failed };
		}
	}

	async cancel(queryId?: string): Promise<SqlEditorQueryCancelledEvent | undefined> {
		const run = this.activeRun;
		const running = this.currentState;

		if (
			!run ||
			!running.connectionId ||
			!running.sql ||
			running.source === undefined ||
			running.startedAt === undefined
		) {
			return undefined;
		}

		if (!run.canCancel) {
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
			editorId: run.started.editorId,
			connectionId: run.started.connectionId,
			sql: run.started.sql,
			source: run.started.source,
			startedAt: run.started.startedAt,
			executionId: run.executionId,
			completedAt: this.now(),
			message: result.message,
			statementResults: [...run.statementResults]
		};

		this.cancelledRuns.set(run.id, cancelled);
		this.finishRun(run.id);

		return cancelled;
	}

	private finishRun(runId: number): void {
		if (this.activeRun?.id === runId) {
			this.activeRun = undefined;
			this.currentState = createIdleState();
		}
	}

	private takeCancelledRun(runId: number): SqlEditorQueryCancelledEvent | undefined {
		const cancelled = this.cancelledRuns.get(runId);
		if (cancelled) {
			this.cancelledRuns.delete(runId);
		}
		return cancelled;
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

function createIdleState(): SqlEditorExecutionControllerState {
	return {
		state: SqlEditorRunningState.Idle,
		editorId: '',
		canCancel: false
	};
}

function normalizeError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}
	return new Error(String(error));
}

function createSqlEditorExecutionId(): string {
	return `sql-execution-${generateUuid()}`;
}

function createSqlEditorStatementResultId(executionId: string, statementIndex: number): string {
	return `${executionId}-result-${statementIndex + 1}`;
}

function assertNever(value: never): never {
	throw new Error(`Unsupported SQL editor execution source: ${String(value)}`);
}
