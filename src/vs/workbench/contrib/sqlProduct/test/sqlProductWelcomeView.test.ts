/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product welcome view tests (Phase 08 §3.4).
 *
 * Covers the contract documented in
 * `docs/sql-mvp-phases/phase-08-mvp-packaging.md` §3.4:
 *
 *   * the primary action is reachable and flagged primary;
 *   * the host view can fire an action and listeners receive it;
 *   * the model exposes exactly four canonical actions.
 *
 * Tests stay at the model / event layer; DOM rendering lives in a
 * future `ViewPane` subclass and is exercised separately.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlProductWelcomeView } from '../browser/sqlProductWelcomeView.js';

test('welcome exposes primary action', () => {
	const w = new SqlProductWelcomeView();
	const acts = w.actions();
	const primary = acts.find(a => a.id === 'open.demo');
	assert.ok(primary, 'open.demo action must exist');
	assert.equal(primary?.primary, true, 'open.demo must be the primary action');
});

test('welcome fires events', () => {
	const w = new SqlProductWelcomeView();
	let received: { id: string; label: string } | null = null;
	w.onAct(a => (received = a));
	w.fire({ id: 'new.connection', label: 'Add connection' });
	assert.ok(received, 'listener must receive fired action');
	assert.equal(received?.id, 'new.connection');
	assert.equal(received?.label, 'Add connection');
});

test('welcome has four actions', () => {
	const w = new SqlProductWelcomeView();
	assert.equal(w.actions().length, 4);
});

test('welcome emits actions to multiple listeners', () => {
	const w = new SqlProductWelcomeView();
	const calls: string[] = [];
	w.onAct(a => calls.push('first:' + a.id));
	w.onAct(a => calls.push('second:' + a.id));
	w.fire({ id: 'open.history', label: 'Browse history' });
	assert.deepEqual(calls, ['first:open.history', 'second:open.history']);
});

test('welcome action ids are stable', () => {
	const w = new SqlProductWelcomeView();
	const ids = w.actions().map(a => a.id);
	assert.deepEqual(ids, ['open.demo', 'new.connection', 'open.history', 'docs.shortcuts']);
});