/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - MySQL Preview validation controller tests (Phase 08 §3.5).
 *
 * Covers the contract documented in
 * `docs/sql-mvp-phases/phase-08-mvp-packaging.md` §3.5:
 *
 *   * success path (DDL + SELECT both pass) returns `ok: true`;
 *   * validator exceptions are forwarded to the caller with their
 *     code + message preserved;
 *   * the secret password reaches the connection service unchanged;
 *   * the controller never auto-closes the profile (Phase 08 forces
 *     validation to be transient: keep the pool alive so a
 *     follow-up query can reuse the credentials).
 *
 * Tests stay at the controller layer by injecting two fakes:
 *   * a `FakeConn` that mimics `ISqlConnectionServiceV2` with
 *     just enough surface area to capture `open()` calls;
 *   * a `FakeVal` that mimics `IMysqlPreviewValidator` with a
 *     configurable `validate()` result.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { MysqlPreviewValidationController } from '../browser/mysqlValidationView.js';

class FakeConn {
	openCalls: { profile: unknown; secret: unknown }[] = [];
	closeCalls: string[] = [];

	async open(profile: unknown, secret: unknown): Promise<string> {
		this.openCalls.push({ profile, secret });
		return 'tmp';
	}

	async close(id: string): Promise<void> {
		this.closeCalls.push(id);
	}

	async forgetAllSecrets(): Promise<void> {}

	async list() {
		return [];
	}

	async test() {}
}

class FakeVal {
	result: { selectOk: boolean; ddlOk: boolean; droppedTable: boolean; warnings: string[] } = {
		selectOk: true,
		ddlOk: true,
		droppedTable: true,
		warnings: []
	};

	setResult(next: typeof this.result): void {
		this.result = next;
	}

	async validate(_id: string): Promise<typeof this.result> {
		return this.result;
	}
}

test('validate succeeds when DDL and SELECT pass', async () => {
	const c = new FakeConn();
	const v = new FakeVal();
	const ctrl = new MysqlPreviewValidationController(c as never, v as never);
	const r = await ctrl.validate('p', '127.0.0.1', 3306, 'u', 'p');
	assert.equal(r.ok, true);
	assert.equal(c.openCalls.length, 1);
});

test('validate forwards exceptions to caller', async () => {
	const c = new FakeConn();
	const v = new FakeVal();
	v.setResult({ selectOk: false, ddlOk: false, droppedTable: false, warnings: [] });
	v.validate = async () => {
		throw Object.assign(new Error('failed'), { code: 'X' });
	};
	const ctrl = new MysqlPreviewValidationController(c as never, v as never);
	const r = await ctrl.validate('p', '127.0.0.1', 3306, 'u', 'p');
	assert.equal(r.ok, false);
	assert.equal(r.code, 'X');
	assert.equal(r.message, 'failed');
});

test('validate forwards secret password unchanged', async () => {
	const c = new FakeConn();
	const v = new FakeVal();
	const ctrl = new MysqlPreviewValidationController(c as never, v as never);
	await ctrl.validate('p', '127.0.0.1', 3306, 'u', 'PWN');
	const sent = c.openCalls[0].secret as { password: string };
	assert.equal(sent.password, 'PWN');
});

test('validate does not auto-close the profile', async () => {
	const c = new FakeConn();
	const v = new FakeVal();
	const ctrl = new MysqlPreviewValidationController(c as never, v as never);
	await ctrl.validate('p', '127.0.0.1', 3306, 'u', 'p');
	// Phase 08 forces the profile to stay open so a follow-up query
	// can reuse the credentials. Auto-close would surprise the user.
	assert.equal(c.closeCalls.length, 0);
});

test('validate uses a tmp-prefixed profile id', async () => {
	const c = new FakeConn();
	const v = new FakeVal();
	const ctrl = new MysqlPreviewValidationController(c as never, v as never);
	await ctrl.validate('p', '127.0.0.1', 3306, 'u', 'p');
	const profile = c.openCalls[0].profile as { id: string };
	assert.ok(profile.id.startsWith('tmp-'), `expected tmp- prefix, got ${profile.id}`);
});

test('validate forwards non-mysql driver report as ok=false', async () => {
	const c = new FakeConn();
	const v = new FakeVal();
	v.setResult({ selectOk: false, ddlOk: true, droppedTable: true, warnings: ['preview'] });
	const ctrl = new MysqlPreviewValidationController(c as never, v as never);
	const r = await ctrl.validate('p', '127.0.0.1', 3306, 'u', 'p');
	assert.equal(r.ok, false);
	assert.deepEqual(r.warnings, ['preview']);
});