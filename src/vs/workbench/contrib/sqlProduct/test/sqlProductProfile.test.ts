import assert from 'node:assert/strict';
import test from 'node:test';

import { SQL_CONNECTIONS_VIEW_ID, SQL_CONNECTIONS_VIEWLET_ID } from '../../sqlConnections/common/sqlConnections.js';
import { SQL_RESULT_VIEW_ID, SQL_RESULT_VIEWLET_ID } from '../../sqlResult/common/sqlResult.js';
import { SQL_QUERY_HISTORY_VIEW_ID } from '../../sqlHistory/common/sqlQueryHistory.js';
import {
	assertNoLegacyWorkbenchSurface,
	getSqlProductRequiredSurfaceIds,
	getSqlProductTrimReport,
	isLegacyWorkbenchViewlet,
	isSqlProductPrimaryViewContainer,
	SQL_PRODUCT_LEGACY_WORKBENCH_VIEWLETS,
	SQL_STUDIO_PRODUCT_PROFILE,
	SqlProductWorkbenchSurfaceKind
} from '../common/sqlProductProfile.js';

test('SQL_STUDIO_PRODUCT_PROFILE exposes only SQL primary view containers', () => {
	assert.deepEqual(SQL_STUDIO_PRODUCT_PROFILE.primaryViewContainers, [
		SQL_CONNECTIONS_VIEWLET_ID,
		SQL_RESULT_VIEWLET_ID
	]);

	assert.equal(isSqlProductPrimaryViewContainer(SQL_CONNECTIONS_VIEWLET_ID), true);
	assert.equal(isSqlProductPrimaryViewContainer(SQL_RESULT_VIEWLET_ID), true);
	assert.equal(isSqlProductPrimaryViewContainer('workbench.view.explorer'), false);
});

test('SQL product required surfaces include connections results and history', () => {
	assert.deepEqual(getSqlProductRequiredSurfaceIds(), [
		SQL_CONNECTIONS_VIEWLET_ID,
		SQL_CONNECTIONS_VIEW_ID,
		SQL_RESULT_VIEWLET_ID,
		SQL_RESULT_VIEW_ID,
		SQL_QUERY_HISTORY_VIEW_ID
	]);
});

test('required surfaces have stable kinds and labels', () => {
	const containerSurfaces = SQL_STUDIO_PRODUCT_PROFILE.requiredSurfaces.filter(
		surface => surface.kind === SqlProductWorkbenchSurfaceKind.ViewContainer
	);

	assert.deepEqual(
		containerSurfaces.map(surface => surface.id),
		[
			SQL_CONNECTIONS_VIEWLET_ID,
			SQL_RESULT_VIEWLET_ID
		]
	);

	for (const surface of SQL_STUDIO_PRODUCT_PROFILE.requiredSurfaces) {
		assert.equal(surface.required, true);
		assert.ok(surface.label.length > 0);
	}
});

test('legacy workbench viewlets are marked as legacy', () => {
	assert.equal(isLegacyWorkbenchViewlet('workbench.view.explorer'), true);
	assert.equal(isLegacyWorkbenchViewlet('workbench.view.search'), true);
	assert.equal(isLegacyWorkbenchViewlet('workbench.view.scm'), true);
	assert.equal(isLegacyWorkbenchViewlet('workbench.view.debug'), true);
	assert.equal(isLegacyWorkbenchViewlet('workbench.view.extensions'), true);
	assert.equal(isLegacyWorkbenchViewlet(SQL_CONNECTIONS_VIEWLET_ID), false);
});

test('assertNoLegacyWorkbenchSurface throws for legacy surface', () => {
	assert.throws(
		() => assertNoLegacyWorkbenchSurface([SQL_CONNECTIONS_VIEWLET_ID, 'workbench.view.explorer']),
		/Legacy workbench surface/
	);
});

test('assertNoLegacyWorkbenchSurface accepts SQL-only surfaces', () => {
	assert.doesNotThrow(() => {
		assertNoLegacyWorkbenchSurface([
			SQL_CONNECTIONS_VIEWLET_ID,
			SQL_RESULT_VIEWLET_ID
		]);
	});
});

test('getSqlProductTrimReport classifies ids', () => {
	const report = getSqlProductTrimReport([
		SQL_CONNECTIONS_VIEWLET_ID,
		'workbench.view.explorer',
		'custom.unknown'
	]);

	assert.deepEqual(report.allowed, [SQL_CONNECTIONS_VIEWLET_ID]);
	assert.deepEqual(report.legacy, ['workbench.view.explorer']);
	assert.deepEqual(report.unknown, ['custom.unknown']);
});

test('legacy workbench viewlet list has no duplicates', () => {
	assert.equal(
		new Set(SQL_PRODUCT_LEGACY_WORKBENCH_VIEWLETS).size,
		SQL_PRODUCT_LEGACY_WORKBENCH_VIEWLETS.length
	);
});
