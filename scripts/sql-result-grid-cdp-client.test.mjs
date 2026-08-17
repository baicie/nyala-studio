import assert from 'node:assert/strict';
import test from 'node:test';
import { CdpClient } from './sql-result-grid-cdp-client.mjs';

class FakeSocket extends EventTarget {
	constructor() {
		super();
		this.sent = [];
	}

	send(payload) {
		this.sent.push(JSON.parse(payload));
	}

	respond(id, result) {
		this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, result }) }));
	}

	close() {
		this.dispatchEvent(new Event('close'));
	}
}

test('CDP command resolves only its matching response', async () => {
	const socket = new FakeSocket();
	const client = new CdpClient(socket, { commandTimeoutMs: 100 });
	const command = client.send('Runtime.evaluate', { expression: '1 + 1' });
	assert.equal(socket.sent.length, 1);
	socket.respond(socket.sent[0].id, { result: { value: 2 } });
	assert.deepEqual(await command, { result: { value: 2 } });
	client.close();
});

test('CDP command rejects within its per-command timeout', async () => {
	const socket = new FakeSocket();
	const client = new CdpClient(socket, { commandTimeoutMs: 20 });
	await assert.rejects(client.send('Runtime.evaluate'), /Runtime\.evaluate.*timed out.*20ms/i);
	client.close();
});

test('CDP socket close rejects every pending command', async () => {
	const socket = new FakeSocket();
	const client = new CdpClient(socket, { commandTimeoutMs: 1_000 });
	const first = client.send('Page.navigate');
	const second = client.send('Runtime.evaluate');
	socket.dispatchEvent(new Event('close'));
	await assert.rejects(first, /connection closed/i);
	await assert.rejects(second, /connection closed/i);
});

test('CDP socket error rejects every pending command', async () => {
	const socket = new FakeSocket();
	const client = new CdpClient(socket, { commandTimeoutMs: 1_000 });
	const command = client.send('Page.navigate');
	socket.dispatchEvent(new Event('error'));
	await assert.rejects(command, /connection error/i);
});
