import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { resolveDemoDataDir } from './seed-demo-data-dir.mjs';

const seedScriptPath = fileURLToPath(new URL('./seed-demo-db.mjs', import.meta.url));

test('NYALA_DATA_DIR overrides every platform default', () => {
	assert.equal(
		resolveDemoDataDir({
			environment: { NYALA_DATA_DIR: 'D:/isolated/nyala' },
			platformName: 'win32',
			homeDirectory: 'C:/Users/test'
		}),
		'D:/isolated/nyala'
	);
});

test('Windows uses APPDATA', () => {
	assert.equal(
		resolveDemoDataDir({
			environment: { APPDATA: 'C:/Users/test/AppData/Roaming' },
			platformName: 'win32',
			homeDirectory: 'C:/Users/test'
		}),
		join('C:/Users/test/AppData/Roaming', 'nyala-studio')
	);
});

test('Windows falls back to the home roaming data directory', () => {
	assert.equal(
		resolveDemoDataDir({ environment: {}, platformName: 'win32', homeDirectory: 'C:/Users/test' }),
		join('C:/Users/test', 'AppData', 'Roaming', 'nyala-studio')
	);
});

test('macOS uses Application Support', () => {
	assert.equal(
		resolveDemoDataDir({ environment: {}, platformName: 'darwin', homeDirectory: '/Users/test' }),
		join('/Users/test', 'Library', 'Application Support', 'nyala-studio')
	);
});

test('Linux uses XDG_DATA_HOME when configured', () => {
	assert.equal(
		resolveDemoDataDir({
			environment: { XDG_DATA_HOME: '/var/lib/test' },
			platformName: 'linux',
			homeDirectory: '/home/test'
		}),
		join('/var/lib/test', 'nyala-studio')
	);
});

test('Linux falls back to the home data directory', () => {
	assert.equal(
		resolveDemoDataDir({ environment: {}, platformName: 'linux', homeDirectory: '/home/test' }),
		join('/home/test', '.local', 'share', 'nyala-studio')
	);
});

test('seed helper preserves user rows matching seed values', () => {
	const dataDir = mkdtempSync(join(tmpdir(), 'nyala-seed-demo-'));
	const environment = { ...process.env, NYALA_DATA_DIR: dataDir };
	const runSeed = () =>
		execFileSync(process.execPath, ['--no-warnings', seedScriptPath], {
			env: environment,
			stdio: 'pipe'
		});

	try {
		runSeed();
		const dbPath = join(dataDir, 'demo.db');
		const setupDb = new DatabaseSync(dbPath);
		setupDb.exec(`
            INSERT INTO orders(user_id, amount, created_at)
            VALUES (1, 100, '2026-07-01');
        `);
		setupDb.close();

		runSeed();
		const resultDb = new DatabaseSync(dbPath);
		const matchingRows = resultDb
			.prepare(
				`SELECT COUNT(*) AS count FROM orders
                 WHERE user_id = 1 AND amount = 100 AND created_at = '2026-07-01'`
			)
			.get();
		resultDb.close();

		assert.equal(matchingRows.count, 2);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});
