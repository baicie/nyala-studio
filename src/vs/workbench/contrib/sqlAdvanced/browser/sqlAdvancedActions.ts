/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - advanced command actions.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { SqlDialect } from '../../../services/sql/common/sqlDialect.js';
import {
	SQL_AI_ASSISTANT_COMMAND_ID,
	SQL_AI_EXPLAIN_ERROR_COMMAND_ID,
	SQL_AI_GENERATE_QUERY_COMMAND_ID,
	SQL_AI_OPTIMIZE_QUERY_COMMAND_ID,
	SQL_EXPLAIN_PLAN_COMMAND_ID,
	SQL_INSERT_SNIPPET_COMMAND_ID,
	SQL_LIST_PLUGINS_COMMAND_ID,
	SQL_OPEN_WORKSPACE_COMMAND_ID
} from '../common/sqlAdvanced.js';
import { ISqlAdvancedService } from '../common/sqlAdvancedService.js';
import { applySnippetVariables } from '../common/sqlAdvancedSnippets.js';
import { SqlAiTaskKind } from '../common/sqlAdvancedAi.js';
import { SqlEditorPane } from '../../sqlEditor/browser/sqlEditorPane.js';
import { SQL_NEW_QUERY_COMMAND_ID } from '../../sqlEditor/common/sqlEditor.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

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
			title: localize2('sqlInsertSnippet', 'SQL: Insert SELECT Snippet'),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const advancedService = accessor.get(ISqlAdvancedService);
		const commandService = accessor.get(ICommandService);
		const snippet = advancedService.listSnippets().find(item => item.id === 'builtin.select.all');

		const initialSql = snippet
			? applySnippetVariables(snippet.body, {
				table: 'users',
				limit: '100'
			})
			: 'SELECT 1 AS value;';

		await commandService.executeCommand(SQL_NEW_QUERY_COMMAND_ID, {
			initialSql
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

async function openAiResult(accessor: ServicesAccessor, kind: SqlAiTaskKind): Promise<void> {
	const advancedService = accessor.get(ISqlAdvancedService);
	const commandService = accessor.get(ICommandService);

	const response = await advancedService.completeAi({
		kind,
		context: {
			dialect: SqlDialect.Sqlite,
			userPrompt: 'Help me write a SQL query.',
			schema: [
				{
					name: 'users',
					columns: ['id', 'name', 'created_at']
				}
			]
		}
	});

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
registerAction2(AiGenerateQueryAction);
registerAction2(AiOptimizeQueryAction);
