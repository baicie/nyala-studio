import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
	SQL_AGENT_RUN_STATES,
	SqlAgentMode,
	SqlAgentRunState,
	SqlAgentTaskKind
} from '../../../services/sql/common/sqlAgent.js';
import { SqlCapability } from '../../../services/sql/common/sqlCapabilities.js';
import {
	getSqlAgentPanelCapabilities,
	getSqlAgentPanelActiveRunId,
	getSqlAgentPanelStatus,
	projectSqlAgentRunEvent
} from '../common/sqlAgentPanelModel.js';

const agentViewSource = readFileSync(new URL('../browser/sqlAgentView.ts', import.meta.url), 'utf8');
const agentStylesSource = readFileSync(new URL('../browser/media/sqlAgent.css', import.meta.url), 'utf8');
const agentDomainSource = readFileSync(
	new URL('../../../../../../src-tauri/src/commands/sql/agent/domain.rs', import.meta.url),
	'utf8'
);

test('Agent panel projection exposes run state, usage, answer, and evidence refs', () => {
	const projection = projectSqlAgentRunEvent({
		run: {
			runId: 'run-1',
			goal: 'inspect',
			mode: 'read_only',
			budget: {
				maxModelTurns: 8,
				maxToolCalls: 16,
				maxSchemaObjects: 48,
				maxResultRows: 1000,
				maxResultBytes: 262144,
				maxWallClockMs: 60000,
				maxTokens: 32000
			},
			state: 'completed',
			revision: 3,
			usage: {
				modelTurns: 2,
				toolCalls: 1,
				schemaObjects: 3,
				resultRows: 4,
				resultBytes: 128,
				tokens: 10
			},
			createdAtMs: 1,
			updatedAtMs: 2,
			evidenceRefs: ['evidence-1'],
			tasks: [],
			toolCalls: [
				{
					runId: 'run-1',
					callId: 'call-1',
					tool: 'sql.execute_readonly',
					contextRefs: ['schema-1']
				}
			]
		},
		result: {
			runId: 'run-1',
			state: 'completed',
			answer: { title: 'Answer', content: 'Done', sql: 'SELECT 1;' },
			evidenceRefs: ['evidence-2'],
			warnings: [],
			partial: false,
			queryCallCount: 1
		}
	});

	assert.equal(projection.state, 'completed');
	assert.equal(projection.usageLabel, '2 model turn(s), 1 tool call(s), 4 result row(s)');
	assert.deepEqual(projection.evidenceRefs, ['evidence-2']);
	assert.equal(projection.answerTitle, 'Answer');
	assert.equal(projection.answerSql, 'SELECT 1;');
	assert.deepEqual(projection.toolCalls, [
		{ callId: 'call-1', tool: 'sql.execute_readonly', contextRefs: ['schema-1'] }
	]);
	assert.deepEqual(projection.warnings, []);
	assert.equal(projection.queryCallCount, 1);
	assert.equal(getSqlAgentPanelStatus(projection), 'Completed');
});

test('Agent panel projection reports structured errors and partial runs', () => {
	const projection = projectSqlAgentRunEvent({
		run: {
			runId: 'run-2',
			goal: 'inspect',
			mode: 'read_only',
			budget: {
				maxModelTurns: 8,
				maxToolCalls: 16,
				maxSchemaObjects: 48,
				maxResultRows: 1000,
				maxResultBytes: 262144,
				maxWallClockMs: 60000,
				maxTokens: 32000
			},
			state: 'failed',
			revision: 2,
			usage: { modelTurns: 1, toolCalls: 0, schemaObjects: 0, resultRows: 0, resultBytes: 0, tokens: 0 },
			createdAtMs: 1,
			updatedAtMs: 2,
			evidenceRefs: [],
			tasks: [],
			toolCalls: []
		},
		result: undefined,
		error: { code: 'validation', message: 'denied' }
	});
	assert.match(getSqlAgentPanelStatus(projection), /Error: denied/);
});

test('Agent panel projects every backend run state to a visible label and matching ownership', () => {
	const expectedLabels: Record<SqlAgentRunState, string> = {
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
	const terminalStates = new Set<SqlAgentRunState>(['completed', 'failed', 'cancelled']);

	for (const state of SQL_AGENT_RUN_STATES) {
		const projection = projectSqlAgentRunEvent({
			run: {
				runId: `run-${state}`,
				goal: 'inspect',
				mode: SqlAgentMode.ReadOnly,
				budget: {
					maxModelTurns: 8,
					maxToolCalls: 16,
					maxSchemaObjects: 48,
					maxResultRows: 1000,
					maxResultBytes: 262144,
					maxWallClockMs: 60000,
					maxTokens: 32000
				},
				state,
				revision: 1,
				usage: {
					modelTurns: 0,
					toolCalls: 0,
					schemaObjects: 0,
					resultRows: 0,
					resultBytes: 0,
					tokens: 0
				},
				createdAtMs: 1,
				updatedAtMs: 1,
				evidenceRefs: [],
				tasks: [],
				toolCalls: []
			}
		});

		assert.equal(getSqlAgentPanelStatus(projection), expectedLabels[state]);
		assert.equal(getSqlAgentPanelActiveRunId(projection), terminalStates.has(state) ? undefined : `run-${state}`);
	}
});

test('Workbench run states stay aligned with the Rust lifecycle contract', () => {
	const enumBody = agentDomainSource.match(/pub enum AgentRunState \{([\s\S]*?)\n\}/)?.[1];
	assert.ok(enumBody);
	const rustStates = [...enumBody.matchAll(/^\s+([A-Z][A-Za-z]+),$/gm)].map(match =>
		match[1].replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
	);

	assert.deepEqual(rustStates, [...SQL_AGENT_RUN_STATES]);
});

test('Agent panel projection keeps warnings and strips tool arguments', () => {
	const projection = projectSqlAgentRunEvent({
		run: {
			runId: 'run-3',
			goal: 'inspect',
			mode: 'read_only',
			budget: {
				maxModelTurns: 8,
				maxToolCalls: 16,
				maxSchemaObjects: 48,
				maxResultRows: 1000,
				maxResultBytes: 262144,
				maxWallClockMs: 60000,
				maxTokens: 32000
			},
			state: 'completed',
			revision: 4,
			usage: { modelTurns: 1, toolCalls: 1, schemaObjects: 1, resultRows: 0, resultBytes: 0, tokens: 0 },
			createdAtMs: 1,
			updatedAtMs: 2,
			evidenceRefs: [],
			tasks: [],
			toolCalls: [
				{
					runId: 'run-3',
					callId: 'call-3',
					tool: 'sql.explain',
					contextRefs: [],
					arguments: { sql: 'SELECT secret FROM users' }
				} as never
			]
		},
		result: {
			runId: 'run-3',
			state: 'completed',
			evidenceRefs: [],
			warnings: ['Result was truncated.'],
			partial: true,
			queryCallCount: 1
		}
	});

	assert.deepEqual(projection.warnings, ['Result was truncated.']);
	assert.equal(projection.partial, true);
	assert.deepEqual(projection.toolCalls, [{ callId: 'call-3', tool: 'sql.explain', contextRefs: [] }]);
	assert.equal('arguments' in projection.toolCalls[0], false);
	assert.match(getSqlAgentPanelStatus(projection), /partial/);
});

test('Agent panel projects typed Optimize comparison and uncertainty evidence', () => {
	const projection = projectSqlAgentRunEvent({
		run: {
			runId: 'run-optimize',
			goal: 'optimize',
			mode: SqlAgentMode.ReadOnly,
			budget: {
				maxModelTurns: 8,
				maxToolCalls: 16,
				maxSchemaObjects: 48,
				maxResultRows: 1000,
				maxResultBytes: 262144,
				maxWallClockMs: 60000,
				maxTokens: 32000
			},
			state: 'completed',
			revision: 9,
			usage: { modelTurns: 6, toolCalls: 5, schemaObjects: 0, resultRows: 0, resultBytes: 0, tokens: 0 },
			createdAtMs: 1,
			updatedAtMs: 2,
			evidenceRefs: ['plan-compare'],
			toolCalls: []
		},
		result: {
			runId: 'run-optimize',
			state: 'completed',
			evidenceRefs: ['plan-compare'],
			optimizeEvidence: {
				indexMetadataAvailable: false,
				semanticsVerified: false,
				comparison: {
					verdict: 'uncertain',
					uncertaintyReason: 'index_metadata_unavailable',
					original: {
						scanCount: 1,
						indexSearchCount: 0,
						joinInputCount: 0,
						temporaryBtreeCount: 1,
						unknownCount: 0
					},
					rewritten: {
						scanCount: 0,
						indexSearchCount: 1,
						joinInputCount: 0,
						temporaryBtreeCount: 0,
						unknownCount: 0
					},
					changes: [],
					performanceVerified: false
				}
			},
			warnings: [],
			partial: false,
			queryCallCount: 2
		}
	});

	assert.deepEqual(projection.optimizeEvidenceLines, [
		'Plan verdict: Uncertain',
		'Uncertainty: Index metadata unavailable',
		'Index metadata: Unavailable',
		'Original plan: 1 scan, 0 index searches, 0 join inputs, 1 temporary B-tree, 0 unknown operations',
		'Rewritten plan: 0 scans, 1 index search, 0 join inputs, 0 temporary B-trees, 0 unknown operations',
		'Plan changes: 0',
		'Runtime performance verified: No',
		'Query semantics verified: No'
	]);
});

test('Agent panel exposes stable screen-reader names and live status semantics', () => {
	assert.match(agentViewSource, /'aria-label': 'Agent prompt'/);
	assert.match(agentViewSource, /setAttribute\('aria-label', 'Agent task'\)/);
	assert.match(agentViewSource, /setAttribute\('aria-label', 'Agent access mode'\)/);
	assert.match(agentViewSource, /role: 'status', 'aria-live': 'polite'/);
	assert.match(agentViewSource, /'aria-label': 'Agent evidence'/);
	assert.match(agentViewSource, /role: 'article'/);
	assert.match(agentViewSource, /'aria-label': 'Agent activity'/);
	assert.match(agentViewSource, /'aria-label': 'Agent warnings'/);
	assert.match(agentViewSource, /'aria-label': 'Agent SQL draft'/);
});

test('Agent panel keeps action and input controls disabled during an active run', () => {
	const setBusySource = agentViewSource.match(/private setBusy\(busy: boolean\): void \{([\s\S]*?)\n\t\}/)?.[1];

	assert.ok(setBusySource);
	assert.match(setBusySource, /this\.startButton\.disabled = busy/);
	assert.match(setBusySource, /this\.cancelButton\.disabled = !busy/);
	assert.match(setBusySource, /this\.promptElement\.disabled = busy/);
	assert.match(setBusySource, /this\.modeElement\.disabled = busy/);
	assert.match(setBusySource, /this\.taskElement\.disabled = busy/);
});

test('Agent panel keeps an allocated run cancellable when background execution rejects', () => {
	const startRunSource = agentViewSource.match(/private async startRun\(\): Promise<void> \{([\s\S]*?)\n\t\}/)?.[1];
	assert.ok(startRunSource);
	const catchSource = startRunSource.match(/catch \(error\) \{([\s\S]*?)\n\t\t\}/)?.[1];
	assert.ok(catchSource);

	assert.match(catchSource, /this\.setBusy\(Boolean\(this\.activeRunId\)\)/);
	assert.doesNotMatch(catchSource, /this\.setBusy\(false\)/);
});

test('Agent service supports the official Tauri event API when globalTauri is unavailable', async () => {
	const serviceSource = await import('node:fs/promises').then(fs =>
		fs.readFile(new URL('../../../services/sql/browser/sqlAgentService.ts', import.meta.url), 'utf8')
	);
	assert.match(serviceSource, /@tauri-apps\/api\/event/);
	assert.match(serviceSource, /isTauri\(\)/);
	assert.match(serviceSource, /tauriEvent\?\.listen/);
	assert.match(serviceSource, /return await tauriEvent\.listen/);
});

test('Agent panel controls wrap in narrow viewports', () => {
	assert.match(agentStylesSource, /\.sql-agent-controls[\s\S]*flex-wrap: wrap/);
	assert.match(agentStylesSource, /@media \(max-width: 420px\)/);
	assert.match(agentStylesSource, /flex-basis: 100%/);
});

test('Agent panel renders tool activity and warnings without raw tool arguments', () => {
	assert.match(agentViewSource, /private activityElement!: HTMLOListElement/);
	assert.match(agentViewSource, /private warningsElement!: HTMLOListElement/);
	assert.match(agentViewSource, /projection\.toolCalls/);
	assert.match(agentViewSource, /projection\.warnings/);
	assert.doesNotMatch(agentViewSource, /toolCall\.arguments/);
});

test('Read Only Assistant requests only the backend-owned Explore capabilities', () => {
	assert.deepEqual(getSqlAgentPanelCapabilities(SqlAgentMode.ReadOnly, SqlAgentTaskKind.Assistant, true), [
		SqlCapability.AgentTool,
		SqlCapability.DatabaseReadMetadata,
		SqlCapability.DatabaseExecuteRead,
		SqlCapability.DatabaseReadResultShape
	]);
});

test('Read Only Explain and Optimize request their exact backend capabilities', () => {
	assert.deepEqual(getSqlAgentPanelCapabilities(SqlAgentMode.ReadOnly, SqlAgentTaskKind.ExplainError, true), [
		SqlCapability.DatabaseExplain
	]);
	assert.deepEqual(getSqlAgentPanelCapabilities(SqlAgentMode.ReadOnly, SqlAgentTaskKind.OptimizeQuery, true), [
		SqlCapability.AgentTool,
		SqlCapability.DatabaseReadMetadata,
		SqlCapability.DatabaseExplain
	]);
	for (const task of [SqlAgentTaskKind.GenerateQuery, SqlAgentTaskKind.FixError]) {
		assert.deepEqual(getSqlAgentPanelCapabilities(SqlAgentMode.ReadOnly, task, true), []);
	}
});

test('Agent panel sends Optimize the full stale-safe editor target without selection context', () => {
	const startRunSource = agentViewSource.match(/private async startRun\(\): Promise<void> \{([\s\S]*?)\n\t\}/)?.[1];
	assert.ok(startRunSource);
	assert.match(startRunSource, /const artifactTarget = pane\.getAgentArtifactTarget\(\)/);
	assert.match(startRunSource, /editorId: artifactTarget\.editorId/);
	assert.match(startRunSource, /editorVersionId: artifactTarget\.versionId/);
	assert.match(startRunSource, /sql: artifactTarget\.sql/);
	assert.match(startRunSource, /context\.versionId !== result\.query\.editorVersionId/);
});

test('Suggest Only schema draft tasks request backend metadata only with a connection', () => {
	for (const task of [SqlAgentTaskKind.GenerateQuery, SqlAgentTaskKind.FixError]) {
		assert.deepEqual(getSqlAgentPanelCapabilities(SqlAgentMode.SuggestOnly, task, true), [
			SqlCapability.AgentTool,
			SqlCapability.WorkspaceReadSql,
			SqlCapability.DatabaseReadMetadata
		]);
		assert.deepEqual(getSqlAgentPanelCapabilities(SqlAgentMode.SuggestOnly, task, false), [
			SqlCapability.AgentTool,
			SqlCapability.WorkspaceReadSql
		]);
	}
});

test('Agent panel leaves Explore schema and result handles under Rust ownership', () => {
	const startRunSource = agentViewSource.match(/private async startRun\(\): Promise<void> \{([\s\S]*?)\n\t\}/)?.[1];
	assert.ok(startRunSource);
	const requestContext = startRunSource.match(/let requestContext:[^=]+ = \{([\s\S]*?)\n\t\t\};/)?.[1];
	assert.ok(requestContext);

	assert.match(requestContext, /connectionId: context\.connectionId/);
	assert.doesNotMatch(requestContext, /\bschema\s*:/);
	assert.doesNotMatch(requestContext, /\bresultRef\s*:/);
	assert.doesNotMatch(requestContext, /\bresultShape\s*:/);
	assert.match(startRunSource, /context: requestContext/);
});

test('Agent panel Fix uses the matching Result error and structured context', () => {
	const startRunSource = agentViewSource.match(/private async startRun\(\): Promise<void> \{([\s\S]*?)\n\t\}/)?.[1];
	assert.ok(startRunSource);
	assert.match(
		startRunSource,
		/getSqlResultPanelContentState\(this\.resultService\.state, this\.resultService\.panelState\)/
	);
	assert.match(startRunSource, /result\.kind !== SqlResultStateKind\.Error/);
	assert.match(startRunSource, /context\.editorId !== result\.query\.editorId/);
	assert.match(startRunSource, /context\.versionId !== result\.query\.editorVersionId/);
	assert.match(startRunSource, /context\.connectionId !== result\.query\.connectionId/);
	assert.match(startRunSource, /errorContext: result\.errorContext/);
	assert.doesNotMatch(startRunSource, /schema: result/);
});
