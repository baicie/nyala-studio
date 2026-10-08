import assert from 'node:assert/strict';
import test from 'node:test';

import { DeferredPromise } from '../../../../base/common/async.js';
import { SqlProductBootstrapOutcome, SqlProductBootstrapService } from '../common/sqlProductBootstrapService.js';
import { SqlProductStartupCommandKind } from '../common/sqlProductBootstrapModel.js';

const succeeded: SqlProductBootstrapOutcome = {
	version: 1,
	status: 'succeeded',
	mode: 'restore',
	completedCommands: [SqlProductStartupCommandKind.BootstrapDemo]
};

test('SqlProductBootstrapService waits for a delayed structured outcome', async () => {
	const service = new SqlProductBootstrapService();
	const bootstrap = new DeferredPromise<SqlProductBootstrapOutcome>();
	let settled = false;
	service.whenSettled.then(() => (settled = true));

	service.start('restore', () => bootstrap.p);
	await Promise.resolve();
	assert.equal(settled, false);

	await bootstrap.complete(succeeded);
	assert.deepEqual(await service.whenSettled, succeeded);
	assert.equal(settled, true);
});

test('SqlProductBootstrapService converts an unexpected rejection into a safe outcome', async () => {
	const service = new SqlProductBootstrapService();
	const bootstrap = new DeferredPromise<SqlProductBootstrapOutcome>();

	service.start('onboarding', () => bootstrap.p);
	await bootstrap.error(new Error('secret /Users/private/demo.db'));

	assert.deepEqual(await service.whenSettled, {
		version: 1,
		status: 'failed',
		mode: 'onboarding',
		completedCommands: [],
		failedStep: 'prepare',
		errorCode: 'unexpected-bootstrap-rejection'
	});
});

test('SqlProductBootstrapService converts a synchronous task failure into a safe outcome', async () => {
	const service = new SqlProductBootstrapService();

	service.start('restore', () => {
		throw new Error('secret /Users/private/demo.db');
	});

	assert.deepEqual(await service.whenSettled, {
		version: 1,
		status: 'failed',
		mode: 'restore',
		completedCommands: [],
		failedStep: 'prepare',
		errorCode: 'unexpected-bootstrap-rejection'
	});
});

test('SqlProductBootstrapService rejects duplicate bootstrap tasks', () => {
	const service = new SqlProductBootstrapService();
	let firstFactoryCalls = 0;
	let duplicateFactoryCalls = 0;

	service.start('restore', () => {
		firstFactoryCalls += 1;
		return Promise.resolve(succeeded);
	});

	assert.throws(
		() =>
			service.start('restore', () => {
				duplicateFactoryCalls += 1;
				return Promise.resolve(succeeded);
			}),
		/already started/
	);
	assert.equal(firstFactoryCalls, 1);
	assert.equal(duplicateFactoryCalls, 0);
});

test('SqlProductBootstrapService settles disposed and ignores a late task outcome', async () => {
	const service = new SqlProductBootstrapService();
	const bootstrap = new DeferredPromise<SqlProductBootstrapOutcome>();
	service.start('restore', () => bootstrap.p);

	service.settleDisposed('restore');
	assert.deepEqual(await service.whenSettled, {
		version: 1,
		status: 'disposed',
		mode: 'restore',
		completedCommands: []
	});

	await bootstrap.complete(succeeded);
	assert.equal((await service.whenSettled).status, 'disposed');
});

test('SqlProductBootstrapService rejects a task after disposal without invoking its factory', async () => {
	const service = new SqlProductBootstrapService();
	let factoryCalls = 0;

	service.settleDisposed('onboarding');
	assert.throws(
		() =>
			service.start('onboarding', () => {
				factoryCalls += 1;
				return Promise.resolve(succeeded);
			}),
		/already disposed/
	);

	assert.equal(factoryCalls, 0);
	assert.deepEqual(await service.whenSettled, {
		version: 1,
		status: 'disposed',
		mode: 'onboarding',
		completedCommands: []
	});
});
