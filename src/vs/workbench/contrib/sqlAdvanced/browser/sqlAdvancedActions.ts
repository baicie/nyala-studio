/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - advanced command actions.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { getDialectForConnectionKind, SqlDialect } from '../../../services/sql/common/sqlDialect.js';
import {
	SQL_AI_ASSISTANT_COMMAND_ID,
	SQL_AI_EXPLAIN_ERROR_COMMAND_ID,
	SQL_AI_FIX_ERROR_COMMAND_ID,
	SQL_AI_GENERATE_QUERY_COMMAND_ID,
	SQL_AI_OPTIMIZE_QUERY_COMMAND_ID,
	SQL_AI_RESULT_ASSISTANT_COMMAND_ID,
	SQL_AI_SCHEMA_GENERATE_QUERY_COMMAND_ID,
	SQL_EXPLAIN_PLAN_COMMAND_ID,
	SQL_INSERT_SNIPPET_COMMAND_ID,
	SQL_LIST_PLUGINS_COMMAND_ID,
	SQL_OPEN_WORKSPACE_COMMAND_ID
} from '../common/sqlAdvanced.js';
import { ISqlAdvancedService } from '../common/sqlAdvancedService.js';
import { renderSnippetWithDefaults } from '../common/sqlAdvancedSnippets.js';
import { SqlAiTaskKind } from '../common/sqlAdvancedAi.js';
import { SqlEditorPane } from '../../sqlEditor/browser/sqlEditorPane.js';
import { SQL_NEW_QUERY_COMMAND_ID } from '../../sqlEditor/common/sqlEditor.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import {
	createSqlAgentArtifactForTarget,
	SqlAgentArtifactTarget
} from '../../../services/sql/common/sqlAgentArtifacts.js';
import {
	ISqlAgentService,
	SqlAgentMode,
	SqlAgentErrorContext,
	SqlAgentResultShape,
	SqlAgentTaskKind
} from '../../../services/sql/common/sqlAgent.js';
import { SqlCapability } from '../../../services/sql/common/sqlCapabilities.js';
import { ISqlMetadataService } from '../../../services/sql/common/sqlMetadata.js';
import { ISqlResultService } from '../../sqlResult/common/sqlResultService.js';
import { getSqlResultPanelContentState, SqlResultStateKind } from '../../sqlResult/common/sqlResultModel.js';
import { canApplyAgentFixToEditor } from '../common/sqlAgentFixContext.js';
import { loadAgentSchema } from '../common/sqlAgentSchemaLoader.js';

class ExplainPlanAction extends Action2 {
	constructor() {
		super({
			id: SQL_EXPLAIN_PLAN_COMMAND_ID,
			title: localize2('sqlExplainPlan', 'SQL: Explain Plan'),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);
		const pane = editorService.activeEditorPane;

		if (pane instanceof SqlEditorPane) {
			await pane.explainPlan();
			return;
		}

		notificationService.info('Open a SQL Query editor before explaining SQL.');
	}
}

class InsertSnippetAction extends Action2 {
	constructor() {
		super({
			id: SQL_INSERT_SNIPPET_COMMAND_ID,
			title: localize2('sqlInsertSnippet', 'SQL: Insert Snippet'),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const advancedService = accessor.get(ISqlAdvancedService);
		const commandService = accessor.get(ICommandService);
		const quickInputService = accessor.get(IQuickInputService);
		const picked = await quickInputService.pick(
			advancedService.listSnippets().map(snippet => ({
				label: snippet.name,
				description: snippet.description,
				snippet
			})),
			{ placeHolder: 'Select a SQL snippet' }
		);

		if (!picked) {
			return;
		}

		await commandService.executeCommand(SQL_NEW_QUERY_COMMAND_ID, {
			initialSql: renderSnippetWithDefaults(picked.snippet)
		});
	}
}

class OpenWorkspaceAction extends Action2 {
	constructor() {
		super({
			id: SQL_OPEN_WORKSPACE_COMMAND_ID,
			title: localize2('sqlOpenWorkspace', 'SQL: Show Workspace Project'),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const advancedService = accessor.get(ISqlAdvancedService);
		const notificationService = accessor.get(INotificationService);
		const workspace = advancedService.getWorkspace();

		notificationService.info(`Workspace: ${workspace.name}`);
	}
}

class ListPluginsAction extends Action2 {
	constructor() {
		super({
			id: SQL_LIST_PLUGINS_COMMAND_ID,
			title: localize2('sqlListPlugins', 'SQL: List Plugins'),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const advancedService = accessor.get(ISqlAdvancedService);
		const notificationService = accessor.get(INotificationService);
		const plugins = advancedService.listPlugins();

		notificationService.info(`Registered SQL plugins: ${plugins.length}`);
	}
}

class AiAssistantAction extends Action2 {
	constructor() {
		super({
			id: SQL_AI_ASSISTANT_COMMAND_ID,
			title: localize2('sqlAiAssistant', 'SQL AI: Assistant'),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openAiResult(accessor, SqlAiTaskKind.Assistant);
	}
}

class AiExplainErrorAction extends Action2 {
	constructor() {
		super({
			id: SQL_AI_EXPLAIN_ERROR_COMMAND_ID,
			title: localize2('sqlAiExplainError', 'SQL AI: Explain Error'),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openAiResult(accessor, SqlAiTaskKind.ExplainError);
	}
}

class AiFixErrorAction extends Action2 {
	constructor() {
		super({
			id: SQL_AI_FIX_ERROR_COMMAND_ID,
			title: localize2('sqlAiFixError', 'SQL AI: Fix Error'),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await fixSqlResultError(accessor);
	}
}

class AiGenerateQueryAction extends Action2 {
	constructor() {
		super({
			id: SQL_AI_GENERATE_QUERY_COMMAND_ID,
			title: localize2('sqlAiGenerateQuery', 'SQL AI: Generate Query'),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openAiResult(accessor, SqlAiTaskKind.GenerateQuery);
	}
}

class AiOptimizeQueryAction extends Action2 {
	constructor() {
		super({
			id: SQL_AI_OPTIMIZE_QUERY_COMMAND_ID,
			title: localize2('sqlAiOptimizeQuery', 'SQL AI: Optimize Query'),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openAiResult(accessor, SqlAiTaskKind.OptimizeQuery);
	}
}

class SchemaGenerateQueryAction extends Action2 {
	constructor() {
		super({
			id: SQL_AI_SCHEMA_GENERATE_QUERY_COMMAND_ID,
			title: localize2('sqlAiSchemaGenerateQuery', 'SQL AI: Generate from Schema'),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);
		const quickInputService = accessor.get(IQuickInputService);
		const agentService = accessor.get(ISqlAgentService);
		const metadataService = accessor.get(ISqlMetadataService);
		const commandService = accessor.get(ICommandService);
		const pane = editorService.activeEditorPane;
		if (!(pane instanceof SqlEditorPane)) {
			notificationService.info('Open a SQL Query editor before generating from schema.');
			return;
		}

		const context = pane.getAssistantContext();
		const artifactTarget = pane.getAgentArtifactTarget();
		if (!context.connectionId) {
			notificationService.info('Select a database connection before generating from schema.');
			return;
		}
		const goal = await quickInputService.input({
			prompt: 'Describe the query to generate from the current schema',
			placeHolder: 'For example: list recent orders with customer names'
		});
		if (!goal?.trim()) {
			return;
		}

		try {
			const schema = await loadAgentSchema(metadataService, context.connectionId);
			const event = await agentService.start({
				goal: goal.trim(),
				task: SqlAgentTaskKind.GenerateQuery,
				mode: SqlAgentMode.SuggestOnly,
				context: {
					dialect: context.connectionKind ? getDialectForConnectionKind(context.connectionKind) : SqlDialect.Sqlite,
					connectionId: context.connectionId,
					sql: context.sql,
					selectedSql: context.selectedSql,
					userPrompt: goal.trim(),
					schema
				},
				capabilities: [SqlCapability.AgentTool, SqlCapability.WorkspaceReadSql]
			});
			await commandService.executeCommand('sql.agent.openPanel');
			await applyAgentAnswerDraft(pane, event, quickInputService, notificationService, commandService, artifactTarget);
		} catch (error) {
			notificationService.error(toActionErrorMessage(error));
		}
	}
}

class ResultAssistantAction extends Action2 {
	constructor() {
		super({
			id: SQL_AI_RESULT_ASSISTANT_COMMAND_ID,
			title: localize2('sqlAiResultAssistant', 'SQL AI: Explain Result'),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const resultService = accessor.get(ISqlResultService);
		const agentService = accessor.get(ISqlAgentService);
		const commandService = accessor.get(ICommandService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		const state = resultService.state;
		if (state.kind !== SqlResultStateKind.Success && state.kind !== SqlResultStateKind.Error) {
			notificationService.info('Run a SQL query before asking about its result.');
			return;
		}

		const prompt = await quickInputService.input({
			prompt:
				state.kind === SqlResultStateKind.Error
					? 'Ask Agent to explain the SQL error'
					: 'Ask Agent about this SQL result',
			placeHolder: 'For example: explain the columns and likely next step'
		});
		if (!prompt?.trim()) {
			return;
		}

		const pane = editorService.activeEditorPane;
		const editorContext = pane instanceof SqlEditorPane ? pane.getAssistantContext() : undefined;
		const dialect = editorContext?.connectionKind
			? getDialectForConnectionKind(editorContext.connectionKind)
			: SqlDialect.Sqlite;
		try {
			const event = await agentService.start({
				goal: prompt.trim(),
				task: state.kind === SqlResultStateKind.Error ? SqlAgentTaskKind.ExplainError : SqlAgentTaskKind.Assistant,
				mode: SqlAgentMode.SuggestOnly,
				context: {
					dialect,
					connectionId: state.query.connectionId,
					sql: state.query.sql,
					userPrompt: prompt.trim(),
					errorMessage: state.kind === SqlResultStateKind.Error ? state.errorMessage : undefined,
					resultShape: state.kind === SqlResultStateKind.Success ? createResultShape(state.result) : undefined
				},
				capabilities: [SqlCapability.AgentTool, SqlCapability.WorkspaceReadSql]
			});
			await commandService.executeCommand('sql.agent.openPanel');
			if (event.error) {
				notificationService.error(event.error.message);
			}
		} catch (error) {
			notificationService.error(toActionErrorMessage(error));
		}
	}
}

function createResultShape(result: {
	columns: readonly { name: string; ordinal: number }[];
	rowCount: number;
	elapsedMs: number;
	truncated: boolean;
}): SqlAgentResultShape {
	return {
		columns: result.columns.map(column => ({ name: column.name, ordinal: column.ordinal })),
		rowCount: result.rowCount,
		elapsedMs: result.elapsedMs,
		truncated: result.truncated
	};
}

export async function applyAgentAnswerDraft(
	pane: SqlEditorPane,
	event: Awaited<ReturnType<ISqlAgentService['start']>>,
	quickInputService: IQuickInputService,
	notificationService: INotificationService,
	commandService: ICommandService,
	baseTarget: SqlAgentArtifactTarget | undefined,
	allowApply = true,
	isApplyStillAllowed?: () => boolean
): Promise<void> {
	const sql = event.result?.answer?.sql?.trim();
	if (!sql) {
		return;
	}
	const canApply = allowApply && baseTarget !== undefined;
	const choice = await quickInputService.pick(
		[
			...(canApply ? [{ label: 'Apply draft to current editor' }] : []),
			{ label: 'Open draft in new query' },
			{ label: 'Cancel' }
		],
		{ placeHolder: 'Choose how to handle the SQL draft' }
	);
	if (!choice || choice.label === 'Cancel') {
		return;
	}
	if (choice.label === 'Apply draft to current editor') {
		if (!canApply || !baseTarget) {
			return;
		}
		if (isApplyStillAllowed?.() === false) {
			notificationService.warn('The SQL editor context changed. The draft was not applied.');
			return;
		}
		const artifact = createSqlAgentArtifactForTarget({
			artifactId: `artifact-${Date.now()}`,
			runId: event.run.runId,
			target: baseTarget,
			content: sql
		});
		const applied = pane.applyAgentArtifact(artifact);
		if (!applied.applied) {
			notificationService.warn('The SQL editor changed while the draft was generated. The draft was not applied.');
			return;
		}
		notificationService.info('SQL draft applied to the editor. Review it before running.');
		return;
	}
	await commandService.executeCommand(SQL_NEW_QUERY_COMMAND_ID, { initialSql: sql });
}

async function fixSqlResultError(accessor: ServicesAccessor): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const resultService = accessor.get(ISqlResultService);
	const agentService = accessor.get(ISqlAgentService);
	const metadataService = accessor.get(ISqlMetadataService);
	const commandService = accessor.get(ICommandService);
	const quickInputService = accessor.get(IQuickInputService);
	const notificationService = accessor.get(INotificationService);
	const state = getSqlResultPanelContentState(resultService.state, resultService.panelState);
	if (state.kind !== SqlResultStateKind.Error) {
		notificationService.info('Run a SQL query that fails before asking Agent to fix it.');
		return;
	}
	const pane = editorService.activeEditorPane;
	if (!(pane instanceof SqlEditorPane)) {
		notificationService.info('Open the failed SQL editor before asking Agent to fix it.');
		return;
	}
	const context = pane.getAssistantContext();
	if (!context.editorId || context.editorId !== state.query.editorId) {
		notificationService.info('Open the editor that produced this SQL error before asking Agent to fix it.');
		return;
	}
	if (!context.connectionId || context.connectionId !== state.query.connectionId) {
		notificationService.info('Restore the failed query connection before asking Agent to fix SQL.');
		return;
	}
	const goal = 'Fix the failed SQL using the supplied error and schema columns.';
	const baseTarget = pane.getAgentArtifactTarget();
	const canApplyAtRequest = canApplyAgentFixToEditor(state.query, baseTarget, context.connectionId);
	try {
		const schema = await loadAgentSchema(metadataService, state.query.connectionId);
		const errorContext: SqlAgentErrorContext = state.errorContext;
		const event = await agentService.start({
			goal,
			task: SqlAgentTaskKind.FixError,
			mode: SqlAgentMode.SuggestOnly,
			context: {
				dialect: context.connectionKind ? getDialectForConnectionKind(context.connectionKind) : SqlDialect.Sqlite,
				connectionId: state.query.connectionId,
				sql: state.query.sql,
				errorMessage: state.errorMessage,
				errorContext,
				userPrompt: goal,
				schema
			},
			capabilities: [SqlCapability.AgentTool, SqlCapability.WorkspaceReadSql, SqlCapability.DatabaseReadMetadata]
		});
		await commandService.executeCommand('sql.agent.openPanel');
		const isApplyStillAllowed = () => {
			const currentContext = pane.getAssistantContext();
			return (
				editorService.activeEditorPane === pane &&
				canApplyAgentFixToEditor(state.query, pane.getAgentArtifactTarget(), currentContext.connectionId)
			);
		};
		const allowApply = canApplyAtRequest && isApplyStillAllowed();
		await applyAgentAnswerDraft(
			pane,
			event,
			quickInputService,
			notificationService,
			commandService,
			baseTarget,
			allowApply,
			isApplyStillAllowed
		);
	} catch (error) {
		notificationService.error(toActionErrorMessage(error));
	}
}

function toActionErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function openAiResult(accessor: ServicesAccessor, kind: SqlAiTaskKind): Promise<void> {
	const advancedService = accessor.get(ISqlAdvancedService);
	const commandService = accessor.get(ICommandService);
	const editorService = accessor.get(IEditorService);
	const quickInputService = accessor.get(IQuickInputService);
	const notificationService = accessor.get(INotificationService);
	const pane = editorService.activeEditorPane;
	const editorContext = pane instanceof SqlEditorPane ? pane.getAssistantContext() : undefined;
	const baseTarget = pane instanceof SqlEditorPane ? pane.getAgentArtifactTarget() : undefined;
	const dialect = editorContext?.connectionKind
		? getDialectForConnectionKind(editorContext.connectionKind)
		: SqlDialect.Sqlite;

	let userPrompt: string | undefined;
	let errorMessage: string | undefined;

	if (kind === SqlAiTaskKind.Assistant || kind === SqlAiTaskKind.GenerateQuery) {
		userPrompt = await quickInputService.input({
			prompt:
				kind === SqlAiTaskKind.GenerateQuery
					? 'Describe the SQL query to generate'
					: 'How should Nyala help with this SQL?',
			placeHolder: 'Enter a request for the SQL assistant'
		});

		if (!userPrompt?.trim()) {
			return;
		}
	}

	if (kind === SqlAiTaskKind.ExplainError) {
		errorMessage = await quickInputService.input({
			prompt: 'Paste the SQL error to explain',
			placeHolder: 'Database error message'
		});

		if (!errorMessage?.trim()) {
			return;
		}
	}

	const response = await advancedService.completeAi({
		kind,
		context: {
			dialect,
			connectionName: editorContext?.connectionName,
			sql: editorContext?.sql,
			selectedSql: editorContext?.selectedSql,
			userPrompt: userPrompt?.trim(),
			errorMessage: errorMessage?.trim()
		}
	});

	if (response.sql?.trim() && pane instanceof SqlEditorPane) {
		if (baseTarget) {
			const artifact = createSqlAgentArtifactForTarget({
				artifactId: `artifact-${Date.now()}`,
				runId: `ai-draft-${Date.now()}`,
				target: baseTarget,
				content: response.sql
			});
			const choice = await quickInputService.pick(
				[{ label: 'Apply draft to current editor' }, { label: 'Open draft in new query' }, { label: 'Cancel' }],
				{ placeHolder: 'Choose how to handle the SQL draft' }
			);
			if (!choice || choice.label === 'Cancel') {
				return;
			}
			if (choice.label === 'Apply draft to current editor') {
				const applied = pane.applyAgentArtifact(artifact);
				if (!applied.applied) {
					notificationService.warn('The SQL editor changed while the draft was generated. The draft was not applied.');
					return;
				}
				notificationService.info('SQL draft applied to the editor. Review it before running.');
				return;
			}
		}
	}

	await commandService.executeCommand(SQL_NEW_QUERY_COMMAND_ID, {
		initialSql: response.sql ?? `-- ${response.title}\n${response.content}`
	});
}

registerAction2(ExplainPlanAction);
registerAction2(InsertSnippetAction);
registerAction2(OpenWorkspaceAction);
registerAction2(ListPluginsAction);
registerAction2(AiAssistantAction);
registerAction2(AiExplainErrorAction);
registerAction2(AiFixErrorAction);
registerAction2(AiGenerateQueryAction);
registerAction2(AiOptimizeQueryAction);
registerAction2(SchemaGenerateQueryAction);
registerAction2(ResultAssistantAction);
