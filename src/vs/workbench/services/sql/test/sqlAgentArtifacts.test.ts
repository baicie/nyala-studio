import assert from 'node:assert/strict';
import test from 'node:test';

import {
	applySqlAgentArtifact,
	createSqlAgentArtifact,
	createSqlAgentArtifactForTarget,
	getSqlAgentArtifactStaleReason,
	SqlAgentArtifactKind
} from '../common/sqlAgentArtifacts.js';

function artifact() {
	return createSqlAgentArtifact({
		artifactId: 'artifact-1',
		runId: 'run-1',
		editorId: 'editor-1',
		baseVersionId: 7,
		baseSql: 'SELECT 1;',
		content: 'SELECT 2;',
		kind: SqlAgentArtifactKind.SqlDraft,
		createdAt: 100
	});
}

test('SQL Agent artifact applies only to its captured editor version and content', () => {
	const result = applySqlAgentArtifact(artifact(), {
		editorId: 'editor-1',
		versionId: 7,
		sql: 'SELECT 1;'
	});

	assert.deepEqual(result, { applied: true, sql: 'SELECT 2;' });
});

test('SQL Agent artifact refuses stale editor content without overwriting it', () => {
	const source = artifact();
	assert.equal(
		getSqlAgentArtifactStaleReason(source, {
			editorId: 'editor-1',
			versionId: 8,
			sql: 'SELECT 1;'
		}),
		'version'
	);
	assert.equal(
		applySqlAgentArtifact(source, {
			editorId: 'editor-1',
			versionId: 7,
			sql: 'SELECT user_edited;'
		}).applied,
		false
	);
});

test('SQL Agent draft captured before an async run refuses an editor changed while the run is pending', async () => {
	let editor = {
		editorId: 'editor-1',
		versionId: 7,
		sql: 'SELECT missing FROM orders;'
	};
	const capturedTarget = { ...editor };
	const agentResponse = Promise.resolve('SELECT id FROM orders;');

	editor = {
		...editor,
		versionId: 8,
		sql: 'SELECT total FROM orders;'
	};
	const artifact = createSqlAgentArtifactForTarget({
		artifactId: 'artifact-async',
		runId: 'run-async',
		target: capturedTarget,
		content: await agentResponse,
		createdAt: 101
	});
	const result = applySqlAgentArtifact(artifact, editor);

	assert.deepEqual(result, { applied: false, reason: 'version' });
	assert.equal(editor.sql, 'SELECT total FROM orders;');
});

test('SQL Agent artifact normalizes identity and rejects invalid proposals', () => {
	const normalized = createSqlAgentArtifact({
		artifactId: ' artifact-2 ',
		runId: ' run-2 ',
		editorId: ' editor-2 ',
		baseVersionId: 1,
		baseSql: '',
		content: ' SELECT 3; '
	});
	assert.equal(normalized.artifactId, 'artifact-2');
	assert.equal(normalized.content, 'SELECT 3;');
	assert.throws(() => createSqlAgentArtifact({ ...normalized, content: ' ' }), /required/);
});
