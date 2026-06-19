import assert from 'node:assert/strict';
import test from 'node:test';

import { formatSql, formatSqlSelectionOrDocument, minifySql } from '../common/sqlAdvancedFormatter.js';

test('formatSql formats select query', () => {
	assert.equal(
		formatSql('select id, name from users where id = 1 and name = \'select from\' limit 10'),
		`SELECT
  id,
  name
FROM users
WHERE id = 1
  AND name = 'select from'
LIMIT 10;`
	);
});

test('formatSql keeps empty SQL empty', () => {
	assert.equal(formatSql('   '), '');
});

test('formatSql adds trailing semicolon', () => {
	assert.equal(formatSql('select 1'), 'SELECT 1;');
});

test('minifySql compacts whitespace', () => {
	assert.equal(minifySql('SELECT  *\nFROM users ;'), 'SELECT * FROM users;');
});

test('formatSqlSelectionOrDocument formats selection first', () => {
	assert.equal(formatSqlSelectionOrDocument('select 1', 'select 2'), 'SELECT 1;');
});

test('formatSql keeps line comments unchanged', () => {
	assert.equal(
		formatSql(`-- select from should stay lowercase
select id from users`),
		`-- select from should stay lowercase
SELECT id
FROM users;`
	);
});

test('formatSql keeps block comments unchanged', () => {
	assert.equal(
		formatSql(`/* select from should stay lowercase */
select id from users`),
		`/* select from should stay lowercase */
SELECT id
FROM users;`
	);
});

test('formatSql keeps quoted identifiers unchanged', () => {
	assert.equal(
		formatSql('select "select", `from` from users'),
		`SELECT
  "select",
  \`from\`
FROM users;`
	);
});
