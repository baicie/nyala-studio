import assert from 'node:assert/strict';
import test from 'node:test';

import {
	assertReleaseVersions,
	isPrereleaseVersion,
	parseReleaseArguments,
	readCargoLockPackageVersion,
	readCargoPackageVersion,
	replaceCargoPackageVersion,
	validateReleaseVersion
} from './release-version.mjs';

test('accepts pnpm argument separators', () => {
	assert.deepEqual(parseReleaseArguments(['prepare', '--', '0.0.1-dev.0']), ['prepare', '0.0.1-dev.0']);
});

test('accepts stable and prerelease SemVer versions', () => {
	for (const version of ['0.0.1', '0.0.1-dev.0', '12.34.56-rc.1+build.9']) {
		assert.equal(validateReleaseVersion(version), version);
	}
	assert.equal(isPrereleaseVersion('0.0.1-dev.0'), true);
	assert.equal(isPrereleaseVersion('0.0.1'), false);
	assert.equal(isPrereleaseVersion('0.0.1+build-with-hyphen'), false);
});

test('rejects ambiguous or invalid release versions', () => {
	for (const version of ['', 'v0.0.1', '01.0.0', '0.0', '0.0.1-01', '0.0.1-', ' 0.0.1']) {
		assert.throws(() => validateReleaseVersion(version));
	}
});

test('reads and replaces only the Cargo package version', () => {
	const source = `[package]\nname = "sql-studio-next"\nversion = "0.1.0"\n\n[dependencies]\nexample = "0.1.0"\n`;
	assert.equal(readCargoPackageVersion(source), '0.1.0');
	const updated = replaceCargoPackageVersion(source, '0.0.1-dev.0');
	assert.match(updated, /version = "0\.0\.1-dev\.0"/);
	assert.match(updated, /example = "0\.1\.0"/);
});

test('reads the application version from Cargo.lock', () => {
	const source = `[[package]]\nname = "dependency"\nversion = "0.1.0"\n\n[[package]]\nname = "sql-studio-next"\nversion = "0.0.1-dev.0"\n`;
	assert.equal(readCargoLockPackageVersion(source, 'sql-studio-next'), '0.0.1-dev.0');
	assert.throws(() => readCargoLockPackageVersion(source, 'missing'));
});

test('requires all release version sources to match', () => {
	assert.equal(
		assertReleaseVersions({ package: '0.0.1-dev.0', tauri: '0.0.1-dev.0', cargo: '0.0.1-dev.0' }),
		'0.0.1-dev.0'
	);
	assert.throws(() => assertReleaseVersions({ package: '0.0.1-dev.0', tauri: '0.1.0' }), /mismatch/);
	assert.throws(() => assertReleaseVersions({ package: '0.0.1-dev.0' }, '0.0.1-dev.1'), /mismatch/);
	assert.throws(() => assertReleaseVersions({}), /At least one/);
});
