const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

export class CdpClient {
	static async connect(url, deadline, options) {
		const socket = new WebSocket(url);
		try {
			await waitForOpen(socket, url, deadline);
			return new CdpClient(socket, options);
		} catch (error) {
			socket.close();
			throw error;
		}
	}

	constructor(socket, { commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
		if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs < 1) {
			throw new Error(`CDP command timeout must be a positive integer, got ${commandTimeoutMs}.`);
		}
		this.socket = socket;
		this.commandTimeoutMs = commandTimeoutMs;
		this.sequence = 0;
		this.pending = new Map();
		this.closedError = undefined;
		socket.addEventListener('message', event => this.handleMessage(event));
		socket.addEventListener('close', () => this.failPending(new Error('CDP connection closed.')));
		socket.addEventListener('error', () => this.failPending(new Error('CDP connection error.')));
	}

	send(method, params = {}, { timeoutMs = this.commandTimeoutMs } = {}) {
		if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
			return Promise.reject(new Error(`CDP command timeout must be a positive integer, got ${timeoutMs}.`));
		}
		if (this.closedError) return Promise.reject(this.closedError);

		return new Promise((resolveCommand, rejectCommand) => {
			const id = ++this.sequence;
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				rejectCommand(new Error(`CDP command ${method} timed out after ${timeoutMs}ms.`));
			}, timeoutMs);
			this.pending.set(id, { method, resolve: resolveCommand, reject: rejectCommand, timeout });
			try {
				this.socket.send(JSON.stringify({ id, method, params }));
			} catch (error) {
				clearTimeout(timeout);
				this.pending.delete(id);
				rejectCommand(error);
			}
		});
	}

	close() {
		this.failPending(new Error('CDP connection closed.'));
		this.socket.close();
	}

	handleMessage(event) {
		let message;
		try {
			message = JSON.parse(String(event.data));
		} catch {
			this.failPending(new Error('CDP connection returned an invalid JSON message.'));
			return;
		}
		const pending = this.pending.get(message.id);
		if (!pending) return;
		clearTimeout(pending.timeout);
		this.pending.delete(message.id);
		if (message.error) {
			pending.reject(new Error(`CDP command ${pending.method} failed: ${JSON.stringify(message.error)}`));
		} else {
			pending.resolve(message.result);
		}
	}

	failPending(error) {
		if (!this.closedError) this.closedError = error;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(this.closedError);
		}
		this.pending.clear();
	}
}

async function waitForOpen(socket, url, deadline) {
	await new Promise((resolveConnection, rejectConnection) => {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			rejectConnection(new Error(`Timed out connecting to ${url}.`));
			return;
		}
		let settled = false;
		const settle = callback => event => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.removeEventListener('open', handleOpen);
			socket.removeEventListener('error', handleError);
			callback(event);
		};
		const timeout = setTimeout(
			settle(() => rejectConnection(new Error(`Timed out connecting to ${url}.`))),
			remaining
		);
		const handleOpen = settle(resolveConnection);
		const handleError = settle(() => rejectConnection(new Error(`Could not connect to ${url}.`)));
		socket.addEventListener('open', handleOpen, { once: true });
		socket.addEventListener('error', handleError, { once: true });
	});
}
