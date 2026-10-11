const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_RESULTS = 128;

export function createSqlResultGridResultChannel() {
	const results = new Map();
	const handle = (request, response) => {
		if (request.method !== 'POST' || request.url !== '/benchmark-result') {
			return false;
		}

		const chunks = [];
		let size = 0;
		request.on('data', chunk => {
			size += chunk.length;
			if (size <= MAX_RESULT_BYTES) chunks.push(chunk);
		});
		request.on('end', () => {
			try {
				if (size > MAX_RESULT_BYTES) throw new Error('result payload exceeds 2 MiB');
				const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
				if (typeof result?.runToken !== 'string' || result.runToken.length === 0) {
					throw new Error('result payload is missing runToken');
				}
				if (results.size >= MAX_PENDING_RESULTS) results.delete(results.keys().next().value);
				results.set(result.runToken, result);
				response.writeHead(204);
				response.end();
			} catch (error) {
				response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
				response.end(error instanceof Error ? error.message : String(error));
			}
		});
		return true;
	};
	return {
		handle,
		readResult(runToken) {
			const result = results.get(runToken);
			if (result) results.delete(runToken);
			return result;
		}
	};
}
