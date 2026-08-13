import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const contentTypes = new Map([
	['.css', 'text/css; charset=utf-8'],
	['.gif', 'image/gif'],
	['.html', 'text/html; charset=utf-8'],
	['.ico', 'image/x-icon'],
	['.js', 'text/javascript; charset=utf-8'],
	['.json', 'application/json; charset=utf-8'],
	['.map', 'application/json; charset=utf-8'],
	['.png', 'image/png'],
	['.svg', 'image/svg+xml'],
	['.ttf', 'font/ttf'],
	['.txt', 'text/plain; charset=utf-8'],
	['.wasm', 'application/wasm'],
	['.woff', 'font/woff'],
	['.woff2', 'font/woff2']
]);

/**
 * Serve a built frontend from a loopback-only HTTP origin.
 *
 * Tauri `--no-bundle` debug binaries do not embed `frontendDist`; the native
 * WebDriver harness uses this server as an explicit, local-only page source.
 */
export async function serveFrontendDist(distPath) {
	const root = resolve(distPath);
	const rootInfo = await stat(root).catch(() => undefined);
	if (!rootInfo?.isDirectory()) {
		throw new Error(`Frontend dist directory does not exist: ${root}`);
	}

	const server = createServer(async (request, response) => {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
			response.end('Method not allowed');
			return;
		}

		const rawPathname = String(request.url ?? '/').split(/[?#]/, 1)[0] || '/';
		if (hasTraversalSegment(rawPathname)) {
			response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
			response.end('Forbidden');
			return;
		}
		const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
		const requestedPath = decodePathname(requestUrl.pathname);
		if (requestedPath === undefined) {
			response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
			response.end('Invalid URL path');
			return;
		}

		const candidate = resolve(root, `.${requestedPath}`);
		if (!isWithinRoot(root, candidate)) {
			response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
			response.end('Forbidden');
			return;
		}

		const filePath = await resolveFile(candidate, root, requestedPath);
		if (!filePath) {
			response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
			response.end('Not found');
			return;
		}

		const body = await readFile(filePath);
		response.writeHead(200, {
			'cache-control': 'no-store',
			'content-length': body.byteLength,
			'content-type': contentTypes.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream'
		});
		if (request.method === 'HEAD') response.end();
		else response.end(body);
	});

	await new Promise((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', rejectListen);
			resolveListen();
		});
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		await closeServer(server);
		throw new Error('Frontend dist server did not bind to a TCP port.');
	}

	return {
		root,
		url: `http://127.0.0.1:${address.port}/`,
		close: () => closeServer(server)
	};
}

async function resolveFile(candidate, root, requestedPath) {
	const info = await stat(candidate).catch(() => undefined);
	if (info?.isFile()) return candidate;
	if (info?.isDirectory()) {
		const indexPath = join(candidate, 'index.html');
		const indexInfo = await stat(indexPath).catch(() => undefined);
		if (indexInfo?.isFile()) return indexPath;
	}

	// Workbench routes are client-rendered. Only route-like requests get the
	// index fallback; missing asset requests must remain 404s.
	if (requestedPath === '/' || !extname(requestedPath)) {
		const indexPath = join(root, 'index.html');
		const indexInfo = await stat(indexPath).catch(() => undefined);
		if (indexInfo?.isFile()) return indexPath;
	}
	return undefined;
}

function decodePathname(pathname) {
	try {
		const decoded = decodeURIComponent(pathname);
		if (decoded.includes('\0')) return undefined;
		return decoded;
	} catch {
		return undefined;
	}
}

function hasTraversalSegment(rawPathname) {
	try {
		return decodeURIComponent(rawPathname)
			.split(/[\\/]+/)
			.some(segment => segment === '..');
	} catch {
		return true;
	}
}

function isWithinRoot(root, candidate) {
	const rootWithSeparator = root.endsWith(sep) ? root : `${root}${sep}`;
	return candidate === root || candidate.startsWith(rootWithSeparator);
}

function closeServer(server) {
	server.closeAllConnections?.();
	return new Promise(resolveClose => {
		if (!server.listening) {
			resolveClose();
			return;
		}
		server.close(() => resolveClose());
	});
}
