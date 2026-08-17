import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { SqlEditorExecutionSource } from '../../sqlEditor/common/sqlEditorModel.js';
import { canApplyAgentFixToEditor } from '../common/sqlAgentFixContext.js';

const advancedActionsSource = readFileSync(new URL('../browser/sqlAdvancedActions.ts', import.meta.url), 'utf8');

const target = {
	editorId: 'query-1',
	versionId: 7,
	sql: 'SELECT totl FROM orders;'
};

const query = {
	editorId: 'query-1',
	editorVersionId: 7,
	connectionId: 'local',
	sql: 'SELECT totl FROM orders',
	source: SqlEditorExecutionSource.All
};

test('Fix with Agent can apply a single Run All draft to its unchanged editor', () => {
	assert.equal(canApplyAgentFixToEditor(query, target, 'local'), true);
});

test('Fix with Agent refuses an editor changed after the failed execution', () => {
	assert.equal(canApplyAgentFixToEditor(query, { ...target, versionId: 8 }, 'local'), false);
});

test('Fix with Agent refuses to replace a multi-statement editor for one failed statement', () => {
	assert.equal(
		canApplyAgentFixToEditor(query, { ...target, sql: 'SELECT 1; SELECT totl FROM orders;' }, 'local'),
		false
	);
});

test('Fix with Agent refuses selection, editor, and connection mismatches', () => {
	assert.equal(
		canApplyAgentFixToEditor({ ...query, source: SqlEditorExecutionSource.Selection }, target, 'local'),
		false
	);
	assert.equal(canApplyAgentFixToEditor(query, { ...target, editorId: 'query-2' }, 'local'), false);
	assert.equal(canApplyAgentFixToEditor(query, target, 'other'), false);
});

test('Fix with Agent revalidates its editor context after the user chooses Apply', () => {
	const choiceIndex = advancedActionsSource.indexOf('const choice = await quickInputService.pick');
	const finalValidationIndex = advancedActionsSource.indexOf('isApplyStillAllowed?.()');

	assert.ok(choiceIndex >= 0);
	assert.ok(finalValidationIndex > choiceIndex);
});

test('legacy AI draft captures its artifact target before provider completion', () => {
	const actionStart = advancedActionsSource.indexOf('async function openAiResult');
	const actionSource = advancedActionsSource.slice(actionStart);
	const targetIndex = actionSource.indexOf('const baseTarget =');
	const providerIndex = actionSource.indexOf('await advancedService.completeAi');
	const artifactIndex = actionSource.indexOf('createSqlAgentArtifactForTarget');
	const lateTargetIndex = actionSource.indexOf('getAgentArtifactTarget()', providerIndex);

	assert.ok(actionStart >= 0);
	assert.ok(targetIndex >= 0 && targetIndex < providerIndex);
	assert.ok(artifactIndex > providerIndex);
	assert.equal(lateTargetIndex, -1);
});

test('Optimize Query delegates to the A5 runtime without the legacy AI provider', () => {
	const actionStart = advancedActionsSource.indexOf('async function optimizeCurrentSql');
	const actionEnd = advancedActionsSource.indexOf('async function fixSqlResultError', actionStart);
	const actionSource = advancedActionsSource.slice(actionStart, actionEnd);

	assert.ok(actionStart >= 0 && actionEnd > actionStart);
	assert.equal(actionSource.includes('ISqlAdvancedService'), false);
	assert.equal(actionSource.includes('completeAi'), false);
	assert.ok(actionSource.includes('task: SqlAgentTaskKind.OptimizeQuery'));
	assert.ok(actionSource.includes('mode: SqlAgentMode.ReadOnly'));
});

test('Optimize Query captures a full stale-safe target before dispatch and sends no frontend evidence', () => {
	const actionStart = advancedActionsSource.indexOf('async function optimizeCurrentSql');
	const actionEnd = advancedActionsSource.indexOf('async function fixSqlResultError', actionStart);
	const actionSource = advancedActionsSource.slice(actionStart, actionEnd);
	const targetIndex = actionSource.indexOf('const baseTarget = pane.getAgentArtifactTarget()');
	const dispatchIndex = actionSource.indexOf('await agentService.start');

	assert.ok(actionStart >= 0 && actionEnd > actionStart);
	assert.ok(targetIndex >= 0 && targetIndex < dispatchIndex);
	assert.ok(actionSource.includes('connectionId: context.connectionId'));
	assert.ok(actionSource.includes('editorId: baseTarget.editorId'));
	assert.ok(actionSource.includes('editorVersionId: baseTarget.versionId'));
	assert.ok(actionSource.includes('sql: baseTarget.sql'));
	assert.equal(actionSource.includes('selectedSql:'), false);
	assert.equal(actionSource.includes('schema:'), false);
	assert.equal(actionSource.includes('resultShape:'), false);
	assert.ok(actionSource.includes('SqlCapability.AgentTool'));
	assert.ok(actionSource.includes('SqlCapability.DatabaseReadMetadata'));
	assert.ok(actionSource.includes('SqlCapability.DatabaseExplain'));
});

test('Optimize Query disables Apply when the captured editor identity, version, or SQL changes', () => {
	const actionStart = advancedActionsSource.indexOf('async function optimizeCurrentSql');
	const actionEnd = advancedActionsSource.indexOf('async function fixSqlResultError', actionStart);
	const actionSource = advancedActionsSource.slice(actionStart, actionEnd);
	const guardStart = actionSource.indexOf('const isApplyStillAllowed = () =>');
	const guardEnd = actionSource.indexOf('await applyAgentAnswerDraft', guardStart);
	const guard = actionSource.slice(guardStart, guardEnd);

	assert.ok(guardStart >= 0 && guardEnd > guardStart);
	assert.ok(guard.includes('currentTarget?.editorId === baseTarget.editorId'));
	assert.ok(guard.includes('currentTarget?.versionId === baseTarget.versionId'));
	assert.ok(guard.includes('currentTarget?.sql === baseTarget.sql'));
});

test('schema AI draft captures its artifact target before prompting', () => {
	const actionStart = advancedActionsSource.indexOf('class SchemaGenerateQueryAction');
	const actionEnd = advancedActionsSource.indexOf('class ResultAssistantAction', actionStart);
	const actionSource = advancedActionsSource.slice(actionStart, actionEnd);
	const targetIndex = actionSource.indexOf('const artifactTarget =');
	const promptIndex = actionSource.indexOf('await quickInputService.input');

	assert.ok(actionStart >= 0 && actionEnd > actionStart);
	assert.ok(targetIndex >= 0 && targetIndex < promptIndex);
});

test('schema-aware Generate delegates metadata lookup to the backend', () => {
	const actionStart = advancedActionsSource.indexOf('class SchemaGenerateQueryAction');
	const actionEnd = advancedActionsSource.indexOf('class ResultAssistantAction', actionStart);
	const actionSource = advancedActionsSource.slice(actionStart, actionEnd);

	assert.ok(actionStart >= 0 && actionEnd > actionStart);
	assert.equal(actionSource.includes('accessor.get(ISqlMetadataService)'), false);
	assert.equal(actionSource.includes('loadAgentSchema'), false);
	assert.equal(actionSource.includes('\n\t\t\t\t\tschema'), false);
	assert.ok(actionSource.includes('connectionId: context.connectionId'));
	assert.ok(actionSource.includes('SqlCapability.DatabaseReadMetadata'));
});

test('Result Assistant uses the visible Result Panel history snapshot', () => {
	const actionStart = advancedActionsSource.indexOf('class ResultAssistantAction');
	const actionEnd = advancedActionsSource.indexOf('function createResultShape', actionStart);
	const actionSource = advancedActionsSource.slice(actionStart, actionEnd);

	assert.ok(actionStart >= 0 && actionEnd > actionStart);
	assert.match(
		actionSource,
		/const state = getSqlResultPanelContentState\(resultService\.state, resultService\.panelState\)/
	);
	assert.equal(actionSource.includes('const state = resultService.state;'), false);
});

test('Fix with Agent delegates schema lookup and sends the failed editor identity', () => {
	const actionStart = advancedActionsSource.indexOf('async function fixSqlResultError');
	const actionEnd = advancedActionsSource.indexOf('function toActionErrorMessage', actionStart);
	const actionSource = advancedActionsSource.slice(actionStart, actionEnd);

	assert.ok(actionStart >= 0 && actionEnd > actionStart);
	assert.equal(actionSource.includes('accessor.get(ISqlMetadataService)'), false);
	assert.equal(actionSource.includes('loadAgentSchema'), false);
	assert.equal(actionSource.includes('\n\t\t\t\tschema'), false);
	assert.ok(actionSource.includes('editorId: state.query.editorId'));
	assert.ok(actionSource.includes('editorVersionId: state.query.editorVersionId'));
	assert.ok(actionSource.includes('SqlCapability.DatabaseReadMetadata'));
});

test('Agent actions reveal the Panel idempotently instead of toggling it', () => {
	assert.equal(advancedActionsSource.includes("executeCommand('sql.agent.openPanel')"), false);
	assert.match(advancedActionsSource, /async function revealSqlAgentPanel\(viewsService: IViewsService\)/);
	assert.match(advancedActionsSource, /await viewsService\.openView\(SQL_AGENT_VIEW_ID, false\)/);
	assert.equal(advancedActionsSource.match(/await revealSqlAgentPanel\(viewsService\)/g)?.length, 4);
	assert.equal(advancedActionsSource.match(/const viewsService = accessor\.get\(IViewsService\);/g)?.length, 4);
});
