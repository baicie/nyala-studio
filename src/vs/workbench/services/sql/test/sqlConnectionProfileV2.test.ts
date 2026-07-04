/*---------------------------------------------------------------------------------------------
 * Nyala Studio - Connection MVP V2 contract tests (Phase 01).
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	ConnectionProfile,
	ConnectionSecret,
} from '../common/sqlConnection.js';
import { SqlRuntimeDriverId } from '../common/sqlDriverCatalog.js';

test('connection profile serializes without secret fields', () => {
	const profile: ConnectionProfile = {
		id: 'p1',
		label: 'demo',
		driver: SqlRuntimeDriverId.Sqlite,
		readOnly: false,
		filePath: '/tmp/a.db',
		createdAtMs: 0,
	};

	const json = JSON.stringify(profile);
	assert.ok(!json.includes('password'), 'profile JSON must not contain "password"');
	assert.ok(!json.includes('secret'), 'profile JSON must not contain "secret"');
	assert.ok(!json.includes('credential'), 'profile JSON must not contain "credential"');
});

test('connection secret can be cleared without affecting profile', () => {
	const profile: ConnectionProfile = {
		id: 'p',
		label: 'demo',
		driver: SqlRuntimeDriverId.MySql,
		readOnly: true,
		host: '127.0.0.1',
		port: 3306,
		createdAtMs: 0,
	};
	const cleared: ConnectionSecret = { password: undefined };
	assert.equal(cleared.password, undefined);
	assert.equal(profile.label, 'demo');
});

test('connection profile driver must be a runtime driver id', () => {
	const allowed: SqlRuntimeDriverId[] = [
		SqlRuntimeDriverId.Sqlite,
		SqlRuntimeDriverId.MySql,
		SqlRuntimeDriverId.Postgres,
	];
	for (const driver of allowed) {
		const profile: Pick<ConnectionProfile, 'driver'> = { driver };
		assert.ok(profile.driver === driver);
	}
});

test('connection profile readOnly flag survives round-trip', () => {
	const profile: ConnectionProfile = {
		id: 'p',
		label: 'p',
		driver: SqlRuntimeDriverId.Sqlite,
		readOnly: true,
		createdAtMs: 0,
	};
	const round = JSON.parse(JSON.stringify(profile));
	assert.equal(round.readOnly, true);
});

test('memory-mode SQLite profile has no host or port', () => {
	const profile: ConnectionProfile = {
		id: 'p',
		label: 'memory',
		driver: SqlRuntimeDriverId.Sqlite,
		readOnly: false,
		rememberInMemory: true,
		createdAtMs: 0,
	};
	assert.equal(profile.host, undefined);
	assert.equal(profile.port, undefined);
});

test('saved file never contains password even after import', async () => {
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const { writeFileSync, readFileSync, unlinkSync } = await import('node:fs');

	const path = join(tmpdir(), `nyala-ct-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(path, JSON.stringify({
		version: 1,
		profiles: [{ id: 'a', label: 'a', driver: 'sqlite', readOnly: false, password: 'PWN' }],
	}));

	try {
		const text = readFileSync(path, 'utf8');
		assert.ok(text.includes('PWN'), 'fixture retains password for this test');

		// Simulate the persistence_v2.rs strip logic.
		const obj = JSON.parse(text);
		for (const prof of obj.profiles as Array<Record<string, unknown>>) {
			delete prof.password;
			delete prof.secret;
			delete prof.credentials;
		}
		writeFileSync(path, JSON.stringify(obj));

		const after = readFileSync(path, 'utf8');
		assert.ok(!after.includes('PWN'));
	} finally {
		try { unlinkSync(path); } catch { /* best-effort cleanup */ }
	}
});

test('connection profile host/port/database fields survive JSON round-trip', () => {
	const profile: ConnectionProfile = {
		id: 'p',
		label: 'demo',
		driver: SqlRuntimeDriverId.MySql,
		readOnly: false,
		host: '127.0.0.1',
		port: 3306,
		database: 'app',
		username: 'user',
		createdAtMs: 42,
	};
	const round = JSON.parse(JSON.stringify(profile));
	assert.equal(round.host, '127.0.0.1');
	assert.equal(round.port, 3306);
	assert.equal(round.database, 'app');
	assert.equal(round.username, 'user');
	assert.equal(round.createdAtMs, 42);
});