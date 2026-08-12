import assert from 'node:assert/strict';
import test from 'node:test';

test('benchmark script exposes the required workload and renderer vocabulary', async () => {
	const source = await import('node:fs/promises').then(fs =>
		fs.readFile(new URL('./benchmark-sql-result-grid.mjs', import.meta.url), 'utf8')
	);
	assert.match(source, /1_000/);
	assert.match(source, /10_000/);
	assert.match(source, /workbench-table/);
	assert.match(source, /zw-data-grid/);
	assert.match(source, /formatMs/);
	assert.match(source, /fixtureBytes/);
	assert.match(source, /scrollP95Ms/);
	assert.match(source, /visualProbe/);
	assert.match(source, /headerText/);
	assert.match(source, /firstVisibleCellText/);
});

test('benchmark script keeps the browser outside the production workbench', async () => {
	const source = await import('node:fs/promises').then(fs =>
		fs.readFile(new URL('./benchmark-sql-result-grid.mjs', import.meta.url), 'utf8')
	);
	assert.doesNotMatch(source, /src\/vs\/workbench\/contrib\/sqlResult\/browser\/sqlResultView/);
	assert.match(source, /limitations/);
});

test('scroll metric avoids background-throttled timers across native WebViews', async () => {
	const source = await import('node:fs/promises').then(fs =>
		fs.readFile(new URL('./benchmark-sql-result-grid.mjs', import.meta.url), 'utf8')
	);
	assert.match(source, /function commitScroll/);
	assert.match(source, /async function measureScroll/);
	assert.match(source, /dispatchEvent\(new Event\('scroll'\)\)/);
	assert.match(source, /void scrollElement\.offsetHeight/);
	assert.match(source, /await rendered\.grid\.scrollToOffset\(target\)/);
	assert.match(source, /commitScroll\(rendered\.scroll, 0\)/);
	assert.match(source, /rendered\.grid\.scrollToOffset\(0\)/);
	assert.match(source, /firstCellInViewport/);
	assert.match(source, /virtualRowsBounded/);
	assert.match(source, /\[data-slot="data-grid-viewport"\]/);
	assert.match(source, /\[data-slot="data-grid-body"\].*position: absolute/);
	assert.doesNotMatch(source, /function nextFrame/);
});
