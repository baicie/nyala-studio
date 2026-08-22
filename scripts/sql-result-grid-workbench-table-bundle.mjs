import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const entryPath = fileURLToPath(new URL('./sql-result-grid-workbench-table-entry.ts', import.meta.url));

export async function buildSqlResultGridWorkbenchTableBundle() {
	const buildResult = await build({
		root: repositoryRoot,
		configFile: false,
		publicDir: false,
		logLevel: 'silent',
		resolve: {
			alias: {
				vs: fileURLToPath(new URL('../src/vs', import.meta.url))
			}
		},
		build: {
			write: false,
			target: ['es2022', 'chrome100', 'safari15'],
			minify: 'esbuild',
			sourcemap: false,
			cssCodeSplit: false,
			rollupOptions: {
				input: entryPath,
				output: {
					format: 'es',
					codeSplitting: false,
					entryFileNames: 'workbench-table-benchmark.js',
					assetFileNames: '[name][extname]'
				}
			}
		}
	});
	const outputs = (Array.isArray(buildResult) ? buildResult : [buildResult]).flatMap(result => result.output);
	const chunks = outputs.filter(output => output.type === 'chunk');
	const cssAssets = outputs.filter(output => output.type === 'asset' && output.fileName.endsWith('.css'));
	const unsupportedAssets = outputs.filter(output => output.type === 'asset' && !output.fileName.endsWith('.css'));
	if (chunks.length !== 1 || cssAssets.length !== 1 || unsupportedAssets.length !== 0) {
		throw new Error(
			`Expected one WorkbenchTable JavaScript chunk and one CSS asset; got ${chunks.length} chunks, ${cssAssets.length} CSS assets, and ${unsupportedAssets.length} unsupported assets.`
		);
	}
	const javascript = chunks[0].code;
	const css = String(cssAssets[0].source);
	const sha256 = createHash('sha256').update(javascript).update('\0').update(css).digest('hex');
	return {
		javascript,
		css,
		sha256,
		javascriptBytes: Buffer.byteLength(javascript),
		cssBytes: Buffer.byteLength(css)
	};
}
