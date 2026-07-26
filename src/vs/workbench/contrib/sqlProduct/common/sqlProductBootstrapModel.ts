/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product bootstrap pure model.
 *--------------------------------------------------------------------------------------------*/

import { SQL_CONNECTIONS_FOCUS_COMMAND_ID } from '../../sqlConnections/common/sqlConnections.js';
import { SQL_RESULT_OPEN_COMMAND_ID } from '../../sqlResult/common/sqlResult.js';
import { SQL_NEW_QUERY_COMMAND_ID } from '../../sqlEditor/common/sqlEditor.js';
import { SQL_PRODUCT_BOOTSTRAP_DEMO_COMMAND_ID, SQL_PRODUCT_WELCOME_VIEW_ID } from './sqlProduct.js';
import { DEFAULT_SQL_PRODUCT_PREFERENCES, SqlProductPreferences } from './sqlProductPreferences.js';

export const enum SqlProductStartupCommandKind {
	BootstrapDemo = 'bootstrapDemo',
	FocusConnections = 'focusConnections',
	OpenResults = 'openResults',
	NewQuery = 'newQuery',
	FocusWelcome = 'focusWelcome'
}

export interface SqlProductStartupCommand {
	readonly kind: SqlProductStartupCommandKind;
	readonly commandId: string;
	readonly args?: unknown[];
}

export interface SqlProductBootstrapOptions {
	readonly alreadyBootstrapped: boolean;
	readonly preferences?: SqlProductPreferences;
	readonly force?: boolean;
}

export function shouldRunSqlProductBootstrap(options: SqlProductBootstrapOptions): boolean {
	if (options.force) {
		return true;
	}

	return !options.alreadyBootstrapped;
}

/** The demo database is a native Tauri capability, not a browser-preview capability. */
export function isSqlProductDemoBootstrapSupported(isNativeRuntime: boolean): boolean {
	return isNativeRuntime;
}

export function createSqlProductStartupPlan(options: SqlProductBootstrapOptions): SqlProductStartupCommand[] {
	if (!shouldRunSqlProductBootstrap(options)) {
		return [];
	}

	const preferences = options.preferences ?? DEFAULT_SQL_PRODUCT_PREFERENCES;
	const commands: SqlProductStartupCommand[] = [];

	commands.push({
		kind: SqlProductStartupCommandKind.BootstrapDemo,
		commandId: SQL_PRODUCT_BOOTSTRAP_DEMO_COMMAND_ID
	});

	if (preferences.restoreSqlLayoutOnStartup) {
		commands.push({
			kind: SqlProductStartupCommandKind.FocusConnections,
			commandId: SQL_CONNECTIONS_FOCUS_COMMAND_ID
		});

		commands.push({
			kind: SqlProductStartupCommandKind.OpenResults,
			commandId: SQL_RESULT_OPEN_COMMAND_ID
		});
	}

	if (preferences.openWelcomeQueryOnFirstLaunch) {
		// Welcome pane and a fresh SQL query both fire on first launch:
		// the query lands an editor tab so the user has somewhere to
		// type, the welcome pane (also gated on this same preference,
		// see ISqlProductPreferencesService#openWelcomeQueryOnFirstLaunch)
		// surfaces the four starting points in the panel.
		commands.push({
			kind: SqlProductStartupCommandKind.FocusWelcome,
			commandId: `${SQL_PRODUCT_WELCOME_VIEW_ID}.focus`
		});

		commands.push({
			kind: SqlProductStartupCommandKind.NewQuery,
			commandId: SQL_NEW_QUERY_COMMAND_ID,
			args: [
				{
					initialSql: preferences.defaultQuery
				}
			]
		});
	}

	return dedupeStartupCommands(commands);
}

export function dedupeStartupCommands(commands: readonly SqlProductStartupCommand[]): SqlProductStartupCommand[] {
	const seen = new Set<string>();
	const result: SqlProductStartupCommand[] = [];

	for (const command of commands) {
		const key = `${command.commandId}:${JSON.stringify(command.args ?? [])}`;

		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		result.push(command);
	}

	return result;
}
