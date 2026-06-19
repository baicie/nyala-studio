/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor commands.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ISqlConnectionService } from '../../../services/sql/common/sqlConnection.js';
import {
	SQL_EXECUTE_CURRENT_STATEMENT_COMMAND_ID,
	SQL_EXECUTE_QUERY_COMMAND_ID,
	SQL_EXECUTE_SELECTION_COMMAND_ID,
	SQL_FORMAT_QUERY_COMMAND_ID,
	SQL_NEW_QUERY_COMMAND_ID
} from '../common/sqlEditor.js';
import { SqlEditorExecutionSource } from '../common/sqlEditorModel.js';
import { SqlEditorInput } from '../common/sqlEditorInput.js';
import { SqlEditorPane } from './sqlEditorPane.js';

export interface OpenSqlQueryArgs {
	id?: string;
	connectionId?: string;
	connectionName?: string;
	initialSql?: string;
}

export class NewSqlQueryAction extends Action2 {
	constructor() {
		super({
			id: SQL_NEW_QUERY_COMMAND_ID,
			title: localize2('sqlNewQuery', 'New SQL Query'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor, args?: OpenSqlQueryArgs): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const connectionService = accessor.get(ISqlConnectionService);

		let connectionId = args?.connectionId?.trim() || undefined;
		let connectionName = args?.connectionName?.trim() || undefined;

		if (!connectionId) {
			try {
				const connections = await connectionService.listConnections();
				const first = connections[0];

				if (first) {
					connectionId = first.id;
					connectionName = first.name;
				}
			} catch {
				connectionId = undefined;
				connectionName = undefined;
			}
		}

		await editorService.openEditor(
			new SqlEditorInput({
				id: args?.id,
				connectionId,
				connectionName,
				initialSql: args?.initialSql
			})
		);
	}
}

export class ExecuteSqlQueryAction extends Action2 {
	constructor() {
		super({
			id: SQL_EXECUTE_QUERY_COMMAND_ID,
			title: localize2('sqlExecuteQuery', 'Execute SQL Query'),
			category: Categories.View,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.Enter,
				weight: KeybindingWeight.EditorContrib
			},
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await runSqlEditorCommand(accessor, pane => pane.executeQuery(SqlEditorExecutionSource.All), 'Open a SQL Query editor before executing SQL.');
	}
}

export class ExecuteSqlSelectionAction extends Action2 {
	constructor() {
		super({
			id: SQL_EXECUTE_SELECTION_COMMAND_ID,
			title: localize2('sqlExecuteSelection', 'Execute SQL Selection'),
			category: Categories.View,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter,
				weight: KeybindingWeight.EditorContrib
			},
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await runSqlEditorCommand(accessor, pane => pane.executeQuery(SqlEditorExecutionSource.Selection), 'Open a SQL Query editor before executing selected SQL.');
	}
}

export class ExecuteSqlCurrentStatementAction extends Action2 {
	constructor() {
		super({
			id: SQL_EXECUTE_CURRENT_STATEMENT_COMMAND_ID,
			title: localize2('sqlExecuteCurrentStatement', 'Execute Current SQL Statement'),
			category: Categories.View,
			f1: true,
			keybinding: {
				primary: KeyMod.Alt | KeyCode.Enter,
				weight: KeybindingWeight.EditorContrib
			},
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await runSqlEditorCommand(accessor, pane => pane.executeQuery(SqlEditorExecutionSource.Statement), 'Open a SQL Query editor before executing current statement.');
	}
}

export class FormatSqlQueryAction extends Action2 {
	constructor() {
		super({
			id: SQL_FORMAT_QUERY_COMMAND_ID,
			title: localize2('sqlFormatQuery', 'Format SQL Query'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await runSqlEditorCommand(accessor, pane => {
			pane.formatQuery();
		}, 'Open a SQL Query editor before formatting SQL.');
	}
}

async function runSqlEditorCommand(
	accessor: ServicesAccessor,
	callback: (pane: SqlEditorPane) => Promise<void> | void,
	message: string
): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const notificationService = accessor.get(INotificationService);
	const pane = editorService.activeEditorPane;

	if (pane instanceof SqlEditorPane) {
		await callback(pane);
		return;
	}

	notificationService.info(message);
}

registerAction2(NewSqlQueryAction);
registerAction2(ExecuteSqlQueryAction);
registerAction2(ExecuteSqlSelectionAction);
registerAction2(ExecuteSqlCurrentStatementAction);
registerAction2(FormatSqlQueryAction);
