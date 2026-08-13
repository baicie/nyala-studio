import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { serveFrontendDist } from './serve-frontend-dist.mjs';

test('frontend dist server serves assets and client routes from loopback', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-frontend-dist-test-'));
	try {
		await mkdir(join(root, 'assets'));
		await writeFile(join(root, 'index.html'), '<!doctype html><title>Nyala</title>');
		await writeFile(join(root, 'assets', 'main.js'), 'console.log("nyala")');
		const server = await serveFrontendDist(root);
		try {
			const index = await fetch(server.url);
			assert.equal(index.status, 200);
			assert.match(await index.text(), /Nyala/);

			const asset = await fetch(`${server.url}assets/main.js`);
			assert.equal(asset.status, 200);
			assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
			assert.match(await asset.text(), /console/);

			const route = await fetch(`${server.url}workbench/sql-agent`);
			assert.equal(route.status, 200);
			assert.match(await route.text(), /Nyala/);
		} finally {
			await server.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('frontend dist server rejects traversal and missing assets', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nyala-frontend-dist-test-'));
	const outside = join(root, '..', `nyala-outside-${Date.now()}.txt`);
	try {
		await writeFile(join(root, 'index.html'), 'index');
		await writeFile(outside, 'secret');
		const server = await serveFrontendDist(root);
		try {
			const traversal = await rawGet(server.url, `/%2e%2e/${outside.split('/').pop()}`);
			assert.equal(traversal.status, 403);
			assert.notEqual(traversal.body, 'secret');
			const missingAsset = await fetch(`${server.url}assets/missing.js`);
			assert.equal(missingAsset.status, 404);
		} finally {
			await server.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { force: true });
	}
});

function rawGet(baseUrl, path) {
	const endpoint = new URL(baseUrl);
	return new Promise((resolveResponse, rejectResponse) => {
		const clientRequest = request(
			{
				hostname: endpoint.hostname,
				method: 'GET',
				path,
				port: endpoint.port
			},
			response => {
				let body = '';
				response.setEncoding('utf8');
				response.on('data', chunk => {
					body += chunk;
				});
				response.once('end', () => resolveResponse({ status: response.statusCode, body }));
			}
		);
		clientRequest.once('error', rejectResponse);
		clientRequest.end();
	});
}
