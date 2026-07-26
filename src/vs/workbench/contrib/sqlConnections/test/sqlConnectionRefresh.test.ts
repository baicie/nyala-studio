/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection refresh orchestration tests.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	refreshAndRequireSqlConnection,
	restoreSavedConnectionsForRefresh,
	SqlConnectionRefreshOptions
} from '../common/sqlConnectionRefresh.js';

test('restoreSavedConnectionsForRefresh keeps retry enabled after a recoverable failure', async () => {
	const failure = new Error('restore failed');
	const reported: unknown[] = [];

	const restored = await restoreSavedConnectionsForRefresh(
		false,
		async () => {
			throw failure;
		},
		error => reported.push(error)
	);

	assert.equal(restored, false);
	assert.deepEqual(reported, [failure]);
});

test('restoreSavedConnectionsForRefresh propagates strict failures', async () => {
	const failure = new Error('restore failed');
	const reported: unknown[] = [];

	await assert.rejects(
		restoreSavedConnectionsForRefresh(
			false,
			async () => {
				throw failure;
			},
			error => reported.push(error),
			{ throwOnError: true }
		),
		error => error === failure
	);
	assert.deepEqual(reported, []);
});

test('restoreSavedConnectionsForRefresh skips work that already completed', async () => {
	let restoreCalls = 0;

	const restored = await restoreSavedConnectionsForRefresh(
		true,
		async () => {
			restoreCalls++;
		},
		() => {}
	);

	assert.equal(restored, true);
	assert.equal(restoreCalls, 0);
});

test('refreshAndRequireSqlConnection propagates strict refresh failures', async () => {
	const failure = new Error('refresh failed');
	let receivedOptions: SqlConnectionRefreshOptions | undefined;

	await assert.rejects(
		refreshAndRequireSqlConnection(
			'demo-sqlite',
			async options => {
				receivedOptions = options;
				throw failure;
			},
			() => false
		),
		error => error === failure
	);
	assert.deepEqual(receivedOptions, { throwOnError: true });
});

test('refreshAndRequireSqlConnection rejects when the requested connection is absent', async () => {
	await assert.rejects(
		refreshAndRequireSqlConnection(
			'demo-sqlite',
			async () => {},
			() => false
		),
		/Connection demo-sqlite was not returned after refresh\./
	);
});

test('refreshAndRequireSqlConnection accepts a connection returned by refresh', async () => {
	await refreshAndRequireSqlConnection(
		'demo-sqlite',
		async () => {},
		id => id === 'demo-sqlite'
	);
});
