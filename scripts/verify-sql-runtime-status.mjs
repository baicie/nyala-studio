import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function read(path) {
	return readFileSync(join(root, path), 'utf8');
}

function assertIncludes(path, text) {
	const content = read(path);
	assert.ok(content.includes(text), `${path} must include ${JSON.stringify(text)}`);
}

function assertNotIncludes(path, text) {
	const content = read(path);
	assert.ok(!content.includes(text), `${path} must not include stale text ${JSON.stringify(text)}`);
}

assertIncludes('README.md', 'SQLite | MVP stable');
assertIncludes('README.md', 'MySQL | Preview');
assertIncludes('README.md', 'PostgreSQL | Planned');
assertIncludes('README.md', 'Query cancellation is not supported yet');

assertIncludes('README.md', 'Phase 00 — Runtime Status Alignment');
assertIncludes('README.md', 'Phase 01 — Connection MVP Stabilization');
assertIncludes('README.md', 'Stabilize MySQL Preview connection flows');
assertIncludes('README.md', 'Keep PostgreSQL visible only as planned');

assertNotIncludes('README.md', 'fork stabilization phase');
assertNotIncludes('README.md', 'Add SQLite connection command bridge');
assertNotIncludes('README.md', 'Add SQLite connection flow');

assertIncludes('src/vs/workbench/services/sql/common/sqlTypes.ts', 'SQLite is the MVP stable runtime driver');
assertIncludes('src/vs/workbench/services/sql/common/sqlTypes.ts', 'MySQL is preview-enabled');
assertIncludes('src/vs/workbench/services/sql/common/sqlTypes.ts', 'PostgreSQL protocol fields are reserved');

assertNotIncludes(
	'src/vs/workbench/services/sql/common/sqlTypes.ts',
	'SQLite remains the only enabled runtime driver'
);

assertIncludes(
	'src/vs/workbench/contrib/sqlConnections/common/sqlConnectionFormModel.ts',
	'MySQL Preview'
);
assertIncludes(
	'src/vs/workbench/contrib/sqlConnections/common/sqlConnectionFormModel.ts',
	'PostgreSQL Planned'
);
assertNotIncludes(
	'src/vs/workbench/contrib/sqlConnections/common/sqlConnectionFormModel.ts',
	'PostgreSQL Preview'
);
assertNotIncludes(
	'src/vs/workbench/contrib/sqlConnections/common/sqlConnectionFormModel.ts',
	'preview-only'
);

assertIncludes(
	'src/vs/workbench/contrib/sqlConnections/common/sqlConnectionTreeModel.ts',
	'MySQL Preview'
);
assertIncludes(
	'src/vs/workbench/contrib/sqlConnections/common/sqlConnectionTreeModel.ts',
	'Add a SQLite or MySQL Preview connection'
);

console.log('SQL runtime status is aligned.');