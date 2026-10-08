import assert from 'node:assert/strict';
import test from 'node:test';

import { DeferredPromise } from '../../../../base/common/async.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { SqlProductBootstrapContribution } from '../browser/sqlProductBootstrap.js';
import { SqlProductBootstrapService } from '../common/sqlProductBootstrapService.js';
import { DEFAULT_SQL_PRODUCT_PREFERENCES } from '../common/sqlProductPreferences.js';
import { ISqlProductPreferencesService } from '../common/sqlProductPreferencesService.js';

test('SqlProductBootstrapContribution exposes delayed restore completion', async () => {
	const command = new DeferredPromise<void>();
	const harness = createHarness({ alreadyBootstrapped: true, executeCommand: () => command.p });
	let settled = false;
	harness.service.whenSettled.then(() => (settled = true));

	await Promise.resolve();
	assert.equal(settled, false);
	await command.complete(undefined);

	assert.deepEqual(await harness.service.whenSettled, {
		version: 1,
		status: 'succeeded',
		mode: 'restore',
		completedCommands: ['bootstrapDemo']
	});
	assert.deepEqual(harness.warnings, []);
	assert.equal(harness.storeCalls, 0);
	harness.contribution.dispose();
});

test('SqlProductBootstrapContribution reports one sanitized command failure outcome', async () => {
	const harness = createHarness({
		alreadyBootstrapped: true,
		executeCommand: async () => {
			throw new Error('private /Users/example/demo.db');
		}
	});

	assert.deepEqual(await harness.service.whenSettled, {
		version: 1,
		status: 'failed',
		mode: 'restore',
		completedCommands: [],
		failedStep: 'bootstrapDemo',
		errorCode: 'startup-command-failed'
	});
	assert.equal(harness.warnings.length, 1);
	assert.match(harness.warnings[0], /private \/Users\/example\/demo\.db/);
	assert.equal(harness.storeCalls, 0);
	harness.contribution.dispose();
});

test('SqlProductBootstrapContribution records persist failure after completed onboarding commands', async () => {
	const harness = createHarness({ alreadyBootstrapped: false, storeError: new Error('storage unavailable') });

	const outcome = await harness.service.whenSettled;
	assert.equal(outcome.status, 'failed');
	assert.equal(outcome.mode, 'onboarding');
	assert.equal(outcome.failedStep, 'persist');
	assert.equal(outcome.errorCode, 'bootstrap-persist-failed');
	assert.equal(outcome.completedCommands[0], 'bootstrapDemo');
	assert.equal(harness.warnings.length, 1);
	harness.contribution.dispose();
});

test('SqlProductBootstrapContribution reports storage-read failure without running startup commands', async () => {
	const harness = createHarness({
		alreadyBootstrapped: false,
		storageReadError: new Error('private profile storage failure')
	});

	assert.deepEqual(await harness.service.whenSettled, {
		version: 1,
		status: 'failed',
		mode: 'onboarding',
		completedCommands: [],
		failedStep: 'prepare',
		errorCode: 'startup-prepare-failed'
	});
	assert.equal(harness.commandCalls, 0);
	assert.equal(harness.storeCalls, 0);
	assert.equal(harness.warnings.length, 1);
	harness.contribution.dispose();
});

test('SqlProductBootstrapContribution dispose prevents late marker and warning side effects', async () => {
	const command = new DeferredPromise<void>();
	const harness = createHarness({ alreadyBootstrapped: false, executeCommand: () => command.p });

	harness.contribution.dispose();
	assert.equal((await harness.service.whenSettled).status, 'disposed');
	await command.error(new Error('late private failure'));
	await Promise.resolve();

	assert.equal(harness.storeCalls, 0);
	assert.deepEqual(harness.warnings, []);
});

function createHarness(options: {
	alreadyBootstrapped: boolean;
	executeCommand?: () => Promise<void>;
	storageReadError?: Error;
	storeError?: Error;
}) {
	const warnings: string[] = [];
	let commandCalls = 0;
	let storeCalls = 0;
	const service = new SqlProductBootstrapService();
	const commandService = {
		executeCommand: () => {
			commandCalls += 1;
			return options.executeCommand?.() ?? Promise.resolve();
		}
	} as unknown as ICommandService;
	const storageService = {
		getBoolean: () => {
			if (options.storageReadError) {
				throw options.storageReadError;
			}
			return options.alreadyBootstrapped;
		},
		store: () => {
			storeCalls += 1;
			if (options.storeError) {
				throw options.storeError;
			}
		}
	} as unknown as IStorageService;
	const notificationService = {
		warn: (message: string) => warnings.push(message)
	} as unknown as INotificationService;
	const preferencesService = {
		preferences: DEFAULT_SQL_PRODUCT_PREFERENCES
	} as unknown as ISqlProductPreferencesService;
	const contribution = new SqlProductBootstrapContribution(
		commandService,
		storageService,
		notificationService,
		preferencesService,
		service
	);

	return {
		contribution,
		service,
		warnings,
		get commandCalls() {
			return commandCalls;
		},
		get storeCalls() {
			return storeCalls;
		}
	};
}
