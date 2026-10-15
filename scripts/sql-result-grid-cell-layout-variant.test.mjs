import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { appendBlockCellLayout } from './sql-result-grid-cell-layout-variant.mjs';

test('candidate executes the same bundle and installs a real marked cell stylesheet', () => {
	const styles = [];
	const context = {
		document: {
			createElement(tag) {
				assert.equal(tag, 'style');
				return { dataset: {} };
			},
			head: {
				append(style) {
					styles.push(style);
				}
			}
		}
	};
	runInNewContext(appendBlockCellLayout('globalThis.bundleExecuted = true;'), context);
	assert.equal(context.bundleExecuted, true);
	assert.equal(styles.length, 1);
	assert.equal(styles[0].dataset.nyalaCellLayout, 'block-center');
	assert.equal(
		styles[0].textContent,
		'zw-data-grid [data-slot="data-grid-cell"] { display: block; align-content: center; }'
	);
});
