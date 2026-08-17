#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

const cli = parseArgs(process.argv.slice(2));
const outputPath = resolve(cli.output ?? 'platform-evidence.json');
const macosPath = cli.macos ? resolve(cli.macos) : undefined;
const windowsPath = cli.windows ? resolve(cli.windows) : undefined;

const report = {
	version: 1,
	generatedAt: new Date().toISOString(),
	macosWebKit: await loadEvidence(macosPath, 'macOS WebKit'),
	windowsWebView2: await loadEvidence(windowsPath, 'Windows WebView2')
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`Wrote ${outputPath}\n`);

function parseArgs(args) {
	const result = {};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
		const [key, inlineValue] = argument.slice(2).split('=', 2);
		if (inlineValue !== undefined) {
			result[key] = inlineValue;
			continue;
		}
		result[key] = args[index + 1] ?? 'true';
		index += 1;
	}
	return result;
}

async function loadEvidence(filePath, label) {
	if (!filePath) return blocked(label, 'platform evidence path was not provided');
	try {
		const value = JSON.parse(await readFile(filePath, 'utf8'));
		if (!value || typeof value !== 'object') return blocked(label, 'platform evidence is not an object');
		const artifactDirectory = relative(dirname(outputPath), dirname(filePath)).split(sep).join('/');
		return { ...value, label, artifactDirectory: artifactDirectory || '.' };
	} catch (error) {
		return blocked(
			label,
			`platform evidence could not be loaded: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

function blocked(label, reason) {
	return { label, status: 'blocked', runs: 0, reason };
}
