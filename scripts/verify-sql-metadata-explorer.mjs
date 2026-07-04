#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * Nyala Studio - Phase 02 Metadata Explorer verifier.
 *
 * Static cross-stack checks for Phase 02:
 *   1. Rust: metadata_v2 module exports SchemataDto / SchemaObjectDto / ColumnDto.
 *   2. Rust: SqlConnection trait has list_schemas / list_tables / list_columns.
 *   3. Rust: SqliteConnection implements the metadata methods (uses rusqlite).
 *   4. Rust: sql_list_schemas / sql_list_tables_v2 / sql_list_columns_v2 are
 *      registered in lib.rs.
 *   5. TS:  ISqlMetadataService exposes listSchemas / listTablesV2 / listColumnsV2.
 *   6. TS:  SqlMetadataService has TTL cache + invalidate.
 *   7. TS:  SqlCommandName union includes the three new v2 commands.
 *   8. TS:  SqlConnectionTreeModel exists with datasource/schema/table shape.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, statSync } from 'node:fs';
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

function header(title) {
	console.log(`\n[${title}]`);
}

header('Rust - metadata_v2 module');
const metadataV2 = readText('src-tauri/src/commands/sql/metadata_v2.rs');
check('SchemaObjectKind enum defined', /pub enum SchemaObjectKind/.test(metadataV2));
check('SchemataDto defined', /pub struct SchemataDto/.test(metadataV2));
check('SchemaObjectDto defined', /pub struct SchemaObjectDto/.test(metadataV2));
check('ColumnDto defined', /pub struct ColumnDto/.test(metadataV2));
check('sql_list_schemas command exported', /#\[tauri::command\][\s\S]*pub fn sql_list_schemas/.test(metadataV2));
check('sql_list_tables_v2 command exported', /pub fn sql_list_tables_v2/.test(metadataV2));
check('sql_list_columns_v2 command exported', /pub fn sql_list_columns_v2/.test(metadataV2));

header('Rust - driver trait');
const driverReg = readText('src-tauri/src/commands/sql/driver_registry.rs');
check('SqlConnection trait declares list_schemas', /fn list_schemas\(\s*&self\s*\)/.test(driverReg));
check('SqlConnection trait declares list_tables', /fn list_tables\(\s*&self,\s*schema:/.test(driverReg));
check('SqlConnection trait declares list_columns', /fn list_columns\(\s*&self,\s*schema:/.test(driverReg));
check('SqliteConnection is a real wrapper around rusqlite::Connection', /SqliteConnection\s*\{[\s\S]*conn:\s*Mutex<SqliteRawConnection>/.test(driverReg));
check('SqliteConnection.list_tables queries sqlite_master', /sqlite_master/.test(driverReg));
check('SqliteConnection.list_columns uses PRAGMA table_info', /PRAGMA table_info/.test(driverReg));
check('SqliteConnection honors readOnly via query_only PRAGMA', /query_only/.test(driverReg));
check('MysqlProbeConnection stubs metadata methods', /impl SqlConnection for MysqlProbeConnection[\s\S]*fn list_schemas[\s\S]*Ok\(Vec::new\(\)\)/.test(driverReg));

header('Rust - lib.rs registration');
const libRs = readText('src-tauri/src/lib.rs');
check('sql_list_schemas registered in invoke_handler', /commands::sql_list_schemas,/.test(libRs));
check('sql_list_tables_v2 registered in invoke_handler', /commands::sql_list_tables_v2,/.test(libRs));
check('sql_list_columns_v2 registered in invoke_handler', /commands::sql_list_columns_v2,/.test(libRs));

header('TS - metadata types');
const metaTs = readText('src/vs/workbench/services/sql/common/sqlMetadata.ts');
check('SchemataDto exported', /export interface SchemataDto/.test(metaTs));
check('SchemaObjectDto exported', /export interface SchemaObjectDto/.test(metaTs));
check('ColumnDto exported', /export interface ColumnDto/.test(metaTs));
check('ISqlMetadataService declares listSchemas', /listSchemas\(/.test(metaTs));
check('ISqlMetadataService declares listTablesV2', /listTablesV2\(/.test(metaTs));
check('ISqlMetadataService declares listColumnsV2', /listColumnsV2\(/.test(metaTs));
check('ISqlMetadataService declares invalidate', /invalidate\(/.test(metaTs));

header('TS - metadata service cache');
const metaSvc = readText('src/vs/workbench/services/sql/browser/sqlMetadataService.ts');
check('SqlMetadataService extends Disposable', /extends Disposable/.test(metaSvc));
check('SqlMetadataService declares ttlMs', /ttlMs/.test(metaSvc));
check('SqlMetadataService declares invalidate()', /^\s*invalidate\(profileId:/m.test(metaSvc));
check('SqlMetadataService uses schemaCache / tablesCache / columnsCache', /schemaCache[\s\S]*tablesCache[\s\S]*columnsCache/.test(metaSvc));

header('TS - executor names');
const execTs = readText('src/vs/workbench/services/sql/browser/sqlCommandExecutor.ts');
check("'sql_list_schemas' present in SqlCommandName union", /\| 'sql_list_schemas'/.test(execTs));
check("'sql_list_tables_v2' present in SqlCommandName union", /\| 'sql_list_tables_v2'/.test(execTs));
check("'sql_list_columns_v2' present in SqlCommandName union", /\| 'sql_list_columns_v2'/.test(execTs));

header('TS - tree model');
const treePath = 'src/vs/workbench/contrib/sqlConnections/browser/sqlConnectionTreeModel.ts';
check('tree model file exists', exists(treePath));
if (exists(treePath)) {
	const tree = readText(treePath);
	check('TreeModel exposes rebuild()', /async rebuild\(\)/.test(tree));
	check('TreeModel exposes expandDatasource()', /expandDatasource\(/.test(tree));
	check('TreeModel exposes expandSchema()', /expandSchema\(/.test(tree));
	check('TreeModel exposes expandTable()', /expandTable\(/.test(tree));
	check('TreeModel exposes refresh()', /async refresh\(/.test(tree));
	check('TreeModel excludes planned drivers', /status !== 'planned'/.test(tree));
}

header('TS - tree model tests');
check('tree model v2 tests exist', exists('src/vs/workbench/contrib/sqlConnections/test/sqlConnectionTreeModelV2.test.ts'));

console.log('');
if (failed === 0) {
	console.log(`OK: Phase 02 metadata explorer checks passed.`);
	process.exit(0);
} else {
	console.log(`FAIL: ${failed} Phase 02 metadata explorer check(s) failed.`);
	process.exit(1);
}