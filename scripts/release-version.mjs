import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const VERSION_FILES = {
	packageJson: 'package.json',
	tauriConfig: 'src-tauri/tauri.conf.json',
	cargoManifest: 'src-tauri/Cargo.toml',
	cargoLock: 'Cargo.lock'
};

function fail(message) {
	throw new Error(message);
}

export function validateReleaseVersion(version) {
	if (typeof version !== 'string' || version.length === 0 || version.trim() !== version) {
		fail('Release version must be a non-empty SemVer string without surrounding whitespace.');
	}

	const buildSeparator = version.indexOf('+');
	const coreAndPrerelease = buildSeparator === -1 ? version : version.slice(0, buildSeparator);
	const build = buildSeparator === -1 ? undefined : version.slice(buildSeparator + 1);
	if (buildSeparator !== -1 && (!build || !isValidIdentifierList(build, false))) {
		fail(`Invalid SemVer build metadata: ${version}`);
	}

	const prereleaseSeparator = coreAndPrerelease.indexOf('-');
	const core = prereleaseSeparator === -1 ? coreAndPrerelease : coreAndPrerelease.slice(0, prereleaseSeparator);
	const prerelease = prereleaseSeparator === -1 ? undefined : coreAndPrerelease.slice(prereleaseSeparator + 1);
	const coreParts = core.split('.');

	if (coreParts.length !== 3 || coreParts.some(part => !/^(0|[1-9]\d*)$/.test(part))) {
		fail(`Release version must use SemVer major.minor.patch syntax: ${version}`);
	}

	if (prereleaseSeparator !== -1 && (!prerelease || !isValidIdentifierList(prerelease, true))) {
		fail(`Invalid SemVer prerelease identifiers: ${version}`);
	}

	return version;
}

function isValidIdentifierList(value, rejectNumericLeadingZeros) {
	return value.split('.').every(identifier => {
		if (!/^[0-9A-Za-z-]+$/.test(identifier)) {
			return false;
		}
		return !(rejectNumericLeadingZeros && /^\d+$/.test(identifier) && identifier.length > 1 && identifier[0] === '0');
	});
}

export function isPrereleaseVersion(version) {
	validateReleaseVersion(version);
	return version.split('+', 1)[0].includes('-');
}

export function parseReleaseArguments(arguments_) {
	return arguments_.filter(argument => argument !== '--');
}

function cargoPackageBlock(source) {
	const marker = '[package]';
	const markerIndex = source.indexOf(marker);
	if (markerIndex === -1) {
		fail('src-tauri/Cargo.toml does not contain a [package] section.');
	}

	const bodyStart = source.indexOf('\n', markerIndex);
	if (bodyStart === -1) {
		fail('src-tauri/Cargo.toml has an empty [package] section.');
	}

	const nextSection = source.indexOf('\n[', bodyStart + 1);
	const bodyEnd = nextSection === -1 ? source.length : nextSection;
	return { start: bodyStart + 1, end: bodyEnd, value: source.slice(bodyStart + 1, bodyEnd) };
}

export function readCargoPackageVersion(source) {
	const block = cargoPackageBlock(source).value;
	const matches = [...block.matchAll(/^version\s*=\s*"([^"]+)"\s*$/gm)];
	if (matches.length !== 1) {
		fail(`Expected one package version in src-tauri/Cargo.toml, found ${matches.length}.`);
	}
	return matches[0][1];
}

export function replaceCargoPackageVersion(source, version) {
	validateReleaseVersion(version);
	const block = cargoPackageBlock(source);
	const currentVersion = readCargoPackageVersion(source);
	const nextBlock = block.value.replace(
		new RegExp(`^version\\s*=\\s*"${escapeRegExp(currentVersion)}"\\s*$`, 'm'),
		`version = "${version}"`
	);
	return `${source.slice(0, block.start)}${nextBlock}${source.slice(block.end)}`;
}

export function readCargoLockPackageVersion(source, packageName) {
	const blocks = source.split(/(?=^\[\[package\]\]$)/m);
	const matchingBlocks = blocks.filter(block => {
		const name = block.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1];
		return name === packageName;
	});
	if (matchingBlocks.length !== 1) {
		fail(`Expected one ${packageName} package in Cargo.lock, found ${matchingBlocks.length}.`);
	}
	const version = matchingBlocks[0].match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
	if (!version) {
		fail(`Cargo.lock package ${packageName} does not declare a version.`);
	}
	return version;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatJson(source, value) {
	const indent = source.match(/\n([\t ]+)"/)?.[1] ?? '\t';
	return `${JSON.stringify(value, null, indent)}\n`;
}

async function formatJsonFiles(root, paths) {
	const prettier = await import('prettier');
	await Promise.all(
		paths.map(async path => {
			const filePath = `${root}/${path}`;
			const [source, config] = await Promise.all([readFile(filePath, 'utf8'), prettier.resolveConfig(filePath)]);
			const formatted = await prettier.format(source, { ...config, filepath: filePath });
			await writeFile(filePath, formatted);
		})
	);
}

async function readReleaseFiles(root) {
	const [packageJsonSource, tauriConfigSource, cargoManifestSource, cargoLockSource] = await Promise.all([
		readFile(`${root}/${VERSION_FILES.packageJson}`, 'utf8'),
		readFile(`${root}/${VERSION_FILES.tauriConfig}`, 'utf8'),
		readFile(`${root}/${VERSION_FILES.cargoManifest}`, 'utf8'),
		readFile(`${root}/${VERSION_FILES.cargoLock}`, 'utf8')
	]);

	return {
		packageJsonSource,
		tauriConfigSource,
		cargoManifestSource,
		cargoLockSource,
		packageJson: JSON.parse(packageJsonSource),
		tauriConfig: JSON.parse(tauriConfigSource)
	};
}

export function assertReleaseVersions(versions, expectedVersion) {
	const expected = expectedVersion === undefined ? undefined : validateReleaseVersion(expectedVersion);
	const entries = Object.entries(versions);
	if (entries.length === 0) {
		fail('At least one release version source is required.');
	}
	for (const [source, version] of entries) {
		try {
			validateReleaseVersion(version);
		} catch (error) {
			fail(`${source} has an invalid release version: ${error.message}`);
		}
	}

	const reference = expected ?? entries[0]?.[1];
	const mismatches = entries.filter(([, version]) => version !== reference);
	if (mismatches.length > 0) {
		fail(
			`Release version mismatch; expected ${reference}: ${entries.map(([source, version]) => `${source}=${version}`).join(', ')}`
		);
	}
	return reference;
}

async function checkReleaseVersion(root, expectedVersion) {
	const files = await readReleaseFiles(root);
	const version = assertReleaseVersions(
		{
			'package.json': files.packageJson.version,
			'src-tauri/tauri.conf.json': files.tauriConfig.version,
			'src-tauri/Cargo.toml': readCargoPackageVersion(files.cargoManifestSource),
			'Cargo.lock': readCargoLockPackageVersion(files.cargoLockSource, 'sql-studio-next')
		},
		expectedVersion
	);
	console.log(`Release version ${version} is valid and consistent.`);
	return version;
}

async function prepareReleaseVersion(root, version) {
	validateReleaseVersion(version);
	const files = await readReleaseFiles(root);
	assertReleaseVersions({
		'package.json': files.packageJson.version,
		'src-tauri/tauri.conf.json': files.tauriConfig.version,
		'src-tauri/Cargo.toml': readCargoPackageVersion(files.cargoManifestSource),
		'Cargo.lock': readCargoLockPackageVersion(files.cargoLockSource, 'sql-studio-next')
	});

	files.packageJson.version = version;
	files.tauriConfig.version = version;
	await Promise.all([
		writeFile(`${root}/${VERSION_FILES.packageJson}`, formatJson(files.packageJsonSource, files.packageJson)),
		writeFile(`${root}/${VERSION_FILES.tauriConfig}`, formatJson(files.tauriConfigSource, files.tauriConfig)),
		writeFile(`${root}/${VERSION_FILES.cargoManifest}`, replaceCargoPackageVersion(files.cargoManifestSource, version))
	]);

	await formatJsonFiles(root, [VERSION_FILES.packageJson, VERSION_FILES.tauriConfig]);

	const cargoCheck = spawnSync('cargo', ['check', '-p', 'sql-studio-next', '--quiet'], {
		cwd: root,
		stdio: ['ignore', 'ignore', 'inherit']
	});
	if (cargoCheck.error) {
		throw cargoCheck.error;
	}
	if (cargoCheck.status !== 0) {
		fail(`cargo check failed with exit code ${cargoCheck.status}.`);
	}

	await checkReleaseVersion(root, version);
	console.log(`Prepared Nyala Studio ${version}.`);
}

async function main() {
	const arguments_ = parseReleaseArguments(process.argv.slice(2));
	const [command, version] = arguments_;
	if (command === 'check' && arguments_.length <= 2) {
		await checkReleaseVersion(process.cwd(), version);
		return;
	}
	if (command === 'prepare' && version && arguments_.length === 2) {
		await prepareReleaseVersion(process.cwd(), version);
		return;
	}
	fail('Usage: release-version.mjs check [version] | prepare <version>');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	main().catch(error => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
