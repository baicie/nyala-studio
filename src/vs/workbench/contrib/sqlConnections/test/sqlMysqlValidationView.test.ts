/*---------------------------------------------------------------------------------------------
 * Nyala Studio - MySQL Preview validation controller tests.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MysqlPreviewValidationController } from '../browser/mysqlValidationView.js';
import { SqlSslMode } from '../../../services/sql/common/sqlTypes.js';

const connectionEditorSource = readFileSync(new URL('../browser/sqlConnectionEditorPane.ts', import.meta.url), 'utf8');

class FakeProductService {
	readonly calls: Array<{ input: unknown; secret: unknown }> = [];
	result = {
		selectOk: true,
		ddlOk: true,
		droppedTable: true,
		elapsedMs: 4,
		warnings: [] as string[]
	};
	error: unknown;

	async validateMysqlPreview(input: unknown, secret: unknown): Promise<typeof this.result> {
		this.calls.push({ input, secret });
		if (this.error !== undefined) {
			throw this.error;
		}
		return this.result;
	}
}

test('validate forwards transient fields and secret without opening a profile', async () => {
	const service = new FakeProductService();
	const controller = new MysqlPreviewValidationController(service as never);

	const result = await controller.validate('127.0.0.1', 3307, 'app', 'user', 'PWN', SqlSslMode.Require);

	assert.equal(result.ok, true);
	assert.deepEqual(service.calls, [
		{
			input: {
				host: '127.0.0.1',
				port: 3307,
				database: 'app',
				username: 'user',
				sslMode: SqlSslMode.Require
			},
			secret: { password: 'PWN' }
		}
	]);
});

test('validate requires SELECT, DDL, and cleanup to pass', async () => {
	const service = new FakeProductService();
	service.result = {
		selectOk: true,
		ddlOk: false,
		droppedTable: true,
		elapsedMs: 2,
		warnings: ['preview']
	};
	const controller = new MysqlPreviewValidationController(service as never);

	const result = await controller.validate('localhost', 3306, 'mysql', 'root', '', SqlSslMode.Disable);

	assert.equal(result.ok, false);
	assert.deepEqual(result.warnings, ['preview']);

	service.result = {
		selectOk: true,
		ddlOk: true,
		droppedTable: false,
		elapsedMs: 2,
		warnings: ['cleanup failed']
	};

	const cleanupResult = await controller.validate('localhost', 3306, 'mysql', 'root', '', SqlSslMode.Disable);

	assert.equal(cleanupResult.ok, false);
	assert.deepEqual(cleanupResult.warnings, ['cleanup failed']);
});

test('validate preserves structured service errors', async () => {
	const service = new FakeProductService();
	service.error = Object.assign(new Error('DDL denied'), { code: 'ddl_failed' });
	const controller = new MysqlPreviewValidationController(service as never);

	const result = await controller.validate('localhost', 3306, 'mysql', 'root', '', SqlSslMode.Disable);

	assert.deepEqual(result, {
		ok: false,
		warnings: [],
		code: 'ddl_failed',
		message: 'DDL denied'
	});
});

test('MySQL Validate is visible beside Test and Connect instead of inside Advanced', () => {
	const advancedStart = connectionEditorSource.indexOf('const advancedBody');
	const footerStart = connectionEditorSource.indexOf('const footer', advancedStart);
	const actionsStart = connectionEditorSource.indexOf('const actions', footerStart);
	const listenersStart = connectionEditorSource.indexOf('this.registerFormListeners()', actionsStart);
	const advancedSource = connectionEditorSource.slice(advancedStart, footerStart);
	const actionSource = connectionEditorSource.slice(actionsStart, listenersStart);

	assert.doesNotMatch(advancedSource, /this\.validateButton\s*=\s*append/);
	assert.ok(actionSource.indexOf('this.testButton = append') < actionSource.indexOf('this.validateButton = append'));
	assert.ok(actionSource.indexOf('this.validateButton = append') < actionSource.indexOf('this.connectButton = append'));
	assert.match(connectionEditorSource, /this\.validateButton\.hidden\s*=\s*!isMysql/);
});
