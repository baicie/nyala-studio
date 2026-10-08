#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);
const repositoryRoot = resolve(scriptDirectory, '..');
const candidate = {
	name: 'sqlparser',
	version: '0.62.0',
	license: 'Apache-2.0',
	repository: 'https://github.com/apache/datafusion-sqlparser-rs'
};
const commandTimeoutMs = 5 * 60 * 1000;
const buildTimeoutMs = 10 * 60 * 1000;
const fetchTimeoutMs = 30 * 1000;
const maxFetchBodyBytes = 4 * 1024 * 1024;
const maxCommandBufferBytes = 32 * 1024 * 1024;
const fixtures = [
	{
		id: 'sqlite-select',
		dialect: 'sqlite',
		sql: 'SELECT * FROM users',
		expectedStatementCount: 1,
		localRisk: 'read_only'
	},
	{
		id: 'sqlite-explain-query-plan',
		dialect: 'sqlite',
		sql: 'EXPLAIN QUERY PLAN SELECT * FROM users',
		expectedStatementCount: 1,
		localRisk: 'explain_read_only'
	},
	{
		id: 'sqlite-cte-select',
		dialect: 'sqlite',
		sql: 'WITH recent AS (SELECT * FROM orders) SELECT * FROM recent',
		expectedStatementCount: 1,
		localRisk: 'read_only'
	},
	{
		id: 'sqlite-pragma-assignment',
		dialect: 'sqlite',
		sql: 'PRAGMA journal_mode = WAL',
		expectedStatementCount: 1,
		localRisk: 'unknown'
	},
	{
		id: 'mysql-into-outfile',
		dialect: 'mysql',
		sql: "SELECT * FROM users INTO OUTFILE '/tmp/users.csv'",
		expectedStatementCount: 1,
		localRisk: 'forbidden'
	},
	{
		id: 'mysql-lock-in-share-mode',
		dialect: 'mysql',
		sql: 'SELECT * FROM users LOCK IN SHARE MODE',
		expectedStatementCount: 1,
		localRisk: 'transactional_write'
	},
	{
		id: 'mysql-versioned-comment',
		dialect: 'mysql',
		sql: '/*!50000 SELECT * FROM users */',
		expectedStatementCount: 1,
		localRisk: 'unknown'
	},
	{
		id: 'postgres-for-no-key-update',
		dialect: 'postgresql',
		sql: 'SELECT * FROM users FOR NO KEY UPDATE',
		expectedStatementCount: 1,
		localRisk: 'transactional_write'
	},
	{
		id: 'postgres-dollar-quoted-semicolon',
		dialect: 'postgresql',
		sql: 'SELECT $tag$semi;colon$tag$',
		expectedStatementCount: 1,
		localRisk: 'read_only'
	},
	{
		id: 'sqlite-cte-update',
		dialect: 'sqlite',
		sql: 'WITH stale AS (SELECT id FROM users) UPDATE users SET active = 0',
		expectedStatementCount: 1,
		localRisk: 'transactional_write'
	},
	{
		id: 'generic-select-drop',
		dialect: 'generic',
		sql: 'SELECT 1; DROP TABLE users',
		expectedStatementCount: 2,
		localRisk: 'unknown'
	}
];

const commands = [];
const activeChildren = new Set();
const terminationController = new AbortController();
let terminationSignal = null;
let temporaryDirectory = null;
let canonicalTemporaryDirectory = null;

await main();

async function main() {
	const signalHandlers = installSignalHandlers();
	let failure = null;
	let report = null;
	let outputPath = null;

	try {
		outputPath = parseArguments(process.argv.slice(2));
		throwIfTerminated();
		temporaryDirectory = await mkdtemp(join(tmpdir(), 'nyala-sqlparser-spike-'));
		canonicalTemporaryDirectory = await realpath(temporaryDirectory);
		throwIfTerminated();
		report = await collectEvidence();
	} catch (error) {
		failure = error;
	} finally {
		try {
			if (temporaryDirectory !== null) {
				await rm(temporaryDirectory, { recursive: true, force: true });
			}
		} catch (error) {
			failure ??= error;
		} finally {
			removeSignalHandlers(signalHandlers);
		}
	}

	if (terminationSignal !== null) {
		failure ??= new Error(`received ${terminationSignal}`);
		process.exitCode = signalExitCode(terminationSignal);
	}

	if (failure !== null || report === null) {
		const message = normalize(failure instanceof Error ? failure.message : String(failure));
		process.stdout.write(`${JSON.stringify({ version: 2, status: 'failed', error: message, commands }, null, '\t')}\n`);
		process.exitCode ||= 1;
		return;
	}

	const serializedReport = `${JSON.stringify(report, null, '\t')}\n`;
	try {
		if (outputPath !== null) {
			await writeFile(outputPath, serializedReport, 'utf8');
		}
		process.stdout.write(serializedReport);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`failed to write parser spike evidence: ${message}\n`);
		process.exitCode = 1;
	}
}

async function collectEvidence() {
	const generatedAt = new Date().toISOString();
	const repositoryManifest = await readFile(join(repositoryRoot, 'Cargo.toml'), 'utf8');
	const runnerSource = await readFile(scriptPath);
	const repositoryMsrv = matchRequired(repositoryManifest, /rust-version\s*=\s*"([^"]+)"/, 'workspace rust-version');
	const cargoManifest = createCargoManifest(repositoryMsrv);
	const rustSource = createRustSource();
	await writeFile(join(temporaryDirectory, 'Cargo.toml'), cargoManifest, 'utf8');
	await writeFile(join(temporaryDirectory, 'src.rs'), rustSource, 'utf8');

	const { commandEnvironment, environmentPolicy, cargoTargetDirectory } = createCommandEnvironment();
	const commandOptions = { cwd: temporaryDirectory, env: commandEnvironment };
	const rustc = await run('rustc', ['--version', '--verbose'], commandOptions);
	const cargo = await run('cargo', ['--version', '--verbose'], commandOptions);
	const cargoInfo = await run('cargo', ['info', `${candidate.name}@${candidate.version}`], commandOptions);
	await run('cargo', ['generate-lockfile'], commandOptions);
	const cargoTree = await run(
		'cargo',
		['tree', '--features', 'parser', '--edges', 'normal,build', '--locked'],
		commandOptions
	);
	const metadataResult = await run(
		'cargo',
		['metadata', '--format-version', '1', '--features', 'parser', '--locked'],
		commandOptions
	);
	const metadata = parseCargoMetadata(metadataResult.stdout);
	const cargoLock = normalize(await readFile(join(temporaryDirectory, 'Cargo.lock'), 'utf8'));
	const lockedCandidateChecksum = findLockedCandidateChecksum(cargoLock);
	const packages = normalizePackages(metadata.packages);
	const candidatePackage = packages.find(pkg => pkg.name === candidate.name && pkg.version === candidate.version);
	validateCandidatePackage(candidatePackage, lockedCandidateChecksum);

	await run('cargo', ['build', '--release', '--no-default-features', '--locked'], commandOptions);
	const binaryPath = join(
		cargoTargetDirectory,
		'release',
		process.platform === 'win32' ? 'nyala-sqlparser-spike.exe' : 'nyala-sqlparser-spike'
	);
	const baselineBinary = await readFile(binaryPath);
	await run('cargo', ['build', '--release', '--features', 'parser', '--locked'], commandOptions);
	const parserBinary = await readFile(binaryPath);
	const fixtureRun = await run(binaryPath, [], commandOptions, { displayProgram: 'harness-binary' });
	const corpus = parseCorpus(fixtureRun.stdout);
	const normalizedCargoTree = `${cargoTree.stdout.trimEnd()}\n`;
	const msrv = await collectMsrvEvidence(repositoryMsrv, commandOptions);
	const maintenance = await collectMaintenanceEvidence(candidatePackage, lockedCandidateChecksum, cargoInfo);
	const binary = {
		baselineBytes: baselineBinary.byteLength,
		parserBytes: parserBinary.byteLength,
		deltaBytes: parserBinary.byteLength - baselineBinary.byteLength,
		baselineSha256: sha256(baselineBinary),
		parserSha256: sha256(parserBinary)
	};
	const dependencyClosure = {
		packageCountIncludingHarness: packages.length,
		licenses: [...new Set(packages.map(pkg => pkg.license ?? 'UNKNOWN'))].sort(),
		packages,
		packagesSha256: sha256(JSON.stringify(packages)),
		cargoTree: normalizedCargoTree,
		cargoTreeSha256: sha256(normalizedCargoTree),
		cargoLock,
		cargoLockSha256: sha256(cargoLock),
		lockedCandidate: {
			name: candidate.name,
			version: candidate.version,
			checksum: lockedCandidateChecksum
		}
	};
	const harness = {
		temporaryOnly: true,
		candidate: `${candidate.name} =${candidate.version}`,
		candidateDefaultFeatures: metadata.packages.find(
			pkg => pkg.name === candidate.name && pkg.version === candidate.version
		)?.features.default,
		fixtureCount: fixtures.length,
		runnerScriptSha256: sha256(runnerSource),
		cargoManifest,
		cargoManifestSha256: sha256(cargoManifest),
		rustSource,
		rustSourceSha256: sha256(rustSource),
		sourceSetSha256: sha256(`${cargoManifest}\0${rustSource}`)
	};
	const environment = {
		platform: process.platform,
		architecture: process.arch,
		rustc: rustc.stdout.trim().split('\n'),
		cargo: cargo.stdout.trim().split('\n'),
		repositoryMsrv,
		candidateRustVersion: candidatePackage.rustVersion,
		commandTimeoutMs,
		buildTimeoutMs,
		fetchTimeoutMs,
		maxFetchBodyBytes,
		environmentPolicy,
		msrv
	};
	const measurement = {
		version: 1,
		harness,
		environment,
		dependencyClosure,
		binary,
		corpus
	};
	const measurementSha256 = sha256(JSON.stringify(measurement));

	return {
		version: 2,
		status: 'complete',
		generatedAt,
		recordedDecision: 'NO-GO',
		decisionReasons: [
			`${corpus.summary.dialectGapCount} of ${corpus.summary.fixtureCount} fixtures expose parser gaps`,
			`the release harness grows by ${binary.deltaBytes} bytes with default parser features`,
			candidatePackage.rustVersion === null
				? `the candidate does not declare rust-version; repository MSRV ${repositoryMsrv} compatibility is ${msrv.status}`
				: `the candidate declares rust-version ${candidatePackage.rustVersion}`
		],
		measurementSha256,
		measurementDigest: {
			algorithm: 'sha256',
			canonicalization: 'UTF-8 bytes of JSON.stringify(measurementDigest.payload)',
			sha256: measurementSha256,
			payload: measurement
		},
		maintenance,
		commands
	};
}

function parseArguments(args) {
	let outputPath = null;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument !== '--output') throw new Error(`unknown argument: ${argument}`);
		if (outputPath !== null) throw new Error('--output may only be provided once');
		const value = args[index + 1];
		if (value === undefined || value.length === 0 || value.startsWith('--')) {
			throw new Error('--output requires a path');
		}
		outputPath = resolve(process.cwd(), value);
		index += 1;
	}
	return outputPath;
}

function createCargoManifest(repositoryMsrv) {
	return `[package]
name = "nyala-sqlparser-spike"
version = "0.0.0"
edition = "2021"
rust-version = "${repositoryMsrv}"
license = "MIT"

[[bin]]
name = "nyala-sqlparser-spike"
path = "src.rs"

[features]
default = []
parser = ["dep:sqlparser"]

[dependencies]
sqlparser = { version = "=${candidate.version}", optional = true }
`;
}

function createRustSource() {
	const rows = fixtures
		.map(
			fixture =>
				`        Fixture { id: ${JSON.stringify(fixture.id)}, dialect: ${JSON.stringify(fixture.dialect)}, sql: ${JSON.stringify(fixture.sql)} },`
		)
		.join('\n');
	return `#[cfg(feature = "parser")]
use sqlparser::dialect::{GenericDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect};
#[cfg(feature = "parser")]
use sqlparser::parser::Parser;

#[cfg(feature = "parser")]
struct Fixture {
    id: &'static str,
    dialect: &'static str,
    sql: &'static str,
}

#[cfg(not(feature = "parser"))]
fn main() {
    println!("parser feature disabled");
}

#[cfg(feature = "parser")]
fn main() {
    let fixtures = [
${rows}
    ];

    for fixture in fixtures {
        let parsed = match fixture.dialect {
            "sqlite" => Parser::parse_sql(&SQLiteDialect {}, fixture.sql),
            "mysql" => Parser::parse_sql(&MySqlDialect {}, fixture.sql),
            "postgresql" => Parser::parse_sql(&PostgreSqlDialect {}, fixture.sql),
            "generic" => Parser::parse_sql(&GenericDialect {}, fixture.sql),
            _ => unreachable!("fixed fixture dialect"),
        };
        match parsed {
            Ok(statements) => println!("{}\\tparsed\\t{}\\t", fixture.id, statements.len()),
            Err(error) => println!(
                "{}\\trejected\\t0\\t{}",
                fixture.id,
                error
                    .to_string()
                    .replace('\\t', " ")
                    .replace('\\n', " ")
                    .replace('\\r', " ")
            ),
        }
    }
}
`;
}

function createCommandEnvironment() {
	const passThroughKeys = [
		'ALL_PROXY',
		'COMSPEC',
		'HOME',
		'HTTP_PROXY',
		'HTTPS_PROXY',
		'LANG',
		'LC_ALL',
		'LC_CTYPE',
		'LOGNAME',
		'NO_PROXY',
		'PATH',
		'PATHEXT',
		'RUSTUP_HOME',
		'SHELL',
		'SSL_CERT_DIR',
		'SSL_CERT_FILE',
		'SYSTEMROOT',
		'TEMP',
		'TMP',
		'TMPDIR',
		'USER',
		'WINDIR',
		'all_proxy',
		'http_proxy',
		'https_proxy',
		'no_proxy'
	];
	const commandEnvironment = {};
	const inheritedEnvironmentKeys = [];
	for (const key of passThroughKeys) {
		if (process.env[key] !== undefined) {
			commandEnvironment[key] = process.env[key];
			inheritedEnvironmentKeys.push(key);
		}
	}

	const cargoHome = join(temporaryDirectory, 'cargo-home');
	const cargoTargetDirectory = join(temporaryDirectory, 'target');
	Object.assign(commandEnvironment, {
		CARGO_HOME: cargoHome,
		CARGO_INCREMENTAL: '0',
		CARGO_TARGET_DIR: cargoTargetDirectory,
		CARGO_TERM_COLOR: 'never'
	});
	const discardedBuildEnvironmentKeys = Object.keys(process.env)
		.filter(isBuildAffectingEnvironmentKey)
		.filter(key => !['CARGO_HOME', 'CARGO_INCREMENTAL', 'CARGO_TARGET_DIR', 'CARGO_TERM_COLOR'].includes(key))
		.sort();

	return {
		commandEnvironment,
		cargoTargetDirectory,
		environmentPolicy: {
			inheritance: 'allowlist',
			inheritedEnvironmentKeys,
			discardedBuildEnvironmentKeys,
			forcedEnvironment: {
				CARGO_HOME: '<TEMP>/cargo-home',
				CARGO_INCREMENTAL: '0',
				CARGO_TARGET_DIR: '<TEMP>/target',
				CARGO_TERM_COLOR: 'never'
			}
		}
	};
}

function isBuildAffectingEnvironmentKey(key) {
	return (
		/^(?:AR|CC|CFLAGS|CXX|CXXFLAGS|LD|LDFLAGS|RANLIB)(?:_|$)/.test(key) ||
		/^CARGO_(?:BUILD|ENCODED_RUSTFLAGS|HOME|INCREMENTAL|PROFILE|TARGET|TERM_COLOR)(?:_|$)/.test(key) ||
		/^PKG_CONFIG(?:_|$)/.test(key) ||
		/^RUST(?:C|DOC)?FLAGS$/.test(key) ||
		/^RUSTC_BOOTSTRAP$/.test(key) ||
		/^RUSTC_(?:WRAPPER|WORKSPACE_WRAPPER)$/.test(key) ||
		/^RUSTUP_TOOLCHAIN$/.test(key) ||
		/^(?:MACOSX_DEPLOYMENT_TARGET|SDKROOT|SOURCE_DATE_EPOCH)$/.test(key)
	);
}

function parseCargoMetadata(output) {
	let metadata;
	try {
		metadata = JSON.parse(output);
	} catch (error) {
		throw new Error(`cargo metadata returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(metadata) || !Array.isArray(metadata.packages)) {
		throw new Error('cargo metadata omitted its packages array');
	}
	return metadata;
}

function normalizePackages(packages) {
	return packages
		.map(pkg => {
			if (!isRecord(pkg)) throw new Error('cargo metadata contains a non-object package');
			return {
				name: requireString(pkg.name, 'cargo package name'),
				version: requireString(pkg.version, 'cargo package version'),
				license: requireNullableString(pkg.license, 'cargo package license'),
				rustVersion: requireNullableString(pkg.rust_version, 'cargo package rust_version'),
				source: requireNullableString(pkg.source, 'cargo package source'),
				repository: requireNullableString(pkg.repository, 'cargo package repository')
			};
		})
		.sort(comparePackage);
}

function validateCandidatePackage(candidatePackage, lockedCandidateChecksum) {
	if (candidatePackage === undefined) throw new Error('cargo metadata omitted the exact sqlparser candidate');
	if (candidatePackage.license !== candidate.license) {
		throw new Error(`cargo metadata license mismatch: expected ${candidate.license}`);
	}
	if (candidatePackage.repository !== candidate.repository) {
		throw new Error(`cargo metadata repository mismatch: expected ${candidate.repository}`);
	}
	if (!/^[0-9a-f]{64}$/.test(lockedCandidateChecksum)) {
		throw new Error('Cargo.lock candidate checksum must be 64 lowercase hexadecimal characters');
	}
}

function findLockedCandidateChecksum(cargoLock) {
	const packages = [];
	let current = null;
	for (const line of cargoLock.split('\n')) {
		if (line === '[[package]]') {
			if (current !== null) packages.push(current);
			current = {};
			continue;
		}
		if (current === null) continue;
		const field = line.match(/^(name|version|source|checksum) = "([^"]*)"$/);
		if (field !== null) current[field[1]] = field[2];
	}
	if (current !== null) packages.push(current);
	const matches = packages.filter(pkg => pkg.name === candidate.name && pkg.version === candidate.version);
	if (matches.length !== 1) {
		throw new Error(`Cargo.lock must contain exactly one ${candidate.name}@${candidate.version} package`);
	}
	if (typeof matches[0].source !== 'string' || !matches[0].source.startsWith('registry+')) {
		throw new Error('Cargo.lock candidate must resolve from a registry source');
	}
	return requireString(matches[0].checksum, 'Cargo.lock candidate checksum');
}

async function collectMsrvEvidence(repositoryMsrv, commandOptions) {
	const toolchains = await run('rustup', ['toolchain', 'list'], commandOptions, { allowFailure: true });
	if (toolchains.exitCode !== 0) {
		return { status: 'not_run', reason: 'rustup is unavailable', installedToolchains: [] };
	}
	const installedToolchains = toolchains.stdout
		.trim()
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean);
	const installed = installedToolchains.some(line =>
		new RegExp(`^${escapeRegExp(repositoryMsrv)}(?:-|\\s|$)`).test(line)
	);
	if (!installed) {
		return {
			status: 'not_run',
			reason: `Rust ${repositoryMsrv} toolchain is not installed`,
			installedToolchains
		};
	}
	const result = await run(
		'cargo',
		[`+${repositoryMsrv}`, 'check', '--features', 'parser', '--locked'],
		{
			...commandOptions,
			env: { ...commandOptions.env, CARGO_TARGET_DIR: join(temporaryDirectory, 'target-msrv') }
		},
		{ allowFailure: true }
	);
	return {
		status: result.exitCode === 0 ? 'passed' : 'failed',
		exitCode: result.exitCode,
		installedToolchains
	};
}

async function collectMaintenanceEvidence(candidatePackage, lockedCandidateChecksum, cargoInfo) {
	const [versionResponse, crateResponse] = await Promise.all([
		fetchJson(`https://crates.io/api/v1/crates/${candidate.name}/${candidate.version}`),
		fetchJson(`https://crates.io/api/v1/crates/${candidate.name}`)
	]);
	if (!isRecord(versionResponse.version)) throw new Error('crates.io version response omitted version object');
	if (!isRecord(crateResponse.crate)) throw new Error('crates.io crate response omitted crate object');
	const version = versionResponse.version;
	const crate = crateResponse.crate;
	const exactVersion = requireString(version.num, 'crates.io version.num');
	const versionCrate = requireString(version.crate, 'crates.io version.crate');
	const checksum = requireString(version.checksum, 'crates.io version.checksum');
	const license = requireString(version.license, 'crates.io version.license');
	const repository = requireString(version.repository, 'crates.io version.repository');
	const rustVersion = requireNullableString(version.rust_version, 'crates.io version.rust_version');
	const yanked = requireBoolean(version.yanked, 'crates.io version.yanked');
	if (exactVersion !== candidate.version || versionCrate !== candidate.name) {
		throw new Error(
			`crates.io returned ${versionCrate}@${exactVersion}; expected ${candidate.name}@${candidate.version}`
		);
	}
	if (!/^[0-9a-f]{64}$/.test(checksum)) {
		throw new Error('crates.io checksum must be 64 lowercase hexadecimal characters');
	}
	if (checksum !== lockedCandidateChecksum) throw new Error('crates.io checksum does not match Cargo.lock');
	if (license !== candidate.license) throw new Error(`crates.io license mismatch: expected ${candidate.license}`);
	if (repository !== candidate.repository) {
		throw new Error(`crates.io repository mismatch: expected ${candidate.repository}`);
	}
	if (rustVersion !== candidatePackage.rustVersion) {
		throw new Error('crates.io rust_version does not match Cargo metadata');
	}
	if (yanked) throw new Error(`${candidate.name}@${candidate.version} is yanked`);

	const crateId = requireString(crate.id, 'crates.io crate.id');
	const crateName = requireString(crate.name, 'crates.io crate.name');
	const crateRepository = requireString(crate.repository, 'crates.io crate.repository');
	if (crateId !== candidate.name || crateName !== candidate.name) {
		throw new Error(`crates.io crate identity mismatch: ${crateId}/${crateName}`);
	}
	if (crateRepository !== candidate.repository) {
		throw new Error(`crates.io crate repository mismatch: expected ${candidate.repository}`);
	}

	return {
		source: 'crates.io API and cargo info',
		exactVersion,
		publishedAt: requireString(version.created_at, 'crates.io version.created_at'),
		updatedAt: requireString(version.updated_at, 'crates.io version.updated_at'),
		yanked,
		downloadsAtMeasurement: requireNonNegativeNumber(version.downloads, 'crates.io version.downloads'),
		crateBytes: requireNonNegativeNumber(version.crate_size, 'crates.io version.crate_size'),
		checksum,
		license,
		repository,
		latestStableVersionAtMeasurement: requireString(crate.max_stable_version, 'crates.io crate.max_stable_version'),
		crateUpdatedAt: requireString(crate.updated_at, 'crates.io crate.updated_at'),
		cargoInfo: {
			lines: cargoInfo.stdout.trim().split('\n'),
			sha256: sha256(cargoInfo.stdout)
		}
	};
}

async function fetchJson(url) {
	const timeoutSignal = AbortSignal.timeout(fetchTimeoutMs);
	const signal = AbortSignal.any([terminationController.signal, timeoutSignal]);
	let response;
	try {
		response = await fetch(url, {
			signal,
			headers: {
				Accept: 'application/json',
				'User-Agent': 'nyala-studio-a0-parser-spike/2'
			}
		});
	} catch (error) {
		if (timeoutSignal.aborted) throw new Error(`${url} timed out after ${fetchTimeoutMs}ms`);
		if (terminationController.signal.aborted) throw new Error(`received ${terminationSignal ?? 'termination signal'}`);
		throw new Error(`${url} request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
	const body = await readBoundedResponseBody(response, url);
	let value;
	try {
		value = JSON.parse(body);
	} catch (error) {
		throw new Error(`${url} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(value)) throw new Error(`${url} returned a non-object JSON payload`);
	return value;
}

async function readBoundedResponseBody(response, url) {
	const contentLength = response.headers.get('content-length');
	if (contentLength !== null) {
		const declaredBytes = Number(contentLength);
		if (Number.isSafeInteger(declaredBytes) && declaredBytes > maxFetchBodyBytes) {
			await response.body?.cancel();
			throw new Error(`${url} response exceeds the ${maxFetchBodyBytes}-byte limit`);
		}
	}
	if (response.body === null) return '';

	const reader = response.body.getReader();
	const chunks = [];
	let receivedBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			receivedBytes += value.byteLength;
			if (receivedBytes > maxFetchBodyBytes) {
				await reader.cancel();
				throw new Error(`${url} response exceeds the ${maxFetchBodyBytes}-byte limit`);
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, receivedBytes).toString('utf8');
}

function parseCorpus(output) {
	const observed = new Map();
	for (const line of output.trim().split('\n').filter(Boolean)) {
		const [id, status, statementCountValue, ...detail] = line.split('\t');
		if (observed.has(id)) throw new Error(`harness duplicated fixture ${id}`);
		if (!['parsed', 'rejected'].includes(status)) throw new Error(`harness returned invalid status for ${id}`);
		const statementCount = Number(statementCountValue);
		if (!Number.isSafeInteger(statementCount) || statementCount < 0) {
			throw new Error(`harness returned invalid statement count for ${id}`);
		}
		observed.set(id, { status, statementCount, detail: detail.join('\t') || null });
	}
	const results = fixtures.map(fixture => {
		const result = observed.get(fixture.id);
		if (result === undefined) throw new Error(`harness omitted fixture ${fixture.id}`);
		observed.delete(fixture.id);
		return {
			...fixture,
			...result,
			matchesDialectExpectation: result.status === 'parsed' && result.statementCount === fixture.expectedStatementCount
		};
	});
	if (observed.size > 0) throw new Error(`harness returned unknown fixtures: ${[...observed.keys()].join(', ')}`);
	const dialectGaps = results.filter(result => !result.matchesDialectExpectation).map(result => result.id);
	return {
		summary: {
			fixtureCount: results.length,
			parsedCount: results.filter(result => result.status === 'parsed').length,
			rejectedCount: results.filter(result => result.status === 'rejected').length,
			dialectGapCount: dialectGaps.length,
			dialectGaps,
			parsedButNotLocallyReadOnly: results
				.filter(result => result.status === 'parsed' && !['read_only', 'explain_read_only'].includes(result.localRisk))
				.map(result => result.id)
		},
		rawOutput: output,
		outputSha256: sha256(output),
		fixtures,
		fixturesSha256: sha256(JSON.stringify(fixtures)),
		resultsSha256: sha256(JSON.stringify(results)),
		results
	};
}

async function run(program, args, options, runOptions = {}) {
	const displayProgram = runOptions.displayProgram ?? program;
	const allowFailure = runOptions.allowFailure ?? false;
	const timeoutMs = args.includes('build') || args.includes('check') ? buildTimeoutMs : commandTimeoutMs;
	const result = await executeFile(program, args, options, timeoutMs);
	const stdout = normalize(result.stdout);
	const stderr = normalize(result.stderr);
	let exitCode = 0;
	if (result.timedOut) exitCode = 124;
	else if (Number.isInteger(result.exitCode)) exitCode = result.exitCode;
	else if (typeof result.signal === 'string') exitCode = signalExitCode(result.signal);
	else if (result.spawnError !== null) exitCode = 127;
	commands.push({
		program: normalize(displayProgram),
		args,
		timeoutMs,
		timedOut: result.timedOut,
		exitCode,
		signal: result.signal,
		stdoutSha256: sha256(stdout),
		stderrSha256: sha256(stderr)
	});
	if (terminationSignal !== null) throw new Error(`received ${terminationSignal}`);
	if (result.timedOut) throw new Error(`${displayProgram} ${args.join(' ')} timed out after ${timeoutMs}ms`);
	if (result.outputLimitExceeded !== null) {
		throw new Error(`${displayProgram} exceeded the ${maxCommandBufferBytes}-byte ${result.outputLimitExceeded} limit`);
	}
	if (exitCode !== 0 && !allowFailure) {
		throw new Error(`${displayProgram} ${args.join(' ')} exited ${exitCode}: ${stderr.trim()}`);
	}
	return { stdout, stderr, exitCode };
}

function executeFile(program, args, options, timeoutMs) {
	return new Promise(resolvePromise => {
		let timer = null;
		let timedOut = false;
		let stdout = '';
		let stderr = '';
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let outputLimitExceeded = null;
		let spawnError = null;
		const child = spawn(program, args, {
			...options,
			detached: process.platform !== 'win32',
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true
		});
		activeChildren.add(child);
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', chunk => {
			stdoutBytes += Buffer.byteLength(chunk);
			if (stdoutBytes <= maxCommandBufferBytes) stdout += chunk;
			else exceedOutputLimit('stdout');
		});
		child.stderr.on('data', chunk => {
			stderrBytes += Buffer.byteLength(chunk);
			if (stderrBytes <= maxCommandBufferBytes) stderr += chunk;
			else exceedOutputLimit('stderr');
		});
		child.on('error', error => {
			spawnError = error;
			if (stderr.length === 0) stderr = error.message;
		});
		child.on('close', (exitCode, signal) => {
			if (timer !== null) clearTimeout(timer);
			activeChildren.delete(child);
			resolvePromise({
				exitCode,
				signal,
				spawnError,
				stdout,
				stderr,
				timedOut,
				outputLimitExceeded
			});
		});
		timer = setTimeout(() => {
			timedOut = true;
			killProcessGroup(child, 'SIGKILL');
		}, timeoutMs);
		timer.unref();

		function exceedOutputLimit(stream) {
			if (outputLimitExceeded !== null) return;
			outputLimitExceeded = stream;
			killProcessGroup(child, 'SIGKILL');
		}
	});
}

function installSignalHandlers() {
	const handlers = new Map();
	for (const signal of ['SIGINT', 'SIGTERM']) {
		const handler = () => {
			terminationSignal ??= signal;
			if (!terminationController.signal.aborted) terminationController.abort(new Error(`received ${signal}`));
			for (const child of activeChildren) killProcessGroup(child, 'SIGKILL');
		};
		handlers.set(signal, handler);
		process.on(signal, handler);
	}
	return handlers;
}

function removeSignalHandlers(handlers) {
	for (const [signal, handler] of handlers) process.removeListener(signal, handler);
}

function killProcessGroup(child, signal) {
	if (child.pid === undefined) return;
	try {
		if (process.platform === 'win32') child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// The child may have exited between the deadline and the kill attempt.
		}
	}
}

function throwIfTerminated() {
	if (terminationSignal !== null) throw new Error(`received ${terminationSignal}`);
}

function signalExitCode(signal) {
	return { SIGHUP: 129, SIGINT: 130, SIGKILL: 137, SIGTERM: 143 }[signal] ?? 1;
}

function normalize(value) {
	return [canonicalTemporaryDirectory, temporaryDirectory]
		.filter(directory => typeof directory === 'string')
		.sort((left, right) => right.length - left.length)
		.reduce((result, directory) => result.split(directory).join('<TEMP>'), String(value));
}

function matchRequired(value, pattern, label) {
	const match = value.match(pattern);
	if (!match) throw new Error(`Could not read ${label}`);
	return match[1];
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value, label) {
	if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function requireNullableString(value, label) {
	if (value === null || value === undefined) return null;
	return requireString(value, label);
}

function requireBoolean(value, label) {
	if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
	return value;
}

function requireNonNegativeNumber(value, label) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new Error(`${label} must be a non-negative finite number`);
	}
	return value;
}

function comparePackage(left, right) {
	return left.name.localeCompare(right.name) || left.version.localeCompare(right.version);
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}
