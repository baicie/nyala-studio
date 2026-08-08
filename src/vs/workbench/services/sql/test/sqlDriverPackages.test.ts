import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlDriverPackageService } from '../browser/sqlDriverPackageService.js';
import { ISqlCommandExecutor, SqlCommandName, SqlServiceError } from '../browser/sqlCommandExecutor.js';
import { SqlRuntimeDriverId } from '../common/sqlDriverCatalog.js';

class FakeSqlCommandExecutor implements ISqlCommandExecutor {
	readonly calls: Array<{ command: SqlCommandName; args: Record<string, unknown> }> = [];
	responses = new Map<SqlCommandName, unknown>();
	errors = new Map<SqlCommandName, unknown>();

	async execute<T>(command: SqlCommandName, args: Record<string, unknown> = {}): Promise<T> {
		this.calls.push({ command, args });
		if (this.errors.has(command)) {
			throw this.errors.get(command);
		}
		return this.responses.get(command) as T;
	}
}

const mysqlPackage = {
	id: 'mysql-jdbc',
	driverId: 'mysql',
	displayName: 'MySQL Connector/J',
	version: '9.3.0',
	fileName: 'mysql-connector-j-9.3.0.jar',
	sizeBytes: 100,
	installed: false
};

test('SqlDriverPackageService loads and caches signed package status', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_list_driver_packages', [mysqlPackage]);
	const service = new SqlDriverPackageService(executor);

	const first = await service.getPackages();
	const second = await service.getPackages();

	assert.equal(first, second);
	assert.equal(first[0].driverId, SqlRuntimeDriverId.MySql);
	assert.equal(service.findForDriver(SqlRuntimeDriverId.MySql)?.id, 'mysql-jdbc');
	assert.equal(executor.calls.length, 1);
});

test('SqlDriverPackageService downloads a package through the command service and updates cache', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_list_driver_packages', [mysqlPackage]);
	executor.responses.set('sql_download_driver', { ...mysqlPackage, installed: true });
	const service = new SqlDriverPackageService(executor);
	let changeCount = 0;
	const subscription = service.onChange(() => changeCount++);

	await service.getPackages();
	const result = await service.download(' mysql-jdbc ');

	assert.equal(result.installed, true);
	assert.equal(service.findForDriver(SqlRuntimeDriverId.MySql)?.installed, true);
	assert.deepEqual(executor.calls.at(-1), {
		command: 'sql_download_driver',
		args: { packageId: 'mysql-jdbc' }
	});
	assert.equal(changeCount, 2);
	subscription.dispose();
	service.dispose();
});

test('SqlDriverPackageService initializes its cache before a standalone download', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_list_driver_packages', [mysqlPackage]);
	executor.responses.set('sql_download_driver', { ...mysqlPackage, installed: true });
	const service = new SqlDriverPackageService(executor);

	await service.download('mysql-jdbc');

	assert.deepEqual(
		executor.calls.map(call => call.command),
		['sql_list_driver_packages', 'sql_download_driver']
	);
	assert.equal(service.findForDriver(SqlRuntimeDriverId.MySql)?.installed, true);
});

test('SqlDriverPackageService rejects malformed package payloads', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.responses.set('sql_list_driver_packages', [{ ...mysqlPackage, sizeBytes: '100' }]);
	const service = new SqlDriverPackageService(executor);

	await assert.rejects(() => service.getPackages(), /invalid package/);
});

test('SqlDriverPackageService preserves structured command errors', async () => {
	const executor = new FakeSqlCommandExecutor();
	executor.errors.set(
		'sql_download_driver',
		new SqlServiceError('Unknown driver package', 'sql_download_driver', undefined, 'invalid_input')
	);
	const service = new SqlDriverPackageService(executor);

	await assert.rejects(
		() => service.download('missing'),
		error => {
			assert.ok(error instanceof SqlServiceError);
			assert.equal(error.code, 'invalid_input');
			assert.equal(error.command, 'sql_download_driver');
			return true;
		}
	);
});
