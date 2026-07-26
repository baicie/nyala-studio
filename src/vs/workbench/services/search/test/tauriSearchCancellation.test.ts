import assert from 'node:assert/strict';
import test from 'node:test';

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { raceTauriSearchRequest } from '../common/tauriSearchCancellation.js';

test('raceTauriSearchRequest returns the backend result without a token', async () => {
	await assert.doesNotReject(async () => {
		assert.deepEqual(await raceTauriSearchRequest(Promise.resolve(['match'])), ['match']);
	});
});

test('raceTauriSearchRequest rejects when cancellation wins the backend race', async () => {
	let resolveRequest: ((value: string[]) => void) | undefined;
	const request = new Promise<string[]>(resolve => {
		resolveRequest = resolve;
	});
	const source = new CancellationTokenSource();
	const result = raceTauriSearchRequest(request, source.token);

	source.cancel();
	await assert.rejects(result, error => isCancellationError(error));
	resolveRequest?.(['late match']);
	source.dispose();
});
