import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSqlDriverStatusBadge, renderSqlDriverStatusBadge } from '../browser/driverCardBadge.js';
import { ISqlDriverCatalogService, SqlRuntimeDriverId, SqlRuntimeStatus } from '../../../../workbench/services/sql/common/sqlDriverCatalog.js';

class StubCatalog implements ISqlDriverCatalogService {
	declare readonly _serviceBrand: undefined;

	constructor(entries) {
		this.entries = entries;
	}

	async getRuntimeStatus() {
		return this.entries;
	}

	getCachedRuntimeStatus() {
		return this.entries;
	}

	findRuntimeStatus(id) {
		return this.entries.find(entry => entry.id === id);
	}

	isDriverRunnable(id) {
		const entry = this.findRuntimeStatus(id);
		return entry?.status === SqlRuntimeStatus.Stable || entry?.status === SqlRuntimeStatus.Preview;
	}
}

const stable = (id) => ({ id, displayName: id === 'sqlite' ? 'SQLite' : id === 'mysql' ? 'MySQL' : id === 'postgres' ? 'PostgreSQL' : id, status: SqlRuntimeStatus.Stable, summary: `${id === 'sqlite' ? 'SQLite' : id === 'mysql' ? 'MySQL' : id === 'postgres' ? 'PostgreSQL' : id} stable summary`, notes: Object.freeze(['note']) });
const preview = (id) => ({ id, displayName: id === 'sqlite' ? 'SQLite' : id === 'mysql' ? 'MySQL' : id === 'postgres' ? 'PostgreSQL' : id, status: SqlRuntimeStatus.Preview, summary: `${id === 'sqlite' ? 'SQLite' : id === 'mysql' ? 'MySQL' : id === 'postgres' ? 'PostgreSQL' : id} preview summary`, notes: Object.freeze(['note']) });
const planned = (id) => ({ id, displayName: id === 'sqlite' ? 'SQLite' : id === 'mysql' ? 'MySQL' : id === 'postgres' ? 'PostgreSQL' : id, status: SqlRuntimeStatus.Planned, summary: `${id === 'sqlite' ? 'SQLite' : id === 'mysql' ? 'MySQL' : id === 'postgres' ? 'PostgreSQL' : id} planned summary`, notes: Object.freeze(['note']) });

test('buildSqlDriverStatusBadge returns Stable class for sqlite', () => {
	const badge = buildSqlDriverStatusBadge(new StubCatalog([stable(SqlRuntimeDriverId.Sqlite)]), SqlRuntimeDriverId.Sqlite);
	assert.equal(badge.text, 'Stable');
	assert.equal(badge.runnable, true);
	assert.match(badge.className, /--stable/);
	assert.match(badge.title, /SQLite/);
});

test('buildSqlDriverStatusBadge returns Preview class for mysql', () => {
	const badge = buildSqlDriverStatusBadge(new StubCatalog([preview(SqlRuntimeDriverId.MySql)]), SqlRuntimeDriverId.MySql);
	assert.equal(badge.text, 'Preview');
	assert.equal(badge.runnable, true);
	assert.match(badge.className, /--preview/);
});

test('buildSqlDriverStatusBadge returns Planned class and not runnable for postgres', () => {
	const badge = buildSqlDriverStatusBadge(new StubCatalog([planned(SqlRuntimeDriverId.Postgres)]), SqlRuntimeDriverId.Postgres);
	assert.equal(badge.text, 'Planned');
	assert.equal(badge.runnable, false);
	assert.match(badge.className, /--planned/);
});

test('buildSqlDriverStatusBadge returns unknown badge for unknown ids', () => {
	const badge = buildSqlDriverStatusBadge(new StubCatalog([]), 'unknown');
	assert.equal(badge.text, 'Unknown');
	assert.equal(badge.runnable, false);
	assert.match(badge.className, /--disabled/);
});

test('renderSqlDriverStatusBadge escapes special characters', () => {
	const badge = {
		text: 'Stable',
		ariaLabel: 'SQLite runtime status: Stable',
		title: 'SQLite <preview & stable>',
		className: 'sql-driver-status-badge sql-driver-status-badge--stable',
		runnable: true
	};

	const html = renderSqlDriverStatusBadge(badge);
	assert.doesNotMatch(html, /<preview/);
	assert.match(html, /&lt;preview/);
	assert.match(html, /&amp; stable/);
});
