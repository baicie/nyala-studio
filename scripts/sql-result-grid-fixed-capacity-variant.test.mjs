import assert from 'node:assert/strict';
import test from 'node:test';

import { patchFixedCapacityBundle } from './sql-result-grid-fixed-capacity-variant.mjs';

test('fixed capacity variant patches exactly the virtualized row capacity', () => {
	const source = 'const capacity = Math.min(t.length, Math.ceil(f/n)+r*2+1);';

	assert.equal(patchFixedCapacityBundle(source), 'const capacity = Math.min(t.length, Math.ceil(f/n)+1);');
});

test('fixed capacity variant rejects bundles without one known capacity expression', () => {
	assert.throws(
		() => patchFixedCapacityBundle('const capacity = 15;'),
		/Expected exactly one fixed-capacity expression, found 0/
	);
	assert.throws(
		() => patchFixedCapacityBundle('Math.ceil(f/n)+r*2+1; Math.ceil(f/n)+r*2+1;'),
		/Expected exactly one fixed-capacity expression, found 2/
	);
});
