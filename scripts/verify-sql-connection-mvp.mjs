#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * Nyala Studio - Phase 01 Connection MVP verifier.
 *
 * Performs static cross-stack checks for Phase 01:
 *   1. Rust: ConnectionProfile / ConnectionSecret types are exported.
 *   2. Rust: Tauri commands v2 are registered in invoke_handler.
 *   3. TS:  ISqlConnectionServiceV2 interface exists.
 *   4. TS:  SqlConnectionServiceV2 implementation exists.
 *   5. TS:  sql_test_connection_v2 / sql_open_connection_v2 / sql_list_connections_v2 /
 *          sql_close_connection_v2 / sql_forget_secrets are present in SqlCommandName union.
 *   6. Forbidden: no raw `console.log(secret)` or `console.log(password)` in src/vs/...
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');
const cwd = process.cwd();
const root = cwd.endsWith('sql-studio-next') ? cwd : repoRoot;

function readText(rel) {
	return readFileSync(join(root, rel), 'utf8');
}
function exists(rel) {
	try { statSync(join(root, rel)); return true; }
	catch { return false; }
}

let failed = 0;
function check(label, ok, detail) {
	if (ok) {
		console.log(`  + ${label}`);
	} else {
		failed++;
		console.log(`  - ${label}${detail ? ` :: ${detail}` : ''}`);
	}
}

console.log('[phase-01] Rust surface');

const typesRs = readText('src-tauri/src/commands/sql/types.rs');
check('ConnectionProfile defined in types.rs', /pub struct ConnectionProfile\b/.test(typesRs));
check('ConnectionSecret defined in types.rs', /pub struct ConnectionSecret\b/.test(typesRs));
check('DriverIdDto defined in types.rs', /pub enum DriverIdDto\b/.test(typesRs));
check('SqlCommandError defined in types.rs', /pub enum SqlCommandError\b/.test(typesRs));
check('assert_driver_status_at_least exported', /pub fn assert_driver_status_at_least\b/.test(typesRs));

const persistence = readText('src-tauri/src/commands/sql/persistence_v2.rs');
check('persistence_v2.rs strips password field', /strip_secret_fields|strip_secret_fields_root/.test(persistence));
check('persistence_v2.rs default_path exported', /pub fn default_path\b/.test(persistence));
check('types.rs ConnectionSecret.redacted_string exposed', /fn redacted_string\b/.test(typesRs));

const manager = readText('src-tauri/src/commands/sql/connection_manager.rs');
check('connection_manager.rs implements open_for_test', /pub fn open_for_test\b/.test(manager));
check('connection_manager.rs implements forget_everything', /pub fn forget_everything\b/.test(manager));
check('connection_manager.rs exposes with_conn', /pub fn with_conn\b/.test(manager));

const connectionV2 = readText('src-tauri/src/commands/sql/connection_v2.rs');
for (const fn of ['sql_test_connection_v2', 'sql_open_connection_v2', 'sql_close_connection_v2', 'sql_list_connections_v2', 'sql_forget_secrets', 'sql_upsert_connection_v2']) {
	check(`command ${fn} declared`, new RegExp(`pub fn ${fn}\\b`).test(connectionV2));
}

const libRs = readText('src-tauri/src/lib.rs');
for (const fn of ['sql_test_connection_v2', 'sql_open_connection_v2', 'sql_close_connection_v2', 'sql_list_connections_v2', 'sql_upsert_connection_v2', 'sql_forget_secrets']) {
	check(`command ${fn} registered in invoke_handler`, libRs.includes(fn));
}
check('connection_manager managed in lib.rs', /manage\(build_default_manager/.test(libRs));

console.log('[phase-01] TypeScript surface');

const connInterface = readText('src/vs/workbench/services/sql/common/sqlConnection.ts');
check('ISqlConnectionServiceV2 exported', /ISqlConnectionServiceV2/.test(connInterface));
check('ConnectionProfile shape exported', /export interface ConnectionProfile\b/.test(connInterface));
check('ConnectionSecret shape exported', /export interface ConnectionSecret\b/.test(connInterface));

const connService = readText('src/vs/workbench/services/sql/browser/sqlConnectionServiceV2.ts');
check('SqlConnectionServiceV2 class exists', /class SqlConnectionServiceV2\b/.test(connService));

const executor = readText('src/vs/workbench/services/sql/browser/sqlCommandExecutor.ts');
for (const cmd of ['sql_test_connection_v2', 'sql_open_connection_v2', 'sql_close_connection_v2', 'sql_list_connections_v2', 'sql_upsert_connection_v2', 'sql_forget_secrets']) {
	check(`SqlCommandName includes ${cmd}`, executor.includes(`'${cmd}'`));
}

check('ISqlConnectionServiceV2 registered as singleton',
	readText('src/vs/workbench/services/sql/browser/sqlService.contribution.ts').includes('ISqlConnectionServiceV2'));

const driverCatalog = readText('src/vs/workbench/services/sql/common/sqlDriverCatalog.ts');
check('ISqlDriverCatalogService.assertAtLeast exists', /assertAtLeast\(/.test(driverCatalog));
check('ISqlDriverCatalogService.labelFor exists', /labelFor\(/.test(driverCatalog));

check('SqlConnectionFormController exists',
	readText('src/vs/workbench/contrib/sqlConnections/browser/sqlConnectionFormController.ts').includes('class SqlConnectionFormController'));
check('SqlConnectionTemplateModel exists',
	readText('src/vs/workbench/contrib/sqlConnections/browser/sqlConnectionTemplateModel.ts').includes('SqlConnectionTemplateModel'));
check('SqlConnectionQueryModel exists',
	readText('src/vs/workbench/contrib/sqlConnections/browser/sqlConnectionQueryModel.ts').includes('class SqlConnectionQueryModel'));
check('ConnectionAutoRestoreNotifier exists',
	readText('src/vs/workbench/contrib/sqlConnections/browser/connectionAutoRestoreNotifier.ts').includes('ConnectionAutoRestoreNotifier'));

console.log('[phase-01] Forbidden patterns');

const cwdForbids = ['src/vs', 'src-tauri/src'];
function walk(dir) {
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'target') continue;
			walk(full);
		} else if (/\.(ts|tsx|js|mjs|rs)$/.test(entry.name)) {
			const text = readFileSync(full, 'utf8');
			if (/console\.log\([^)]*(secret|password)/i.test(text)) {
				failed++;
				console.log(`  \u2717 ${full} contains a console.log of secret/password`);
			}
			if (/println!.*\$\{?.*(secret|password)/i.test(text)) {
				failed++;
				console.log(`  \u2717 ${full} contains a println! of secret/password`);
			}
		}
	}
}
for (const dir of cwdForbids) {
	try { walk(join(root, dir)); } catch { /* missing dir is fine */ }
}
console.log('  + no console.log/println! of secrets detected');

console.log('[phase-01] Result');
if (failed > 0) {
	console.error(`FAILED ${failed} check(s)`);
	process.exit(1);
}
console.log('OK');