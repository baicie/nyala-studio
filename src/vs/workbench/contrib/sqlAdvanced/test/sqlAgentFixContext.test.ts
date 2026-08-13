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

test('schema AI draft captures its artifact target before prompting', () => {
	const actionStart = advancedActionsSource.indexOf('class SchemaGenerateQueryAction');
	const actionEnd = advancedActionsSource.indexOf('class ResultAssistantAction', actionStart);
	const actionSource = advancedActionsSource.slice(actionStart, actionEnd);
	const targetIndex = actionSource.indexOf('const artifactTarget =');
	const promptIndex = actionSource.indexOf('await quickInputService.input');

	assert.ok(actionStart >= 0 && actionEnd > actionStart);
	assert.ok(targetIndex >= 0 && targetIndex < promptIndex);
});
