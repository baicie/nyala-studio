/*---------------------------------------------------------------------------------------------
 * SQL Agent panel projection helpers. The panel renders this projection and never
 * interprets backend policy or raw query rows.
 *--------------------------------------------------------------------------------------------*/

import { SqlAgentRunEvent, SqlAgentToolCall } from '../../../services/sql/common/sqlAgent.js';

export interface SqlAgentPanelProjection {
	readonly runId?: string;
	readonly state: string;
	readonly usageLabel: string;
	readonly evidenceRefs: readonly string[];
	readonly answerTitle?: string;
	readonly answerContent?: string;
	readonly errorMessage?: string;
	readonly partial: boolean;
	readonly toolCalls: readonly Pick<SqlAgentToolCall, 'callId' | 'tool' | 'contextRefs'>[];
	readonly warnings: readonly string[];
	readonly queryCallCount: number;
}

export function projectSqlAgentRunEvent(event: SqlAgentRunEvent): SqlAgentPanelProjection {
	const result = event.result;
	return {
		runId: event.run.runId,
		state: event.run.state,
		usageLabel: `${event.run.usage.modelTurns} model turn(s), ${event.run.usage.toolCalls} tool call(s), ${event.run.usage.resultRows} result row(s)`,
		evidenceRefs: result?.evidenceRefs ?? event.run.evidenceRefs,
		answerTitle: result?.answer?.title,
		answerContent: result?.answer?.content,
		errorMessage: event.error?.message,
		partial: result?.partial ?? false,
		toolCalls: (event.run.toolCalls ?? []).map(({ callId, tool, contextRefs }) => ({
			callId,
			tool,
			contextRefs
		})),
		warnings: result?.warnings ?? [],
		queryCallCount: result?.queryCallCount ?? 0
	};
}

export function getSqlAgentPanelStatus(projection: SqlAgentPanelProjection): string {
	if (projection.errorMessage) {
		return `Error: ${projection.errorMessage}`;
	}
	if (projection.partial) {
		return `${projection.state} (partial)`;
	}
	return projection.state;
}
