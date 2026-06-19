/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product bootstrap pure model.
 *--------------------------------------------------------------------------------------------*/

import { SQL_CONNECTIONS_FOCUS_COMMAND_ID } from '../../sqlConnections/common/sqlConnections.js';
import { SQL_RESULT_OPEN_COMMAND_ID } from '../../sqlResult/common/sqlResult.js';
import { SQL_NEW_QUERY_COMMAND_ID } from '../../sqlEditor/common/sqlEditor.js';
import { SQL_PRODUCT_DEFAULT_QUERY } from './sqlProduct.js';

export const enum SqlProductStartupCommandKind {
	FocusConnections = 'focusConnections',
	OpenResults = 'openResults',
	NewQuery = 'newQuery'
}

export interface SqlProductStartupCommand {
	readonly kind: SqlProductStartupCommandKind;
	readonly commandId: string;
	readonly args?: unknown[];
}

export interface SqlProductBootstrapOptions {
	readonly alreadyBootstrapped: boolean;
	readonly restoreSqlLayout?: boolean;
	readonly openWelcomeQuery?: boolean;
	readonly force?: boolean;
}

export function shouldRunSqlProductBootstrap(options: SqlProductBootstrapOptions): boolean {
	if (options.force) {
		return true;
	}

	return !options.alreadyBootstrapped;
}

export function createSqlProductStartupPlan(options: SqlProductBootstrapOptions): SqlProductStartupCommand[] {
	if (!shouldRunSqlProductBootstrap(options)) {
		return [];
	}

	const restoreSqlLayout = options.restoreSqlLayout !== false;
	const openWelcomeQuery = options.openWelcomeQuery === true;

	const commands: SqlProductStartupCommand[] = [];

	if (restoreSqlLayout) {
		commands.push({
			kind: SqlProductStartupCommandKind.FocusConnections,
			commandId: SQL_CONNECTIONS_FOCUS_COMMAND_ID
		});

		commands.push({
			kind: SqlProductStartupCommandKind.OpenResults,
			commandId: SQL_RESULT_OPEN_COMMAND_ID
		});
	}

	if (openWelcomeQuery) {
		commands.push({
			kind: SqlProductStartupCommandKind.NewQuery,
			commandId: SQL_NEW_QUERY_COMMAND_ID,
			args: [
				{
					initialSql: SQL_PRODUCT_DEFAULT_QUERY
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
