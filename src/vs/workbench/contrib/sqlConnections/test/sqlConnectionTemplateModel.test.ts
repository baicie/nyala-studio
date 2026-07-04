/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection template model tests (Phase 01).
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlConnectionTemplateModel } from '../browser/sqlConnectionTemplateModel.js';
import { SqlRuntimeDriverId } from '../../../services/sql/common/sqlDriverCatalog.js';

test('SQLite file template has portless fields', () => {
	const t = SqlConnectionTemplateModel.for('sqlite-file');
	assert.ok(t.required.includes('label'));
	assert.ok(!t.fields.includes('host'));
	assert.equal(t.driver, SqlRuntimeDriverId.Sqlite);
});

test('SQLite memory template has no filePath', () => {
	const t = SqlConnectionTemplateModel.for('sqlite-memory');
	assert.ok(t.required.includes('label'));
	assert.ok(!t.fields.includes('filePath'));
	assert.equal(t.driver, SqlRuntimeDriverId.Sqlite);
});

test('MySQL template requires host/port/username/database', () => {
	const t = SqlConnectionTemplateModel.for('mysql');
	for (const key of ['label', 'host', 'port', 'database', 'username']) {
		assert.ok(t.required.includes(key), `mysql missing required ${key}`);
	}
	assert.equal(t.driver, SqlRuntimeDriverId.MySql);
});

test('Postgres template is disabled', () => {
	const t = SqlConnectionTemplateModel.for('postgres');
	assert.equal(t.disabled, true);
	assert.equal(t.driver, SqlRuntimeDriverId.Postgres);
});

test('default template is sqlite file', () => {
	const t = SqlConnectionTemplateModel.default();
	assert.equal(t.id, 'sqlite-file');
});