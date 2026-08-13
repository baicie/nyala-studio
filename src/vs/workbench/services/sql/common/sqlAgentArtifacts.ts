/*---------------------------------------------------------------------------------------------
 * SQL Agent editor artifacts.
 *
 * Artifacts are transient proposals. Applying one is guarded by the editor identity,
 * document version, and exact source text captured when the Agent response started.
 *--------------------------------------------------------------------------------------------*/

export const enum SqlAgentArtifactKind {
	SqlDraft = 'sql_draft',
	SqlPatch = 'sql_patch',
	Answer = 'answer'
}

export interface SqlAgentArtifact {
	readonly artifactId: string;
	readonly runId: string;
	readonly editorId: string;
	readonly kind: SqlAgentArtifactKind;
	readonly baseVersionId: number;
	readonly baseSql: string;
	readonly content: string;
	readonly createdAt: number;
}

export type SqlAgentArtifactApplyResult =
	| { readonly applied: true; readonly sql: string }
	| { readonly applied: false; readonly reason: 'editor' | 'version' | 'content' | 'empty' };

export interface SqlAgentArtifactTarget {
	readonly editorId: string;
	readonly versionId: number;
	readonly sql: string;
}

export function createSqlAgentArtifact(input: {
	readonly artifactId: string;
	readonly runId: string;
	readonly editorId: string;
	readonly baseVersionId: number;
	readonly baseSql: string;
	readonly content: string;
	readonly kind?: SqlAgentArtifactKind;
	readonly createdAt?: number;
}): SqlAgentArtifact {
	const content = input.content.trim();
	if (!content) {
		throw new Error('Agent artifact content is required.');
	}
	if (!input.editorId.trim() || !input.runId.trim() || !input.artifactId.trim()) {
		throw new Error('Agent artifact identity is required.');
	}
	if (!Number.isInteger(input.baseVersionId) || input.baseVersionId < 1) {
		throw new Error('Agent artifact base version is invalid.');
	}

	return {
		artifactId: input.artifactId.trim(),
		runId: input.runId.trim(),
		editorId: input.editorId.trim(),
		kind: input.kind ?? SqlAgentArtifactKind.SqlDraft,
		baseVersionId: input.baseVersionId,
		baseSql: input.baseSql,
		content,
		createdAt: input.createdAt ?? Date.now()
	};
}

export function createSqlAgentArtifactForTarget(input: {
	readonly artifactId: string;
	readonly runId: string;
	readonly target: SqlAgentArtifactTarget;
	readonly content: string;
	readonly kind?: SqlAgentArtifactKind;
	readonly createdAt?: number;
}): SqlAgentArtifact {
	return createSqlAgentArtifact({
		artifactId: input.artifactId,
		runId: input.runId,
		editorId: input.target.editorId,
		baseVersionId: input.target.versionId,
		baseSql: input.target.sql,
		content: input.content,
		kind: input.kind,
		createdAt: input.createdAt
	});
}

export function applySqlAgentArtifact(
	artifact: SqlAgentArtifact,
	target: SqlAgentArtifactTarget
): SqlAgentArtifactApplyResult {
	if (!artifact.content.trim()) {
		return { applied: false, reason: 'empty' };
	}
	if (target.editorId !== artifact.editorId) {
		return { applied: false, reason: 'editor' };
	}
	if (target.versionId !== artifact.baseVersionId) {
		return { applied: false, reason: 'version' };
	}
	if (target.sql !== artifact.baseSql) {
		return { applied: false, reason: 'content' };
	}
	return { applied: true, sql: artifact.content };
}

export function getSqlAgentArtifactStaleReason(
	artifact: SqlAgentArtifact,
	target: SqlAgentArtifactTarget
): Exclude<SqlAgentArtifactApplyResult, { applied: true }>['reason'] | undefined {
	const result = applySqlAgentArtifact(artifact, target);
	if (!('reason' in result)) {
		return undefined;
	}
	return result.reason;
}
