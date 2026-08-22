/*---------------------------------------------------------------------------------------------
 * SQL Agent panel projection helpers. The panel renders this projection and never
 * interprets backend policy or raw query rows.
 *--------------------------------------------------------------------------------------------*/

import {
	SqlAgentMode,
	SqlAgentOptimizeEvidence,
	SqlAgentOptimizePlanSummary,
	SqlAgentRunEvent,
	SqlAgentRunState,
	SqlAgentTaskKind,
	SqlAgentToolCall
} from '../../../services/sql/common/sqlAgent.js';
import { SqlCapability } from '../../../services/sql/common/sqlCapabilities.js';

export const SQL_AGENT_VIEW_ID = 'nyala.sqlAgent.view';

export interface SqlAgentPanelProjection {
	readonly runId?: string;
	readonly state: SqlAgentRunState;
	readonly usageLabel: string;
	readonly evidenceRefs: readonly string[];
	readonly optimizeEvidenceLines: readonly string[];
	readonly answerTitle?: string;
	readonly answerContent?: string;
	readonly answerSql?: string;
	readonly errorMessage?: string;
	readonly partial: boolean;
	readonly toolCalls: readonly Pick<SqlAgentToolCall, 'callId' | 'tool' | 'contextRefs'>[];
	readonly warnings: readonly string[];
	readonly queryCallCount: number;
}

const SQL_AGENT_RUN_STATE_LABELS: Record<SqlAgentRunState, string> = {
	created: 'Created',
	building_context: 'Building context',
	reasoning: 'Reasoning',
	awaiting_tool: 'Awaiting tool',
	awaiting_approval: 'Awaiting approval',
	executing_tool: 'Executing tool',
	completed: 'Completed',
	failed: 'Failed',
	cancelled: 'Cancelled'
};

export function projectSqlAgentRunEvent(event: SqlAgentRunEvent): SqlAgentPanelProjection {
	const result = event.result;
	return {
		runId: event.run.runId,
		state: event.run.state,
		usageLabel: `${event.run.usage.modelTurns} model turn(s), ${event.run.usage.toolCalls} tool call(s), ${event.run.usage.resultRows} result row(s)`,
		evidenceRefs: result?.evidenceRefs ?? event.run.evidenceRefs,
		optimizeEvidenceLines: getSqlAgentOptimizeEvidenceLines(result?.optimizeEvidence),
		answerTitle: result?.answer?.title,
		answerContent: result?.answer?.content,
		answerSql: result?.answer?.sql,
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

export function getSqlAgentPanelCapabilities(
	mode: SqlAgentMode,
	task: SqlAgentTaskKind,
	hasConnection: boolean
): readonly SqlCapability[] {
	if (mode === SqlAgentMode.SuggestOnly) {
		return task === SqlAgentTaskKind.GenerateQuery || task === SqlAgentTaskKind.FixError
			? [
					SqlCapability.AgentTool,
					SqlCapability.WorkspaceReadSql,
					...(hasConnection ? [SqlCapability.DatabaseReadMetadata] : [])
				]
			: [SqlCapability.AgentTool, SqlCapability.WorkspaceReadSql];
	}
	if (mode === SqlAgentMode.ReadOnly && task === SqlAgentTaskKind.Assistant) {
		return [
			SqlCapability.AgentTool,
			SqlCapability.DatabaseReadMetadata,
			SqlCapability.DatabaseExecuteRead,
			SqlCapability.DatabaseReadResultShape
		];
	}
	if (mode === SqlAgentMode.ReadOnly && task === SqlAgentTaskKind.ExplainError) {
		return [SqlCapability.DatabaseExplain];
	}
	if (mode === SqlAgentMode.ReadOnly && task === SqlAgentTaskKind.OptimizeQuery) {
		return [SqlCapability.AgentTool, SqlCapability.DatabaseReadMetadata, SqlCapability.DatabaseExplain];
	}
	return [];
}

export function getSqlAgentOptimizeEvidenceLines(evidence: SqlAgentOptimizeEvidence | undefined): readonly string[] {
	if (!evidence) {
		return [];
	}
	const { comparison } = evidence;
	return [
		`Plan verdict: ${formatWireLabel(comparison.verdict)}`,
		...(comparison.uncertaintyReason ? [`Uncertainty: ${formatWireLabel(comparison.uncertaintyReason)}`] : []),
		`Index metadata: ${evidence.indexMetadataAvailable ? 'Available' : 'Unavailable'}`,
		...(comparison.original ? [formatPlanSummary('Original plan', comparison.original)] : []),
		...(comparison.rewritten ? [formatPlanSummary('Rewritten plan', comparison.rewritten)] : []),
		`Plan changes: ${comparison.changes.length}`,
		`Runtime performance verified: ${comparison.performanceVerified ? 'Yes' : 'No'}`,
		`Query semantics verified: ${evidence.semanticsVerified ? 'Yes' : 'No'}`
	];
}

function formatWireLabel(value: string): string {
	const label = value.replaceAll('_', ' ');
	return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function formatPlanSummary(label: string, summary: SqlAgentOptimizePlanSummary): string {
	return `${label}: ${formatCount(summary.scanCount, 'scan')}, ${formatCount(summary.indexSearchCount, 'index search', 'index searches')}, ${formatCount(summary.joinInputCount, 'join input')}, ${formatCount(summary.temporaryBtreeCount, 'temporary B-tree')}, ${formatCount(summary.unknownCount, 'unknown operation')}`;
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

export function getSqlAgentPanelStatus(projection: SqlAgentPanelProjection): string {
	if (projection.errorMessage) {
		return `Error: ${projection.errorMessage}`;
	}
	const stateLabel = SQL_AGENT_RUN_STATE_LABELS[projection.state];
	if (projection.partial) {
		return `${stateLabel} (partial)`;
	}
	return stateLabel;
}

export function getSqlAgentPanelActiveRunId(projection: SqlAgentPanelProjection): string | undefined {
	return projection.state === 'completed' || projection.state === 'failed' || projection.state === 'cancelled'
		? undefined
		: projection.runId;
}
