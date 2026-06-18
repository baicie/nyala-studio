/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor commands.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ISqlConnectionService } from '../../../services/sql/common/sqlConnection.js';
import {
	SQL_EXECUTE_QUERY_COMMAND_ID,
	SQL_EXECUTE_SELECTION_COMMAND_ID,
	SQL_NEW_QUERY_COMMAND_ID
} from '../common/sqlEditor.js';
import { SqlEditorInput } from '../common/sqlEditorInput.js';
import { SqlEditorPane } from './sqlEditorPane.js';

export interface OpenSqlQueryArgs {
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

		let connectionId = args?.connectionId;
		let connectionName = args?.connectionName;

		if (!connectionId) {
			const connections = await connectionService.listConnections();
			const first = connections[0];

			if (first) {
				connectionId = first.id;
				connectionName = first.name;
			}
		}

		await editorService.openEditor(
			new SqlEditorInput({
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
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const pane = editorService.activeEditorPane;

		if (pane instanceof SqlEditorPane) {
			await pane.executeQuery(false);
		}
	}
}

export class ExecuteSqlSelectionAction extends Action2 {
	constructor() {
		super({
			id: SQL_EXECUTE_SELECTION_COMMAND_ID,
			title: localize2('sqlExecuteSelection', 'Execute SQL Selection'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const pane = editorService.activeEditorPane;

		if (pane instanceof SqlEditorPane) {
			await pane.executeQuery(true);
		}
	}
}

registerAction2(NewSqlQueryAction);
registerAction2(ExecuteSqlQueryAction);
registerAction2(ExecuteSqlSelectionAction);
