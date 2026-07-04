#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL runtime status consistency check.
 *
 * Phase 00 — Runtime Status Alignment.
 * Enforces the Phase 00 invariant:
 *   "All SQL runtime status surfaces must agree with the truth-of-record
 *    defined in `src-tauri/src/runtime_status/mod.rs`."
 *
 * What is verified:
 *   1. The Rust truth-of-record (`RUNTIME_STATUS_TABLE`) has exactly the
 *      three Phase 00 drivers (SQLite, MySQL, PostgreSQL) and the
 *      documented statuses (Stable / Preview / Planned).
 *   2. The frontend TypeScript contract (`SqlRuntimeDriverId` /
 *      `SqlRuntimeStatus`) and the offline fallback shipped in
 *      `sqlDriverCatalogService.ts` agree with the Rust truth-of-record.
 *   3. The rendered form labels in `sqlConnectionsView.ts` no longer
 *      handcraft driver status text (no "MySQL Preview" / "PostgreSQL
 *      Planned" hardcoded).
 *   4. The README runtime driver table matches the Rust truth-of-record
 *      for the three documented drivers.
 *
 * Exit code 0 on success, 1 on any mismatch.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const failures = [];

function check(name, predicate, detail) {
	if (predicate) {
		console.log(`  PASS  ${name}`);
		return;
	}
	failures.push(`${name}${detail ? `: ${detail}` : ''}`);
	console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const rustTablePath = join(repoRoot, 'src-tauri', 'src', 'runtime_status', 'mod.rs');
const tsContractPath = join(repoRoot, 'src', 'vs', 'workbench', 'services', 'sql', 'common', 'sqlDriverCatalog.ts');
const tsServicePath = join(repoRoot, 'src', 'vs', 'workbench', 'services', 'sql', 'browser', 'sqlDriverCatalogService.ts');
const viewPath = join(repoRoot, 'src', 'vs', 'workbench', 'contrib', 'sqlConnections', 'browser', 'sqlConnectionsView.ts');
const readmePath = join(repoRoot, 'README.md');

const rustSource = readFileSync(rustTablePath, 'utf8');
const tsContract = readFileSync(tsContractPath, 'utf8');
const tsService = readFileSync(tsServicePath, 'utf8');
const viewSource = readFileSync(viewPath, 'utf8');
const readmeSource = readFileSync(readmePath, 'utf8');

console.log('Verifying SQL runtime status consistency (Phase 00)...\n');

const expectedDrivers = ['Sqlite', 'MySql', 'Postgres'];
const expectedStatuses = ['Stable', 'Preview', 'Planned', 'Disabled'];

console.log('Rust truth-of-record (src-tauri/src/runtime_status/mod.rs):');
for (const driver of expectedDrivers) {
	check(
		`declares driver ${driver}`,
		new RegExp(`id:\\s*DriverId::${driver}(?=[\\s,])`).test(rustSource)
	);
}

for (const status of expectedStatuses) {
	check(
		`declares RuntimeStatus::${status}`,
		new RegExp(`RuntimeStatus::${status}\\b`).test(rustSource)
	);
}

const sqliteEntryMatch = rustSource.match(/DriverRuntimeEntry\s*{[\s\S]*?id:\s*DriverId::Sqlite[\s\S]*?status:\s*RuntimeStatus::(\w+)/);
check(
	'SQLite is Stable in Rust',
	sqliteEntryMatch !== null && sqliteEntryMatch[1] === 'Stable',
	sqliteEntryMatch ? `found ${sqliteEntryMatch[1]}` : 'no Sqlite entry found'
);

const mysqlEntryMatch = rustSource.match(/DriverRuntimeEntry\s*{[\s\S]*?id:\s*DriverId::MySql[\s\S]*?status:\s*RuntimeStatus::(\w+)/);
check(
	'MySQL is Preview in Rust (per Phase 00)',
	mysqlEntryMatch !== null && mysqlEntryMatch[1] === 'Preview',
	mysqlEntryMatch ? `found ${mysqlEntryMatch[1]}` : 'no MySql entry found'
);

const postgresEntryMatch = rustSource.match(/DriverRuntimeEntry\s*{[\s\S]*?id:\s*DriverId::Postgres[\s\S]*?status:\s*RuntimeStatus::(\w+)/);
check(
	'PostgreSQL is Planned in Rust (per Phase 00)',
	postgresEntryMatch !== null && postgresEntryMatch[1] === 'Planned',
	postgresEntryMatch ? `found ${postgresEntryMatch[1]}` : 'no Postgres entry found'
);

console.log('\nFrontend contract (services/sql/common/sqlDriverCatalog.ts):');
for (const id of ['Sqlite', 'MySql', 'Postgres']) {
	check(
		`declares SqlRuntimeDriverId.${id}`,
		new RegExp(`(?:const\\s+enum\\s+)?SqlRuntimeDriverId\\s*\\{[^}]*\\b${id}\\s*=\\s*'${id.toLowerCase()}'`).test(tsContract)
	);
}
for (const status of ['Stable', 'Preview', 'Planned', 'Disabled']) {
	check(
		`declares SqlRuntimeStatus.${status}`,
		new RegExp(`(?:const\\s+enum\\s+)?SqlRuntimeStatus\\s*\\{[^}]*\\b${status}\\s*=\\s*'${status.toLowerCase()}'`).test(tsContract)
	);
}
console.log('\nFrontend service offline fallback (browser/sqlDriverCatalogService.ts):');
check(
	'offline fallback lists SQLite as Stable',
	/id: SqlRuntimeDriverId\.Sqlite[\s\S]{0,200}status: SqlRuntimeStatus\.Stable/.test(tsService)
);
check(
	'offline fallback lists MySQL as Preview',
	/id: SqlRuntimeDriverId\.MySql[\s\S]{0,200}status: SqlRuntimeStatus\.Preview/.test(tsService)
);
check(
	'offline fallback lists Postgres as Planned',
	/id: SqlRuntimeDriverId\.Postgres[\s\S]{0,200}status: SqlRuntimeStatus\.Planned/.test(tsService)
);

console.log('\nConnection view driver select (browser/sqlConnectionsView.ts):');
check(
	'no hardcoded "MySQL Preview" string',
	!viewSource.includes("'MySQL Preview'") && !viewSource.includes('"MySQL Preview"')
);
check(
	'no hardcoded "PostgreSQL Planned" string',
	!viewSource.includes("'PostgreSQL Planned'") && !viewSource.includes('"PostgreSQL Planned"')
);
check(
	'view reads from ISqlDriverCatalogService',
	viewSource.includes('ISqlDriverCatalogService') && viewSource.includes('sqlDriverCatalogService')
);

console.log('\nREADME runtime status table:');
check(
	'README mentions SQLite stable',
	/SQLite[\s\S]{0,80}stable/i.test(readmeSource)
);
check(
	'README mentions MySQL preview',
	/MySQL[\s\S]{0,80}preview/i.test(readmeSource)
);
check(
	'README mentions PostgreSQL planned',
	/PostgreSQL[\s\S]{0,80}planned/i.test(readmeSource)
);

console.log('');
if (failures.length > 0) {
	console.error(`Phase 00 runtime status consistency check FAILED with ${failures.length} issue(s):`);
	for (const failure of failures) {
		console.error(`  - ${failure}`);
	}
	process.exit(1);
}

console.log('All Phase 00 runtime status consistency checks passed.');
