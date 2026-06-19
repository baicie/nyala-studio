import assert from 'node:assert/strict';
import test from 'node:test';

import { SQL_CONNECTIONS_FOCUS_COMMAND_ID } from '../../sqlConnections/common/sqlConnections.js';
import { SQL_NEW_QUERY_COMMAND_ID } from '../../sqlEditor/common/sqlEditor.js';
import { SQL_RESULT_OPEN_COMMAND_ID } from '../../sqlResult/common/sqlResult.js';
import {
	createSqlProductStartupPlan,
	dedupeStartupCommands,
	shouldRunSqlProductBootstrap,
	SqlProductStartupCommandKind
} from '../common/sqlProductBootstrapModel.js';
import { DEFAULT_SQL_PRODUCT_PREFERENCES } from '../common/sqlProductPreferences.js';

test('shouldRunSqlProductBootstrap runs on first launch', () => {
	assert.equal(
		shouldRunSqlProductBootstrap({
			alreadyBootstrapped: false
		}),
		true
	);
});

test('shouldRunSqlProductBootstrap skips after bootstrapped', () => {
	assert.equal(
		shouldRunSqlProductBootstrap({
			alreadyBootstrapped: true
		}),
		false
	);
});

test('shouldRunSqlProductBootstrap respects force', () => {
	assert.equal(
		shouldRunSqlProductBootstrap({
			alreadyBootstrapped: true,
			force: true
		}),
		true
	);
});

test('createSqlProductStartupPlan creates SQL layout plan from preferences', () => {
	const plan = createSqlProductStartupPlan({
		alreadyBootstrapped: false,
		preferences: DEFAULT_SQL_PRODUCT_PREFERENCES
	});

	assert.deepEqual(
		plan.map(item => item.kind),
		[
			SqlProductStartupCommandKind.FocusConnections,
			SqlProductStartupCommandKind.OpenResults
		]
	);

	assert.deepEqual(
		plan.map(item => item.commandId),
		[
			SQL_CONNECTIONS_FOCUS_COMMAND_ID,
			SQL_RESULT_OPEN_COMMAND_ID
		]
	);
});

test('createSqlProductStartupPlan skips when already bootstrapped', () => {
	const plan = createSqlProductStartupPlan({
		alreadyBootstrapped: true,
		preferences: DEFAULT_SQL_PRODUCT_PREFERENCES
	});

	assert.deepEqual(plan, []);
});

test('createSqlProductStartupPlan can skip layout restore through preferences', () => {
	const plan = createSqlProductStartupPlan({
		alreadyBootstrapped: false,
		preferences: {
			...DEFAULT_SQL_PRODUCT_PREFERENCES,
			restoreSqlLayoutOnStartup: false
		}
	});

	assert.deepEqual(plan, []);
});

test('createSqlProductStartupPlan can open welcome query through preferences', () => {
	const plan = createSqlProductStartupPlan({
		alreadyBootstrapped: false,
		preferences: {
			...DEFAULT_SQL_PRODUCT_PREFERENCES,
			restoreSqlLayoutOnStartup: false,
			openWelcomeQueryOnFirstLaunch: true,
			defaultQuery: 'SELECT 42;'
		}
	});

	assert.equal(plan.length, 1);
	assert.equal(plan[0].kind, SqlProductStartupCommandKind.NewQuery);
	assert.equal(plan[0].commandId, SQL_NEW_QUERY_COMMAND_ID);
	assert.deepEqual(plan[0].args, [
		{
			initialSql: 'SELECT 42;'
		}
	]);
});

test('dedupeStartupCommands removes duplicate command args pairs', () => {
	const plan = dedupeStartupCommands([
		{
			kind: SqlProductStartupCommandKind.FocusConnections,
			commandId: SQL_CONNECTIONS_FOCUS_COMMAND_ID
		},
		{
			kind: SqlProductStartupCommandKind.FocusConnections,
			commandId: SQL_CONNECTIONS_FOCUS_COMMAND_ID
		},
		{
			kind: SqlProductStartupCommandKind.OpenResults,
			commandId: SQL_RESULT_OPEN_COMMAND_ID
		}
	]);

	assert.deepEqual(
		plan.map(item => item.commandId),
		[
			SQL_CONNECTIONS_FOCUS_COMMAND_ID,
			SQL_RESULT_OPEN_COMMAND_ID
		]
	);
});
