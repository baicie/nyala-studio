/*---------------------------------------------------------------------------------------------
 * SQL Workspace Agent service contract.
 *
 * The Workbench owns only typed requests, projections, and event lifetime.
 * Rust remains the lifecycle, policy, and cancellation authority.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SqlCapability } from './sqlCapabilities.js';
import { SqlDialect } from './sqlDialect.js';
import { SqlQueryResult } from './sqlTypes.js';

export const ISqlAgentService = createDecorator<ISqlAgentService>('sqlAgentService');

export const enum SqlAgentTaskKind {
	Assistant = 'assistant',
	ExplainError = 'explain_error',
	FixError = 'fix_error',
	GenerateQuery = 'generate_query',
	OptimizeQuery = 'optimize_query'
}

export const enum SqlAgentMode {
	SuggestOnly = 'suggest_only',
	ReadOnly = 'read_only',
	AllowWritesWithApproval = 'allow_writes_with_approval'
}

/** Keep this wire contract aligned with Rust's `AgentRunState`. */
export const SQL_AGENT_RUN_STATES = [
	'created',
	'building_context',
	'reasoning',
	'awaiting_tool',
	'awaiting_approval',
	'executing_tool',
	'completed',
	'failed',
	'cancelled'
] as const;

export type SqlAgentRunState = (typeof SQL_AGENT_RUN_STATES)[number];

export interface SqlAgentBudget {
	readonly maxModelTurns: number;
	readonly maxToolCalls: number;
	readonly maxSchemaObjects: number;
	readonly maxResultRows: number;
	readonly maxResultBytes: number;
	readonly maxWallClockMs: number;
	readonly maxTokens?: number;
}

export interface SqlAgentSchemaTable {
	readonly schema?: string;
	readonly name: string;
	readonly columns: readonly string[];
}

export interface SqlAgentErrorContext {
	readonly code?: string;
	readonly message: string;
	readonly detail?: string;
}

export interface SqlAgentResultShapeColumn {
	readonly name: string;
	readonly ordinal: number;
}

/** Result metadata safe to send to the Agent; rows and cell values are excluded. */
export interface SqlAgentResultShape {
	readonly columns: readonly SqlAgentResultShapeColumn[];
	readonly rowCount: number;
	readonly elapsedMs: number;
	readonly truncated: boolean;
}

export interface SqlAgentModelContext {
	readonly dialect: SqlDialect;
	/** Opaque local connection id; never contains credentials or a URL. */
	readonly connectionId?: string;
	/** Opaque Workbench editor identity used only to correlate a stale-safe draft. */
	readonly editorId?: string;
	readonly editorVersionId?: number;
	readonly sql?: string;
	readonly selectedSql?: string;
	readonly errorMessage?: string;
	readonly errorContext?: SqlAgentErrorContext;
	readonly userPrompt?: string;
	readonly explainPlan?: string;
	readonly schema?: readonly SqlAgentSchemaTable[];
	readonly resultShape?: SqlAgentResultShape;
}

export interface SqlAgentStartRequest {
	readonly goal: string;
	readonly task: SqlAgentTaskKind;
	readonly mode: SqlAgentMode;
	readonly budget?: SqlAgentBudget;
	readonly context: SqlAgentModelContext;
	readonly capabilities?: readonly SqlCapability[];
}

export interface SqlAgentRunUsage {
	readonly modelTurns: number;
	readonly toolCalls: number;
	readonly schemaObjects: number;
	readonly resultRows: number;
	readonly resultBytes: number;
	readonly tokens: number;
}

export interface SqlAgentTask {
	readonly taskId: string;
	readonly kind: SqlAgentTaskKind;
	readonly state: string;
	readonly title: string;
}

/** Safe tool-call summary for the Workbench; backend arguments are intentionally excluded. */
export interface SqlAgentToolCall {
	readonly runId: string;
	readonly callId: string;
	readonly tool: string;
	readonly contextRefs: readonly string[];
}

export interface SqlAgentRun {
	readonly runId: string;
	readonly goal: string;
	readonly mode: SqlAgentMode;
	readonly budget: SqlAgentBudget;
	readonly state: SqlAgentRunState;
	/** Backend-owned monotonic version used to reject stale cross-queue events. */
	readonly revision: number;
	readonly usage: SqlAgentRunUsage;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
	readonly evidenceRefs: readonly string[];
	readonly tasks?: readonly SqlAgentTask[];
	readonly toolCalls?: readonly SqlAgentToolCall[];
}

export interface SqlAgentAnswer {
	readonly title: string;
	readonly content: string;
	readonly sql?: string;
}

export type SqlAgentOptimizePlanVerdict =
	'structurally_improved' | 'equivalent' | 'structurally_regressed' | 'uncertain';

export type SqlAgentOptimizePlanUncertaintyReason =
	| 'missing_original'
	| 'missing_rewritten'
	| 'index_metadata_unavailable'
	| 'original_incomplete'
	| 'rewritten_incomplete'
	| 'connection_mismatch'
	| 'dialect_mismatch'
	| 'metadata_revision_mismatch'
	| 'normalization_version_mismatch'
	| 'unsupported_operation'
	| 'topology_mismatch'
	| 'unranked_access_change'
	| 'mixed_structural_signals';

export interface SqlAgentOptimizePlanSummary {
	readonly scanCount: number;
	readonly indexSearchCount: number;
	readonly joinInputCount: number;
	readonly temporaryBtreeCount: number;
	readonly unknownCount: number;
}

export type SqlAgentOptimizePlanLoopRole =
	{ readonly kind: 'single' } | { readonly kind: 'join'; readonly position: number };

export type SqlAgentOptimizePlanAccessClass = 'scan' | 'index_search';

export type SqlAgentOptimizeTemporaryBTreePurpose =
	'order_by' | 'right_part_of_order_by' | 'group_by' | 'distinct' | 'compound_query' | 'other';

export type SqlAgentOptimizePlanStructuralChange =
	| {
			readonly kind: 'access_mode';
			readonly target: string;
			readonly loop_role: SqlAgentOptimizePlanLoopRole;
			readonly before: SqlAgentOptimizePlanAccessClass;
			readonly after: SqlAgentOptimizePlanAccessClass;
	  }
	| {
			readonly kind: 'temporary_b_tree_count';
			readonly purpose: SqlAgentOptimizeTemporaryBTreePurpose;
			readonly before: number;
			readonly after: number;
	  };

export interface SqlAgentOptimizePlanComparison {
	readonly verdict: SqlAgentOptimizePlanVerdict;
	readonly uncertaintyReason?: SqlAgentOptimizePlanUncertaintyReason;
	readonly original?: SqlAgentOptimizePlanSummary;
	readonly rewritten?: SqlAgentOptimizePlanSummary;
	readonly changes: readonly SqlAgentOptimizePlanStructuralChange[];
	readonly performanceVerified: boolean;
}

/** Backend-owned terminal evidence for a deterministic Optimize run. */
export interface SqlAgentOptimizeEvidence {
	readonly indexMetadataAvailable: boolean;
	readonly comparison: SqlAgentOptimizePlanComparison;
	readonly semanticsVerified: boolean;
}

export interface SqlAgentLoopResult {
	readonly runId: string;
	readonly state: SqlAgentRunState;
	readonly answer?: SqlAgentAnswer;
	readonly evidenceRefs: readonly string[];
	readonly optimizeEvidence?: SqlAgentOptimizeEvidence;
	readonly warnings: readonly string[];
	readonly partial: boolean;
	readonly queryCallCount: number;
}

export interface SqlAgentReadOnlyRequest {
	readonly connectionId: string;
	readonly sql: string;
	readonly limit?: number;
}

export interface SqlAgentSqlAnalysis {
	readonly dialect: SqlDialect;
	readonly statementCount: number;
	readonly statementClass: string;
	readonly risk: string;
	readonly referencedTables: readonly { readonly schema?: string; readonly name: string }[];
	readonly warnings: readonly string[];
}

export interface SqlAgentExecuteReadonlyResult {
	readonly connectionId: string;
	readonly analysis: SqlAgentSqlAnalysis;
	readonly result: SqlQueryResult;
}

export interface SqlAgentExplainResult {
	readonly connectionId: string;
	readonly analysis: SqlAgentSqlAnalysis;
	readonly plan: SqlQueryResult;
}

export interface SqlAgentRunEvent {
	readonly run: SqlAgentRun;
	readonly result?: SqlAgentLoopResult;
	readonly error?: { readonly code: string; readonly message: string };
}

export interface ISqlAgentService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeRun: Event<SqlAgentRunEvent>;
	getLastRunEvent(): SqlAgentRunEvent | undefined;
	start(request: SqlAgentStartRequest): Promise<SqlAgentRunEvent>;
	cancel(runId: string): Promise<SqlAgentRunEvent>;
	getRun(runId: string): Promise<SqlAgentRun>;
	executeReadonly(request: SqlAgentReadOnlyRequest): Promise<SqlAgentExecuteReadonlyResult>;
	explain(request: SqlAgentReadOnlyRequest): Promise<SqlAgentExplainResult>;
}

/** Used by browser service tests without importing the implementation. */
export function isSqlAgentTaskKind(value: unknown): value is SqlAgentTaskKind {
	return (
		value === SqlAgentTaskKind.Assistant ||
		value === SqlAgentTaskKind.ExplainError ||
		value === SqlAgentTaskKind.FixError ||
		value === SqlAgentTaskKind.GenerateQuery ||
		value === SqlAgentTaskKind.OptimizeQuery
	);
}

export function isSqlAgentMode(value: unknown): value is SqlAgentMode {
	return (
		value === SqlAgentMode.SuggestOnly ||
		value === SqlAgentMode.ReadOnly ||
		value === SqlAgentMode.AllowWritesWithApproval
	);
}

export function isSqlAgentRunState(value: unknown): value is SqlAgentRunState {
	return typeof value === 'string' && (SQL_AGENT_RUN_STATES as readonly string[]).includes(value);
}

export type SqlAgentRunEventEmitter = Emitter<SqlAgentRunEvent>;
