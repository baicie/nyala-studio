/*---------------------------------------------------------------------------------------------
 * SQL Workspace Agent service implementation.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isTauri } from '../../../../sidex-bridge.js';
import {
	ISqlAgentService,
	isSqlAgentMode,
	isSqlAgentTaskKind,
	SqlAgentRun,
	SqlAgentRunEvent,
	SqlAgentExecuteReadonlyResult,
	SqlAgentExplainResult,
	SqlAgentReadOnlyRequest,
	SqlAgentStartRequest
} from '../common/sqlAgent.js';
import { isSqlCapability } from '../common/sqlCapabilities.js';
import { SqlDialect } from '../common/sqlDialect.js';
import { ISqlCommandExecutor, TauriSqlCommandExecutor, toSqlServiceError } from './sqlCommandExecutor.js';

const SQL_AGENT_RUN_EVENT = 'sql-agent/run';

interface TauriEventWindow {
	__TAURI__?: {
		event?: {
			listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
		};
	};
}

async function tauriListen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
	const tauriEvent = (globalThis as unknown as TauriEventWindow).__TAURI__?.event;
	if (tauriEvent?.listen) {
		try {
			return await tauriEvent.listen<T>(event, e => handler(e.payload));
		} catch {
			// A stale global API can remain during WebView shutdown; retry through the official v2 module.
		}
	}
	if (!isTauri()) {
		return () => {
			/* no-op outside Tauri */
		};
	}
	try {
		const { listen: officialListen } = await import('@tauri-apps/api/event');
		return await officialListen<T>(event, e => handler(e.payload));
	} catch {
		return () => {
			/* Tauri can disappear while the Workbench is shutting down. */
		};
	}
}

export class SqlAgentService extends Disposable implements ISqlAgentService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeRun = this._register(new Emitter<SqlAgentRunEvent>());
	private disposed = false;
	private eventUnlisten: (() => void) | undefined;
	private lastRunEvent: SqlAgentRunEvent | undefined;

	constructor();
	constructor(executor: ISqlCommandExecutor);
	constructor(private readonly executor: ISqlCommandExecutor = new TauriSqlCommandExecutor()) {
		super();
		this._register(
			toDisposable(() => {
				this.disposed = true;
				this.eventUnlisten?.();
				this.eventUnlisten = undefined;
			})
		);
		void this.subscribeToRunEvents();
	}

	readonly onDidChangeRun: Event<SqlAgentRunEvent> = this._onDidChangeRun.event;

	getLastRunEvent(): SqlAgentRunEvent | undefined {
		return this.lastRunEvent;
	}

	async start(request: SqlAgentStartRequest): Promise<SqlAgentRunEvent> {
		const normalized = normalizeSqlAgentStartRequest(request);
		try {
			const event = await this.executor.execute<SqlAgentRunEvent>('sql_agent_start', { request: normalized });
			this.lastRunEvent = event;
			return event;
		} catch (error) {
			throw toSqlServiceError('sql_agent_start', error);
		}
	}

	async cancel(runId: string): Promise<SqlAgentRunEvent> {
		const normalized = normalizeRunId(runId);
		try {
			const event = await this.executor.execute<SqlAgentRunEvent>('sql_agent_cancel', { runId: normalized });
			this.lastRunEvent = event;
			return event;
		} catch (error) {
			throw toSqlServiceError('sql_agent_cancel', error);
		}
	}

	async getRun(runId: string): Promise<SqlAgentRun> {
		const normalized = normalizeRunId(runId);
		try {
			return await this.executor.execute<SqlAgentRun>('sql_agent_get_run', { runId: normalized });
		} catch (error) {
			throw toSqlServiceError('sql_agent_get_run', error);
		}
	}

	async executeReadonly(request: SqlAgentReadOnlyRequest): Promise<SqlAgentExecuteReadonlyResult> {
		const normalized = normalizeSqlAgentReadOnlyRequest(request);
		try {
			return await this.executor.execute<SqlAgentExecuteReadonlyResult>('sql_agent_execute_readonly', {
				request: normalized
			});
		} catch (error) {
			throw toSqlServiceError('sql_agent_execute_readonly', error);
		}
	}

	async explain(request: SqlAgentReadOnlyRequest): Promise<SqlAgentExplainResult> {
		const normalized = normalizeSqlAgentReadOnlyRequest(request);
		try {
			return await this.executor.execute<SqlAgentExplainResult>('sql_agent_explain', {
				request: normalized
			});
		} catch (error) {
			throw toSqlServiceError('sql_agent_explain', error);
		}
	}

	private async subscribeToRunEvents(): Promise<void> {
		const unlisten = await tauriListen<SqlAgentRunEvent>(SQL_AGENT_RUN_EVENT, event => {
			if (isSqlAgentRunEvent(event)) {
				this.lastRunEvent = event;
				this._onDidChangeRun.fire(event);
			}
		});
		if (this.disposed) {
			unlisten();
			return;
		}
		this.eventUnlisten = unlisten;
	}
}

export function normalizeSqlAgentStartRequest(request: SqlAgentStartRequest): SqlAgentStartRequest {
	if (!request || typeof request !== 'object') {
		throw new Error('Agent request is required.');
	}
	if (!request.goal?.trim()) {
		throw new Error('Agent goal is required.');
	}
	if (!isSqlAgentTaskKind(request.task)) {
		throw new Error('Agent task is required.');
	}
	if (!isSqlAgentMode(request.mode)) {
		throw new Error('Agent mode is required.');
	}
	if (!request.context || typeof request.context !== 'object' || !isSqlDialect(request.context.dialect)) {
		throw new Error('Agent context dialect is required.');
	}
	const capabilities = [...new Set(request.capabilities ?? [])];
	for (const capability of capabilities) {
		if (!isSqlCapability(capability)) {
			throw new Error(`Unsupported SQL capability '${capability}'`);
		}
	}
	return {
		...request,
		goal: request.goal.trim(),
		context: {
			...request.context,
			connectionId: request.context.connectionId?.trim() || undefined,
			sql: request.context.sql?.trim() || undefined,
			selectedSql: request.context.selectedSql?.trim() || undefined,
			errorMessage: request.context.errorMessage?.trim() || undefined,
			errorContext: normalizeSqlAgentErrorContext(request.context.errorContext),
			userPrompt: request.context.userPrompt?.trim() || undefined,
			explainPlan: request.context.explainPlan?.trim() || undefined
		},
		capabilities
	};
}

function normalizeSqlAgentErrorContext(
	context: SqlAgentStartRequest['context']['errorContext']
): SqlAgentStartRequest['context']['errorContext'] {
	if (!context) {
		return undefined;
	}
	const message = context.message?.trim();
	if (!message) {
		return undefined;
	}
	return {
		code: context.code?.trim() || undefined,
		message,
		detail: context.detail?.trim() || undefined
	};
}

export function normalizeSqlAgentReadOnlyRequest(request: SqlAgentReadOnlyRequest): SqlAgentReadOnlyRequest {
	if (!request || typeof request !== 'object') {
		throw new Error('Agent SQL request is required.');
	}
	const connectionId = request.connectionId?.trim();
	if (!connectionId) {
		throw new Error('Agent SQL connection id is required.');
	}
	const sql = request.sql?.trim();
	if (!sql) {
		throw new Error('Agent SQL statement is required.');
	}
	if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit <= 0)) {
		throw new Error('Agent SQL limit must be a positive integer.');
	}
	return {
		...request,
		connectionId,
		sql,
		limit: request.limit === undefined ? undefined : Math.min(request.limit, 1000)
	};
}

function normalizeRunId(runId: string): string {
	const normalized = runId?.trim();
	if (!normalized) {
		throw new Error('Agent run id is required.');
	}
	return normalized;
}

function isSqlDialect(value: unknown): value is SqlDialect {
	return value === SqlDialect.Sqlite || value === SqlDialect.MySql || value === SqlDialect.PostgreSql;
}

function isSqlAgentRunEvent(value: unknown): value is SqlAgentRunEvent {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as { run?: unknown };
	return Boolean(candidate.run && typeof candidate.run === 'object');
}
