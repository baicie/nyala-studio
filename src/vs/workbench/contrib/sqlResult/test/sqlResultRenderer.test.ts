import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
	SQL_RESULT_NATIVE_RENDERER_ID,
	SQL_RESULT_ZEUS_PREVIEW_RENDERER_ID,
	resolveSqlResultRenderer,
	SqlResultRendererAvailability
} from '../common/sqlResultRenderer.js';
import { DEFAULT_SQL_PRODUCT_PREFERENCES } from '../../sqlProduct/common/sqlProductPreferences.js';

const nativeRendererSource = readFileSync(new URL('../browser/sqlResultNativeRenderer.ts', import.meta.url), 'utf8');

test('result renderer preference defaults to the native renderer', () => {
	assert.equal(DEFAULT_SQL_PRODUCT_PREFERENCES.resultRenderer, SQL_RESULT_NATIVE_RENDERER_ID);
	assert.deepEqual(resolveSqlResultRenderer(DEFAULT_SQL_PRODUCT_PREFERENCES.resultRenderer, { zeusPreview: false }), {
		requested: SQL_RESULT_NATIVE_RENDERER_ID,
		selected: SQL_RESULT_NATIVE_RENDERER_ID,
		fallback: false
	});
});

test('result renderer falls back to native when Zeus Preview is unavailable', () => {
	const availability: SqlResultRendererAvailability = { zeusPreview: false };

	assert.deepEqual(resolveSqlResultRenderer(SQL_RESULT_ZEUS_PREVIEW_RENDERER_ID, availability), {
		requested: SQL_RESULT_ZEUS_PREVIEW_RENDERER_ID,
		selected: SQL_RESULT_NATIVE_RENDERER_ID,
		fallback: true,
		reason: 'Zeus Preview is unavailable.'
	});
});

test('result renderer keeps Preview when the adapter is available', () => {
	assert.deepEqual(resolveSqlResultRenderer(SQL_RESULT_ZEUS_PREVIEW_RENDERER_ID, { zeusPreview: true }), {
		requested: SQL_RESULT_ZEUS_PREVIEW_RENDERER_ID,
		selected: SQL_RESULT_ZEUS_PREVIEW_RENDERER_ID,
		fallback: false
	});
});

test('invalid result renderer preference fails closed to native', () => {
	assert.deepEqual(resolveSqlResultRenderer('unknown', { zeusPreview: true }), {
		requested: SQL_RESULT_NATIVE_RENDERER_ID,
		selected: SQL_RESULT_NATIVE_RENDERER_ID,
		fallback: true,
		reason: 'Unknown result renderer preference.'
	});
});

test('native renderer exposes the success-grid contract and native identity', () => {
	assert.match(nativeRendererSource, /class SqlResultNativeRendererAdapter implements ISqlResultSuccessGridRenderer/);
	assert.match(nativeRendererSource, /readonly id = SQL_RESULT_NATIVE_RENDERER_ID/);
	assert.match(nativeRendererSource, /readonly disposable: IDisposable/);
	assert.match(nativeRendererSource, /onGridActivation/);
});
