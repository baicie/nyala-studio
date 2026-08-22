import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const scriptPath = new URL('./create-sql-result-grid-zeus-audit.mjs', import.meta.url).pathname;
const packageMetadata = {
	name: '@zeus-web/data-grid',
	version: '0.1.0-beta.4',
	license: 'MIT',
	dependencies: {
		'@zeus-js/output-react-wrapper': '0.1.1-beta.2',
		'@zeus-js/output-vue-wrapper': '0.1.1-beta.2',
		'@zeus-js/runtime-dom': '0.1.1-beta.2',
		'@zeus-js/web-c-runtime': '0.1.1-beta.2',
		'@zeus-web/virtual': '0.1.0-beta.4',
		'@zeus-web/zeus-compat': '0.1.0-beta.4'
	},
	peerDependencies: {
		'@zeus-js/zeus': '0.1.1-beta.2',
		react: '>=18 || >=19',
		vue: '>=3'
	}
};
const registryMetadata = {
	'dist.integrity': 'sha512-hiaTjf29UY8E/hrMkDm81nVORNWSrqTcInJXQcxZ7azfCfVkN82M8UMe/GDlbQBWksJetq8lT3GbapJEbqZbHA==',
	'dist.unpackedSize': 341_232
};

test('creates a revision-bound Zeus dependency and bundle audit', async () => {
	const fixture = await createFixture();
	try {
		await execFileAsync(process.execPath, createArgs(fixture));
		const report = JSON.parse(await readFile(fixture.outputPath, 'utf8'));
		assert.equal(report.status, 'ready');
		assert.equal(report.provenance.sourceRevision, 'a'.repeat(40));
		assert.equal(report.package.integrity, registryMetadata['dist.integrity']);
		assert.equal(report.package.unpackedSize, registryMetadata['dist.unpackedSize']);
		assert.equal(report.bundle.bytes, fixture.bundle.byteLength);
		assert.equal(report.bundle.gzipBytes, gzipSync(fixture.bundle, { level: 9 }).byteLength);
		assert.equal(report.bundle.sha256, createHash('sha256').update(fixture.bundle).digest('hex'));
		assert.ok(report.checks.every(check => check.passed));
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test('writes blocked evidence when registry integrity changes', async () => {
	const fixture = await createFixture({ ...registryMetadata, 'dist.integrity': 'sha512-forged' });
	try {
		await assert.rejects(execFileAsync(process.execPath, createArgs(fixture)));
		const report = JSON.parse(await readFile(fixture.outputPath, 'utf8'));
		assert.equal(report.status, 'blocked');
		assert.match(report.reasons.join('\n'), /integrity/);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test('writes blocked evidence when registry unpacked size changes', async () => {
	const fixture = await createFixture({ ...registryMetadata, 'dist.unpackedSize': 341_233 });
	try {
		await assert.rejects(execFileAsync(process.execPath, createArgs(fixture)));
		const report = JSON.parse(await readFile(fixture.outputPath, 'utf8'));
		assert.equal(report.status, 'blocked');
		assert.match(report.reasons.join('\n'), /unpackedSize/);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

async function createFixture(registry = registryMetadata) {
	const root = await mkdtemp(join(tmpdir(), 'nyala-zeus-audit-test-'));
	const packagePath = join(root, 'package.json');
	const registryPath = join(root, 'registry.json');
	const bundlePath = join(root, 'data-grid-bundle.js');
	const outputPath = join(root, 'zeus-audit.json');
	const bundle = Buffer.from('customElements.define("zw-data-grid", class extends HTMLElement {});\n');
	await writeFile(packagePath, `${JSON.stringify(packageMetadata)}\n`);
	await writeFile(registryPath, `${JSON.stringify(registry)}\n`);
	await writeFile(bundlePath, bundle);
	return { root, packagePath, registryPath, bundlePath, outputPath, bundle };
}

function createArgs(fixture) {
	return [
		scriptPath,
		'--package-json',
		fixture.packagePath,
		'--registry-json',
		fixture.registryPath,
		'--bundle',
		fixture.bundlePath,
		'--output',
		fixture.outputPath,
		'--repository',
		'baicie/nyala-studio',
		'--source-revision',
		'a'.repeat(40),
		'--source-ref',
		'refs/heads/mvp',
		'--workflow-run-id',
		'123456789',
		'--workflow-run-attempt',
		'1'
	];
}
