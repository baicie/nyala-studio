import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { projectSqlAgentRunEvent, getSqlAgentPanelStatus } from '../common/sqlAgentPanelModel.js';

const agentViewSource = readFileSync(new URL('../browser/sqlAgentView.ts', import.meta.url), 'utf8');
const agentStylesSource = readFileSync(new URL('../browser/media/sqlAgent.css', import.meta.url), 'utf8');

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
			answer: { title: 'Answer', content: 'Done' },
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
	assert.deepEqual(projection.toolCalls, [
		{ callId: 'call-1', tool: 'sql.execute_readonly', contextRefs: ['schema-1'] }
	]);
	assert.deepEqual(projection.warnings, []);
	assert.equal(projection.queryCallCount, 1);
	assert.equal(getSqlAgentPanelStatus(projection), 'completed');
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

test('Agent panel exposes stable screen-reader names and live status semantics', () => {
	assert.match(agentViewSource, /'aria-label': 'Agent prompt'/);
	assert.match(agentViewSource, /setAttribute\('aria-label', 'Agent task'\)/);
	assert.match(agentViewSource, /setAttribute\('aria-label', 'Agent access mode'\)/);
	assert.match(agentViewSource, /role: 'status', 'aria-live': 'polite'/);
	assert.match(agentViewSource, /'aria-label': 'Agent evidence'/);
	assert.match(agentViewSource, /role: 'article'/);
	assert.match(agentViewSource, /'aria-label': 'Agent activity'/);
	assert.match(agentViewSource, /'aria-label': 'Agent warnings'/);
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
