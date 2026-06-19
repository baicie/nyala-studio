/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product commands.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { SQL_CONNECTIONS_FOCUS_COMMAND_ID } from '../../sqlConnections/common/sqlConnections.js';
import { SQL_NEW_QUERY_COMMAND_ID } from '../../sqlEditor/common/sqlEditor.js';
import { SQL_RESULT_OPEN_COMMAND_ID } from '../../sqlResult/common/sqlResult.js';
import {
	SQL_PRODUCT_DEFAULT_QUERY,
	SQL_PRODUCT_HOME_COMMAND_ID,
	SQL_PRODUCT_NEW_QUERY_COMMAND_ID,
	SQL_PRODUCT_OPEN_RESULTS_COMMAND_ID
} from '../common/sqlProduct.js';

class SqlProductHomeAction extends Action2 {
	constructor() {
		super({
			id: SQL_PRODUCT_HOME_COMMAND_ID,
			title: localize2('sqlProductHome', 'SQL Studio: Home'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);

		await commandService.executeCommand(SQL_CONNECTIONS_FOCUS_COMMAND_ID);
		await commandService.executeCommand(SQL_RESULT_OPEN_COMMAND_ID);
	}
}

class SqlProductNewQueryAction extends Action2 {
	constructor() {
		super({
			id: SQL_PRODUCT_NEW_QUERY_COMMAND_ID,
			title: localize2('sqlProductNewQuery', 'SQL Studio: New Query'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);

		await commandService.executeCommand(SQL_NEW_QUERY_COMMAND_ID, {
			initialSql: SQL_PRODUCT_DEFAULT_QUERY
		});
	}
}

class SqlProductOpenResultsAction extends Action2 {
	constructor() {
		super({
			id: SQL_PRODUCT_OPEN_RESULTS_COMMAND_ID,
			title: localize2('sqlProductOpenResults', 'SQL Studio: Open Results'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);

		await commandService.executeCommand(SQL_RESULT_OPEN_COMMAND_ID);
	}
}

registerAction2(SqlProductHomeAction);
registerAction2(SqlProductNewQueryAction);
registerAction2(SqlProductOpenResultsAction);
