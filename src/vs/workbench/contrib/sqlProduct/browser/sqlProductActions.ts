/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product commands.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { SQL_CONNECTIONS_FOCUS_COMMAND_ID } from '../../sqlConnections/common/sqlConnections.js';
import { SQL_NEW_QUERY_COMMAND_ID } from '../../sqlEditor/common/sqlEditor.js';
import { SQL_RESULT_OPEN_COMMAND_ID } from '../../sqlResult/common/sqlResult.js';
import {
	SQL_PRODUCT_HOME_COMMAND_ID,
	SQL_PRODUCT_NEW_QUERY_COMMAND_ID,
	SQL_PRODUCT_OPEN_RESULTS_COMMAND_ID
} from '../common/sqlProduct.js';
import { ISqlProductPreferencesService } from '../common/sqlProductPreferencesService.js';
import { SQL_PRODUCT_PREFERENCES_VIEW_ID } from './sqlProductPreferencesView.js';

export const SQL_PRODUCT_OPEN_PREFERENCES_COMMAND_ID = 'sqlStudio.product.openPreferences';
export const SQL_PRODUCT_RESET_PREFERENCES_COMMAND_ID = 'sqlStudio.product.resetPreferences';
export const SQL_PRODUCT_TOGGLE_RESTORE_LAYOUT_COMMAND_ID = 'sqlStudio.product.toggleRestoreLayout';
export const SQL_PRODUCT_TOGGLE_WELCOME_QUERY_COMMAND_ID = 'sqlStudio.product.toggleWelcomeQuery';

class SqlProductHomeAction extends Action2 {
	constructor() {
		super({
			id: SQL_PRODUCT_HOME_COMMAND_ID,
			title: localize2('sqlProductHome', 'Nyala: Home'),
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
			title: localize2('sqlProductNewQuery', 'Nyala: New Query'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		const preferencesService = accessor.get(ISqlProductPreferencesService);

		await commandService.executeCommand(SQL_NEW_QUERY_COMMAND_ID, {
			initialSql: preferencesService.preferences.defaultQuery
		});
	}
}

class SqlProductOpenResultsAction extends Action2 {
	constructor() {
		super({
			id: SQL_PRODUCT_OPEN_RESULTS_COMMAND_ID,
			title: localize2('sqlProductOpenResults', 'Nyala: Open Results'),
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

class SqlProductOpenPreferencesAction extends Action2 {
	constructor() {
		super({
			id: SQL_PRODUCT_OPEN_PREFERENCES_COMMAND_ID,
			title: localize2('sqlProductOpenPreferences', 'Nyala: Preferences'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);

		await commandService.executeCommand(`${SQL_PRODUCT_PREFERENCES_VIEW_ID}.focus`);
	}
}

class SqlProductResetPreferencesAction extends Action2 {
	constructor() {
		super({
			id: SQL_PRODUCT_RESET_PREFERENCES_COMMAND_ID,
			title: localize2('sqlProductResetPreferences', 'Nyala: Reset Preferences'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const preferencesService = accessor.get(ISqlProductPreferencesService);
		const notificationService = accessor.get(INotificationService);

		preferencesService.reset();
		notificationService.info('Nyala preferences reset.');
	}
}

class SqlProductToggleRestoreLayoutAction extends Action2 {
	constructor() {
		super({
			id: SQL_PRODUCT_TOGGLE_RESTORE_LAYOUT_COMMAND_ID,
			title: localize2('sqlProductToggleRestoreLayout', 'Nyala: Toggle Restore Layout On Startup'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const preferencesService = accessor.get(ISqlProductPreferencesService);
		const notificationService = accessor.get(INotificationService);
		const next = !preferencesService.preferences.restoreSqlLayoutOnStartup;

		preferencesService.updatePreference('restoreSqlLayoutOnStartup', next);
		notificationService.info(`Restore SQL layout on startup: ${next ? 'on' : 'off'}.`);
	}
}

class SqlProductToggleWelcomeQueryAction extends Action2 {
	constructor() {
		super({
			id: SQL_PRODUCT_TOGGLE_WELCOME_QUERY_COMMAND_ID,
			title: localize2('sqlProductToggleWelcomeQuery', 'Nyala: Toggle Welcome Query On First Launch'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const preferencesService = accessor.get(ISqlProductPreferencesService);
		const notificationService = accessor.get(INotificationService);
		const next = !preferencesService.preferences.openWelcomeQueryOnFirstLaunch;

		preferencesService.updatePreference('openWelcomeQueryOnFirstLaunch', next);
		notificationService.info(`Open welcome query on first launch: ${next ? 'on' : 'off'}.`);
	}
}

registerAction2(SqlProductHomeAction);
registerAction2(SqlProductNewQueryAction);
registerAction2(SqlProductOpenResultsAction);
registerAction2(SqlProductOpenPreferencesAction);
registerAction2(SqlProductResetPreferencesAction);
registerAction2(SqlProductToggleRestoreLayoutAction);
registerAction2(SqlProductToggleWelcomeQueryAction);
