import assert from 'node:assert/strict';
import test from 'node:test';

import { SQL_CONNECTIONS_FOCUS_COMMAND_ID } from '../../sqlConnections/common/sqlConnections.js';
import { SQL_NEW_QUERY_COMMAND_ID } from '../../sqlEditor/common/sqlEditor.js';
import { SQL_RESULT_OPEN_COMMAND_ID } from '../../sqlResult/common/sqlResult.js';
import { SQL_PRODUCT_BOOTSTRAP_DEMO_COMMAND_ID, SQL_PRODUCT_WELCOME_VIEW_ID } from '../common/sqlProduct.js';
import {
	createSqlProductStartupPlan,
	dedupeStartupCommands,
	isSqlProductDemoBootstrapSupported,
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

test('isSqlProductDemoBootstrapSupported skips browser preview', () => {
	assert.equal(isSqlProductDemoBootstrapSupported(false), false);
	assert.equal(isSqlProductDemoBootstrapSupported(true), true);
});

test('createSqlProductStartupPlan creates SQL layout plan from preferences', () => {
	const plan = createSqlProductStartupPlan({
		alreadyBootstrapped: false,
		preferences: DEFAULT_SQL_PRODUCT_PREFERENCES
	});

	assert.deepEqual(
		plan.map(item => item.kind),
		[
			SqlProductStartupCommandKind.BootstrapDemo,
			SqlProductStartupCommandKind.FocusConnections,
			SqlProductStartupCommandKind.OpenResults,
			SqlProductStartupCommandKind.FocusWelcome,
			SqlProductStartupCommandKind.NewQuery
		]
	);

	assert.deepEqual(
		plan.map(item => item.commandId),
		[
			SQL_PRODUCT_BOOTSTRAP_DEMO_COMMAND_ID,
			SQL_CONNECTIONS_FOCUS_COMMAND_ID,
			SQL_RESULT_OPEN_COMMAND_ID,
			`${SQL_PRODUCT_WELCOME_VIEW_ID}.focus`,
			SQL_NEW_QUERY_COMMAND_ID
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

test('createSqlProductStartupPlan can skip layout restore while keeping onboarding', () => {
	const plan = createSqlProductStartupPlan({
		alreadyBootstrapped: false,
		preferences: {
			...DEFAULT_SQL_PRODUCT_PREFERENCES,
			restoreSqlLayoutOnStartup: false
		}
	});

	assert.deepEqual(
		plan.map(item => item.kind),
		[
			SqlProductStartupCommandKind.BootstrapDemo,
			SqlProductStartupCommandKind.FocusWelcome,
			SqlProductStartupCommandKind.NewQuery
		]
	);
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

	// Phase 08 follow-up: when welcome-query is on, both the welcome
	// pane focus and the new-query command fire so the user gets the
	// guide in the panel plus a starter query in the editor.
	assert.equal(plan.length, 3);
	assert.equal(plan[0].kind, SqlProductStartupCommandKind.BootstrapDemo);
	assert.equal(plan[1].kind, SqlProductStartupCommandKind.FocusWelcome);
	assert.equal(plan[1].commandId, 'sqlStudio.product.welcome.focus');
	assert.equal(plan[2].kind, SqlProductStartupCommandKind.NewQuery);
	assert.equal(plan[2].commandId, SQL_NEW_QUERY_COMMAND_ID);
	assert.deepEqual(plan[2].args, [
		{
			initialSql: 'SELECT 42;'
		}
	]);
});

test('createSqlProductStartupPlan focuses welcome even without layout restore', () => {
	// Welcome must work independently of `restoreSqlLayoutOnStartup`,
	// otherwise first-time users with layout-restore off would never
	// see the welcome pane.
	const plan = createSqlProductStartupPlan({
		alreadyBootstrapped: false,
		preferences: {
			...DEFAULT_SQL_PRODUCT_PREFERENCES,
			restoreSqlLayoutOnStartup: false,
			openWelcomeQueryOnFirstLaunch: true,
			defaultQuery: 'SELECT 1;'
		}
	});

	assert.ok(
		plan.some(cmd => cmd.kind === SqlProductStartupCommandKind.FocusWelcome),
		'welcome focus must fire when openWelcomeQueryOnFirstLaunch is true'
	);
});

test('createSqlProductStartupPlan omits welcome when preference is off', () => {
	const plan = createSqlProductStartupPlan({
		alreadyBootstrapped: false,
		preferences: {
			...DEFAULT_SQL_PRODUCT_PREFERENCES,
			openWelcomeQueryOnFirstLaunch: false
		}
	});

	assert.ok(
		!plan.some(cmd => cmd.kind === SqlProductStartupCommandKind.FocusWelcome),
		'welcome focus must not fire when openWelcomeQueryOnFirstLaunch is false'
	);
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
		[SQL_CONNECTIONS_FOCUS_COMMAND_ID, SQL_RESULT_OPEN_COMMAND_ID]
	);
});
